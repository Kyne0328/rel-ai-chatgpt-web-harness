import { setTimeout as delay } from 'node:timers/promises';

import type { ComputerControlResultDto, ComputerControlStatusDto } from './contracts/computer.ts';
import {
  approveComputerApp,
  assertComputerAppApproved,
  assertComputerControlEnabled,
  assertComputerTierAllowed,
  computerControlSettings,
  listComputerApprovedApps,
  normalizeAppName,
  revokeComputerApp,
  tierForComputerApp,
  warningForComputerApp,
  ComputerSessionLockedError,
  type ComputerControlConfig
} from './computer/computerPolicy.ts';
import {
  createMidsceneComputerAdapter,
  type ComputerAdapter,
  type ComputerAppImage,
  type ComputerPixelProvenance,
  type ComputerPoint,
  type ScrollDirection
} from './computer/midsceneAdapter.ts';
import {
  computerImageSha256,
  normalizeScreenshotProfile,
  prepareComputerObservation,
  type ScreenshotProfile
} from './computer/computerObservation.ts';
import {
  createWindowsUiaAdapter,
  type ComputerSemanticAdapter,
  type SemanticPerception,
  type SemanticTarget
} from './computer/windowsUiaAdapter.ts';
import { appCaptureUnavailable, appInputTargetUnverified, validateAppImage, validateAppPixelProvenance } from './computer/appCapture.ts';
import { isResolvedAppApproved, type ResolvedAppTarget } from './computer/appTarget.ts';
import { principalFingerprint } from './mcp/principal.ts';

const COMPUTER_ACTIONS = new Set([
  'status', 'displays', 'observe', 'activate', 'set_value', 'screenshot', 'wait_for_change', 'wait_for_stable', 'move', 'click', 'double_click', 'right_click',
  'drag', 'scroll', 'type', 'key', 'hotkey', 'batch', 'stop', 'approve_app', 'revoke_app'
] as const);
const MAX_BATCH_ACTIONS = 20;
const MODIFIER_ALIASES = Object.freeze({
  ctrl: 'control', control: 'control', shift: 'shift', alt: 'alt', option: 'alt',
  cmd: 'command', command: 'command', meta: 'command', win: 'command', super: 'command'
} as const);
const KEY_ALIASES = Object.freeze({
  return: 'enter', esc: 'escape', spacebar: 'space', del: 'delete',
  arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right'
} as const);
const DEFAULT_SCROLL_DISTANCE = 700;
const MAX_TYPE_TEXT_BYTES = 64 * 1024;
const DISPLAY_SIZE_CACHE_TTL_MS = 3000;
const OBSERVATION_TTL_MS = 30_000;
const MAX_OBSERVATIONS = 128;
const SEMANTIC_OBSERVATION_TTL_MS = 30_000;
const MAX_SEMANTIC_OBSERVATIONS = 64;
const DEFAULT_SEMANTIC_ELEMENTS = 120;
const DEFAULT_CHANGE_TIMEOUT_MS = 5_000;
const DEFAULT_CHANGE_POLL_MS = 125;
const DEFAULT_STABLE_MS = 350;
const defaultComputerAdapter = createMidsceneComputerAdapter();
const defaultSemanticAdapter = createWindowsUiaAdapter();
const displaySizeCache = new Map<string, { value: { width: number; height: number }; expiresAt: number }>();
const observations = new Map<string, ComputerObservationRecord>();
const lastObservationByScope = new Map<string, string>();
const semanticObservations = new Map<string, SemanticObservationRecord>();
const lastSemanticObservationByScope = new Map<string, string>();
let inputQueue: Promise<unknown> = Promise.resolve();

type ComputerAction = typeof COMPUTER_ACTIONS extends Set<infer T> ? T : never;

type ComputerWorkspace = Readonly<{ alias: string }>;
type ComputerArgs = Readonly<Record<string, unknown> & {
  action?: unknown;
  displayId?: unknown;
  windowTitle?: unknown;
  windowId?: unknown;
  app?: unknown;
  x?: unknown;
  y?: unknown;
  toX?: unknown;
  toY?: unknown;
  direction?: unknown;
  distance?: unknown;
  text?: unknown;
  value?: unknown;
  key?: unknown;
  keys?: unknown;
  actions?: unknown;
  observationId?: unknown;
  previousObservationId?: unknown;
  profile?: unknown;
  forceImage?: unknown;
  timeoutMs?: unknown;
  pollMs?: unknown;
  semanticObservationId?: unknown;
  targetId?: unknown;
  maxElements?: unknown;
  perception?: unknown;
  stableMs?: unknown;
}>;
type ComputerObservationRecord = Readonly<{
  id: string;
  sessionId: string;
  app: string;
  displayId?: string;
  sourceSha256: string;
  sourceWidth: number;
  originX: number;
  originY: number;
  capture: ComputerPixelProvenance;
  sourceHeight: number;
  imageWidth: number;
  imageHeight: number;
  profile: ScreenshotProfile;
  capturedAt: number;
}>;
type SemanticObservationRecord = Readonly<{
  id: string;
  sessionId: string;
  app: string;
  maxElements: number;
  perception: SemanticPerception;
  fingerprint: string;
  targets: readonly SemanticTarget[];
  appTarget?: ResolvedAppTarget;
  capturedAt: number;
}>;
type ComputerSessionLock = { holder: string; app: string | null; since: string; lastActive: number };
let computerSessionLock: ComputerSessionLock | null = null;
const COMPUTER_LOCK_TTL_MS = 5 * 60 * 1000;
type ComputerContext = Readonly<{
  computerAdapter?: ComputerAdapter;
  semanticAdapter?: ComputerSemanticAdapter;
  signal?: AbortSignal;
  conversationId?: unknown;
  transportSessionId?: unknown;
  taskId?: unknown;
  principal?: unknown;
}>;


const appTargetBindings = new Map<string, ResolvedAppTarget>();

async function authorizeResolvedApp(
  semanticAdapter: ComputerSemanticAdapter, app: string, config: ComputerControlConfig | null | undefined,
  args: ComputerArgs, sessionId: string, action: string, signal?: AbortSignal
): Promise<ResolvedAppTarget | undefined> {
  if (typeof semanticAdapter.resolveAppTarget !== 'function' || !semanticAdapter.supported()) {
    assertComputerAppApproved(app, config, sessionId);
    assertComputerTierAllowed(app, action);
    return undefined;
  }
  const bindingKey = [sessionId, app, String(args.windowId || ''), String(args.windowTitle || '')].join('\u0000');
  const observed = args.observationId ? requireComputerObservation(args.observationId, sessionId, app).capture.targetIdentity : undefined;
  const semantic = args.semanticObservationId ? requireSemanticObservation(args.semanticObservationId, sessionId, app).appTarget : undefined;
  const target = observed || semantic || await semanticAdapter.resolveAppTarget(app, {
    ...(appTargetBindings.has(bindingKey) ? { binding: appTargetBindings.get(bindingKey)! } : {}),
    ...(args.windowId ? { windowId: String(args.windowId) } : {}),
    ...(args.windowTitle ? { windowTitle: String(args.windowTitle) } : {}),
    ...(args.displayId ? { displayId: String(args.displayId) } : {}),
    approvedApps: listComputerApprovedApps(config, sessionId)
  }, signal);
  signal?.throwIfAborted?.();
  const approved = listComputerApprovedApps(config, sessionId);
  if (target.approvalBasis === 'title') {
    // Captions select an already approved identity; they never grant one.
    if (!isResolvedAppApproved(target, approved)) assertComputerAppApproved(target.canonicalApp, config, sessionId);
  } else if (!approved.includes(app) && !isResolvedAppApproved(target, approved)) {
    assertComputerAppApproved(app, config, sessionId);
  }
  assertComputerTierAllowed(app, action);
  for (const name of target.policyNames) assertComputerTierAllowed(name, action);
  appTargetBindings.set(bindingKey, target);
  if (appTargetBindings.size > MAX_OBSERVATIONS) appTargetBindings.delete(appTargetBindings.keys().next().value!);
  return target;
}

