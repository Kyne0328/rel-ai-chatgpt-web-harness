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
  const reactMain = read('src/ui/react/main.js');
  const dashboard = read('public/dashboard.js');
  const activityCss = read('src/ui/features/activity/styles.css');
  
  assert.match(activity, /from '\.\/model\.js'/, 'Activity must keep filtering and merge behavior in its pure model');
  assert.match(activity, /replaceActivityHistory\(data\.auditTail\?\.entries \|\| \[\]\)/, 'React Activity must initialize from the canonical dashboard snapshot');
  assert.match(activity, /liveEntriesSinceLoadRef/, 'live entries received during history loading must be retained');
  assert.match(activity, /parseActivityHistoryResponse\(response\)/, 'structured history fetch errors must be interpreted explicitly');
  assert.match(activity, /pauseTimeoutWhenHidden:\s*false/, 'Activity history must not suspend its timeout for an entire minimized period');
  assert.match(activity, /historyRetryRef/, 'a hidden history failure must retry when the dashboard becomes visible');
  assert.match(activity, /replaceActivityHistory\(parsed\.entries\)/, 'stored history must remain an authoritative snapshot');
  assert.match(activity, /pausedEntriesRef/, 'paused live snapshots must be buffered');
  assert.match(activity, /await loadHistory\('merge'\)/, 'resuming must reconcile buffered events with a fresh stored snapshot');
  assert.match(activity, /if \(!merged\.changed\) return false;/, 'unchanged live snapshots must be React no-ops');
  assert.match(activity, /sorted:\s*true/, 'Activity must avoid re-sorting canonical already-sorted history during filtering');
  assert.match(activity, /relai:clock-tick/, 'time-range filters must age from the shared dashboard clock');
  assert.match(activity, /nextActivityExpiry/, 'clock updates must only rerender at an expiration boundary');
  assert.match(activity, /const ActivityRow = memo\(/, 'live Activity rows must be memoized so unrelated event updates do not rerender them');
  assert.match(activity, /const eventId = activityEventId\(entry\);[\s\S]*key:\s*eventId/, 'live Activity rows must use canonical domain event IDs as React keys');
  assert.doesNotMatch(activity, /entries\.map\(\([^)]*index[^)]*\)[\s\S]{0,180}key:\s*index/, 'live Activity rows must never use array indexes as keys');
  assert.match(activity, /selectedEventId/, 'selected Activity identity must be explicit React state');
  assert.match(activity, /selected:\s*Boolean\(selectedEventId && eventId === selectedEventId\)/, 'selection must follow canonical event identity across live merges');
  assert.match(activity, /activityActionLabel\(entry\)/, 'row actions must keep distinguishable accessible labels');
  assert.match(activity, /className:\s*'activity-message-copy'\s*\},\s*message\)/, 'message text must remain the primary visible row content');
  assert.match(activity, /className:\s*'activity-row-task'/, 'rows must retain task context as supporting metadata');
  assert.match(activity, /className:\s*'activity-row-project'/, 'rows must retain project context as supporting metadata');
  assert.match(activity, /focus\(\{ preventScroll: true \}\)/, 'stacked inspector selection must move focus without an intermediate browser scroll');
  assert.match(activity, /scrollIntoView\(\{ block: 'start', inline: 'nearest' \}\)/, 'stacked inspector selection must reveal the inspector predictably');
  assert.match(activity, /Copy event JSON/, 'technical details must preserve the copy action');
  assert.match(activity, /rawDetail\('Raw target'/, 'technical details must preserve raw target information');
  assert.match(activity, /rawDetail\('Raw result'/, 'technical details must preserve raw result information');
  assert.match(activity, /rawDetail\('Raw error'/, 'technical details must preserve raw error information');
  assert.match(activity, /ACTIVITY_STORE_KEYS = Object\.freeze\(\['auditTail', 'tasks'\]\)/, 'Activity must subscribe only to the dashboard slices it renders');
  assert.match(activity, /createActivityRoute\(useDashboardSlices\)[\s\S]*useDashboardSlices\(ACTIVITY_STORE_KEYS\)/, 'Activity must consume scoped canonical dashboard store slices');
  assert.match(reactMain, /registerReactSection\('activity'/, 'Activity must remain registered as a canonical React route');
  assert.doesNotMatch(dashboard, /case 'activity':\s*return true;/, 'React-owned Activity must not retain an imperative live-rendering branch');
  assert.match(activityCss, /\.activity-master-detail\s*\{[^}]*grid-template-columns:/s, 'Activity must retain a list/inspector layout; rendered browser coverage owns the exact geometry and stacking breakpoint');
  assert.match(activityCss, /\.activity-message-copy\s*\{[^}]*min-width:/s, 'messages need an explicit readable minimum width');
  assert.match(activityCss, /\.activity-col-message\s*\{[^}]*width:\s*auto/s, 'the primary Activity column must be able to consume the remaining table width');
  
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

// Formerly activity-message-layout-unit.mjs
async function case_activity_message_layout_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
  const css = fs.readFileSync('src/ui/features/activity/styles.css', 'utf8');
  const react = fs.readFileSync('src/ui/features/activity/react.js', 'utf8');
  
  assert.match(react, /h\('colgroup',[\s\S]{0,260}activity-col-time[\s\S]{0,180}activity-col-message/, 'React activity table must keep the canonical time + activity columns');
  assert.doesNotMatch(react, /activity-col-(?:tool|task|status|action)/, 'tool, task, status, and action belong in Activity metadata instead of duplicate table columns');
  assert.match(react, /activity-row-meta[\s\S]{0,500}StatusPill[\s\S]{0,300}activity-row-action[\s\S]{0,300}activity-row-task[\s\S]{0,300}activity-row-project/, 'Activity metadata must retain status, action, task, and project context');
  assert.match(css, /\.activity-table\s*\{[^}]*table-layout:\s*fixed/s, 'Activity table must use a stable fixed layout');
  assert.match(css, /\.activity-col-time\s*\{[^}]*width:\s*\d+px/s, 'Time must keep a bounded fixed-width column');
  assert.doesNotMatch(css, /^\.activity-time-column\s*\{[^}]*align-top/ms, 'the Time header must keep the table header vertical alignment');
  assert.match(css, /^\.activity-table tbody \.activity-time-column\s*\{[^}]*align-top/ms, 'only Activity body times should align to the top of multi-line rows');
  assert.match(css, /\.activity-col-message\s*\{[^}]*width:\s*auto/s, 'Activity content must consume the remaining width');
  assert.doesNotMatch(css, /\.activity-col-message\s*\{[^}]*width:\s*calc\(/s, 'Activity width must not depend on brittle calc chains');
  assert.match(css, /\.activity-message-copy\s*\{[^}]*min-width:/s, 'message text must retain an explicit readable minimum width');
  assert.doesNotMatch(css, /\.activity-time-column\s*\{[^}]*display:\s*none/s, 'responsive layouts must preserve the time column so chronology remains visible');
  assert.match(css, /@media\s*\(max-width:[^)]+\)[\s\S]*\.activity-col-message\s*\{[^}]*width:\s*100%/s, 'the Activity column must use the available narrow-layout width alongside the retained time column'); // rigidity-ok: full width is the responsive Activity-column contract.
  
  console.log('Activity message layout invariants passed.');
}
await case_activity_message_layout_unit();

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
    assert.equal(activitySessionView(entry({ taskId: '', sessionId: '' }), sessions).title, 'Unlinked activity');
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
      error: 'Request timed out.'
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
  const activityCss = read('src/ui/features/activity/styles.css');
  const activity = read('src/ui/features/activity/react.js');
  
  const tableWrapRule = css.match(/\.table-wrap\s*\{([^}]*)\}/)?.[1] || '';
  const routeRootRule = css.match(/\.route-root\s*\{([^}]*)\}/)?.[1] || '';
  const activityPageRule = activityCss.match(/\.activity-page\s*\{([^}]*)\}/)?.[1] || '';
  const activityCardRule = activityCss.match(/\.activity-event-card\s*\{([^}]*)\}/)?.[1] || '';
  const activityCardBodyRule = activityCss.match(/\.activity-event-card \.card-body\s*\{([^}]*)\}/)?.[1] || '';
  const activityTableWrapRule = activityCss.match(/\.activity-event-card \.table-wrap\s*\{([^}]*)\}/)?.[1] || '';
  
  assert.match(activity, /className:\s*'table-wrap'/, 'React Activity must render its event log inside the shared table wrapper');
  assert.match(activity, /tableWrapRef\.current\.scrollLeft = 0/, 'filter changes may reset horizontal table position');
  assert.doesNotMatch(activity, /tableWrapRef\.current\.scrollTop\s*=|\.scrollTop\s*=\s*0/, 'Activity filter/live updates must not reset vertical reading position');
  assert.match(activity, /scrollIntoView\(\{ block: 'start', inline: 'nearest' \}\)/, 'only explicit stacked-inspector selection should scroll content into view');
  assert.match(css, /\.main\s*\{[^}]*@apply flex min-w-0 w-full flex-col/, 'the main dashboard column must expose remaining height to route content');
  assert.match(routeRootRule, /@apply flex min-w-0 flex-col/, 'route content must use a vertical flex layout');
  assert.match(routeRootRule, /flex:\s*1 0 auto/, 'route content must claim unused dashboard height without shrinking long pages');
  assert.match(activityPageRule, /min-height:\s*0/, 'Activity must be allowed to shrink within the available route height'); // rigidity-ok: flex overflow invariant
  assert.match(activityPageRule, /flex:\s*1 1 0/, 'Activity must fill available route height while allowing internal scrolling'); // rigidity-ok: bounded route flex child
  assert.match(activityCardRule, /@apply flex min-w-0 flex-col/, 'the event log card must lay out its header and body vertically');
  assert.match(activityCardRule, /min-height:\s*0/, 'the event log card must allow its scroll panes to shrink'); // rigidity-ok: flex overflow invariant
  assert.match(activityCardRule, /flex:\s*1 1 0/, 'the event log card must fill remaining Activity height without forcing outer-page overflow'); // rigidity-ok: bounded vertical flex child
  assert.match(activityCardBodyRule, /flex:\s*1 0 auto/, 'the event log body must fill the card');
  assert.match(activityTableWrapRule, /flex:\s*1 0 auto/, 'the event log table wrapper must fill the body');
  assert.match(activityCss, /\.activity-event-card \.table-wrap\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/, 'the event log wrapper must span the full card width'); // rigidity-ok: semantic scroll-container invariant
  assert.match(activityCss, /\.activity-event-card \.table-wrap\s*\{[^}]*overflow-x:\s*auto/, 'horizontal overflow must be contained by the Activity table wrapper');
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
  
    const __m1 = await import("../src/ui/features/sessions/index.js");
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
