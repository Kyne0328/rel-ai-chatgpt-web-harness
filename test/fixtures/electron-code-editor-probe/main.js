const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const targetUrl = process.env.RELAI_PROBE_TARGET_URL;
const outputPath = process.env.RELAI_PROBE_OUTPUT_PATH;

if (!targetUrl || !outputPath) throw new Error('Code editor probe requires RELAI_PROBE_TARGET_URL and RELAI_PROBE_OUTPUT_PATH.');

app.whenReady().then(async () => {
  const cspErrors = [];
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.webContents.on('console-message', (_event, _level, message) => {
    if (/content security policy|refused to apply inline style/i.test(String(message || ''))) cspErrors.push(String(message));
  });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: new URL(details.url).pathname === '/public/dashboard-app.js' });
  });

  try {
    await win.loadURL(targetUrl);
    const result = await win.webContents.executeJavaScript(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const until = async (predicate, label) => {
        const deadline = Date.now() + 5000;
        while (!predicate()) {
          if (Date.now() >= deadline) throw new Error('Timed out waiting for ' + label);
          await wait(10);
        }
      };
      const nativeFetch = window.fetch.bind(window);
      const detailRequests = [];
      let retryDetailFails = true;
      let releaseSlowDetail;
      const activityEntries = [
        { eventId: 'task-return-event', timestamp: new Date().toISOString(), tool: 'relai_read', title: 'Read fixture', summary: 'Activity return context fixture', status: 'succeeded', workspace: 'app', taskId: 'probe-task' },
        { eventId: 'other-task-event', timestamp: new Date().toISOString(), tool: 'relai_read', title: 'Read fixture', summary: 'Different task activity fixture', status: 'succeeded', workspace: 'app', taskId: 'no-change-task' }
      ];
      const taskSession = (id, title) => ({ work_id: id, title, workspace: 'app', status: 'completed', events: [], changedFiles: [] });
      window.fetch = async (input, options) => {
        const url = new URL(String(input), location.href);
        if (url.pathname === '/api/logs') return new Response(JSON.stringify({ ok: true, entries: activityEntries }), { headers: { 'Content-Type': 'application/json' } });
        if (url.pathname !== '/api/tasks/session') return nativeFetch(input, options);
        const id = url.searchParams.get('task');
        detailRequests.push(id);
        const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
        if (id === 'retry-detail-task') return retryDetailFails
          ? respond({ ok: false, error: 'Temporary detail failure.' }, 503)
          : respond({ ok: true, session: taskSession(id, 'Recovered retained task') });
        if (id === 'slow-detail-task') return new Promise(resolve => { releaseSlowDetail = () => resolve(respond({ ok: true, session: taskSession(id, 'Stale delayed task') })); });
        if (id === 'mismatched-detail-task') return respond({ ok: true, session: taskSession('another-task', 'Wrong task') });
        if (id === 'missing-detail-task') return respond({ ok: false, error: 'Work session not found.' }, 404);
        if (id === 'summary-error-task') return respond({ ok: false, error: 'Summary details temporarily unavailable.' }, 503);
        const summary = snapshot.tasks.find(task => task.work_id === id);
        return summary ? respond({ ok: true, session: { ...summary, events: activityEntries.filter(entry => entry.taskId === id) } }) : respond({ ok: false, error: 'Work session not found.' }, 404);
      };
      history.replaceState(null, '', '#code?task=probe-task&file=src%2Fnew.js');
      const host = document.createElement('div');
      document.body.replaceChildren(host);
      const module = await import('/public/dashboard-react.js');
      let snapshot = {
        config: { workspaces: [{ alias: 'app' }] },
        tasks: [
          { work_id: 'probe-task', changeRevision: 1, title: 'Changes viewer probe', status: 'running', workspace: 'app', changedFiles: ['src/example.js', 'src/new.js'] },
          { work_id: 'no-change-task', title: 'No changes', status: 'completed', workspace: 'app', changedFiles: [] },
          { work_id: 'support-only-task', title: 'Support only', status: 'completed', workspace: 'app', changedFiles: ['tools/helper.jar'] }
        ],
        live: { revisions: { task: 1 } }
      };
      const listeners = new Set();
      const store = {
        getSnapshot: () => snapshot,
        subscribe: listener => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }
      };
      module.mountReactFoundation(host, store);
      window.dispatchEvent(new CustomEvent('relai:route-change', {
        detail: { section: 'code', path: 'code', params: new URLSearchParams('task=probe-task') }
      }));
      for (let attempt = 0; attempt < 50 && (!document.querySelector('.monaco-editor .view-lines') || typeof window.monaco?.editor?.colorize !== 'function'); attempt += 1) await wait(50);
      await wait(300);
      const editorBefore = document.querySelector('.monaco-diff-editor');
      const editors = window.monaco?.editor?.getEditors?.() || [];
      const liveEditor = editors.find(editor => editor.getModel?.()?.getValue?.()?.includes('const answer = 42;')) || editors.at(-1) || null;
      const model = liveEditor?.getModel?.() || null;
      const readOnly = liveEditor?.getOption?.(window.monaco.editor.EditorOption.readOnly) === true;
      const modelLanguage = model?.getLanguageId?.() || '';
      const modelValue = model?.getValue?.() || '';
      const editorHtml = editorBefore?.innerHTML || '';
      const theme = document.documentElement.dataset.theme === 'light' ? 'vs' : 'vs-dark';
      const colorizedHtml = await window.monaco.editor.colorize(modelValue, modelLanguage, { theme });
      const colorProbe = document.createElement('div');
      colorProbe.style.position = 'fixed';
      colorProbe.style.left = '-10000px';
      colorProbe.innerHTML = colorizedHtml;
      document.body.appendChild(colorProbe);
      const tokenColors = [...new Set([...colorProbe.querySelectorAll('span')]
        .map(token => getComputedStyle(token).color)
        .filter(Boolean))];
      colorProbe.remove();
      const lineHeight = liveEditor?.getOption?.(window.monaco.editor.EditorOption.lineHeight) || 0;
      const lineTops = liveEditor
        ? Array.from({ length: Math.min(5, model?.getLineCount?.() || 0) }, (_, index) => liveEditor.getTopForLineNumber(index + 1))
        : [];
      liveEditor?.setPosition?.({ lineNumber: 3, column: 10 });
      const positionBeforeLiveUpdate = liveEditor?.getPosition?.() || null;
      const rectFor = selector => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        return box ? { width: box.width, height: box.height, top: box.top, left: box.left } : null;
      };
      window.relaiCodeProbe.setRevision(2);
      snapshot = {
        ...snapshot,
        tasks: snapshot.tasks.map(task => task.work_id === 'probe-task' ? { ...task, changeRevision: 2 } : task),
        live: { revisions: { task: 2 } }
      };
      listeners.forEach(listener => listener());
      await wait(150);
      const positionAfterLiveUpdate = liveEditor?.getPosition?.() || null;
      const result = {
        editorPresent: Boolean(editorBefore),
        inlineDiffEditor: Boolean(document.querySelector('.monaco-diff-editor')),
        readOnly,
        saveButtonPresent: Boolean(document.querySelector('[data-code-save]')),
        changedFileRows: [...document.querySelectorAll('[data-code-file]')].map(button => button.dataset.codeFile || ''),
        taskOptions: [...document.querySelectorAll('[data-code-task] option')].map(option => option.value),
        taskReturnHref: document.querySelector('[data-code-task-link]')?.getAttribute('href') || '',
        selectedFileHeading: document.querySelector('[data-code-file-heading]')?.textContent.trim() || '',
        statusBadges: [...document.querySelectorAll('[data-code-file]')].map(button => {
          const marker = button.querySelector('.code-file-marker');
          const style = marker ? getComputedStyle(marker) : null;
          const box = marker?.getBoundingClientRect?.();
          return {
            path: button.dataset.codeFile || '',
            code: marker?.textContent?.trim() || '',
            title: button.getAttribute('title') || '',
            fontSize: style ? Number.parseFloat(style.fontSize) : 0,
            width: box?.width || 0,
            height: box?.height || 0
          };
        }),
        sameEditorAfterLiveUpdate: editorBefore === document.querySelector('.monaco-diff-editor'),
        sameModelAfterLiveUpdate: model === liveEditor?.getModel?.(),
        freshModelAfterLiveUpdate: liveEditor?.getModel?.()?.getValue?.() || '',
        modelLanguage,
        modelValue,
        tokenColors,
        lineHeight,
        lineTops,
        positionBeforeLiveUpdate,
        positionAfterLiveUpdate,
        editorHtmlSample: editorHtml.slice(0, 1000),
        geometry: {
          host: rectFor('[data-code-editor]'),
          pane: rectFor('.code-editor-pane'),
          workbench: rectFor('.code-workbench'),
          monaco: rectFor('.monaco-editor:not(.gutter)')
        }
      };
      // Older same-path responses must not overwrite the latest task revision.
      window.relaiCodeProbe.setRevision(3, 300);
      snapshot = { ...snapshot, tasks: snapshot.tasks.map(task => task.work_id === 'probe-task' ? { ...task, changeRevision: 3 } : task) };
      listeners.forEach(listener => listener());
      await wait(35);
      window.relaiCodeProbe.setRevision(4, 20);
      snapshot = { ...snapshot, tasks: snapshot.tasks.map(task => task.work_id === 'probe-task' ? { ...task, changeRevision: 4 } : task) };
      listeners.forEach(listener => listener());
      await wait(350);
      result.modelAfterOutOfOrderRefresh = liveEditor?.getModel?.()?.getValue?.() || '';
      window.relaiCodeProbe.setRevision(5, 20);
      document.querySelector('[data-code-refresh]')?.click();
      await wait(100);
      result.modelAfterManualRefresh = liveEditor?.getModel?.()?.getValue?.() || '';
      // Navigate to another file without unmounting Changes. The URL and the
      // rendered diff must agree even when the task itself has not changed.
      location.hash = '#code?task=probe-task&file=src%2Fexample.js';
      await wait(200);
      result.sameTaskFileNavigation = {
        heading: document.querySelector('[data-code-file-heading]')?.textContent.trim() || '',
        routeFile: new URLSearchParams(location.hash.split('?')[1] || '').get('file')
      };
      document.querySelector('[data-code-file="src/new.js"]')?.click();
      location.hash = '#activity?task=outside-task';
      await wait(200);
      result.routeAfterPendingDiff = location.hash;
      location.hash = '#code?task=probe-task&file=missing.js';
      await wait(250);
      await until(() => document.querySelector('[data-code-editor][role="alert"]')?.textContent.includes('missing.js'), 'missing requested file explanation');
      result.invalidFileContext = {
        heading: document.querySelector('[data-code-file-heading]')?.textContent.trim() || '',
        routeFile: new URLSearchParams(location.hash.split('?')[1] || '').get('file'),
        recoveryVisible: document.querySelector('[data-code-editor]')?.textContent.includes('Choose a changed file or refresh') === true,
        selectedOtherFile: Boolean(document.querySelector('[data-code-file].active'))
      };
      location.hash = '#code?task=retained-task&file=src%2Fretained.js';
      await until(() => document.querySelector('[data-code-task]')?.value === 'retained-task' && document.querySelector('[data-code-file="src/retained.js"]') && document.querySelector('.monaco-diff-editor'), 'retained task changes');
      result.retainedTaskIdentity = {
        selected: document.querySelector('[data-code-task]')?.value,
        routeTask: new URLSearchParams(location.hash.split('?')[1]).get('task'),
        heading: document.querySelector('[data-code-file-heading]')?.textContent.trim(),
        requested: window.relaiCodeProbe.taskRequests().at(-1),
        otherTaskAvailable: Boolean(document.querySelector('[data-code-task] option[value="probe-task"]'))
      };
      location.hash = '#code?task=unavailable-task&file=src%2Fretained.js';
      await until(() => document.querySelector('[data-code-task-error]') && document.querySelector('[data-code-refresh]')?.textContent === 'Retry', 'unavailable retained task retry');
      result.unavailableTaskContext = {
        selected: document.querySelector('[data-code-task]')?.value,
        routeTask: new URLSearchParams(location.hash.split('?')[1]).get('task'),
        routeFile: new URLSearchParams(location.hash.split('?')[1]).get('file'),
        errorIdentifiesTask: document.querySelector('[data-code-task-error]')?.textContent.includes('unavailable-task') === true,
        returnTask: new URLSearchParams(document.querySelector('[data-code-task-link]')?.hash.split('?')[1]).get('task')
      };
      window.relaiCodeProbe.setUnavailableTaskAvailable(true);
      document.querySelector('[data-code-refresh]').click();
      await until(() => !document.querySelector('[data-code-task-error]') && document.querySelector('[data-code-file="src/retained.js"]') && document.querySelector('.monaco-diff-editor'), 'retained task retry recovery');
      result.unavailableTaskRecovered = document.querySelector('[data-code-task]')?.value === 'unavailable-task';
      const aggregateTasks = snapshot.tasks;
      snapshot = { ...snapshot, tasks: [] };
      listeners.forEach(listener => listener());
      location.hash = '#code?task=retained-task&file=src%2Fretained.js';
      await until(() => document.querySelector('[data-code-task]')?.value === 'retained-task' && document.querySelector('[data-code-file="src/retained.js"]') && document.querySelector('.monaco-diff-editor'), 'retained task without aggregate summaries');
      result.retainedTaskWithoutSummaries = [...document.querySelectorAll('[data-code-task] option')].map(option => option.value);
      snapshot = { ...snapshot, tasks: aggregateTasks };
      listeners.forEach(listener => listener());
      location.hash = '#tasks?task=probe-task';
      for (let attempt = 0; attempt < 20 && !document.querySelector('[data-task-id="probe-task"]'); attempt += 1) await wait(25);
      document.querySelector('[data-task-id="probe-task"]')?.click();
      for (let attempt = 0; attempt < 20 && !document.querySelector('.task-file-link'); attempt += 1) await wait(25);
      result.taskFileHrefs = [...document.querySelectorAll('.task-file-link')].map(link => link.getAttribute('href') || '');
      result.editorCountAfterUnmount = window.monaco?.editor?.getEditors?.().length || 0;
      result.modelCountAfterUnmount = window.monaco?.editor?.getModels?.().length || 0;
      location.hash = '#tasks?workspace=app&task=probe-task&search=Changes+viewer&taskStatus=open';
      await until(() => document.querySelector('[aria-label="Search tasks"]')?.value === 'Changes viewer' && document.querySelector('[aria-label="Task status filter"]')?.value === 'open' && document.querySelector('.task-file-link')?.hash.includes('from=tasks'), 'task filter route hydration');
      result.scopedTaskFileHref = document.querySelector('.task-file-link').getAttribute('href');
      document.querySelector('.task-file-link').click();
      await until(() => document.querySelector('[data-code-task-link]')?.hash.includes('search=Changes+viewer'), 'contextual return link');
      result.filteredTaskReturnHref = document.querySelector('[data-code-task-link]').getAttribute('href');
      document.querySelector('[data-code-task-link]').click();
      await until(() => document.querySelector('[aria-label="Search tasks"]')?.value === 'Changes viewer' && document.querySelector('[data-task-id="probe-task"].is-selected'), 'restored task selection');
      result.restoredTaskContext = {
        search: document.querySelector('[aria-label="Search tasks"]')?.value,
        status: document.querySelector('[aria-label="Task status filter"]')?.value,
        workspace: document.querySelector('[aria-label="Project filter"]')?.value,
        selected: document.querySelector('.task-row.is-selected')?.dataset.taskId,
        scopeExplained: document.querySelector('[data-task-search-scope]')?.textContent.includes('loaded tasks') === true
      };
      document.querySelector('#session-tab-activity').click();
      const taskActivityLink = () => document.querySelector('#session-panel-activity .session-inline-actions a');
      const activityTaskLink = () => document.querySelector('.activity-session-actions a[href^="#tasks"]');
      await until(() => taskActivityLink(), 'task Activity link');
      result.scopedTaskActivityHref = taskActivityLink().getAttribute('href');
      result.taskEventActivityHref = document.querySelector('[data-task-event-link]')?.getAttribute('href');
      taskActivityLink().click();
      await until(() => document.querySelector('.activity-row-trigger')?.textContent.includes('Activity return context fixture'), 'contextual task activity');
      result.activityOwnFiltersInitiallyEmpty = !new URLSearchParams(location.hash.split('?')[1]).has('search') && !new URLSearchParams(location.hash.split('?')[1]).has('status');
      document.querySelector('.activity-row-trigger').click();
      await until(() => activityTaskLink(), 'Activity task return link');
      const activitySearch = document.querySelector('input[placeholder="Search activity"]');
      activitySearch.value = 'Activity return context';
      activitySearch.dispatchEvent(new Event('input', { bubbles: true }));
      await until(() => new URLSearchParams(location.hash.split('?')[1]).get('search') === 'Activity return context', 'independent Activity search');
      result.activityTaskReturnHref = activityTaskLink().getAttribute('href');
      document.querySelector('.activity-session-actions a[href^="#activity"]').click();
      await until(() => !new URLSearchParams(location.hash.split('?')[1]).has('search') && new URLSearchParams(location.hash.split('?')[1]).get('returnSearch') === 'Changes viewer', 'Task activity retains origin context');
      result.activityNestedReturnHref = activityTaskLink().getAttribute('href');
      activityTaskLink().click();
      await until(() => document.querySelector('[aria-label="Search tasks"]')?.value === 'Changes viewer' && document.querySelector('[data-task-id="probe-task"].is-selected'), 'Tasks Activity Tasks roundtrip');
      result.activityRestoredTaskContext = {
        search: document.querySelector('[aria-label="Search tasks"]')?.value,
        status: document.querySelector('[aria-label="Task status filter"]')?.value,
        workspace: document.querySelector('[aria-label="Project filter"]')?.value,
        selected: document.querySelector('.task-row.is-selected')?.dataset.taskId
      };
      location.hash = '#tasks?task=probe-task&search=Changes+viewer&taskStatus=open';
      await until(() => document.querySelector('[aria-label="Project filter"]')?.value === '' && taskActivityLink()?.hash.includes('returnSearch=Changes+viewer'), 'all-projects Tasks Activity context');
      document.querySelector('#session-tab-activity').click();
      taskActivityLink().click();
      await until(() => document.querySelector('.activity-row-trigger'), 'all-projects origin task activity');
      document.querySelector('.activity-row-trigger').click();
      await until(() => activityTaskLink(), 'all-projects origin Activity return link');
      result.activityAllProjectsReturnHref = activityTaskLink().getAttribute('href');
      activityTaskLink().click();
      await until(() => document.querySelector('[aria-label="Search tasks"]')?.value === 'Changes viewer' && document.querySelector('[data-task-id="probe-task"].is-selected'), 'all-projects Activity roundtrip');
      result.activityAllProjectsRestored = document.querySelector('[aria-label="Project filter"]')?.value === '';
      location.hash = '#activity?workspace=app&task=no-change-task&time=all&from=tasks&returnTask=probe-task&returnWorkspace=app&returnSearch=Changes+viewer&returnTaskStatus=open';
      await until(() => document.querySelector('.activity-row-trigger')?.textContent.includes('Different task activity fixture'), 'different Activity task selection');
      document.querySelector('.activity-row-trigger').click();
      await until(() => activityTaskLink()?.hash.includes('task=no-change-task'), 'different task return link');
      result.activityDifferentTaskReturnHref = activityTaskLink().getAttribute('href');
      location.hash = '#tasks?task=probe-task&search=nomatch&taskStatus=completed';
      await until(() => document.querySelector('[aria-label="Search tasks"]')?.value === 'nomatch' && document.querySelector('[aria-label="Task status filter"]')?.value === 'completed', 'changed task filters');
      result.filteredSelection = {
        emptyExplainsLoadedScope: document.querySelector('.task-list .empty')?.textContent.includes('No loaded tasks match') === true,
        selectionExplained: Boolean(document.querySelector('[data-task-selection-context]')),
        selectedTaskVisible: document.querySelector('.task-detail-header h2')?.textContent === 'Changes viewer probe'
      };
      location.hash = '#tasks?task=probe-task';
      await until(() => document.querySelector('[aria-label="Search tasks"]')?.value === '' && document.querySelector('.task-file-link')?.hash.includes('from=tasks'), 'all projects task route');
      document.querySelector('.task-file-link').click();
      await until(() => document.querySelector('[data-code-task-link]'), 'all projects return link');
      result.allProjectsReturnHref = document.querySelector('[data-code-task-link]').getAttribute('href');
      location.hash = '#tasks?task=retry-detail-task';
      await until(() => document.querySelector('[data-task-detail-state="error"]') && document.querySelector('[data-retry-task-detail]'), 'structured detail error');
      result.taskDetailFailure = {
        identifiesTask: document.querySelector('[data-task-detail-state]')?.textContent.includes('retry-detail-task') === true,
        selectPromptAbsent: !document.querySelector('[data-session-inspector]')?.textContent.includes('Select a task'),
        messageVisible: document.querySelector('[data-task-detail-state]')?.textContent.includes('Temporary detail failure.') === true
      };
      retryDetailFails = false;
      document.querySelector('[data-retry-task-detail]').click();
      await until(() => document.querySelector('.task-detail-header h2')?.textContent === 'Recovered retained task', 'detail retry success');
      result.taskDetailRetry = {
        attempts: detailRequests.filter(id => id === 'retry-detail-task').length,
        errorCleared: !document.querySelector('[data-task-detail-state]'),
        routeTask: new URLSearchParams(location.hash.split('?')[1]).get('task')
      };
      location.hash = '#tasks?task=missing-detail-task';
      await until(() => document.querySelector('[data-task-detail-state="unavailable"]'), 'missing task distinction');
      result.missingTaskDetails = {
        retryVisible: Boolean(document.querySelector('[data-retry-task-detail]')),
        identifiesTask: document.querySelector('[data-task-detail-state]')?.textContent.includes('missing-detail-task') === true
      };
      location.hash = '#tasks?task=mismatched-detail-task';
      await until(() => document.querySelector('[data-task-detail-state="error"]'), 'mismatched task rejection');
      result.mismatchedTaskRejected = !document.querySelector('.task-detail-header h2') && document.querySelector('[data-task-detail-state]')?.textContent.includes('did not match') === true;
      snapshot = { ...snapshot, tasks: [...snapshot.tasks, taskSession('summary-error-task', 'Last available summary')] };
      listeners.forEach(listener => listener());
      location.hash = '#tasks?task=summary-error-task';
      await until(() => document.querySelector('[data-task-detail-state="error"]') && document.querySelector('.task-detail-header h2')?.textContent === 'Last available summary', 'preserved summary on hydration failure');
      result.summarySurvivesDetailFailure = document.querySelector('[data-task-detail-state]')?.textContent.includes('Showing the last available task details.') === true;
      location.hash = '#tasks?task=slow-detail-task';
      await until(() => releaseSlowDetail && document.querySelector('[data-task-detail-state="loading"]'), 'pending retained task');
      result.taskDetailLoading = {
        loading: document.querySelector('[data-task-detail-state]')?.getAttribute('aria-busy') === 'true',
        selectPromptAbsent: !document.querySelector('[data-session-inspector]')?.textContent.includes('Select a task')
      };
      location.hash = '#tasks?task=retry-detail-task';
      await until(() => document.querySelector('.task-detail-header h2')?.textContent === 'Recovered retained task', 'newer task selection');
      releaseSlowDetail();
      await wait(0);
      await wait(0);
      result.lateTaskDetailsIgnored = document.querySelector('.task-detail-header h2')?.textContent === 'Recovered retained task';
      location.hash = '#home';
      await wait(50);
      return result;
    })()`);
    result.cspErrors = cspErrors;
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  } catch (error) {
    fs.writeFileSync(outputPath, JSON.stringify({ error: error instanceof Error ? error.stack || error.message : String(error), cspErrors }, null, 2));
    process.exitCode = 1;
  } finally {
    win.destroy();
    app.exit(process.exitCode || 0);
  }
});