function resolvedAppTier(app: string, target?: ResolvedAppTarget): ReturnType<typeof tierForComputerApp> {
  const tiers = [app, ...(target?.policyNames || [])].map(tierForComputerApp);
  return tiers.includes('read') ? 'read' : tiers.includes('click') ? 'click' : 'full';
}

async function readComputerStatus(
  config: ComputerControlConfig | null | undefined,
  context: ComputerContext = {}
): Promise<ComputerControlStatusDto> {
  const settings = computerControlSettings(config);
  if (settings.enabled) startSemanticWarmup(context);
  const adapter = resolveAdapter(context);
  const sessionId = computerControlSessionId(context);
  const lock = currentComputerLock();
  const lockState = lock
    ? {
      controlling: true,
      lockedBy: lock.holder,
      lockSince: lock.since,
      banner: `Computer control active for '${lock.holder}'. Send relai_computer stop or abort (Esc) to release.`
    }
    : { controlling: false };
  try {
    const environment = await adapter.environment();
    return {
      ok: true,
      action: 'status',
      enabled: settings.enabled,
      available: environment?.available === true,
      platform: String(environment?.platform || process.platform),
      engine: adapter.engine || '@midscene/computer',
      displays: Number(environment?.displays || 0),
      approvedApps: listComputerApprovedApps(config, sessionId),
      ...lockState,
      ...(environment?.error ? { message: `Computer control runtime is unavailable: ${environment.error}` } : {})
    };
  } catch (error) {
    return {
      ok: true,
      action: 'status',
      enabled: settings.enabled,
      available: false,
      platform: process.platform,
      engine: adapter.engine || '@midscene/computer',
      approvedApps: listComputerApprovedApps(config, sessionId),
      ...lockState,
      message: `Computer control runtime is unavailable: ${errorMessage(error)}`
    };
  }
}

async function runComputerAction(
  workspace: ComputerWorkspace,
  config: ComputerControlConfig | null | undefined,
  args: ComputerArgs = {},
  context: ComputerContext = {}
): Promise<ComputerControlResultDto> {
  context.signal?.throwIfAborted?.();
  const action = normalizeAction(args.action);
  if (action === 'status') {
    return { ...(await readComputerStatus(config, context)), workspace: workspace.alias };
  }
  assertComputerControlEnabled(config);
  startSemanticWarmup(context);

  const adapter = resolveAdapter(context);
  const semanticAdapter = resolveSemanticAdapter(context);
  const sessionId = computerControlSessionId(context);
  if (action === 'approve_app') {
    const app = approveComputerApp(args.app, sessionId);
    const warning = warningForComputerApp(app);
    return baseResult(workspace, action, {
      app, tier: tierForComputerApp(app), approved: true,
      ...(warning ? { warning } : {}),
      approvedApps: listComputerApprovedApps(config, sessionId)
    });
  }
  if (action === 'revoke_app') {
    const app = revokeComputerApp(args.app, sessionId);
    for (const key of appTargetBindings.keys()) if (key.startsWith(`${sessionId}\u0000${app}\u0000`)) appTargetBindings.delete(key);
    return baseResult(workspace, action, { app, approved: false, approvedApps: listComputerApprovedApps(config, sessionId) });
  }
  if (action === 'stop') {
    const released = releaseComputerLock(sessionId);
    displaySizeCache.clear();
    clearSessionObservations(sessionId);
    for (const key of appTargetBindings.keys()) if (key.startsWith(`${sessionId}\u0000`)) appTargetBindings.delete(key);
    return baseResult(workspace, action, { executed: true, released, controlling: false });
  }
  if (action === 'displays') {
    const displays = await adapter.listDisplays();
    return baseResult(workspace, action, { displays, count: displays.length, engine: adapter.engine || '@midscene/computer' });
  }
  if (action === 'observe') {
    return executeObserve(adapter, semanticAdapter, workspace, config, args, sessionId, context.signal);
  }
  if (action === 'screenshot') {
    const displayId = optionalDisplayId(args.displayId);
    const app = requiredComputerApp(args.app);
    const appTarget = await authorizeResolvedApp(semanticAdapter, app, config, args, sessionId, 'screenshot', context.signal);
    const observation = await captureComputerObservation(adapter, sessionId, app, displayId, args, appTarget, context.signal);
    return baseResult(workspace, action, {
      ...(displayId ? { displayId } : {}),
      app,
      tier: resolvedAppTier(app, appTarget),
      ...observation,
      engine: String(observation.captureEngine || adapter.engine || '@midscene/computer')
    });
  }
  if (action === 'wait_for_change') {
    return queueInput(
      () => executeWaitForChange(adapter, semanticAdapter, workspace, config, args, sessionId, context.signal),
      context.signal
    );
  }
  if (action === 'wait_for_stable') {
    return queueInput(
      () => executeWaitForStable(adapter, semanticAdapter, workspace, config, args, sessionId, context.signal),
      context.signal
    );
  }
  if (action === 'batch') {
    const steps = normalizeBatchSteps(args.actions);
    return queueInput(
      () => executeBatchAction(adapter, semanticAdapter, workspace, config, steps, args, sessionId, context.signal),
      context.signal
    );
  }
  return queueInput(() => executeInputAction(adapter, semanticAdapter, workspace, config, action, args, sessionId, context.signal), context.signal);
}

