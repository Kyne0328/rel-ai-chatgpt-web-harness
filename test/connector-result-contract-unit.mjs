import assert from 'node:assert/strict';
import { fromJsonSchema } from '@modelcontextprotocol/server';
import { serializeConnectorResult } from '../src/tools/connector.js';
import { OPERATION_IDS as OP } from '../src/tools/operationIds.js';
import { getPublicToolSchemas } from '../src/tools/schema.js';
import { taskBootstrapFromSnapshot } from '../src/tools/task.js';

const compactBootstrap = taskBootstrapFromSnapshot({
  manifests: ['package.json'], discoveredCommands: { test: 'npm test' }, projectInstructions: { summary: 'Use project rules.' },
  fileCount: 64, files: Array.from({ length: 64 }, (_, index) => `src/file-${index}.js`), truncated: true,
  hints: ['node'], git: { branch: 'main' }, recommendedFlow: ['Search first.']
}, 'compact');
assert.equal(compactBootstrap.files, undefined, 'compact task bootstrap must not return a repository file listing');
assert.equal(compactBootstrap.fileCount, undefined, 'a truncated compact scan must not present its scan cap as the repository file count');
assert.equal(compactBootstrap.manifests[0], 'package.json');

const fullBootstrap = taskBootstrapFromSnapshot({
  manifests: ['package.json'], discoveredCommands: {}, projectInstructions: {}, fileCount: 2,
  files: ['src/a.js', 'src/b.js'], truncated: false, hints: [], git: {}, recommendedFlow: [],
  manifestContents: { 'package.json': '{}' }, skipped: [], writeGuidance: {}, operationJournal: []
}, 'full');
assert.deepEqual(fullBootstrap.files, ['src/a.js', 'src/b.js'], 'full task bootstrap must retain the explicit file listing');
assert.equal(fullBootstrap.fileCount, 2);

