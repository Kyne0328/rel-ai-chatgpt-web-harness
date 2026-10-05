import * as path from 'node:path';
import { isClearlyWorkspaceReadOnlyAdb } from './executionControl.js';

const UNSAFE_READ_ONLY_GIT_OPTIONS = new Set([
  '--ext-diff', '--textconv', '--filters', '--open-files-in-pager'
]);
const READ_ONLY_INSPECTION_EXECUTABLES = new Set([
  'cat', 'dir', 'grep', 'head', 'ls', 'pwd', 'tail', 'wc', 'where', 'which'
]);
const READ_ONLY_FIND_UNSAFE_OPTIONS = new Set([
  '-delete', '-exec', '-execdir', '-ok', '-okdir', '-fls', '-fprint', '-fprint0', '-fprintf'
]);
function isClearlyReadOnlyExec(args = {}) {
  if (String(args.input || '').length > 0) return false;
  if (args.env && typeof args.env === 'object' && Object.keys(args.env).length > 0) return false;
  const command = String(args.command || '').trim();
  if (command) {
    const tokens = simpleShellCommandTokens(command);
    if (!tokens) return false;
    return isClearlyReadOnlyDirectExec(tokens[0], tokens.slice(1));
  }
  return isClearlyReadOnlyDirectExec(args.executable, args.argv);
}

function isClearlyReadOnlyDirectExec(executableValue, argvValue) {
  const executable = path.basename(String(executableValue || '')).toLowerCase();
  const argv = Array.isArray(argvValue) ? argvValue.map(value => String(value || '')) : [];
  if (!argv.length) return false;
  if (isReadOnlyWindowsInspection(executable, argv)) return true;
  if (isClearlyWorkspaceReadOnlyAdb(executableValue, argv)) return true;
  if (executable === 'node' || executable === 'node.exe') {
    const first = argv[0].toLowerCase();
    if (['--version', '-v', '--help', '-h'].includes(first)) return argv.length === 1;
    return ['--check', '-c'].includes(first) && argv.length === 2 && !argv[1].startsWith('-');
  }
  const inspectionExecutable = executable.replace(/\.exe$/i, '');
  if (READ_ONLY_INSPECTION_EXECUTABLES.has(inspectionExecutable)) return true;
  if (inspectionExecutable === 'find' || inspectionExecutable === 'findstr') {
    return !argv.some(value => READ_ONLY_FIND_UNSAFE_OPTIONS.has(value.toLowerCase()));
  }
  if (inspectionExecutable === 'diff') {
    const options = argv.map(value => value.toLowerCase());
    return !options.some((value, index) => value === '--output'
      || value.startsWith('--output=')
      || (index > 0 && options[index - 1] === '--output'));
  }
  if (inspectionExecutable === 'rg') {
    const options = argv.map(value => value.toLowerCase());
    return !options.some(value => value === '--pre' || value.startsWith('--pre='));
  }
  if (executable !== 'git' && executable !== 'git.exe') return false;
  if (argv[0].startsWith('-')) return false;
  const optionTokens = argv.slice(1).map(value => value.toLowerCase());
  if (optionTokens.some(value => UNSAFE_READ_ONLY_GIT_OPTIONS.has(value)
    || value === '--output'
    || value.startsWith('--output='))) return false;
  const command = argv[0].toLowerCase();
  if (new Set([
    'status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree',
    'cat-file', 'grep', 'blame', 'shortlog', 'describe', 'merge-base', 'name-rev'
  ]).has(command)) return true;
  if (command === 'branch') {
    return optionTokens.length === 0 || optionTokens.every(value => ['--show-current', '--list', '-a', '-r'].includes(value));
  }
  if (command === 'worktree') return argv.length === 2 && argv[1]?.toLowerCase() === 'list';
  if (command === 'remote') return argv.length === 1 || optionTokens.every(value => value === '-v' || value === '--verbose');
  if (command === 'config') {
    const mode = String(argv[1] || '').toLowerCase();
    if (!['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(mode)) return false;
    return argv.slice(2).every(value => !String(value).startsWith('-'));
  }
  return false;
}

// Only direct, fixed interpreter forms qualify. Never infer read-only behavior
// from a Get-* prefix, aliases, arbitrary scripts, profiles or shell expansion.
function isReadOnlyWindowsInspection(executable, argv) {
  const host = executable.replace(/\.exe$/i, '');
  if (host === 'cmd') {
    return argv.length === 3 && argv[0].toLowerCase() === '/d'
      && argv[1].toLowerCase() === '/c' && /^(?:ver|vol)$/i.test(argv[2]);
  }
  if (host !== 'powershell' && host !== 'pwsh') return false;
  if (argv.length !== 4 || argv[0].toLowerCase() !== '-noprofile'
    || argv[1].toLowerCase() !== '-noninteractive' || argv[2].toLowerCase() !== '-command') return false;
  const script = argv[3];
  if (/^(?:Microsoft\.PowerShell\.Management\\)?Get-(?:Location|Process|Service)$/i.test(script)) return true;
  // Literal filesystem reads, with no expressions, providers or escaping. A
  // quoted path supports spaces, but a quote inside it is deliberately rejected.
  return /^(?:Microsoft\.PowerShell\.Management\\)?(?:Get-Content|Get-Item|Get-ChildItem) -LiteralPath '(?!-)[a-zA-Z0-9_ ./\\:-]+'(?: -Raw)?$/i.test(script)
    && !/ -LiteralPath '(?![a-zA-Z]:[\\/\\\\])[^']*:/i.test(script)
    && !/^(?:.* -LiteralPath ')(?:[^']*::|(?:[^']*:){2})/.test(script)
    && (!/ -Raw$/i.test(script) || /(?:^|\\)Get-Content /i.test(script));
}

function simpleShellCommandTokens(command) {
  const text = String(command || '').trim();
  if (!text || /[\r\n;&|<>`"'$()^]/.test(text)) return null;
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  return tokens;
}

export { isClearlyReadOnlyExec };
