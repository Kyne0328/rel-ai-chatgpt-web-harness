import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_VERSION, startMcpClient, structuredContentOf } from './helpers/mcp-client.mjs';
import { GIT_EXECUTABLE } from './helpers/git-executable.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-ai-mcp-workflow-'));
const workspace = path.join(temp, 'workspace');
const stateDir = path.join(temp, 'state');
function git(args, options = {}) {
  return execFileSync(GIT_EXECUTABLE, args, options);
}

fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'README.md'), '# Smoke\n');
fs.writeFileSync(path.join(workspace, 'src', 'index.js'), 'console.log("smoke")\n');
fs.writeFileSync(path.join(workspace, 'src', 'helper.js'), 'function smokeValue() { return 1; }\nmodule.exports = { smokeValue };\n');
fs.writeFileSync(path.join(workspace, 'exec-smoke.js'), "process.stdout.write('exec-smoke-ok');\n");
fs.writeFileSync(path.join(workspace, 'create-artifact.js'), "require('node:fs').writeFileSync('session-artifact.txt', 'temporary\\n');\n");
fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({
  scripts: { check: 'node --check src/index.js' }
}, null, 2));

git(['init'], { cwd: workspace, stdio: 'ignore' });
git(['config', 'user.email', 'relai@example.test'], { cwd: workspace });
git(['config', 'user.name', 'RelAI Smoke'], { cwd: workspace });
git(['add', '.'], { cwd: workspace });
git(['commit', '-m', 'init'], { cwd: workspace, stdio: 'ignore' });

const configPath = path.join(temp, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  version: 2,
  stateDir,
  workspaces: {
    smoke: {
      path: workspace,
      testCommands: { check: 'npm run check' },
      commands: {}
    }
  }
}, null, 2));

const client = startMcpClient({ root, configPath, timeoutMs: 15000 });
let taskId = '';
function taskCall(id, name, args) {
  client.call(id, name, {
    ...args,
    ...(taskId && !(name === 'relai_work' && args.action === 'begin') ? { work_id: taskId } : {})
  });
}

