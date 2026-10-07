const { contextBridge } = require('electron');

let revision = 1;
let diffDelayMs = 75;
let content = [
  'const answer = 42;',
  'function greet(name) {',
  '  return `hello ${name}`; // greeting',
  '}',
  'greet("Rel.AI");'
].join('\n');

contextBridge.exposeInMainWorld('relaiCodeProbe', {
  setRevision(value, delayMs = 75) {
    revision = value;
    diffDelayMs = delayMs;
    content = content.replace(/const answer = [0-9]+;/, `const answer = ${41 + value};`);
  }
});

contextBridge.exposeInMainWorld('relaiDesktop', {
  codeWorkspace: {
    editors: async () => ({ editors: [] }),
    get: async () => ({
      ok: true,
      work_id: 'probe-task',
      workspace: 'app',
      workspaceMode: 'visible',
      integrationStatus: 'not_applicable',
      status: 'running',
      readOnly: true,
      writable: false,
      files: ['src/example.js', 'src/new.js'],
      changedFiles: ['src/example.js', 'src/new.js'],
      changedFileStatuses: {
        'src/example.js': { code: 'M', label: 'Modified', tone: 'warning' },
        'src/new.js': { code: 'U', label: 'Untracked', tone: 'info' }
      },
      changedFileCount: 2,
      fileCount: 2,
      historyMode: 'live',
      historyAvailable: true,
      commitHead: '',
      commitHeads: [],
      commitSource: '',
      truncated: false
    }),
    diff: async (_taskId, requestedPath) => {
      const requestedContent = content;
      const requestedRevision = revision;
      await new Promise(resolve => setTimeout(resolve, diffDelayMs));
      return {
      ok: true,
      work_id: 'probe-task',
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
