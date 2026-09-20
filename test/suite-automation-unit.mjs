// Consolidated automation coverage.
// Pure and self-contained checks share one process; tests requiring process/global isolation remain standalone.
// Add related regression checks here instead of creating another one-off test file.

// Formerly computer-manager-unit.mjs
async function case_computer_manager_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("sharp");
    const sharp = __m1.default;
  
    const __m2 = await import("../src/computerManager.js");
    const { readComputerStatus, runComputerAction } = __m2;
  
    const __m3 = await import("../src/tools/actionCatalog.js");
    const { getToolActionCatalog } = __m3;
  
    const __m4 = await import("../src/tools/errors.js");
    const { serializeToolError } = __m4;
  
  const workspace = { alias: 'repo' };
  const enabledConfig = { computerControl: { enabled: true } };
  const disabledConfig = { computerControl: { enabled: false } };
  const calls = [];
  const MAX_TYPE_TEXT_BYTES = 64 * 1024;
  const APP = 'notes';
  
  const adapter = {
    engine: '@midscene/computer',
    environment: async () => ({ available: true, platform: process.platform, displays: 2 }),
    listDisplays: async () => [
      { id: 'display-side', name: 'Side', primary: false, coordinateSpace: 'display-local-pixels' },
      { id: 'display-main', name: 'Main', primary: true, coordinateSpace: 'display-local-pixels' }
    ],
    size: async displayId => displayId === 'display-side' ? { width: 1280, height: 1024 } : { width: 1920, height: 1080 },
    screenshot: async displayId => ({
      mimeType: 'image/png', data: Buffer.from(`shot:${displayId || 'primary'}`).toString('base64'),
      bytes: 10, width: displayId === 'display-side' ? 1280 : 1920, height: displayId === 'display-side' ? 1024 : 1080
    }),
    move: async (displayId, point) => calls.push(['move', displayId, point]),
    click: async (displayId, point) => calls.push(['click', displayId, point]),
    doubleClick: async (displayId, point) => calls.push(['doubleClick', displayId, point]),
    rightClick: async (displayId, point) => calls.push(['rightClick', displayId, point]),
    drag: async (displayId, from, to) => calls.push(['drag', displayId, from, to]),
    scroll: async (displayId, param) => calls.push(['scroll', displayId, param]),
    typeText: async text => calls.push(['typeText', text]),
    pressKey: async key => calls.push(['pressKey', key])
  };
  const contextA = { computerAdapter: adapter, conversationId: 'computer-session-a', principal: 'principal-a' };
  const contextB = { computerAdapter: adapter, conversationId: 'computer-session-b', principal: 'principal-a' };
  
  const disabledStatus = await readComputerStatus(disabledConfig, contextA);
  assert.equal(disabledStatus.ok, true);
  assert.equal(disabledStatus.enabled, false);
  assert.equal(disabledStatus.available, true);
  assert.equal(disabledStatus.engine, '@midscene/computer');
  assert.equal(disabledStatus.displays, 2);
  
  await assert.rejects(
    () => runComputerAction(workspace, disabledConfig, { action: 'screenshot', app: APP }, contextA),
    error => {
      assert.equal(error.code, 'COMPUTER_CONTROL_DISABLED');
      assert.equal(error.retryable, false);
      assert.equal(error.requiresUserConfirmation, false);
      assert.match(error.message, /Do not retry this computer action or request MCP approval/i);
      const serialized = serializeToolError('relai_computer', error);
      assert.equal(serialized.errorCode, 'COMPUTER_CONTROL_DISABLED');
      assert.equal(serialized.errorDetails.retryable, false);
      assert.equal(serialized.errorDetails.requiresUserConfirmation, false);
      assert.deepEqual(serialized.errorDetails.allowedAlternatives, [
        'Enable Computer control in Rel.AI Settings > App, then retry the requested computer action.'
      ]);
      return true;
    }
  );
  
  const displays = await runComputerAction(workspace, enabledConfig, { action: 'displays' }, contextA);
  assert.equal(displays.count, 2);
  assert.equal(displays.engine, '@midscene/computer');
  assert.equal(displays.displays[0].coordinateSpace, 'display-local-pixels');
  assert.equal(displays.displays[1].primary, true);
  
  await assert.rejects(
    () => runComputerAction(workspace, enabledConfig, { action: 'click', x: 1, y: 1 }, contextA),
    /requires an explicit app/i,
    'omitting app must never bypass computer-control policy'
  );
  await assert.rejects(
    () => runComputerAction(workspace, enabledConfig, { action: 'screenshot', app: APP }, contextA),
    error => error?.code === 'COMPUTER_APP_APPROVAL_REQUIRED'
  );
  await runComputerAction(workspace, enabledConfig, { action: 'approve_app', app: APP }, contextA);
  const statusA = await readComputerStatus(enabledConfig, contextA);
  const statusBBeforeApproval = await readComputerStatus(enabledConfig, contextB);
  assert.ok(statusA.approvedApps.includes(APP));
  assert.equal(statusBBeforeApproval.approvedApps.includes(APP), false, 'transient app approvals must not leak across sessions');
  await assert.rejects(
    () => runComputerAction(workspace, enabledConfig, { action: 'screenshot', app: APP }, contextB),
    error => error?.code === 'COMPUTER_APP_APPROVAL_REQUIRED'
  );
  
  const capture = await runComputerAction(workspace, enabledConfig, { action: 'screenshot', app: APP, displayId: 'display-side' }, contextA);
  assert.equal(capture.displayId, 'display-side');
  assert.equal(capture.app, APP);
  assert.equal(capture.image.mimeType, 'image/png');
  assert.equal(capture.image.width, 1280);
  assert.equal(capture.image.height, 1024);
  assert.match(capture.observationId, /^obs_/);
  assert.equal(capture.changed, true);
  const unchangedCapture = await runComputerAction(workspace, enabledConfig, { action: 'screenshot', app: APP, displayId: 'display-side' }, contextA);
  assert.equal(unchangedCapture.changed, false);
  assert.equal(unchangedCapture.observationId, capture.observationId);
  assert.equal(unchangedCapture.image, undefined, 'unchanged observations must not retransmit image data');
  const forcedCapture = await runComputerAction(workspace, enabledConfig, { action: 'screenshot', app: APP, displayId: 'display-side', forceImage: true }, contextA);
  assert.equal(forcedCapture.changed, false);
  assert.ok(forcedCapture.image, 'forceImage must re-emit an unchanged image when the caller explicitly needs pixels again');
  
  let semanticObserveCalls = 0;
  const semanticTarget = {
    targetId: 'e1', source: 'uia', role: 'Button', name: 'Save', automationId: 'save', className: 'Button', enabled: true,
    displayId: 'display-side', x: 250, y: 350, width: 100, height: 60, centerX: 300, centerY: 380, patterns: ['invoke']
  };
  const semanticAdapter = {
    engine: 'windows-uia',
    supported: () => true,
    observe: async (_app, _maxElements, perception = 'auto') => {
      semanticObserveCalls += 1;
      return {
        supported: true,
        available: true,
        perception,
        ocrAvailable: true,
        window: { title: 'Notes', processName: 'notes', processId: 42, className: 'NotesWindow', displayId: 'display-side' },
        elements: [semanticTarget],
        count: 1,
        truncated: false
      };
    },
    shutdown: async () => {}
  };
  const semanticContextA = { ...contextA, semanticAdapter };
  const semanticObservation = await runComputerAction(workspace, enabledConfig, { action: 'observe', app: APP }, semanticContextA);
  assert.equal(semanticObservation.semanticAvailable, true);
  assert.equal(semanticObservation.engine, 'windows-uia');
  assert.match(semanticObservation.semanticObservationId, /^uia_/);
  assert.equal(semanticObservation.elements[0].targetId, 'e1');
  const unchangedSemanticObservation = await runComputerAction(workspace, enabledConfig, { action: 'observe', app: APP }, semanticContextA);
  assert.equal(unchangedSemanticObservation.changed, false);
  assert.equal(unchangedSemanticObservation.semanticObservationId, semanticObservation.semanticObservationId);
  assert.equal(unchangedSemanticObservation.elements, undefined, 'unchanged semantic observations must not retransmit the control tree');
  calls.length = 0;
  const semanticActivation = await runComputerAction(workspace, enabledConfig, {
    action: 'activate', app: APP, semanticObservationId: semanticObservation.semanticObservationId, targetId: 'e1'
  }, semanticContextA);
  assert.equal(semanticActivation.executed, true);
  assert.equal(semanticActivation.method, 'semantic-center-click');
  assert.deepEqual(calls, [['click', 'display-side', { x: 300, y: 380 }]], 'semantic activation must use the current revalidated target center through the existing input adapter');
  assert.equal(semanticObserveCalls, 3, 'activate must re-observe before clicking so stale semantic geometry is not trusted');
  
  const hybridSemanticObservation = await runComputerAction(workspace, enabledConfig, {
    action: 'observe', app: APP, perception: 'hybrid'
  }, semanticContextA);
  assert.equal(hybridSemanticObservation.perception, 'hybrid');
  assert.equal(hybridSemanticObservation.ocrAvailable, true);
  assert.equal(hybridSemanticObservation.elements[0].source, 'uia');
  
  const nativeSemanticAdapter = {
    ...semanticAdapter,
    activate: async (_app, target, _maxElements, perception) => ({
      supported: true,
      available: true,
      handled: true,
      method: 'uia-invoke',
      target: { ...target, centerX: 310, centerY: 390 },
      perception
    }),
    setValue: async (_app, target, text) => ({
      supported: true,
      available: true,
      handled: true,
      method: 'uia-set-value',
      target: { ...target, role: 'Edit', patterns: ['value'] },
      text
    })
  };
  const nativeSemanticContextA = { ...contextA, semanticAdapter: nativeSemanticAdapter };
  const nativeObservation = await runComputerAction(workspace, enabledConfig, { action: 'observe', app: APP }, nativeSemanticContextA);
  calls.length = 0;
  const nativeActivation = await runComputerAction(workspace, enabledConfig, {
    action: 'activate', app: APP, semanticObservationId: nativeObservation.semanticObservationId, targetId: 'e1'
  }, nativeSemanticContextA);
  assert.equal(nativeActivation.method, 'uia-invoke');
  assert.equal(nativeActivation.x, 310);
  assert.equal(nativeActivation.y, 390);
  assert.deepEqual(calls, [], 'native UIA activation must not also emit a pixel click');
  const nativeSetValue = await runComputerAction(workspace, enabledConfig, {
    action: 'set_value', app: APP, semanticObservationId: nativeObservation.semanticObservationId, targetId: 'e1', value: ''
  }, nativeSemanticContextA);
  assert.equal(nativeSetValue.method, 'uia-set-value');
  assert.equal(nativeSetValue.textLength, 0, 'native set_value must preserve an intentional empty value');
  
  const fallbackObservation = await runComputerAction(workspace, enabledConfig, { action: 'observe', app: APP }, {
    ...contextA,
    semanticAdapter: {
      engine: 'windows-uia', supported: () => true,
      observe: async () => ({ supported: true, available: false, reason: 'window unavailable' }),
      shutdown: async () => {}
    }
  });
  assert.equal(fallbackObservation.semanticAvailable, false);
  assert.match(fallbackObservation.semanticReason, /window unavailable/i);
  assert.match(fallbackObservation.observationId, /^obs_/, 'semantic observation must fall back to the adaptive visual path');
  
  let releaseIgnoredAbortObservation;
  let markIgnoredAbortStarted;
  const ignoredAbortStarted = new Promise(resolve => { markIgnoredAbortStarted = resolve; });
  const ignoredAbortPending = new Promise(resolve => { releaseIgnoredAbortObservation = resolve; });
  const semanticAbortController = new AbortController();
  const abortedSemanticObservation = runComputerAction(workspace, enabledConfig, { action: 'observe', app: APP }, {
    ...contextA,
    signal: semanticAbortController.signal,
    computerAdapter: { ...adapter, screenshot: async () => { throw new Error('aborted semantic observation must not fall back to a screenshot'); } },
    semanticAdapter: {
      engine: 'windows-uia', supported: () => true,
      observe: async () => {
        markIgnoredAbortStarted();
        await ignoredAbortPending;
        return { supported: true, available: false, reason: 'late result' };
      },
      shutdown: async () => {}
    }
  });
  await ignoredAbortStarted;
  semanticAbortController.abort();
  releaseIgnoredAbortObservation();
  await assert.rejects(abortedSemanticObservation, error => error?.name === 'AbortError', 'aborted semantic observation must not silently continue into visual fallback');
  
  await runComputerAction(workspace, enabledConfig, { action: 'approve_app', app: 'chrome' }, contextA);
  await runComputerAction(workspace, enabledConfig, { action: 'screenshot', app: 'chrome' }, contextA);
  await assert.rejects(
    () => runComputerAction(workspace, enabledConfig, { action: 'observe', app: 'chrome' }, semanticContextA),
    error => error?.code === 'COMPUTER_TIER_RESTRICTED',
    'browser semantic observation must stay routed to relai_browser instead of UIA'
  );
  await assert.rejects(
    () => runComputerAction(workspace, enabledConfig, { action: 'click', app: 'chrome', x: 1, y: 1 }, contextA),
    error => error?.code === 'COMPUTER_TIER_RESTRICTED'
  );
  await runComputerAction(workspace, enabledConfig, { action: 'approve_app', app: 'terminal' }, contextA);
  await assert.rejects(
    () => runComputerAction(workspace, enabledConfig, { action: 'type', app: 'terminal', text: 'blocked' }, contextA),
    error => error?.code === 'COMPUTER_TIER_RESTRICTED'
  );
  
  calls.length = 0;
  await runComputerAction(workspace, enabledConfig, { action: 'click', app: APP, displayId: 'display-side', x: 100, y: 50 }, contextA);
  await runComputerAction(workspace, enabledConfig, { action: 'move', app: APP, x: 20, y: 30 }, contextA);
  await runComputerAction(workspace, enabledConfig, { action: 'double_click', app: APP, x: 25, y: 35 }, contextA);
  await runComputerAction(workspace, enabledConfig, { action: 'right_click', app: APP, x: 30, y: 40 }, contextA);
  await runComputerAction(workspace, enabledConfig, { action: 'drag', app: APP, x: 10, y: 20, toX: 30, toY: 40 }, contextA);
  assert.deepEqual(calls, [
    ['click', 'display-side', { x: 100, y: 50 }],
    ['move', undefined, { x: 20, y: 30 }],
    ['doubleClick', undefined, { x: 25, y: 35 }],
    ['rightClick', undefined, { x: 30, y: 40 }],
    ['drag', undefined, { x: 10, y: 20 }, { x: 30, y: 40 }]
  ]);
  
  calls.length = 0;
  await runComputerAction(workspace, enabledConfig, { action: 'scroll', app: APP, direction: 'down', distance: 125, x: 200, y: 300 }, contextA);
  await runComputerAction(workspace, enabledConfig, { action: 'type', app: APP, text: 'hello' }, contextA);
  await runComputerAction(workspace, enabledConfig, { action: 'key', app: APP, key: 'return' }, contextA);
  await runComputerAction(workspace, enabledConfig, { action: 'hotkey', app: APP, keys: ['ctrl', 's'] }, contextA);
  assert.deepEqual(calls, [
    ['scroll', undefined, { direction: 'down', distance: 125, point: { x: 200, y: 300 } }],
    ['typeText', 'hello'],
    ['pressKey', 'enter'],
    ['pressKey', 'control+s']
  ]);
  
  const scaledPng = await sharp({
    create: { width: 1920, height: 1080, channels: 3, background: { r: 20, g: 30, b: 40 } }
  }).png().toBuffer();
  const scaledCalls = [];
  const scaledAdapter = {
    ...adapter,
    screenshot: async () => ({ mimeType: 'image/png', data: scaledPng.toString('base64'), bytes: scaledPng.length, width: 1920, height: 1080 }),
    click: async (displayId, point) => scaledCalls.push(['click', displayId, point])
  };
  const scaledContextA = { ...contextA, computerAdapter: scaledAdapter };
  const scaledCapture = await runComputerAction(workspace, enabledConfig, { action: 'screenshot', app: APP, profile: 'fast' }, scaledContextA);
  assert.equal(scaledCapture.image.width, 1280);
  assert.equal(scaledCapture.image.height, 720);
  assert.equal(scaledCapture.image.sourceWidth, 1920);
  assert.equal(scaledCapture.image.sourceHeight, 1080);
  await runComputerAction(workspace, enabledConfig, {
    action: 'click', app: APP, observationId: scaledCapture.observationId, x: 640, y: 360
  }, scaledContextA);
  assert.deepEqual(scaledCalls, [['click', undefined, { x: 960, y: 540 }]], 'observation-space coordinates must map back to physical display pixels');
  
  let screenState = 0;
  const stateCalls = [];
  const stateAdapter = {
    ...adapter,
    screenshot: async () => {
      const data = Buffer.from(`screen-state:${screenState}`).toString('base64');
      return { mimeType: 'image/png', data, bytes: Buffer.byteLength(data, 'base64'), width: 800, height: 600 };
    },
    click: async (displayId, point) => {
      stateCalls.push(['click', displayId, point]);
      screenState = 1;
    }
  };
  const stateContextA = { ...contextA, computerAdapter: stateAdapter };
  await runComputerAction(workspace, enabledConfig, { action: 'screenshot', app: APP }, stateContextA);
  const stateBatch = await runComputerAction(workspace, enabledConfig, {
    action: 'batch', app: APP,
    actions: [
      { action: 'click', x: 10, y: 20 },
      { action: 'wait_for_change', timeoutMs: 500, pollMs: 50 },
      { action: 'screenshot' }
    ]
  }, stateContextA);
  assert.equal(stateBatch.executed, true);
  assert.deepEqual(stateCalls, [['click', undefined, { x: 10, y: 20 }]]);
  assert.equal(stateBatch.results[1].action, 'wait_for_change');
  assert.equal(stateBatch.results[1].changed, true);
  assert.ok(stateBatch.results[1].image, 'the changed observation should be emitted once');
  assert.equal(stateBatch.results[2].changed, false);
  assert.equal(stateBatch.results[2].image, undefined, 'the trailing screenshot should reuse the changed observation without retransmitting it');
  
  let stableCapture = 0;
  const stableAdapter = {
    ...adapter,
    screenshot: async () => {
      stableCapture += 1;
      const state = stableCapture < 3 ? stableCapture : 3;
      const data = Buffer.from(`stable-state:${state}`).toString('base64');
      return { mimeType: 'image/png', data, bytes: Buffer.byteLength(data, 'base64'), width: 800, height: 600 };
    }
  };
  const stableResult = await runComputerAction(workspace, enabledConfig, {
    action: 'wait_for_stable', app: APP, timeoutMs: 1000, pollMs: 50, stableMs: 100
  }, { ...contextA, computerAdapter: stableAdapter });
  assert.equal(stableResult.stable, true);
  assert.equal(stableResult.stableMs, 100);
  assert.ok(stableResult.durationMs >= 100);
  
  const verifiedBatch = await runComputerAction(workspace, enabledConfig, {
    action: 'batch', app: APP, perception: 'hybrid',
    actions: [{ action: 'observe' }]
  }, semanticContextA);
  assert.equal(verifiedBatch.results[0].action, 'observe');
  assert.equal(verifiedBatch.results[0].semanticAvailable, true);
  assert.equal(verifiedBatch.results[0].perception, 'hybrid');
  
  calls.length = 0;
  const batch = await runComputerAction(workspace, enabledConfig, {
    action: 'batch', app: APP,
    actions: [
      { action: 'move', x: 5, y: 6 },
      { action: 'click', x: 7, y: 8 }
    ]
  }, contextA);
  assert.equal(batch.executed, true);
  assert.deepEqual(calls, [
    ['move', undefined, { x: 5, y: 6 }],
    ['click', undefined, { x: 7, y: 8 }]
  ], 'batch steps must inherit the approved parent app instead of requiring duplicate app fields');
  
  await runComputerAction(workspace, enabledConfig, { action: 'approve_app', app: APP }, contextB);
  await assert.rejects(
    () => runComputerAction(workspace, enabledConfig, { action: 'click', app: APP, x: 2, y: 2 }, contextB),
    error => error?.code === 'COMPUTER_SESSION_LOCKED',
    'a different session in the same workspace must not share the desktop lock'
  );
  await assert.rejects(
    () => runComputerAction(workspace, enabledConfig, { action: 'stop' }, contextB),
    error => error?.code === 'COMPUTER_SESSION_LOCKED',
    'only the lock-owning session may release computer control'
  );
  const released = await runComputerAction(workspace, enabledConfig, { action: 'stop' }, contextA);
  assert.equal(released.released, true);
  
  const queuedCalls = [];
  let releaseBlockedClick;
  let markBlockedClickStarted;
  const blockedClickStarted = new Promise(resolve => { markBlockedClickStarted = resolve; });
  const blockedClick = new Promise(resolve => { releaseBlockedClick = resolve; });
  const blockingAdapter = {
    ...adapter,
    click: async (displayId, point) => {
      queuedCalls.push(['click', displayId, point]);
      if (point.x === 1) {
        markBlockedClickStarted();
        await blockedClick;
      }
    }
  };
  const blockingContextA = { ...contextA, computerAdapter: blockingAdapter };
  const firstQueuedClick = runComputerAction(
    workspace,
    enabledConfig,
    { action: 'click', app: APP, x: 1, y: 1 },
    blockingContextA
  );
  await blockedClickStarted;
  const queuedController = new AbortController();
  const cancelledQueuedClick = runComputerAction(
    workspace,
    enabledConfig,
    { action: 'click', app: APP, x: 2, y: 2 },
    { ...blockingContextA, signal: queuedController.signal }
  );
  queuedController.abort();
  await assert.rejects(cancelledQueuedClick, error => error?.name === 'AbortError');
  releaseBlockedClick();
  await firstQueuedClick;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(queuedCalls, [['click', undefined, { x: 1, y: 1 }]], 'cancelled queued input must never execute later');
  
  calls.length = 0;
  await assert.rejects(
    () => runComputerAction(workspace, enabledConfig, { action: 'type', app: APP, text: 'x'.repeat(MAX_TYPE_TEXT_BYTES + 1) }, contextA),
    /65536-byte limit/
  );
  assert.equal(calls.length, 0, 'oversized typing must be rejected before Midscene input execution');
  const catalog = getToolActionCatalog().filter(entry => entry.publicTool === 'relai_computer');
  const typeAction = catalog.find(entry => entry.action === 'type');
  assert.equal(typeAction?.inputSchema?.properties?.text?.maxLength, 65536, 'the model-facing schema must advertise the bounded typing limit');
  for (const action of ['observe', 'activate', 'set_value', 'screenshot', 'wait_for_change', 'wait_for_stable', 'move', 'click', 'double_click', 'right_click', 'drag', 'scroll', 'type', 'key', 'hotkey', 'batch']) {
    const definition = catalog.find(entry => entry.action === action);
    assert.ok(definition?.required?.includes('app'), `${action} must advertise app as required`);
  }
  const observeAction = catalog.find(entry => entry.action === 'observe');
  assert.equal(observeAction?.inputSchema?.properties?.maxElements?.maximum, 300);
  assert.deepEqual(observeAction?.inputSchema?.properties?.perception?.enum, ['auto', 'semantic', 'hybrid']);
  const activateAction = catalog.find(entry => entry.action === 'activate');
  assert.ok(activateAction?.required?.includes('semanticObservationId'));
  assert.ok(activateAction?.required?.includes('targetId'));
  const setValueAction = catalog.find(entry => entry.action === 'set_value');
  assert.ok(setValueAction?.required?.includes('value'));
  assert.equal(setValueAction?.inputSchema?.properties?.value?.maxLength, 65536);
  const screenshotAction = catalog.find(entry => entry.action === 'screenshot');
  assert.deepEqual(screenshotAction?.inputSchema?.properties?.profile?.enum, ['fast', 'balanced', 'detail']);
  assert.equal(screenshotAction?.inputSchema?.properties?.forceImage?.type, 'boolean');
  const clickAction = catalog.find(entry => entry.action === 'click');
  assert.equal(clickAction?.inputSchema?.properties?.observationId?.type, 'string');
  const waitAction = catalog.find(entry => entry.action === 'wait_for_change');
  assert.equal(waitAction?.inputSchema?.properties?.timeoutMs?.maximum, 30000);
  assert.equal(waitAction?.inputSchema?.properties?.pollMs?.minimum, 50);
  const stableAction = catalog.find(entry => entry.action === 'wait_for_stable');
  assert.equal(stableAction?.inputSchema?.properties?.stableMs?.maximum, 5000);
  
  await assert.rejects(
    () => runComputerAction(workspace, enabledConfig, { action: 'click', app: APP, displayId: 'display-side', x: 1280, y: 20 }, contextA),
    /must be inside display 'display-side'/
  );
  await assert.rejects(
    () => runComputerAction(workspace, enabledConfig, { action: 'click', app: APP, x: -1, y: 20 }, contextA),
    /must be between 0 and 100000/
  );
  await runComputerAction(workspace, enabledConfig, { action: 'stop' }, contextA);
  
  const unavailable = await readComputerStatus(enabledConfig, {
    ...contextA,
    computerAdapter: { ...adapter, environment: async () => ({ available: false, platform: process.platform, displays: 0, error: 'permission denied' }) }
  });
  assert.equal(unavailable.available, false);
  assert.match(unavailable.message, /permission denied/);
  
  console.log('Computer manager enforces opt-in, per-session app approval and locking, app tiers, cancellation, schemas, and display-local input bounds.');
}
await case_computer_manager_unit();

