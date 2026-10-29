import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { callTool as rawCallTool } from '../src/tools.js';
import { flushLocalAnalytics } from '../src/localAnalytics.ts';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';
import { flushTaskHistoryPersistence } from '../src/taskHistoryStore.ts';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-finish-queue-'));
const workspace = path.join(temp, 'workspace');
const stateDir = path.join(temp, 'state');
const configPath = path.join(temp, 'config.json');
const previousConfig = process.env.REL_AI_MCP_CONFIG;

fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'README.md'), '# fixture\n');
execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
execFileSync('git', ['config', 'user.name', 'RelAI Test'], { cwd: workspace });
execFileSync('git', ['add', '.'], { cwd: workspace });
execFileSync('git', ['commit', '-m', 'fixture'], { cwd: workspace, stdio: 'ignore' });
fs.writeFileSync(configPath, JSON.stringify({
  version: 2,
  stateDir,
  workspaces: { app: { path: workspace, commands: {}, testCommands: {} } }
}, null, 2));
process.env.REL_AI_MCP_CONFIG = configPath;

let requestCounter = 0;
const callTool = (name, args) => rawCallTool(name, args, {
  principal: 'local:trusted',
  publicHttpOnly: true,
  requestId: `finish-queue-${++requestCounter}`
});

try {
  const blocker = await callTool('relai_work', { mode: 'normal', action: 'begin', workspace: 'app', bootstrap: 'none' });
  const finisher = await callTool('relai_work', { mode: 'normal', action: 'begin', workspace: 'app', bootstrap: 'none' });

  const startedPath = path.join(temp, 'mutation-started');
  const releasePath = path.join(temp, 'mutation-release');
  const activeMutation = callTool('relai_exec', {
    workspace: 'app',
    work_id: blocker.work_id,
    executable: process.execPath,
    argv: ['-e', [
      "const fs=require('node:fs');",
      "fs.writeFileSync(process.argv[1],'started');",
      "const timer=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(timer);process.exit(0)}},10);"
    ].join(''), startedPath, releasePath]
  });
  // A file handshake proves that the other command still owns the mutation
  // lane. No arbitrary sleep is needed to guess whether it has started.
  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { clearInterval(poll); reject(new Error('Mutation fixture never started.')); }, 8000);
      const poll = setInterval(() => {
        if (!fs.existsSync(startedPath)) return;
        clearInterval(poll);
        clearTimeout(deadline);
        resolve();
      }, 10);
    });

    const completed = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Unrelated task finish waited for the active mutation.')), 8000);
      callTool('relai_work', {
        action: 'finish',
        workspace: 'app',
        work_id: finisher.work_id,
        summary: 'Independent completion does not wait for a running command in another task.'
      }).then(value => { clearTimeout(deadline); resolve(value); }, error => { clearTimeout(deadline); reject(error); });
    });
    assert.equal(completed.completionKnown, true);
    assert.equal(completed.ok, true);
    assert.equal(fs.existsSync(releasePath), false, 'Task A must still be running when Task B completes');
  } finally {
    fs.writeFileSync(releasePath, 'release');
    const activeResult = await activeMutation;
    assert.equal(activeResult.commandSucceeded, true, 'finishing another task must not terminate the running command');
  }

  await callTool('relai_work', {
    action: 'cancel',
    workspace: 'app',
    work_id: blocker.work_id,
    reason: 'Independent task finish regression coverage complete.'
  });
} finally {
  await flushTaskHistoryPersistence();
  await repositoryIntelligence.shutdown();
  await flushLocalAnalytics();
  if (previousConfig == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previousConfig;
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 20 : 5, retryDelay: 100 });
}

console.log('work.finish completes independently while another task keeps the mutation lane.');
