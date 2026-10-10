import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { isPathInside } from './safety.js';
import { directCommandDisplay } from './commandDisplay.ts';

const WHERE_EXE = String.raw`C:\Windows\System32\where.exe`;
const MAX_DIRECT_ARGV_ITEMS = 100;
const MAX_DIRECT_ARG_LENGTH = 20000;
const MAX_DIRECT_INPUT_LENGTH = 1024 * 1024;

interface WorkspacePath {
  readonly path: string;
}

interface ExecutionInvocationInput {
  readonly command?: unknown;
  readonly executable?: unknown;
  readonly argv?: unknown;
  readonly input?: unknown;
}

interface CommandHost {
  readonly executable: string;
  readonly label: string;
  readonly args: (command: string) => string[];
}

interface ShellCommandDefinition {
  readonly mode: 'shell';
  readonly command: string;
  readonly executable: '';
  readonly argv: readonly [];
  readonly input: undefined;
  readonly displayCommand: string;
}

interface DirectCommandDefinition {
  readonly mode: 'direct';
  readonly command: '';
  readonly executable: string;
  readonly argv: readonly string[];
  readonly input: string | undefined;
  readonly displayCommand: string;
}

type CommandDefinition = ShellCommandDefinition | DirectCommandDefinition;

interface ExecutionPolicy {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly label: string;
}

interface ExecutionRequest {
  readonly command: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly input: string | undefined;
  readonly displayCommand: string;
  readonly processExecutable: string;
  readonly processArgv: readonly string[];
  readonly executionLabel: string;
}

interface ResolvedCommandCwd {
  readonly absolutePath: string;
  readonly relativePath: string;
}

let cachedShell: CommandHost | null = null;

function resolveCommandCwd(workspace: WorkspacePath, value: unknown, operationName = 'relai_exec'): ResolvedCommandCwd {
  const raw = String(value == null || value === '' ? '.' : value).trim() || '.';
  if (path.isAbsolute(raw)) throw new Error(`${operationName} cwd must be relative to the configured workspace.`);
  const root = path.resolve(workspace.path);
  const candidate = path.resolve(root, raw);
  if (!isPathInside(candidate, root)) throw new Error(`${operationName} cwd escapes the workspace: ${raw}`);
  let real: string;
  try {
    real = fs.realpathSync.native(candidate);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`${operationName} cwd does not exist: ${raw}`, { cause: error });
    }
    throw error;
  }
  // The configured root can use a Windows 8.3 alias or junction while realpath
  // resolves the candidate to its canonical spelling. Compare real paths.
  const canonicalRoot = fs.realpathSync.native(root);
  if (!isPathInside(real, canonicalRoot)) throw new Error(`${operationName} cwd resolves outside the workspace: ${raw}`);
  if (!fs.statSync(real).isDirectory()) throw new Error(`${operationName} cwd is not a directory: ${raw}`);
  const relative = path.relative(canonicalRoot, real).replaceAll(path.sep, '/') || '.';
  return { absolutePath: real, relativePath: relative };
}

function normalizeCommandEnv(value: unknown, operationName = 'relai_exec'): Record<string, string> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${operationName} env must be an object of string values.`);
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key || key.includes('=') || key.includes('\0')) throw new Error(`${operationName} env contains an invalid key: ${key || '(empty)'}`);
    if (typeof item !== 'string') throw new Error(`${operationName} env value for ${key} must be a string.`);
    if (item.includes('\0')) throw new Error(`${operationName} env value for ${key} contains a null byte.`);
    env[key] = item;
  }
  return env;
}

function normalizeDirectArgv(value: unknown, operationName = 'relai_exec'): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${operationName} argv must be an array of strings.`);
  if (value.length > MAX_DIRECT_ARGV_ITEMS) throw new Error(`${operationName} argv supports at most 100 items.`);
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new Error(`${operationName} argv[${index}] must be a string.`);
    if (item.length > MAX_DIRECT_ARG_LENGTH) throw new Error(`${operationName} argv[${index}] must be 20000 characters or fewer.`);
    if (item.includes('\0')) throw new Error(`${operationName} argv[${index}] contains a null byte.`);
    return item;
  });
}

function normalizeDirectInput(value: unknown, operationName = 'relai_exec'): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string') throw new Error(`${operationName} input must be a string.`);
  if (value.length > MAX_DIRECT_INPUT_LENGTH) throw new Error(`${operationName} input must be 1048576 characters or fewer.`);
  return value;
}

