function hasAgentCancellationHandle(args = {}, context = {}) {
  return Boolean(
    String(args.work_id || context.taskId || '').trim()
    || String(args._operationTaskId || context.nativeTaskId || '').trim()
  );
}

function resolveOneShotTimeoutMs(args = {}, context = {}, options = {}) {
  const minMs = positiveNumber(options.minMs, 1000);
  const maxMs = Math.max(minMs, positiveNumber(options.maxMs, 24 * 60 * 60 * 1000));
  const fallbackMs = Math.min(maxMs, Math.max(minMs, positiveNumber(options.fallbackMs, 120000)));
  const requested = Number(args.timeoutMs);
  if (Number.isFinite(requested) && requested > 0) {
    return Math.min(maxMs, Math.max(minMs, Math.floor(requested)));
  }
  return hasAgentCancellationHandle(args, context) ? 0 : fallbackMs;
}

function adbCommandParts(executable, argv = []) {
  const executableName = String(executable || '').replaceAll('\\', '/').split('/').pop().toLowerCase();
  if (executableName !== 'adb' && executableName !== 'adb.exe') return null;
  const tokens = Array.isArray(argv) ? argv.map(value => String(value || '')) : [];
  const optionsWithValue = new Set(['-s', '-t', '-h', '-p', '-l', '--one-device']);
  const standaloneOptions = new Set(['-d', '-e', '-a', '--exit-on-write-error']);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const lower = token.toLowerCase();
    if (optionsWithValue.has(lower)) {
      index += 1;
      continue;
    }
    if (standaloneOptions.has(lower) || /^(?:-h|-p|-l|--one-device)=/i.test(token)) continue;
    if (token.startsWith('-')) return null;
    return { command: lower, args: tokens.slice(index + 1) };
  }
  return { command: '', args: [] };
}

function isClearlyWorkspaceReadOnlyAdb(executable, argv = []) {
  const parsed = adbCommandParts(executable, argv);
  if (!parsed?.command) return false;
  return !new Set(['pull', 'bugreport', 'backup', 'keygen']).has(parsed.command);
}

function isPersistentAdbInvocation(executable, argv = []) {
  const parsed = adbCommandParts(executable, argv);
  if (!parsed?.command) return false;
  if (parsed.command === 'track-devices' || parsed.command === 'track-jdwp') return true;
  if (parsed.command === 'logcat') {
    return !parsed.args.some(value => ['-d', '--dump'].includes(String(value).toLowerCase()));
  }
  if (parsed.command === 'shell') {
    const shellArgs = parsed.args.filter(value => !['-t', '-tt', '-t', '-x', '-n'].includes(String(value).toLowerCase()));
    return shellArgs.length === 0;
  }
  return parsed.command === 'server' && String(parsed.args[0] || '').toLowerCase() === 'nodaemon';
}

function positiveNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export {
  hasAgentCancellationHandle,
  isClearlyWorkspaceReadOnlyAdb,
  isPersistentAdbInvocation,
  resolveOneShotTimeoutMs
};
