import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { relaiStatus } from "../src/tools/status.js";
import { getToolSurfaceManifest } from '../src/tools/schema.js';
import { CAPABILITIES, createConsentPolicy } from '../src/mcp/authorizationPolicy.ts';
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-status-aliases-'));
const previousStateDir = process.env.REL_AI_MCP_STATE_DIR;
process.env.REL_AI_MCP_STATE_DIR = stateDir;
const config = {
  stateDir,
  workspaces: {
    zebra: { path: '/tmp/zebra' },
    app: { path: '/tmp/app' },
    worker: { path: '/tmp/worker' },
    api: { path: '/tmp/api' }
  }
};

try {
  const status = await relaiStatus(config);
  assert.equal(status.workspaceCount, 4);
  const expectedSurface = getToolSurfaceManifest();
  assert.equal(status.toolSurface.toolSurfaceVersion, expectedSurface.toolSurfaceVersion);
  assert.equal(status.toolSurface.toolCount, expectedSurface.toolCount);
  assert.deepEqual(status.toolSurface.deprecations, expectedSurface.deprecations);
  assert.deepEqual(status.workspaceAliases, ['api', 'app', 'worker', 'zebra']);
  assert.equal(status.workspace, null);
  assert.equal(status.runtimeCompatibility.status, 'repository_unavailable');

  const restricted = await relaiStatus(config, {}, {
    connector: true,
    principal: {
      authorizationPolicy: createConsentPolicy({
        capabilities: [CAPABILITIES.REPOSITORY_READ],
        workspaces: ['app', 'api'],
        availableWorkspaces: ['api', 'app', 'worker', 'zebra']
      })
    }
  });
  assert.equal(restricted.workspaceCount, 2);
  assert.deepEqual(restricted.workspaceAliases, ['api', 'app'], 'restricted clients must not enumerate ungranted workspace aliases');

  const missing = await relaiStatus(config, { workspace: 'unknown' });
  assert.equal(missing.workspace.alias, 'unknown');
  assert.match(missing.workspace.error, /not configured/i);
  assert.deepEqual(missing.workspaceAliases, ['api', 'app', 'worker', 'zebra']);
} finally {
  if (previousStateDir == null) delete process.env.REL_AI_MCP_STATE_DIR;
  else process.env.REL_AI_MCP_STATE_DIR = previousStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
}

console.log('Status workspace aliases unit tests passed');
