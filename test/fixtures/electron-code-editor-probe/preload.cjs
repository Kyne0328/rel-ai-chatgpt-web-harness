const { contextBridge } = require('electron');

let revision = 1;
let unavailableTaskAvailable = false;
const taskRequests = [];
let historicalDiffRequests = 0;
let diffDelayMs = 75;
let content = [
  'const answer = 42;',
  'function greet(name) {',
  '  return `hello ${name}`; // greeting',
  '}',
  'greet("Rel.AI");'
].join('\n');

contextBridge.exposeInMainWorld('relaiCodeProbe', {
  taskRequests: () => [...taskRequests],
  historicalDiffRequests: () => historicalDiffRequests,
  setUnavailableTaskAvailable: value => { unavailableTaskAvailable = value; },
  setRevision(value, delayMs = 75) {
    revision = value;
    diffDelayMs = delayMs;
    content = content.replace(/const answer = [0-9]+;/, `const answer = ${41 + value};`);
  }
});

contextBridge.exposeInMainWorld('relaiDesktop', {
  codeWorkspace: {
    editors: async () => ({ editors: [] }),
    get: async taskId => {
      taskRequests.push(taskId);
      if (taskId === 'unavailable-task' && !unavailableTaskAvailable) throw new Error('Retained task unavailable.');
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
      changedFiles: retained ? ['src/retained.js'] : ['src/example.js', 'src/new.js'],
      changedFileStatuses: {
        'src/example.js': { code: 'M', label: 'Modified', tone: 'warning' },
        'src/new.js': { code: 'U', label: 'Untracked', tone: 'info' }
      },
      changedFileCount: 2,
      fileCount: 2,
      historyMode: taskId === 'historical-task' ? 'unavailable' : 'live',
      historyAvailable: taskId !== 'historical-task',
      commitHead: '',
      commitHeads: [],
      commitSource: '',
      truncated: false
    });
    },
    diff: async (taskId, requestedPath) => {
      if (taskId === 'historical-task') {
        historicalDiffRequests++;
        return { ok: true, work_id: taskId, workspace: 'app', path: requestedPath,
          content: content, exists: true, baseAvailable: false,
          historyMode: 'unavailable', historyAvailable: false, language: 'javascript', readOnly: true };
      }
      const requestedContent = content;
      const requestedRevision = revision;
      await new Promise(resolve => setTimeout(resolve, diffDelayMs));
      return {
      ok: true,
      work_id: taskId,
      workspace: 'app',
      path: requestedPath,
      content: requestedContent,
      baseContent: 'const answer = 0;\n',
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
