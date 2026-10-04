import type { ComputerControlSettingsDto } from '../contracts/computer.ts';

interface ComputerControlConfig {
  readonly computerControl?: { readonly enabled?: unknown; readonly approvedApps?: unknown };
}

const BROWSER_APPS = new Set([
  'chrome', 'google chrome', 'chromium', 'microsoft edge', 'edge', 'msedge',
  'firefox', 'safari', 'brave', 'opera', 'arc', 'vivaldi', 'iexplore', 'internet explorer'
]);
const TERMINAL_APPS = new Set([
  'terminal', 'iterm', 'iterm2', 'vscode', 'visual studio code', 'powershell',
  'pwsh', 'cmd', 'command prompt', 'warp', 'windows terminal', 'wt',
  'alacritty', 'kitty', 'hyper', 'tabby', 'code'
]);
const approvedComputerAppsBySession = new Map<string, Set<string>>();

type ComputerAppTier = 'full' | 'click' | 'read';

class ComputerControlDisabledError extends Error {
  readonly code = 'COMPUTER_CONTROL_DISABLED' as const;
  readonly source = 'rel-ai-mcp-policy' as const;
  readonly operation = 'computer_control' as const;
  readonly retryable = false;
  readonly requiresUserConfirmation = false;
  readonly allowedAlternatives = Object.freeze([
    'Enable Computer control in Rel.AI Settings > App, then retry the requested computer action.'
  ]);

  constructor() {
    super('Computer control is disabled by the local Rel.AI setting. Do not retry this computer action or request MCP approval. Ask the user to enable Computer control in Rel.AI Settings > App, then retry after the setting is enabled.');
    this.name = 'ComputerControlDisabledError';
  }
}

function computerControlSettings(config: ComputerControlConfig | null | undefined): ComputerControlSettingsDto {
  return Object.freeze({ enabled: config?.computerControl?.enabled === true });
}

function assertComputerControlEnabled(config: ComputerControlConfig | null | undefined): void {
  if (!computerControlSettings(config).enabled) throw new ComputerControlDisabledError();
}

function normalizeAppName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function sessionApprovedApps(sessionId: unknown, create = false): Set<string> | null {
  const session = String(sessionId || '').trim();
  if (!session) return null;
  let approved = approvedComputerAppsBySession.get(session) || null;
  if (!approved && create) {
    approved = new Set<string>();
    approvedComputerAppsBySession.set(session, approved);
  }
  return approved;
}

function listComputerApprovedApps(
  config: ComputerControlConfig | null | undefined = null,
  sessionId: unknown = ''
): string[] {
  const fromConfig = Array.isArray(config?.computerControl?.approvedApps)
    ? (config?.computerControl?.approvedApps as unknown[]).map(normalizeAppName).filter(Boolean)
    : [];
  return [...new Set([...fromConfig, ...(sessionApprovedApps(sessionId) || [])])].sort();
}

function approveComputerApp(value: unknown, sessionId: unknown): string {
  const app = normalizeAppName(value);
  if (!app) throw new Error('approve_app requires a non-empty app name.');
  const approved = sessionApprovedApps(sessionId, true);
  if (!approved) throw new Error('approve_app requires an active computer-control session.');
  approved.add(app);
  return app;
}

function revokeComputerApp(value: unknown, sessionId: unknown): string {
  const app = normalizeAppName(value);
  sessionApprovedApps(sessionId)?.delete(app);
  return app;
}

function isComputerAppApproved(
  value: unknown,
  config: ComputerControlConfig | null | undefined = null,
  sessionId: unknown = ''
): boolean {
  const app = normalizeAppName(value);
  if (!app) return false;
  const fromConfig = Array.isArray(config?.computerControl?.approvedApps)
    ? (config?.computerControl?.approvedApps as unknown[]).map(normalizeAppName)
    : [];
  return fromConfig.includes(app) || Boolean(sessionApprovedApps(sessionId)?.has(app));
}

function tierForComputerApp(value: unknown): ComputerAppTier {
  const app = normalizeAppName(value);
  if (!app) return 'full';
  if ([...BROWSER_APPS].some(entry => app === entry || app.includes(entry))) return 'read';
  if ([...TERMINAL_APPS].some(entry => app === entry || app.includes(entry))) return 'click';
  return 'full';
}

function warningForComputerApp(value: unknown): string | null {
  const app = normalizeAppName(value);
  if (!app) return null;
  if ([...TERMINAL_APPS].some(entry => app === entry || app.includes(entry))) {
    return `Approving '${app}' is equivalent to shell access. Prefer relai_desktop or relai_exec when they can complete the task.`;
  }
  if (app.includes('finder') || app.includes('file explorer') || app === 'explorer') {
    return `Approving '${app}' can read or write any file. Keep the task scoped to one app flow at a time.`;
  }
  if (app.includes('settings') || app.includes('system preferences')) {
    return `Approving '${app}' can change system settings. Stay present for sensitive flows.`;
  }
  return null;
}

