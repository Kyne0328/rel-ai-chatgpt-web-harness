// Consolidated dashboard ui coverage.
// Pure and self-contained checks share one process; tests requiring process/global isolation remain standalone.
// Add related regression checks here instead of creating another one-off test file.

// Formerly caution-summary-unit.mjs
async function case_caution_summary_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:path");
    const path = __m2.default;
  
    const __m3 = await import("node:os");
    const os = __m3.default;
  
    const __m4 = await import("../src/productUx.js");
    const { cautionSummary } = __m4;
  
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-caution-summary-'));
  const auditPath = path.join(TMP, 'audit.jsonl');
  const config = { stateDir: TMP, auditLogPath: auditPath };
  
  function writeEntries(entries) {
    fs.writeFileSync(auditPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  
  function isoMinusHours(hours) {
    return new Date(Date.now() - hours * 3600000).toISOString();
  }
  
  // 1. No audit file -> empty workspaces
  {
    fs.rmSync(auditPath, { force: true });
    const r = cautionSummary(config, { windowHours: 24 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.workspaces, []);
    console.log('1. no audit file: OK');
  }
  
  // 2. Non-caution entries ignored
  {
    writeEntries([
      { ts: isoMinusHours(1), tool: 'relai_edit', workspace: 'a', ok: true },
      { ts: isoMinusHours(2), tool: 'relai_read', workspace: 'a', ok: true }
    ]);
    const r = cautionSummary(config, { windowHours: 24 });
    assert.deepEqual(r.workspaces, []);
    console.log('2. non-caution ignored: OK');
  }
  
  // 3. Caution entries inside window counted
  {
    writeEntries([
      { ts: isoMinusHours(1), tool: 'relai_clear_files', workspace: 'a', taskId: 'task-new', filePath: 'config.json', cautionLevel: 'caution', cautionReason: 'cleared 3 files' },
      { ts: isoMinusHours(2), tool: 'relai_apply_bundle', workspace: 'a', cautionLevel: 'caution', cautionReason: 'applied prepared bundle' }
    ]);
    const r = cautionSummary(config, { windowHours: 24 });
    assert.equal(r.workspaces.length, 1);
    assert.equal(r.workspaces[0].count, 2);
    assert.equal(r.workspaces[0].recent.length, 2);
    assert.equal(r.workspaces[0].recent[0].taskId, 'task-new');
    assert.equal(r.workspaces[0].recent[0].path, 'config.json');
    assert.equal(r.workspaces[0].recent[0].reason, 'cleared 3 files');
    console.log('3. caution counted: OK');
  }
  
  // 4. Entries outside window excluded
  {
    writeEntries([
      { ts: isoMinusHours(25), tool: 'relai_clear_files', workspace: 'a', cautionLevel: 'caution', cautionReason: 'old' },
      { ts: isoMinusHours(1), tool: 'relai_clear_files', workspace: 'a', cautionLevel: 'caution', cautionReason: 'new' }
    ]);
    const r = cautionSummary(config, { windowHours: 24 });
    assert.equal(r.workspaces[0].count, 1);
    assert.equal(r.workspaces[0].recent[0].reason, 'new');
    console.log('4. window filter: OK');
  }
  
  // 5. Grouped per workspace
  {
    writeEntries([
      { ts: isoMinusHours(1), tool: 'relai_clear_files', workspace: 'a', cautionLevel: 'caution', cautionReason: 'r1' },
      { ts: isoMinusHours(2), tool: 'relai_apply_bundle', workspace: 'b', cautionLevel: 'caution', cautionReason: 'r2' },
      { ts: isoMinusHours(3), tool: 'relai_apply_bundle', workspace: 'b', cautionLevel: 'caution', cautionReason: 'r3' }
    ]);
    const r = cautionSummary(config, { windowHours: 24 });
    assert.equal(r.workspaces.length, 2);
    const a = r.workspaces.find((w) => w.alias === 'a');
    const b = r.workspaces.find((w) => w.alias === 'b');
    assert.equal(a.count, 1);
    assert.equal(b.count, 2);
    console.log('5. grouped per workspace: OK');
  }
  
  // 6. recent[] capped at 5
  {
    const entries = [];
    for (let i = 0; i < 8; i++) entries.push({ ts: isoMinusHours(i + 1), tool: 'relai_clear_files', workspace: 'a', cautionLevel: 'caution', cautionReason: 'r' + i });
    writeEntries(entries);
    const r = cautionSummary(config, { windowHours: 24, limit: 50 });
    assert.equal(r.workspaces[0].count, 8);
    assert.equal(r.workspaces[0].recent.length, 5);
    console.log('6. recent capped at 5: OK');
  }
  
  // 7. Malformed ts ignored
  {
    writeEntries([
      { tool: 'relai_clear_files', workspace: 'a', cautionLevel: 'caution', cautionReason: 'no ts' },
      { ts: 'not-a-date', tool: 'relai_clear_files', workspace: 'a', cautionLevel: 'caution', cautionReason: 'bad ts' },
      { ts: isoMinusHours(1), tool: 'relai_clear_files', workspace: 'a', cautionLevel: 'caution', cautionReason: 'good' }
    ]);
    const r = cautionSummary(config, { windowHours: 24 });
    assert.equal(r.workspaces[0].count, 1);
    console.log('7. malformed ts ignored: OK');
  }
  
  // 8. Missing workspace alias goes to __unknown__
  {
    writeEntries([
      { ts: isoMinusHours(1), tool: 'relai_clear_files', cautionLevel: 'caution', cautionReason: 'no ws' }
    ]);
    const r = cautionSummary(config, { windowHours: 24 });
    assert.equal(r.workspaces[0].alias, '__unknown__');
    console.log('8. missing alias: OK');
  }
  
  // 9. windowHours custom
  {
    writeEntries([
      { ts: isoMinusHours(1), tool: 'relai_clear_files', workspace: 'a', cautionLevel: 'caution', cautionReason: 'r' },
      { ts: isoMinusHours(3), tool: 'relai_clear_files', workspace: 'a', cautionLevel: 'caution', cautionReason: 'r' }
    ]);
    const r = cautionSummary(config, { windowHours: 2 });
    assert.equal(r.workspaces[0].count, 1);
    console.log('9. custom window: OK');
  }
  
  // 10. generatedAt + windowHours echoed
  {
    const r = cautionSummary(config, { windowHours: 12 });
    assert.match(r.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(r.windowHours, 12);
    console.log('10. result shape: OK');
  }
  
  // Cleanup
  fs.rmSync(auditPath, { force: true });
  fs.rmSync(TMP, { recursive: true, force: true });
  
  console.log('caution-summary unit tests passed.');
}
await case_caution_summary_unit();

// Formerly caution-zone-unit.mjs
async function case_caution_zone_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/cautionZone.js");
    const { classifyCaution } = __m1;
  
  for (const toolName of ['relai_edit']) {
    const configFile = classifyCaution(toolName, { path: 'package.json' });
    assert.equal(configFile.level, 'caution');
    assert.equal(configFile.reason, 'workspace config path modified');
  
    const ignoreFile = classifyCaution(toolName, { path: '.relaiignore' });
    assert.equal(ignoreFile.level, 'caution');
  
    const workflowFile = classifyCaution(toolName, { path: String.raw`.github\workflows\ci.yml` });
    assert.equal(workflowFile.level, 'caution');
  
    const normalFile = classifyCaution(toolName, { path: 'src/example.js' });
    assert.equal(normalFile.level, null);
  }
  
  assert.equal(classifyCaution('relai_read', { paths: ['package.json'] }).level, null);
  assert.equal(classifyCaution('relai_validate', {}).level, null);
  assert.equal(classifyCaution('relai_exec', { command: 'npm install' }).level, null);
  assert.equal(classifyCaution('relai_exec', { command: 'git reset --hard HEAD~1' }).level, 'caution');
  assert.equal(classifyCaution('relai_exec', { command: 'docker system prune -f' }).level, 'caution');
  assert.equal(classifyCaution('removed_tool', { path: 'package.json' }).level, null);
  
  console.log('Caution-zone unit tests passed for active edit tools.');
}
await case_caution_zone_unit();

// Formerly color-token-staleness-unit.mjs
async function case_color_token_staleness_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:child_process");
    const { spawnSync } = __m1;
  
    const __m2 = await import("node:fs");
    const fs = __m2.default;
  
    const __m3 = await import("node:os");
    const os = __m3.default;
  
    const __m4 = await import("node:path");
    const path = __m4.default;
  
    const __m5 = await import("node:url");
    const { fileURLToPath } = __m5;
  
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const generator = path.join(root, 'scripts', 'generate-color-tokens.mjs');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-color-token-staleness-'));
  const generatedPaths = [
    'src/ui/styles/color-tokens.css',
    'electron/renderer/color-tokens.css',
    'docs/color-system-reference.svg'
  ];
  const originals = new Map();
  
  for (const relativePath of generatedPaths) {
    const source = path.join(root, relativePath);
    const target = path.join(tempRoot, relativePath);
    const original = fs.readFileSync(source, 'utf8');
    originals.set(relativePath, original);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, original, 'utf8');
  }
  
  function run(...args) {
    return spawnSync(process.execPath, [generator, ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, REL_AI_COLOR_OUTPUT_ROOT: tempRoot }
    });
  }
  
  try {
    assert.equal(run('--check').status, 0, 'fresh generated color assets must pass verification');
  
    const staleRelativePath = 'src/ui/styles/color-tokens.css';
    const stalePath = path.join(tempRoot, staleRelativePath);
    fs.writeFileSync(stalePath, `${originals.get(staleRelativePath)}\n/* intentional stale-asset probe */\n`, 'utf8');
    const stale = run('--check');
    assert.notEqual(stale.status, 0, 'stale generated color assets must fail verification');
    assert.match(`${stale.stdout}\n${stale.stderr}`, /src\/ui\/styles\/color-tokens\.css/);
  
    const regenerated = run();
    assert.equal(regenerated.status, 0, regenerated.stderr || regenerated.stdout);
    for (const relativePath of generatedPaths) {
      assert.equal(
        fs.readFileSync(path.join(tempRoot, relativePath), 'utf8'),
        originals.get(relativePath),
        `${relativePath} must be restored to the canonical generated content exactly`
      );
    }
    assert.equal(run('--check').status, 0, 'verification must pass after regeneration');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  
  console.log('Generated color-asset staleness detection and repair tests passed.');
}
await case_color_token_staleness_unit();

