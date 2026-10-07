import { normalizeAppName } from './computerPolicy.ts';

export type AppWindowCandidate = Readonly<{
  windowId: string;
  processId: number;
  processStartedAt: string;
  executablePath: string;
  processName: string;
  productName?: string;
  fileDescription?: string;
  title: string;
  foreground?: boolean;
  visible?: boolean;
  minimized?: boolean;
  displayId?: string;
  displayIds?: readonly string[];
  packageFamily?: string;
  applicationId?: string;
  content?: Readonly<{
    windowId: string; processId: number; processStartedAt: string; executablePath: string;
    processName: string; productName?: string; fileDescription?: string; packageFamily: string; applicationId?: string;
  }>;
}>;

export type ResolvedAppTarget = AppWindowCandidate & Readonly<{
  requestedApp: string;
  canonicalApp: string;
  policyNames: readonly string[];
  identityKey: string;
  approvalBasis: 'executable' | 'product' | 'known-alias' | 'title';
  reacquired: boolean;
}>;
export type AppTargetOptions = Readonly<{
  windowId?: string; windowTitle?: string; displayId?: string;
  approvedApps?: readonly string[]; binding?: ResolvedAppTarget | null;
}>;

const KNOWN_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'google chrome': ['chrome'], chrome: ['chrome'], 'microsoft edge': ['msedge'], edge: ['msedge'],
  'visual studio code': ['code'], 'vs code': ['code'], vscode: ['code'],
  'windows terminal': ['windowsterminal'], terminal: ['windowsterminal'],
  'windows notepad': ['notepad'], notepad: ['notepad'],
  'windows powershell': ['powershell'], 'microsoft word': ['winword'], word: ['winword'],
  'microsoft excel': ['excel'], 'microsoft powerpoint': ['powerpnt'], powerpoint: ['powerpnt'],
  'file explorer': ['explorer'], 'windows explorer': ['explorer'],
  'microsoft photos': ['microsoft.photos', 'microsoft.windows.photos'], photos: ['microsoft.photos', 'microsoft.windows.photos'],
  'microsoft calculator': ['calculatorapp', 'calculator', 'microsoft.windowscalculator'], calculator: ['calculatorapp', 'calculator', 'microsoft.windowscalculator']
});
const RECOGNIZED_POLICY_NAMES = Object.freeze([...Object.keys(KNOWN_ALIASES),
  'firefox', 'mozilla firefox', 'chromium', 'brave', 'brave browser', 'opera', 'opera browser', 'safari', 'arc', 'vivaldi', 'internet explorer',
  'powershell', 'pwsh', 'cmd', 'command prompt', 'iterm', 'iterm2', 'warp', 'alacritty', 'kitty', 'hyper', 'tabby'
]);
const compact = (value: unknown): string => normalizeAppName(value).replace(/\.exe$/i, '').normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
const imagePath = (value: unknown): string => String(value || '').trim().replaceAll('/', '\\').toLowerCase();
const identity = (candidate: AppWindowCandidate) => candidate.content || candidate;
const packageName = (candidate: AppWindowCandidate): string => String(identity(candidate).packageFamily || '').split('_')[0] || '';

function matchIdentity(app: string, candidate: AppWindowCandidate): ResolvedAppTarget['approvalBasis'] | null {
  const current = identity(candidate);
  const normalized = normalizeAppName(app);
  if (normalized.includes('\\') || normalized.includes('/')) {
    return imagePath(normalized) === imagePath(current.executablePath) ? 'executable' : null;
  }
  if (compact(normalized) && compact(normalized) === compact(current.processName)) return 'executable';
  if ([current.productName, current.fileDescription, packageName(candidate)].some(name => name && compact(name) === compact(normalized))) return 'product';
  const aliases = KNOWN_ALIASES[normalized] || [];
  if (aliases.some(alias => compact(alias) === compact(current.processName) || compact(alias) === compact(packageName(candidate)))) return 'known-alias';
  return null;
}

function appTargetIdentityKey(candidate: AppWindowCandidate): string {
  const current = identity(candidate);
  return current.packageFamily
    ? ['package', normalizeAppName(current.packageFamily), normalizeAppName(current.applicationId || current.processName)].join('\u0000')
    : ['executable', imagePath(current.executablePath)].join('\u0000');
}

export function isResolvedAppApproved(target: ResolvedAppTarget, approvedApps: readonly string[]): boolean {
  return approvedApps.some(app => Boolean(matchIdentity(app, target)));
}

function validCandidate(value: AppWindowCandidate): boolean {
  const validProcess = (process: AppWindowCandidate | NonNullable<AppWindowCandidate['content']>) =>
    /^[1-9][0-9]*$/.test(String(process.windowId || '')) && Number.isSafeInteger(process.processId) && process.processId > 0
    && /^[1-9][0-9]*$/.test(String(process.processStartedAt || '')) && Boolean(process.executablePath && process.processName);
  if (!validProcess(value) || value.visible === false) return false;
  if (normalizeAppName(value.processName) === 'applicationframehost' && !value.content?.packageFamily) return false;
  return !value.content || (validProcess(value.content) && Boolean(value.content.packageFamily));
}