class ComputerAppApprovalRequiredError extends Error {
  readonly code = 'COMPUTER_APP_APPROVAL_REQUIRED' as const;
  readonly source = 'rel-ai-mcp-policy' as const;
  readonly operation = 'computer_control' as const;
  readonly retryable = false;
  readonly requiresUserConfirmation = true;
  readonly allowedAlternatives: readonly string[];
  readonly app: string;
  readonly tier: ComputerAppTier;
  readonly warning: string | null;

  constructor(app: string) {
    const tier = tierForComputerApp(app);
    const warning = warningForComputerApp(app);
    super(
      `Computer control needs one-time approval for '${app}' (tier: ${tier}). ` +
      `Run the relai_computer approve_app action for '${app}' once per session, then retry. ` +
      `Browsers are view-only: use relai_browser instead of raw clicks. ` +
      `Terminals and IDEs are click-only: use relai_desktop or relai_exec for typing.` +
      (warning ? ` ${warning}` : '')
    );
    this.name = 'ComputerAppApprovalRequiredError';
    this.app = normalizeAppName(app);
    this.tier = tier;
    this.warning = warning;
    this.allowedAlternatives = Object.freeze([
      `Run relai_computer approve_app for '${app}', then retry the requested computer action.`
    ]);
  }
}

class ComputerSessionLockedError extends Error {
  readonly code = 'COMPUTER_SESSION_LOCKED' as const;
  readonly source = 'rel-ai-mcp-policy' as const;
  readonly operation = 'computer_control' as const;
  readonly retryable = false;
  readonly requiresUserConfirmation = false;
  readonly allowedAlternatives: readonly string[];
  readonly lockedBy: string;

  constructor(lockedBy: string) {
    super(`Another session ('${lockedBy}') is currently controlling the computer. Only one session can drive the desktop at a time. Run relai_computer stop (or wait for the active session to finish) before retrying.`);
    this.name = 'ComputerSessionLockedError';
    this.lockedBy = lockedBy;
    this.allowedAlternatives = Object.freeze(['Run relai_computer stop after the active session finishes, then retry.']);
  }
}

class ComputerTierRestrictedError extends Error {
  readonly code = 'COMPUTER_TIER_RESTRICTED' as const;
  readonly source = 'rel-ai-mcp-policy' as const;
  readonly operation = 'computer_control' as const;
  readonly retryable = false;
  readonly requiresUserConfirmation = false;
  readonly allowedAlternatives: readonly string[];
  readonly app: string;
  readonly tier: ComputerAppTier;

  constructor(app: string, action: string) {
    const tier = tierForComputerApp(app);
    const alternative = tier === 'read'
      ? 'Use relai_browser for this browser app instead of raw relai_computer input.'
      : 'Use relai_desktop or relai_exec for typing into terminals and IDEs instead of raw relai_computer input.';
    super(`'${app}' is ${tier === 'read' ? 'view-only' : 'click-only'} for computer control, so '${action}' is blocked. ${alternative}`);
    this.name = 'ComputerTierRestrictedError';
    this.app = normalizeAppName(app);
    this.tier = tier;
    this.allowedAlternatives = Object.freeze([alternative]);
  }
}

function assertComputerAppApproved(
  value: unknown,
  config: ComputerControlConfig | null | undefined = null,
  sessionId: unknown = ''
): string {
  const app = normalizeAppName(value);
  if (!app) throw new Error('Computer control requires an explicit app for this action.');
  if (isComputerAppApproved(app, config, sessionId)) return app;
  throw new ComputerAppApprovalRequiredError(app);
}

function assertComputerTierAllowed(value: unknown, action: string): void {
  const tier = tierForComputerApp(value);
  if (tier === 'read' && action !== 'screenshot' && action !== 'status' && action !== 'displays') {
    throw new ComputerTierRestrictedError(String(value ?? ''), action);
  }
  if (tier === 'click' && (action === 'type' || action === 'key' || action === 'hotkey' || action === 'set_value')) {
    throw new ComputerTierRestrictedError(String(value ?? ''), action);
  }
}

export {
  approveComputerApp, assertComputerAppApproved, assertComputerControlEnabled, assertComputerTierAllowed, computerControlSettings, listComputerApprovedApps, normalizeAppName, revokeComputerApp, tierForComputerApp, warningForComputerApp
};
export type { ComputerControlConfig };
export { ComputerSessionLockedError };