// Formerly connection-state-unit.mjs
async function case_connection_state_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/ui/connection-state.js");
    const { connectionLayerViews, connectionStateFor, connectionSummary, isMcpAuthenticationReady, withConnectionState } = __m1;
  
  const base = {
    connectionState: {
      localService: { status: 'running' },
      publicEndpoint: { status: 'available' },
      dashboardUpdates: { status: 'live' }
    }
  };
  
  const ready = connectionStateFor({
    ...base,
    mcpAuthentication: { status: 'bearer_authorized' },
    mcpConnection: { status: 'ready', activityStatus: 'no_requests' }
  });
  assert.equal(ready.chatgptReadiness.status, 'ready');
  assert.equal(ready.mcpClient.status, 'no_requests');
  assert.equal(isMcpAuthenticationReady(ready), true);
  assert.equal(connectionSummary(ready).label, 'Ready');
  assert.equal(connectionSummary(ready).message, 'This computer is connected and ready for ChatGPT.');
  const readyLayers = connectionLayerViews(ready);
  assert.equal(readyLayers.find(layer => layer.key === 'chatgptReadiness')?.label, 'Ready');
  assert.equal(readyLayers.find(layer => layer.key === 'mcpClient')?.label, 'Ready');
  
  const active = connectionStateFor({
    ...base,
    mcpConnection: { status: 'ready', activityStatus: 'active', activeRequestCount: 1, lastRequestMethod: 'tools/call' }
  });
  assert.equal(connectionSummary(active).label, 'Active now');
  assert.equal(connectionSummary(active).title, 'ChatGPT is using Rel.AI');
  assert.equal(connectionSummary(active).tone, 'working');
  
  const recent = connectionStateFor({
    ...base,
    mcpConnection: { status: 'ready', activityStatus: 'recent', lastRequestMethod: 'tools/list', lastSuccessfulRequestAt: '2026-08-01T04:00:00.000Z' }
  });
  assert.equal(connectionSummary(recent).label, 'Recently active');
  assert.equal(connectionSummary(recent).tone, 'ok');
  
  const failed = connectionStateFor({
    ...base,
    mcpConnection: { status: 'ready', activityStatus: 'request_failed', lastRequestMethod: 'tools/call' }
  });
  assert.equal(connectionSummary(failed).label, 'Last request failed');
  assert.equal(connectionSummary(failed).title, 'The last ChatGPT request failed');
  assert.doesNotMatch(connectionSummary(failed).message, /tools\//i);
  assert.match(connectionSummary(failed).message, /local Rel\.AI service and Secure MCP Tunnel are ready for another request/i);
  assert.match(connectionSummary(failed).message, /Restart Rel\.AI only if a connection layer has a problem/i);
  
  const legacyClientState = connectionStateFor({
    ...base,
    mcpConnection: { status: 'capability_mismatch' }
  });
  assert.equal(legacyClientState.mcpClient.status, 'no_requests');
  assert.equal(connectionSummary(legacyClientState).label, 'Ready');
  
  const unavailable = connectionStateFor({
    connectionState: {
      localService: { status: 'running' },
      publicEndpoint: { status: 'unavailable' },
      dashboardUpdates: { status: 'live' }
    },
    mcpConnection: { status: 'ready', activityStatus: 'no_requests' }
  });
  assert.equal(unavailable.chatgptReadiness.status, 'unavailable');
  assert.equal(isMcpAuthenticationReady(unavailable), false);
  assert.equal(connectionSummary(unavailable).label, 'Needs attention');
  assert.equal(connectionSummary(unavailable).title, 'ChatGPT connection unavailable');
  assert.doesNotMatch(connectionSummary(unavailable).message, /Tunnel ID|API key|MCP/i);

  const degradedAggregate = {
    localService: { status: 'running' },
    publicEndpoint: { status: 'degraded' },
    chatgptReadiness: { status: 'unavailable' },
    error: null
  };
  const availableAggregate = {
    ...degradedAggregate,
    publicEndpoint: { status: 'available', retryAttempt: 0, nextRetryAt: null },
    chatgptReadiness: { status: 'ready' }
  };
  const partiallyConnected = connectionStateFor({
    connectionState: { ...availableAggregate, dashboardUpdates: { status: 'live' } },
    desktopStatus: {
      serverRunning: true,
      connectionState: availableAggregate,
      tunnelId: 'tunnel_primary123',
      tunnelStatus: 'degraded',
      tunnelRetryAttempt: 2,
      tunnelNextRetryAt: '2026-10-04T02:00:00.000Z',
      additionalTunnelStatuses: [
        { tunnelId: 'tunnel_secondary123', label: 'Account 2', state: 'running' }
      ]
    },
    mcpConnection: { status: 'ready', activityStatus: 'no_requests' }
  });
  assert.equal(partiallyConnected.publicEndpoint.status, 'available', 'one healthy tunnel must keep the aggregate endpoint available');
  assert.equal(partiallyConnected.publicEndpoint.connectionCount, 2);
  assert.equal(partiallyConnected.publicEndpoint.availableCount, 1);
  assert.equal(partiallyConnected.publicEndpoint.reconnectingCount, 1);
  assert.equal(partiallyConnected.chatgptReadiness.status, 'ready', 'ChatGPT readiness must stay ready while any configured tunnel is connected');
  assert.equal(connectionSummary(partiallyConnected).label, 'Connected');
  assert.equal(connectionSummary(partiallyConnected).tone, 'warn');
  assert.match(connectionSummary(partiallyConnected).message, /1 of 2 configured tunnels/i);
  assert.match(connectionSummary(partiallyConnected).message, /1 tunnel is reconnecting/i);
  const partialTunnelLayer = connectionLayerViews(partiallyConnected).find(layer => layer.key === 'publicEndpoint');
  assert.equal(partialTunnelLayer?.title, 'Secure MCP tunnels');
  assert.equal(partialTunnelLayer?.label, '1 of 2 connected');
  
  // Bootstrap projection, successive desktop status events, and the shell's
  // reduced store must not count an aggregate endpoint as a healthy primary.
  const desktopProjection = connectionStateFor({
    ...base,
    desktopStatus: { connectionState: availableAggregate, tunnelId: 'primary', tunnelStatus: 'degraded', additionalTunnelStatuses: [{ state: 'running' }] }
  }, 'live');
  assert.equal(desktopProjection.publicEndpoint.availableCount, 1, 'fresh desktop primary state must override a stale HTTP endpoint');
  assert.equal(desktopProjection.publicEndpoint.reconnectingCount, 1);
  const shellProjection = connectionStateFor({ connectionState: desktopProjection });
  assert.deepEqual(shellProjection.publicEndpoint, desktopProjection.publicEndpoint, 'the shell must preserve the already projected tunnel counts');
  assert.equal(connectionSummary(shellProjection).tone, 'warn');
  assert.match(connectionSummary(shellProjection).message, /1 of 2 configured tunnels/);
  const allUnhealthy = connectionStateFor({
    connectionState: desktopProjection,
    desktopStatus: { connectionState: degradedAggregate, tunnelId: 'primary', tunnelStatus: 'degraded', additionalTunnelStatuses: [{ state: 'degraded' }] }
  }, 'live');
  assert.equal(allUnhealthy.publicEndpoint.status, 'degraded', 'the last healthy tunnel failing must clear aggregate availability');
  assert.equal(allUnhealthy.publicEndpoint.availableCount, 0);
  assert.equal(allUnhealthy.chatgptReadiness.status, 'unavailable');
  const primaryRecovered = connectionStateFor({
    connectionState: allUnhealthy,
    desktopStatus: { connectionState: availableAggregate, tunnelId: 'primary', tunnelStatus: 'running', additionalTunnelStatuses: [{ state: 'failed' }] }
  }, 'live');
  assert.equal(primaryRecovered.publicEndpoint.availableCount, 1);
  assert.equal(primaryRecovered.publicEndpoint.unavailableCount, 1);
  assert.equal(primaryRecovered.publicEndpoint.connectionCount, 2);
  assert.equal(connectionSummary(primaryRecovered).tone, 'warn');

  const desktopBootstrapSource = (await import('node:fs')).readFileSync(new URL('../public/dashboard.js', import.meta.url), 'utf8');
  const desktopUpdateSource = desktopBootstrapSource.match(/function applyDesktopStatus\(status\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(desktopUpdateSource, 'desktop status updates must remain routed through their actual store projection');
  let projectedStore = { connectionState: desktopProjection };
  const desktopUpdateContext = {
    withConnectionState, _liveState: 'live',
    getStore: () => projectedStore,
    patchLocalConnection: patch => { projectedStore = { ...projectedStore, ...patch }; },
    dashboardHidden: () => false,
    updateShell: () => {}
  };
  (await import('node:vm')).default.runInNewContext(desktopUpdateSource + '\n;globalThis.applyDesktopStatus = applyDesktopStatus;', desktopUpdateContext);
  desktopUpdateContext.applyDesktopStatus({ connectionState: degradedAggregate, tunnelId: 'primary', tunnelStatus: 'degraded', additionalTunnelStatuses: [{ state: 'degraded' }] });
  assert.equal(projectedStore.connectionState.publicEndpoint.status, 'degraded', 'the actual desktop store update must clear a formerly healthy aggregate');
  assert.equal(projectedStore.connectionState.publicEndpoint.availableCount, 0);
  desktopUpdateContext.applyDesktopStatus({ connectionState: availableAggregate, tunnelId: 'primary', tunnelStatus: 'running', additionalTunnelStatuses: [{ state: 'failed' }] });
  assert.equal(projectedStore.connectionState.publicEndpoint.availableCount, 1, 'the actual desktop update must also recover without counting stale aggregate state');

  assert.deepEqual(connectionLayerViews(recent).map(layer => layer.title), [
    'Local Rel.AI service',
    'OpenAI Secure MCP Tunnel',
    'Ready for ChatGPT',
    'ChatGPT requests',
    'Dashboard updates'
  ]);
  assert.equal(connectionLayerViews(recent).find(layer => layer.key === 'publicEndpoint')?.label, 'Connected');
  
  const startingLayers = connectionLayerViews({
    localService: { status: 'starting' },
    publicEndpoint: { status: 'connecting' },
    chatgptReadiness: { status: 'unavailable' },
    mcpClient: { status: 'starting' },
    dashboardUpdates: { status: 'reconnecting' }
  });
  for (const key of ['localService', 'publicEndpoint', 'mcpClient']) {
    assert.equal(startingLayers.find(layer => layer.key === key)?.tone, 'working', `${key} progress must use the information tone`);
  }
  
  console.log('Connection state reflects Secure MCP Tunnel readiness and stateless request activity.');
}
await case_connection_state_unit();

// Formerly dashboard-clock-unit.mjs
async function case_dashboard_clock_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/ui/clock.js");
    const { createDashboardClock, elapsedAt, parseClockTime } = __m1;
  
    const __m2 = await import("../src/ui/utils.js");
    const { formatDuration } = __m2;
  
  class FakeNode {
    constructor(attributes = {}) {
      this.attributes = new Map(Object.entries(attributes));
      this.textContent = '';
      this.isConnected = true;
    }
    hasAttribute(name) { return this.attributes.has(name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    matches() { return this.hasAttribute('data-clock-elapsed-start') || this.hasAttribute('data-clock-relative'); }
    querySelectorAll() { return []; }
  }
  
  class FakeDocument {
    constructor(nodes) {
      this.nodes = nodes;
      this.body = this;
      this.visibilityState = 'visible';
      this.listeners = new Map();
    }
    querySelectorAll() { this.queryCount = (this.queryCount || 0) + 1; return this.nodes.filter(node => node.matches()); }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    removeEventListener(name, listener) {
      if (this.listeners.get(name) === listener) this.listeners.delete(name);
    }
    emit(name) { this.listeners.get(name)?.(); }
  }

  let mutationObserver = null;
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; mutationObserver = this; }
    observe(target, options) { this.target = target; this.options = options; }
    disconnect() { this.disconnected = true; }
    emit(records) { this.callback(records); }
  }
  
  assert.equal(parseClockTime('2026-07-28T10:00:00.000Z'), Date.parse('2026-07-28T10:00:00.000Z'));
  assert.equal(elapsedAt('2026-07-28T10:00:00.000Z', '', Date.parse('2026-07-28T10:01:05.000Z')), '1m 5s');
  assert.equal(elapsedAt(1000, 2500, 5000), '2s');
  assert.equal(formatDuration((6 * 60 * 60 + 40 * 60 + 30) * 1000), '6h 40m', 'completed durations must use compact hour/minute formatting');
  assert.equal(formatDuration(45_000, { historical: true }), '<1m', 'historical durations under one minute must not show seconds');
  assert.equal(formatDuration((2 * 60 * 60 + 1 * 60 + 1) * 1000, { historical: true }), '2h 1m', 'historical durations must omit seconds');
  assert.equal(formatDuration((66 * 60 * 60 + 25 * 60 + 53) * 1000, { historical: true }), '2d 18h 25m', 'historical durations must use days instead of unbounded hours');
  assert.equal(elapsedAt(0, '', (1 * 60 * 60 + 2 * 60 + 3) * 1000), '1h 2m 3s', 'live elapsed durations keep seconds');
  const sessionsUi = await import('../src/ui/features/sessions/model.js');
  assert.equal(typeof sessionsUi.isOngoingSession, 'function', 'Sessions must expose its live-state predicate for regression coverage');
  assert.equal(sessionsUi.isOngoingSession({ status: 'inactive' }), false, 'inactive history must not use the live seconds clock');
  assert.equal(sessionsUi.isOngoingSession({ status: 'validation_failed' }), false, 'validation-failed history must not use the live seconds clock');
  assert.equal(sessionsUi.isOngoingSession({ status: 'running' }), true, 'active running sessions must keep the live seconds clock');
  
  let now = Date.parse('2026-07-28T10:00:05.000Z');
  let nextTimer = 0;
  const timers = new Map();
  const cleared = [];
  const elapsedNode = new FakeNode({ 'data-clock-elapsed-start': '2026-07-28T10:00:00.000Z' });
  const relativeNode = new FakeNode({ 'data-clock-relative': '2026-07-28T09:59:00.000Z' });
  const boundaryNode = new FakeNode({ 'data-clock-relative': '2026-07-28T09:59:06.000Z' });
  const roleNode = new FakeNode({ 'data-clock-elapsed-start': '2026-07-28T10:00:02.000Z' });
  const completedNode = new FakeNode({
    'data-clock-elapsed-start': '2026-07-28T09:00:00.000Z',
    'data-clock-elapsed-end': '2026-07-28T09:00:30.000Z'
  });
  const documentRef = new FakeDocument([elapsedNode, relativeNode, boundaryNode, roleNode, completedNode]);
  let ticks = 0;
  const clock = createDashboardClock({
    documentRef,
    windowRef: {},
    now: () => now,
    setIntervalFn(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearIntervalFn(id) {
      cleared.push(id);
      timers.delete(id);
    },
    MutationObserverRef: FakeMutationObserver,
    onTick() { ticks += 1; }
  });
  
  clock.start();
  assert.equal(clock.isRunning(), true);
  assert.equal(timers.size, 1, 'one shared interval must serve all time-sensitive nodes');
  assert.equal([...timers.values()][0].delay, 1000);
  assert.equal(elapsedNode.textContent, '5s');
  assert.equal(relativeNode.textContent, '1m ago');
  assert.equal(boundaryNode.textContent, 'now');
  assert.equal(roleNode.textContent, '3s');
  assert.equal(completedNode.textContent, '30s');
  assert.equal(mutationObserver?.options?.attributes, true, 'clock must observe clock-role attribute changes on reused React nodes');
  assert.deepEqual(mutationObserver?.options?.attributeFilter, ['data-clock-elapsed-start', 'data-clock-elapsed-end', 'data-clock-relative']);
  const queriesAfterStart = documentRef.queryCount;

  now = Date.parse('2026-07-28T10:00:07.000Z');
  [...timers.values()][0].callback();
  assert.equal(boundaryNode.textContent, '1m ago', 'relative labels must change at their own display boundary instead of an unrelated global minute tick');
  assert.equal(documentRef.queryCount, queriesAfterStart, 'relative refresh must update registered nodes without rescanning the document');
  const queriesAfterBoundary = documentRef.queryCount;

  const lateRelativeNode = new FakeNode({ 'data-clock-relative': '2026-07-28T09:55:00.000Z' });
  documentRef.nodes.push(lateRelativeNode);
  mutationObserver.emit([{ type: 'childList', target: documentRef, addedNodes: [lateRelativeNode] }]);
  now = Date.parse('2026-07-28T10:01:10.000Z');
  [...timers.values()][0].callback();
  assert.equal(elapsedNode.textContent, '1m 10s');
  assert.equal(relativeNode.textContent, '2m ago');
  relativeNode.textContent = '1m ago';
  now = Date.parse('2026-07-28T10:01:11.000Z');
  [...timers.values()][0].callback();
  assert.equal(relativeNode.textContent, '2m ago', 'shared clock ticks must repair a stale relative label even before the next minute boundary');
  assert.equal(lateRelativeNode.textContent, '6m ago', 'late-mounted task times must refresh without selecting a task');
  assert.equal(completedNode.textContent, '30s', 'completed durations must remain anchored to completion time');
  assert.equal(documentRef.queryCount, queriesAfterBoundary, 'clock must rely on registered nodes and mutation observation instead of periodic document rescans');

  roleNode.removeAttribute('data-clock-elapsed-start');
  roleNode.setAttribute('data-clock-relative', '2026-07-28T10:01:10.000Z');
  mutationObserver.emit([{ type: 'attributes', target: roleNode, addedNodes: [] }]);
  assert.equal(roleNode.textContent, 'now', 'a reused task node must switch immediately from elapsed time to relative time');
  now = Date.parse('2026-07-28T10:02:11.000Z');
  [...timers.values()][0].callback();
  assert.equal(roleNode.textContent, '1m ago', 'a reused task node must keep updating after its clock role changes');
  
  const ticksBeforeHidden = ticks;
  documentRef.visibilityState = 'hidden';
  documentRef.emit('visibilitychange');
  assert.equal(clock.isRunning(), false);
  assert.equal(timers.size, 0);
  assert.equal(cleared.length, 1);
  
  now = Date.parse('2026-07-28T10:03:10.000Z');
  documentRef.visibilityState = 'visible';
  documentRef.emit('visibilitychange');
  assert.equal(clock.isRunning(), true);
  assert.equal(elapsedNode.textContent, '3m 10s', 'resume must recompute from timestamps instead of increment counters');
  assert.ok(ticks > ticksBeforeHidden);
  assert.equal(timers.size, 1);
  
  clock.stop();
  assert.equal(clock.isRunning(), false);
  assert.equal(timers.size, 0);
  assert.equal(documentRef.listeners.has('visibilitychange'), false);

  now = Date.parse('2026-07-28T10:04:10.000Z');
  clock.start();
  assert.equal(clock.isRunning(), true, 'a stopped dashboard clock must restart after page restoration');
  assert.equal(timers.size, 1, 'restarting the dashboard clock must recreate exactly one shared interval');
  assert.equal(relativeNode.textContent, '5m ago', 'restart must immediately catch relative labels up to wall-clock time');
  clock.stop();
  
  console.log('Shared dashboard clock updates elapsed and relative time without backend events.');
}
await case_dashboard_clock_unit();

// Formerly dashboard-data-projection-unit.mjs
async function case_dashboard_data_projection_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/core/dashboard-data.ts");
    const { mergeDashboardActivity, summarizeDashboardTask } = __m1;
  
  const merged = mergeDashboardActivity({
    entries: [
      {
        id: 'persisted-event',
        timestamp: '2026-08-05T10:00:00.000Z',
        tool: 'relai_read',
        status: 'running',
        summary: 'Reading repository.',
        args: { token: 'must-not-leak' }
      },
      {
        id: 'persisted-event',
        timestamp: '2026-08-05T10:00:01.000Z',
        tool: 'relai_read',
        status: 'completed',
        summary: 'Repository read complete.',
        output: { secret: 'must-not-leak' }
      },
      {
        id: 'persisted-event',
        timestamp: '2026-08-05T10:00:01.500Z',
        tool: 'relai_read',
        status: 'completed',
        summary: '   ',
        message: ''
      }
    ]
  }, [{
    id: 'work-1',
    workspace: 'repo',
    events: [{
      operationId: 'operation-2',
      ts: '2026-08-05T10:00:02.000Z',
      tool: 'relai_validate',
      ok: false,
      error: { message: 'Validation failed.' }
    }]
  }], 20);
  
  assert.equal(merged.entries.length, 2, 'persisted event IDs must merge lifecycle updates');
  assert.deepEqual(merged.entries.map(entry => entry.eventId), ['persisted-event', 'operation-2']);
  assert.deepEqual(merged.entries.map(entry => entry.ts), [
    '2026-08-05T10:00:01.500Z',
    '2026-08-05T10:00:02.000Z'
  ]);
  assert.equal(merged.entries[0].status, 'completed');
  assert.equal(merged.entries[0].message, 'Repository read complete.');
  assert.equal(merged.entries[0].args, undefined);
  assert.equal(merged.entries[0].output, undefined);
  assert.equal(merged.entries[1].status, 'failed');
  assert.equal(merged.entries[1].workspace, 'repo');
  assert.equal(merged.entries[1].taskId, 'work-1');
  assert.equal(merged.entries[1].message, 'Validation failed.');
  
  const taskSummary = summarizeDashboardTask({
    id: 'work-summary',
    workspace: 'repo',
    status: 'running',
    events: [{ tool: 'relai_read', status: 'completed' }]
  });
  assert.equal(taskSummary.id, 'work-summary');
  assert.equal(Object.hasOwn(taskSummary, 'events'), false, 'dashboard task summaries must not carry retained event histories');
  
  console.log('Dashboard activity identity, timestamp, ordering, and safe projection passed.');
}
await case_dashboard_data_projection_unit();

// Formerly dashboard-event-batcher-unit.mjs
async function case_dashboard_event_batcher_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/core/dashboard-event-batcher.ts");
    const { createDashboardTaskEventBatcher } = __m1;
  
  const scheduled = [];
  const cleared = [];
  const batches = [];
  const batcher = createDashboardTaskEventBatcher({
    setTimer(callback) {
      const timer = { callback, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearTimer(timer) { cleared.push(timer); },
    onFlush(batch) { batches.push(batch); }
  });
  
  batcher.push({ taskId: 'task-a', phase: 'update', revision: 1, currentActivity: 'First' });
  batcher.push({ taskId: 'task-a', phase: 'update', revision: 2, currentActivity: 'Latest' });
  
  assert.equal(scheduled.length, 1, 'a pending batch must use one flush timer');
  assert.equal(batcher.pendingCount(), 1, 'same-task same-phase updates must coalesce');
  
  scheduled[0].callback();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].revision, 2, 'a coalesced batch must publish the newest revision');
  assert.deepEqual(batches[0].activities, [
    { taskId: 'task-a', phase: 'update', revision: 2, currentActivity: 'Latest' }
  ]);
  
  batcher.push({ taskId: 'task-a', phase: 'update', revision: 3, activityEvent: { eventId: 'event-1' } });
  batcher.push({ taskId: 'task-a', phase: 'update', revision: 4, activityEvent: { eventId: 'event-2' } });
  assert.equal(batcher.pendingCount(), 2, 'distinct activity events must not overwrite each other');
  assert.equal(batcher.flush(), true);
  assert.equal(batches.at(-1).revision, 4);
  assert.deepEqual(batches.at(-1).activities.map(item => item.activityEvent.eventId), ['event-1', 'event-2']);
  
  batcher.push({ taskId: 'task-b', phase: 'update', revision: 5 });
  assert.equal(batcher.pendingCount(), 1);
  batcher.close();
  assert.equal(batcher.pendingCount(), 0, 'closing the batcher must discard pending work');
  assert.ok(cleared.length >= 1, 'closing or flushing must clear the active timer');
  
  console.log('Dashboard task-event batching coalesces replaceable progress while preserving distinct events.');
}
await case_dashboard_event_batcher_unit();