async function executeInputAction(
  adapter: ComputerAdapter,
  semanticAdapter: ComputerSemanticAdapter,
  workspace: ComputerWorkspace,
  config: ComputerControlConfig | null | undefined,
  action: ComputerAction,
  args: ComputerArgs,
  sessionId: string,
  signal?: AbortSignal
): Promise<ComputerControlResultDto> {
  const app = requiredComputerApp((args as Record<string, unknown>).app);
  const displayId = resolveInputDisplayId(sessionId, app, args.displayId, args.observationId);
  const appTarget = await authorizeResolvedApp(semanticAdapter, app, config, args, sessionId, action, signal);
  acquireComputerLock(sessionId, app);

  if (action === 'activate') {
    const semanticObservationId = requiredIdentifier(args.semanticObservationId, 'activate requires semanticObservationId.');
    const targetId = requiredIdentifier(args.targetId, 'activate requires targetId.');
    const stored = requireSemanticObservation(semanticObservationId, sessionId, app);
    const original = stored.targets.find(target => target.targetId === targetId);
    if (!original) throw new Error(`Semantic target '${targetId}' is not part of observation '${semanticObservationId}'.`);
    signal?.throwIfAborted?.();
    let current: SemanticTarget | null = null;
    let semanticMethod = '';
    let handled = false;
    if (typeof semanticAdapter.activate === 'function') {
      const activation = await semanticAdapter.activate(app, original, stored.maxElements, stored.perception, signal, appTarget);
      if (!activation.available || !activation.target) {
        throw new Error(activation.reason || `Semantic target '${targetId}' is stale or unavailable; take a new relai_computer observe result and retry.`);
      }
      current = activation.target;
      semanticMethod = activation.method || '';
      handled = activation.handled === true;
    } else {
      const refreshed = await semanticAdapter.observe(app, stored.maxElements, stored.perception, signal, appTarget);
      if (!refreshed.available || !Array.isArray(refreshed.elements)) {
        throw new Error('Semantic target could not be revalidated; take a new relai_computer observe result and retry.');
      }
      current = revalidatedSemanticTarget(original, refreshed.elements);
    }
    if (!current || !current.enabled) {
      throw new Error(`Semantic target '${targetId}' is stale or unavailable; take a new relai_computer observe result and retry.`);
    }
    if (handled) {
      adapter.invalidateScreenshot?.(current.displayId);
      touchComputerLock();
      return baseResult(workspace, action, {
        executed: true,
        app,
        tier: resolvedAppTier(app, appTarget),
        semanticObservationId,
        targetId,
        displayId: current.displayId,
        x: current.centerX,
        y: current.centerY,
        method: semanticMethod || 'uia-native'
      });
    }
    const size = await cachedDisplaySize(adapter, current.displayId);
    const point = resolvePointInSize(
      current.displayId,
      current.centerX,
      current.centerY,
      'semantic target center',
      size
    );
    signal?.throwIfAborted?.();
    await adapter.click(current.displayId, point);
    touchComputerLock();
    return baseResult(workspace, action, {
      executed: true,
      app,
      tier: resolvedAppTier(app, appTarget),
      semanticObservationId,
      targetId,
      displayId: current.displayId,
      x: point.x,
      y: point.y,
      method: semanticMethod || 'semantic-center-click'
    });
  }

  if (action === 'set_value') {
    const semanticObservationId = requiredIdentifier(args.semanticObservationId, 'set_value requires semanticObservationId.');
    const targetId = requiredIdentifier(args.targetId, 'set_value requires targetId.');
    const text = String(args.value ?? '');
    const textBytes = Buffer.byteLength(text, 'utf8');
    if (textBytes > MAX_TYPE_TEXT_BYTES) throw new Error(`set_value text exceeds the ${MAX_TYPE_TEXT_BYTES}-byte limit.`);
    const stored = requireSemanticObservation(semanticObservationId, sessionId, app);
    const original = stored.targets.find(target => target.targetId === targetId);
    if (!original) throw new Error(`Semantic target '${targetId}' is not part of observation '${semanticObservationId}'.`);
    if (typeof semanticAdapter.setValue !== 'function') {
      throw new Error('Native semantic value setting is unavailable; use click/type for this application instead.');
    }
    signal?.throwIfAborted?.();
    const result = await semanticAdapter.setValue(app, original, text, stored.maxElements, signal, appTarget);
    if (!result.available || !result.target) {
      throw new Error(result.reason || `Semantic target '${targetId}' is stale or unavailable; take a new relai_computer observe result and retry.`);
    }
    if (!result.handled) {
      throw new Error(result.reason || 'Semantic target does not expose a writable native value pattern; use click/type instead.');
    }
    adapter.invalidateScreenshot?.(result.target.displayId);
    touchComputerLock();
    return baseResult(workspace, action, {
      executed: true,
      app,
      tier: resolvedAppTier(app, appTarget),
      semanticObservationId,
      targetId,
      displayId: result.target.displayId,
      x: result.target.centerX,
      y: result.target.centerY,
      textLength: text.length,
      method: result.method || 'uia-set-value'
    });
  }

  const appFields = {
    app,
    tier: resolvedAppTier(app, appTarget),
    ...(optionalObservationId(args.observationId) ? { observationId: optionalObservationId(args.observationId) } : {}),
    ...(warningForComputerApp(app) ? { warning: warningForComputerApp(app) } : {})
  };

  if (action === 'move' || action === 'click' || action === 'double_click' || action === 'right_click') {
    const point = await resolveDisplayPoint(adapter, displayId, args.x, args.y, 'x/y', sessionId, args.observationId, app);
    await assertObservationInputTarget(adapter, sessionId, app, displayId, args.observationId, [point], false, signal);
    if (action === 'move') await adapter.move(displayId, point);
    else if (action === 'click') await adapter.click(displayId, point);
    else if (action === 'double_click') await adapter.doubleClick(displayId, point);
    else await adapter.rightClick(displayId, point);
    touchComputerLock();
    return baseResult(workspace, action, { ...point, ...(displayId ? { displayId } : {}), executed: true, ...appFields });
  }

  if (action === 'drag') {
    const from = await resolveDisplayPoint(adapter, displayId, args.x, args.y, 'x/y', sessionId, args.observationId, app);
    const to = await resolveDisplayPoint(adapter, displayId, args.toX, args.toY, 'toX/toY', sessionId, args.observationId, app);
    await assertObservationInputTarget(adapter, sessionId, app, displayId, args.observationId, [from, to], false, signal);
    await adapter.drag(displayId, from, to);
    touchComputerLock();
    return baseResult(workspace, action, {
      x: from.x, y: from.y, toX: to.x, toY: to.y,
      ...(displayId ? { displayId } : {}), executed: true, ...appFields
    });
  }

  if (action === 'scroll') {
    const direction = normalizeScrollDirection(args.direction);
    const distance = boundedInteger(args.distance, 1, 100000, DEFAULT_SCROLL_DISTANCE, 'distance');
    let point: ComputerPoint | undefined;
    if (args.x !== undefined || args.y !== undefined) {
      if (args.x === undefined || args.y === undefined) throw new Error('scroll requires both x and y when either coordinate is provided.');
      point = await resolveDisplayPoint(adapter, displayId, args.x, args.y, 'x/y', sessionId, args.observationId, app);
    }
    await assertObservationInputTarget(adapter, sessionId, app, displayId, args.observationId, point ? [point] : [], false, signal);
    await adapter.scroll(displayId, { direction, distance, ...(point ? { point } : {}) });
    touchComputerLock();
    return baseResult(workspace, action, {
      direction,
      distance,
      ...(point ? { x: point.x, y: point.y } : {}),
      ...(displayId ? { displayId } : {}),
      executed: true, ...appFields
    });
  }

  if (action === 'type') {
    const text = String(args.text ?? '');
    if (!text) throw new Error('type requires non-empty text.');
    const textBytes = Buffer.byteLength(text, 'utf8');
    if (textBytes > MAX_TYPE_TEXT_BYTES) throw new Error(`type text exceeds the ${MAX_TYPE_TEXT_BYTES}-byte limit.`);
    await assertObservationInputTarget(adapter, sessionId, app, displayId, args.observationId, [], true, signal);
    await adapter.typeText(text);
    touchComputerLock();
    return baseResult(workspace, action, { executed: true, textLength: text.length, ...appFields });
  }

  if (action === 'key') {
    const key = normalizeKey(args.key);
    await assertObservationInputTarget(adapter, sessionId, app, displayId, args.observationId, [], true, signal);
    await adapter.pressKey(key);
    touchComputerLock();
    return baseResult(workspace, action, { executed: true, key, ...appFields });
  }

  if (action === 'hotkey') {
    const chord = normalizeHotkey(args.keys);
    await assertObservationInputTarget(adapter, sessionId, app, displayId, args.observationId, [], true, signal);
    await adapter.pressKey(chord.keyName);
    touchComputerLock();
    return baseResult(workspace, action, { executed: true, key: chord.key, keys: chord.keys, ...appFields });
  }

  throw new Error(`Unsupported computer input action: ${action}.`);
}

