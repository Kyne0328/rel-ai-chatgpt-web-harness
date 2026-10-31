/* global window, document, location, history, requestAnimationFrame */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const targetUrl = process.env.RELAI_PROBE_TARGET_URL;
const outputPath = process.env.RELAI_PROBE_OUTPUT_PATH;
if (!targetUrl || !outputPath) throw new Error('Task Changes probe needs a target URL and output path.');

async function probeTaskChanges() {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (predicate, label) => {
    const deadline = Date.now() + 8000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for ' + label + ' at ' + location.hash + ' text=' + document.body.textContent.slice(0, 500) + ' panels=' + document.querySelectorAll('[data-session-panel]').length + ' tabs=' + document.querySelectorAll('[data-session-tab]').length);
      await wait(20);
    }
  };
  const activityEntries = [
    { eventId: 'probe-event-1', timestamp: new Date().toISOString(), tool: 'relai_read', title: 'Read fixture', summary: 'Activity return context fixture', status: 'succeeded', workspace: 'app', taskId: 'probe-task' },
    { eventId: 'probe-event-2', timestamp: new Date(Date.now() - 1000).toISOString(), tool: 'relai_exec', title: 'Run fixture', summary: 'Activity already hydrated on first open', status: 'succeeded', workspace: 'app', taskId: 'probe-task' }
  ];
  const detailRequests = [];
  let retryDetailFails = true;
  const task = (id, files = [], overrides = {}) => ({
    work_id: id, title: id, workspace: 'app', status: 'completed', toolCallCount: 2,
    changedFiles: files, events: [], changeRevision: 1, ...overrides
  });
  let snapshot = {
    config: { workspaces: [{ alias: 'app' }] },
    tasks: [task('probe-task', ['src/example.js', 'src/new.js']), task('no-change-task')],
    live: { revisions: { task: 1 } }
  };
  const listeners = new Set();
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, options) => {
    const url = new URL(String(input), location.href);
    const respond = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {
      status, headers: { 'Content-Type': 'application/json' }
    }));
    if (url.pathname === '/api/logs') return respond({ ok: true, entries: activityEntries });
    if (url.pathname === '/api/tasks/session') {
      const id = url.searchParams.get('task');
      detailRequests.push(id);
      if (id === 'retry-detail-task') return retryDetailFails
        ? respond({ ok: false, error: 'Temporary detail failure.' }, 503)
        : respond({ ok: true, session: task(id, [], { title: 'Recovered retained task' }) });
      if (id === 'mismatched-detail-task') return respond({ ok: true, session: task('another-task', [], { title: 'Wrong task' }) });
      const summary = snapshot.tasks.find(item => item.work_id === id);
      const events = activityEntries.filter(entry => entry.taskId === id);
      const session = summary
        ? { ...summary, events, recordedEventCount: events.length }
        : task(id, ['src/retained.js']);
      return respond({ ok: true, session });
    }
    return nativeFetch(input, options);
  };

  history.replaceState(null, '', '#tasks?workspace=app&task=probe-task&tab=changes&file=src%2Fnew.js');
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const module = await import('/public/dashboard-react.js');
  module.mountReactFoundation(host, {
    getSnapshot: () => snapshot,
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); }
  });
  window.dispatchEvent(new CustomEvent('relai:route-change', {
    detail: { section: 'tasks', path: 'tasks', params: new URLSearchParams(location.hash.split('?')[1]) }
  }));
  await until(() =>
    document.querySelector('#session-tab-changes')?.getAttribute('aria-selected') === 'true' &&
    document.querySelector('.task-diff-viewer .monaco-diff-editor') &&
    document.querySelector('[data-code-file-heading]')?.textContent === 'src/new.js', 'embedded task diff');

  const activeEditor = () => window.monaco?.editor?.getEditors?.().find(
    editor => editor.getModel?.()?.getValue?.()?.includes('function greet')
  );
  const current = activeEditor();
  const result = {
    integrated: true,
    readOnly: current?.getOption(window.monaco.editor.EditorOption.readOnly) === true,
    language: current?.getModel?.()?.getLanguageId?.(),
    filePaths: [...document.querySelectorAll('[data-code-file]')].map(node => node.dataset.codeFile),
    noStandaloneControls: !document.querySelector('[data-code-fullscreen-link], [data-code-task-link], [data-code-task], [data-code-react]'),
    ideControl: Boolean(document.querySelector('[data-code-open-ide]')) &&
      Boolean(document.querySelector('[data-code-ide]')) &&
      !document.querySelector('[data-code-open-ide]')?.disabled,
    noOverviewFilesLink: !document.querySelector('.task-files-summary a'),
    noCodeNavigation: !document.querySelector('[data-nav-id="code"]')
  };

  const initialModel = current?.getModel?.();
  current?.setPosition({ lineNumber: 3, column: 4 });
  window.relaiCodeProbe.setRevision(2, 20);
  snapshot = {
    ...snapshot,
    tasks: snapshot.tasks.map(item => item.work_id === 'probe-task' ? { ...item, changeRevision: 2 } : item),
    live: { revisions: { task: 2 } }
  };
  listeners.forEach(listener => listener());
  await until(() => activeEditor()?.getModel?.()?.getValue?.()?.includes('const answer = 43;'), 'live diff refresh');
  result.liveRefresh = {
    sameModel: initialModel === activeEditor()?.getModel?.(),
    line: activeEditor()?.getPosition?.()?.lineNumber,
    content: activeEditor()?.getModel?.()?.getValue?.() || ''
  };

  window.relaiCodeProbe.setRevision(3, 250);
  snapshot = { ...snapshot, tasks: snapshot.tasks.map(item => item.work_id === 'probe-task' ? { ...item, changeRevision: 3 } : item) };
  listeners.forEach(listener => listener());
  await wait(30);
  window.relaiCodeProbe.setRevision(4, 20);
  snapshot = { ...snapshot, tasks: snapshot.tasks.map(item => item.work_id === 'probe-task' ? { ...item, changeRevision: 4 } : item) };
  listeners.forEach(listener => listener());
  await until(() => activeEditor()?.getModel?.()?.getValue?.()?.includes('const answer = 45;'), 'newer diff revision');
  await wait(280);
  result.outOfOrderContent = activeEditor()?.getModel?.()?.getValue?.() || '';

  document.querySelector('[data-code-open-ide]')?.click();
  await wait(30);
  document.querySelector('.code-layout-button:last-child').click();
  current?.setPosition({ lineNumber: 3, column: 4 });
  document.querySelector('#session-tab-activity').click();
  await until(() => !document.querySelector('.task-diff-viewer .monaco-diff-editor') &&
    document.querySelector('#session-panel-activity .task-event-link'), 'first Activity tab open');
  result.activityFirstOpen = {
    rows: document.querySelectorAll('#session-panel-activity .task-event-link').length,
    badgeAbsent: !document.querySelector('#session-tab-activity .task-tab-badge'),
    heading: document.querySelector('#session-panel-activity .task-detail-heading')?.textContent?.trim() || ''
  };
  document.querySelector('#session-tab-changes').click();
  await until(() => document.querySelector('.task-diff-viewer .monaco-diff-editor') && activeEditor(), 'editor remount');
  result.restore = {
    file: document.querySelector('[data-code-file-heading]')?.textContent,
    unified: document.querySelector('.code-layout-button:last-child')?.getAttribute('aria-pressed') === 'true',
    line: activeEditor()?.getPosition?.()?.lineNumber
  };

  const embedded = document.querySelector('.task-diff-viewer');
  embedded.style.width = '380px';
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const workbench = embedded.querySelector('.code-workbench-embedded');
  const explorer = embedded.querySelector('.code-explorer').getBoundingClientRect();
  const diff = embedded.querySelector('.code-editor-pane').getBoundingClientRect();
  result.narrow = {
    stacked: diff.top >= explorer.bottom - 2,
    fits: workbench.scrollWidth <= workbench.clientWidth + 2,
    editorUsable: diff.width >= 280 && diff.height >= 450
  };
  embedded.style.width = '';

  document.querySelector('[data-code-file="src/example.js"]').click();
  await until(() => document.querySelector('[data-code-file-heading]')?.textContent === 'src/example.js', 'file selection');
  result.fileRoute = new URLSearchParams(location.hash.split('?')[1]).get('file');

  location.hash = '#code?workspace=app&task=probe-task&file=src%2Fnew.js&search=legacy&taskStatus=open&from=tasks';
  await until(() => location.hash.startsWith('#tasks?') &&
    new URLSearchParams(location.hash.split('?')[1]).get('tab') === 'changes' &&
    document.querySelector('[data-code-file-heading]')?.textContent === 'src/new.js', 'legacy code route');
  const params = new URLSearchParams(location.hash.split('?')[1]);
  result.legacy = Object.fromEntries(['workspace','task','file','tab','search','taskStatus'].map(key => [key, params.get(key)]));
  result.legacyDiscardedFrom = !params.has('from');

  location.hash = '#tasks?task=historical-task&tab=changes&file=src%2Fretained.js';
  await until(() => document.querySelector('[data-code-editor]')?.textContent.includes('Original task diff unavailable'), 'historical diff fallback');
  result.historicalFallback = Boolean(document.querySelector('[data-code-file="src/retained.js"]')) &&
    !document.querySelector('.task-diff-viewer .monaco-diff-editor');

  location.hash = '#tasks?task=probe-task&tab=changes&file=missing.js';
  await until(() => document.querySelector('[data-code-editor]')?.textContent.includes('not available for this task'), 'missing-file explanation');
  result.missingFilePreserved = new URLSearchParams(location.hash.split('?')[1]).get('file') === 'missing.js';

  snapshot = {
    ...snapshot,
    managedProcesses: [
      { processId: 'proc-task-owned', workSessionId: 'probe-task', workspaceId: 'app', lifecycle: 'task', status: 'running', label: 'Task command', pid: 123 },
      { processId: 'proc-persistent', workSessionId: 'probe-task', workspaceId: 'app', lifecycle: 'persistent', status: 'running', label: 'Persistent server', pid: 124 },
      { processId: 'proc-other', workSessionId: 'another-task', workspaceId: 'app', lifecycle: 'persistent', status: 'orphaned', label: 'Other service', pid: 125 }
    ]
  };
  listeners.forEach(listener => listener());
  location.hash = '#tasks?workspace=app&task=probe-task&tab=processes';
  await until(() => document.querySelector('[data-process-id="proc-task-owned"]') &&
    document.querySelector('[data-process-id="proc-persistent"]'), 'task-owned processes');
  result.processOwnership = {
    taskOwnedVisible: Boolean(document.querySelector('[data-process-id="proc-task-owned"]')),
    persistentVisible: Boolean(document.querySelector('[data-process-id="proc-persistent"]')),
    unrelatedHidden: !document.querySelector('[data-process-id="proc-other"]')
  };

  location.hash = '#tasks?workspace=app&task=probe-task&tab=details';
  await until(() => document.querySelector('#session-panel-details')?.hidden === false, 'task details');
  result.countPresentation = {
    toolCallsVisible: document.querySelector('#session-panel-details')?.textContent.includes('Tool calls') === true,
    activityEventsHidden: document.querySelector('#session-panel-details')?.textContent.includes('Activity events') === false,
    activityBadgeAbsent: !document.querySelector('#session-tab-activity .task-tab-badge')
  };

  location.hash = '#tasks?workspace=app&task=probe-task&search=probe&taskStatus=completed&tab=activity';
  await until(() => document.querySelector('#session-panel-activity .task-activity-view-all') &&
    document.querySelector('[aria-label="Search tasks"]')?.value === 'probe', 'task Activity return origin');
  document.querySelector('#session-panel-activity .task-activity-view-all').click();
  await until(() => document.querySelector('.activity-row-trigger'), 'Activity route row');
  document.querySelector('.activity-row-trigger').click();
  await until(() => document.querySelector('.activity-session-actions a[href^="#tasks"]'), 'Activity return link');
  const activityReturnLink = document.querySelector('.activity-session-actions a[href^="#tasks"]');
  result.activityReturnHref = activityReturnLink.getAttribute('href');
  activityReturnLink.click();
  await until(() => document.querySelector('[aria-label="Search tasks"]')?.value === 'probe' &&
    document.querySelector('[aria-label="Task status filter"]')?.value === 'completed' &&
    document.querySelector('[aria-label="Project filter"]')?.value === 'app' &&
    document.querySelector('[data-task-id="probe-task"]')?.classList.contains('is-selected'), 'restored Tasks context');
  result.activityReturnRestored = true;

  location.hash = '#tasks?task=retry-detail-task';
  await until(() => document.querySelector('[data-task-detail-state="error"]') && document.querySelector('[data-retry-task-detail]'), 'task detail failure');
  result.taskDetailFailure = {
    messageVisible: document.querySelector('[data-task-detail-state]')?.textContent.includes('Temporary detail failure.') === true,
    identifiesTask: document.querySelector('[data-task-detail-state]')?.textContent.includes('retry-detail-task') === true
  };
  retryDetailFails = false;
  document.querySelector('[data-retry-task-detail]').click();
  await until(() => document.querySelector('.task-detail-header h2')?.textContent === 'Recovered retained task', 'task detail retry');
  result.taskDetailRetry = {
    attempts: detailRequests.filter(id => id === 'retry-detail-task').length,
    recovered: !document.querySelector('[data-task-detail-state]')
  };

  location.hash = '#tasks?task=mismatched-detail-task';
  await until(() => document.querySelector('[data-task-detail-state="error"]'), 'mismatched task detail');
  result.mismatchedTaskRejected = document.querySelector('[data-task-detail-state]')?.textContent.includes('did not match') === true;
  return result;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: new URL(details.url).pathname === '/public/dashboard-app.js' });
  });
  try {
    await win.loadURL(targetUrl);
    const result = await win.webContents.executeJavaScript('(' + probeTaskChanges.toString() + ')()');
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  } catch (error) {
    fs.writeFileSync(outputPath, JSON.stringify({
      error: error instanceof Error ? error.stack || error.message : String(error)
    }, null, 2));
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode || 0);
  }
});