// Formerly computer-observation-unit.mjs
async function case_computer_observation_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("sharp");
    const sharp = __m1.default;
  
    const __m2 = await import("../src/computer/computerObservation.js");
    const { computerImageSha256,
    normalizeScreenshotProfile,
    prepareComputerObservation } = __m2;
  
  const sourceBuffer = await sharp({
    create: {
      width: 2560,
      height: 1440,
      channels: 3,
      background: { r: 30, g: 60, b: 90 }
    }
  }).png().toBuffer();
  const source = {
    mimeType: 'image/png',
    data: sourceBuffer.toString('base64'),
    bytes: sourceBuffer.length,
    width: 2560,
    height: 1440
  };
  
  const balanced = await prepareComputerObservation(source, 'balanced');
  assert.equal(balanced.profile, 'balanced');
  assert.equal(balanced.image.width, 1600);
  assert.equal(balanced.image.height, 900);
  assert.equal(balanced.image.sourceWidth, 2560);
  assert.equal(balanced.image.sourceHeight, 1440);
  assert.equal(balanced.image.scaleX, 1.6);
  assert.equal(balanced.image.scaleY, 1.6);
  assert.ok(balanced.image.bytes < source.width * source.height * 4);
  assert.equal(balanced.sourceSha256, computerImageSha256(source));
  
  const fast = await prepareComputerObservation(source, 'fast');
  assert.equal(fast.image.width, 1280);
  assert.equal(fast.image.height, 720);
  assert.equal(fast.image.scaleX, 2);
  assert.equal(fast.image.scaleY, 2);
  
  const detail = await prepareComputerObservation(source, 'detail');
  assert.equal(detail.image.width, 2560);
  assert.equal(detail.image.height, 1440);
  assert.equal(detail.image.data, source.data);
  assert.equal(detail.image.scaleX, 1);
  assert.equal(detail.image.scaleY, 1);
  
  assert.equal(normalizeScreenshotProfile(undefined), 'balanced');
  assert.throws(() => normalizeScreenshotProfile('unknown'), /fast, balanced, or detail/);
  
  console.log('Computer observations resize predictably, preserve source geometry, and expose stable source hashes.');
}
await case_computer_observation_unit();

