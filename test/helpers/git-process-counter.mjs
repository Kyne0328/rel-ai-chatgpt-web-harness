import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

// Isolated test/benchmark instrumentation. Production Git sanitizes GIT_TRACE,
// so count actual spawns rather than weakening its environment protections.
async function withGitProcessCounts(run) {
  const original = childProcess.spawn;
  const counts = { status: 0, head: 0, total: 0 };
  childProcess.spawn = function(command, args, ...rest) {
    if (/^git(?:\.exe)?$/i.test(path.basename(String(command)))) {
      counts.total += 1;
      if (Array.isArray(args) && args.includes('status')) counts.status += 1;
      if (Array.isArray(args) && args.includes('rev-parse') && args.includes('HEAD')) counts.head += 1;
    }
    return original.call(this, command, args, ...rest);
  };
  syncBuiltinESMExports();
  try { return { result: await run(), counts }; }
  finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
  }
}

export { withGitProcessCounts };
