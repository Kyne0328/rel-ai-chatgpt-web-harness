import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMcpClient, structuredContentOf } from './helpers/mcp-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-ai-goal-workflow-'));
const configPath = path.join(temp, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({ version: 2, stateDir: path.join(temp, 'state'), workspaces: {} }));
const client = startMcpClient({
  root, configPath, timeoutMs: 15000,
  env: { REL_AI_CHATGPT_WEB_BEARER: '', REL_AI_CHATGPT_WEB_COOKIE: '' }
});

try {
  client.initialize(1);
  await client.waitFor(1);
  client.call(2, 'relai_work', {
    action: 'begin', title: 'Goal opt-in smoke', objective: 'Verify Goal Mode opt-in', goal: true
  });
  const started = structuredContentOf(await client.waitFor(2));
  assert.ok(started.work_id);
  assert.equal(started.goalMode, undefined); // Preserve existing begin output contract.

  client.call(3, 'relai_work', { action: 'goal_status', work_id: started.work_id });
  const status = structuredContentOf(await client.waitFor(3));
  assert.equal(status.goalActive, true);

  client.call(4, 'relai_work', { action: 'goal_stop', work_id: started.work_id });
  const stopped = structuredContentOf(await client.waitFor(4));
  assert.equal(stopped.goalActive, false);
  assert.equal(stopped.state, 'stopped');

  client.call(5, 'relai_work', { action: 'status', work_id: started.work_id });
  const workStatus = structuredContentOf(await client.waitFor(5));
  assert.notEqual(workStatus?.task?.status, 'cancelled');

  client.call(6, 'relai_work', { action: 'begin', title: 'Ordinary task', objective: 'No goal requested' });
  const normal = structuredContentOf(await client.waitFor(6));
  assert.ok(normal.work_id);
  assert.equal(normal.goalMode, undefined);

  client.call(7, 'relai_work', { action: 'begin', goal: true,
    title: 'Offline milestone with hardware blocker', objective: 'Complete feasible work and record the blocker',
    steps: [{ id: 'offline', title: 'Finish offline integration', status: 'in_progress' },
      { id: 'hardware', title: 'Verify physical device', status: 'pending' }] });
  const resolvable = structuredContentOf(await client.waitFor(7));
  assert.ok(resolvable.work_id);
  client.call(8, 'relai_work', { action: 'plan', work_id: resolvable.work_id,
    steps: [{ id: 'offline', title: 'Finish offline integration', status: 'completed' },
      { id: 'hardware', title: 'Verify physical device', status: 'blocked' }] });
  const updated = structuredContentOf(await client.waitFor(8));
  assert.equal(updated.ok, true);
  client.call(9, 'relai_work', { action: 'context', work_id: resolvable.work_id, bootstrap: 'none' });
  const completedReply = await client.waitFor(9);
  assert.throws(() => structuredContentOf(completedReply), /already completed/,
    'explicitly resolved Goal Mode plan must finalize the work session through its normal guarded path');

  client.call(10, 'relai_work', { action: 'plan', work_id: normal.work_id,
    steps: [{ id: 'goal', title: 'Ordinary task', status: 'completed' }] });
  assert.equal(structuredContentOf(await client.waitFor(10)).ok, true);
  client.call(11, 'relai_work', { action: 'context', work_id: normal.work_id, bootstrap: 'none' });
  assert.notEqual(structuredContentOf(await client.waitFor(11)).status, 'completed',
    'ordinary non-goal work must still require an explicit finish call');

  console.log('Goal Mode lifecycle preserves blockers and closes resolved goals; ordinary work stays explicit.');
} finally {
  await client.closeGracefully();
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 20 : 5, retryDelay: 100 });
}
