import React from 'react';
import { openModal } from './components/modal.js';
import { CHATGPT_REFRESH_BUSINESS_NOTE, CHATGPT_REFRESH_STEPS } from './features/settings/connection-guidance.js';

const h = React.createElement;
const STORAGE_PREFIX = 'relai_connector_refresh';

function prepareConnectorRefreshNotice(lifecycle = {}, storage) {
  const currentVersion = cleanVersion(lifecycle.currentVersion);
  const connectorRevision = connectorRevisionForLifecycle(lifecycle);
  if (!connectorRevision) return null;

  const acknowledgedKey = storageKey('acknowledged', connectorRevision);
  const pendingKey = storageKey('pending', connectorRevision);
  if (readStorage(storage, acknowledgedKey) === '1') {
    removeStorage(storage, pendingKey);
    return null;
  }

  const previousVersion = cleanVersion(lifecycle.previousVersion);
  const connectorChanged = lifecycle.connectorRefreshRequired === true;
  if (connectorChanged) writeStorage(storage, pendingKey, '1');
  const pending = connectorChanged || readStorage(storage, pendingKey) === '1';
  if (!pending) return null;

  return {
    currentVersion,
    previousVersion,
    connectorRevision,
    acknowledgedKey,
    pendingKey,
    title: 'Refresh Rel.AI MCP in ChatGPT',
    description: `Rel.AI MCP ${currentVersion} changed its ChatGPT action definitions. ChatGPT keeps an approved snapshot, so review the updated actions before using the new tool surface.`,
    steps: CHATGPT_REFRESH_STEPS,
    businessNote: CHATGPT_REFRESH_BUSINESS_NOTE
  };
}

function acknowledgeConnectorRefreshNotice(view, storage) {
  if (!view?.acknowledgedKey) return;
  writeStorage(storage, view.acknowledgedKey, '1');
  removeStorage(storage, view.pendingKey);
}

function initConnectorRefreshModal(options = {}) {
  const bridge = options.bridge || window.relaiDesktop;
  const storage = options.storage || window.localStorage;
  if (!bridge?.getLifecycleStatus) return () => {};

  let cancelled = false;

  void bridge.getLifecycleStatus().then(lifecycle => {
    if (cancelled) return;
    const connectorRevision = connectorRevisionForLifecycle(lifecycle);
    if (lifecycle?.connectorRefreshRequired === true && connectorRevision && readStorage(storage, storageKey('acknowledged', connectorRevision)) === '1') {
      if (typeof bridge.acknowledgeConnectorRefresh === 'function') void Promise.resolve(bridge.acknowledgeConnectorRefresh()).catch(() => {});
      return;
    }
    const view = prepareConnectorRefreshNotice(lifecycle, storage);
    if (!view) return;

    let modal = null;
    const content = h('div', { className: 'confirm-dialog' },
      h('p', null, view.description),
      h('div', { className: 'confirm-dialog-copy' },
        h('strong', null, 'In ChatGPT:'),
        h('ol', { className: 'modal-step-list' }, view.steps.map(step => h('li', { key: step }, step)))
      ),
      h('p', { className: 'muted' }, view.businessNote),
      h('p', { className: 'muted' }, 'You can dismiss this notice now. It will not appear again for this Rel.AI action revision.'),
      h('div', { className: 'modal-actions' },
        h('button', { type: 'button', className: 'primary', onClick: () => modal?.close() }, 'Done')
      )
    );

    modal = openModal({
      title: view.title,
      content,
      size: 'compact',
      onClose: () => {
        const acknowledge = bridge.acknowledgeConnectorRefresh;
        if (typeof acknowledge !== 'function') {
          acknowledgeConnectorRefreshNotice(view, storage);
          return;
        }
        void Promise.resolve(acknowledge()).then(result => {
          if (result?.ok !== false) acknowledgeConnectorRefreshNotice(view, storage);
        }).catch(() => {});
      }
    });
  }).catch(() => {});

  return () => {
    cancelled = true;
  };
}

function storageKey(kind, version) {
  return `${STORAGE_PREFIX}:${kind}:${version}`;
}

function readStorage(storage, key) {
  try { return storage?.getItem?.(key) || ''; } catch { return ''; }
}

function writeStorage(storage, key, value) {
  try { storage?.setItem?.(key, value); } catch {}
}

function removeStorage(storage, key) {
  try { storage?.removeItem?.(key); } catch {}
}

function connectorRevisionForLifecycle(lifecycle = {}) {
  return cleanRevision(lifecycle.connectorRevision) || cleanVersion(lifecycle.currentVersion);
}

function cleanVersion(value) {
  return String(value || '').trim().replace(/^v/i, '').slice(0, 80);
}

function cleanRevision(value) {
  return String(value || '').trim().slice(0, 240);
}

export {
  acknowledgeConnectorRefreshNotice,
  initConnectorRefreshModal,
  prepareConnectorRefreshNotice
};