let followupId = 1000;
async function completedTaskCall(id, name, args) {
  taskCall(id, name, args);
  const initial = structuredContentOf(await client.waitFor(id));
  if (initial.status !== 'running') return initial;

  for (let attempt = 0; attempt < 300; attempt += 1) {
    const statusId = followupId++;
    taskCall(statusId, 'relai_work', { action: 'status', workspace: 'smoke', operationId: initial.operationId });
    const status = structuredContentOf(await client.waitFor(statusId));
    const operation = status.backgroundOperation;
    if (operation?.status && operation.status !== 'running') {
      const replayId = followupId++;
      taskCall(replayId, name, args);
      return structuredContentOf(await client.waitFor(replayId));
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${name} fallback operation did not complete.`);
}

function repositoryGraphFiles() {
  const directory = path.join(stateDir, 'repository-intelligence');
  if (!fs.existsSync(directory)) return [];
  const found = [];
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile() && entry.name === 'graph.db') found.push(target);
    }
  }
  return found;
}

try {
  client.initialize(1);
  const discovery = await client.waitFor(1);
  if (!discovery.result?.supportedVersions?.includes(MCP_VERSION)) throw new Error('MCP discovery failed.');

  taskCall(2, 'relai_work', { action: 'begin', workspace: 'smoke' });
  const startedTask = structuredContentOf(await client.waitFor(2));
  taskId = startedTask.work_id;
  if (!taskId || startedTask.identity !== 'work_session') throw new Error('Work-session bootstrap failed.');
  if (repositoryGraphFiles().length) throw new Error('Work-session bootstrap must not build Repository Intelligence on a cold workspace.');

  taskCall(3, 'relai_snapshot', { workspace: 'smoke', maxEntries: 100 });
  const snapshot = structuredContentOf(await client.waitFor(3));
  if (!snapshot.files.includes('README.md')) throw new Error('Snapshot missing README.md.');
  for (const mode of ['exact-replace', 'direct-write', 'apply-update', 'workspace-tidy']) {
    if (!snapshot.writeGuidance?.modes?.[mode]) throw new Error(`Snapshot guidance missing ${mode}.`);
  }
  if (snapshot.writeGuidance?.modes?.['staged-write']) throw new Error('Internal staged-write fallback must not be advertised in normal guidance.');
  if (snapshot.writeGuidance?.modes?.['apply-bundle']) throw new Error('Obsolete bundle guidance remains.');

  taskCall(4, 'relai_read', { workspace: 'smoke', paths: ['README.md', 'src/index.js'] });
  const read = structuredContentOf(await client.waitFor(4));
  if (!read.items[0].content.includes('# Smoke')) throw new Error('Read failed.');

  const codeInspect = await completedTaskCall(30, 'relai_inspect', { workspace: 'smoke', action: 'symbol', symbol: 'smokeValue' });
  if (!codeInspect.ok || codeInspect.index?.freshness !== 'current' || !codeInspect.definitions?.some(item => item.path === 'src/helper.js')) {
    throw new Error(`Code intelligence dispatch failed: ${JSON.stringify(codeInspect)}`);
  }

  taskCall(17, 'relai_exec', { workspace: 'smoke', command: 'node exec-smoke.js', timeoutMs: 5000 });
  const executed = structuredContentOf(await client.waitFor(17));
  if (!executed.ok || executed.exitCode !== 0 || executed.stdout !== 'exec-smoke-ok') throw new Error('One-shot command failed.');
  if (executed.changedFiles.length) throw new Error('Read-only command reported workspace mutations.');

  taskCall(5, 'relai_edit', {
    workspace: 'smoke',
    path: 'README.md',
    oldText: '# Smoke\n',
    newText: '# Smoke\n\nEdited through relai_edit.\n'
  });
  const exactEdit = structuredContentOf(await client.waitFor(5));
  if (!exactEdit.changedFiles.includes('README.md')) throw new Error('Exact edit failed.');

  taskCall(6, 'relai_edit', {
    workspace: 'smoke',
    path: 'README.md',
    content: '# Smoke\n\nWritten through relai_edit content mode.\n',
    dryRun: true
  });
  const dryWrite = structuredContentOf(await client.waitFor(6));
  if (!dryWrite.dryRun || dryWrite.changedFiles.length !== 0 || dryWrite.result?.path !== 'README.md' || dryWrite.result?.changed !== true) throw new Error('Dry content edit failed.');

  taskCall(7, 'relai_edit', {
    workspace: 'smoke',
    path: 'README.md',
    replacements: [{ oldText: 'Edited through relai_edit.', newText: 'Updated by exact replacement.' }]
  });
  const replaced = structuredContentOf(await client.waitFor(7));
  if (!replaced.changedFiles.includes('README.md')) throw new Error('Replacement failed.');

  const patch = `*** Begin Patch
*** Update File: src/index.js
@@
-console.log("smoke")
+console.log("smoke updated")
*** End Patch
`;
  taskCall(8, 'relai_edit', { workspace: 'smoke', updateText: patch, returnDiff: true });
  const patched = structuredContentOf(await client.waitFor(8));
  if (!patched.changedFiles.includes('src/index.js')) throw new Error('Patch edit failed.');

  fs.writeFileSync(path.join(workspace, 'obsolete.md'), 'remove me\n');
  git(['add', 'obsolete.md'], { cwd: workspace });
  git(['commit', '-m', 'add obsolete'], { cwd: workspace, stdio: 'ignore' });
  const deletePatch = `*** Begin Patch
*** Delete File: obsolete.md
*** End Patch
`;
  taskCall(9, 'relai_edit', { workspace: 'smoke', updateText: deletePatch });
  const deleted = structuredContentOf(await client.waitFor(9));
  if (!deleted.changedFiles.includes('obsolete.md') || fs.existsSync(path.join(workspace, 'obsolete.md'))) {
    throw new Error('Structured delete failed.');
  }

  taskCall(18, 'relai_exec', { workspace: 'smoke', command: 'node create-artifact.js', timeoutMs: 5000 });
  const artifactExec = structuredContentOf(await client.waitFor(18));
  if (!artifactExec.changedFiles?.includes('session-artifact.txt')) throw new Error('Task-owned exec did not attribute its untracked artifact.');
  taskCall(10, 'relai_work', { action: 'status', workspace: 'smoke', detail: 'full' });
  const status = structuredContentOf(await client.waitFor(10));
  if (!status.workspace?.repository?.sessionChangedFiles?.includes('session-artifact.txt')) throw new Error('Session ownership missing task-owned untracked artifact.');

  taskCall(11, 'relai_changes', { action: 'tidy_plan', workspace: 'smoke' });
  const plan = structuredContentOf(await client.waitFor(11));
  if (!plan.candidates.some(item => item.path === 'session-artifact.txt')) throw new Error('Tidy plan missed session artifact.');
  taskCall(12, 'relai_changes', { action: 'tidy_run', workspace: 'smoke', planId: plan.planId });
  const tidied = structuredContentOf(await client.waitFor(12));
  if (!tidied.changedFiles.includes('session-artifact.txt')) throw new Error('Tidy run failed.');

  const checks = await completedTaskCall(13, 'relai_validate', {
    action: 'checks',
    workspace: 'smoke',
    level: 'standard',
    complete: false
  });
  if (!checks.ok || !checks.checks.includes('npm run check')) throw new Error('Validation failed.');

  taskCall(14, 'relai_changes', { action: 'diff', workspace: 'smoke' });
  const diff = structuredContentOf(await client.waitFor(14));
  if (!diff.diff.includes('Updated by exact replacement')) throw new Error('Diff missing README change.');
  if (!diff.diff.includes('smoke updated')) throw new Error('Diff missing source change.');

  taskCall(15, 'relai_changes', { action: 'restore', workspace: 'smoke', paths: ['README.md', 'src/index.js', 'obsolete.md'] });
  const restored = structuredContentOf(await client.waitFor(15));
  if (!restored.ok) throw new Error('Restore failed.');

  taskCall(16, 'relai_changes', { action: 'diff', workspace: 'smoke' });
  const clean = structuredContentOf(await client.waitFor(16));
  if (clean.diff.trim()) throw new Error('Workspace diff should be clean after restore.');

  const completed = await completedTaskCall(31, 'relai_validate', {
    action: 'checks',
    workspace: 'smoke',
    level: 'standard',
    complete: true,
    summary: 'Completed and validated the public workflow smoke task.'
  });
  if (!completed.ok || completed.completionKnown !== true || completed.completionSource !== 'relai_validate:checks') {
    throw new Error(`Atomic workflow completion failed: ${JSON.stringify(completed)}`);
  }
  if (completed.summary !== 'Completed and validated the public workflow smoke task.') throw new Error('Atomic workflow completion lost its summary.');

  taskId = '';
  taskCall(32, 'relai_work', { action: 'begin', workspace: 'smoke', bootstrap: 'full' });
  const graphTask = structuredContentOf(await client.waitFor(32));
  taskId = graphTask.work_id;
  const graphBootstrapped = await completedTaskCall(33, 'relai_work', { action: 'context', workspace: 'smoke', bootstrap: 'full' });
  if (!graphBootstrapped.bootstrap?.repositoryIntelligence?.available) throw new Error('Warm Repository Intelligence context was not included in work bootstrap.');
  if (!graphBootstrapped.bootstrap.repositoryIntelligence.recommendedReadOrder?.length) throw new Error('Graph bootstrap did not include a targeted read order.');
  taskCall(34, 'relai_work', { action: 'cancel', workspace: 'smoke', reason: 'Bootstrap regression verified.' });
  const cancelled = structuredContentOf(await client.waitFor(34));
  if (!cancelled.ok) throw new Error('Second smoke work session did not cancel cleanly.');

  console.log('Public tool workflow smoke test passed.');
} finally {
  await client.closeGracefully();
  fs.rmSync(temp, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 20 : 5,
    retryDelay: 100
  });
}
