import * as crypto from 'node:crypto';
import { throwIfAborted, withAbort } from '../abortablePromise.ts';
import { taskError } from '../toolActivity.js';
import {
  assertAutomationAttribution,
  createAutomationAttribution,
  taskIdFor,
  type AutomationAttribution,
  type AutomationContext,
  type AutomationWorkspace
} from './automationAttribution.ts';
import {
  launchWebBrowserSession,
  type BrowserActionResult,
  type BrowserInteractionArgs,
  type WebBrowserSession
} from './webBrowserAdapter.ts';
import {
  assertUiSessionId,
  formatHost,
  normalizeAllowedPorts,
  normalizeLoopbackHost,
  normalizePort,
  normalizeProtocol,
  normalizeViewport,
  resolveUiRoute,
  timeoutFor
} from './webPolicy.ts';

const MAX_ACTIVE_SESSIONS = 8;

type UiArgs = Readonly<Record<string, unknown> & BrowserInteractionArgs & {
  action?: unknown;
  port?: unknown;
  protocol?: unknown;
  host?: unknown;
  allowedPorts?: unknown;
  route?: unknown;
  width?: unknown;
  height?: unknown;
  headless?: unknown;
  timeoutMs?: unknown;
  sessionId?: unknown;
  work_id?: unknown;
  fullPage?: unknown;
  maxEntries?: unknown;
  clear?: unknown;
}>;

type UiContext = AutomationContext & Readonly<Record<string, unknown>> & Readonly<{ signal?: AbortSignal }>;

type UiSessionRecord = Readonly<{
  sessionId: string;
  attribution: AutomationAttribution;
  origin: string;
  allowedPorts: ReadonlySet<number>;
  browser: WebBrowserSession;
  createdAt: string;
}>;

type SessionCallback<T> = (record: UiSessionRecord) => Promise<T> | T;

const sessions = new Map<string, UiSessionRecord>();
const pendingStarts = new Set<{ taskId: string; cancelled: boolean; done: Promise<void> }>();
const closingSessions = new Map<string, Promise<void>>();
const taskCleanups = new Map<string, Promise<{ stopped: number }>>();
let shutdownPromise: Promise<{ stopped: number }> | null = null;

async function startUiSession(
  workspace: AutomationWorkspace,
  args: UiArgs = {},
  context: UiContext = {}
): Promise<Record<string, unknown>> {
  throwIfAborted(context.signal, uiCancellationError);
  if (shutdownPromise) throw taskError('UI_RUNTIME_SHUTTING_DOWN', 'Wait for UI browser shutdown to finish before starting another session.');
  const taskId = taskIdFor(args, context);
  if (taskId && taskCleanups.has(taskId)) throw taskError('UI_SESSION_CLOSING', 'Wait for this work session\'s UI browser cleanup to finish before starting another session.');
  const existing = taskId ? [...sessions.values()].find(record => record.attribution.taskId === taskId) : null;
  const pendingForTask = taskId ? [...pendingStarts].some(pending => pending.taskId === taskId) : false;
  if (existing || pendingForTask) {
    const detail = existing ? `: ${existing.sessionId}` : '';
    throw taskError('UI_SESSION_ALREADY_ACTIVE', `Work session already has an active or starting UI test session${detail}. Stop it before starting another.`);
  }
  if (sessions.size + pendingStarts.size >= MAX_ACTIVE_SESSIONS) {
    throw taskError('UI_SESSION_LIMIT', `Rel.AI supports at most ${MAX_ACTIVE_SESSIONS} concurrent UI test sessions.`);
  }

  const port = normalizePort(args.port, 'port');
  const protocol = normalizeProtocol(args.protocol);
  const host = normalizeLoopbackHost(args.host || '127.0.0.1');
  const allowedPorts = normalizeAllowedPorts(port, args.allowedPorts);
  const origin = `${protocol}://${formatHost(host)}:${port}`;
  const initialUrl = resolveUiRoute(origin, args.route || '/');
  const viewport = normalizeViewport(args.width, args.height);
  const sessionId = `ui_${crypto.randomBytes(24).toString('base64url')}`;
  const createdAt = new Date().toISOString();
  let resolveStartDone: (() => void) | undefined;
  const startDone = new Promise<void>(resolve => { resolveStartDone = resolve; });
  const pendingStart = { taskId, cancelled: false, done: startDone };
  pendingStarts.add(pendingStart);
  let record: UiSessionRecord | null = null;
  let launching: Promise<UiSessionRecord> | null = null;
  let launchSettled = false;
  let cleanupAttempted = false;
  const finishStart = () => { pendingStarts.delete(pendingStart); resolveStartDone?.(); };
  const assertStartActive = () => {
    throwIfAborted(context.signal, uiCancellationError);
    if (pendingStart.cancelled) throw taskError('UI_OPERATION_CANCELLED', 'UI browser startup was cancelled during cleanup.');
  };
  try {
    launching = launchWebBrowserSession({
      protocol, viewport, headless: args.headless !== false, allowedPorts
    }).then(async browser => {
      const acquired: UiSessionRecord = Object.freeze({
        sessionId, attribution: createAutomationAttribution(workspace, args, context),
        origin, allowedPorts, browser, createdAt
      });
      record = acquired;
      sessions.set(sessionId, acquired);
      browser.onDisconnected(() => {
        if (!closingSessions.has(sessionId)) sessions.delete(sessionId);
      });
      if (pendingStart.cancelled || context.signal?.aborted) {
        cleanupAttempted = true;
        await closeUiRecord(acquired);
        assertStartActive();
      }
      return acquired;
    }).finally(() => { launchSettled = true; });
    record = await withAbort(launching, context.signal, uiCancellationError);
    assertStartActive();
    const initialNavigation = await withAbort(record.browser.navigate(initialUrl, timeoutFor(args.timeoutMs)), context.signal, uiCancellationError);
    assertStartActive();
    return {
      ok: true,
      workspace: workspace.alias,
      action: 'start',
      sessionId,
      url: initialNavigation.url,
      origin,
      statusCode: initialNavigation.statusCode ?? null,
      title: initialNavigation.title ?? '',
      viewport,
      browserEngine: 'chromium',
      browserProduct: record.browser.browserProduct,
      allowedPorts: [...allowedPorts].sort((left, right) => left - right),
      createdAt
    };
  } catch (error) {
    if (record && !cleanupAttempted) await closeUiRecord(record).catch(() => {});
    throw error;
  } finally {
    if (launching && !launchSettled) void launching.catch(() => {}).finally(finishStart);
    else finishStart();
  }
}

