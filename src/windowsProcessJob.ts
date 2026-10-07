import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeProcessEnvironment } from './processEnvironment.js';
import { getStateDir } from './statePaths.js';
import { readWindowsProcessJobArtifacts } from './windowsProcessJobArtifacts.js';

const HELPER = fileURLToPath(new URL('./windows-process-job.ps1', import.meta.url));
const RECEIPT_LIMIT = 16 * 1024;
const PROTOCOL = 1;

interface WindowsJobReceipt {
  readonly protocol: number;
  readonly final?: boolean;
  readonly nonce: string;
  readonly helperPid: number;
  readonly rootPid?: number;
  readonly rootCreationIdentity?: string;
  readonly rootExitCode?: number;
  readonly rootExited?: boolean;
  readonly activeProcesses?: number;
  readonly jobComplete?: boolean;
  readonly cleanupConfirmed?: boolean;
  readonly commandStarted?: boolean;
  readonly startupFailedBeforeCommand?: boolean;
  readonly stopReason?: string;
  readonly error?: string;
}

function completedNativeJob(receipt: WindowsJobReceipt | null): boolean {
  return receipt?.final === true && receipt.jobComplete === true && receipt.cleanupConfirmed === true
    && receipt.activeProcesses === 0
    && ((receipt.commandStarted === true && receipt.rootExited === true)
      || (receipt.commandStarted === false && receipt.startupFailedBeforeCommand === true));
}

interface JobInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Record<string, string | undefined>;
  readonly shellCommand?: string;
}

interface NormalizedCommand {
  readonly file: string;
  readonly commandArguments: string[];
  readonly options: { readonly argv0?: string; readonly windowsVerbatimArguments?: boolean };
}
type ExecaNormalizer = (file: string, args: readonly string[], options: Record<string, unknown>) => NormalizedCommand;
let normalizerPromise: Promise<ExecaNormalizer> | null = null;

async function execaNormalizer(): Promise<ExecaNormalizer> {
  normalizerPromise ||= (async () => {
    // Execa 10 does not export its Windows normalizer publicly. This guarded
    // adapter reuses the shipped parser; do not duplicate batch/shebang escaping.
    const root = new URL('.', import.meta.resolve('execa'));
    const manifest = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8')) as { version?: string };
    if (!/^10\./.test(String(manifest.version || ''))) throw new Error('Unsupported Execa version for native Windows job launch.');
    const module = await import(new URL('lib/arguments/options.js', root).href) as { normalizeOptions?: ExecaNormalizer };
    if (typeof module.normalizeOptions !== 'function') throw new Error('Execa Windows normalization is unavailable.');
    return module.normalizeOptions;
  })();
  return normalizerPromise;
}

function absoluteNativeExecutable(file: string): string {
  if (path.isAbsolute(file)) return file;
  if (/^cmd(?:\.exe)?$/i.test(file)) return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  throw new Error('Windows job normalization did not resolve an absolute executable.');
}

