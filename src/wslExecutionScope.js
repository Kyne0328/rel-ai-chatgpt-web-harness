import path from 'node:path';

// The guest enters a delegated cgroup before publishing its identity and
// executing caller code. A detached/setsid descendant remains in that scope.
// Distros without delegation retain the durable native controller, but never
// advertise guest containment that they could not establish.
const WSL_SCOPE_LAUNCH = `nonce=$1; storage=$(wslpath -u "$2") || exit 125; shift 2
boot=$(cat /proc/sys/kernel/random/boot_id) || exit 125
parent=$(sed -n 's|^0::|/sys/fs/cgroup|p' /proc/self/cgroup)
case "$parent" in /sys/fs/cgroup/*|/sys/fs/cgroup) ;; *) parent= ;; esac
case "$parent" in *[!a-zA-Z0-9_./:@-]*|*/../*|*/..) parent= ;; esac
scope=$parent/relai-mutation-$nonce
if [ -n "$parent" ] && [ -w "$parent/cgroup.procs" ] && mkdir "$scope" 2>/dev/null; then
  if [ ! -f "$scope/cgroup.events" ] || [ ! -f "$scope/cgroup.kill" ]; then rmdir "$scope"; exec "$@"; fi
  printf '%s\\n' "$$" > "$scope/cgroup.procs" || exit 125
  umask 077
  printf '{"nonce":"%s","boot":"%s","directory":"%s"}\\n' "$nonce" "$boot" "$scope" > "$storage/guest-scope.tmp" || exit 125
  mv "$storage/guest-scope.tmp" "$storage/guest-scope.json" || exit 125
fi
exec "$@"`;

function prepareWslExecutionScope(executable, args, directory, nonce) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  if (process.platform !== 'win32' || path.resolve(executable).toLowerCase() !== path.join(systemRoot, 'System32', 'wsl.exe').toLowerCase()) return null;
  let distribution = '';
  let commandAt = -1;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (['--', '--exec', '-e'].includes(value)) { commandAt = index + 1; break; }
    if (['-d', '--distribution'].includes(value)) distribution = String(args[index + 1] || '');
    if (value.startsWith('--distribution=')) distribution = value.slice(15);
    if (['-d', '--distribution', '-u', '--user', '--cd'].includes(value)) index++;
    else if (!value.startsWith('--distribution=') && !value.startsWith('--user=')) return null;
  }
  if (!distribution || commandAt < 0 || !args[commandAt]) return null;
  return { args: [...args.slice(0, commandAt - 1), '--exec', '/bin/sh', '-c', WSL_SCOPE_LAUNCH, 'relai-owned-execution', nonce, directory, ...args.slice(commandAt)],
    identity: { distribution, nonce } };
}

export { prepareWslExecutionScope };