// Formerly dashboard-health-status-unit.mjs
async function case_dashboard_health_status_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:path");
    const path = __m2.default;
  
    const __m3 = await import("node:url");
    const { fileURLToPath } = __m3;
  
    const __m4 = await import("../src/ui/status-tone.js");
    const { statusPillClass } = __m4;
  
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sessionsReact = fs.readFileSync(path.join(root, 'src/ui/features/sessions/react.js'), 'utf8');
  const dashboard = fs.readFileSync(path.join(root, 'public/dashboard.js'), 'utf8');
  
  assert.equal(statusPillClass('succeeded'), 'ok', 'succeeded must use the canonical success pill class');
  assert.match(
    sessionsReact,
    /const pillClass = state\?\.pillClass \|\| statusPillClass\(status\)/,
    'task activity pills must fall back to the canonical status class when a caller does not provide one'
  );
  assert.match(
    dashboard,
    /_routerReady && _liveState === 'live'[\s\S]{0,180}request timed out[\s\S]{0,80}return data/,
    'a dashboard snapshot timeout must not report Rel.AI as disconnected while the live event stream is healthy'
  );
  
  console.log('Dashboard health and status presentation regressions passed.');
}
await case_dashboard_health_status_unit();

// Formerly dashboard-react-store-unit.mjs
async function case_dashboard_react_store_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/ui/store.js");
    const { applyLiveEvent, getSnapshot, init, patchLocalConnection, subscribe } = __m1;
  
  init({
    ok: true,
    desktopStatus: { state: 'starting' },
    connectionState: { overall: 'connecting' },
    live: { streamId: 'stream-a', revisions: { task: 2, connection: 1 } },
    taskActivity: { tasks: [], activeTaskCount: 0, activeCalls: 0 },
    config: { workspaces: [{ alias: 'alpha', operational: { state: 'idle' } }] },
    workspaceStates: { alpha: { state: 'idle' } }
  });
  
  let notifications = 0;
  const unsubscribe = subscribe(() => { notifications += 1; });
  const initialSnapshot = getSnapshot();
  
  const stale = applyLiveEvent('task.updated', {
    streamId: 'stream-a',
    revision: 2,
    taskUpdates: [{ id: 'stale', status: 'running' }]
  });
  assert.equal(stale.accepted, false);
  assert.equal(getSnapshot(), initialSnapshot, 'rejected events must retain snapshot identity');
  assert.equal(notifications, 0, 'rejected events must not notify React subscribers');
  
  const foreign = applyLiveEvent('task.updated', {
    streamId: 'stream-b',
    revision: 3,
    taskUpdates: [{ id: 'foreign', status: 'running' }]
  });
  assert.equal(foreign.accepted, false);
  assert.equal(getSnapshot(), initialSnapshot, 'foreign streams must retain snapshot identity');
  assert.equal(notifications, 0);
  
  const accepted = applyLiveEvent('task.updated', {
    streamId: 'stream-a',
    revision: 3,
    taskUpdates: [{ id: 'task-1', workspace: 'alpha', status: 'running', activeCalls: 1, updatedAt: '2026-09-06T00:00:00Z' }]
  });
  assert.equal(accepted.accepted, true);
  assert.notEqual(getSnapshot(), initialSnapshot, 'accepted events must publish a new snapshot identity');
  assert.equal(notifications, 1);
  assert.equal(getSnapshot().live.revisions.task, 3);
  assert.equal(initialSnapshot.live.revisions.task, 2, 'previous snapshot metadata must remain unchanged');
  assert.equal(initialSnapshot.taskActivity.tasks.length, 0, 'previous nested task state must not be mutated');
  
  const acceptedSnapshot = getSnapshot();
  patchLocalConnection({ desktopStatus: acceptedSnapshot.desktopStatus });
  assert.equal(getSnapshot(), acceptedSnapshot, 'a local no-op must retain snapshot identity');
  assert.equal(notifications, 1, 'a local no-op must not notify subscribers');
  
  patchLocalConnection({ connectionState: { overall: 'available' } });
  assert.notEqual(getSnapshot(), acceptedSnapshot);
  assert.equal(notifications, 2, 'accepted local mutations must notify subscribers');
  
  unsubscribe();
  patchLocalConnection({ connectionState: { overall: 'live' } });
  assert.equal(notifications, 2, 'unsubscribe must stop notifications');
  
  console.log('Dashboard React store subscription contracts passed.');
}
await case_dashboard_react_store_unit();

