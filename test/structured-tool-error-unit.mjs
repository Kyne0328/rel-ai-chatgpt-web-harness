import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-structured-error-'));
const workspaceRoot = path.join(tmp, 'repo');
const stateDir = path.join(tmp, 'state');
const configPath = path.join(tmp, 'config.json');
fs.mkdirSync(workspaceRoot, { recursive: true });
fs.writeFileSync(path.join(workspaceRoot, '.env'), 'API_KEY=not-returned\n');
fs.writeFileSync(configPath, JSON.stringify({
  version: 2,
  stateDir,
  auditLogPath: path.join(stateDir, 'audit.jsonl'),
  workspaces: { repo: { path: workspaceRoot, testCommands: {}, commands: {} } }
}, null, 2));
process.env.REL_AI_MCP_CONFIG = configPath;
process.env.REL_AI_MCP_MAX_TOOL_RESULT_BYTES = '1200';

const { callTool: rawCallTool } = await import('../src/tools.js');
const { serializeToolError } = await import('../src/tools/errors.js');
const { toolResult } = await import('../src/mcpServer.js');
const callTool = (name, args, context = {}) => rawCallTool(name, args, { principal: 'local:trusted', ...context });

let requestId = 0;
async function invoke(name, args, context = {}) {
  requestId += 1;
  try {
    const output = await callTool(name, args, { requestId, transportType: 'test', ...context });
    return toolResult(output, output?.ok === false);
  } catch (error) {
    return toolResult(serializeToolError(name, error), true);
  }
}

try {
  const initialTaskResponse = await invoke('relai_work', { action: 'begin', workspace: 'repo', bootstrap: 'none' });
  const initialTaskId = initialTaskResponse.structuredContent.work_id;
  const response = await invoke('relai_read', { work_id: initialTaskId, paths: ['.env'], guidanceMode: 'none' });

  assert.equal(response.isError, true, 'explicit reads of secret-bearing paths must fail at the safety boundary');
  const readPayload = response.structuredContent;
  assert.equal(readPayload.ok, false);
  assert.deepEqual(readPayload.items, []);
  assert.equal(readPayload.skipped[0].path, '.env');
  assert.match(readPayload.skipped[0].reason, /blocked sensitive path/);
  assert.match(readPayload.error, /None of the requested paths could be read/);
  assert.doesNotMatch(JSON.stringify(readPayload), /not-returned/);

  const dotWorkspaceResponse = await invoke('relai_work', { action: 'begin', workspace: '.' }, { publicHttpOnly: true });
  assert.equal(dotWorkspaceResponse.isError, true);
  const dotWorkspace = dotWorkspaceResponse.structuredContent;
  assert.equal(dotWorkspace.errorCode, 'WORKSPACE_AMBIGUOUS_RELATIVE_INPUT');
  assert.equal(dotWorkspace.errorDetails.workspaceInput, '.');
  assert.equal(dotWorkspace.errorDetails.workspaceMatchStatus, 'rejected_ambiguous_input');
  assert.equal(dotWorkspace.errorDetails.workspaceResolutionFailure, 'explicit_dot_has_no_authoritative_client_base');
  assert.deepEqual(dotWorkspace.errorDetails.configuredWorkspaceAliases, ['repo']);
  assert.match(dotWorkspace.error, /configured workspace alias/);

  const directPathResponse = await invoke('relai_work', { action: 'begin', workspace: workspaceRoot, bootstrap: 'none' }, { publicHttpOnly: true });
  assert.equal(directPathResponse.isError, false);
  assert.equal(directPathResponse.structuredContent.workspace, 'repo');
  const taskId = directPathResponse.structuredContent.work_id;

  const unknownPath = path.join(tmp, 'unknown-repo');
  fs.mkdirSync(unknownPath);
  const unknownPathResponse = await invoke('relai_work', { action: 'begin', workspace: unknownPath }, { publicHttpOnly: true });
  assert.equal(unknownPathResponse.isError, true);
  assert.equal(unknownPathResponse.structuredContent.errorCode, 'WORKSPACE_PATH_NOT_CONFIGURED');

  const omittedWorkspaceResponse = await invoke('relai_work', { action: 'begin' }, { publicHttpOnly: true });
  assert.equal(omittedWorkspaceResponse.isError, true);
  assert.equal(omittedWorkspaceResponse.structuredContent.errorCode, 'WORKSPACE_INPUT_OMITTED');
  assert.deepEqual(omittedWorkspaceResponse.structuredContent.errorDetails.workspaceAliases, ['repo']);
  assert.equal(omittedWorkspaceResponse.structuredContent.errorDetails.workspaceCount, 1);

  const writeResponse = await invoke('relai_edit', { workspace: 'repo', work_id: taskId, path: '.env', content: 'API_KEY=replacement\n' }, { publicHttpOnly: true });

  assert.equal(writeResponse.isError, true);
  const payload = writeResponse.structuredContent;
  assert.equal(payload.ok, false);
  assert.equal(payload.errorCode, 'SENSITIVE_PATH_RESTRICTED');
  assert.equal(payload.errorDetails.source, 'rel-ai-mcp-policy');
  assert.equal(payload.errorDetails.operation, 'write');
  assert.equal(payload.errorDetails.path, '.env');
  assert.equal(payload.errorDetails.fileClass, 'environment_secret');
  assert.equal(payload.errorDetails.retryable, false);
  assert.equal(payload.errorDetails.requiresUserConfirmation, false);
  assert.ok(payload.errorDetails.allowedAlternatives.some((item) => item.includes('.env.example')));
  assert.doesNotMatch(JSON.stringify(payload), /replacement|not-returned/);

  const largeFailureResponse = await invoke('relai_validate', { action: 'checks',
    workspace: 'repo',
    work_id: taskId,
    check: `node -e "process.stderr.write('failure-detail-'.repeat(800));process.exit(1)"`
  }, { publicHttpOnly: true });

  assert.equal(largeFailureResponse.isError, true);
  const largeFailure = largeFailureResponse.structuredContent;
  assert.equal(largeFailure.ok, false);
  assert.equal(largeFailure.truncated, true);
  assert.ok(largeFailure.originalBytes > 1200);
  assert.equal(largeFailure.validationStatus, 'failed');
  assert.equal(largeFailure.results[0].exitCode, 1);
  assert.match(largeFailure.results[0].stderr, /failure-detail-/);
  assert.match(largeFailure.nextAction, /failing (?:check|validation)/i);
  assert.match(largeFailure.nextAction, /rerun/i);

  console.log('Structured tool errors preserve actionable diagnostics, including truncated failures.');
} finally {
  delete process.env.REL_AI_MCP_CONFIG;
  delete process.env.REL_AI_MCP_MAX_TOOL_RESULT_BYTES;
  fs.rmSync(tmp, { recursive: true, force: true });
}
