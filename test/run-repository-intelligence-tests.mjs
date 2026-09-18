import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(testDir);
const testPattern = /^(?:repository-|intelligence-).+\.mjs$/;
const tests = fs.readdirSync(testDir)
  .filter(name => testPattern.test(name) || name === 'code-intelligence-unit.mjs')
  .sort((left, right) => left.localeCompare(right));

if (!tests.length) throw new Error('No Repository Intelligence tests were discovered.');

for (const test of tests) {
  const result = spawnSync(process.execPath, [path.join(testDir, test)], {
    cwd: root,
    stdio: 'inherit',
    timeout: 180_000
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Repository Intelligence suite passed (${tests.length} files).`);