// Formerly dashboard-snapshot-order-unit.mjs
async function case_dashboard_snapshot_order_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/ui/store.js");
    const { applyLiveEvent, getSnapshot, init, patchLocalConnection } = __m1;
  
  init({
    ok: true,
    tasks: [],
    managedProcesses: [],
    config: { workspaces: [{ alias: 'app', operational: null }] },
    live: { streamId: 'stream-a', revisions: { task: 1, connection: 1, workspace: 1, process: 1 } }
  });
  
  assert.equal(applyLiveEvent('task.updated', {
    streamId: 'stream-a', revision: 2,
    taskActivity: { state: 'working', activeTaskCount: 1, tasks: [{ id: 'task-1', workspace: 'app', state: 'working' }] },
    taskUpdates: [{ id: 'task-1', workspace: 'app', updatedAt: '2026-08-15T00:00:00.000Z' }],
    activityEntries: [{ eventId: 'event-1', ts: '2026-08-15T00:00:00.000Z', message: 'Started' }]
  }).accepted, true);
  assert.equal(getSnapshot().tasks[0].id, 'task-1');
  assert.equal(getSnapshot().auditTail.entries[0].eventId, 'event-1');
  assert.equal(getSnapshot().workspaceStates.app.currentActivity.taskId, 'task-1');
  assert.equal(getSnapshot().live.revisions.task, 2);
  
  assert.equal(applyLiveEvent('task.updated', {
    streamId: 'stream-a', revision: 2, tasks: [{ id: 'stale' }]
  }).accepted, false, 'duplicate domain revisions are idempotent');
  assert.equal(getSnapshot().tasks[0].id, 'task-1');
  
  assert.equal(applyLiveEvent('connection.updated', {
    streamId: 'stream-a', revision: 3, connectionState: { status: 'ready' }
  }).accepted, true);
  assert.equal(getSnapshot().connectionState.status, 'ready');
  assert.equal(getSnapshot().live.revisions.connection, 3);
  assert.equal(getSnapshot().live.revisions.task, 2, 'domain revisions advance independently');
  
  assert.equal(applyLiveEvent('workspace.updated', {
    streamId: 'stream-a', revision: 2, alias: 'app', state: { status: 'dirty' }
  }).accepted, true);
  assert.equal(getSnapshot().workspaceStates.app.status, 'dirty');
  assert.equal(getSnapshot().config.workspaces[0].operational.status, 'dirty');
  
  assert.equal(applyLiveEvent('process.updated', {
    streamId: 'stream-a', revision: 4, managedProcesses: [{ processId: 'proc-1' }]
  }).accepted, true);
  assert.equal(getSnapshot().managedProcesses[0].processId, 'proc-1');
  
  assert.equal(applyLiveEvent('task.updated', {
    streamId: 'stream-b', revision: 99, tasks: [{ id: 'wrong-stream' }]
  }).accepted, false, 'events from a different live stream must not mutate the current store');
  
  patchLocalConnection({ desktopStatus: { serverRunning: true }, connectionState: { status: 'ready' } });
  assert.equal(getSnapshot().tasks[0].id, 'task-1', 'desktop-only state patches must not replace task state');
  
  init({
    ok: true,
    tasks: [{ id: 'refresh-2' }],
    live: { streamId: 'stream-b', revisions: { task: 5, connection: 2, workspace: 1, process: 0, diagnostics: 3 } }
  });
  assert.equal(getSnapshot().tasks[0].id, 'refresh-2', 'an authoritative aggregate refresh establishes the new stream atomically');
  assert.equal(getSnapshot().live.streamId, 'stream-b');
  assert.equal(getSnapshot().live.revisions.task, 5);
  assert.equal(getSnapshot().live.revisions.diagnostics, 3);
  
  console.log('Dashboard typed domain revisions reject stale and cross-stream deltas.');
}
await case_dashboard_snapshot_order_unit();

