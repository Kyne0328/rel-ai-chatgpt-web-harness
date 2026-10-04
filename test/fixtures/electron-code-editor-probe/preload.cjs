const { contextBridge } = require('electron');

const content = [
  'const answer = 42;',
  'function greet(name) {',
  '  return `hello ${name}`; // greeting',
  '}',
  'greet("Rel.AI");'
].join('\n');

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
      await new Promise(resolve => setTimeout(resolve, 75));
      return {
      ok: true,
      work_id: 'probe-task',
      workspace: 'app',
      path: requestedPath,
      content,
      baseContent: 'const answer = 0;\n',
      sha256: 'a'.repeat(64),
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
