import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { packPlugin } from '../scripts/pack-plugin.mjs';
import { validatePlugin } from '../scripts/validate-plugin.mjs';
import { getMcpToolSchemas } from '../src/tools/schema.js';
import { TASKS_EXTENSION_REVISION } from '../src/mcp/protocol.js';
import { startMcpClient, structuredContentOf } from './helpers/mcp-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-plugin-package-'));
const packDir = path.join(temp, 'pack');
const extractDir = path.join(temp, 'extract');
const installDir = path.join(temp, 'installed', 'rel-ai-mcp');
const expectedSkills = ['rel-ai-debugging', 'rel-ai-dev-process', 'rel-ai-investigation', 'rel-ai-planning', 'rel-ai-verification', 'rel-ai-workflow'];
fs.mkdirSync(packDir, { recursive: true });
fs.mkdirSync(extractDir, { recursive: true });

try {
  const sourceValidation = validatePlugin(root);
  assert.equal(sourceValidation.ok, true);
  assert.deepEqual(sourceValidation.skills, expectedSkills);

  const metadata = packPlugin({ rootDir: root, destination: packDir });
  assert.ok(metadata?.filename, 'plugin packer must return artifact metadata');
  assert.ok(Number.isFinite(Number(metadata.size)) && Number(metadata.size) > 0, 'npm pack must report a non-empty compressed artifact');
  assert.ok(Number.isFinite(Number(metadata.unpackedSize)) && Number(metadata.unpackedSize) > 0, 'npm pack must report non-empty unpacked content');
  const artifact = path.join(packDir, metadata.filename);
  assert.ok(fs.existsSync(artifact), 'npm pack artifact must exist');

  const tar = spawnSync('tar', ['-xzf', artifact, '-C', extractDir], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(tar.status, 0, tar.stderr || tar.stdout);
  const builtRoot = path.join(extractDir, 'package');
  const builtValidation = validatePlugin(builtRoot);
  assert.deepEqual(builtValidation.skills, expectedSkills);

  const expected = [
    'skills/PROVENANCE.md',
    ...expectedSkills.flatMap(skill => [`skills/${skill}/SKILL.md`, `skills/${skill}/agents/openai.yaml`]),
    'skills/rel-ai-workflow/references/workflows.md', 'skills/rel-ai-workflow/references/safety.md',
    'src/mcp/appUi.js', 'src/mcp/localDeveloperMode.js',
    'bin/rel-ai-mcp.js', 'package.json'
  ];
  const packedFiles = new Set(metadata.files.map(item => item.path.replaceAll('\\', '/')));
  for (const relative of expected) assert.ok(packedFiles.has(relative), `artifact missing ${relative}`);
  for (const dependency of ['@modelcontextprotocol/server', '@opentelemetry/api', 'web-tree-sitter']) {
    assert.ok(
      fs.existsSync(path.join(builtRoot, 'node_modules', dependency, 'package.json')),
      `artifact must bundle runtime dependency ${dependency}`
    );
  }

  fs.mkdirSync(path.dirname(installDir), { recursive: true });
  fs.cpSync(builtRoot, installDir, { recursive: true });
  assert.deepEqual(validatePlugin(installDir).skills, expectedSkills, 'installed package skills must validate');
  const check = spawnSync(process.execPath, ['--check', path.join(installDir, 'bin', 'rel-ai-mcp.js')], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr || check.stdout);

  const config = {
    version: 3,
    stateDir: path.join(temp, 'state'),
    workspaces: { repo: { path: root } }
  };
  const configPath = path.join(temp, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const client = startMcpClient({ root: installDir, configPath, timeoutMs: 30_000 });
  try {
    client.initialize(1);
    const discovery = await client.waitFor(1);
    assert.equal(discovery.result?.capabilities?.tools != null, true, 'installed MCP server must advertise tools');
    assert.deepEqual(
      discovery.result?.capabilities?.extensions?.['io.modelcontextprotocol/tasks'],
      { revision: TASKS_EXTENSION_REVISION }
    );

    client.send(2, 'tools/list');
    const listed = await client.waitFor(2);
    assert.deepEqual(listed.result.tools, getMcpToolSchemas(config), 'source and extracted MCP tools/list must match, including native ChatGPT status metadata');

    client.call(3, 'relai_work', { action: 'begin', workspace: root, bootstrap: 'none' });
    const started = structuredContentOf(await client.waitFor(3));
    assert.match(started.work_id, /^[0-9a-f-]{36}$/i, 'installed MCP server must start work through relai_work begin');

    client.call(4, 'relai_read', {
      work_id: started.work_id,
      paths: ['package.json'],
      maxBytes: 32768,
      guidanceMode: 'none'
    });
    const read = structuredContentOf(await client.waitFor(4));
    assert.equal(read.items?.[0]?.path, 'package.json', 'installed artifact must execute a low-risk repository read');

    client.call(5, 'relai_validate', {
      action: 'checks',
      work_id: started.work_id,
      check: 'node --check src/mcpServer.js',
      timeoutMs: 30000,
      stopOnFailure: true,
      complete: false
    });
    const validation = structuredContentOf(await client.waitFor(5, 45_000));
    assert.equal(validation.ok, true, 'consolidated validation must receive work_id in the extracted artifact');

    client.call(6, 'relai_process', { action: 'list', work_id: started.work_id });
    const processes = structuredContentOf(await client.waitFor(6));
    assert.equal(processes.ok, true, 'consolidated process listing must receive work_id in the extracted artifact');
    assert.equal(processes.count, 0);

    client.call(7, 'relai_work', { action: 'cancel', work_id: started.work_id, reason: 'Package runtime parity test completed.' });
    const cancelled = structuredContentOf(await client.waitFor(7));
    assert.equal(cancelled.work_id, started.work_id);
  } finally {
    await client.close();
  }

  fs.rmSync(installDir, { recursive: true, force: true });
  assert.equal(fs.existsSync(installDir), false, 'plugin removal must remove the complete unit');
  console.log(`Package artifact ${path.basename(artifact)} validated, installed, exercised, and removed.`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