// Formerly toast-unit.mjs
async function case_toast_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
  const { toast } = await import(new URL('../src/ui/components/toast.js', import.meta.url));
  const {
    getOverlaySnapshot,
    removeToastOverlay,
    subscribeOverlay
  } = await import(new URL('../src/ui/overlay-store.js', import.meta.url));
  
  let notifications = 0;
  const unsubscribe = subscribeOverlay(() => { notifications += 1; });
  
  try {
    const first = toast('Saved', { variant: 'success', duration: 100 });
    let snapshot = getOverlaySnapshot();
    assert.equal(snapshot.toasts.length, 1, 'a toast must publish one canonical overlay descriptor');
    assert.equal(snapshot.toasts[0].id, first);
    assert.equal(snapshot.toasts[0].tone, 'success');
    assert.equal(snapshot.toasts[0].role, 'status');
    assert.equal(snapshot.toasts[0].ariaLabel, 'Success: Saved');
    assert.equal(snapshot.toasts[0].dismissLabel, 'Dismiss success notification');
    assert.equal(snapshot.toasts[0].duration, 100);
    assert.equal(snapshot.toasts[0].revision, 0);
  
    const second = toast('Saved', { variant: 'success', duration: 100 });
    snapshot = getOverlaySnapshot();
    assert.equal(second, first, 'identical active notifications should be coalesced');
    assert.equal(snapshot.toasts.length, 1, 'coalescing must not add another overlay descriptor');
    assert.equal(snapshot.toasts[0].revision, 1, 'coalescing must refresh the existing toast descriptor');
  
    const persistent = toast('Connection failed', { variant: 'error' });
    snapshot = getOverlaySnapshot();
    const persistentDescriptor = snapshot.toasts.find(item => item.id === persistent);
    assert.ok(persistentDescriptor, 'persistent errors must be present in overlay state');
    assert.equal(persistentDescriptor.role, 'alert');
    assert.equal(persistentDescriptor.duration, 0, 'error notifications must remain until dismissed by default');
  
    const duplicateError = toast('Connection failed', { variant: 'error' });
    snapshot = getOverlaySnapshot();
    assert.equal(duplicateError, persistent, 'repeated persistent errors should not stack');
    assert.equal(snapshot.toasts.filter(item => item.id === persistent).length, 1);
  
    assert.equal(removeToastOverlay(persistent), true, 'manual dismissal must remove a persistent error');
    assert.equal(getOverlaySnapshot().toasts.some(item => item.id === persistent), false);
    assert.equal(removeToastOverlay(persistent), false, 'dismissing an already removed toast must be a no-op');
  
    const afterDismiss = toast('Connection failed', { variant: 'error' });
    assert.notEqual(afterDismiss, persistent, 'a dismissed notification may be shown again later');
    assert.ok(notifications >= 6, 'toast mutations must notify overlay subscribers');
  
    console.log('Toast overlay behavior passed.');
  } finally {
    unsubscribe();
  }
}
await case_toast_unit();