async function executeBatchAction(
  adapter: ComputerAdapter,
  semanticAdapter: ComputerSemanticAdapter,
  workspace: ComputerWorkspace,
  config: ComputerControlConfig | null | undefined,
  steps: ComputerArgs[],
  parentArgs: ComputerArgs,
  sessionId: string,
  signal?: AbortSignal
): Promise<ComputerControlResultDto> {
  const parentApp = requiredComputerApp((parentArgs as Record<string, unknown>).app);
  const parentTarget = await authorizeResolvedApp(semanticAdapter, parentApp, config, parentArgs, sessionId, 'batch', signal);
  acquireComputerLock(sessionId, parentApp);
  const results: ComputerControlResultDto[] = [];
  let failed = false;
  for (const step of steps) {
    signal?.throwIfAborted?.();
    if (failed) {
      results.push({ ...baseResult(workspace, String(step.action || 'unknown'), { executed: false, skipped: true }), ok: false });
      continue;
    }
    try {
      const stepArgs = {
        ...step,
        ...(parentApp && !step.app ? { app: parentApp } : {}),
        ...(parentArgs.windowTitle && !step.windowTitle ? { windowTitle: parentArgs.windowTitle } : {}),
        ...(parentArgs.windowId && !step.windowId ? { windowId: parentArgs.windowId } : {}),
        ...(parentArgs.observationId && !step.observationId ? { observationId: parentArgs.observationId } : {}),
        ...(parentArgs.profile && !step.profile ? { profile: parentArgs.profile } : {}),
        ...(parentArgs.semanticObservationId && !step.semanticObservationId ? { semanticObservationId: parentArgs.semanticObservationId } : {}),
        ...(parentArgs.perception && !step.perception ? { perception: parentArgs.perception } : {})
      } as ComputerArgs;
      const stepAction = normalizeAction(stepArgs.action);
      if (stepAction === 'batch' || stepAction === 'stop' || stepAction === 'status' || stepAction === 'approve_app' || stepAction === 'revoke_app') {
        throw new Error(`batch does not support nested '${stepAction}' actions.`);
      }
      if (stepAction === 'observe') {
        results.push(await executeObserve(adapter, semanticAdapter, workspace, config, stepArgs, sessionId, signal));
        touchComputerLock();
        continue;
      }
      if (stepAction === 'screenshot' || stepAction === 'displays' || stepAction === 'wait_for_change' || stepAction === 'wait_for_stable') {
        const displayId = optionalDisplayId(stepArgs.displayId);
        if (stepAction === 'displays') {
          const displays = await adapter.listDisplays();
          results.push(baseResult(workspace, stepAction, { displays, count: displays.length, engine: adapter.engine || '@midscene/computer' }));
        } else if (stepAction === 'wait_for_change') {
          results.push(await executeWaitForChange(adapter, semanticAdapter, workspace, config, stepArgs, sessionId, signal));
        } else if (stepAction === 'wait_for_stable') {
          results.push(await executeWaitForStable(adapter, semanticAdapter, workspace, config, stepArgs, sessionId, signal));
        } else {
          const stepApp = requiredComputerApp((stepArgs as Record<string, unknown>).app);
          const stepTarget = await authorizeResolvedApp(semanticAdapter, stepApp, config, stepArgs, sessionId, stepAction, signal);
          const observation = await captureComputerObservation(adapter, sessionId, stepApp, displayId, stepArgs, stepTarget, signal);
          results.push(baseResult(workspace, stepAction, {
            ...(displayId ? { displayId } : {}),
            app: stepApp,
            tier: resolvedAppTier(stepApp, stepTarget),
            ...observation,
            engine: String(observation.captureEngine || adapter.engine || '@midscene/computer')
          }));
        }
        touchComputerLock();
        continue;
      }
      results.push(await executeInputAction(adapter, semanticAdapter, workspace, config, stepAction, stepArgs, sessionId, signal));
    } catch (error) {
      failed = true;
      results.push({
        ...baseResult(workspace, String((step as Record<string, unknown>).action || 'unknown'), {
          executed: false,
          error: error instanceof Error ? error.message : String(error || 'batch step failed')
        }),
        ok: false
      });
    }
  }
  touchComputerLock();
  return baseResult(workspace, 'batch', {
    executed: !failed,
    count: results.length,
    failed,
    results,
    app: parentApp,
    tier: resolvedAppTier(parentApp, parentTarget)
  });
}

async function executeObserve(
  adapter: ComputerAdapter,
  semanticAdapter: ComputerSemanticAdapter,
  workspace: ComputerWorkspace,
  config: ComputerControlConfig | null | undefined,
  args: ComputerArgs,
  sessionId: string,
  signal?: AbortSignal
): Promise<ComputerControlResultDto> {
  const app = requiredComputerApp(args.app);
  const appTarget = await authorizeResolvedApp(semanticAdapter, app, config, args, sessionId, 'observe', signal);
  const maxElements = boundedInteger(args.maxElements, 1, 300, DEFAULT_SEMANTIC_ELEMENTS, 'maxElements');
  const perception = normalizeSemanticPerception(args.perception);
  try {
    const semantic = await semanticAdapter.observe(app, maxElements, perception, signal, appTarget);
    signal?.throwIfAborted?.();
    if (semantic.available === true && Array.isArray(semantic.elements) && semantic.elements.length > 0) {
      const capture = semantic.elements.some(target => target.source === 'ocr')
        ? validateAppPixelProvenance(semantic.pixelProvenance, app, semantic.window?.displayId)
        : null;
      const remembered = rememberSemanticObservation(sessionId, app, maxElements, perception, semantic.elements, appTarget);
      return baseResult(workspace, 'observe', {
        app,
        tier: resolvedAppTier(app, appTarget),
        perception: semantic.perception || perception,
        semanticAvailable: true,
        semanticObservationId: remembered.id,
        ...(capture ? { capture } : {}),
        changed: remembered.changed,
        count: semantic.elements.length,
        ...(semantic.ocrAvailable !== undefined ? { ocrAvailable: semantic.ocrAvailable } : {}),
        ...(semantic.ocrReason ? { ocrReason: semantic.ocrReason } : {}),
        ...(remembered.changed ? {
          window: semantic.window,
          elements: semantic.elements,
          truncated: semantic.truncated === true
        } : {}),
        engine: semanticAdapter.engine
      });
    }
    const displayId = optionalDisplayId(args.displayId);
    const fallback = await captureComputerObservation(adapter, sessionId, app, displayId, args, appTarget, signal);
    return baseResult(workspace, 'observe', {
      ...(displayId ? { displayId } : {}),
      app,
      tier: resolvedAppTier(app, appTarget),
      perception,
      semanticAvailable: false,
      semanticReason: semantic.reason || 'Structured desktop controls were unavailable; returned a visual observation instead.',
      ...(semantic.ocrAvailable !== undefined ? { ocrAvailable: semantic.ocrAvailable } : {}),
      ...(semantic.ocrReason ? { ocrReason: semantic.ocrReason } : {}),
      ...fallback,
      engine: String(fallback.captureEngine || adapter.engine || '@midscene/computer')
    });
  } catch (error) {
    signal?.throwIfAborted?.();
    if ((error as { code?: string })?.code === 'COMPUTER_APP_CAPTURE_UNAVAILABLE') throw error;
    const displayId = optionalDisplayId(args.displayId);
    const fallback = await captureComputerObservation(adapter, sessionId, app, displayId, args, appTarget, signal);
    return baseResult(workspace, 'observe', {
      ...(displayId ? { displayId } : {}),
      app,
      tier: resolvedAppTier(app, appTarget),
      perception,
      semanticAvailable: false,
      semanticReason: `Structured desktop observation failed; returned a visual observation instead: ${errorMessage(error)}`,
      ...fallback,
      engine: String(fallback.captureEngine || adapter.engine || '@midscene/computer')
    });
  }
}

