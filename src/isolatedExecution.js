// A Linux-container snapshot is the only lock-free command path. A copied cwd
// alone is not confinement: the container can mount only its owned volume.
import crypto from 'node:crypto';
import path from 'node:path';
import { runProcess } from './process.js';

const IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,199}$/;
const DEFAULT_SETUP_TIMEOUT_MS = 10 * 60_000;

function isolationError(code, message) {
  return Object.assign(new Error(message), { code, retryable: false });
}

function assertImage(image) {
  if (typeof image !== 'string' || !IMAGE.test(image) || image.includes('..')) {
    throw isolationError('ISOLATION_INVALID_IMAGE', 'containerImage must name an installed Linux container image.');
  }
}

export function isolatedDockerArguments(volume, image, args = {}, cwd = '') {
  assertImage(image);
  if (!/^relai-isolated-[a-f0-9]{32}$/.test(volume)) throw isolationError('ISOLATION_INVALID_VOLUME', 'Invalid owned volume.');
  if (args.input != null || (args.env && Object.keys(args.env).length)) {
    throw isolationError('ISOLATION_UNSUPPORTED_INPUT', 'Isolated container commands currently require no stdin or custom environment. Use a project configuration file instead.');
  }
  if (cwd.includes('\\') || path.posix.isAbsolute(cwd)
    || cwd.split('/').some(part => part === '..' || part === '.' || part === '')
    || cwd.includes(':')) {
    throw isolationError('ISOLATION_INVALID_CWD', 'The isolated working directory must be inside the workspace.');
  }
  const invocation = args.command
    ? ['/bin/sh', '-c', String(args.command)]
    : [String(args.executable || ''), ...(Array.isArray(args.argv) ? args.argv.map(String) : [])];
  if (!invocation[0]) throw isolationError('ISOLATION_INVALID_COMMAND', 'An isolated command or executable is required.');
  return ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,nodev',
    '--mount', `type=volume,source=${volume},target=/workspace`,
    '--workdir', cwd ? `/workspace/${cwd}` : '/workspace',
    '--entrypoint', invocation.shift(), image, ...invocation];
}

function sourceMount(absolute) {
  if (/[\r\n,]/.test(absolute)) throw isolationError('ISOLATION_INVALID_PATH', 'The workspace path cannot be mounted safely by the container runtime.');
  return `type=bind,source=${absolute},target=/relai-source,readonly`;
}

async function docker(args, workspace, config, options = {}) {
  const result = await runProcess('docker', args, {
    cwd: workspace.path, timeout: options.timeoutMs || DEFAULT_SETUP_TIMEOUT_MS,
    signal: options.signal, maxOutputBytes: options.maxOutputBytes || 1024 * 128,
    resourceClass: options.onOutput ? 'heavy' : undefined,
    resourceOwner: workspace.alias,
    ...(options.onPhase ? { onPhase: options.onPhase } : {}),
    ...(options.onOutput ? { onOutput: options.onOutput } : {})
  }, config);
  if (result.spawnError || result.executed !== true) {
    throw isolationError('ISOLATION_RUNTIME_UNAVAILABLE', 'A working Docker engine is required for isolated container execution. The main workspace was not changed.');
  }
  return result;
}

function requireSuccess(result, step) {
  if (result.exitCode !== 0 || result.terminationConfirmed !== true) {
    throw isolationError('ISOLATION_SETUP_FAILED', `Isolated execution ${step} did not finish successfully: ${String(result.stderr || result.error || 'unknown error').slice(0, 450)}`);
  }
}

export async function prepareIsolatedCommand(workspace, config, args, options = {}) {
  const image = String(args.containerImage || '');
  assertImage(image);
  if (args.input != null || (args.env && Object.keys(args.env).length)) {
    throw isolationError('ISOLATION_UNSUPPORTED_INPUT', 'Isolated container execution does not accept custom stdin or environment.');
  }
  const volume = `relai-isolated-${crypto.randomBytes(16).toString('hex')}`;
  // Require an already installed image. Do not silently download gigabytes.
  requireSuccess(await docker(['image', 'inspect', image], workspace, config, options), 'image inspection');
  requireSuccess(await docker(['volume', 'create', volume], workspace, config, options), 'volume creation');
  const prepared = { volume, image, started: false, safeToCleanup: false };
  try {
    // Snapshot all visible source, including dirty and untracked files, while
    // holding the repository mutation lease. The source mount is read-only.
    const result = await docker(['run', '--rm', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--tmpfs', '/tmp:rw,nosuid,nodev',
      '--mount', sourceMount(path.resolve(workspace.path)),
      '--mount', `type=volume,source=${volume},target=/workspace`,
      '--entrypoint', '/bin/sh', image, '-c', 'cp -a /relai-source/. /workspace/'],
    workspace, config, options);
    requireSuccess(result, 'source snapshot');
    return prepared;
  } catch (error) {
    // Only a confirmed terminated setup can release the volume. Docker itself
    // refuses deletion while it is still in use.
    await releaseIsolatedCommand(workspace, config, prepared).catch(() => {});
    throw error;
  }
}

export async function runIsolatedCommand(workspace, config, args, prepared, options = {}) {
  const cwd = String(options.cwd || '').replaceAll('\\', '/').replace(/^\.\/?/, '');
  const argv = isolatedDockerArguments(prepared.volume, prepared.image, args, cwd);
  prepared.started = true;
  const result = await docker(argv, workspace, config, options);
  prepared.safeToCleanup = result.terminationConfirmed === true;
  return result;
}

export async function releaseIsolatedCommand(workspace, config, prepared) {
  if (!prepared?.volume) return false;
  // Never remove a volume attached to a process with unverified termination.
  if (prepared.started && !prepared.safeToCleanup) return false;
  const result = await docker(['volume', 'rm', prepared.volume], workspace, config, { timeoutMs: 15_000 });
  return result.exitCode === 0 && result.terminationConfirmed === true;
}
