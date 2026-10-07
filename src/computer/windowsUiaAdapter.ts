import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { selectAppTarget, type AppWindowCandidate, type AppTargetOptions, type ResolvedAppTarget } from './appTarget.ts';
import type { ComputerAppImage, ComputerAppInputTarget, ComputerPixelProvenance } from './midsceneAdapter.ts';
import { appCaptureUnavailable, appInputTargetUnverified, validateAppImage, validateAppPixelProvenance } from './appCapture.ts';

type SemanticSource = 'uia' | 'ocr';
type SemanticPerception = 'auto' | 'semantic' | 'hybrid';

type SemanticTarget = Readonly<{
  targetId: string;
  source: SemanticSource;
  role: string;
  name: string;
  automationId: string;
  className: string;
  enabled: boolean;
  displayId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  patterns?: string[];
}>;

type SemanticWindow = Readonly<{
  title: string;
  processName: string;
  processId: number;
  className: string;
  displayId?: string;
}>;

type SemanticObservation = Readonly<{
  supported: boolean;
  available: boolean;
  reason?: string;
  perception?: SemanticPerception;
  ocrAvailable?: boolean;
  ocrReason?: string;
  pixelProvenance?: ComputerPixelProvenance;
  window?: SemanticWindow;
  elements?: SemanticTarget[];
  count?: number;
  truncated?: boolean;
}>;

type SemanticWarmup = Readonly<{
  supported: boolean;
  available: boolean;
  ocrAvailable: boolean;
}>;

type SemanticActivation = Readonly<{
  supported: boolean;
  available: boolean;
  handled: boolean;
  reason?: string;
  method?: string;
  target?: SemanticTarget;
}>;

interface ComputerSemanticAdapter {
  readonly engine: string;
  resolveAppTarget?(app: string, options?: AppTargetOptions, signal?: AbortSignal): Promise<ResolvedAppTarget>;
  supported(): boolean;
  warmup(signal?: AbortSignal): Promise<SemanticWarmup>;
  observe(
    app: string,
    maxElements?: number,
    perception?: SemanticPerception,
    signal?: AbortSignal,
    appTarget?: ResolvedAppTarget
  ): Promise<SemanticObservation>;
  activate(
    app: string,
    target: SemanticTarget,
    maxElements?: number,
    perception?: SemanticPerception,
    signal?: AbortSignal,
    appTarget?: ResolvedAppTarget
  ): Promise<SemanticActivation>;
  setValue(
    app: string,
    target: SemanticTarget,
    text: string,
    maxElements?: number,
    signal?: AbortSignal,
    appTarget?: ResolvedAppTarget
  ): Promise<SemanticActivation>;
  screenshotApp?(app: string, displayId?: string, options?: { fresh?: boolean; signal?: AbortSignal; target?: ResolvedAppTarget; windowId?: string; windowTitle?: string }): Promise<ComputerAppImage>;
  assertAppInputTarget?(app: string, target: ComputerAppInputTarget): Promise<void>;
  shutdown(): Promise<void>;
}

type RequestPayload =
  | Readonly<{ action: 'warmup' }>
  | Readonly<{ action: 'app_targets'; binding?: ResolvedAppTarget; windowId?: string }>
  | Readonly<{ action: 'screenshot_app'; app: string; displayId?: string; appTarget?: ResolvedAppTarget }>
  | Readonly<{ action: 'verify_input_target'; app: string; target: ComputerAppInputTarget }>
  | Readonly<{ action: 'observe'; app: string; maxElements: number; perception: SemanticPerception; appTarget?: ResolvedAppTarget }>
  | Readonly<{ action: 'activate'; app: string; maxElements: number; perception: SemanticPerception; target: SemanticTarget; appTarget?: ResolvedAppTarget }>
  | Readonly<{ action: 'set_value'; app: string; maxElements: number; target: SemanticTarget; text: string; appTarget?: ResolvedAppTarget }>;