function normalizeBatchSteps(value: unknown): ComputerArgs[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('batch requires a non-empty actions array.');
  if (value.length > MAX_BATCH_ACTIONS) throw new Error(`batch supports at most ${MAX_BATCH_ACTIONS} actions per call.`);
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`batch actions[${index}] must be an object with an action field.`);
    }
    const step = entry as Record<string, unknown>;
    normalizeAction(step.action);
    return step as ComputerArgs;
  });
}

function currentComputerLock(): ComputerSessionLock | null {
  if (!computerSessionLock) return null;
  if (Date.now() - computerSessionLock.lastActive > COMPUTER_LOCK_TTL_MS) {
    computerSessionLock = null;
    return null;
  }
  return computerSessionLock;
}

function acquireComputerLock(holder: string, app: string | null): void {
  const current = currentComputerLock();
  if (current && current.holder !== holder) throw new ComputerSessionLockedError(current.holder);
  const now = Date.now();
  if (current && current.holder === holder) {
    current.lastActive = now;
    if (app) current.app = app;
    return;
  }
  computerSessionLock = { holder, app, since: new Date(now).toISOString(), lastActive: now };
}

function touchComputerLock(): void {
  if (computerSessionLock) computerSessionLock.lastActive = Date.now();
}

function releaseComputerLock(holder: string): boolean {
  const current = currentComputerLock();
  if (!current) return false;
  if (current.holder !== holder) throw new ComputerSessionLockedError(current.holder);
  computerSessionLock = null;
  return true;
}

async function captureComputerObservation(
  adapter: ComputerAdapter,
  sessionId: string,
  app: string,
  displayId: string | undefined,
  args: ComputerArgs,
  appTarget?: ResolvedAppTarget,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const image = await captureAppImage(adapter, app, displayId, appTarget, args, signal);
  return prepareObservationResult(image, sessionId, app, displayId, args.profile, args.forceImage === true, args.previousObservationId);
}

async function captureAppImage(adapter: ComputerAdapter, app: string, displayId?: string, appTarget?: ResolvedAppTarget, args: ComputerArgs = {}, signal?: AbortSignal): Promise<ComputerAppImage> {
  if (typeof adapter.screenshotApp !== 'function') throw appCaptureUnavailable();
  const requestedAt = Date.now();
  try {
    return validateAppImage(await adapter.screenshotApp(app, displayId, { fresh: true, ...(signal ? { signal } : {}), ...(appTarget ? { target: appTarget } : {}), ...(args.windowTitle ? { windowTitle: String(args.windowTitle) } : {}), ...(args.windowId ? { windowId: String(args.windowId) } : {}) }), app, displayId, requestedAt);
  } catch (error) {
    signal?.throwIfAborted?.();
    const code = String((error as { code?: string })?.code || '');
    if (/^COMPUTER_(APP_CAPTURE|APP_TARGET|APPROVAL|TIER|HELPER)_/.test(code)) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    if (/APP_CAPTURE_DENIED|WGC_DENIED/.test(detail)) throw appCaptureUnavailable('Windows denied capture of this app. Use supported semantic controls or browser tools; another pixel provider will not bypass this restriction.');
    if (/APP_TARGET_STALE/.test(detail)) throw appCaptureUnavailable('The selected app window changed during capture. Select its current windowTitle/windowId and retry.');
    throw appCaptureUnavailable('This app could not provide verified window pixels. Use an executable or product name (for example, notepad or Visual Studio Code), optionally select windowTitle/windowId, and restore minimized windows yourself. If pixels remain unavailable, use supported semantic controls or browser tools.');
  }
}

function appImageSha256(source: ComputerAppImage): string {
  const p = source.provenance;
  return principalFingerprint(JSON.stringify([computerImageSha256(source), p.windowId, p.processId, p.processStartedAt, p.displayId, p.originX, p.originY, source.width, source.height]));
}

async function prepareObservationResult(
  source: ComputerAppImage,
  sessionId: string,
  app: string,
  displayId: string | undefined,
  profileValue: unknown,
  forceImage: boolean,
  previousObservationIdValue?: unknown
): Promise<Record<string, unknown>> {
  pruneObservations();
  const profile = normalizeScreenshotProfile(profileValue);
  const sourceSha256 = appImageSha256(source);
  const scope = observationScopeKey(sessionId, app, displayId);
  displayId = source.provenance.displayId;
  const explicitPreviousId = optionalObservationId(previousObservationIdValue);
  const previous = explicitPreviousId
    ? requireComputerObservation(explicitPreviousId, sessionId, app, displayId)
    : observationById(lastObservationByScope.get(scope));
  const observationId = observationIdFor(sessionId, app, displayId, sourceSha256, profile);

  if (!forceImage && previous && previous.sourceSha256 === sourceSha256 && previous.profile === profile) {
    const record: ComputerObservationRecord = { ...previous, id: observationId, capture: source.provenance, capturedAt: Date.now() };
    rememberObservation(scope, record);
    return {
      observationId,
      previousObservationId: previous.id,
      changed: false,
      displayId,
      capture: source.provenance,
      captureEngine: source.provenance.method,
      profile
    };
  }

  const prepared = await prepareComputerObservation(source, profile);
  const record: ComputerObservationRecord = {
    id: observationId,
    sessionId,
    app,
    ...(displayId ? { displayId } : {}),
    sourceSha256,
    sourceWidth: prepared.image.sourceWidth,
    originX: source.provenance.originX,
    originY: source.provenance.originY,
    capture: source.provenance,
    sourceHeight: prepared.image.sourceHeight,
    imageWidth: prepared.image.width,
    imageHeight: prepared.image.height,
    profile,
    capturedAt: Date.now()
  };
  rememberObservation(scope, record);
  const changed = !previous || previous.sourceSha256 !== record.sourceSha256;
  return {
    observationId,
    ...(previous ? { previousObservationId: previous.id } : {}),
    changed,
    displayId,
    capture: source.provenance,
      captureEngine: source.provenance.method,
    profile,
    image: prepared.image
  };
}

