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
      history.replaceState(null, '', '#code?task=probe-task&file=src%2Fnew.js');
      const host = document.createElement('div');
      document.body.replaceChildren(host);
      const module = await import('/public/dashboard-react.js');
      let snapshot = {
        tasks: [
          { work_id: 'probe-task', title: 'Changes viewer probe', status: 'running', workspace: 'app', changedFiles: ['src/example.js', 'src/new.js'] },
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
      snapshot = {
        ...snapshot,
        tasks: snapshot.tasks.map(task => ({ ...task, updatedAt: '2026-09-06T03:20:00.000Z' })),
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
      result.invalidFileFallback = {
        heading: document.querySelector('[data-code-file-heading]')?.textContent.trim() || '',
        routeFile: new URLSearchParams(location.hash.split('?')[1] || '').get('file')
      };
      location.hash = '#tasks?task=probe-task';
      for (let attempt = 0; attempt < 20 && !document.querySelector('[data-task-id="probe-task"]'); attempt += 1) await wait(25);
      document.querySelector('[data-task-id="probe-task"]')?.click();
      for (let attempt = 0; attempt < 20 && !document.querySelector('.task-file-link'); attempt += 1) await wait(25);
      result.taskFileHrefs = [...document.querySelectorAll('.task-file-link')].map(link => link.getAttribute('href') || '');
      result.editorCountAfterUnmount = window.monaco?.editor?.getEditors?.().length || 0;
      result.modelCountAfterUnmount = window.monaco?.editor?.getModels?.().length || 0;
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