const cases = [
  fixture('relai_work:begin', 'relai_work', 'begin', OP.WORK_BEGIN, 'work_begin', {
    ok: true, workspace: 'repo', work_id: 'work_begin', status: 'planning', identity: 'work_session',
    workspaceBinding: { alias: 'repo' }, title: 'Contract work', objective: 'Characterize results.', intent: 'investigation',
    activeRelatedWork: [{ goal: 'Sibling task', status: 'running' }], nextAction: 'Use bootstrap.'
  }, {
    ok: true, workspace: 'repo', work_id: 'work_begin', status: 'planning', identity: 'work_session',
    title: 'Contract work', objective: 'Characterize results.', intent: 'investigation', activeRelatedWork: [{ goal: 'Sibling task', status: 'running' }], nextAction: 'Use bootstrap.'
  }),
  fixture('relai_work:plan', 'relai_work', 'plan', OP.WORK_PLAN, 'work_plan', {
    ok: true, workspace: 'repo', work_id: 'work_plan',
    plan: { revision: 3, steps: [
      { id: 'inspect', title: 'Inspect implementation', status: 'completed' },
      { id: 'validate', title: 'Run focused validation', status: 'in_progress' }
    ] },
    message: 'Task plan updated with 2 steps.'
  }, {
    ok: true, workspace: 'repo', work_id: 'work_plan',
    plan: { revision: 3, steps: [
      { id: 'inspect', title: 'Inspect implementation', status: 'completed' },
      { id: 'validate', title: 'Run focused validation', status: 'in_progress' }
    ] },
    message: 'Task plan updated with 2 steps.'
  }),
  fixture('relai_work:status', 'relai_work', 'status', OP.WORK_STATUS, 'work_status', {
    ok: true, version: '0.24.0', runtime: 'node', tools: ['relai_read'],
    toolSurface: { schemaVersion: 5, toolSurfaceVersion: 32, toolCount: 12, tools: [{ name: 'relai_read' }], deprecations: [] },
    activeRelatedWork: [{ goal: 'Sibling task', status: 'running' }], workspaceCount: 1, workspaceAliases: ['repo']
  }, {
    ok: true, version: '0.24.0', runtime: 'node', toolSurface: { schemaVersion: 5, toolSurfaceVersion: 32, toolCount: 12 },
    activeRelatedWork: [{ goal: 'Sibling task', status: 'running' }], workspaceCount: 1, workspaceAliases: ['repo'], work_id: 'work_status'
  }),
  fixture('relai_read', 'relai_read', '', OP.READ, 'work_read', {
    ok: true, workspace: 'repo', items: [{ type: 'file', path: 'README.md', bytes: 12, content: '# Project\n', cacheHit: false, writeGuidance: { recommendedMode: 'direct-write' } }], skipped: []
  }, {
    ok: true, workspace: 'repo', items: [{ type: 'file', path: 'README.md', bytes: 12, content: '# Project\n' }], work_id: 'work_read'
  }, { guidanceMode: 'none' }),
  fixture('relai_snapshot', 'relai_snapshot', '', OP.SNAPSHOT, 'work_snapshot', {
    ok: true, workspace: 'repo', fileCount: 700, files: ['src/index.js', 'src/other.js'], skipped: [], truncated: false,
    manifests: ['package.json'], discoveredCommands: {}, projectInstructions: {}, hints: [], git: {}, recommendedFlow: []
  }, {
    ok: true, workspace: 'repo', manifests: ['package.json'], discoveredCommands: {}, projectInstructions: {},
    fileCount: 700, files: ['src/index.js', 'src/other.js'], returnedFileCount: 2, omittedFiles: 0, skippedCount: 0, truncated: false,
    git: {}, work_id: 'work_snapshot'
  }),  fixture('relai_exec', 'relai_exec', '', OP.EXEC, 'work_exec', {
    ok: false, workspace: 'repo', command: 'npm test', commandSummary: 'npm test', cwd: '.', shell: 'PowerShell 7', exitCode: 1,
    durationMs: 120, stdout: 'running', stderr: 'failed', stdoutBytes: 7, stderrBytes: 6, stdoutTruncated: false,
    stderrTruncated: false, timedOut: false, environmentKeys: ['CI'], changedFiles: ['package-lock.json'], changedFilesTruncated: false, mutationTracking: 'git'
  }, {
    ok: false, workspace: 'repo', command: 'npm test', shell: 'PowerShell 7', exitCode: 1, durationMs: 120, stdout: 'running', stderr: 'failed', stdoutBytes: 7,
    stderrBytes: 6, environmentKeys: ['CI'], changedFiles: ['package-lock.json'], mutationTracking: 'git', work_id: 'work_exec'
  }),
  fixture('relai_process:read', 'relai_process', 'read', OP.PROCESS_READ, 'work_process', {
    ok: true, processId: 'proc_1', pid: 123, workspace: 'repo', workspaceId: 'repo', label: 'Server', kind: 'service', purpose: 'Serve.',
    commandSummary: 'npm run dev', cwd: '.', status: 'running', metadataRevision: 'rev_1', startedAt: '2026-08-05T00:00:00.000Z',
    stdoutBytes: 10, stderrBytes: 0, stdout: { text: 'ready\n', nextOffset: 10 }, stderr: { text: '', nextOffset: 0 }
  }, {
    ok: true, processId: 'proc_1', pid: 123, workspace: 'repo', label: 'Server', kind: 'service', purpose: 'Serve.', status: 'running',
    metadataRevision: 'rev_1', startedAt: '2026-08-05T00:00:00.000Z', stdoutBytes: 10,
    stdout: { text: 'ready\n', nextOffset: 10 }, stderr: { text: '', nextOffset: 0 }, work_id: 'work_process'
  }),
  fixture('relai_process:list-empty', 'relai_process', 'list', OP.PROCESS_LIST, 'work_process_list', {
    ok: true, processes: [], count: 0
  }, {
    ok: true, processes: [], count: 0, work_id: 'work_process_list'
  }),
  fixture('relai_search:semantic-max-bytes', 'relai_search', 'semantic', OP.SEARCH_SEMANTIC, 'work_semantic', {
    ok: true, workspace: 'repo', query: 'needle', maxBytes: 4096, resultCount: 0, matchCount: 0, returnedBytes: 0, truncated: false
  }, {
    ok: true, workspace: 'repo', query: 'needle', maxBytes: 4096, resultCount: 0, matchCount: 0, returnedBytes: 0, truncated: false, work_id: 'work_semantic'
  }),
  fixture('relai_validate:diagnostics-empty', 'relai_validate', 'diagnostics', OP.VALIDATE_DIAGNOSTICS, 'work_diagnostics', {
    ok: true, workspace: 'repo', commands: ['node --check src/index.js'], results: [], diagnostics: [], diagnosticCount: 0, completedUnits: 1, totalUnits: 1, cancelled: false, truncated: false
  }, {
    ok: true, workspace: 'repo', commands: ['node --check src/index.js'], diagnostics: [], diagnosticCount: 0, completedUnits: 1, totalUnits: 1, cancelled: false, truncated: false, work_id: 'work_diagnostics'
  }),
  fixture('relai_validate:checks', 'relai_validate', 'checks', OP.VALIDATE_CHECKS, 'work_checks', {
    ok: true, workspace: 'repo', level: 'standard', checks: ['npm test'], commands: ['npm test'],
    results: [{ command: 'npm test', ok: true, exitCode: 0, durationMs: 40, stdout: 'noise', stderr: '', stdoutBytes: 5, stderrBytes: 0 }],
    validated: true, validationStatus: 'passed', completionKnown: true, endReason: 'explicit_completion', completionSource: 'relai_validate:checks',
    summary: 'Validated.', validationAt: '2026-08-05T00:00:00.000Z', changedFiles: ['src/index.js'], message: 'Validation passed.'
  }, {
    ok: true, workspace: 'repo', level: 'standard', checks: ['npm test'],
    results: [{ command: 'npm test', ok: true, exitCode: 0, durationMs: 40, stdoutBytes: 5 }],
    validated: true, validationStatus: 'passed', completionKnown: true, endReason: 'explicit_completion', completionSource: 'relai_validate:checks',
    summary: 'Validated.', validationAt: '2026-08-05T00:00:00.000Z', changedFiles: ['src/index.js'], message: 'Validation passed.', work_id: 'work_checks'
  }),
  fixture('relai_changes:diff', 'relai_changes', 'diff', OP.CHANGES_DIFF, 'work_diff', {
    ok: true, workspace: 'repo', branch: 'main', status: ' M src/index.js\n M baseline.js\n', changedFiles: ['src/index.js', 'baseline.js'], untrackedFiles: [],
    statusEntries: [{ path: 'src/index.js' }, { path: 'baseline.js' }], staged: false, path: 'src/index.js',
    sessionChangedFiles: ['src/index.js'], baselineChangedFiles: ['baseline.js'], untrackedSessionFiles: ['new.js'], untrackedBaselineFiles: ['old.tmp'], baselineSource: 'session',
    diff: 'diff --git a/src/index.js b/src/index.js'
  }, {
    ok: true, workspace: 'repo', branch: 'main', status: ' M src/index.js\n M baseline.js\n', changedFiles: ['src/index.js', 'baseline.js'], staged: false,
    path: 'src/index.js', sessionChangedFiles: ['src/index.js'], baselineChangedFiles: ['baseline.js'], untrackedSessionFiles: ['new.js'], untrackedBaselineFiles: ['old.tmp'], baselineSource: 'session',
    diff: 'diff --git a/src/index.js b/src/index.js', work_id: 'work_diff'
  }),
  fixture('relai_publish:commit', 'relai_publish', 'commit', OP.PUBLISH_COMMIT, 'work_commit', {
    ok: true, workspace: 'repo', commit: 'abc123', message: 'Committed.', changedFiles: []
  }, { ok: true, workspace: 'repo', commit: 'abc123', message: 'Committed.', work_id: 'work_commit' }),
  fixture('relai_publish:push', 'relai_publish', 'push', OP.PUBLISH_PUSH, 'work_push', {
    ok: true, workspace: 'repo', remote: 'origin', branch: 'main', dryRun: false, setUpstream: false, push: { exitCode: 0 }
  }, { ok: true, workspace: 'repo', remote: 'origin', branch: 'main', dryRun: false, setUpstream: false, push: { exitCode: 0 }, work_id: 'work_push' })
];

const publicOutputValidators = new Map(getPublicToolSchemas().map(tool => [
  tool.name,
  fromJsonSchema(tool.outputSchema)['~standard']
]));

for (const item of cases) {
  const before = structuredClone(item.internal);
  const external = serializeConnectorResult({
    publicName: item.publicTool,
    action: item.action,
    operationName: item.operation,
    value: item.internal,
    args: item.args,
    workId: item.workId
  });
  assert.deepEqual(item.internal, before, `${item.name} serialization mutated the internal result`);
  assert.deepEqual(external, item.expected, `${item.name} connector contract changed`);
  const validation = await publicOutputValidators.get(item.publicTool).validate(external);
  assert.equal(validation.issues, undefined, `${item.name} serialized result must satisfy its advertised public output schema`);
}
console.log(`${cases.length} internal-to-connector result contracts passed.`);

function fixture(name, publicTool, action, operation, workId, internal, expected, args = {}) {
  return { name, publicTool, action, operation, workId, internal, expected, args };
}