async function executeWaitForChange(
  adapter: ComputerAdapter,
  semanticAdapter: ComputerSemanticAdapter,
  workspace: ComputerWorkspace,
  config: ComputerControlConfig | null | undefined,
  args: ComputerArgs,
  sessionId: string,
  signal?: AbortSignal
): Promise<ComputerControlResultDto> {
  const app = requiredComputerApp(args.app);
  const displayId = optionalDisplayId(args.displayId);
  const appTarget = await authorizeResolvedApp(semanticAdapter, app, config, args, sessionId, 'wait_for_change', signal);
  acquireComputerLock(sessionId, app);

  const timeoutMs = boundedInteger(args.timeoutMs, 100, 30_000, DEFAULT_CHANGE_TIMEOUT_MS, 'timeoutMs');
  const pollMs = boundedInteger(args.pollMs, 50, 1_000, DEFAULT_CHANGE_POLL_MS, 'pollMs');
  const scope = observationScopeKey(sessionId, app, displayId);
  const explicitPreviousId = optionalObservationId(args.previousObservationId);
  const previous = explicitPreviousId
    ? requireComputerObservation(explicitPreviousId, sessionId, app, displayId)
    : observationById(lastObservationByScope.get(scope));
  let baselineSha256 = previous?.sourceSha256;
  if (!baselineSha256) {
    const baseline = await captureAppImage(adapter, app, displayId, appTarget, args, signal);
    baselineSha256 = appImageSha256(baseline);
  }

  const startedAt = performance.now();
  while (performance.now() - startedAt < timeoutMs) {
    signal?.throwIfAborted?.();
    const remaining = timeoutMs - (performance.now() - startedAt);
    await delay(Math.max(1, Math.min(pollMs, remaining)), undefined, signal ? { signal } : undefined);
    const source = await captureAppImage(adapter, app, displayId, appTarget, args, signal);
    if (appImageSha256(source) === baselineSha256) continue;
    const observation = await prepareObservationResult(
      source,
      sessionId,
      app,
      displayId,
      args.profile,
      args.forceImage === true,
      previous?.id && observationById(previous.id) ? previous.id : undefined
    );
    touchComputerLock();
    return baseResult(workspace, 'wait_for_change', {
      ...(displayId ? { displayId } : {}),
      app,
      tier: resolvedAppTier(app, appTarget),
      durationMs: Math.round(performance.now() - startedAt),
      ...observation,
      engine: String(observation.captureEngine || adapter.engine || '@midscene/computer')
    });
  }
  throw new Error(`Computer display did not change within ${timeoutMs}ms.`);
}

async function executeWaitForStable(
  adapter: ComputerAdapter,
  semanticAdapter: ComputerSemanticAdapter,
  workspace: ComputerWorkspace,
  config: ComputerControlConfig | null | undefined,
  args: ComputerArgs,
  sessionId: string,
  signal?: AbortSignal
): Promise<ComputerControlResultDto> {
  const app = requiredComputerApp(args.app);
  const displayId = optionalDisplayId(args.displayId);
  const appTarget = await authorizeResolvedApp(semanticAdapter, app, config, args, sessionId, 'wait_for_stable', signal);
  acquireComputerLock(sessionId, app);

  const timeoutMs = boundedInteger(args.timeoutMs, 100, 30_000, DEFAULT_CHANGE_TIMEOUT_MS, 'timeoutMs');
  const pollMs = boundedInteger(args.pollMs, 50, 1_000, DEFAULT_CHANGE_POLL_MS, 'pollMs');
  const stableMs = Math.min(
    timeoutMs,
    boundedInteger(args.stableMs, 100, 5_000, DEFAULT_STABLE_MS, 'stableMs')
  );
  const scope = observationScopeKey(sessionId, app, displayId);
  const explicitPreviousId = optionalObservationId(args.previousObservationId);
  const previous = explicitPreviousId
    ? requireComputerObservation(explicitPreviousId, sessionId, app, displayId)
    : observationById(lastObservationByScope.get(scope));

  let source = await captureAppImage(adapter, app, displayId, appTarget, args, signal);
  let lastSha256 = appImageSha256(source);
  let stableSince = performance.now();
  const startedAt = stableSince;
  while (true) {
    signal?.throwIfAborted?.();
    const now = performance.now();
    if (now - stableSince >= stableMs) {
      const observation = await prepareObservationResult(
        source,
        sessionId,
        app,
        displayId,
        args.profile,
        args.forceImage === true,
        previous?.id && observationById(previous.id) ? previous.id : undefined
      );
      touchComputerLock();
      return baseResult(workspace, 'wait_for_stable', {
        ...(displayId ? { displayId } : {}),
        app,
        tier: resolvedAppTier(app, appTarget),
        stable: true,
        stableMs,
        durationMs: Math.round(now - startedAt),
        ...observation,
        engine: String(observation.captureEngine || adapter.engine || '@midscene/computer')
      });
    }
    if (now - startedAt >= timeoutMs) break;
    const remaining = timeoutMs - (now - startedAt);
    const untilStable = stableMs - (now - stableSince);
    await delay(Math.max(1, Math.min(pollMs, remaining, untilStable)), undefined, signal ? { signal } : undefined);
    source = await captureAppImage(adapter, app, displayId, appTarget, args, signal);
    const sha256 = appImageSha256(source);
    if (sha256 !== lastSha256) {
      lastSha256 = sha256;
      stableSince = performance.now();
    }
  }
  throw new Error(`Computer display did not remain stable for ${stableMs}ms within ${timeoutMs}ms.`);
}

function observationScopeKey(sessionId: string, app: string, displayId?: string): string {
  return `${sessionId}\u0000${app}\u0000${displayId || '__primary__'}`;
}

function observationIdFor(
  sessionId: string,
  app: string,
  displayId: string | undefined,
  sourceSha256: string,
  profile: ScreenshotProfile
): string {
  return `obs_${principalFingerprint(`${sessionId}:${app}:${displayId || '__primary__'}:${sourceSha256}:${profile}`).slice(0, 24)}`;
}

function rememberObservation(scope: string, record: ComputerObservationRecord): void {
  observations.delete(record.id);
  observations.set(record.id, record);
  lastObservationByScope.set(scope, record.id);
  pruneObservations();
}

function pruneObservations(): void {
  const now = Date.now();
  for (const [id, record] of observations) {
    if (now - record.capturedAt <= OBSERVATION_TTL_MS) continue;
    observations.delete(id);
  }
  while (observations.size > MAX_OBSERVATIONS) {
    const oldest = observations.keys().next().value as string | undefined;
    if (!oldest) break;
    observations.delete(oldest);
  }
  for (const [scope, id] of lastObservationByScope) {
    if (!observations.has(id)) lastObservationByScope.delete(scope);
  }
}

function observationById(value: unknown): ComputerObservationRecord | null {
  const id = optionalObservationId(value);
  if (!id) return null;
  const record = observations.get(id);
  if (!record) return null;
  if (Date.now() - record.capturedAt > OBSERVATION_TTL_MS) {
    observations.delete(id);
    return null;
  }
  return record;
}

