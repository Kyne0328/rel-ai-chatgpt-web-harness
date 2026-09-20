import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { flushAuditWrites } from '../src/audit.js';
import { callTool as rawCallTool } from '../src/tools.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';
import { resetToolActivity } from '../src/toolActivity.js';

const callTool = (name, args, context = {}) => rawCallTool(name, args, { principal: 'local:trusted', ...context });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-atomic-validation-race-'));
const workspacePath = path.join(root, 'workspace');
const stateDir = path.join(root, 'state');
const configPath = path.join(root, 'config.json');
const previousConfig = process.env.REL_AI_MCP_CONFIG;
const validationStartedPath = path.join(root, 'validation-started');
const validationReleasePath = path.join(root, 'validation-release');

fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
fs.writeFileSync(path.join(workspacePath, 'src', 'index.js'), 'export const ready = true;\n');
fs.writeFileSync(path.join(workspacePath, 'package.json'), JSON.stringify({
  type: 'module',
  scripts: { check: 'node --check src/index.js' }
}, null, 2));
fs.writeFileSync(path.join(workspacePath, 'validation-gate.mjs'), `
import fs from 'node:fs';
const started = ${JSON.stringify(validationStartedPath)};
const release = ${JSON.stringify(validationReleasePath)};
fs.writeFileSync(started, 'ready\\n');
const finish = () => {
  if (!fs.existsSync(release)) return false;
  clearTimeout(timeout);
  clearInterval(poll);
  process.exit(0);
};
const poll = setInterval(finish, 50);
const timeout = setTimeout(() => {
  clearInterval(poll);
  console.error('validation gate timed out');
  process.exit(2);
}, 10_000);
finish();
`);
execFileSync('git', ['init'], { cwd: workspacePath, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'relai@example.test'], { cwd: workspacePath });
execFileSync('git', ['config', 'user.name', 'RelAI Test'], { cwd: workspacePath });
execFileSync('git', ['add', '.'], { cwd: workspacePath });
execFileSync('git', ['commit', '-m', 'fixture'], { cwd: workspacePath, stdio: 'ignore' });
fs.writeFileSync(configPath, JSON.stringify({
  version: 2,
  stateDir,
  auditLogPath: path.join(stateDir, 'audit.jsonl'),
  workspaces: {
    app: {
      path: workspacePath,
      commands: {},
      testCommands: { check: 'npm run check' }
    }
  }
}, null, 2));
process.env.REL_AI_MCP_CONFIG = configPath;

const context = { publicHttpOnly: true };

async function startTask(title) {
  const result = await callTool('relai_work', {
    action: 'begin',
    workspace: 'app',
    bootstrap: 'none',
    title
  }, context);
  assert.ok(result.work_id);
  return result.work_id;
}

function waitForFile(file, timeoutMs = 10_000) {
  if (fs.existsSync(file)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const expected = path.basename(file);
    const poll = setInterval(() => {
      if (!fs.existsSync(file)) return;
      cleanup();
      resolve();
    }, 25);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${expected}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(poll);
    };
    if (fs.existsSync(file)) {
      cleanup();
      resolve();
    }
  });
}

