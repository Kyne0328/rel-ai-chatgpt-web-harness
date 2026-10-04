import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

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
  supported(): boolean;
  warmup(signal?: AbortSignal): Promise<SemanticWarmup>;
  observe(
    app: string,
    maxElements?: number,
    perception?: SemanticPerception,
    signal?: AbortSignal
  ): Promise<SemanticObservation>;
  activate(
    app: string,
    target: SemanticTarget,
    maxElements?: number,
    perception?: SemanticPerception,
    signal?: AbortSignal
  ): Promise<SemanticActivation>;
  setValue(
    app: string,
    target: SemanticTarget,
    text: string,
    maxElements?: number,
    signal?: AbortSignal
  ): Promise<SemanticActivation>;
  shutdown(): Promise<void>;
}

type RequestPayload =
  | Readonly<{ action: 'warmup' }>
  | Readonly<{ action: 'observe'; app: string; maxElements: number; perception: SemanticPerception }>
  | Readonly<{ action: 'activate'; app: string; maxElements: number; perception: SemanticPerception; target: SemanticTarget }>
  | Readonly<{ action: 'set_value'; app: string; maxElements: number; target: SemanticTarget; text: string }>;
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
  const pending = new Map<string, PendingRequest>();

  function supported(): boolean {
    return platform === 'win32';
  }

  async function warmup(signal?: AbortSignal): Promise<SemanticWarmup> {
    signal?.throwIfAborted?.();
    if (!supported()) return { supported: false, available: false, ocrAvailable: false };
    if (!warmupPromise) {
      warmupPromise = request({ action: 'warmup' })
        .then(normalizeWarmup)
        .catch(error => {
          warmupPromise = null;
          throw error;
        });
    }
    const result = await warmupPromise;
    signal?.throwIfAborted?.();
    return result;
  }

  async function observe(
    app: string,
    maxElements = DEFAULT_MAX_ELEMENTS,
    perception: SemanticPerception = 'auto',
    signal?: AbortSignal
  ): Promise<SemanticObservation> {
    if (!supported()) return { supported: false, available: false, reason: 'Windows UI Automation is available only on Windows.' };
    const normalizedApp = requiredApp(app);
    const normalizedPerception = normalizePerception(perception);
    await warmup(signal);
    const result = await request({
      action: 'observe',
      app: normalizedApp,
      maxElements: boundedInteger(maxElements, 1, MAX_ELEMENTS, DEFAULT_MAX_ELEMENTS),
      perception: normalizedPerception
    }, signal);
    return normalizeObservation(result, normalizedPerception);
  }

  async function activate(
    app: string,
    target: SemanticTarget,
    maxElements = DEFAULT_MAX_ELEMENTS,
    perception: SemanticPerception = 'auto',
    signal?: AbortSignal
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
      target: normalizedTarget
    });
    return normalizeActivation(result);
  }

  async function setValue(
    app: string,
    target: SemanticTarget,
    text: string,
    maxElements = DEFAULT_MAX_ELEMENTS,
    signal?: AbortSignal
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
      text: normalizedText
    });
    return normalizeActivation(result);
  }

  async function request(payload: RequestPayload, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted?.();
    if (requestOverride) return requestOverride(payload, signal);
    const process = ensureProcess();
    const id = `uia_${nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        failProcess(new Error(`Windows UI Automation helper timed out after ${timeoutMs}ms.${stderrTail ? ` ${stderrTail}` : ''}`));
      }, timeoutMs);
      timer.unref?.();
      const entry: PendingRequest = { resolve, reject, timer, ...(signal ? { signal } : {}) };
      if (signal) {
        entry.abortHandler = () => {
          if (!pending.has(id)) return;
          pending.delete(id);
          clearTimeout(timer);
          try { signal.throwIfAborted(); } catch (error) { reject(error); }
        };
        signal.addEventListener('abort', entry.abortHandler, { once: true });
      }
      pending.set(id, entry);
      process.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, 'utf8', error => {
        if (!error || !pending.has(id)) return;
        failProcess(error);
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
    created.once('error', error => failProcess(error));
    created.once('exit', (code, signal) => {
      failProcess(new Error(`Windows UI Automation helper exited (${code ?? signal ?? 'unknown'}).${stderrTail ? ` ${stderrTail}` : ''}`));
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

  function failProcess(error: Error): void {
    const active = child;
    child = null;
    reader?.close();
    reader = null;
    warmupPromise = null;
    for (const id of [...pending.keys()]) settlePending(id, false, error);
    if (active && active.exitCode === null && !active.killed) active.kill();
  }

  async function shutdown(): Promise<void> {
    const active = child;
    child = null;
    reader?.close();
    reader = null;
    warmupPromise = null;
    for (const id of [...pending.keys()]) settlePending(id, false, new Error('Windows UI Automation helper stopped.'));
    if (!active || active.exitCode !== null || active.killed) return;
    active.stdin.end();
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        if (active.exitCode === null && !active.killed) active.kill();
        resolve();
      }, 500);
      timer.unref?.();
      active.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  return Object.freeze({ engine: 'windows-uia', supported, warmup, observe, activate, setValue, shutdown });
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

function normalizeObservation(value: unknown, fallbackPerception: SemanticPerception): SemanticObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Windows UI Automation helper returned an invalid observation.');
  const source = value as Record<string, unknown>;
  if (source.supported === false) return { supported: false, available: false, reason: boundedString(source.reason, 1000) };
  if (source.available !== true) return { supported: true, available: false, reason: boundedString(source.reason, 1000) || 'No matching application window was found.' };
  const elements = Array.isArray(source.elements)
    ? source.elements.slice(0, MAX_ELEMENTS).map(normalizeTarget).filter((target): target is SemanticTarget => Boolean(target))
    : [];
  const window = normalizeWindow(source.window);
  return {
    supported: true,
    available: true,
    perception: normalizePerception(source.perception ?? fallbackPerception),
    ocrAvailable: source.ocrAvailable === true,
    ...(boundedString(source.ocrReason, 500) ? { ocrReason: boundedString(source.ocrReason, 500) } : {}),
    ...(window ? { window } : {}),
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