function requireComputerObservation(
  value: unknown,
  sessionId: string,
  app: string,
  displayId?: string
): ComputerObservationRecord {
  const id = optionalObservationId(value);
  const record = observationById(id);
  if (!id || !record) throw new Error('Computer observation is missing or expired; take a new screenshot and retry.');
  if (record.sessionId !== sessionId || record.app !== app) {
    throw new Error('Computer observation belongs to a different session or app; take a new screenshot and retry.');
  }
  if (displayId && record.displayId !== displayId) {
    throw new Error(`Computer observation does not belong to display '${displayId}'.`);
  }
  return record;
}

function resolveInputDisplayId(
  sessionId: string,
  app: string,
  displayIdValue: unknown,
  observationIdValue: unknown
): string | undefined {
  const explicit = optionalDisplayId(displayIdValue);
  const observationId = optionalObservationId(observationIdValue);
  if (!observationId) return explicit;
  const observation = requireComputerObservation(observationId, sessionId, app, explicit);
  return observation.displayId || explicit;
}

function optionalObservationId(value: unknown): string | undefined {
  const id = String(value ?? '').trim();
  return id || undefined;
}


async function assertObservationInputTarget(
  adapter: ComputerAdapter, sessionId: string, app: string, displayId: string | undefined,
  observationIdValue: unknown, points: readonly ComputerPoint[], requiresFocus: boolean, signal?: AbortSignal
): Promise<void> {
  const id = optionalObservationId(observationIdValue);
  if (!id) return;
  const observation = requireComputerObservation(id, sessionId, app, displayId);
  if ((!requiresFocus && points.length === 0) || typeof adapter.assertAppInputTarget !== 'function') throw appInputTargetUnverified();
  signal?.throwIfAborted?.();
  try {
    await adapter.assertAppInputTarget(app, {
      provenance: observation.capture, width: observation.sourceWidth, height: observation.sourceHeight,
      points, requiresFocus
    });
  } catch {
    signal?.throwIfAborted?.();
    throw appInputTargetUnverified();
  }
  signal?.throwIfAborted?.();
}

async function resolveDisplayPoint(
  adapter: ComputerAdapter,
  displayId: string | undefined,
  xValue: unknown,
  yValue: unknown,
  label: string,
  sessionId: string,
  observationIdValue: unknown,
  app: string
): Promise<ComputerPoint> {
  const observationId = optionalObservationId(observationIdValue);
  if (observationId) {
    const observation = requireComputerObservation(observationId, sessionId, app, displayId);
    const observed = resolvePointInSize(
      displayId,
      xValue,
      yValue,
      label,
      { width: observation.imageWidth, height: observation.imageHeight }
    );
    return {
      x: observation.originX + Math.min(observation.sourceWidth - 1, Math.floor(observed.x * observation.sourceWidth / observation.imageWidth)),
      y: observation.originY + Math.min(observation.sourceHeight - 1, Math.floor(observed.y * observation.sourceHeight / observation.imageHeight))
    };
  }
  const size = await cachedDisplaySize(adapter, displayId);
  return resolvePointInSize(displayId, xValue, yValue, label, size);
}

function resolvePointInSize(
  displayId: string | undefined,
  xValue: unknown,
  yValue: unknown,
  label: string,
  size: { width: number; height: number }
): ComputerPoint {
  const x = boundedInteger(xValue, 0, 100000, null, `${label} x`);
  const y = boundedInteger(yValue, 0, 100000, null, `${label} y`);
  if (x >= size.width || y >= size.height) {
    const target = displayId ? `display '${displayId}'` : 'the primary display';
    throw new Error(`${label} must be inside ${target} (${size.width}x${size.height}).`);
  }
  return { x, y };
}

async function cachedDisplaySize(
  adapter: ComputerAdapter,
  displayId: string | undefined
): Promise<{ width: number; height: number }> {
  const key = `${adapter.engine || 'default'}::${displayId || '__primary__'}`;
  const cached = displaySizeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await adapter.size(displayId);
  displaySizeCache.set(key, { value, expiresAt: Date.now() + DISPLAY_SIZE_CACHE_TTL_MS });
  return value;
}

function normalizeAction(value: unknown): ComputerAction {
  const action = String(value || '').trim().toLowerCase();
  if (!COMPUTER_ACTIONS.has(action as ComputerAction)) {
    throw new Error(`Unsupported computer action: ${action || '(missing)'}.`);
  }
  return action as ComputerAction;
}

function rememberSemanticObservation(
  sessionId: string,
  app: string,
  maxElements: number,
  perception: SemanticPerception,
  targets: readonly SemanticTarget[],
  appTarget?: ResolvedAppTarget
): { id: string; changed: boolean } {
  pruneSemanticObservations();
  const scope = `${sessionId}\u0000${app}`;
  const fingerprint = principalFingerprint(JSON.stringify([appTarget?.windowId, appTarget?.processStartedAt, appTarget?.content?.processStartedAt, targets.map(target => [
    target.source, target.role, target.name, target.automationId, target.className, target.enabled,
    target.displayId, target.x, target.y, target.width, target.height, target.centerX, target.centerY,
    target.patterns || []
  ])]));
  const previousId = lastSemanticObservationByScope.get(scope);
  const previous = previousId ? semanticObservations.get(previousId) : undefined;
  if (previous && previous.fingerprint === fingerprint && previous.maxElements === maxElements && previous.perception === perception) {
    semanticObservations.set(previous.id, Object.freeze({
      ...previous,
      targets: Object.freeze([...targets]),
      ...(appTarget ? { appTarget } : {}),
      capturedAt: Date.now()
    }));
    return { id: previous.id, changed: false };
  }
  const id = `uia_${principalFingerprint(`${sessionId}:${app}:${Date.now()}:${semanticObservations.size}:${fingerprint}`).slice(0, 24)}`;
  semanticObservations.set(id, Object.freeze({
    id,
    sessionId,
    app,
    maxElements,
    perception,
    fingerprint,
    targets: Object.freeze([...targets]),
    ...(appTarget ? { appTarget } : {}),
    capturedAt: Date.now()
  }));
  lastSemanticObservationByScope.set(scope, id);
  pruneSemanticObservations();
  return { id, changed: true };
}

function requireSemanticObservation(value: unknown, sessionId: string, app: string): SemanticObservationRecord {
  const id = requiredIdentifier(value, 'semanticObservationId is required.');
  pruneSemanticObservations();
  const record = semanticObservations.get(id);
  if (!record) throw new Error('Semantic desktop observation is missing or expired; run relai_computer observe again.');
  if (record.sessionId !== sessionId || record.app !== app) {
    throw new Error('Semantic desktop observation belongs to a different session or app; run relai_computer observe again.');
  }
  return record;
}

function pruneSemanticObservations(): void {
  const now = Date.now();
  for (const [id, record] of semanticObservations) {
    if (now - record.capturedAt > SEMANTIC_OBSERVATION_TTL_MS) semanticObservations.delete(id);
  }
  while (semanticObservations.size > MAX_SEMANTIC_OBSERVATIONS) {
    const oldest = semanticObservations.keys().next().value as string | undefined;
    if (!oldest) break;
    semanticObservations.delete(oldest);
  }
  for (const [scope, id] of lastSemanticObservationByScope) {
    if (!semanticObservations.has(id)) lastSemanticObservationByScope.delete(scope);
  }
}

