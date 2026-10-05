import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MAX_PROJECT_INSTRUCTION_BYTES, readProjectInstructions, resetProjectInstructionCacheForTests } from '../src/projectInstructions.js';
import { repoSnapshot, relaiReadAsync } from '../src/localRepoBridge.js';
import { workspaceInspect } from '../src/tools/status.js';
import { compactForConnector } from '../src/tools/connector.js';
import { publicConfigSummary } from '../src/config.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-project-instructions-'));
const repo = path.join(temp, 'repo');
const stateDir = path.join(temp, 'state');
const workspace = { alias: 'app', path: repo, context: {}, commands: {}, testCommands: {} };
const config = {
  stateDir,
  auditLogPath: path.join(stateDir, 'audit.jsonl'),
  workspaces: { app: workspace },
  productUx: {},
  release: {},
  patch: {}
};

fs.mkdirSync(repo, { recursive: true });

try {
  resetProjectInstructionCacheForTests();
  const empty = readProjectInstructions(workspace);
  assert.deepEqual(empty.sources, []);
  assert.equal(empty.content, '');
  assert.equal(empty.truncated, false);
  assert.match(empty.securityBoundary, /not authorization/i);

  fs.writeFileSync(path.join(repo, 'REL_AI.md'), 'Legacy root rule.\n', 'utf8');
  fs.mkdirSync(path.join(repo, '.relai'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.relai', 'instructions.md'), 'Legacy nested rule.\n', 'utf8');
  resetProjectInstructionCacheForTests();
  const legacyIgnored = readProjectInstructions(workspace);
  assert.deepEqual(legacyIgnored.sources, [], 'legacy Rel.AI instruction paths must not be loaded automatically');
  assert.equal(legacyIgnored.content, '');

  const directRead = await relaiReadAsync(workspace, config, { paths: ['.relai/instructions.md'] });
  assert.match(directRead.items[0].content, /Legacy nested rule/, 'legacy files remain ordinary readable repository files');

  fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'Root agent rule.\n', 'utf8');
  resetProjectInstructionCacheForTests();
  const rootAgents = readProjectInstructions(workspace);
  assert.deepEqual(rootAgents.sources, ['AGENTS.md']);
  assert.match(rootAgents.content, /Root agent rule/);

  fs.writeFileSync(path.join(repo, 'AGENTS.override.md'), 'Root override rule.\n', 'utf8');
  resetProjectInstructionCacheForTests();
  const rootOverride = readProjectInstructions(workspace);
  assert.deepEqual(rootOverride.sources, ['AGENTS.override.md']);
  assert.match(rootOverride.content, /Root override rule/);
  assert.doesNotMatch(rootOverride.content, /Root agent rule/, 'AGENTS.override.md must replace AGENTS.md in the same directory');

  const nestedDirectory = path.join(repo, 'src', 'feature');
  fs.mkdirSync(nestedDirectory, { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'AGENTS.md'), 'Source agent rule.\n', 'utf8');
  fs.writeFileSync(path.join(nestedDirectory, 'AGENTS.md'), 'Feature agent rule.\n', 'utf8');
  fs.writeFileSync(path.join(nestedDirectory, 'index.js'), 'export {};\n', 'utf8');
  resetProjectInstructionCacheForTests();
  const nestedAgents = readProjectInstructions(workspace, { targetPath: 'src/feature/index.js' });
  assert.deepEqual(nestedAgents.sources, ['src/feature/AGENTS.md', 'src/AGENTS.md', 'AGENTS.override.md']);
  assert.equal(nestedAgents.targetPath, 'src/feature');
  assert.ok(nestedAgents.content.indexOf('Feature agent rule') < nestedAgents.content.indexOf('Source agent rule'));
  assert.ok(nestedAgents.content.indexOf('Source agent rule') < nestedAgents.content.indexOf('Root override rule'));

  const cachedFirst = readProjectInstructions(workspace);
  fs.writeFileSync(path.join(repo, 'AGENTS.override.md'), 'Fresh override rule.\n', 'utf8');
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(path.join(repo, 'AGENTS.override.md'), future, future);
  const refreshed = readProjectInstructions(workspace);
  assert.match(cachedFirst.content, /Root override rule/);
  assert.match(refreshed.content, /Fresh override rule/, 'mtime/size signature changes must invalidate the instruction cache');

  fs.writeFileSync(path.join(repo, 'AGENTS.override.md'), Buffer.from([0, 1, 2, 3]));
  resetProjectInstructionCacheForTests();
  const binaryRejected = readProjectInstructions(workspace);
  assert.deepEqual(binaryRejected.sources, []);
  assert.deepEqual(binaryRejected.rejectedSources, [{ path: 'AGENTS.override.md', reason: 'binary-looking instruction file' }]);

  fs.writeFileSync(path.join(repo, 'AGENTS.override.md'), '🙂'.repeat(20000), 'utf8');
  resetProjectInstructionCacheForTests();
  const truncated = readProjectInstructions(workspace);
  assert.equal(truncated.truncated, true);
  assert.ok(truncated.totalBytes > MAX_PROJECT_INSTRUCTION_BYTES);
  assert.ok(Buffer.byteLength(truncated.content, 'utf8') <= MAX_PROJECT_INSTRUCTION_BYTES);
  assert.doesNotMatch(truncated.content, /\uFFFD/, 'UTF-8 truncation must not return a partial replacement character');
  const smaller = readProjectInstructions(workspace, { maxBytes: 1024 });
  assert.ok(Buffer.byteLength(smaller.content, 'utf8') <= 1024, 'cache entries must respect the requested payload limit');

  fs.writeFileSync(path.join(repo, 'AGENTS.override.md'), 'Snapshot instruction.\n', 'utf8');
  resetProjectInstructionCacheForTests();
  const snapshot = await repoSnapshot(workspace, config, { includeFiles: false });
  assert.deepEqual(snapshot.projectInstructions.sources, ['AGENTS.override.md']);
  assert.match(snapshot.projectInstructions.content, /Snapshot instruction/);
  assert.match(snapshot.projectInstructions.securityBoundary, /credentials/i, 'repository instructions must carry the non-authorization boundary to MCP clients');

  const compact = compactForConnector('snapshot', snapshot, {});
  assert.deepEqual(compact.projectInstructions, snapshot.projectInstructions, 'connector compaction must retain project instructions');

  const inspect = workspaceInspect(config, { workspace: 'app', maxEntries: 10 });
  assert.equal(inspect.ok, true);
  assert.match(inspect.projectInstructions.content, /Snapshot instruction/);

  const summary = publicConfigSummary(config).workspaces[0].projectInstructions;
  assert.deepEqual(summary.sources, ['AGENTS.override.md']);
  assert.equal(summary.configured, true);
  assert.equal(Object.hasOwn(summary, 'content'), false, 'dashboard/config summaries must not include full instruction content');

  console.log('AGENTS-only project instruction loading tests passed.');
} finally {
  resetProjectInstructionCacheForTests();
  fs.rmSync(temp, { recursive: true, force: true });
}