async function case_update_modal_lifecycle() {
  const { default: assert } = await import('node:assert/strict');
  const { initUpdateAvailableModal } = await import('../src/ui/update-available-modal.js');
  const { closeModal } = await import('../src/ui/components/modal.js');
  const { getOverlaySnapshot } = await import('../src/ui/overlay-store.js');
  const originalDocument = globalThis.document;
  let listener;
  let installs = 0;
  const version = '1.2.0';
  globalThis.document = { activeElement: null, querySelector: () => null };
  const cleanup = initUpdateAvailableModal({
    bridge: {
      getUpdateStatus: async () => ({ state: 'available', availableVersion: version }),
      onUpdateStatus: callback => { listener = callback; return () => { listener = null; }; },
      installUpdate: async () => {
        installs += 1;
        return { ok: true, status: { state: 'installing', availableVersion: version } };
      }
    }
  });
  try {
    await Promise.resolve();
    const available = getOverlaySnapshot().modal;
    assert.equal(available.title, 'Update available');
    listener({ state: 'installing', availableVersion: version });
    const installing = getOverlaySnapshot().modal;
    assert.equal(installing.dismissEnabled, false, 'installing cannot be dismissed');
    assert.equal(installing.showClose, false);
    listener({ state: 'installing', availableVersion: version });
    assert.equal(getOverlaySnapshot().modal.id, installing.id, 'repeated installing updates must retain overlay ownership');

    listener({ state: 'downloaded', availableVersion: version, error: 'Fixture preparation failed' });
    const failed = getOverlaySnapshot().modal;
    assert.equal(failed.dismissEnabled, true, 'failed preparation must restore dismissal');
    listener({ state: 'downloaded', availableVersion: version, error: 'Retry is available' });
    assert.equal(getOverlaySnapshot().modal.id, failed.id, 'failure details must update the existing overlay');
    getOverlaySnapshot().modal.content.props.onAction({ method: 'installUpdate' });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(installs, 1);
    const retry = getOverlaySnapshot().modal;
    assert.equal(retry.dismissEnabled, false, 'retry must restore the blocking installing state');
    listener({ state: 'installing', availableVersion: version });
    assert.equal(getOverlaySnapshot().modal.id, retry.id, 'retry status updates must not reopen the overlay');

    listener({ state: 'downloaded', availableVersion: version, error: 'Fixture preparation failed again' });
    await getOverlaySnapshot().modal.onDismiss();
    assert.equal(getOverlaySnapshot().modal, null, 'failure close must settle the owned overlay');
    listener({ state: 'up_to_date', availableVersion: '' });
    assert.equal(getOverlaySnapshot().modal, null);
  } finally {
    cleanup();
    closeModal();
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
}
await case_update_modal_lifecycle();

// Formerly ui-list-ordering-unit.mjs
async function case_ui_list_ordering_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/ui/features/tools/index.js");
    const { orderToolsForCatalog } = __m1;
  
    const __m2 = await import("../src/ui/features/sessions/model.js");
    const { orderChangedFiles, orderSessionsForDisplay } = __m2;
  
    const __m3 = await import("../src/ui/features/sessions/model.js");
    const { mergeSessionEvents } = __m3;
  
    const __m4 = await import("../src/ui/utils.js");
    const { timeAgo } = __m4;
  
    const __m5 = await import("../src/ui/components/workspace-menu.js");
    const { orderWorkspacesAlphabetically } = __m5;
  
    const __m6 = await import("../src/ui/features/home/index.js");
    const { orderOverviewTasks, orderOverviewWorkspaces } = __m6;
  
    const __m7 = await import("../src/ui/features/activity/model.js");
    const { sortActivityEntries: orderActivityEntries } = __m7;
  
    const __m8 = await import("../src/productUx.js");
    const { cautionSummary } = __m8;
  
  const orderedTools = orderToolsForCatalog([
    { name: 'relai_publish', title: 'Publish', capabilities: ['git'] },
    { name: 'relai_changes', title: 'Changes', capabilities: ['review', 'recover'] },
    { name: 'relai_validate', title: 'Validate', capabilities: ['validate'] },
    { name: 'relai_process', title: 'Processes', capabilities: ['execute'] },
    { name: 'relai_edit', title: 'Edit', capabilities: ['edit'] },
    { name: 'relai_read', title: 'Read', capabilities: ['inspect'] },
    { name: 'relai_inspect', title: 'Inspect', capabilities: ['inspect'] },
    { name: 'relai_work', title: 'Work', capabilities: ['workflow'] }
  ]);
  assert.deepEqual(orderedTools.map(tool => tool.name), [
    'relai_inspect',
    'relai_read',
    'relai_edit',
    'relai_process',
    'relai_work',
    'relai_changes',
    'relai_validate',
    'relai_publish'
  ]);
  
  const sessions = [
    { id: 'older', endedAt: '2026-07-25T10:00:00.000Z' },
    { id: 'invalid', endedAt: 'not-a-date' },
    { id: 'newer', completedAt: '2026-07-25T12:00:00.000Z' }
  ];
  assert.deepEqual(orderSessionsForDisplay(sessions).map(session => session.id), ['newer', 'older', 'invalid']);
  assert.deepEqual(orderSessionsForDisplay([
    { id: 'completed-newest', status: 'completed', completedAt: '2026-07-25T12:04:00.000Z' },
    { id: 'waiting-newer', status: 'waiting', lastActivityAt: '2026-07-25T12:02:00.000Z' },
    { id: 'working-older', status: 'working', state: 'working', activeCalls: 1, startedAt: '2026-07-25T11:59:00.000Z', lastActivityAt: '2026-07-25T12:01:00.000Z' },
    { id: 'failed-middle', status: 'failed', endedAt: '2026-07-25T12:03:00.000Z' },
    { id: 'inactive-oldest', status: 'inactive', endedAt: '2026-07-25T12:00:00.000Z' }
  ]).map(session => session.id), [
    'waiting-newer',
    'working-older',
    'completed-newest',
    'failed-middle',
    'inactive-oldest'
  ]);
  const stableOngoing = [
    { id: 'first-open', status: 'planning', state: 'waiting', activeCalls: 0, startedAt: '2026-07-25T10:00:00.000Z', updatedAt: '2026-07-25T10:05:00.000Z' },
    { id: 'second-working', status: 'working', state: 'working', activeCalls: 1, startedAt: '2026-07-25T10:01:00.000Z', updatedAt: '2026-07-25T10:02:00.000Z' }
  ];
  assert.deepEqual(orderSessionsForDisplay(stableOngoing).map(session => session.id), ['second-working', 'first-open']);
  stableOngoing[1].updatedAt = '2026-07-25T10:10:00.000Z';
  assert.deepEqual(orderSessionsForDisplay(stableOngoing).map(session => session.id), ['second-working', 'first-open'], 'ongoing task activity must not reorder rows after their start time is established');
  assert.deepEqual(orderSessionsForDisplay([
    { id: 'completed', status: 'completed', completedAt: '2026-07-25T12:03:00.000Z' },
    { id: 'cancelled', status: 'cancelled', cancelledAt: '2026-07-25T12:05:00.000Z' },
    { id: 'inactive', status: 'inactive', inactiveAt: '2026-07-25T12:04:00.000Z', endedAt: '2026-07-25T11:00:00.000Z' }
  ]).map(session => session.id), ['cancelled', 'inactive', 'completed'], 'inactive rows must sort by the same inactivity timestamp shown in the list even if stale terminal timestamps remain');
  assert.equal(timeAgo(Date.parse('2026-07-25T12:00:00.000Z'), Date.parse('2026-07-25T12:05:00.000Z')), '5m ago', 'relative time must support numeric epoch timestamps used by historical task records');
  
  const mergedSessionEvents = mergeSessionEvents([
    {
      eventId: 'operation-1',
      operationId: 'operation-1',
      timestamp: '2026-07-25T12:00:00.000Z',
      tool: { name: 'relai_exec', invocationId: 'operation-1' },
      status: 'running',
      summary: 'Running command.'
    }
  ], [
    {
      id: 'operation-1',
      operationId: 'operation-1',
      ts: '2026-07-25T12:00:01.000Z',
      tool: 'relai_exec',
      status: 'succeeded',
      summary: 'Command completed.'
    },
    {
      id: 'operation-2',
      operationId: 'operation-2',
      ts: '2026-07-25T12:00:02.000Z',
      tool: 'relai_exec',
      status: 'succeeded',
      summary: 'Second command completed.'
    }
  ]);
  assert.equal(mergedSessionEvents.length, 2, 'live audit projections must update an existing operation instead of duplicating it');
  assert.equal(mergedSessionEvents.find(event => event.operationId === 'operation-1')?.status, 'succeeded');
  assert.equal(mergedSessionEvents.find(event => event.operationId === 'operation-1')?.summary, 'Command completed.');
  assert.deepEqual(orderOverviewTasks(sessions).map(session => session.id), ['newer', 'older', 'invalid']);
  assert.deepEqual(orderActivityEntries([
    { id: 'older', ts: '2026-07-25T10:00:00.000Z' },
    { id: 'invalid', ts: 'not-a-date' },
    { id: 'newer', ts: '2026-07-25T12:00:00.000Z' }
  ]).map(entry => entry.id), ['newer', 'older', 'invalid']);
  
  assert.deepEqual(orderChangedFiles([
    'src/zeta.js',
    'src/file10.js',
    'src/file2.js',
    'src/zeta.js',
    ''
  ]), ['src/file2.js', 'src/file10.js', 'src/zeta.js']);
  
  const workspaces = [{ alias: 'zeta' }, { alias: 'Alpha' }, { alias: 'repo10' }, { alias: 'repo2' }];
  const expectedAliases = ['Alpha', 'repo2', 'repo10', 'zeta'];
  assert.deepEqual(orderWorkspacesAlphabetically(workspaces).map(item => item.alias), expectedAliases);
  assert.deepEqual(orderOverviewWorkspaces(workspaces).map(item => item.alias), expectedAliases);
  
  const now = new Date().toISOString();
  const caution = cautionSummary({}, {
    entries: [
      { ts: now, cautionLevel: 'caution', workspace: 'zeta', tool: 'relai_edit' },
      { ts: now, cautionLevel: 'caution', workspace: 'Alpha', tool: 'relai_edit' }
    ]
  });
  assert.deepEqual(caution.workspaces.map(item => item.alias), ['Alpha', 'zeta']);
  
  console.log('UI list ordering tests passed.');
}
await case_ui_list_ordering_unit();