// Formerly midscene-computer-adapter-unit.mjs
async function case_midscene_computer_adapter_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/computer/midsceneAdapter.js");
    const { createMidsceneComputerAdapter } = __m1;
  
  const calls = [];
  const instances = [];
  const screenshotBytes = Buffer.from('midscene-shot');
  
  class FakeComputerDevice {
    static async listDisplays() {
      calls.push(['listDisplays']);
      return [
        { id: 'main', name: 'Main', primary: true },
        { id: 'side', name: 'Side', primary: false }
      ];
    }
  
    constructor(options) {
      this.displayId = options?.displayId;
      instances.push(this);
      calls.push(['construct', this.displayId]);
      this.inputPrimitives = {
        pointer: {
          hover: async point => calls.push(['hover', this.displayId, point]),
          tap: async point => calls.push(['tap', this.displayId, point]),
          doubleClick: async point => calls.push(['doubleClick', this.displayId, point]),
          rightClick: async point => calls.push(['rightClick', this.displayId, point]),
          dragAndDrop: async (from, to) => calls.push(['dragAndDrop', this.displayId, from, to])
        },
        scroll: {
          scroll: async value => calls.push(['scroll', this.displayId, value])
        },
        keyboard: {
          typeText: async (text, options) => calls.push(['typeText', this.displayId, text, options]),
          keyboardPress: async key => calls.push(['keyboardPress', this.displayId, key])
        }
      };
    }
  
    async connect() {
      calls.push(['connect', this.displayId]);
    }
  
    async destroy() {
      calls.push(['destroy', this.displayId]);
    }
  
    async size() {
      calls.push(['size', this.displayId]);
      return this.displayId === 'side' ? { width: 1280, height: 1024 } : { width: 1920, height: 1080 };
    }
  
    async screenshotBase64() {
      calls.push(['screenshotBase64', this.displayId]);
      return `data:image/png;base64,${screenshotBytes.toString('base64')}`;
    }
  }
  
  const fakeModule = {
    ComputerDevice: FakeComputerDevice,
    checkComputerEnvironment: async () => ({ available: true, platform: 'win32', displays: 2 })
  };
  const adapter = createMidsceneComputerAdapter({ importMidscene: async () => fakeModule });
  
  assert.equal(adapter.engine, '@midscene/computer');
  assert.deepEqual(await adapter.environment(), { available: true, platform: 'win32', displays: 2 });
  assert.deepEqual(await adapter.listDisplays(), [
    { id: 'main', name: 'Main', primary: true, coordinateSpace: 'display-local-pixels' },
    { id: 'side', name: 'Side', primary: false, coordinateSpace: 'display-local-pixels' }
  ]);
  
  calls.length = 0;
  assert.deepEqual(await adapter.size('side'), { width: 1280, height: 1024 });
  await adapter.click('side', { x: 10, y: 20 });
  await adapter.move('side', { x: 11, y: 21 });
  await adapter.doubleClick('side', { x: 12, y: 22 });
  await adapter.rightClick('side', { x: 13, y: 23 });
  await adapter.drag('side', { x: 1, y: 2 }, { x: 3, y: 4 });
  await adapter.scroll('side', { direction: 'down', distance: 240, point: { x: 50, y: 60 } });
  assert.equal(calls.filter(call => call[0] === 'construct' && call[1] === 'side').length, 1, 'one Midscene device must be reused per display');
  assert.equal(calls.filter(call => call[0] === 'connect' && call[1] === 'side').length, 1, 'cached display devices must connect only once');
  assert.deepEqual(calls.find(call => call[0] === 'scroll'), [
    'scroll', 'side', { scrollType: 'singleAction', direction: 'down', distance: 240, locate: { center: [50, 60] } }
  ]);
  
  calls.length = 0;
  await adapter.typeText('hello');
  await adapter.pressKey('control+s');
  assert.deepEqual(calls.filter(call => ['typeText', 'keyboardPress'].includes(call[0])), [
    ['typeText', undefined, 'hello', { replace: false }],
    ['keyboardPress', undefined, 'control+s']
  ]);
  assert.equal(calls.filter(call => call[0] === 'construct' && call[1] === undefined).length, 1, 'primary Midscene device must be cached');
  
  calls.length = 0;
  const image = await adapter.screenshot('side');
  assert.equal(image.mimeType, 'image/png');
  assert.equal(image.data, screenshotBytes.toString('base64'));
  assert.equal(image.bytes, screenshotBytes.length);
  assert.equal(image.width, 1280);
  assert.equal(image.height, 1024);
  await adapter.screenshot('side');
  assert.equal(calls.filter(call => call[0] === 'screenshotBase64' && call[1] === 'side').length, 1, 'repeated observation may reuse the short screenshot cache');
  await adapter.screenshot('side', { fresh: true });
  assert.equal(calls.filter(call => call[0] === 'screenshotBase64' && call[1] === 'side').length, 2, 'fresh observation must bypass the short screenshot cache for local change detection');
  await adapter.click('side', { x: 20, y: 30 });
  await adapter.screenshot('side');
  assert.equal(calls.filter(call => call[0] === 'screenshotBase64' && call[1] === 'side').length, 3, 'display input must invalidate the cached screenshot immediately');
  
  calls.length = 0;
  await adapter.screenshot();
  await adapter.screenshot();
  assert.equal(calls.filter(call => call[0] === 'screenshotBase64' && call[1] === undefined).length, 1);
  await adapter.typeText('invalidate-primary');
  await adapter.screenshot();
  assert.equal(calls.filter(call => call[0] === 'screenshotBase64' && call[1] === undefined).length, 2, 'keyboard input must invalidate the primary screenshot cache');
  
  const tooLargeModule = {
    ...fakeModule,
    ComputerDevice: class extends FakeComputerDevice {
      async screenshotBase64() {
        return `data:image/png;base64,${Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64')}`;
      }
    }
  };
  const boundedAdapter = createMidsceneComputerAdapter({ importMidscene: async () => tooLargeModule });
  await assert.rejects(() => boundedAdapter.screenshot(), /4194304-byte image limit/);
  
  let attempts = 0;
  class FailingOnceDevice extends FakeComputerDevice {
    async connect() {
      attempts += 1;
      if (attempts === 1) throw new Error('connect failed');
    }
  }
  const retryingAdapter = createMidsceneComputerAdapter({
    importMidscene: async () => ({ ...fakeModule, ComputerDevice: FailingOnceDevice })
  });
  await assert.rejects(() => retryingAdapter.size('side'), /connect failed/);
  assert.deepEqual(await retryingAdapter.size('side'), { width: 1280, height: 1024 }, 'failed device connections must be evicted so a later action can retry');
  
  assert.ok(instances.length >= 2);
  console.log('Midscene computer adapter caches connected devices, invalidates screenshots after input, preserves bounded screenshots, and retries failed device initialization.');
}
await case_midscene_computer_adapter_unit();