function removeTempRootAfterHandlesClose() {
  const options = { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 20 : 5, retryDelay: 100 };
  try {
    fs.rmSync(root, options);
    return;
  } catch (error) {
    if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
  }

  const cleanupScript = `
    const fs = require('node:fs');
    const target = process.argv[1];
    let attempts = 0;
    const remove = () => {
      try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        process.exit(0);
      } catch {
        attempts += 1;
        if (attempts >= 50) process.exit(0);
        setTimeout(remove, 100);
      }
    };
    setTimeout(remove, 100);
  `;
  const cleanup = spawn(process.execPath, ['-e', cleanupScript, root], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  cleanup.unref();
}

try {
  resetToolActivity();
  const primaryTask = await startTask('Atomic validation primary writer');
  const validatingTask = await startTask('Atomic validation secondary writer');

  await callTool('relai_edit', {
    workspace: 'app',
    work_id: validatingTask,
    path: 'src/atomic-race.js',
    content: 'export const atomicValue = 1;\n'
  }, context);

  const validationStarted = waitForFile(validationStartedPath);
  const completionPromise = callTool('relai_validate', {
    action: 'checks',
    workspace: 'app',
    work_id: validatingTask,
    checks: ['node validation-gate.mjs'],
    complete: true,
    summary: 'Atomic completion synchronized and revalidated relevant concurrent changes internally.'
  }, context);

  await validationStarted;
  let concurrentEditCompleted = false;
  const concurrentEdit = callTool('relai_edit', {
    workspace: 'app',
    work_id: primaryTask,
    path: 'src/atomic-race.js',
    oldText: 'export const atomicValue = 1;',
    newText: 'export const atomicValue = 1;\nexport const concurrentValue = 2;'
  }, context).then(result => {
    concurrentEditCompleted = true;
    return result;
  });
  const firstConcurrentResult = await Promise.race([
    concurrentEdit.then(() => 'edit'),
    completionPromise.then(() => 'validation', () => 'validation')
  ]);
  assert.equal(firstConcurrentResult, 'edit', 'a workspace mutation must settle before the deliberately blocked validation command');
  await concurrentEdit;
  assert.equal(concurrentEditCompleted, true, 'a workspace mutation must not wait for the entire validation command');
  fs.writeFileSync(validationReleasePath, 'release\\n');

  const completion = await completionPromise;
  assert.equal(completion.ok, true, 'atomic validation must complete against one stable visible workspace state');
  assert.equal(completion.completionKnown, true);
  assert.equal(completion.work_id, validatingTask);
  assert.equal(completion.completionSource, 'relai_validate:checks');
  assert.equal(concurrentEditCompleted, true, 'the overlapping edit completed before validation was released');

  fs.rmSync(validationStartedPath, { force: true });
  fs.rmSync(validationReleasePath, { force: true });
  const scopedTask = await startTask('Atomic validation ignores unrelated writers');
  await callTool('relai_edit', {
    workspace: 'app',
    work_id: scopedTask,
    path: 'src/scoped-validation.js',
    content: 'export const scoped = true;\n'
  }, context);

  const scopedValidationStarted = waitForFile(validationStartedPath);
  const scopedCompletionPromise = callTool('relai_validate', {
    action: 'checks',
    workspace: 'app',
    work_id: scopedTask,
    checks: ['node validation-gate.mjs'],
    complete: true,
    summary: 'Unrelated concurrent changes do not invalidate task-scoped validation.'
  }, context);

  await scopedValidationStarted;
  let unrelatedEditCompleted = false;
  const unrelatedEdit = callTool('relai_edit', {
    workspace: 'app',
    work_id: primaryTask,
    path: 'src/unrelated-validation.js',
    content: 'export const unrelated = true;\n'
  }, context).then(result => {
    unrelatedEditCompleted = true;
    return result;
  });
  const firstUnrelatedResult = await Promise.race([
    unrelatedEdit.then(() => 'edit'),
    scopedCompletionPromise.then(() => 'validation', () => 'validation')
  ]);
  assert.equal(firstUnrelatedResult, 'edit', 'an unrelated workspace mutation must settle before the deliberately blocked validation command');
  await unrelatedEdit;
  assert.equal(unrelatedEditCompleted, true, 'unrelated workspace mutations must remain usable while another task validates');
  fs.writeFileSync(validationReleasePath, 'release\\n');

  const scopedCompletion = await scopedCompletionPromise;
  assert.equal(scopedCompletion.ok, true, 'task-scoped validation must remain current despite an unrelated concurrent mutation');
  assert.equal(scopedCompletion.completionKnown, true);
  assert.equal(scopedCompletion.work_id, scopedTask);
  assert.equal(unrelatedEditCompleted, true);

  await callTool('relai_work', {
    action: 'cancel',
    workspace: 'app',
    work_id: primaryTask,
    reason: 'Atomic race regression complete.'
  }, context);
} finally {
  await flushAuditWrites();
  await repositoryIntelligence.shutdown();
  resetToolActivity();
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  removeTempRootAfterHandlesClose();
}

console.log('Atomic validation resolves relevant races internally and ignores unrelated concurrent task changes.');
// Nested raw tool calls can leave Windows piped stdio referenced after app resources close.
// Teardown above is complete, so exit explicitly to keep this isolated integration test deterministic.
process.exit(0);
