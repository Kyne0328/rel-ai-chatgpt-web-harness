// Duplicate platform coverage intentionally keeps child tests in the everyday
// Linux suite. Do not list these child paths directly in CI workflow commands.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const commands = [
  ['test/resource-execution-routing-unit.mjs'],
  ['test/validation-admission-pressure-unit.mjs'],
  ['test/context-pressure-unit.mjs'],
  ['test/host-resource-scheduler-unit.mjs'],
  ['test/process-lifetime-unit.mjs'],
  ['test/process-root-memory-unit.mjs'],
  ['test/process-start-admission-diagnostics-unit.mjs'],
  ['test/git-mutation-accounting-unit.mjs'],
  ['scripts/benchmark-git-mutation-accounting.mjs', '--files', '500', '--repeats', '5', '--enforce']
];
for (const args of commands) {
  console.log('Resource platform gate: ' + args.join(' '));
  const result = spawnSync(process.execPath, args, {
    cwd: root, stdio: 'inherit', windowsHide: true, timeout: 180000
  });
  if (result.error || result.status !== 0) {
    if (result.error) console.error(result.error.message);
    process.exit(result.status || 1);
  }
}
