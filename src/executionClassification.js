import * as path from 'node:path';
import { isClearlyWorkspaceReadOnlyAdb } from './executionControl.js';

const UNSAFE_READ_ONLY_GIT_OPTIONS = new Set([
  '--ext-diff', '--textconv', '--filters', '--open-files-in-pager'
]);
const READ_ONLY_INSPECTION_EXECUTABLES = new Set([
  'cat', 'dir', 'grep', 'head', 'ls', 'pgrep', 'ps', 'pwd', 'tail', 'wc', 'where', 'which',
  'file', 'stat', 'strings', 'whoami', 'id', 'hostname', 'uname', 'du', 'df',
  'nm', 'readelf', 'size', 'javap', 'dexdump', 'oatdump', 'zipinfo', 'jq', 'hexdump', 'od'
]);
const READ_ONLY_ZERO_ARG_EXECUTABLES = new Set([
  'pwd', 'dir', 'ls', 'ps', 'whoami', 'id', 'hostname', 'uname'
]);
const READ_ONLY_FIND_UNSAFE_OPTIONS = new Set([
  '-delete', '-exec', '-execdir', '-ok', '-okdir', '-fls', '-fprint', '-fprint0', '-fprintf'
]);

function isClearlyReadOnlyExec(args = {}) {
  if (String(args.input || '').length > 0) return false;
  if (args.env && typeof args.env === 'object' && Object.keys(args.env).length > 0) return false;
  const command = String(args.command || '').trim();
  if (command) {
    const tokens = parseSafeShellTokens(command);
    if (!tokens) return false;
    return isClearlyReadOnlyDirectExec(tokens[0], tokens.slice(1));
  }
  return isClearlyReadOnlyDirectExec(args.executable, args.argv);
}

