import { postJson } from '../../api.js';
import { routeMetadata } from '../../navigation-catalog.js';

const DISMISSED_KEY = 'relai_desktop_setup_dismissed';
let completionPersisted = false;
let pendingPersisted = false;

export function desktopSetupSteps({
  hasWorkspace = false,
  endpointReady = false,
  chatgptReady = false,
  firstRequestObserved = false
} = {}) {
  const requestUnlocked = hasWorkspace && endpointReady && chatgptReady;
  return [
    {
      id: 'connection',
      title: 'Connect this computer',
      description: 'Copy the Secure MCP Tunnel ID in OpenAI Platform. Create a runtime API key. Save both values in Rel.AI.',
      href: routeMetadata('settings/connection').href,
      action: 'Set up connection',
      complete: endpointReady,
      locked: false
    },
    {
      id: 'chatgpt',
      title: 'Create the Rel.AI connector in ChatGPT',
      description: 'Open ChatGPT connector setup. Use Tunnel + No authentication. Scan the Rel.AI tools.',
      action: 'Follow ChatGPT setup',
      actionType: 'guide',
      complete: endpointReady && chatgptReady,
      locked: !endpointReady
    },
    {
      id: 'workspace',
      title: 'Add a project',
      description: 'Choose a project folder and give it a short name.',
      href: `${routeMetadata('workspaces').href}?create=1`,
      action: 'Add project',
      complete: hasWorkspace,
      locked: false
    },
    {
      id: 'first-request',
      title: 'Send your first Rel.AI request',
      description: 'Open ChatGPT. Select Rel.AI MCP. Send the request below to confirm that ChatGPT can reach your project.',
      action: 'Copy first request',
      actionType: 'copy',
      complete: requestUnlocked && firstRequestObserved,
      locked: !requestUnlocked
    }
  ];
}

export function isDesktopSetupDismissed() {
  try { return localStorage.getItem(DISMISSED_KEY) === '1'; } catch { return false; }
}

export async function dismissDesktopSetup() {
  setDesktopSetupDismissed(true);
  announceDesktopSetupState(false);
  const result = await persistDesktopSetup({ skipped: true, handoffPending: false, source: 'overview-checklist' });
  if (!result?.ok) {
    setDesktopSetupDismissed(false);
    announceDesktopSetupState(true);
  }
  return result;
}

export async function completeDesktopSetup() {
  setDesktopSetupDismissed(true);
  announceDesktopSetupState(false);
  if (completionPersisted) return null;
  completionPersisted = true;
  const result = await persistDesktopSetup({ completed: true, handoffPending: false, source: 'overview-checklist' });
  if (!result?.ok) completionPersisted = false;
  return result;
}

export function syncDesktopSetupState(status = {}) {
  const pending = status.needsOnboarding === true || status.handoffPending === true;
  setDesktopSetupDismissed(!pending);
  announceDesktopSetupState(pending);
  if (pending) persistPendingSetup();
  return pending;
}

function setDesktopSetupDismissed(value) {
  try {
    if (value) localStorage.setItem(DISMISSED_KEY, '1');
    else localStorage.removeItem(DISMISSED_KEY);
  } catch {}
}

function announceDesktopSetupState(pending) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('relai:onboarding-state', { detail: { pending } }));
}

function persistPendingSetup() {
  if (pendingPersisted) return;
  pendingPersisted = true;
  void persistDesktopSetup({ completed: false, skipped: false, handoffPending: true, source: 'overview-checklist' })
    .then(result => { if (!result?.ok) pendingPersisted = false; });
}

async function persistDesktopSetup(payload) {
  try {
    return await postJson('/api/onboarding/complete', payload);
  } catch {
    return null;
  }
}
