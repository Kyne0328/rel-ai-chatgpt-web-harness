import { callTool as rawCallTool } from "../src/tools.js";
import { getToolActivity, onToolActivity, resetToolActivity } from "../src/toolActivity.js";
import { flushAuditWrites, readAudit } from "../src/audit.js";
import { readConfig } from "../src/config.js";
import { flushLocalAnalytics } from '../src/localAnalytics.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const callTool = (name, args, context = {}) => rawCallTool(name, args, { principal: 'local:trusted', ...context });

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-tool-failure-'));
const workspace = path.join(temp, 'workspace');
const configPath = path.join(temp, 'config.json');
const auditLogPath = path.join(temp, 'audit.jsonl');
const previous = process.env.REL_AI_MCP_CONFIG;
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { check: 'node -e "process.exit(1)"' } }));
fs.writeFileSync(configPath, JSON.stringify({
  version: 2,
  stateDir: path.join(temp, 'state'),
  auditLogPath,
  workspaces: { app: { path: workspace, commands: {}, testCommands: {} } }
}));
process.env.REL_AI_MCP_CONFIG = configPath;

const activityEvents = [];
const unsubscribeActivity = onToolActivity(event => activityEvents.push(event));

try {
  resetToolActivity();
  const context = { publicHttpOnly: true };
  const task = await callTool('relai_work', { action: 'begin', workspace: 'app' }, context);
  const result = await callTool('relai_exec', {
    workspace: 'app', work_id: task.work_id, command: 'node -e "process.exit(1)"'
  }, context);
  assert.equal(result.ok, true);
  assert.equal(result.executed, true);
  assert.equal(result.commandSucceeded, false);
  assert.equal(result.exitCode, 1);
  assert.equal(getToolActivity().failures, 0, 'a nonzero child-process exit must not count as an MCP tool failure');
  const liveEvent = [...activityEvents].reverse().find(event => event.phase === 'finished' && event.activityEvent?.metadata?.exitCode === 1);
  assert.equal(liveEvent?.activityEvent?.status, 'failed', 'Activity must show a nonzero command outcome as failed even when the MCP tool call completed normally');
  await flushAuditWrites();
  const event = readAudit(readConfig(), { limit: 20 }).entries.find(entry => entry.publicTool === 'relai_exec');
  assert.equal(event.ok, true, 'the audit event must record successful tool execution separately from command outcome');
  assert.equal(event.status, 'failed', 'persisted Activity history must retain the failed command outcome');
} finally {
  unsubscribeActivity();
  await flushLocalAnalytics();
  if (previous == null) delete process.env.REL_AI_MCP_CONFIG;
  else process.env.REL_AI_MCP_CONFIG = previous;
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 20 : 2, retryDelay: 100 });
}

console.log('Tool execution and command-outcome accounting tests passed.');
