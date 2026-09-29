import assert from 'node:assert/strict';

globalThis.location = { hash: '#home' };
const {
  homeAnalyticsView,
  overviewWorkspaceStatus
} = await import('../src/ui/features/home/index.js');
const { desktopSetupSteps } = await import('../src/ui/features/onboarding/index.js');

const scope = {
  kind: 'all',
  toolCalls: 18,
  completed: 18,
  reliabilityCalls: 18,
  reliableCalls: 17,
  reliabilityRate: 94.444,
  operationSuccessRate: 88.889,
  infrastructureFailures: 1,
  averageDuration: 240,
  workspaces: [
    { workspace: 'rel-ai-mcp', toolCalls: 12 },
    { workspace: 'other', toolCalls: 6 }
  ],
  points: [{ toolCalls: 1 }, { toolCalls: 5 }, { toolCalls: 2 }, { toolCalls: 10 }]
};

assert.equal(overviewWorkspaceStatus({ alias: 'app', operational: { exists: true } }), 'ready');
assert.equal(overviewWorkspaceStatus({ alias: 'app', operational: { exists: false } }), 'unavailable');
assert.equal(overviewWorkspaceStatus({ alias: 'app', operational: { exists: true } }, [{ workspace: 'app', severity: 'error' }]), 'needs attention');
assert.equal(overviewWorkspaceStatus({ alias: 'app', operational: { currentActivity: 'Editing' } }), 'active');

const lockedSetup = desktopSetupSteps({ hasWorkspace: true, endpointReady: false, chatgptReady: false, firstRequestObserved: false });
assert.equal(lockedSetup.find(step => step.id === 'chatgpt').locked, true);
assert.equal(lockedSetup.find(step => step.id === 'first-request').locked, true);
const readySetup = desktopSetupSteps({ hasWorkspace: true, endpointReady: true, chatgptReady: true, firstRequestObserved: false });
assert.equal(readySetup.find(step => step.id === 'chatgpt').complete, true);
assert.equal(readySetup.find(step => step.id === 'first-request').locked, false);
assert.equal(readySetup.find(step => step.id === 'first-request').complete, false);
const addProjectStep = desktopSetupSteps({ hasWorkspace: false }).find(step => step.id === 'workspace');
assert.equal(addProjectStep.href, '#workspaces?create=1');
assert.equal(addProjectStep.action, 'Add project');
assert.equal(readySetup.find(step => step.id === 'workspace').action, 'Add project', 'Completed setup steps must not carry unreachable action copy');
assert.equal(desktopSetupSteps({ hasWorkspace: true, endpointReady: true, chatgptReady: true, firstRequestObserved: true }).every(step => step.complete), true);

const view = homeAnalyticsView(scope);
assert.equal(view.heading, 'Activity');
assert.deepEqual(view.metrics.map(metric => metric.label), ['Actions', 'Successful actions', 'Average time', 'Active projects']);
assert.equal(view.metrics[0].value, '18');
assert.equal(view.metrics[1].value, '88.9%');
assert.equal(view.metrics[2].value, '240 ms');
assert.equal(view.metrics[3].value, '2');
assert.equal(view.contextSummary, 'Most active project: rel-ai-mcp');
assert.equal(view.errorSummary, '1 Rel.AI internal error');
assert.equal(homeAnalyticsView({ ...scope, infrastructureFailures: 0 }).errorSummary, '', 'Healthy overview analytics must not show a permanent no-errors message');
assert.equal(view.pulse.empty, false);
assert.match(view.pulse.summary, /Current hour 10 actions/);
assert.match(view.pulse.summary, /Overall trend increasing/);
assert.deepEqual(view.pulse.values, [1, 5, 2, 10]);
assert.deepEqual(view.pulse.labels, ['3h ago', '2h ago', '1h ago', 'Current hour']);
assert.equal(view.pulse.latestIndex, 3);
assert.equal(view.pulse.peakIndex, 3);
assert.equal(view.pulse.peak, 10);
assert.equal('polyline' in view.pulse, false);
assert.equal('area' in view.pulse, false);

const workspaceView = homeAnalyticsView({ ...scope, kind: 'workspace', label: 'Rel.AI', workspace: 'rel-ai-mcp', executionMs: 1500 });
assert.equal(workspaceView.heading, 'Rel.AI activity');
assert.equal(workspaceView.workspaceScoped, true);
assert.equal(workspaceView.metrics[3].label, 'Total execution time');
assert.equal(workspaceView.metrics[3].value, '1.50 s');

assert.equal(homeAnalyticsView({ points: [] }).pulse.empty, true);
console.log('Overview analytics preview model passed.');
