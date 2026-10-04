import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-connector-result-'));
const wsRoot = path.join(tmp, 'repo');
const stateDir = path.join(tmp, 'state');
const configPath = path.join(tmp, 'config.json');
const outsideRoot = path.join(tmp, 'outside');
const outsideFile = path.join(outsideRoot, 'outside.txt');
fs.mkdirSync(wsRoot, { recursive: true });
fs.mkdirSync(path.join(outsideRoot, '.ssh'), { recursive: true });
fs.writeFileSync(outsideFile, 'outside before\nsearch needle\n');
fs.writeFileSync(path.join(outsideRoot, '.ssh', 'id_rsa'), 'blocked secret\n');
fs.writeFileSync(path.join(wsRoot, 'big.txt'), 'x'.repeat(400000));
for (const name of ['multi-a.txt', 'multi-b.txt', 'multi-c.txt']) {
  fs.writeFileSync(path.join(wsRoot, name), name[6].repeat(700000));
}
const largeLines = Array.from({ length: 9000 }, (_, index) => `line-${String(index + 1).padStart(5, '0')}-${'x'.repeat(72)}`);
const largeText = largeLines.join('\n');
fs.writeFileSync(path.join(wsRoot, 'large-lines.txt'), largeText);
fs.writeFileSync(configPath, JSON.stringify({
  version: 2,
  stateDir,
  auditLogPath: path.join(stateDir, 'audit.jsonl'),
  trustedBudgetMultiplier: 2,
  projectAccess: { directFilesystem: true },
  workspaces: {
    repo: {
      path: wsRoot,
      testCommands: {},
      commands: {}
    }
  }
}, null, 2));
process.env.REL_AI_MCP_CONFIG = configPath;

const { flushAuditWrites } = await import('../src/audit.js');
const { invalidateConfigCache } = await import('../src/config.js');
const { flushLocalAnalytics } = await import('../src/localAnalytics.js');
const { flushTaskHistoryPersistence } = await import('../src/taskHistoryStore.ts');
const { resetTaskHistoryCaches } = await import('../src/taskHistoryStorage.ts');
const { callTool: rawCallTool } = await import('../src/tools.js');
const { resetToolActivity } = await import('../src/toolActivity.js');
const { toolResult } = await import('../src/mcp/results.js');
const { repositoryIntelligence } = await import('../src/repository/intelligence/service.js');
const sessionCache = await import('../src/sessionCache.js');
const callTool = (name, args, context = {}) => rawCallTool(name, args, { principal: 'local:trusted', ...context });

