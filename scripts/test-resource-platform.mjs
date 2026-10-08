// Duplicate platform coverage intentionally keeps child tests in the everyday
// Linux suite. Do not list these child paths directly in CI workflow commands.
import { runTestProcess } from '../test/helpers/run-test-process.mjs';
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
  ['test/git-mutation-accounting-unit.mjs']
];
for (const args of commands) {
  console.log('Resource platform gate: ' + args.join(' '));
  const result = await runTestProcess(process.execPath, args, {
    cwd: root, timeoutMs: 180_000, maxOutputBytes: 1024 * 1024
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdoutTruncated) console.error('Test stdout exceeded the retained 1 MiB tail; earlier output was omitted.');
  if (result.stderrTruncated) console.error('Test stderr exceeded the retained 1 MiB tail; earlier output was omitted.');
  if (result.cleanupPending) console.error('Temporary test ownership artifacts remain; cleanup is pending.');
  if (result.error || result.exitCode !== 0 || result.terminationUncertain) {
    if (result.error) console.error(result.error.message || String(result.error));
    if (result.terminationUncertain) console.error('Process-tree cleanup is unconfirmed. No further tests will be launched.');
    process.exitCode = Number.isInteger(result.exitCode) && result.exitCode > 0 ? result.exitCode : 1;
    break;
  }
}
