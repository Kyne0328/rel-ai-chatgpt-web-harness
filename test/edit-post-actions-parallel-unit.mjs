import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { planEdit } from '../src/executionPlanner.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';

function git(root, args, options = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', ...options });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function createRepo(scripts, extraFiles = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-edit-post-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'edit-post-fixture', private: true, scripts }, null, 2));
  fs.writeFileSync(path.join(root, 'app.js'), 'export const value = 1;\n');
  for (const [relative, content] of Object.entries(extraFiles)) fs.writeFileSync(path.join(root, relative), content);
  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'RelAI Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'fixture']);
  return root;
}

const safeRoot = createRepo({
  lint: 'node -e "setTimeout(() => process.exit(0), 120)"',
  typecheck: 'node -e "setTimeout(() => process.exit(0), 120)"'
});
const safeState = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-edit-post-state-'));
try {
  const result = await planEdit(
    { alias: 'safe', path: safeRoot, commands: {}, testCommands: {} },
    { stateDir: safeState },
    { path: 'app.js', oldText: 'value = 1', newText: 'value = 2', runChecks: true, returnDiff: true }
  );
  assert.equal(result.ok, true);
  assert.equal(result.checks.ok, true);
  assert.ok(result.checks.execution.maxConcurrentSteps >= 1, 'validation should report its actual internal concurrency');
  assert.equal(result.execution.mode, 'serial', 'diff capture must wait for validation even when checks are side-effect-free by policy');
  assert.equal(result.execution.maxConcurrentSteps, 1);
  assert.match(String(result.diff.diff || ''), /value = 2/);
} finally {
  await repositoryIntelligence.shutdown();
  fs.rmSync(safeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  fs.rmSync(safeState, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

const mutatingRoot = createRepo({
  lint: 'node -e "setTimeout(() => require(\'fs\').appendFileSync(\'generated.txt\', \'after-validation\\n\'), 80)"'
}, { 'generated.txt': 'baseline\n' });
const mutatingState = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-edit-post-state-'));
try {
  const result = await planEdit(
    { alias: 'mutating', path: mutatingRoot, commands: {}, testCommands: {} },
    { stateDir: mutatingState },
    { path: 'app.js', oldText: 'value = 1', newText: 'value = 2', runChecks: true, returnDiff: true }
  );
  assert.equal(result.ok, true);
  assert.equal(result.execution.mode, 'serial');
  assert.match(String(result.diff.diff || ''), /generated\.txt/,
    'returned diff must include files created or changed by validation');
  assert.match(String(result.diff.diff || ''), /after-validation/);
  const actual = git(mutatingRoot, ['diff', '--', 'app.js', 'generated.txt']);
  assert.equal(String(result.diff.diff || '').trim(), actual.trim(), 'returned diff must equal the final workspace diff after validation');
} finally {
  await repositoryIntelligence.shutdown();
  fs.rmSync(mutatingRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  fs.rmSync(mutatingState, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

const cancelledRoot = createRepo({
  lint: 'node -e "setInterval(() => {}, 1000)"'
});
const cancelledState = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-edit-post-state-'));
try {
  const controller = new AbortController();
  const cancelTimer = setTimeout(() => controller.abort(new Error('cancel edit post-check')), 100);
  const result = await planEdit(
    { alias: 'cancelled', path: cancelledRoot, commands: {}, testCommands: {} },
    { stateDir: cancelledState },
    { path: 'app.js', oldText: 'value = 1', newText: 'value = 2', runChecks: true },
    { signal: controller.signal }
  );
  clearTimeout(cancelTimer);
  assert.equal(result.ok, false, 'cancelled post-edit validation must make the edit result non-successful');
  assert.equal(result.checks.validationStatus, 'cancelled', 'edit post-actions must forward the mutation cancellation signal into validation');
  assert.equal(result.checks.cancelled, true);
  assert.equal(result.checks.executedUnits, 0, 'a cancelled in-flight post-check must not be counted as completed work');
} finally {
  await repositoryIntelligence.shutdown();
  fs.rmSync(cancelledRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  fs.rmSync(cancelledState, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

console.log('Edit post-actions preserve validation/diff ordering and propagate cancellation into subprocess-backed checks.');