type RequestOverride = (payload: RequestPayload, signal?: AbortSignal) => Promise<unknown>;
type SpawnProcess = typeof spawn;

type WindowsUiaAdapterOptions = Readonly<{
  platform?: NodeJS.Platform;
  helperPath?: string;
  request?: RequestOverride;
  spawnProcess?: SpawnProcess;
  timeoutMs?: number;
}>;

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
  abortHandler?: () => void;
  signal?: AbortSignal;
};

const DEFAULT_MAX_ELEMENTS = 120;
const MAX_ELEMENTS = 300;
const DEFAULT_TIMEOUT_MS = 5_000;

function createWindowsUiaAdapter(options: WindowsUiaAdapterOptions = {}): ComputerSemanticAdapter {
  const platform = options.platform || process.platform;
  const requestOverride = options.request;
  const spawnProcess = options.spawnProcess || spawn;
  const helperPath = options.helperPath || fileURLToPath(new URL('./windows-uia-helper.ps1', import.meta.url));
  const timeoutMs = boundedInteger(options.timeoutMs, 500, 30_000, DEFAULT_TIMEOUT_MS);
  let child: ChildProcessWithoutNullStreams | null = null;
  let reader: readline.Interface | null = null;
  let nextRequestId = 1;
  let stderrTail = '';
  let warmupPromise: Promise<SemanticWarmup> | null = null;
  let cleanupPromise: Promise<void> | null = null;
  let containmentFailure: Error | null = null;
  const pending = new Map<string, PendingRequest>();

  function supported(): boolean {
    return platform === 'win32';
  }

  async function warmup(signal?: AbortSignal): Promise<SemanticWarmup> {
    signal?.throwIfAborted?.();
    if (!supported()) return { supported: false, available: false, ocrAvailable: false };
    if (!warmupPromise) {
      warmupPromise = request({ action: 'warmup' }, signal)
        .then(normalizeWarmup)
        .catch(error => {
          warmupPromise = null;
          throw error;
        });
    }
    const abortWarmup = () => {
      if (child && pending.size) void failProcess(signal?.reason instanceof Error ? signal.reason : new Error('Windows UI Automation warmup cancelled.'), child);
    };
    signal?.addEventListener('abort', abortWarmup, { once: true });
    try {
      const result = await warmupPromise;
      signal?.throwIfAborted?.();
      return result;
    } finally { signal?.removeEventListener('abort', abortWarmup); }
  }

  async function resolveAppTarget(app: string, options: AppTargetOptions = {}, signal?: AbortSignal): Promise<ResolvedAppTarget> {
    if (!supported()) throw appCaptureUnavailable('App target resolution is currently available only on Windows.');
    signal?.throwIfAborted?.();
    const result = await request({ action: 'app_targets', ...(options.binding ? { binding: options.binding } : {}), ...(options.windowId ? { windowId: options.windowId } : {}) }, signal) as Record<string, unknown>;
    if (result?.truncated === true) throw Object.assign(new Error('Application discovery reached its bounded window limit. Use windowId to select a specific approved window.'), { code: 'COMPUTER_APP_TARGET_AMBIGUOUS' });
    const candidates = Array.isArray(result?.candidates) ? result.candidates as AppWindowCandidate[] : [];
    return selectAppTarget(app, candidates, options);
  }

  async function observe(app: string, maxElements = DEFAULT_MAX_ELEMENTS, perception: SemanticPerception = 'auto', signal?: AbortSignal, appTarget?: ResolvedAppTarget): Promise<SemanticObservation> {
    return withDeadline(signal, deadline => observeWithinDeadline(app, maxElements, perception, deadline, appTarget));
  }

  async function observeWithinDeadline(
    app: string,
    maxElements = DEFAULT_MAX_ELEMENTS,
    perception: SemanticPerception = 'auto',
    signal?: AbortSignal,
    appTarget?: ResolvedAppTarget
  ): Promise<SemanticObservation> {
    if (!supported()) return { supported: false, available: false, reason: 'Windows UI Automation is available only on Windows.' };
    const normalizedApp = requiredApp(app);
    const normalizedPerception = normalizePerception(perception);
    await warmup(signal);
    const result = await request({
      action: 'observe',
      app: normalizedApp,
      maxElements: boundedInteger(maxElements, 1, MAX_ELEMENTS, DEFAULT_MAX_ELEMENTS),
      perception: normalizedPerception,
      ...(appTarget ? { appTarget } : {})
    }, signal);
    return normalizeObservation(result, normalizedPerception, normalizedApp);
  }

  async function assertAppInputTarget(app: string, target: ComputerAppInputTarget): Promise<void> {
    if (!supported()) throw appInputTargetUnverified();
    validateAppPixelProvenance(target.provenance, app, target.provenance.displayId, Date.now() - 30_000);
    const result = await request({ action: 'verify_input_target', app: requiredApp(app), target }) as Record<string, unknown>;
    if (result?.verified !== true || result.windowId !== target.provenance.windowId || result.processId !== target.provenance.processId) throw appInputTargetUnverified();
  }

  async function screenshotApp(app: string, displayId?: string, options: { target?: ResolvedAppTarget; windowId?: string; windowTitle?: string; signal?: AbortSignal } = {}): Promise<ComputerAppImage> {
    return withDeadline(options.signal, deadline => screenshotWithinDeadline(app, displayId, options, deadline));
  }

  async function screenshotWithinDeadline(app: string, displayId: string | undefined, options: { target?: ResolvedAppTarget; windowId?: string; windowTitle?: string }, signal: AbortSignal): Promise<ComputerAppImage> {
    if (!supported()) throw appCaptureUnavailable('App-only native capture is currently supported only on Windows.');
    const normalizedApp = requiredApp(app);
    const requestedAt = Date.now();
    let target = options.target || await resolveAppTarget(normalizedApp, { ...(options.windowId ? { windowId: options.windowId } : {}), ...(options.windowTitle ? { windowTitle: options.windowTitle } : {}), ...(displayId ? { displayId } : {}) }, signal);
    if (!options.target && target.approvalBasis === 'title') throw appCaptureUnavailable('A window title can select only an already approved application identity; use the executable or product name first.');
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await request({ action: 'screenshot_app', app: normalizedApp, ...(displayId ? { displayId } : {}), ...(target ? { appTarget: target } : {}) }, signal);
        return validateAppImage(result, normalizedApp, displayId, requestedAt);
      } catch (error) {
        // Retry once only after metadata revalidation of the same bound identity.
        // Denial/protection and timeout never trigger provider/identity changes.
        if (attempt > 0 || !target || !/APP_TARGET_STALE|WGC_SOURCE_CHANGED/.test(error instanceof Error ? error.message : String(error))) throw error;
        target = await resolveAppTarget(normalizedApp, { binding: target, ...(options.windowId ? { windowId: options.windowId } : {}), ...(options.windowTitle ? { windowTitle: options.windowTitle } : {}), ...(displayId ? { displayId } : {}) }, signal);
      }
    }
  }

  async function activate(
    app: string,
    target: SemanticTarget,
    maxElements = DEFAULT_MAX_ELEMENTS,
    perception: SemanticPerception = 'auto',
    signal?: AbortSignal,
    appTarget?: ResolvedAppTarget
  ): Promise<SemanticActivation> {
    if (!supported()) return { supported: false, available: false, handled: false, reason: 'Windows UI Automation is available only on Windows.' };
    const normalizedApp = requiredApp(app);
    const normalizedTarget = normalizeTarget(target);
    if (!normalizedTarget) throw new Error('Semantic activation requires a valid target.');
    await warmup(signal);
    signal?.throwIfAborted?.();
    const result = await request({
      action: 'activate',
      app: normalizedApp,
      maxElements: boundedInteger(maxElements, 1, MAX_ELEMENTS, DEFAULT_MAX_ELEMENTS),
      perception: normalizePerception(perception),
      ...(appTarget ? { appTarget } : {}),
      target: normalizedTarget
    });
    return normalizeActivation(result);
  }

  async function setValue(
    app: string,
    target: SemanticTarget,
    text: string,
    maxElements = DEFAULT_MAX_ELEMENTS,
    signal?: AbortSignal,
    appTarget?: ResolvedAppTarget
  ): Promise<SemanticActivation> {
    if (!supported()) return { supported: false, available: false, handled: false, reason: 'Windows UI Automation is available only on Windows.' };
    const normalizedApp = requiredApp(app);
    const normalizedTarget = normalizeTarget(target);
    if (!normalizedTarget) throw new Error('Semantic value setting requires a valid target.');
    const normalizedText = String(text ?? '');
    await warmup(signal);
    signal?.throwIfAborted?.();
    const result = await request({
      action: 'set_value',
      app: normalizedApp,
      maxElements: boundedInteger(maxElements, 1, MAX_ELEMENTS, DEFAULT_MAX_ELEMENTS),
      target: normalizedTarget,
      ...(appTarget ? { appTarget } : {}),
      text: normalizedText
    });
    return normalizeActivation(result);
  }

  async function request(payload: RequestPayload, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted?.();
    if (requestOverride) return requestOverride(payload, signal);
    if (cleanupPromise) await cleanupPromise;
    signal?.throwIfAborted?.();
    if (containmentFailure) throw containmentFailure;
    const process = ensureProcess();
    const id = `uia_${nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        void failProcess(Object.assign(new Error(`Windows UI Automation helper timed out after ${timeoutMs}ms.`), { code: 'COMPUTER_HELPER_TIMEOUT' }), process);
      }, timeoutMs);
      const entry: PendingRequest = { resolve, reject, timer, ...(signal ? { signal } : {}) };
      if (signal) {
        entry.abortHandler = () => {
          if (!pending.has(id)) return;
          const error = signal.reason instanceof Error ? signal.reason : new Error('Windows UI Automation request cancelled.');
          void failProcess(error, process);
        };
        signal.addEventListener('abort', entry.abortHandler, { once: true });
      }
      pending.set(id, entry);
      process.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, 'utf8', error => {
        if (!error || !pending.has(id)) return;
        void failProcess(error, process);
      });
    });
  }

  function ensureProcess(): ChildProcessWithoutNullStreams {
    if (child && child.exitCode === null && !child.killed) return child;
    stderrTail = '';
    const created = spawnProcess('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', helperPath
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child = created;
    created.stdout.setEncoding('utf8');
    created.stderr.setEncoding('utf8');
    reader = readline.createInterface({ input: created.stdout });
    reader.on('line', onLine);
    created.stderr.on('data', chunk => {
      stderrTail = `${stderrTail}${String(chunk)}`.slice(-4000).trim();
    });
    created.once('error', error => { if (child === created) void failProcess(error, created); });
    created.once('exit', (code, signal) => {
      if (child === created) void failProcess(new Error(`Windows UI Automation helper exited (${code ?? signal ?? 'unknown'}).${stderrTail ? ` ${stderrTail}` : ''}`), created);
    });
    return created;
  }

  function onLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let response: Record<string, unknown>;
    try {
      response = JSON.parse(text) as Record<string, unknown>;
    } catch {
      stderrTail = `${stderrTail}\nUnexpected helper output: ${text}`.slice(-4000).trim();
      return;
    }
    const id = String(response.id || '');
    if (!id || !pending.has(id)) return;
    if (response.ok === true) settlePending(id, true, response.result);
    else settlePending(id, false, new Error(String(response.error || 'Windows UI Automation helper failed.')));
  }

  function settlePending(id: string, ok: boolean, value: unknown): void {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (entry.signal && entry.abortHandler) entry.signal.removeEventListener('abort', entry.abortHandler);
    if (ok) entry.resolve(value);
    else entry.reject(value);
  }

  function failProcess(error: Error, expected: ChildProcessWithoutNullStreams | null = child): Promise<void> {
    if (expected !== child) return cleanupPromise || Promise.resolve();
    const active = child;
    child = null;
    reader?.close();
    reader = null;
    warmupPromise = null;
    // Detach pending results before termination. Late stdout/exit from an old
    // helper must never complete a request or affect its successor.
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      if (entry.signal && entry.abortHandler) entry.signal.removeEventListener('abort', entry.abortHandler);
    }
    const cleanup = (async () => {
      const confirmed = await terminateOwnedHelper(active);
      const failure = Object.assign(error, { terminationConfirmed: confirmed });
      if (!confirmed) containmentFailure = Object.assign(new Error('The owned computer helper did not confirm termination. Further requests are blocked.'), { code: 'COMPUTER_HELPER_TERMINATION_UNCONFIRMED' });
      for (const entry of entries) entry.reject(failure);
    })();
    cleanupPromise = cleanup;
    void cleanup.finally(() => { if (cleanupPromise === cleanup) cleanupPromise = null; });
    return cleanup;
  }

  function terminateOwnedHelper(active: ChildProcessWithoutNullStreams | null): Promise<boolean> {
    if (!active || active.exitCode !== null || active.signalCode !== null) return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false;
      const finish = (confirmed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        active.removeListener('exit', onExit);
        resolve(confirmed);
      };
      const onExit = () => finish(true);
      active.once('exit', onExit);
      const timer = setTimeout(() => finish(active.exitCode !== null || active.signalCode !== null), 1500);
      // Kill by the retained ChildProcess handle only, never enumerate or kill
      // by a remembered PID. A successful kill call is not an exit receipt.
      try { active.kill('SIGKILL'); } catch { finish(false); }
      if (active.exitCode !== null || active.signalCode !== null) finish(true);
    });
  }

  async function shutdown(): Promise<void> {
    if (cleanupPromise) await cleanupPromise;
    await failProcess(new Error('Windows UI Automation helper stopped.'));
    if (containmentFailure) throw containmentFailure;
  }

  async function withDeadline<T>(signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(Object.assign(new Error(`Computer helper operation exceeded ${timeoutMs}ms.`), { code: 'COMPUTER_HELPER_TIMEOUT' })), timeoutMs);
    try { combined.throwIfAborted(); return await action(combined); }
    finally { clearTimeout(timer); }
  }

  return Object.freeze({ engine: 'windows-uia', supported, warmup, resolveAppTarget, observe, screenshotApp, assertAppInputTarget, activate, setValue, shutdown });
}

function normalizeWarmup(value: unknown): SemanticWarmup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Windows UI Automation helper returned an invalid warmup result.');
  const source = value as Record<string, unknown>;
  return {
    supported: source.supported !== false,
    available: source.available === true,
    ocrAvailable: source.ocrAvailable === true
  };
}

function normalizeObservation(value: unknown, fallbackPerception: SemanticPerception, app: string): SemanticObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Windows UI Automation helper returned an invalid observation.');
  const source = value as Record<string, unknown>;
  if (source.supported === false) return { supported: false, available: false, reason: boundedString(source.reason, 1000) };
  if (source.available !== true) return { supported: true, available: false, reason: boundedString(source.reason, 1000) || 'No matching application window was found.' };
  const elements = Array.isArray(source.elements)
    ? source.elements.slice(0, MAX_ELEMENTS).map(normalizeTarget).filter((target): target is SemanticTarget => Boolean(target))
    : [];
  const window = normalizeWindow(source.window);
  const pixelProvenance = elements.some(target => target.source === 'ocr')
    ? validateAppPixelProvenance(source.pixelProvenance, app, window?.displayId)
    : undefined;
  return {
    supported: true,
    available: true,
    perception: normalizePerception(source.perception ?? fallbackPerception),
    ocrAvailable: source.ocrAvailable === true,
    ...(boundedString(source.ocrReason, 500) ? { ocrReason: boundedString(source.ocrReason, 500) } : {}),
    ...(window ? { window } : {}),
    ...(pixelProvenance ? { pixelProvenance } : {}),
    elements,
    count: elements.length,
    truncated: source.truncated === true || (Array.isArray(source.elements) && source.elements.length > MAX_ELEMENTS)
  };
}

function normalizeActivation(value: unknown): SemanticActivation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Windows UI Automation helper returned an invalid semantic action result.');
  const source = value as Record<string, unknown>;
  const target = normalizeTarget(source.target);
  return {
    supported: source.supported !== false,
    available: source.available === true,
    handled: source.handled === true,
    ...(boundedString(source.reason, 1000) ? { reason: boundedString(source.reason, 1000) } : {}),
    ...(boundedString(source.method, 100) ? { method: boundedString(source.method, 100) } : {}),
    ...(target ? { target } : {})
  };
}

function normalizeTarget(value: unknown): SemanticTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const targetId = boundedString(source.targetId, 100);
  const displayId = boundedString(source.displayId, 200);
  const width = safeInteger(source.width);
  const height = safeInteger(source.height);
  const centerX = safeInteger(source.centerX);
  const centerY = safeInteger(source.centerY);
  if (!targetId || !displayId || width <= 0 || height <= 0 || centerX < 0 || centerY < 0) return null;
  const patterns = Array.isArray(source.patterns)
    ? source.patterns.map(value => boundedString(value, 60)).filter(Boolean).slice(0, 12)
    : [];
  return Object.freeze({
    targetId,
    source: normalizeSource(source.source),
    role: boundedString(source.role, 100),
    name: boundedString(source.name, 500),
    automationId: boundedString(source.automationId, 300),
    className: boundedString(source.className, 300),
    enabled: source.enabled !== false,
    displayId,
    x: Math.max(0, safeInteger(source.x)),
    y: Math.max(0, safeInteger(source.y)),
    width,
    height,
    centerX,
    centerY,
    ...(patterns.length ? { patterns } : {})
  });
}

function normalizeWindow(value: unknown): SemanticWindow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  return Object.freeze({
    title: boundedString(source.title, 500),
    processName: boundedString(source.processName, 200),
    processId: Math.max(0, safeInteger(source.processId)),
    className: boundedString(source.className, 300),
    ...(boundedString(source.displayId, 200) ? { displayId: boundedString(source.displayId, 200) } : {})
  });
}

function requiredApp(value: unknown): string {
  const app = String(value || '').trim();
  if (!app) throw new Error('Semantic desktop operation requires a non-empty app name.');
  return app;
}

function normalizeSource(value: unknown): SemanticSource {
  return String(value || '').trim().toLowerCase() === 'ocr' ? 'ocr' : 'uia';
}

function normalizePerception(value: unknown): SemanticPerception {
  const perception = String(value || 'auto').trim().toLowerCase();
  if (perception === 'auto' || perception === 'semantic' || perception === 'hybrid') return perception;
  throw new Error('Semantic perception must be auto, semantic, or hybrid.');
}

function boundedString(value: unknown, maxLength: number): string {
  const text = String(value ?? '').trim();
  return text.length <= maxLength ? text : text.slice(0, maxLength);
}

function safeInteger(value: unknown): number {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? number : -1;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`Value must be between ${min} and ${max}.`);
  return number;
}

export { createWindowsUiaAdapter };
export type {
  ComputerSemanticAdapter, SemanticPerception, SemanticTarget
};
