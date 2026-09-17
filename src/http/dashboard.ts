import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  completeDashboardOnboarding,
  createDashboardEventSubscription,
  dashboardConnection,
  dashboardLogs,
  dashboardOnboardingStatus,
  dashboardReleaseNotes,
  dashboardRequiresHttpToken,
  dashboardSnapshot,
  dashboardTaskSession,
  dashboardTools,
  dashboardWorkspacePreflight,
  updateDashboardWorkspace
} from '../core/dashboard-runtime.ts';
import { ERROR_CODES, errorPayload } from '../contracts/errors.ts';
import { handleOpenFolder, handlePickFolder, handleWorkspaceChecks } from './dashboardActions.ts';
import { createSseWriter, readJsonBody, sendJson, sendSse } from './io.ts';
import type { HttpRouteContext, HttpServerOptions } from './types.ts';

function handleApiTools(ctx: HttpRouteContext): void {
  try {
    sendJson(ctx.res, 200, dashboardTools());
  } catch (error) {
    sendJson(ctx.res, 500, errorPayload(ERROR_CODES.UNKNOWN, errorMessage(error)));
  }
}

function handleOnboardingStatus(ctx: HttpRouteContext): void {
  sendJson(ctx.res, 200, dashboardOnboardingStatus());
}

function handleConnection(ctx: HttpRouteContext): void {
  sendJson(ctx.res, 200, dashboardConnection(ctx.options));
}

function handleDashboardV10(ctx: HttpRouteContext): void {
  sendJson(ctx.res, 200, dashboardSnapshot(ctx.options, {
    limit: Number(ctx.parsed.searchParams.get('limit') || 100),
    requireHttpToken: dashboardRequiresHttpToken(ctx.parsed.searchParams.get('requireHttpToken'))
  }));
}

async function handleWorkspacePreflight(ctx: HttpRouteContext): Promise<void> {
  sendJson(ctx.res, 200, await dashboardWorkspacePreflight({
    path: ctx.parsed.searchParams.get('path') || '',
    workspace: ctx.parsed.searchParams.get('workspace') || '',
    requireClean: ctx.parsed.searchParams.get('requireClean') !== '0'
  }));
}

function handleEvents(ctx: HttpRouteContext): void {
  openDashboardEvents(ctx.res, ctx.req, ctx.options);
}

async function handleOnboardingComplete(ctx: HttpRouteContext): Promise<void> {
  const payload = await readJsonBody(ctx.req, ctx.options.maxBodyBytes);
  sendJson(ctx.res, 200, completeDashboardOnboarding(payload));
}

async function handleApiWorkspaces(ctx: HttpRouteContext): Promise<void> {
  const payload = await readJsonBody(ctx.req, ctx.options.maxBodyBytes);
  sendJson(ctx.res, 200, await updateDashboardWorkspace(payload));
}

function openDashboardEvents(
  res: ServerResponse<IncomingMessage>,
  req: IncomingMessage,
  options: HttpServerOptions
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  let subscription: { close: () => void } | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  const stream = createSseWriter(res, {
    onOverflow: () => {
      subscription?.close();
      if (heartbeat) clearInterval(heartbeat);
    }
  });
  subscription = createDashboardEventSubscription(options, {
    onReady: payload => stream.send('ready', payload),
    onEvent: (eventName, payload) => stream.send(eventName, payload, { id: `${payload.streamId}:${payload.sequence}` }),
    onError: error => sendDashboardStreamError(res, error, stream)
  });
  heartbeat = setInterval(() => {
    // Keep the existing `: keepalive` SSE comment semantics while routing it
    // through the bounded writer.
    if (!res.destroyed) stream.comment(`keepalive ${Date.now()}`);
  }, 15000);
  heartbeat.unref?.();
  req.on('close', () => {
    subscription?.close();
    if (heartbeat) clearInterval(heartbeat);
    stream.close();
  });
}

function sendDashboardStreamError(
  res: ServerResponse<IncomingMessage>,
  error: unknown,
  stream?: ReturnType<typeof createSseWriter>
): void {
  if (res.destroyed) return;
  const payload = errorPayload(ERROR_CODES.UNKNOWN, errorMessage(error));
  if (stream) stream.send('dashboard.error', payload);
  else sendSse(res, 'dashboard.error', payload);
}

const handleTaskSession = (ctx: HttpRouteContext): void => {
  const taskId = String(ctx.parsed.searchParams.get('task') || '').trim();
  if (!taskId) {
    sendJson(ctx.res, 400, { ok: false, error: 'task is required.' });
    return;
  }
  const result = dashboardTaskSession(taskId);
  if (!result) {
    sendJson(ctx.res, 404, { ok: false, error: 'Work session not found.' });
    return;
  }
  sendJson(ctx.res, 200, result);
};

const handleApiLogs = (ctx: HttpRouteContext): void => {
  const limit = Number(ctx.parsed.searchParams.get('limit') || 100);
  sendJson(ctx.res, 200, dashboardLogs(ctx.options, limit));
};

const handleReleaseNotes = (ctx: HttpRouteContext): void => sendJson(ctx.res, 200, dashboardReleaseNotes());

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export {
  handleApiTools,
  handleOnboardingStatus,
  handleConnection,
  handleDashboardV10,
  handleTaskSession,
  handleApiLogs,
  handleReleaseNotes,
  handleWorkspacePreflight,
  handleEvents,
  handleOnboardingComplete,
  handleApiWorkspaces,
  handlePickFolder,
  handleOpenFolder,
  handleWorkspaceChecks
};
