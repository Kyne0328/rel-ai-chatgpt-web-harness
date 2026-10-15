import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clearRealRootCache, realRootOf } from "../src/safety.js";
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-real-root-'));
const firstTarget = path.join(base, 'first');
const secondTarget = path.join(base, 'second');
const link = path.join(base, 'workspace');
fs.mkdirSync(firstTarget);
fs.mkdirSync(secondTarget);

try {
  clearRealRootCache();
  try {
    fs.symlinkSync(firstTarget, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN'].includes(error?.code)) {
      console.log('Real-root retarget test skipped because symlink creation is unavailable.');
      process.exit(0);
    }
    throw error;
  }

  const first = realRootOf(link);
  fs.rmSync(link, { force: true });
  fs.symlinkSync(secondTarget, link, process.platform === 'win32' ? 'junction' : 'dir');
  const second = realRootOf(link);

  assert.equal(first, fs.realpathSync(firstTarget));
  assert.equal(second, fs.realpathSync(secondTarget));
  assert.notEqual(second, first, 'a retargeted symlink or junction must not reuse the old cached repository root');
  for (const target of [firstTarget, secondTarget]) fs.mkdirSync(path.join(target, 'nested'));
  const nested = path.join(link, 'nested');
  assert.equal(realRootOf(nested), fs.realpathSync(path.join(secondTarget, 'nested')));
  fs.unlinkSync(link);
  fs.symlinkSync(firstTarget, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(realRootOf(nested), fs.realpathSync(path.join(firstTarget, 'nested')),
    'an ordinary directory beneath a retargeted parent link must resolve its current physical root');
  console.log('Retargeted workspace roots are resolved against the current filesystem target.');
} finally {
  clearRealRootCache();
  fs.rmSync(base, { recursive: true, force: true });
}