// Extension source mutations must invalidate the normal route's cached snapshot.
async function case_extension_source_cache_unit() {
  const assert = (await import('node:assert/strict')).default;
  const fs = (await import('node:fs')).default;
  const vm = (await import('node:vm')).default;
  const source = fs.readFileSync(new URL('../src/ui/features/extensions/react.js', import.meta.url), 'utf8');
  for (const action of ['add_source', 'remove_source']) {
    const before = { ok: true, installed: [], catalog: [], sources: [{ id: 'existing' }] };
    const after = { ...before, sources: action === 'add_source' ? [{ id: 'existing' }, { id: 'new' }] : [] };
    const cache = new Map([['/api/extensions', before]]);
    const requests = [];
    let stateIndex = 0;
    const fetchJson = async (url, options = {}) => {
      requests.push({ url, options });
      if (options.cache !== 'no-store' && cache.has(url)) return cache.get(url);
      if (options.cache !== 'no-store') cache.set(url, after);
      return after;
    };
    const context = {
      React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
      useState: initial => [stateIndex++ === 0 ? 'sources' : stateIndex === 2 ? before : initial, () => {}],
      useMemo: compute => compute(),
      useEffect: () => {},
      fetchJson,
      postJson: async (_url, body) => { assert.equal(body.action, action); return { ok: true, source: {}, installedExtensions: [] }; },
      invalidateCache: url => cache.delete(url),
      confirmAction: async () => true,
      toast: () => {},
      Icon: () => null
    };
    vm.runInNewContext(source.replace(/^import .*;\n/gm, '').replace(/^export \{.*\};$/m, '')
      + '\nglobalThis.renderExtensions = createExtensionsRoute();', context);
    const tree = context.renderExtensions();
    const flatten = node => node == null ? [] : Array.isArray(node) ? node.flatMap(flatten)
      : [node, ...(typeof node === 'object' ? (node.children || []).flatMap(flatten) : [])];
    const panel = flatten(tree).find(node => typeof node?.props?.onAddSource === 'function');
    assert.ok(panel, 'the Sources tab must expose its action callbacks');
    if (action === 'add_source') await panel.props.onAddSource('https://example.test/catalog.json');
    else await panel.props.onRemoveSource({ id: 'existing', name: 'Existing source' });
    assert.ok(requests.some(request => request.url === '/api/extensions?refresh=1'));
    const remounted = await fetchJson('/api/extensions', { cacheTtlMs: 15_000 });
    assert.equal(remounted, after, `${action} must not resurrect the stale base-route cache after navigating away and back`);
  }
  console.log('Extension source mutation cache tests passed.');
}
await case_extension_source_cache_unit();