function readSmallJson(file: string, limit = RECEIPT_LIMIT): Record<string, unknown> | null {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(limit + 1);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (bytes > limit) return null;
      const value: unknown = JSON.parse(buffer.subarray(0, bytes).toString('utf8').replace(/^\uFEFF/, ''));
      return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function writeControl(file: string, value: object): void {
  const temporary = file + '.' + crypto.randomBytes(8).toString('hex');
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
}

export class WindowsProcessJob {
  readonly executable: string;
  readonly args: string[];
  readonly directory: string;
  readonly environment: Record<string, string | undefined>;
  private readonly nonce: string;
  private helperPid = 0;
  private completedReceipt: WindowsJobReceipt | null = null;

  constructor(directory: string, nonce: string, env?: Record<string, string | undefined>) {
    this.environment = {};
    if (env !== undefined) {
      const targetEnvironment = { ...env };
      if (process.env.NODE_V8_COVERAGE && !Object.hasOwn(env, 'NODE_V8_COVERAGE')) targetEnvironment.NODE_V8_COVERAGE = process.env.NODE_V8_COVERAGE;
      const seen = new Set<string>();
      const entries: [string, string][] = [];
      for (const key of Object.keys(targetEnvironment).sort()) {
        const value = targetEnvironment[key];
        if (seen.has(key.toUpperCase())) continue;
        seen.add(key.toUpperCase());
        if (value === undefined) continue;
        if (!key || key.includes('=') || key.includes('\0') || value.includes('\0')) throw new Error('Invalid Windows target environment.');
        entries.push([key, value]);
      }
      // Match libuv's Windows required-variable fallback after Node's
      // case-insensitive key selection. Explicit empty values stay empty.
      const present = new Set(entries.map(([key]) => key.toUpperCase()));
      for (const key of ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR']) {
        if (present.has(key)) continue;
        const hostKey = Object.keys(process.env).sort().find(name => name.toUpperCase() === key);
        const value = hostKey === undefined ? undefined : process.env[hostKey];
        if (value !== undefined) entries.push([key, value]);
      }
      const payload = JSON.stringify({ protocol: PROTOCOL, nonce, entries });
      if (payload.length > 24000) throw new Error('Windows target environment exceeds the 24000-character protected transport limit.');
      // Caller values only enter the in-memory payload. The trusted controller
      // starts with the host's filtered environment, never caller startup settings.
      this.environment = { ...makeProcessEnvironment({}), ['REL_AI_JOB_ENV_' + nonce]: payload };
    }
    this.directory = directory;
    this.nonce = nonce;
    const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    this.executable = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    this.args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER,
      '-RequestPath', path.join(directory, 'request.json'), '-ReceiptPath', path.join(directory, 'receipt.json'),
      '-ControlPath', path.join(directory, 'control.json')];
    try {
      // Fixed shipped companion only; stale/missing artifacts use trusted source.
      const artifacts = readWindowsProcessJobArtifacts(path.dirname(HELPER));
      if (artifacts.proof.companion.runtime === 'nativeaot-win-x64' && process.arch !== 'x64')
        throw new Error('Native Windows companion architecture is unavailable.');
      this.executable = artifacts.executable;
      this.args = this.args.slice(this.args.indexOf('-RequestPath'));
    } catch { /* PowerShell compiles or loads the source-pinned owner. */ }
  }

  bind(pid: number | null | undefined): void {
    const helperPid = Number(pid) || 0;
    if (helperPid !== this.helperPid) this.completedReceipt = null;
    this.helperPid = helperPid;
  }

  receipt(): WindowsJobReceipt | null {
    // Final native-zero proof is immutable for this nonce/helper identity.
    // Keep it when our own cleanup removes the receipt during a concurrent stop.
    if (this.completedReceipt) return this.completedReceipt;
    const value = readSmallJson(path.join(this.directory, 'receipt.json'));
    if (!value || value.protocol !== PROTOCOL || value.nonce !== this.nonce
      || !Number.isSafeInteger(value.helperPid) || Number(value.helperPid) <= 0
      || this.helperPid <= 0 || value.helperPid !== this.helperPid) return null;
    const receipt = value as unknown as WindowsJobReceipt;
    if (completedNativeJob(receipt)) this.completedReceipt = Object.freeze({ ...receipt });
    return this.completedReceipt || receipt;
  }

  outcome(): { exited: boolean; forced: boolean; error?: string } {
    const receipt = this.receipt();
    const complete = completedNativeJob(receipt);
    return {
      exited: complete,
      forced: Boolean(receipt?.stopReason),
      ...(!complete ? { error: receipt?.error || 'Native Windows job completion was not confirmed; ownership is retained.' } : {})
    };
  }

  async waitStarted(signal?: AbortSignal): Promise<WindowsJobReceipt> {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw signal.reason || new Error('Windows process startup was cancelled.');
      const receipt = this.receipt();
      if (receipt?.commandStarted || receipt?.startupFailedBeforeCommand || receipt?.jobComplete) return receipt;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Native Windows job startup receipt was not confirmed.');
  }

  async stop(reason: 'cancel' | 'timeout' | 'stop', waitMs: number): Promise<{ exited: boolean; forced: boolean; error?: string }> {
    if (this.outcome().exited) return this.outcome();
    try { writeControl(path.join(this.directory, 'control.json'), { protocol: PROTOCOL, nonce: this.nonce, action: 'stop', reason }); }
    catch { return { exited: false, forced: false, error: 'Native Windows job cancellation could not be recorded.' }; }
    const deadline = Date.now() + Math.max(1000, Math.min(30000, waitMs));
    do {
      const outcome = this.outcome();
      if (outcome.exited) return outcome;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    return this.outcome();
  }

  cleanup(): boolean {
    if (!this.outcome().exited) return false;
    try { fs.rmSync(this.directory, { recursive: true, force: true }); return true; } catch { return false; }
  }
}

export async function prepareWindowsProcessJob(config: Record<string, unknown>, input: JobInput, parentDirectory?: string): Promise<WindowsProcessJob> {
  if (Reflect.has(process, 'permission')) throw Object.assign(
    new Error('Native Windows job launch is unavailable under the Node permission model; caller code was not executed.'),
    { code: 'WINDOWS_JOB_PERMISSION_MODEL_UNSUPPORTED', executed: false }
  );
  const cwd = path.resolve(input.cwd || process.cwd());
  const normalize = await execaNormalizer();
  const normalized = input.shellCommand === undefined
    ? normalize(input.executable, input.args, { cwd, env: input.env, extendEnv: false, shell: false })
    : null;
  if (normalized && (typeof normalized.file !== 'string' || !Array.isArray(normalized.commandArguments)
    || normalized.commandArguments.some(value => typeof value !== 'string') || !normalized.options || typeof normalized.options !== 'object')) {
    throw new Error('Execa returned an unsupported Windows command shape.');
  }
  const executable = normalized ? absoluteNativeExecutable(normalized.file)
    : path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  const root = parentDirectory || path.join(getStateDir(config), 'process-jobs');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(root, 'job-'));
  const nonce = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(path.join(directory, 'request.json'), JSON.stringify({
      protocol: PROTOCOL, nonce, executable, args: normalized?.commandArguments || [], cwd,
      environmentTransportKey: 'REL_AI_JOB_ENV_' + nonce,
      ...(normalized?.options.argv0 ? { argv0: normalized.options.argv0 } : {}),
      ...(normalized?.options.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
      ...(input.shellCommand !== undefined ? { rawCommandLine: '"' + executable + '" /d /s /c "' + input.shellCommand + '"' } : {})
    }), { flag: 'wx', mode: 0o600 });
    return new WindowsProcessJob(directory, nonce, input.env);
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function restoreWindowsProcessJob(directory: string, helperPid: number | null | undefined): WindowsProcessJob | null {
  const value = readSmallJson(path.join(directory, 'request.json'), 256 * 1024);
  if (!value || value.protocol !== PROTOCOL || typeof value.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(value.nonce)) return null;
  const job = new WindowsProcessJob(directory, value.nonce);
  job.bind(helperPid);
  return job;
}
