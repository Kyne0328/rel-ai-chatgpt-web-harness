// Consolidated activity session coverage.
// Pure and self-contained checks share one process; tests requiring process/global isolation remain standalone.
// Add related regression checks here instead of creating another one-off test file.

// Formerly activity-controller-contract-unit.mjs
async function case_activity_controller_contract_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:path");
    const path = __m2.default;
  
    const __m3 = await import("node:url");
    const { fileURLToPath } = __m3;
  
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
  const activity = read('src/ui/features/activity/react.js');
  const activityCss = read('src/ui/features/activity/styles.css');
  
  assert.match(activity, /liveEntriesSinceLoadRef/, 'live entries received during history loading must be retained');
  assert.match(activity, /pauseTimeoutWhenHidden:\s*false/, 'Activity history must not suspend its timeout for an entire minimized period');
  assert.match(activity, /historyRetryRef/, 'a hidden history failure must retry when the dashboard becomes visible');
  assert.match(activity, /pausedEntriesRef/, 'paused live snapshots must be buffered');
  assert.match(activity, /await loadHistory\('merge'\)/, 'resuming must reconcile buffered events with a fresh stored snapshot');
  assert.match(activity, /relai:clock-tick/, 'time-range filters must age from the shared dashboard clock');
  assert.match(activity, /nextActivityExpiry/, 'clock updates must only rerender at an expiration boundary');
  assert.match(activity, /'aria-expanded': treeRevision\.open/, 'the raw JSON tree toggle must expose its expanded state to assistive technology');
  assert.match(activity, /treeRevision\.open \? 'Collapse all' : 'Expand all'/, 'raw JSON controls must use one stateful expand/collapse toggle instead of duplicate opposite actions');
  assert.match(activity, /command \? h\(CommandDetail, \{ command \}\) : null/, 'Activity details must render the recorded command as a first-class readable section');
  assert.match(activity, /Copy command/, 'Activity command details must provide a dedicated copy action');
  assert.match(activityCss, /\.activity-detail-command pre\s*\{[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;/s, 'long commands must wrap instead of being visually clipped');
  assert.match(activity, /h\(RawDetail, \{ title: 'Raw target'/, 'technical details must preserve raw target information');
  assert.match(activity, /h\(RawDetail, \{ title: 'Raw result'/, 'technical details must preserve raw result information');
  assert.match(activity, /h\(RawDetail, \{ title: 'Raw error'/, 'technical details must preserve raw error information');
  
  console.log('Activity React controller contract test passed.');
}
await case_activity_controller_contract_unit();

// Formerly activity-event-unit.mjs
async function case_activity_event_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/ui/activity-event.js");
    const { activityEventId } = __m1;
  
  const event = {
    ts: '2026-07-18T07:00:00.000Z',
    tool: 'relai_edit',
    workspace: 'rel-ai-mcp',
    taskId: 'task-1',
    operationId: 'operation-1',
    operation: 'Editing dashboard sessions',
    ms: 42,
    ok: true
  };
  
  assert.equal(activityEventId(event), activityEventId({ ...event }), 'the same audit event must have a stable identity');
  assert.notEqual(activityEventId(event), activityEventId({ ...event, operationId: 'operation-2' }), 'different operations must not collide');
  assert.notEqual(activityEventId(event), activityEventId({ ...event, ok: false }), 'success and failure events must not collide');
  const persisted = activityEventId({ id: 'persisted-id', tool: 'ignored' });
  assert.equal(persisted, activityEventId({ id: 'persisted-id', tool: 'different' }), 'persisted event IDs must take precedence');
  assert.match(persisted, /^event:[a-f0-9]{16}$/, 'event identities must be compact and URL-safe');
  assert.equal(Array.from(activityEventId(event)).every(character => {
    const code = character.codePointAt(0);
    return code > 31 && code !== 127;
  }), true, 'event identities must survive route sanitization');
  
  console.log('Activity event identity tests passed.');
}
await case_activity_event_unit();

// Formerly activity-model-unit.mjs
async function case_activity_model_unit() {
  const __m0 = await import("node:test");
    const test = __m0.default;
  
    const __m1 = await import("node:assert/strict");
    const assert = __m1.default;
  
    const __m2 = await import("../src/ui/features/activity/model.js");
    const activityModel = __m2;
  
    const __m3 = await import("../src/ui/features/activity/model.js");
    const { activityAbsoluteTime,
    activityActionLabel,
    activityFileLocation,
    activityFilterTransition,
    activityMessage,
    activityStatusGroup,
    filterActivityEntries,
    mergeActivityEntries,
    nextActivityExpiry,
    parseActivityHistoryResponse,
    replaceActivityHistory } = __m3;
  
  const NOW = Date.parse('2026-08-06T10:00:00.000Z');
  const entry = (overrides = {}) => ({
    eventId: 'event-1',
    timestamp: '2026-08-06T09:55:00.000Z',
    tool: 'relai_read',
    workspace: 'app',
    status: 'succeeded',
    title: 'Read repository',
    summary: 'Read the requested files.',
    ...overrides
  });
  
  test('history snapshots replace stale local entries', () => {
    const replaced = replaceActivityHistory([
      entry({ eventId: 'server-new', timestamp: '2026-08-06T09:59:00.000Z' })
    ]);
    assert.deepEqual(replaced.map(item => item.eventId), ['server-new']);
  });
  
  test('paged history keeps every explicitly loaded entry beyond the old client cap', () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => entry({
      eventId: `event-${index}`,
      timestamp: new Date(NOW - index).toISOString()
    }));
    const olderPage = Array.from({ length: 500 }, (_, index) => entry({
      eventId: `event-${1000 + index}`,
      timestamp: new Date(NOW - 1000 - index).toISOString()
    }));
    const replaced = replaceActivityHistory(firstPage);
    const merged = mergeActivityEntries(replaced, olderPage);
    assert.equal(merged.entries.length, 1500, 'loading an older page must not discard rows while the server cursor advances');
    assert.equal(merged.entries.at(-1)?.eventId, 'event-1499');
  });

  test('live merges report no-op snapshots and preserve useful message text', () => {
    const current = [entry()];
    const same = mergeActivityEntries(current, [entry()]);
    assert.equal(same.changed, false);
    assert.equal(same.entries, current, 'no-op snapshots should preserve the current array identity');
  
    const blankPatch = mergeActivityEntries(current, [entry({ summary: '   ', message: '' })]);
    assert.equal(blankPatch.changed, false, 'blank lifecycle fields must not erase useful display text');
    assert.equal(blankPatch.entries[0].summary, 'Read the requested files.');
  
    const changed = mergeActivityEntries(current, [entry({ status: 'failed', summary: 'Read failed.' })]);
    assert.equal(changed.changed, true);
    assert.equal(changed.entries[0].summary, 'Read failed.');
  });
  
  test('activity resolves user-facing work-session context from task or session ids', () => {
    assert.equal(typeof activityModel.activitySessionView, 'function', 'activity model must expose session resolution');
    const { activitySessionView } = activityModel;
    const sessions = new Map([
      ['task-1', { id: 'task-1', title: 'Fix Electron app lag', workspace: 'rel-ai-mcp' }]
    ]);
    assert.deepEqual(activitySessionView(entry({ taskId: 'task-1' }), sessions), {
      id: 'task-1',
      title: 'Fix Electron app lag',
      workspace: 'rel-ai-mcp',
      shortId: 'task-1',
      linked: true
    });
    assert.equal(activitySessionView(entry({ taskId: 'missing-session' }), sessions).title, 'Task missing-');
    assert.equal(activitySessionView(entry({ taskId: '', sessionId: '' }), sessions).title, 'Project activity');
    assert.equal(activitySessionView(entry({ taskId: '', sessionId: '', workspace: '' }), sessions).title, 'Direct activity');
  });
  
  test('activity search can match a resolved work-session title', () => {
    const { activitySessionView } = activityModel;
    const base = { search: 'electron app lag', timeRange: 'all', workspace: '', tool: '', status: '', task: '' };
    const sessions = new Map([['task-1', { id: 'task-1', title: 'Fix Electron app lag', workspace: 'rel-ai-mcp' }]]);
    const results = filterActivityEntries([entry({ taskId: 'task-1' })], base, NOW, {
      sessionTitle: item => activitySessionView(item, sessions).title
    });
    assert.equal(results.length, 1);
  });
  
  test('activity exposes and searches canonical local file destinations', () => {
    const downloaded = entry({
      tool: 'relai_browser',
      title: 'Download file',
      result: { ok: true, path: 'reports/September/report.pdf' }
    });
    assert.equal(activityFileLocation(downloaded), 'reports/September/report.pdf');
    assert.equal(activityFileLocation(entry({ result: { ok: true } })), '');
    const results = filterActivityEntries([downloaded], {
      search: 'september/report.pdf', timeRange: 'all', workspace: '', tool: '', status: '', task: ''
    }, NOW);
    assert.equal(results.length, 1);
  });
  
  test('activity rows prioritize distinct actions and file identities', () => {
    const read = entry({
      action: 'read',
      title: 'Read 3 files',
      summary: 'Read 3 files.',
      metadata: { filePaths: ['src/a.js', 'src/b.ts', 'docs/README.md'] },
      target: { type: 'file', workspaceRelativePath: 'src/a.js' }
    });
    assert.equal(activityModel.activityDisplayAction(read), 'Read 3 files');
    assert.deepEqual(activityModel.activityFilePaths(read), ['src/a.js', 'src/b.ts', 'docs/README.md']);
    assert.equal(activityModel.activityDescription(read), 'src/a.js · src/b.ts · +1 more');
    assert.equal(activityModel.activityFileKind('docs/README.md'), 'Markdown');
    assert.equal(activityModel.activityDescription(entry({
      action: 'read', title: 'Read 1 file', summary: 'Read src/a.js.',
      target: { type: 'file', workspaceRelativePath: 'src/a.js' }
    })), 'JavaScript · src/a.js');
    assert.equal(activityModel.activityDisplayAction(entry({
      title: 'Completed successfully', action: 'goal.stop', summary: 'Completed successfully'
    })), 'Goal Mode stopped');
    assert.equal(activityModel.activityDescription(entry({
      title: 'Completed successfully', action: 'goal.stop', summary: 'Completed successfully'
    })), '');
    assert.deepEqual(activityModel.activityFilePaths(entry({
      action: 'edit', metadata: { changedFiles: ['src/b.ts'], filePaths: ['src/a.js', 'src/b.ts'] },
      target: { type: 'file', workspaceRelativePath: 'src/a.js' }
    })), ['src/b.ts'], 'actual changed files take priority over requested files');
  });

  test('activity messages skip whitespace and always provide visible text', () => {
    assert.equal(activityMessage(entry({ summary: '   ', message: '\n', currentActivity: 'Indexing files' })), 'Indexing files');
    assert.equal(activityMessage(entry({ summary: '', title: '', operation: '', path: '' })), 'No additional details recorded.');
  });
  
  test('status groups preserve active, blocked, cancelled, failed, and succeeded semantics', () => {
    assert.equal(activityStatusGroup(entry({ status: 'running', ok: undefined })), 'active');
    assert.equal(activityStatusGroup(entry({ status: 'blocked', ok: false })), 'blocked');
    assert.equal(activityStatusGroup(entry({ status: 'cancelled', ok: false })), 'cancelled');
    assert.equal(activityStatusGroup(entry({ status: 'failed', ok: false })), 'failed');
    assert.equal(activityStatusGroup(entry({ status: 'succeeded', ok: true })), 'succeeded');
    assert.equal(activityStatusGroup(entry({ status: '', ok: undefined })), 'other');
  });
  
  test('filters use exact status groups and an injected current time', () => {
    const entries = [
      entry({ eventId: 'recent-success', status: 'succeeded' }),
      entry({ eventId: 'recent-running', status: 'running' }),
      entry({ eventId: 'recent-blocked', status: 'blocked' }),
      entry({ eventId: 'old-success', timestamp: '2026-08-06T08:00:00.000Z' })
    ];
    const base = { search: '', timeRange: '1h', workspace: '', tool: '', status: '', task: '' };
    assert.deepEqual(filterActivityEntries(entries, base, NOW).map(item => item.eventId), ['recent-success', 'recent-running', 'recent-blocked']);
    const sorted = [entries[1], entries[0], entries[2], entries[3]];
    assert.deepEqual(filterActivityEntries(sorted, base, NOW, { sorted: true }).map(item => item.eventId), ['recent-running', 'recent-success', 'recent-blocked'], 'pre-sorted activity should filter without reordering');
    assert.deepEqual(filterActivityEntries(entries, { ...base, status: 'active' }, NOW).map(item => item.eventId), ['recent-running']);
    assert.deepEqual(filterActivityEntries(entries, { ...base, status: 'blocked' }, NOW).map(item => item.eventId), ['recent-blocked']);
    assert.deepEqual(filterActivityEntries(entries, { ...base, status: 'ok' }, NOW).map(item => item.eventId), ['recent-success'], 'legacy successful routes should map to succeeded only');
    assert.deepEqual(filterActivityEntries(entries, { ...base, status: 'error' }, NOW).map(item => item.eventId), [], 'legacy failed routes must not include blocked or cancelled events');
    assert.deepEqual(filterActivityEntries([entry()], base, Date.parse('2026-08-06T10:55:00.000Z')), [], 'events must expire at the exact range boundary');
    assert.deepEqual(filterActivityEntries([entry({ taskId: '', sessionId: 'session-1' })], { ...base, timeRange: 'all', task: 'session-1' }, NOW).map(item => item.eventId), ['event-1'], 'session filters must accept sessionId-only activity records');
  });
  
  test('workspace filter transitions require a route remount while local filters do not', () => {
    const current = { search: 'read', timeRange: '1h', workspace: 'app', tool: '', status: '', task: 'task-1' };
    const workspaceChange = activityFilterTransition(current, { timeRange: '24h', workspace: 'api', tool: 'relai_read', status: 'failed' });
    assert.equal(workspaceChange.workspaceChanged, true);
    assert.deepEqual(workspaceChange.filterState, {
      search: 'read',
      timeRange: '24h',
      workspace: 'api',
      tool: 'relai_read',
      status: 'failed',
      task: 'task-1'
    });
  
    const localChange = activityFilterTransition(current, { timeRange: 'all', workspace: 'app', tool: '', status: 'active' });
    assert.equal(localChange.workspaceChanged, false);
  });
  
  test('time filters expose the next expiration boundary', () => {
    const expiry = nextActivityExpiry([entry()], { timeRange: '1h' }, NOW);
    assert.equal(expiry, Date.parse('2026-08-06T10:55:00.000Z'));
    assert.equal(nextActivityExpiry([entry()], { timeRange: 'all' }, NOW), Number.POSITIVE_INFINITY);
  });
  
  test('history responses expose structured fetch failures', () => {
    assert.deepEqual(parseActivityHistoryResponse({ ok: true, entries: [entry()] }).entries.map(item => item.eventId), ['event-1']);
    assert.deepEqual(parseActivityHistoryResponse([entry()]).entries.map(item => item.eventId), ['event-1']);
    assert.deepEqual(parseActivityHistoryResponse({ ok: false, error: 'Request timed out.' }), {
      ok: false,
      entries: [],
      error: 'Request timed out.',
      nextCursor: null,
      hasMore: false
    });
    assert.equal(parseActivityHistoryResponse({ ok: false, error: { message: 'Gateway unavailable.' } }).error, 'Gateway unavailable.');
  });
  
  test('detail timestamps and action labels have safe, distinguishable fallbacks', () => {
    assert.equal(activityAbsoluteTime(entry({ timestamp: 'not-a-date' })), 'Time unavailable');
    assert.notEqual(
      activityActionLabel(entry({ eventId: 'a', summary: 'First operation.' })),
      activityActionLabel(entry({ eventId: 'b', summary: 'Second operation.' }))
    );
    assert.equal(activityModel.activityDisplayAction(entry()), 'Read repository');
    assert.equal(activityModel.activityDisplayAction(entry({ title: '', operation: '', tool: 'relai_edit' })), 'Edit');
    assert.equal(activityModel.activityToolLabel('relai_validate'), 'Validate');
    assert.equal(activityModel.activityToolLabel('custom-action'), 'Custom action');
    assert.match(activityActionLabel(entry()), /^Open Read repository details: Read the requested files\./);
  });
}
await case_activity_model_unit();

// Formerly activity-scroll-unit.mjs
async function case_activity_scroll_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:path");
    const path = __m2.default;
  
    const __m3 = await import("node:url");
    const { fileURLToPath } = __m3;
  
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
  
  const css = read('src/ui/styles/app.css');
  const activity = read('src/ui/features/activity/react.js');
  
  const tableWrapRule = css.match(/\.table-wrap\s*\{([^}]*)\}/)?.[1] || '';
  const filterScrollResetBody = activity.match(/const resetListScroll = useCallback\(\(\) => \{([\s\S]*?)\n {2}\}, \[\]\);/)?.[1] || '';
  
  assert.match(filterScrollResetBody, /tableWrapRef\.current\.scrollLeft = 0/, 'filter changes may reset horizontal table position');
  assert.doesNotMatch(filterScrollResetBody, /scrollTop/, 'Activity filter/live updates must not reset vertical reading position');
  assert.match(activity, /const jumpToLatest = useCallback[\s\S]*listPaneRef\.current\.scrollTop = 0/, 'the explicit Jump to latest action may return the list to the top');
  assert.match(tableWrapRule, /overscroll-behavior-x:\s*contain/, 'horizontal table overscroll should remain contained');
  assert.match(tableWrapRule, /overscroll-behavior-y:\s*auto/, 'vertical wheel and touch scrolling must chain to the Activity page');
  assert.doesNotMatch(tableWrapRule, /overscroll-behavior:\s*contain/, 'the table wrapper must not trap vertical page scrolling');
  
  console.log('Activity React page scroll regression test passed.');
}
await case_activity_scroll_unit();

// Formerly session-cache-unit.mjs
async function case_session_cache_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/sessionCache.js");
    const { getCachedRead, getCachedReadEntry, setCachedRead, invalidatePath, invalidateAlias, invalidateAll, cacheStats } = __m1;
  
  function reset() { invalidateAll(); }
  
  reset();
  assert.equal(getCachedRead('a', '/x', 1), null);
  console.log('1. cold get: OK');
  
  reset();
  setCachedRead('a', '/x', 5, 'hello', { sha256: 'abc123', bytes: 9 });
  assert.equal(getCachedRead('a', '/x', 5), 'hello');
  assert.deepEqual(getCachedReadEntry('a', '/x', 5), { content: 'hello', sha256: 'abc123', bytes: 9 });
  console.log('2. hit with metadata: OK');
  
  reset();
  setCachedRead('a', '/x', 5, 'hello');
  assert.equal(getCachedRead('a', '/x', 6), null);
  assert.equal(getCachedRead('a', '/x', 5), null);
  console.log('3. mtime mismatch: OK');
  
  reset();
  setCachedRead('a', '/x', 1, 'A');
  setCachedRead('a', '/y', 1, 'B');
  invalidatePath('a', '/x');
  assert.equal(getCachedRead('a', '/x', 1), null);
  assert.equal(getCachedRead('a', '/y', 1), 'B');
  console.log('4. invalidatePath: OK');
  
  reset();
  setCachedRead('a', '/x', 1, 'A');
  setCachedRead('b', '/x', 1, 'B');
  invalidateAlias('a');
  assert.equal(getCachedRead('a', '/x', 1), null);
  assert.equal(getCachedRead('b', '/x', 1), 'B');
  console.log('5. invalidateAlias: OK');
  
  reset();
  const big = 'x'.repeat(1024 * 1024 + 1);
  setCachedRead('a', '/big', 1, big);
  assert.equal(getCachedRead('a', '/big', 1), null);
  console.log('6. >1MB not stored: OK');
  
  reset();
  for (let i = 0; i < 200; i++) setCachedRead('a', '/p' + i, 1, 'v' + i);
  assert.equal(cacheStats().entries, 200);
  await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(getCachedRead('a', '/p0', 1), 'v0');
  setCachedRead('a', '/p200', 1, 'v200');
  assert.equal(cacheStats().entries, 200);
  assert.equal(getCachedRead('a', '/p0', 1), 'v0', 'recently touched survives');
  assert.equal(getCachedRead('a', '/p1', 1), null, 'oldest evicted');
  assert.equal(getCachedRead('a', '/p200', 1), 'v200');
  console.log('7. LRU eviction: OK');
  
  reset();
  setCachedRead('a', '/x', 1, 'A');
  setCachedRead('b', '/y', 1, 'B');
  invalidateAll();
  assert.equal(cacheStats().entries, 0);
  console.log('8. invalidateAll: OK');
  
  console.log('session-cache unit tests passed.');
}
await case_session_cache_unit();

// Formerly session-event-order-unit.mjs
async function case_session_event_order_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/ui/features/sessions/model.js");
    const { orderSessionEvents } = __m1;
  
  const events = [
    { id: 'oldest', ts: '2026-07-25T10:00:00.000Z' },
    { id: 'newest', ts: '2026-07-25T10:02:00.000Z' },
    { id: 'middle', ts: '2026-07-25T10:01:00.000Z' },
    { id: 'fallback', createdAt: '2026-07-25T09:59:00.000Z' }
  ];
  
  const ordered = orderSessionEvents(events);
  assert.deepEqual(ordered.map(event => event.id), ['newest', 'middle', 'oldest', 'fallback']);
  assert.deepEqual(events.map(event => event.id), ['oldest', 'newest', 'middle', 'fallback'], 'ordering must not mutate stored session events');
  
  console.log('Session event ordering tests passed.');
}
await case_session_event_order_unit();


