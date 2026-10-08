import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTestProcess } from './helpers/run-test-process.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(testDir);
const testPattern = /^(?:repository-|intelligence-).+\.mjs$/;
const tests = fs.readdirSync(testDir)
  .filter(name => testPattern.test(name) || name === 'code-intelligence-unit.mjs')
  .sort((left, right) => left.localeCompare(right));

if (!tests.length) throw new Error('No Repository Intelligence tests were discovered.');

for (const test of tests) {
  console.log('Repository Intelligence gate: ' + test);
  const result = await runTestProcess(process.execPath, [path.join(testDir, test)], {
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

if (!process.exitCode) console.log(`Repository Intelligence suite passed (${tests.length} files).`);
