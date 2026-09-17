import assert from 'node:assert/strict';

import {
  acknowledgeConnectorRefreshNotice,
  prepareConnectorRefreshNotice
} from '../src/ui/connector-refresh-modal.js';
import { CHATGPT_REFRESH_BUSINESS_NOTE, CHATGPT_REFRESH_STEPS } from '../src/ui/features/settings/connection-guidance.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    values
  };
}

const freshInstallStorage = memoryStorage();
assert.equal(prepareConnectorRefreshNotice({
  currentVersion: '0.27.4',
  previousVersion: '',
  firstLaunch: true,
  updated: false,
  connectorRevision: 'surface-61',
  connectorRefreshRequired: false
}, freshInstallStorage), null, 'fresh installs must not be told to refresh a connector that was not previously registered');

const updateStorage = memoryStorage();
const updateNotice = prepareConnectorRefreshNotice({
  currentVersion: '0.27.4',
  previousVersion: '0.27.3',
  firstLaunch: false,
  updated: true,
  connectorRevision: 'surface-61',
  connectorRefreshRequired: true
}, updateStorage);
assert.ok(updateNotice, '0.27.4 must require a connector refresh when its connector revision changed');
assert.deepEqual(updateNotice.steps, CHATGPT_REFRESH_STEPS);
assert.equal(updateNotice.businessNote, CHATGPT_REFRESH_BUSINESS_NOTE);
assert.match(updateNotice.steps.join(' '), /Go\/Plus\/Pro.*Settings.*Plugins.*Rel\.AI MCP.*Information.*Refresh/i);
assert.match(updateNotice.steps.join(' '), /Enterprise\/Edu.*Workspace settings.*Apps.*Action control.*Refresh/i);
assert.match(updateNotice.businessNote, /Business.*recreate and republish/i);
assert.equal('dismissDelayMs' in updateNotice, false, 'connector refresh notices must never impose a timed dismissal lockout');

const nextLaunchNotice = prepareConnectorRefreshNotice({
  currentVersion: '0.27.4',
  previousVersion: '',
  firstLaunch: false,
  updated: false,
  connectorRevision: 'surface-61',
  connectorRefreshRequired: false
}, updateStorage);
assert.ok(nextLaunchNotice, 'an unacknowledged refresh notice must survive a restart after the update launch');

acknowledgeConnectorRefreshNotice(nextLaunchNotice, updateStorage);
assert.equal(prepareConnectorRefreshNotice({ currentVersion: '0.27.4', connectorRevision: 'surface-61', connectorRefreshRequired: true }, updateStorage), null, 'acknowledged notices must not reappear for the same connector revision');

assert.equal(prepareConnectorRefreshNotice({
  currentVersion: '0.27.5',
  previousVersion: '0.27.4',
  updated: true,
  connectorRevision: 'surface-61',
  connectorRefreshRequired: false
}, memoryStorage()), null, 'an app update with unchanged connector definitions must stay silent');

const futureStorage = memoryStorage();
const futureNotice = prepareConnectorRefreshNotice({
  currentVersion: '9.9.9',
  previousVersion: '9.9.8',
  updated: true,
  connectorRevision: 'future-surface',
  connectorRefreshRequired: true
}, futureStorage);
assert.ok(futureNotice, 'future connector changes must not depend on a hand-maintained version allowlist');
assert.match(futureNotice.description, /9\.9\.9 changed its ChatGPT action definitions/i);

const sameVersionNotice = prepareConnectorRefreshNotice({
  currentVersion: '9.9.9',
  previousVersion: '',
  updated: false,
  connectorRevision: 'future-surface-2',
  connectorRefreshRequired: true
}, memoryStorage());
assert.ok(sameVersionNotice, 'a changed connector revision can request refresh even when the app version is unchanged');

console.log('Connector refresh modal behavior tests passed.');
