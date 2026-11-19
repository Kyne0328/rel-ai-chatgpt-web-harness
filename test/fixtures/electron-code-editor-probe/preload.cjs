const { contextBridge, ipcRenderer } = require('electron');

let revision = 1;
let copiedPath = null;
let unavailableTaskAvailable = false;
const taskRequests = [];
let historicalDiffRequests = 0;
let diffDelayMs = 75;
let heldPath = '';
let failNextPath = '';
let releaseHeld = null;
let content = [
  'const answer = 42;',
  'function greet(name) {',
  '  return `hello ${name}`; // greeting',
  '}',
  'greet("Rel.AI");'
].join('\n');

contextBridge.exposeInMainWorld('relaiCodeProbe', {
  taskRequests: () => [...taskRequests],
  copiedPath: () => copiedPath,
  pressEnter: () => ipcRenderer.invoke('code-probe:enter'),
  holdDiff(path) { heldPath = path; },
  rejectNextDiff(path) { failNextPath = path; },
  diffIsHeld: () => typeof releaseHeld === 'function',
  releaseDiff() { releaseHeld(); releaseHeld = null; },
  historicalDiffRequests: () => historicalDiffRequests,
  setUnavailableTaskAvailable: value => { unavailableTaskAvailable = value; },
  setRevision(value, delayMs = 75) {
    revision = value;
    diffDelayMs = delayMs;
    content = content.replace(/const answer = [0-9]+;/, `const answer = ${41 + value};`);
  }
});

contextBridge.exposeInMainWorld('relaiDesktop', {
  copyText: async value => { copiedPath = value; return { ok: true }; },
  codeWorkspace: {
    editors: async () => ({ editors: [{ id: 'vscode', label: 'Visual Studio Code' }] }),
    get: async taskId => {
      taskRequests.push(taskId);
      if (taskId === 'unavailable-task' && !unavailableTaskAvailable) throw new Error('Retained task unavailable.');
      if (taskId === 'partial-list-task' || taskId === 'no-change-task') return {
        ok: true, work_id: taskId, workspace: 'app', status: 'completed', changedFiles: [], changedFileCount: 0,
        historyMode: 'live', truncated: taskId === 'partial-list-task'
      };
      const retained = taskId !== 'probe-task';
      return ({
      ok: true,
      work_id: taskId,
      workspace: 'app',
      workspaceMode: 'visible',
      integrationStatus: 'not_applicable',
      status: 'running',
      readOnly: true,
      writable: false,
      files: ['src/example.js', 'src/new.js'],
      changedFiles: taskId === 'mixed-task' ? ['src/example.js', 'src/retained.js']
        : retained ? ['src/retained.js'] : ['src/example.js', 'src/new.js'],
      changedFileStatuses: {
        'src/example.js': { code: 'M', label: 'Modified', tone: 'warning' },
        'src/new.js': { code: 'U', label: 'Untracked', tone: 'info' }
      },
      changedFileCount: 2,
      fileCount: 2,
      historyMode: taskId === 'mixed-task' ? 'mixed' : taskId === 'historical-task' ? 'unavailable' : 'live',
      historyAvailable: taskId !== 'historical-task',
      commitHead: '',
      commitHeads: [],
      commitSource: '',
      truncated: false
    });
    },
    diff: async (taskId, requestedPath) => {
      if (taskId === 'historical-task' || (taskId === 'mixed-task' && requestedPath === 'src/retained.js')) {
        historicalDiffRequests++;
        return { ok: true, work_id: taskId, workspace: 'app', path: requestedPath,
          content: content, exists: true, baseAvailable: false,
          historyMode: 'unavailable', historyAvailable: false, language: 'javascript', readOnly: true };
      }
      if (requestedPath === failNextPath) {
        failNextPath = '';
        throw new Error('Fixture file read interrupted.');
      }
      const requestedContent = content;
      const requestedRevision = revision;
      await new Promise(resolve => setTimeout(resolve, diffDelayMs));
      if (requestedPath === heldPath) {
        heldPath = '';
        await new Promise(resolve => { releaseHeld = resolve; });
      }
      return {
      ok: true,
      work_id: taskId,
      workspace: 'app',
      path: requestedPath,
      content: requestedContent,
      exists: true,
      baseAvailable: taskId !== 'no-baseline-task',
      baseExists: taskId !== 'no-baseline-task' && requestedPath !== 'src/new.js',
      baseContent: taskId === 'no-baseline-task' ? requestedContent : requestedPath === 'src/new.js' ? '' : 'const answer = 0;\n',
      sha256: String(requestedRevision).padStart(64, '0'),
      language: 'javascript',
      writable: false,
      readOnly: true,
      historyMode: 'live',
      commitHead: ''
      };
    },
    openIde: async () => ({ ok: true, editor: { label: 'Probe IDE' } })
  }
});
