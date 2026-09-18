import assert from 'node:assert/strict';

import { compactSessionSummary } from '../../src/context/session-compactor.js';

const session = compactSessionSummary({
  title: 'Fix connector timeout',
  objective: 'Fix connector timeout without changing unrelated behavior.',
  status: 'waiting',
  changedFiles: ['src/connector.js'],
  validationStatus: 'passed',
  summary: 'Kept the connector alive after idle recovery.',
  currentStage: 'Verification',
  currentActivity: 'Ran focused connector tests.',
  lastTool: 'relai_validate',
  lastOutcome: 'succeeded',
  plan: {
    revision: 4,
    steps: [
      { id: 'inspect', title: 'Inspect connector', status: 'completed' },
      { id: 'verify', title: 'Verify recovery', status: 'in_progress', detail: 'Run focused connector tests.' }
    ]
  },
  workflowEvidence: [{ kind: 'check', outcome: 'passed', sourceTool: 'relai_validate', commandId: 'test:connector', paths: ['src/connector.js'], command: 'secret-bearing command must not enter recovery' }],
  events: [{ stdout: 'raw log output must not enter summary' }],
  workflow: {
    stage: 'verify',
    recommendedActions: [{ reason: 'obsolete advisory state must not enter recovery' }]
  }
});
assert.equal(session.goal, 'Fix connector timeout without changing unrelated behavior.');
assert.deepEqual(session.changes, ['src/connector.js']);
assert.equal(session.validation, 'passed');
assert.equal(session.status, 'waiting');
assert.equal(session.summary, 'Kept the connector alive after idle recovery.');
assert.equal(session.current.stage, 'Verification');
assert.equal(session.plan.revision, 4);
assert.deepEqual(session.plan.steps.map(step => step.status), ['completed', 'in_progress'], 'recovery compaction must preserve the durable ordered checklist');
assert.equal(session.plan.steps[1].detail, 'Run focused connector tests.');
assert.equal(session.recentEvidence[0].check, 'test:connector');
assert.equal(Object.hasOwn(session, 'remaining'), false);
assert.doesNotMatch(JSON.stringify(session), /raw log output/);
assert.doesNotMatch(JSON.stringify(session), /secret-bearing command/);
assert.doesNotMatch(JSON.stringify(session), /obsolete advisory state/);

console.log('Session compaction retains factual recovery evidence without advisory workflow state.');
