import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-config-defaults-'));
const configPath = path.join(root, 'config.json');
const workspaceRoot = path.join(root, 'workspace');
fs.mkdirSync(workspaceRoot, { recursive: true });
process.env.REL_AI_MCP_CONFIG = configPath;

try {
  const { makeDefaultConfig, makeDefaultContextConfig } = await import('../src/config.js');
  const { updateProjectAccess, updateWorkspace } = await import('../src/configEditor.js');

  const defaults = makeDefaultContextConfig();
  assert.ok(defaults.excludePaths.includes('.rel-ai-mcp-state'), 'canonical defaults must exclude Rel.AI state');

  const current = makeDefaultConfig();
  assert.equal(current.projectAccess.directFilesystem, false, 'direct filesystem access must remain opt-in by default');
  current.stateDir = path.join(root, 'state');
  updateWorkspace(current, {
    action: 'upsert',
    alias: 'fixture',
    mode: 'create',
    path: workspaceRoot
  });

  const persisted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(
    persisted.workspaces.fixture.context,
    defaults,
    'config editing must consume the same canonical context defaults as config loading'
  );
  const projectAccess = updateProjectAccess(persisted, { directFilesystem: true });
  assert.equal(projectAccess.config.projectAccess.directFilesystem, true, 'direct filesystem switch must persist through the canonical config editor');
  assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).projectAccess.directFilesystem, true);

  const cli = (...args) => spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/relai-mcp-config.js'), ...args], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
      REL_AI_MCP_STATE_DIR: current.stateDir, REL_AI_MCP_CONFIG: configPath, REL_AI_OFFICIAL_BUILD: '0' }
  });
  const moved = path.join(root, 'Moved Project');
  fs.renameSync(workspaceRoot, moved);
  const unhealthy = cli('doctor');
  assert.equal(unhealthy.status, 2, unhealthy.stderr);
  assert.equal(JSON.parse(unhealthy.stdout).ok, false);
  assert.ok(JSON.parse(unhealthy.stdout).findings.some(finding => finding.code === 'workspace_unavailable'));
  const repair = cli('workspace', 'add', 'fixture', moved);
  assert.equal(repair.status, 0, repair.stderr);
  const healthy = cli('doctor');
  assert.equal(healthy.status, 0, healthy.stderr);
  assert.equal(JSON.parse(healthy.stdout).ok, true);
  assert.equal(cli('doctor', '--not-a-doctor-option').status, 1, 'bad invocations differ from reported health errors');
  console.log('Configuration default ownership and CLI health checks passed.');
} finally {
  delete process.env.REL_AI_MCP_CONFIG;
  fs.rmSync(root, { recursive: true, force: true });
}
