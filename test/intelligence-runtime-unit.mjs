import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { relaiSemanticSearch } from '../src/bridge/semanticSearch.js';
import { relaiDiagnosticsRun } from '../src/bridge/diagnosticsRunner.js';
import { relaiCodeInspect } from '../src/bridge/codeIntelligence.js';
import { openIndexDatabase, repositoryIndexPath } from '../src/repository/intelligence/database.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';

const zoektSource = fs.readFileSync(new URL('../src/repository/intelligence/zoekt.js', import.meta.url), 'utf8');
const indexBuildSource = fs.readFileSync(new URL('../src/repository/intelligence/indexBuild.js', import.meta.url), 'utf8');
const queryServiceSource = fs.readFileSync(new URL('../src/repository/intelligence/queryService.js', import.meta.url), 'utf8');
const queryWorkerSource = fs.readFileSync(new URL('../src/repository/intelligence/queryWorker.js', import.meta.url), 'utf8');
const repositoryServiceSource = fs.readFileSync(new URL('../src/repository/intelligence/service.js', import.meta.url), 'utf8');
const lexicalFallbackSource = fs.readFileSync(new URL('../src/repository/intelligence/lexicalFallback.js', import.meta.url), 'utf8');
assert.match(lexicalFallbackSource, /await runProcess\(/, 'lexical fallback must use the asynchronous process runner');
assert.match(zoektSource, /await runProcess\(/, 'Zoekt commands must use the asynchronous process runner');
assert.match(indexBuildSource, /await rebuildZoektIndex\(/, 'full Zoekt rebuilds must execute inside the Repository Intelligence worker job');
assert.match(queryServiceSource, /await searchZoekt\(/, 'query-time Zoekt search must remain asynchronous');
assert.match(queryWorkerSource, /SOURCE_CACHE_MAX_FILES/, 'query worker source caching must have a file-count bound');
assert.match(queryWorkerSource, /SOURCE_CACHE_MAX_BYTES/, 'query worker source caching must have a byte bound');
assert.doesNotMatch(repositoryServiceSource, /queryCodeInspect|querySemanticSearch/, 'the main repository service must not execute synchronous query implementations directly');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-intelligence-'));
const stateDir = path.join(root, 'state');
fs.mkdirSync(path.join(root, 'src', 'runtime'), { recursive: true });
fs.mkdirSync(path.join(root, 'test'), { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'attendanceService.js'), `
function calculateDailyAttendance(timeIn, shiftStart) {
  return { lateMinutes: Math.max(0, timeIn - shiftStart), present: true };
}
module.exports = { calculateDailyAttendance };
`);
fs.writeFileSync(path.join(root, 'src', 'theme.js'), `module.exports = { accent: 'blue' };\n`);
fs.writeFileSync(path.join(root, 'test', 'attendance.test.js'), `
const { calculateDailyAttendance } = require('../src/attendanceService');
calculateDailyAttendance(9, 8);
`);

fs.writeFileSync(path.join(root, 'src', 'orphanTarget.js'), `export function ghostCall() { return 'target'; }\n`);
fs.writeFileSync(path.join(root, 'src', 'unrelated.js'), `export function unrelatedCaller() { return ghostCall(); }\n`);
fs.writeFileSync(path.join(root, 'src', 'importedCaller.js'), `
import { ghostCall } from './orphanTarget.js';
export function importedCaller() { return ghostCall(); }
`);
fs.writeFileSync(path.join(root, 'src', 'socketObserver.js'), `
import { scheduleResume } from './runtime/continuation.js';
export function observeSocketFailure(error) {
  // recover connection after socket failure
  return scheduleResume(error);
}
`);
fs.writeFileSync(path.join(root, 'src', 'runtime', 'continuation.js'), `export function scheduleResume(error) { return error ? 250 : 0; }\n`);
fs.writeFileSync(path.join(root, 'src', 'recoveryGuide.js'), `export const recoveryGuide = 'recover connection after failure';\n`);
fs.writeFileSync(path.join(root, 'src', 'socketStatus.js'), `export const socketStatus = 'socket connection failure';\n`);
fs.writeFileSync(path.join(root, 'src', 'failureNotes.js'), `export const failureNotes = 'recover after socket failure';\n`);

const workspace = { alias: 'app', path: root, context: {}, testCommands: {}, commands: {} };
const config = {
  stateDir,
  repositoryIntelligence: {
    zoektSearchExecutable: path.join(root, 'missing-zoekt-search'),
    zoektIndexExecutable: path.join(root, 'missing-zoekt-index')
  }
};

try {
  const semantic = await relaiSemanticSearch(workspace, config, { query: 'calculate employee lateness attendance', maxResults: 5 }, { watch: false });
  assert.equal(semantic.ok, true);
  assert.match(String(semantic.fingerprint || ''), /^generation:/);
  const indexStatus = repositoryIntelligence.status(workspace, config);
  assert.match(String(indexStatus.metadata?.producerVersion || ''), /^[A-Za-z0-9_-]{24}$/);
  assert.equal(indexStatus.metadata?.runtimeStale, false);
  assert.equal(semantic.privacy.includes('No source text'), true);
  assert.equal(semantic.neuralEmbeddings, false);
  assert.equal(typeof semantic.retrieval?.degraded, 'boolean');
  assert.equal(semantic.retrieval?.fallback?.used, true,
    'semantic search must report when Zoekt is unavailable and source-authoritative fallback is used');
  assert.match(semantic.strategy, /graph-diffusion$/);
  assert.equal(semantic.results[0].path, 'src/attendanceService.js');

  const batchedSemantic = await relaiSemanticSearch(workspace, config, {
    queries: ['calculate attendance', 'theme accent'],
    maxResults: 3,
    maxBytes: 4000
  }, { watch: false });
  assert.equal(batchedSemantic.ok, true);
  assert.equal(batchedSemantic.execution.maxConcurrentSteps, 2,
    'two-query semantic batches should report the two units that actually ran concurrently');
  assert.ok(batchedSemantic.resultCount <= 3, 'semantic batch maxResults must be an aggregate cap');
  assert.ok(batchedSemantic.returnedBytes <= 4000, 'semantic batch maxBytes must be an aggregate cap');
  assert.match(batchedSemantic.strategy, /read-pool$/);

  const hiddenSemantic = await relaiSemanticSearch(workspace, config, { query: 'recover connection after socket failure', maxResults: 5 }, { watch: false });
  const hiddenPaths = hiddenSemantic.results.map(item => item.path);
  assert.equal(hiddenPaths[0], 'src/socketObserver.js');
  assert.ok(hiddenPaths.slice(0, 3).every(item => item !== 'src/runtime/continuation.js'),
    'graph diffusion must preserve the lexical top three');
  const hiddenRank = hiddenPaths.indexOf('src/runtime/continuation.js') + 1;
  assert.ok(hiddenRank >= 4 && hiddenRank <= 5, `hidden graph target should rank 4-5, got ${hiddenRank || 'missing'}`);
  const hidden = hiddenSemantic.results.find(item => item.path === 'src/runtime/continuation.js');
  assert.ok(hidden.providers.includes('graph-diffusion'));
  assert.ok(hidden.snippets.some(item => item.text.includes('scheduleResume')));

  const db = openIndexDatabase(repositoryIndexPath(config, workspace), { readonly: true });
  try {
    const indexes = new Set(db.prepare("PRAGMA index_list('edges')").all().map(row => String(row.name)));
    assert.ok(indexes.has('edges_source_file_type_target_idx'));
    assert.ok(indexes.has('edges_target_file_type_source_idx'));
    const callEdges = db.prepare(`
      SELECT source.path AS source_path, target.path AS target_path
      FROM edges e
      JOIN files source ON source.id=e.source_file_id
      JOIN files target ON target.id=e.target_file_id
      WHERE e.type='CALLS' AND e.target_name='ghostCall'
      ORDER BY source.path
    `).all();
    assert.ok(callEdges.some(row => row.source_path === 'src/importedCaller.js' && row.target_path === 'src/orphanTarget.js'));
    assert.equal(callEdges.some(row => row.source_path === 'src/unrelated.js' && row.target_path === 'src/orphanTarget.js'), false,
      'unimported unique-name calls must not create cross-file CALLS edges');
  } finally {
    db.close();
  }

  fs.writeFileSync(path.join(root, 'src', 'orphanTarget.js'), `export function ghostCall() { return 'target-v2'; }\n`);
  repositoryIntelligence.noteMutation(workspace, config, ['src/orphanTarget.js']);
  const incremental = await repositoryIntelligence.ensure(workspace, config);
  assert.equal(incremental.scanMode, 'incremental');
  assert.equal(incremental.changedPathCount, 1);
  const incrementalDb = openIndexDatabase(repositoryIndexPath(config, workspace), { readonly: true });
  try {
    const callEdges = incrementalDb.prepare(`
      SELECT source.path AS source_path, target.path AS target_path
      FROM edges e
      JOIN files source ON source.id=e.source_file_id
      JOIN files target ON target.id=e.target_file_id
      WHERE e.type='CALLS' AND e.target_name='ghostCall'
      ORDER BY source.path
    `).all();
    assert.ok(callEdges.some(row => row.source_path === 'src/importedCaller.js' && row.target_path === 'src/orphanTarget.js'),
      'incremental relationship refresh must rebuild unchanged callers whose target file was reparsed');
    assert.equal(callEdges.some(row => row.source_path === 'src/unrelated.js' && row.target_path === 'src/orphanTarget.js'), false,
      'incremental relationship refresh must preserve cross-file call precision');
  } finally {
    incrementalDb.close();
  }

  const trace = await relaiCodeInspect(workspace, config, { action: 'trace', symbol: 'calculateDailyAttendance', maxResults: 50 });
  assert.equal(trace.definitions[0].path, 'src/attendanceService.js');
  assert.ok(trace.affectedTests.includes('test/attendance.test.js'));
  assert.ok(trace.recommendedReadOrder.includes('src/attendanceService.js'));

  const diagnosticText = 'src/app.ts(4,7): error TS2345: Argument is invalid';
  fs.writeFileSync(path.join(root, 'typescript-diagnostic.cjs'), `process.stderr.write(${JSON.stringify(diagnosticText + '\n')});process.exit(1);\n`);
  const diagnostics = await relaiDiagnosticsRun(workspace, config, { command: 'node typescript-diagnostic.cjs', stopOnFailure: true });
  assert.equal(diagnostics.ok, false);
  assert.equal(diagnostics.diagnostics.length, 1);
  assert.deepEqual(diagnostics.diagnostics[0], {
    path: 'src/app.ts', line: 4, column: 7, severity: 'error', code: 'TS2345',
    message: 'Argument is invalid', source: 'typescript'
  });
} finally {
  await repositoryIntelligence.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Semantic graph diffusion, call precision, relationship trace, and normalized diagnostics tests passed.');