async function case_browser_permission_origin_unit() {
  const assert = (await import('node:assert/strict')).default;
  const fs = (await import('node:fs')).default;
  const vm = (await import('node:vm')).default;
  const source = fs.readFileSync(new URL('../src/ui/features/browser/react.js', import.meta.url), 'utf8');
  for (const knownSession of [true, false]) {
    const responses = [];
    const controlChanges = [];
    const state = {
      active: true, control: 'ai', url: 'https://same.example.test/front', nativeSessionId: 'foreground', tabs: [],
      sessions: [
        { nativeSessionId: 'foreground', title: 'Same site', url: 'https://same.example.test/front', active: true },
        { nativeSessionId: 'background', title: 'Same site', url: 'https://same.example.test/back', active: false }
      ],
      permissionRequests: [{ requestId: 'background-permission', nativeSessionId: knownSession ? 'background' : 'gone', origin: 'https://same.example.test', permission: 'geolocation' }]
    };
    let stateIndex = 0;
    const context = {
      React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
      window: { relaiDesktop: { browser: {
        respondPermission: async (id, allow) => { responses.push({ id, allow }); },
        selectSession: id => controlChanges.push(id),
        setControl: mode => controlChanges.push(mode)
      } } },
      useState: initial => [stateIndex++ === 0 ? state : typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect: () => {}, useCallback: callback => callback, useRef: initial => ({ current: initial }),
      Icon: () => null, StatusPill: () => null, URL
    };
    vm.runInNewContext(source.replace(/^import .*;\n/gm, '').replace(/^export \{.*\};$/m, '')
      + '\nglobalThis.renderBrowser = createBrowserRoute();', context);
    const tree = context.renderBrowser();
    const flatten = node => node == null ? [] : Array.isArray(node) ? node.flatMap(flatten)
      : [node, ...(typeof node === 'object' ? (node.children || []).flatMap(flatten) : [])];
    const nodes = flatten(tree);
    const prompt = nodes.find(node => node?.props?.id === 'browserPermissionRequest');
    assert.ok(prompt, 'a permission prompt must expose its session and origin as an accessible description');
    const promptText = prompt.children.join('');
    assert.match(promptText, /https:\/\/same\.example\.test/);
    assert.match(promptText, knownSession ? /Session 2 · Same site/ : /Unknown browser session/);
    const buttons = nodes.filter(node => node?.type === 'button' && node.props['aria-describedby'] === 'browserPermissionRequest');
    assert.equal(buttons.length, 2, 'both permission decisions must describe their originating session');
    buttons.find(node => node.children.includes('Allow for this session')).props.onClick();
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    assert.equal(responses[0]?.id, 'background-permission');
    assert.equal(responses[0]?.allow, true);
    assert.deepEqual(controlChanges, [], 'responding to a background prompt must not change the visible session or control owner');
  }
  console.log('Browser permission origin labels and request routing passed.');
}
await case_browser_permission_origin_unit();

async function case_pulse_load_recovery_unit() {
  const assert = (await import('node:assert/strict')).default;
  const fs = (await import('node:fs')).default;
  const vm = (await import('node:vm')).default;
  const source = fs.readFileSync(new URL('../src/ui/features/settings/react.js', import.meta.url), 'utf8');
  const component = source.slice(source.indexOf('function PulsePreference()'), source.indexOf('function PrivacyDataPage'));
  const messageHelper = source.match(/function messageOf\(error\) \{[^\n]+\}/)?.[0];
  assert.ok(messageHelper);
  for (const failure of [new Error('Fixture lifecycle status unavailable'), 'Fixture string rejection', null, new Error('')]) {
    const slots = [];
    const pending = [];
    let cursor = 0;
    let attempts = 0;
    const desktop = {
      async getLifecycleStatus() {
        attempts += 1;
        if (attempts === 1) throw failure;
        return { pulseEnabled: false };
      },
      async setAppPreferences() { throw new Error('Loading a preference must not mutate it.'); }
    };
    const context = {
      React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
      window: { relaiDesktop: desktop }, Card: () => null, ToggleRow: () => null,
      Error, toast: () => {},
      useState(initial) {
        const index = cursor++;
        slots[index] ||= { value: initial };
        return [slots[index].value, next => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }];
      },
      useEffect(effect, dependencies) {
        const index = cursor++;
        const previous = slots[index];
        if (previous && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
        pending.push(() => { previous?.cleanup?.(); slots[index] = { dependencies, cleanup: effect() }; });
      }
    };
    vm.runInNewContext('const h = React.createElement;\n' + component + '\n' + messageHelper + '\nglobalThis.renderPulse = PulsePreference;', context);
    const render = () => {
      cursor = 0;
      const tree = context.renderPulse();
      while (pending.length) pending.shift()();
      return tree;
    };
    const flatten = node => node == null ? [] : Array.isArray(node) ? node.flatMap(flatten)
      : [node, ...(typeof node === 'object' ? (node.children || []).flatMap(flatten) : [])];
    render();
    await new Promise(resolve => setImmediate(resolve));
    const failed = flatten(render());
    assert.ok(failed.some(node => node?.props?.role === 'alert'), 'a failed Pulse preference read must be announced as an error, not permanent loading');
    const expectedMessage = failure instanceof Error ? (failure.message || 'Pulse preference is unavailable.') : String(failure || 'The action failed.');
    assert.ok(failed.some(node => typeof node === 'string' && node.includes(expectedMessage)), 'every rejection shape must produce a nonempty actionable error');
    const retry = failed.find(node => node?.type === 'button' && node.children.includes('Try again'));
    assert.ok(retry, 'Pulse preference read failures must offer a retry');
    retry.props.onClick();
    render();
    await new Promise(resolve => setImmediate(resolve));
    const recovered = flatten(render());
    assert.equal(attempts, 2);
    assert.ok(recovered.some(node => node?.props?.label === 'Show Rel.AI Pulse' && node.props.checked === false), 'a successful retry must show the actual saved disabled preference');
    assert.equal(recovered.some(node => node?.props?.role === 'alert'), false);
    slots.forEach(slot => slot?.cleanup?.());
  }
  console.log('Pulse preference loading failure and retry recovery passed.');
}
await case_pulse_load_recovery_unit();
