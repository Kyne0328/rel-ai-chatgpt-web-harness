import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-workspace-recovery-'));
const repoRoot = path.join(tmp, 'repo');
const otherRoot = path.join(tmp, 'other');
const stateDir = path.join(tmp, 'state');
const configPath = path.join(tmp, 'config.json');
fs.mkdirSync(repoRoot, { recursive: true });
fs.mkdirSync(otherRoot, { recursive: true });
fs.writeFileSync(configPath, JSON.stringify({
  version: 2,
  stateDir,
  auditLogPath: path.join(stateDir, 'audit.jsonl'),
  workspaces: {
    repo: { path: repoRoot },
    other: { path: otherRoot }
  }
}, null, 2));
process.env.REL_AI_MCP_CONFIG = configPath;

const { callTool: rawCallTool } = await import('../src/tools.js');
const { CAPABILITIES, createConsentPolicy } = await import('../src/mcp/authorizationPolicy.js');
const { serializeToolError } = await import('../src/tools/errors.js');
const { toolResult } = await import('../src/mcpServer.js');

let requestId = 0;
async function invoke(name, args, context = {}) {
  requestId += 1;
  try {
    const output = await rawCallTool(name, args, {
      principal: 'local:trusted',
      requestId,
      transportType: 'test',
      ...context
    });
    return toolResult(output, output?.ok === false);
  } catch (error) {
    return toolResult(serializeToolError(name, error), true);
  }
}

try {
  const localMissing = await invoke('relai_work', { action: 'begin', title: 'Projectless local recovery goal' }, { publicHttpOnly: true });
  assert.equal(localMissing.isError, false);
  assert.equal(localMissing.structuredContent.workspace, undefined, 'work.begin must not require selecting a configured workspace');
  assert.ok(localMissing.structuredContent.work_id);
  await invoke('relai_work', { action: 'cancel', work_id: localMissing.structuredContent.work_id, reason: 'recovery test cleanup' }, { publicHttpOnly: true });

  const restrictedPrincipal = {
    authorizationPolicy: createConsentPolicy({
      capabilities: [CAPABILITIES.REPOSITORY_READ],
      workspaces: ['repo'],
      availableWorkspaces: ['other', 'repo']
    })
  };

  const restrictedMissing = await invoke('relai_work', { action: 'begin', title: 'Restricted projectless recovery goal' }, {
    publicHttpOnly: true,
    principal: restrictedPrincipal
  });
  assert.equal(restrictedMissing.isError, false);
  assert.equal(restrictedMissing.structuredContent.workspace, undefined);
  assert.ok(restrictedMissing.structuredContent.work_id);
  await invoke('relai_work', {
    action: 'cancel',
    work_id: restrictedMissing.structuredContent.work_id,
    reason: 'restricted recovery test cleanup'
  }, { publicHttpOnly: true, principal: restrictedPrincipal });

  const restrictedUnknown = await invoke('relai_work', { action: 'begin', workspace: 'typo-repo' }, {
    publicHttpOnly: true,
    principal: restrictedPrincipal
  });
  assert.equal(restrictedUnknown.isError, true);
  assert.equal(restrictedUnknown.structuredContent.errorCode, 'AUTHORIZATION_DENIED', 'restricted clients must not learn whether an unauthorized workspace alias exists');
  assert.equal(restrictedUnknown.structuredContent.errorDetails.workspaceAliases, undefined, 'authorization errors must not expose configured workspace aliases');

  const snapshotMissing = await invoke('relai_snapshot', {}, {
    publicHttpOnly: true,
    principal: restrictedPrincipal
  });
  assert.equal(snapshotMissing.isError, true);
  assert.equal(snapshotMissing.structuredContent.errorCode, 'WORKSPACE_INPUT_OMITTED');
  assert.deepEqual(snapshotMissing.structuredContent.errorDetails.workspaceAliases, ['repo']);

  const snapshotUnknown = await invoke('relai_snapshot', { workspace: 'typo-repo' }, {
    publicHttpOnly: true,
    principal: restrictedPrincipal
  });
  assert.equal(snapshotUnknown.isError, true);
  assert.equal(snapshotUnknown.structuredContent.errorCode, 'WORKSPACE_NOT_CONFIGURED');
  assert.deepEqual(snapshotUnknown.structuredContent.errorDetails.workspaceAliases, ['repo']);

  const unauthorizedKnown = await invoke('relai_work', { action: 'begin', workspace: 'other' }, {
    publicHttpOnly: true,
    principal: restrictedPrincipal
  });
  assert.equal(unauthorizedKnown.isError, true);
  assert.equal(unauthorizedKnown.structuredContent.errorCode, 'AUTHORIZATION_DENIED');
  assert.equal(unauthorizedKnown.structuredContent.errorDetails.workspaceAliases, undefined);

  const anonymousMissing = await invoke('relai_work', { action: 'begin' }, {
    publicHttpOnly: true,
    principal: undefined
  });
  assert.equal(anonymousMissing.isError, true);
  assert.equal(anonymousMissing.structuredContent.errorCode, 'AUTHORIZATION_DENIED');
  assert.equal(anonymousMissing.structuredContent.errorDetails.workspaceAliases, undefined);

  const recovered = await invoke('relai_work', { action: 'begin', workspace: 'repo', bootstrap: 'none' }, {
    publicHttpOnly: true,
    principal: restrictedPrincipal
  });
  assert.equal(recovered.isError, false);
  assert.equal(recovered.structuredContent.workspace, 'repo');
  assert.match(recovered.structuredContent.work_id, /^[0-9a-f-]{36}$/i);

  const cancelled = await invoke('relai_work', {
    action: 'cancel',
    workspace: 'repo',
    work_id: recovered.structuredContent.work_id,
    reason: 'Workspace recovery regression complete.'
  }, {
    publicHttpOnly: true,
    principal: restrictedPrincipal
  });
  assert.equal(cancelled.isError, false);

  console.log('Workspace recovery errors return only authorized aliases and support an explicit retry.');
} finally {
  delete process.env.REL_AI_MCP_CONFIG;
  await removeDirectoryWithRetry(tmp);
}

async function removeDirectoryWithRetry(directory, attempts = 40) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  if (process.platform === 'win32' && lastError?.code === 'EPERM') {
    process.once('exit', () => { try { fs.rmSync(directory, { recursive: true, force: true }); } catch {} });
    return;
  }
  throw lastError;
}