function revalidatedSemanticTarget(original: SemanticTarget, current: readonly SemanticTarget[]): SemanticTarget | null {
  const sameRole = (target: SemanticTarget) => target.source === original.source && target.role === original.role;
  let candidates: SemanticTarget[];
  if (original.automationId) {
    candidates = current.filter(target => sameRole(target) && target.automationId === original.automationId);
    if (original.className && candidates.length > 1) candidates = candidates.filter(target => target.className === original.className);
    if (original.name && candidates.length > 1) candidates = candidates.filter(target => target.name === original.name);
  } else {
    candidates = current.filter(target => sameRole(target) && target.name === original.name && target.className === original.className);
  }
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

function clearSessionObservations(sessionId: string): void {
  for (const [id, record] of observations) {
    if (record.sessionId === sessionId) observations.delete(id);
  }
  for (const [scope, id] of lastObservationByScope) {
    if (!observations.has(id) || scope.startsWith(`${sessionId}\u0000`)) lastObservationByScope.delete(scope);
  }
  for (const [id, record] of semanticObservations) {
    if (record.sessionId === sessionId) semanticObservations.delete(id);
  }
  for (const [scope, id] of lastSemanticObservationByScope) {
    if (!semanticObservations.has(id) || scope.startsWith(`${sessionId}\u0000`)) lastSemanticObservationByScope.delete(scope);
  }
}

function requiredIdentifier(value: unknown, message: string): string {
  const identifier = String(value ?? '').trim();
  if (!identifier) throw new Error(message);
  return identifier;
}

function resolveAdapter(context: ComputerContext): ComputerAdapter {
  if (context.computerAdapter) return context.computerAdapter;
  return {
    ...defaultComputerAdapter,
    screenshotApp: (app, displayId, options) => defaultSemanticAdapter.screenshotApp!(app, displayId, options),
    assertAppInputTarget: (app, target) => defaultSemanticAdapter.assertAppInputTarget!(app, target)
  };
}

function resolveSemanticAdapter(context: ComputerContext): ComputerSemanticAdapter {
  if (context.semanticAdapter) return context.semanticAdapter;
  if (context.computerAdapter) return {
    engine: 'injected-adapter-semantic-unavailable', supported: () => false,
    warmup: async () => ({ supported: false, available: false, ocrAvailable: false }),
    observe: async () => ({ supported: false, available: false, reason: 'No semantic adapter was supplied with this custom computer adapter.' }),
    activate: async () => ({ supported: false, available: false, handled: false }),
    setValue: async () => ({ supported: false, available: false, handled: false }),
    shutdown: async () => {}
  };
  return defaultSemanticAdapter;
}

function startSemanticWarmup(context: ComputerContext): void {
  if (context.computerAdapter && !context.semanticAdapter) return;
  const semanticAdapter = resolveSemanticAdapter(context);
  if (!semanticAdapter.supported() || typeof semanticAdapter.warmup !== 'function') return;
  void semanticAdapter.warmup().catch(() => {});
}

function normalizeSemanticPerception(value: unknown): SemanticPerception {
  const perception = String(value || 'auto').trim().toLowerCase();
  if (perception === 'auto' || perception === 'semantic' || perception === 'hybrid') return perception;
  throw new Error('perception must be auto, semantic, or hybrid.');
}

function optionalDisplayId(value: unknown): string | undefined {
  const displayId = String(value ?? '').trim();
  return displayId || undefined;
}

function requiredComputerApp(value: unknown): string {
  const app = normalizeAppName(value);
  if (!app) throw new Error('Computer control requires an explicit app for this action.');
  return app;
}

function computerControlSessionId(context: ComputerContext): string {
  const conversationId = String(context.conversationId || '').trim();
  if (conversationId) return `conversation:${principalFingerprint(`conversation:${conversationId}`).slice(0, 16)}`;
  const transportSessionId = String(context.transportSessionId || '').trim();
  if (transportSessionId) return `transport:${principalFingerprint(`transport:${transportSessionId}`).slice(0, 16)}`;
  const taskId = String(context.taskId || '').trim();
  if (taskId) return `task:${principalFingerprint(`task:${taskId}`).slice(0, 16)}`;
  return `principal:${principalFingerprint(context.principal || 'local:trusted').slice(0, 16)}`;
}

function baseResult(
  workspace: ComputerWorkspace,
  action: string,
  extra: Readonly<Record<string, unknown>> = {}
): ComputerControlResultDto {
  return { ok: true, workspace: workspace.alias, action, platform: process.platform, ...extra };
}

function normalizeKey(value: unknown): string {
  const key = String(value || '').trim().toLowerCase();
  if (!key) throw new Error('key requires a key name.');
  if (Object.hasOwn(MODIFIER_ALIASES, key)) throw new Error('Use hotkey for modifier chords.');
  return KEY_ALIASES[key as keyof typeof KEY_ALIASES] || key;
}

function normalizeHotkey(value: unknown): { key: string; keys: string[]; keyName: string } {
  if (!Array.isArray(value) || value.length < 2) throw new Error('hotkey requires at least one modifier and one key.');
  const raw = value.map(item => String(item || '').trim().toLowerCase()).filter(Boolean);
  if (raw.length < 2) throw new Error('hotkey requires at least one modifier and one key.');
  const key = normalizeKey(raw.at(-1));
  const modifiers = raw.slice(0, -1).map(item => MODIFIER_ALIASES[item as keyof typeof MODIFIER_ALIASES]);
  if (modifiers.some(item => !item)) throw new Error('hotkey modifiers must be ctrl/control, shift, alt/option, or cmd/command/meta/win/super.');
  const keys = [...modifiers, key] as string[];
  return { key, keys, keyName: keys.join('+') };
}

function normalizeScrollDirection(value: unknown): ScrollDirection {
  const direction = String(value || '').toLowerCase();
  if (!['up', 'down', 'left', 'right'].includes(direction)) throw new Error('scroll direction must be up, down, left, or right.');
  return direction as ScrollDirection;
}

function boundedInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number | null,
  label: string
): number {
  if (value === undefined || value === null || value === '') {
    if (fallback !== null) return fallback;
    throw new Error(`${label} is required.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a number.`);
  const integer = Math.round(number);
  if (integer < min || integer > max) throw new Error(`${label} must be between ${min} and ${max}.`);
  return integer;
}

function queueInput<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted?.();
  let started = false;
  const execute = async () => {
    signal?.throwIfAborted?.();
    started = true;
    return operation();
  };
  const run = inputQueue.then(execute, execute);
  inputQueue = run.catch(() => undefined);
  if (!signal) return run;

  return new Promise<T>((resolve, reject) => {
    let cancelledWhileQueued = false;
    const onAbort = () => {
      if (started) return;
      cancelledWhileQueued = true;
      try {
        signal.throwIfAborted();
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    run.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        if (!cancelledWhileQueued) resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        if (!cancelledWhileQueued) reject(error);
      }
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'unknown error');
}

export { computerControlSettings, readComputerStatus, runComputerAction };