function normalizeCommandDefinition(args: ExecutionInvocationInput = {}, operationName = 'relai_exec'): CommandDefinition {
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  const executable = typeof args.executable === 'string' ? args.executable.trim() : '';
  if (Boolean(command) === Boolean(executable)) {
    throw new Error(`${operationName} requires exactly one execution mode: command or executable.`);
  }
  if (command.length > 20000) throw new Error(`${operationName} command must be 20000 characters or fewer.`);
  if (executable.length > 1000) throw new Error(`${operationName} executable must be 1000 characters or fewer.`);
  if (executable.includes('\0')) throw new Error(`${operationName} executable contains a null byte.`);
  if (command && (args.argv !== undefined || args.input !== undefined)) {
    throw new Error(`${operationName} argv and input are available only with executable direct mode.`);
  }
  if (command) {
    return {
      mode: 'shell',
      command,
      executable: '',
      argv: [],
      input: undefined,
      displayCommand: command
    };
  }
  const argv = normalizeDirectArgv(args.argv, operationName);
  const input = normalizeDirectInput(args.input, operationName);
  return {
    mode: 'direct',
    command: '',
    executable,
    argv,
    input,
    displayCommand: directCommandDisplay(executable, argv)
  };
}

function resolveExecutionPolicy(definition: CommandDefinition): ExecutionPolicy {
  return definition.mode === 'shell'
    ? resolveShellProcess(definition.command)
    : resolveDirectProcess(definition.executable, definition.argv);
}

function createExecutionRequest(definition: CommandDefinition, policy: ExecutionPolicy): ExecutionRequest {
  return {
    command: definition.command,
    executable: definition.executable,
    argv: definition.argv,
    input: definition.input,
    displayCommand: definition.displayCommand,
    processExecutable: policy.executable,
    processArgv: policy.argv,
    executionLabel: policy.label
  };
}

function normalizeExecutionInvocation(args: ExecutionInvocationInput = {}, operationName = 'relai_exec'): ExecutionRequest {
  const definition = normalizeCommandDefinition(args, operationName);
  const policy = resolveExecutionPolicy(definition);
  return createExecutionRequest(definition, policy);
}

function resolveShellProcess(command: string): ExecutionPolicy {
  const shell = resolveShell();
  if (process.platform === 'win32' && shell.label === 'Windows PowerShell' && /&&|\|\|/.test(command)) {
    const executable = process.env.ComSpec || 'cmd.exe';
    return { executable, argv: ['/d', '/s', '/c', command], label: 'Command Prompt' };
  }
  return { executable: shell.executable, argv: shell.args(command), label: shell.label };
}

function locateWindowsExecutable(name: string): string {
  try {
    const result = childProcess.spawnSync(WHERE_EXE, [name], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) return '';
    return String(result.stdout || '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
  } catch {
    return '';
  }
}

function resolveDirectProcess(executable: string, argv: readonly string[]): ExecutionPolicy {
  if (process.platform !== 'win32') return { executable, argv: [...argv], label: 'Direct process' };
  const base = path.basename(String(executable || '')).toLowerCase().replace(/\.(?:cmd|exe)$/i, '');
  if (base !== 'npm' && base !== 'npx') return { executable, argv: [...argv], label: 'Direct process' };
  const cli = resolveNpmCli(base);
  if (!cli) return { executable, argv: [...argv], label: 'Direct process' };
  return {
    executable: process.execPath,
    argv: [cli, ...argv],
    label: `Direct ${base} CLI`
  };
}

function resolveNpmCli(command: 'npm' | 'npx'): string {
  const file = command === 'npx' ? 'npx-cli.js' : 'npm-cli.js';
  const candidates = [
    command === 'npm' ? (process.env.npm_execpath || '') : '',
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', file)
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || '';
}

function powershellCommand(command: string): string {
  return `$global:LASTEXITCODE = $null; $ErrorActionPreference = 'Stop'; try { & { ${command}\n} } catch { [Console]::Error.WriteLine($_); exit 1 }; if ($null -ne $global:LASTEXITCODE) { exit $global:LASTEXITCODE }`;
}

function resolveShell(): CommandHost {
  if (cachedShell) return cachedShell;
  if (process.platform === 'win32') {
    const pwsh = locateWindowsExecutable('pwsh.exe');
    if (pwsh) {
      cachedShell = {
        executable: pwsh,
        label: 'PowerShell 7',
        args: command => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', powershellCommand(command)]
      };
      return cachedShell;
    }
    const powershell = locateWindowsExecutable('powershell.exe');
    if (powershell) {
      cachedShell = {
        executable: powershell,
        label: 'Windows PowerShell',
        args: command => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', powershellCommand(command)]
      };
      return cachedShell;
    }
    cachedShell = {
      executable: process.env.ComSpec || 'cmd.exe',
      label: 'Command Prompt',
      args: command => ['/d', '/s', '/c', command]
    };
    return cachedShell;
  }
  const preferred = String(process.env.SHELL || '').trim();
  const executable = preferred && fs.existsSync(preferred) ? preferred : '/bin/sh';
  cachedShell = { executable, label: path.basename(executable), args: command => ['-lc', command] };
  return cachedShell;
}

export {
  normalizeCommandEnv,
  normalizeExecutionInvocation,
  resolveCommandCwd
};
