import assert from 'node:assert/strict';

import { buildExtraAudit } from "../src/tools/session.js";
import { OPERATION_IDS as OP } from '../src/tools/operationIds.js';

assert.deepEqual(
  buildExtraAudit(OP.EDIT, { plannerPath: 'replace', plannerReason: 'exact text supplied' }, { path: 'src/example.js' }),
  { plannerPath: 'replace', plannerReason: 'exact text supplied', filePath: 'src/example.js' }
);

assert.deepEqual(
  buildExtraAudit(OP.VALIDATE_CHECKS, {
    validationLevel: 'release',
    validationLevelReason: 'requested',
    aliasNormalizations: 0,
    policy: { sessionActive: false }
  }, {}),
  {
    validationLevel: 'release',
    validationLevelReason: 'requested',
    aliasNormalizations: 0,
    policySessionActive: false
  }
);

assert.deepEqual(
  buildExtraAudit(OP.READ, { items: [{ cacheHit: false }, { cacheHit: true }] }, {}),
  { cacheHit: true }
);

assert.deepEqual(
  buildExtraAudit(OP.EXEC, {
    commandSummary: 'npm test --token [REDACTED]',
    cwd: '.',
    exitCode: 1,
    durationMs: 42,
    stdoutBytes: 100,
    stderrBytes: 20,
    stdoutTruncated: false,
    stderrTruncated: true,
    timedOut: false,
    mutationTracking: 'git',
    environmentKeys: ['CI'],
    changedFiles: ['package-lock.json']
  }, {}),
  {
    commandSummary: 'npm test --token [REDACTED]',
    cwd: '.',
    exitCode: 1,
    durationMs: 42,
    stdoutBytes: 100,
    stderrBytes: 20,
    stdoutTruncated: false,
    stderrTruncated: true,
    timedOut: false,
    mutationTracking: 'git',
    mutationUnknown: false,
    environmentKeys: ['CI'],
    changedFiles: ['package-lock.json']
  }
);

assert.deepEqual(
  buildExtraAudit(OP.SNAPSHOT, { effectiveMaxEntries: 0, budgetMultiplied: false }, {}),
  { effectiveSnapshotMaxFiles: 0, budgetMultiplied: false }
);

assert.deepEqual(
  buildExtraAudit(OP.EDIT, { changedFiles: ['src/example.js'] }, { path: 'src/example.js', dryRun: true }),
  { filePath: 'src/example.js' },
  'dry-run edits must not be recorded as actual changed files'
);
assert.deepEqual(buildExtraAudit(OP.PUBLISH_COMMIT, { ok: true, paths: ['src/example.js'] }, { dryRun: true }), {}, 'dry-run commits must not be recorded as created commits');
assert.deepEqual(buildExtraAudit(OP.PUBLISH_PUSH, { ok: true }, { dryRun: true }), {}, 'dry-run pushes must not be recorded as published pushes');
assert.deepEqual(buildExtraAudit(OP.PUBLISH_PUSH, { ok: true }, {}), { pushPublished: true }, 'real successful pushes remain publish events');

assert.deepEqual(buildExtraAudit(OP.WORK_STATUS, {}, {}), {});
assert.deepEqual(buildExtraAudit(OP.EDIT, { plannerPath: '', plannerReason: '' }, {}), {});
assert.deepEqual(buildExtraAudit('removed_tool', {}, {}), {});

console.log('Tool session audit enrichment tests passed for active tools.');