function targetError(code: string, message: string, candidates: readonly AppWindowCandidate[] = []): Error {
  const choices = candidates.slice(0, 8).map(item => `windowId ${item.windowId}: ${String(item.title || '(untitled)').slice(0, 120)}`);
  return Object.assign(new Error(message + (choices.length ? ` Candidates: ${choices.join('; ')}` : '')), {
    code, retryable: code === 'COMPUTER_APP_TARGET_STALE', requiresUserConfirmation: false,
    allowedAlternatives: choices.length ? choices : ['Use the application executable/product name and an optional windowTitle or windowId.'],
    candidates: candidates.slice(0, 8).map(item => ({
      windowId: item.windowId, title: String(item.title || '').slice(0, 200),
      app: identity(item).productName || identity(item).processName, foreground: item.foreground === true
    }))
  });
}

export function selectAppTarget(appValue: string, values: readonly AppWindowCandidate[], options: AppTargetOptions = {}): ResolvedAppTarget {
  const app = normalizeAppName(appValue);
  const valid = values.filter(validCandidate).slice(0, 256);
  const direct = valid.map(candidate => ({ candidate, basis: matchIdentity(app, candidate) })).filter(item => item.basis);
  let matches: Array<{ candidate: AppWindowCandidate; basis: ResolvedAppTarget['approvalBasis'] }> = direct.length
    ? direct as Array<{ candidate: AppWindowCandidate; basis: ResolvedAppTarget['approvalBasis'] }>
    : valid.filter(candidate => normalizeAppName(candidate.title) === app).map(candidate => ({ candidate, basis: 'title' }));
  if (options.binding) matches = valid.filter(candidate => appTargetIdentityKey(candidate) === options.binding!.identityKey)
    .map(candidate => ({ candidate, basis: options.binding!.approvalBasis }));
  if (options.displayId) matches = matches.filter(item => item.candidate.displayId === options.displayId || item.candidate.displayIds?.includes(options.displayId!));
  const title = normalizeAppName(options.windowTitle);
  if (title) matches = matches.filter(item => normalizeAppName(item.candidate.title).includes(title));
  const bound = options.binding;
  let reacquired = false;
  if (bound) {
    matches = matches.filter(item => appTargetIdentityKey(item.candidate) === bound.identityKey);
    const same = matches.find(item => item.candidate.windowId === bound.windowId
      && item.candidate.processId === bound.processId && item.candidate.processStartedAt === bound.processStartedAt
      && (!bound.content || (item.candidate.content?.windowId === bound.content.windowId
        && item.candidate.content?.processId === bound.content.processId && item.candidate.content?.processStartedAt === bound.content.processStartedAt)));
    if (same && (!options.windowId || options.windowId === same.candidate.windowId)) matches = [same];
    else {
      // A stale handle may only be replaced by the same authorized executable or
      // package and the same logical window title (or an explicit title filter).
      matches = matches.filter(item => title || normalizeAppName(item.candidate.title) === normalizeAppName(bound.title));
      reacquired = true;
    }
  }
  if (options.windowId && !reacquired) matches = matches.filter(item => item.candidate.windowId === options.windowId);
  if (!matches.length) throw targetError('COMPUTER_APP_TARGET_STALE', 'No matching authorized application window is currently available. Use the executable or product name, or select a current windowTitle/windowId. Restore a minimized app yourself; Rel.AI will not activate or broaden capture automatically.');
  const identities = new Set(matches.map(item => appTargetIdentityKey(item.candidate)));
  if (identities.size !== 1) throw targetError('COMPUTER_APP_TARGET_AMBIGUOUS', 'This name matches more than one application identity. Use the exact executable path or an already approved application with windowTitle/windowId.', matches.map(item => item.candidate));
  if (matches.length > 1) {
    const foreground = matches.filter(item => item.candidate.foreground === true);
    if (foreground.length === 1 && !reacquired) matches = foreground;
    else throw targetError('COMPUTER_APP_TARGET_AMBIGUOUS', 'Several windows belong to this approved app. Select one with windowTitle or windowId; no window was captured.', matches.map(item => item.candidate));
  }
  const selected = matches[0];
  if (!selected) throw targetError('COMPUTER_APP_TARGET_STALE', 'The selected app window is no longer available.');
  const current = identity(selected.candidate);
  return Object.freeze({
    ...selected.candidate, requestedApp: app, canonicalApp: normalizeAppName(current.processName),
    // Only canonical executable names and exact recognized product aliases are
    // tier inputs. Arbitrary Windows version prose can contain words such as
    // 'Operating' and must not accidentally match the legacy 'opera' substring.
    policyNames: Object.freeze([current.processName, ...RECOGNIZED_POLICY_NAMES.filter(name =>
      [current.productName, current.fileDescription].some(value => value && compact(value) === compact(name)))]),
    identityKey: appTargetIdentityKey(selected.candidate), approvalBasis: selected.basis, reacquired
  });
}
