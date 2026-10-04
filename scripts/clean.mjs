import fs from 'node:fs';
import path from 'node:path';
import { assertSafeControllerOperation } from './active-controller-guard.mjs';

const root = path.resolve(import.meta.dirname, '..');
const mode = process.argv.includes('--release') ? 'release' : process.argv.includes('--electron') ? 'electron' : 'default';
const targets = mode === 'release'
  ? ['dist', '.rel-ai-temp']
  : mode === 'electron'
    ? ['dist/build-check', '.rel-ai-temp']
    : ['dist/build-check', '.rel-ai-temp'];

const absoluteTargets = targets.map(target => path.join(root, target));
assertSafeControllerOperation({ operation: 'clean', targetPaths: absoluteTargets });

for (const target of targets) {
  const absolute = path.join(root, target);
  try {
    fs.rmSync(absolute, {
      recursive: true,
      force: true,
      maxRetries: process.platform === 'win32' ? 10 : 2,
      retryDelay: 250
    });
  } catch (error) {
    if (target === '.rel-ai-temp') {
      console.warn('Skipped locked .rel-ai-temp files. They are ignored by Git and can be removed after the owning process exits.');
      continue;
    }
    throw new Error(`Could not remove ${target} after bounded filesystem-lock retries. Close any Explorer window or external scanner holding the build directory, then retry.`, { cause: error });
  }
  console.log(`Removed ${target}`);
}