async function case_task_inspector_lifecycle_unit() {
  const { default: assert } = await import('node:assert/strict');
  const { readFileSync } = await import('node:fs');
  const { default: vm } = await import('node:vm');
  const model = await import('../src/ui/features/sessions/model.js');
  const identity = await import('../src/ui/task-identity.js');
  const { processListView } = await import('../src/ui/features/processes/index.js');
  const source = readFileSync(new URL('../src/ui/features/sessions/react.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replace(/^export /gm, '');

  // Run the actual page/inspector callbacks with deterministic hook state and
  // effect cleanup. Child elements remain inspectable without a browser build.
  function harness(task = '') {
    const componentSlots = new Map();
    let slots = [];
    const requests = [];
    const controls = [];
    let params = new URLSearchParams(task ? { task } : {});
    let cursor = 0;
    let dirty = false;
    let effects = [];
    let refreshes = 0;
    const sameDeps = (before, after) => Array.isArray(before) && Array.isArray(after)
      && before.length === after.length && before.every((value, index) => Object.is(value, after[index]));
    const memo = (create, deps) => {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: create(), deps };
      return slots[index].value;
    };
    const context = {
      ...model, ...identity, URLSearchParams, encodeURIComponent,
      React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }), lazy: () => 'lazy-feature' },
      memo: component => component,
      Icon: 'icon', Suspense: 'suspense', ProcessRow: 'process-row', OperationDiagnostics: 'operation-diagnostics',
      processListView, useProcessMemory: () => null, formatDuration: value => String(value),
      useState: initial => {
        const index = cursor++;
        if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
        const slot = slots[index];
        return [slot.value, update => {
          const next = typeof update === 'function' ? update(slot.value) : update;
          if (!Object.is(next, slot.value)) {
            slot.value = next;
            dirty = true;
          }
        }];
      },
      useRef: initial => {
        const index = cursor++;
        if (!slots[index]) slots[index] = { value: { current: initial } };
        return slots[index].value;
      },
      useMemo: memo,
      useCallback: (callback, deps) => memo(() => callback, deps),
      useEffect: (effect, deps) => {
        const index = cursor++;
        if (!slots[index] || !sameDeps(slots[index].deps, deps)) {
          const previous = slots[index];
          slots[index] = { deps };
          effects.push(() => {
            previous?.cleanup?.();
            slots[index].cleanup = effect();
          });
        }
      },
      window: { matchMedia: () => ({ matches: false }) },
      getWorkspaceFilter: () => params.get('workspace') || '',
      getRouteParams: () => new URLSearchParams(params),
      getRouteSnapshot: () => ({ path: 'tasks', search: params.toString() }),
      subscribeRoute: () => () => {},
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
      replaceRouteParams: patch => {
        for (const [key, value] of Object.entries(patch)) {
          if (value) params.set(key, value); else params.delete(key);
        }
      },
      flushSync: callback => callback(),
      fetchJson: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
      postJson: (url, payload) => new Promise(resolve => controls.push({ url, payload, resolve })),
      requestDashboardRefresh: () => { refreshes += 1; },
      toast() {},
      confirmAction: async () => true,
      routeHref: () => '#activity',
      orderWorkspacesAlphabetically: rows => rows
    };
    vm.runInNewContext(source + '\nglobalThis.components = { SessionsPage, SessionInspector, SessionTabs, TaskProcessesSection, CurrentOperations, TechnicalDetails };', context);
    return {
      requests, controls,
      refreshes: () => refreshes,
      navigate: next => { params = new URLSearchParams(next ? { task: next } : {}); },
      render(name, props) {
        if (!componentSlots.has(name)) componentSlots.set(name, []);
        slots = componentSlots.get(name);
        let tree;
        let renders = 0;
        do {
          assert.ok(++renders < 25, 'task lifecycle effects must settle without a render loop');
          cursor = 0;
          dirty = false;
          effects = [];
          tree = context.components[name](props);
          const committed = effects;
          effects = [];
          for (const effect of committed) effect();
        } while (dirty);
        return tree;
      },
      dispose() {
        for (const component of componentSlots.values()) for (const slot of component) slot?.cleanup?.();
      }
    };
  }
  function find(tree, predicate) {
    if (!tree || typeof tree !== 'object') return null;
    if (Array.isArray(tree)) return tree.map(child => find(child, predicate)).find(Boolean) || null;
    if (predicate(tree)) return tree;
    for (const child of tree.children || []) {
      const found = find(child, predicate);
      if (found) return found;
    }
    return null;
  }
  const inspector = tree => find(tree, node => node.type?.name === 'SessionInspector');
  const stopGoal = tree => find(tree, node => Object.hasOwn(node.props, 'data-stop-goal'));
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const recent = Array.from({ length: 100 }, (_, index) => ({
    id: 'recent-' + index, title: 'Recent task ' + index, workspace: 'app',
    status: 'completed', historyUpdatedAtMs: 1000 - index
  }));
  const data = { tasks: recent, config: { workspaces: [] } };
  const retained = { id: 'retained-old', title: 'Retained task outside bootstrap', workspace: 'app', status: 'completed' };

  {
    const app = harness();
    const currentOperations = [{ id: 'operation-without-counter', tool: 'relai_read' }];
    assert.equal(model.taskRunningOperations({ status: 'running', currentOperations }).length, 1, 'current operations remain visible when the summary omits the call counter');
    assert.equal(model.taskRunningOperations({ status: 'running', activeCalls: 0, currentOperations }).length, 1, 'a lagging call counter must not hide recorded current operations');
    const active = { ...retained, id: 'operations-task', status: 'settling', activeCalls: 1,
      currentOperations: [{ id: 'read-operation', tool: 'relai_read', label: 'Read source', startedAt: Date.now() }] };
    const managedProcesses = [
      { processId: 'task-command', workSessionId: active.id, workspaceId: 'app', lifecycle: 'task', status: 'running' },
      { processId: 'other-command', workSessionId: 'another-task', workspaceId: 'app', status: 'running' }
    ];
    let detail = app.render('SessionInspector', { session: active, managedProcesses, activeTab: 'processes' });
    const tabProps = find(detail, node => node.type?.name === 'SessionTabs').props;
    assert.equal(tabProps.counts.processes, 2, 'Processes must count task operations and owned commands, excluding other tasks');
    const tabs = app.render('SessionTabs', tabProps);
    assert.equal(find(tabs, node => node.props['data-session-tab'] === 'validation'), null);
    assert.equal(find(detail, node => node.props['data-session-panel'] === 'validation'), null);

    const processes = app.render('TaskProcessesSection', find(detail, node => node.type?.name === 'TaskProcessesSection').props);
    assert.ok(find(processes, node => node.type === 'process-row' && node.props.row.processId === 'task-command'));
    assert.equal(find(processes, node => node.type === 'process-row' && node.props.row.processId === 'other-command'), null, 'other project commands stay collapsed');
    assert.equal(find(processes, node => node.type === 'strong' && node.children.includes('No running operations or managed commands')), null);
    const operationProps = find(processes, node => node.type?.name === 'CurrentOperations').props;
    let operations = app.render('CurrentOperations', operationProps);
    const stop = find(operations, node => node.props['data-stop-task-operation'] === 'read-operation');
    assert.ok(stop, 'non-command operations must be visible and individually stoppable in Processes');
    stop.props.onClick();
    assert.equal(app.controls[0].url, '/api/tasks/control');
    assert.equal(app.controls[0].payload.work_id, active.id);
    assert.equal(app.controls[0].payload.operationId, 'read-operation');
    assert.equal(app.controls[0].payload.action, 'stop');
    detail = app.render('SessionInspector', { session: active, managedProcesses, activeTab: 'processes' });
    operations = app.render('CurrentOperations', { ...operationProps, controlKey: find(detail, node => node.type?.name === 'TaskProcessesSection').props.controlKey });
    assert.equal(find(operations, node => node.props['data-stop-task-operation'] === 'read-operation').props.disabled, true);
    app.controls[0].resolve({ ok: true, stoppedOperationCount: 1 });
    await settle();

    const technical = app.render('TechnicalDetails', { session: active });
    assert.equal(find(technical, node => node.type?.name === 'CurrentOperations'), null, 'Technical must not duplicate operations');
    assert.equal(find(technical, node => node.type?.name === 'IdentifierDetail').props.label, 'Task ID');
    assert.equal(find(technical, node => node.props.label === 'Ended').props.value, 'Not recorded', 'missing completion evidence must not imply completion');
    assert.equal(find(technical, node => node.props.label === 'End reason'), null, 'missing end reasons must not be synthesized');
    assert.equal(find(technical, node => node.props.label === 'Checks').props.value, 'Not recorded');

    const completed = { ...active, status: 'completed' };
    assert.equal(app.render('CurrentOperations', { session: completed }), null, 'terminal tasks must hide stale operation snapshots');
    const operationOnly = app.render('TaskProcessesSection', { session: active, taskId: active.id, active: true });
    assert.ok(find(operationOnly, node => node.type?.name === 'CurrentOperations'));
    assert.equal(find(operationOnly, node => node.type === 'strong' && node.children.includes('No running operations or managed commands')), null, 'operation-only tasks must not show an empty state');
    const empty = app.render('TaskProcessesSection', { session: completed, taskId: active.id, active: true });
    assert.ok(find(empty, node => node.type === 'strong' && node.children.includes('No running operations or managed commands')));
    app.dispose();
  }

  {
    const app = harness(retained.id);
    app.render('SessionsPage', { data });
    assert.equal(app.requests.length, 1, 'an off-page deep link must fetch its task without loading older history pages');
    assert.equal(new URL(app.requests[0].url, 'http://localhost').searchParams.get('task'), retained.id);
    app.requests[0].resolve({ ok: true, session: retained, trace: { entries: [] } });
    await settle();
    const tree = app.render('SessionsPage', { data });
    assert.equal(inspector(tree)?.props.session.id, retained.id, 'hydrated detail must render even without a list summary');
    assert.equal(inspector(tree)?.props.session.title, retained.title);
    assert.equal(app.requests.length, 1, 'hydrating an off-page task must not restart its fetch');
    app.dispose();
  }

  {
    const app = harness('older-a');
    app.render('SessionsPage', { data });
    app.navigate('older-b');
    app.render('SessionsPage', { data });
    assert.equal(app.requests.length, 2, 'switching between off-page deep links must select and fetch the newer task');
    app.requests[1].resolve({ ok: true, session: { ...retained, id: 'older-b', title: 'Latest selection' } });
    await settle();
    app.requests[0].resolve({ ok: true, session: { ...retained, id: 'older-a', title: 'Stale response' } });
    await settle();
    const tree = app.render('SessionsPage', { data });
    assert.equal(inspector(tree)?.props.session.id, 'older-b', 'a late hydration response must not replace the newer selection');
    assert.equal(inspector(tree)?.props.session.title, 'Latest selection');
    app.dispose();
  }

  {
    const app = harness();
    const active = { ...retained, id: 'restartable-goal', status: 'planning', goalMode: { goalActive: true, state: 'monitoring' } };
    const props = session => ({ session, activeTab: 'overview' });
    let tree = app.render('SessionInspector', props(active));
    assert.ok(stopGoal(tree), 'an active goal must expose Stop Goal');
    stopGoal(tree).props.onClick();
    tree = app.render('SessionInspector', props(active));
    assert.equal(stopGoal(tree)?.props.disabled, true, 'goal controls must be disabled while the stop request is pending');
    assert.equal(app.controls[0].payload.action, 'goal_stop');
    assert.equal(app.controls[0].payload.work_id, active.id);
    app.controls[0].resolve({ ok: true, goalActive: false });
    await settle();
    tree = app.render('SessionInspector', props({ ...active, goalMode: { goalActive: false, state: 'stopped' } }));
    assert.equal(stopGoal(tree), null, 'the stopped canonical goal must hide Stop Goal');
    assert.equal(app.refreshes(), 1, 'a successful stop must request authoritative task state');
    tree = app.render('SessionInspector', props({ ...active, goalMode: { goalActive: true, state: 'monitoring' } }));
    assert.ok(stopGoal(tree), 'reactivating a goal on the same task must restore Stop Goal');
    assert.equal(stopGoal(tree).props.disabled, false);
    stopGoal(tree).props.onClick();
    assert.equal(app.controls.length, 2, 'the reactivated goal must remain stoppable without navigating away');
    app.controls[1].resolve({ ok: false, error: 'Fixture stop failure' });
    await settle();
    tree = app.render('SessionInspector', props(active));
    assert.equal(stopGoal(tree)?.props.disabled, false, 'a failed stop must leave the active goal available for retry');
    app.dispose();
  }

  {
    const active = { ...retained, status: 'planning', goalMode: { goalActive: true, state: 'monitoring' } };
    const stopped = { ...active, goalMode: { goalActive: false, state: 'stopped' } };
    const app = harness(active.id);
    app.render('SessionsPage', { data });
    app.requests[0].resolve({ ok: true, session: stopped });
    await settle();
    let page = app.render('SessionsPage', { data });
    let detail = app.render('SessionInspector', inspector(page).props);
    assert.equal(stopGoal(detail), null);

    const externallyUpdatedData = { ...data, tasks: [...recent] };
    app.render('SessionsPage', { data: externallyUpdatedData });
    assert.equal(app.requests.length, 2, 'external activation must refresh off-page detail before any local control');
    assert.equal(app.requests[1].options.cache, 'no-store', 'external off-page changes must not reuse the historical detail cache');
    app.requests[1].resolve({ ok: true, session: active });
    await settle();
    page = app.render('SessionsPage', { data: externallyUpdatedData });
    detail = app.render('SessionInspector', inspector(page).props);
    assert.ok(stopGoal(detail), 'external activation must expose Stop Goal without navigating away');
    stopGoal(detail).props.onClick();
    app.controls[0].resolve({ ok: true, goalActive: false, state: 'stopped' });
    await settle();

    // The aggregate list intentionally remains unchanged and omits this task.
    app.render('SessionsPage', { data: externallyUpdatedData });
    assert.equal(app.requests.length, 3, 'successful off-page control must reload selected detail without a changed summary');
    assert.equal(app.requests[2].options.cache, 'no-store', 'post-control hydration must bypass pre-mutation cached detail');
    app.requests[2].resolve({ ok: true, session: stopped });
    await settle();
    page = app.render('SessionsPage', { data: externallyUpdatedData });
    detail = app.render('SessionInspector', inspector(page).props);
    assert.equal(stopGoal(detail), null, 'the off-page inspector must reflect authoritative stop success');

    const refreshedData = { ...data, tasks: [...recent] };
    app.render('SessionsPage', { data: refreshedData });
    assert.equal(app.requests.length, 4, 'a dashboard task refresh must also reconcile selected off-page detail');
    app.requests[3].resolve({ ok: true, session: { ...active, goalMode: { goalActive: true, state: 'monitoring' } } });
    await settle();
    page = app.render('SessionsPage', { data: refreshedData });
    detail = app.render('SessionInspector', inspector(page).props);
    assert.ok(stopGoal(detail), 'same-ID reactivation must restore Stop Goal in the off-page inspector');
    stopGoal(detail).props.onClick();
    assert.equal(app.controls.length, 2, 'reactivated off-page goals must remain stoppable');
    app.controls[1].resolve({ ok: false, error: 'Fixture stop failure' });
    await settle();
    app.dispose();
  }

  console.log('Task inspector, operation controls, deep-link hydration, and goal lifecycle tests passed.');
}
await case_task_inspector_lifecycle_unit();
