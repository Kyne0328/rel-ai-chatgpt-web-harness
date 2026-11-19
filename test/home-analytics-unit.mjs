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

{
  const { clearDashboardAnalytics, loadAnalyticsModels, subscribeAnalyticsReset } = await import('../src/ui/features/usage/data.js');
  const { postJson } = await import('../src/ui/api.js');
  const reset = desktop => clearDashboardAnalytics(desktop, () => postJson('/api/diagnostics/reset', { target: 'analytics', confirm: true }));
  const previousFetch = globalThis.fetch;
  const bridge = {}, other = {};
  const totals = count => ({ requests: count, toolCalls: count, successes: count, failures: 0, executionMs: 0, activeDays: count ? 1 : 0 });
  const snapshot = count => ({ month: '2026-11', totals: totals(count) });
  const readMonth = async (desktop, fresh = false) => (await loadAnalyticsModels({
    desktop, range: '1h', now: new Date('2026-11-15T12:00:00Z'), fresh
  })).models[0].totals.toolCalls;
  let count = 11, otherReads = 0, refreshes = 0;
  bridge.getLocalUsage = async () => snapshot(count);
  other.getLocalUsage = async () => { otherReads++; return snapshot(7); };
  const unsubscribe = subscribeAnalyticsReset(bridge, () => { refreshes++; });
  try {
    assert.equal(await readMonth(bridge), 11);
    assert.equal(await readMonth(other), 7);
    globalThis.fetch = async (url, init) => {
      assert.equal(url, '/api/diagnostics/reset');
      assert.deepEqual(JSON.parse(init.body), { target: 'analytics', confirm: true });
      return Response.json({ ok: false, error: 'reset refused' }, { status: 409 });
    };
    assert.equal((await reset(bridge)).ok, false);
    assert.equal(refreshes, 0);
    let finishRead;
    bridge.getLocalUsage = () => new Promise(resolve => { finishRead = resolve; });
    assert.equal(await readMonth(bridge), 11, 'explicit rejection preserves the last valid cache');
    const olderRead = readMonth(bridge, true);
    await Promise.resolve();
    globalThis.fetch = async () => { count = 0; return Response.json({ ok: true }); };
    assert.equal((await reset(bridge)).ok, true);
    assert.equal(refreshes, 1, 'already-mounted consumers receive the reset');
    bridge.getLocalUsage = async () => snapshot(count);
    assert.equal(await readMonth(bridge), 0, 'immediately reopening must read the emptied store');
    finishRead(snapshot(11));
    assert.equal(await olderRead, 0, 'a pre-reset read completing later must not publish deleted totals');
    assert.equal(await readMonth(bridge), 0);
    assert.equal(await readMonth(other), 7);
    assert.equal(otherReads, 1, 'reset invalidation must not cross desktop bridges');
    unsubscribe();
    globalThis.fetch = async () => { count = 3; throw new Error('lost confirmation'); };
    assert.equal((await reset(bridge)).outcomeUnknown, true);
    assert.equal(await readMonth(bridge), 3, 'uncertain reset re-reads actual state without claiming deletion');
    assert.equal(refreshes, 1, 'disposed listeners must not be notified');
  } finally {
    unsubscribe();
    globalThis.fetch = previousFetch;
  }
}

console.log('Overview analytics preview model passed.');