function withUiSession<T>(
  workspace: AutomationWorkspace,
  args: UiArgs,
  context: UiContext,
  callback: SessionCallback<T>
): Promise<T> | T {
  throwIfAborted(context.signal, uiCancellationError);
  return callback(requireUiSession(workspace, args, context));
}

function requireUiSession(
  workspace: AutomationWorkspace,
  args: UiArgs = {},
  context: UiContext = {},
  allowClosing = false
): UiSessionRecord {
  const sessionId = assertUiSessionId(args.sessionId);
  const record = sessions.get(sessionId);
  // Task/global cleanup revokes public use before awaiting resource teardown.
  if (!record || (!allowClosing && (shutdownPromise || taskCleanups.has(record.attribution.taskId)))) {
    throw taskError('UI_SESSION_NOT_FOUND', `Unknown or closed UI test session: ${sessionId}.`);
  }
  assertAutomationAttribution(record.attribution, workspace, args, context);
  if (!allowClosing && closingSessions.has(sessionId)) throw taskError('UI_SESSION_CLOSING', 'Wait for UI browser cleanup to finish before using this session.');
  return record;
}

async function stopUiSession(
  workspace: AutomationWorkspace,
  args: UiArgs = {},
  context: UiContext = {}
): Promise<Record<string, unknown>> {
  const record = requireUiSession(workspace, args, context, true);
  try {
    await closeUiRecord(record);
    return {
      ok: true,
      workspace: workspace.alias,
      action: 'stop',
      sessionId: record.sessionId,
      status: 'stopped'
    };
  } catch (error) {
    return {
      ok: false,
      workspace: workspace.alias,
      action: 'stop',
      sessionId: record.sessionId,
      error: errorMessage(error)
    };
  }
}

function stopUiSessionsForTask(taskId: string): Promise<{ stopped: number }> {
  const id = String(taskId || '').trim();
  if (!id) return Promise.resolve({ stopped: 0 });
  const existing = taskCleanups.get(id);
  if (existing) return existing;
  const cleanup = (async () => {
    const starts = [...pendingStarts].filter(pending => pending.taskId === id);
    for (const pending of starts) pending.cancelled = true;
    await Promise.all(starts.map(pending => pending.done));
    const records = [...sessions.values()].filter(record => record.attribution.taskId === id);
    await closeUiRecords(records);
    return { stopped: records.length };
  })().finally(() => { taskCleanups.delete(id); });
  taskCleanups.set(id, cleanup);
  return cleanup;
}

function stopAllUiSessions(): Promise<{ stopped: number }> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const starts = [...pendingStarts];
    for (const pending of starts) pending.cancelled = true;
    await Promise.all(starts.map(pending => pending.done));
    const records = [...sessions.values()];
    await closeUiRecords(records);
    return { stopped: records.length };
  })().finally(() => { shutdownPromise = null; });
  return shutdownPromise;
}

function pageResult(record: UiSessionRecord, action: string, result: BrowserActionResult): Record<string, unknown> {
  return {
    ok: true,
    workspace: record.attribution.workspaceId,
    action,
    sessionId: record.sessionId,
    ...result
  };
}

function closeUiRecord(record: UiSessionRecord): Promise<void> {
  const existing = closingSessions.get(record.sessionId);
  if (existing) return existing;
  const closing = Promise.resolve().then(() => record.browser.close())
    .then(() => { sessions.delete(record.sessionId); })
    .finally(() => { closingSessions.delete(record.sessionId); });
  closingSessions.set(record.sessionId, closing);
  return closing;
}

async function closeUiRecords(records: readonly UiSessionRecord[]): Promise<void> {
  const results = await Promise.allSettled(records.map(closeUiRecord));
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'UI browser cleanup failed.');
}

function uiCancellationError(signal: AbortSignal): Error {
  return taskError('UI_OPERATION_CANCELLED', errorMessage(signal.reason || 'UI operation cancelled.'));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'unknown error');
}

export {
  pageResult,
  startUiSession,
  stopAllUiSessions,
  stopUiSession,
  stopUiSessionsForTask,
  withUiSession
};
export type { UiArgs, UiContext };
