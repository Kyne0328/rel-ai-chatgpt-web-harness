import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { relaiSearch } from '../src/bridge/search.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-search-filesystem-fallback-'));
const workspace = { alias: 'non-git', path: root, context: {}, commands: {}, testCommands: {} };
const config = { stateDir: path.join(root, '.state') };

try {
  fs.writeFileSync(path.join(root, 'a-large.txt'), Buffer.alloc((8 * 1024 * 1024) + 1, 120));
  fs.writeFileSync(path.join(root, 'b-small.txt'), 'first line\nneedle is here\nlast line\n');

  let serviceTimerFired = false;
  const serviceTimer = setTimeout(() => { serviceTimerFired = true; }, 0);
  const resultPromise = relaiSearch(workspace, config, {
    pattern: 'needle',
    fixed: true,
    mode: 'compact',
    maxResults: 10
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(serviceTimerFired, true, 'filesystem collection must yield to the service event loop');
  clearTimeout(serviceTimer);
  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.equal(result.matches.some(match => match.path === 'b-small.txt' && match.line === 2), true,
    'non-git fallback must still search normal text files');
  assert.equal(result.matches.some(match => match.path === 'a-large.txt'), false,
    'non-git fallback must not load oversized text files into memory');
  assert.equal(result.truncated, true,
    'skipping an oversized file must be reported as incomplete search coverage');

  const controller = new AbortController();
  controller.abort(new Error('cancel fallback search'));
  await assert.rejects(
    relaiSearch(workspace, config, { pattern: 'needle', fixed: true, mode: 'compact' }, { signal: controller.signal }),
    error => error?.name === 'AbortError'
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Non-git filesystem search stays bounded, reports skipped coverage, and honors cancellation.');