function isClearlyReadOnlyDirectExec(executableValue, argvValue) {
  const executable = path.basename(String(executableValue || '')).toLowerCase();
  const argv = Array.isArray(argvValue) ? argvValue.map(value => String(value || '')) : [];
  const base = executable.replace(/\.exe$/i, '');

  if (!argv.length) {
    return READ_ONLY_ZERO_ARG_EXECUTABLES.has(base);
  }

  if (isReadOnlyWindowsInspection(executable, argv)) return true;
  if (isClearlyWorkspaceReadOnlyAdb(executableValue, argv)) return true;
  if (isReadOnlyWslInvocation(executable, argv)) return true;
  if (isReadOnlyFastboot(executable, argv)) return true;
  if (isReadOnlyArchiveInspection(executable, argv)) return true;
  if (isReadOnlyRuntimeInspection(executable, argv)) return true;

  if (READ_ONLY_INSPECTION_EXECUTABLES.has(base)) return true;
  if (base === 'find' || base === 'findstr') {
    return !argv.some(value => READ_ONLY_FIND_UNSAFE_OPTIONS.has(value.toLowerCase()));
  }
  if (base === 'tree') {
    return !argv.some(value => value === '-o' || value.startsWith('-o='));
  }
  if (base === 'xxd') {
    return !argv.some(value => value === '-r' || value === '-revert');
  }
  if (base === 'yq') {
    return !argv.some(value => value === '-i' || value === '--inplace'
      || value.startsWith('--inplace=') || value.startsWith('-i='));
  }
  if (base === 'diff') {
    const options = argv.map(value => value.toLowerCase());
    return !options.some((value, index) => value === '--output'
      || value.startsWith('--output=')
      || (index > 0 && options[index - 1] === '--output'));
  }
  if (base === 'rg') {
    const options = argv.map(value => value.toLowerCase());
    return !options.some(value => value === '--pre' || value.startsWith('--pre='));
  }

  if (base !== 'git') return false;
  if (argv[0].startsWith('-')) {
    return argv.length === 1 && ['--version', '-v', '--help', '-h'].includes(argv[0].toLowerCase());
  }
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

function isReadOnlyWslInvocation(executable, argv) {
  const base = executable.replace(/\.exe$/i, '');
  if (base !== 'wsl') return false;
  if (!argv.length) return false;
  const first = String(argv[0] || '').toLowerCase();
  if (['-l', '--list', '--status', '--help', '-h'].includes(first)) return true;
  if (argv.every(token => ['-l', '--list', '--running', '-q', '--quiet', '-v', '--verbose'].includes(String(token).toLowerCase()))) {
    return true;
  }
  let index = 0;
  while (index < argv.length) {
    const token = String(argv[index] || '');
    const lower = token.toLowerCase();
    if (lower === '-d' || lower === '--distribution' || lower === '-u' || lower === '--user' || lower === '--cd') {
      index += 2;
      continue;
    }
    if (lower.startsWith('--distribution=') || lower.startsWith('--user=') || lower.startsWith('--cd=')) {
      index += 1;
      continue;
    }
    if (lower === '--exec' || lower === '-e' || lower === '--') {
      index += 1;
      break;
    }
    if (token.startsWith('-')) return false;
    break;
  }
  if (index >= argv.length) return false;
  const targetExecutable = argv[index];
  const targetArgv = argv.slice(index + 1);
  return isClearlyReadOnlyDirectExec(targetExecutable, targetArgv);
}

function isReadOnlyFastboot(executable, argv) {
  const base = executable.replace(/\.exe$/i, '');
  if (base !== 'fastboot') return false;
  if (!argv.length) return false;
  const first = String(argv[0] || '').toLowerCase();
  if (['--version', '-v', '--help', '-h', 'help'].includes(first)) return true;
  if (first === 'devices' || first === 'getvar') return true;
  return false;
}

function isReadOnlyArchiveInspection(executable, argv) {
  const base = executable.replace(/\.exe$/i, '');
  const lowerArgv = argv.map(v => String(v || '').toLowerCase());
  if (base === 'zipinfo') return true;
  if (base === 'unzip') {
    const hasListOrTest = lowerArgv.some(v => v === '-l' || v === '-v' || v === '-t' || /^-[a-z]*[lvt][a-z]*$/.test(v));
    const hasExtract = lowerArgv.some(v => v === '-d' || v.startsWith('-d='));
    return hasListOrTest && !hasExtract;
  }
  if (base === 'tar') {
    const hasList = lowerArgv.some(v => v === '-t' || v === '--list' || /^-[a-z]*t[a-z]*$/.test(v));
    const hasMutate = lowerArgv.some(v => v === '-x' || v === '-c' || v === '-r' || v === '-u' || v === '-A' || v === '--delete' || /^-[a-z]*[xcruA][a-z]*$/.test(v)
      || v === '--checkpoint-action' || v.startsWith('--checkpoint-action=')
      || v === '--use-compress-program' || v.startsWith('--use-compress-program=')
      || /^-i=/.test(v))
      || argv.some(v => v === '-I' || v.startsWith('-I') || v === '-A' || /^-[a-zA-Z]*A[a-zA-Z]*$/.test(v));
    return hasList && !hasMutate;
  }
  if (base === '7z' || base === '7za' || base === '7zr') {
    const sub = lowerArgv.find(v => !v.startsWith('-'));
    return sub === 'l' || sub === 't';
  }
  return false;
}

function isReadOnlyRuntimeInspection(executable, argv) {
  const base = executable.replace(/\.exe$/i, '');
  const first = String(argv[0] || '').toLowerCase();
  const isVersionOrHelp = ['--version', '-v', '-version', '--help', '-h', '-help', 'help'].includes(first);

  if (base === 'node') {
    if (['--version', '-v', '--help', '-h'].includes(first)) return argv.length === 1;
    return ['--check', '-c'].includes(first) && argv.length === 2 && !argv[1].startsWith('-');
  }
  if (['python', 'python3', 'py'].includes(base)) {
    return isVersionOrHelp && argv.length === 1;
  }
  if (['java', 'javac'].includes(base)) {
    return isVersionOrHelp && argv.length === 1;
  }
  if (['rustc', 'cargo', 'go', 'npm', 'npx', 'pnpm', 'yarn', 'bun'].includes(base)) {
    if (argv.length === 1 && isVersionOrHelp) return true;
    if (base === 'go' && (first === 'version' || first === 'help')) return true;
    if (base === 'cargo' && (first === 'version' || first === 'help')) return true;
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

function parseSafeShellTokens(command) {
  const text = String(command || '').trim();
  if (!text) return null;
  if (/[\r\n;&|<>`^]/.test(text)) return null;

  const tokens = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inSingleQuote) {
      if (char === "'") {
        inSingleQuote = false;
      } else {
        current += char;
      }
    } else if (inDoubleQuote) {
      if (char === '"') {
        inDoubleQuote = false;
      } else if (char === '`' || (char === '$' && text[i + 1] === '(')) {
        return null;
      } else if (char === '\\' && i + 1 < text.length) {
        const next = text[i + 1];
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next;
          i++;
        } else {
          current += char;
        }
      } else {
        current += char;
      }
    } else {
      if (char === "'") {
        inSingleQuote = true;
      } else if (char === '"') {
        inDoubleQuote = true;
      } else if (char === '`' || (char === '$' && text[i + 1] === '(')) {
        return null;
      } else if (/\s/.test(char)) {
        if (current.length > 0) {
          tokens.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }
  }

  if (inSingleQuote || inDoubleQuote) return null;
  if (current.length > 0) tokens.push(current);
  return tokens.length > 0 ? tokens : null;
}

export { isClearlyReadOnlyExec };