try {
  const ordinaryAlias = path.join(tmp, 'ordinary-root-alias');
  const privateDirectory = path.join(outsideRoot, '.aws');
  const privateAlias = path.join(tmp, 'private-root-alias');
  fs.mkdirSync(privateDirectory);
  fs.writeFileSync(path.join(privateDirectory, 'config'), 'synthetic private configuration\n');
  fs.symlinkSync(outsideRoot, ordinaryAlias, process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(privateDirectory, privateAlias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const target of ['outside.txt', path.join(ordinaryAlias, 'outside.txt')]) {
    const ordinary = await callTool('relai_read', {
      root: ordinaryAlias, paths: [target], guidanceMode: 'none'
    }, { publicHttpOnly: true, requestId: 'direct-filesystem-ordinary-alias', transportType: 'test' });
    assert.equal(ordinary.items[0].content, 'outside before\nsearch needle\n');
  }
  for (const [name, args] of [
    ['relai_read', { paths: ['config'], guidanceMode: 'none' }],
    ['relai_search', { pattern: 'synthetic', fixed: true }],
    ['relai_edit', { path: 'config', content: 'must not write', independent: true }]
  ]) {
    await assert.rejects(() => callTool(name, { root: privateAlias, ...args }, {
      publicHttpOnly: true, requestId: 'direct-filesystem-sensitive-root-alias', transportType: 'test'
    }), error => error.code === 'SENSITIVE_PATH_RESTRICTED', 'a root alias must not remove a sensitive real-path ancestor');
  }
  assert.equal(fs.readFileSync(path.join(privateDirectory, 'config'), 'utf8'), 'synthetic private configuration\n');

  const task = await callTool('relai_work', { action: 'begin',
    workspace: 'repo',
    bootstrap: 'none'
  }, { publicHttpOnly: true, requestId: 1, transportType: 'test' });
  const tasklessRead = await callTool('relai_read', {
    workspace: 'repo',
    paths: ['large-lines.txt'],
    startLine: 1,
    endLine: 1,
    maxBytes: 16 * 1024,
    guidanceMode: 'none'
  }, { publicHttpOnly: true, requestId: 2, transportType: 'test' });
  assert.equal(tasklessRead.ok, true, 'ordinary authorized workspace reads must not require a live work_id');
  assert.equal(tasklessRead.items[0].content, `${largeLines[0]}\n`);
  const directRead = await callTool('relai_read', {
    paths: [outsideFile],
    maxBytes: 16 * 1024,
    guidanceMode: 'none'
  }, { publicHttpOnly: true, requestId: 'direct-filesystem-read', transportType: 'test' });
  assert.equal(directRead.ok, true, 'enabled direct filesystem access must read an absolute path outside configured projects');
  assert.equal(directRead.workspace, '@filesystem');
  assert.equal(directRead.items[0].content, 'outside before\nsearch needle\n');

  const directSearch = await callTool('relai_search', {
    root: outsideRoot,
    pattern: 'search needle',
    fixed: true,
    maxResults: 10,
    mode: 'compact'
  }, { publicHttpOnly: true, requestId: 'direct-filesystem-search', transportType: 'test' });
  assert.equal(directSearch.ok, true, 'enabled direct filesystem access must search an explicit root outside configured projects');
  assert.equal(directSearch.workspace, '@filesystem');
  assert.ok(directSearch.matches?.some(match => match.path === 'outside.txt') || directSearch.results?.some(result => result.matches?.some(match => match.path === 'outside.txt')));

  const directEdit = await callTool('relai_edit', {
    root: outsideRoot,
    path: 'outside.txt',
    oldText: 'outside before',
    newText: 'outside after',
    independent: true
  }, { publicHttpOnly: true, requestId: 'direct-filesystem-edit', transportType: 'test' });
  assert.equal(directEdit.ok, true, 'enabled direct filesystem access must edit a root-relative path outside configured projects');
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside after\nsearch needle\n');

  const sensitiveRead = await callTool('relai_read', {
    root: outsideRoot,
    paths: ['.ssh/id_rsa'],
    guidanceMode: 'none'
  }, { publicHttpOnly: true, requestId: 'direct-filesystem-sensitive-read', transportType: 'test' });
  assert.equal(sensitiveRead.returnedCount, 0, 'direct filesystem access must preserve sensitive-path blocking');
  assert.match(sensitiveRead.skipped[0].reason, /blocked sensitive path|sensitive path/i);

  const projectlessTask = await callTool('relai_work', {
    action: 'begin',
    title: 'Direct filesystem task',
    objective: 'Edit an ordinary file outside configured projects.',
    bootstrap: 'none',
    steps: [{ id: 'edit', title: 'Edit the outside file', status: 'in_progress' }]
  }, { publicHttpOnly: true, requestId: 'direct-filesystem-task-begin', transportType: 'test' });
  const taskEdit = await callTool('relai_edit', {
    work_id: projectlessTask.work_id,
    root: outsideRoot,
    path: 'outside.txt',
    oldText: 'outside after',
    newText: 'outside task'
  }, { publicHttpOnly: true, requestId: 'direct-filesystem-task-edit', transportType: 'test' });
  assert.equal(taskEdit.ok, true, 'projectless durable work must be able to use enabled direct filesystem access');
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside task\nsearch needle\n');
  await callTool('relai_work', {
    action: 'cancel', work_id: projectlessTask.work_id, reason: 'direct filesystem regression complete'
  }, { publicHttpOnly: true, requestId: 'direct-filesystem-task-cancel', transportType: 'test' });

  const disabledConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  disabledConfig.projectAccess.directFilesystem = false;
  fs.writeFileSync(configPath, JSON.stringify(disabledConfig, null, 2));
  invalidateConfigCache();
  await assert.rejects(
    () => callTool('relai_read', { paths: [outsideFile], guidanceMode: 'none' }, { publicHttpOnly: true, requestId: 'direct-filesystem-disabled', transportType: 'test' }),
    /workspace/i,
    'disabling direct filesystem access must restore the configured-project requirement'
  );

  const computerStatus = await callTool('relai_computer', {
    action: 'status',
    workspace: 'repo'
  }, { publicHttpOnly: true, requestId: 'computer-status', transportType: 'test' });
  assert.equal(computerStatus.ok, true, 'computer status must survive the public connector dispatch path');
  assert.equal(computerStatus.action, 'status');
  assert.equal(computerStatus.enabled, false);
  assert.equal(typeof computerStatus.available, 'boolean');

  const output = await callTool('relai_read', {
    work_id: task.work_id,
    paths: ['big.txt'],
    maxBytes: 256 * 1024,
    guidanceMode: 'none'
  }, { publicHttpOnly: true, requestId: 2, transportType: 'test' });
  const result = toolResult(output, false);
  assert.equal(result.isError, false);
  assert.equal(output.workflow, undefined, 'connector reads must not carry obsolete advisory workflow state');
  assert.ok(Array.isArray(result.structuredContent?.items), 'connector result must retain the relai_read item array');
  const item = result.structuredContent.items[0];
  assert.equal(item.returnedBytes, 256 * 1024);
  assert.equal(item.truncated, true);
  assert.equal(result.structuredContent.message, undefined, 'result must not collapse to the generic outer truncation summary');
  assert.match(result.content[0].text, /Rel\.AI operation succeeded\./, 'text content must provide a concise human-readable summary');
  assert.match(result.content[0].text, /Read big\.txt:/, 'standard MCP text content must expose a bounded useful read excerpt');
  assert.doesNotMatch(result.content[0].text, /"items"/, 'large structured results must not be duplicated into text content');

  const ranged = await callTool('relai_read', {
    work_id: task.work_id,
    paths: ['large-lines.txt'],
    startLine: 4000,
    endLine: 4002,
    maxBytes: 16 * 1024,
    guidanceMode: 'none'
  }, { publicHttpOnly: true, requestId: 3, transportType: 'test' });
  const rangedItem = ranged.items[0];
  assert.equal(rangedItem.content, `${largeLines.slice(3999, 4002).join('\n')}\n`);
  assert.deepEqual(rangedItem.lineRange, { startLine: 4000, endLine: 4002, totalLines: largeLines.length });
  assert.equal(rangedItem.sha256, crypto.createHash('sha256').update(largeText).digest('hex'), 'ranged reads must preserve the authoritative whole-file hash');
  assert.ok(rangedItem.returnedBytes < 1024, 'a small ranged read must not return the whole large file');
  const metadataEntriesAfterFirstRange = sessionCache.cacheStats().metadataEntries;
  assert.ok(metadataEntriesAfterFirstRange >= 1, 'the first large ranged read should cache authoritative whole-file metadata');

  const cachedRange = await callTool('relai_read', {
    work_id: task.work_id,
    paths: ['large-lines.txt'],
    startLine: 7000,
    endLine: 7001,
    maxBytes: 16 * 1024,
    guidanceMode: 'none'
  }, { publicHttpOnly: true, requestId: 4, transportType: 'test' });
  assert.equal(sessionCache.cacheStats().metadataEntries, metadataEntriesAfterFirstRange, 'later bounded ranges should reuse the existing metadata cache entry');
  assert.equal(cachedRange.items[0].sha256, rangedItem.sha256);
  assert.deepEqual(cachedRange.items[0].lineRange, { startLine: 7000, endLine: 7001, totalLines: largeLines.length });

  const aggregate = await callTool('relai_read', {
    work_id: task.work_id,
    paths: ['multi-a.txt', 'multi-b.txt', 'multi-c.txt'],
    maxBytes: 1024 * 1024,
    guidanceMode: 'none'
  }, { publicHttpOnly: true, requestId: 5, transportType: 'test' });
  const aggregateBytes = aggregate.items.reduce((sum, current) => sum + current.returnedBytes, 0);
  assert.ok(aggregateBytes <= 1024 * 1024, `connector multi-file reads must honor one aggregate budget, got ${aggregateBytes}`);
  assert.equal(aggregate.truncated, true);

  const { relaiReadAsync } = await import('../src/localRepoBridge.js');
  const partial = await relaiReadAsync({ alias: 'repo', path: wsRoot }, { stateDir }, {
    paths: ['big.txt', 'does-not-exist.txt'], guidanceMode: 'none'
  }, { connector: true });
  assert.equal(partial.ok, true);
  assert.equal(partial.partial, true, 'mixed read success must be explicit instead of hiding behind ok=true');
  assert.equal(partial.requestedCount, 2);
  assert.equal(partial.returnedCount, 1);
  assert.equal(partial.skipped.length, 1);

  const skippedOnly = await relaiReadAsync({ alias: 'repo', path: wsRoot }, { stateDir }, {
    paths: ['does-not-exist.txt'], guidanceMode: 'none'
  }, { connector: true });
  assert.equal(skippedOnly.ok, false, 'all-skipped reads must not claim success');
  assert.equal(skippedOnly.requestedCount, 1);
  assert.equal(skippedOnly.returnedCount, 0);
  assert.equal(Object.hasOwn(skippedOnly, 'partial'), false);
  assert.match(skippedOnly.error, /none of the requested paths could be read/i);

  console.log('Connector read result limit and streamed range unit tests passed.');
} finally {
  await repositoryIntelligence.shutdown();
  await flushAuditWrites();
  await flushTaskHistoryPersistence();
  resetTaskHistoryCaches();
  resetToolActivity();
  await flushLocalAnalytics();
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
