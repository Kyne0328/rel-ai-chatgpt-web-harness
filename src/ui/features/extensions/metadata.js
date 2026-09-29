const EXTENSIONS_REPOSITORY_URL = 'https://github.com/Kyne0328/rel-ai-extensions';
const EXTENSION_SCHEMA_URL = `${EXTENSIONS_REPOSITORY_URL}/blob/main/schema/relai-extension.schema.json`;

const TABS = Object.freeze([
  ['installed', 'Installed'],
  ['discover', 'Discover'],
  ['sources', 'Sources'],
  ['developer', 'Developer']
]);

const PERMISSION_METADATA = Object.freeze({
  'workspace.read': {
    id: 'workspace.read',
    label: 'Read Project Files',
    shortLabel: 'Read Files',
    icon: 'folder',
    description: 'The extension can read project files, folders, and code symbols.',
    category: 'Filesystem'
  },
  'workspace.write': {
    id: 'workspace.write',
    label: 'Modify Project Files',
    shortLabel: 'Edit Files',
    icon: 'fileCode',
    description: 'The extension can create and change project files. Rel.AI applies its normal confirmation rules.',
    category: 'Filesystem'
  },
  'command.execute': {
    id: 'command.execute',
    label: 'Run Terminal Commands',
    shortLabel: 'Execute Commands',
    icon: 'processes',
    description: 'The extension can run its declared CLI commands through Rel.AI.',
    category: 'Execution'
  },
  'git': {
    id: 'git',
    label: 'Git Operations',
    shortLabel: 'Git Access',
    icon: 'code',
    description: 'The extension can read Git status, history, branches, and diffs.',
    category: 'Source Control'
  },
  'network': {
    id: 'network',
    label: 'Network Access',
    shortLabel: 'Network',
    icon: 'browser',
    description: 'The extension can send HTTPS requests to its declared external APIs.',
    category: 'Network'
  },
  'browser': {
    id: 'browser',
    label: 'Web Browser Automation',
    shortLabel: 'Browser',
    icon: 'browser',
    description: 'The extension can control browser interactions and read page content.',
    category: 'Automation'
  },
  'computer': {
    id: 'computer',
    label: 'Desktop Automation',
    shortLabel: 'Desktop',
    icon: 'system',
    description: 'The extension can control desktop apps and capture screenshots.',
    category: 'System'
  }
});

const TEMPLATES = Object.freeze({
  skill: {
    label: 'Skill',
    filename: 'relai-extension.json',
    description: 'Adds reusable instructions and developer workflows to ChatGPT.',
    code: JSON.stringify({
      schemaVersion: 1,
      id: 'yourname.my-custom-skill',
      name: 'My Custom Skill',
      version: '1.0.0',
      description: 'Adds custom engineering instructions and workflows.',
      kind: 'skill',
      compatibility: { relai: '>=1.0.0 <2.0.0' },
      publisher: { name: 'Your Name or Organization', url: 'https://github.com/your-username' },
      repository: 'https://github.com/your-username/relai-extensions',
      permissions: ['workspace.read'],
      requires: { commands: [], platforms: [] },
      entrypoints: { skill: 'SKILL.md' },
      files: [
        { path: 'SKILL.md', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }
      ]
    }, null, 2)
  },
  cliBinary: {
    label: 'CLI tool (single binary)',
    filename: 'relai-extension.json',
    description: 'Adds a managed CLI tool that Rel.AI downloads and verifies.',
    code: JSON.stringify({
      schemaVersion: 1,
      id: 'yourname.my-cli-tool',
      name: 'My CLI Tool',
      version: '1.0.0',
      description: 'Adds a verified CLI command to ChatGPT workflows.',
      kind: 'cli',
      compatibility: { relai: '>=1.0.0 <2.0.0' },
      publisher: { name: 'Your Name or Organization' },
      repository: 'https://github.com/your-username/relai-extensions',
      permissions: ['workspace.read', 'command.execute'],
      requires: { commands: ['mytool'], platforms: [] },
      entrypoints: { skill: 'SKILL.md', command: 'mytool' },
      install: {
        type: 'binary',
        artifacts: [
          {
            platform: 'win32',
            arch: 'x64',
            url: 'https://github.com/your-username/relai-extensions/releases/download/v1.0.0/mytool-win.exe',
            sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
          },
          {
            platform: 'darwin',
            arch: 'arm64',
            url: 'https://github.com/your-username/relai-extensions/releases/download/v1.0.0/mytool-darwin-arm64',
            sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
          }
        ]
      },
      files: [
        { path: 'SKILL.md', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }
      ]
    }, null, 2)
  },
  cliBundle: {
    label: 'CLI tool (ZIP bundle)',
    filename: 'relai-extension.json',
    description: 'Installs a ZIP bundle that contains multiple executables and support files.',
    code: JSON.stringify({
      schemaVersion: 1,
      id: 'yourname.my-tool-suite',
      name: 'My Tool Suite',
      version: '1.0.0',
      description: 'Rel.AI extracts the tool files into managed local storage.',
      kind: 'cli',
      compatibility: { relai: '>=1.0.0 <2.0.0' },
      publisher: { name: 'Your Name or Organization' },
      repository: 'https://github.com/your-username/relai-extensions',
      permissions: ['workspace.read', 'command.execute'],
      requires: { commands: ['tool-primary', 'tool-helper'], platforms: [] },
      entrypoints: { skill: 'SKILL.md', command: 'tool-primary' },
      install: {
        type: 'bundle',
        artifacts: [
          {
            platform: 'win32',
            arch: 'x64',
            url: 'https://github.com/your-username/relai-extensions/releases/download/v1.0.0/suite-win-x64.zip',
            sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            commands: [
              { command: 'tool-primary', path: 'bin/tool-primary.cmd' },
              { command: 'tool-helper', path: 'bin/tool-helper.cmd' }
            ]
          }
        ]
      },
      files: [
        { path: 'SKILL.md', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' }
      ]
    }, null, 2)
  }
});

export { EXTENSIONS_REPOSITORY_URL, EXTENSION_SCHEMA_URL, PERMISSION_METADATA, TABS, TEMPLATES };
