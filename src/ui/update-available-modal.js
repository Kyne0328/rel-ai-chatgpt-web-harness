import React from 'react';
import { closeModal, openModal, updateModal } from './components/modal.js';
import { toast } from './components/toast.js';

const h = React.createElement;
const RELEASES_URL = 'https://github.com/Kyne0328/rel-ai-chatgpt-web-harness/releases';

function supportPolicyModalView(policy) {
  const state = String(policy?.state || '');
  if (!['deprecated', 'required', 'emergency_blocked'].includes(state)) return null;
  const currentVersion = cleanVersion(policy?.currentVersion);
  const minimumSupportedVersion = cleanVersion(policy?.minimumSupportedVersion);
  const minimumRecommendedVersion = cleanVersion(policy?.minimumRecommendedVersion || minimumSupportedVersion);
  const enforceAfter = cleanIso(policy?.enforceAfter);
  const minimumVersion = state === 'recommended' ? minimumRecommendedVersion : minimumSupportedVersion;
  const key = [state, currentVersion, minimumSupportedVersion, minimumRecommendedVersion, enforceAfter].join(':');

  if (state === 'emergency_blocked') {
    return {
      key,
      state,
      blocking: true,
      allowLater: false,
      minimumVersion,
      title: 'Critical update required',
      description: policy?.message || `Rel.AI MCP v${currentVersion || 'this version'} needs an urgent update before Rel.AI can work with ChatGPT again.`
    };
  }
  if (state === 'required') {
    return {
      key,
      state,
      blocking: true,
      allowLater: false,
      minimumVersion,
      title: 'Update required',
      description: policy?.message || `This Rel.AI MCP version is no longer supported. Update to v${minimumVersion || 'the current release'} or newer to continue.`
    };
  }
  if (state === 'deprecated') {
    const deadline = enforceAfter ? formatPolicyDate(enforceAfter) : '';
    return {
      key,
      state,
      blocking: false,
      allowLater: true,
      minimumVersion,
      title: 'Update required soon',
      description: deadline
        ? `Support for this version ends on ${deadline}. Update to v${minimumVersion || 'the current release'} or newer before then.`
        : `Support for this version is ending. Update to v${minimumVersion || 'the current release'} or newer soon to stay supported.`
    };
  }
  return {
    key,
    state,
    blocking: false,
    allowLater: true,
    minimumVersion,
    title: 'Update recommended',
    description: `Rel.AI MCP v${minimumVersion || 'a newer version'} or newer is recommended.`
  };
}
function availableUpdateModalView(status = {}) {
  if (String(status.state || '') !== 'available') return null;
  const version = cleanVersion(status.availableVersion);
  if (!version) return null;
  const synchronization = status.updateSynchronization;
  const syncDetail = synchronization?.deviceUpdateRequired === true
    ? ' This release also changes the Rel.AI device protocol. Update connected Rel.AI device components after restart.'
    : synchronization?.toolRefreshRequired === true
      ? ' This release changes ChatGPT tool definitions. Rel.AI will ask you to refresh the ChatGPT connector after restart.'
      : '';
  return {
    key: `available:${version}`,
    state: 'available',
    blocking: false,
    allowLater: true,
    title: 'Update available',
    description: `Rel.AI MCP v${version} is available.`,
    detail: `Download it now or keep working. Rel.AI will remind you on a later launch if you choose Later.${syncDetail}`
  };
}

function installingUpdateModalView(status = {}) {
  if (String(status.state || '') !== 'installing') return null;
  const version = cleanVersion(status.availableVersion);
  return {
    key: `installing:${version || 'update'}`,
    state: 'installing',
    blocking: true,
    allowLater: false,
    title: 'Updating Rel.AI',
    description: version ? `Installing Rel.AI MCP v${version}…` : 'Installing the Rel.AI MCP update…',
    detail: 'Rel.AI is temporarily paused while it prepares the verified update. The app restarts automatically to finish installation.'
  };
}

function installFailureModalView(status = {}) {
  if (String(status.state || '') !== 'downloaded' || !status.error) return null;
  const version = cleanVersion(status.availableVersion);
  return {
    key: `install-failed:${version || 'update'}`,
    state: 'downloaded',
    blocking: false,
    allowLater: true,
    title: 'Update could not install',
    description: String(status.error),
    detail: 'The downloaded update is still verified and ready. Your current Rel.AI version was not replaced.'
  };
}


function initUpdateAvailableModal(options = {}) {
  const bridge = options.bridge || window.relaiDesktop;
  if (!bridge?.getUpdateStatus) return () => {};

  const shownPolicyKeys = new Set();
  const shownUpdateKeys = new Set();
  let latestStatus = null;
  let removeUpdateListener = null;
  let activeModalKey = '';

  function consider(status) {
    latestStatus = status || latestStatus;
    const installingView = installingUpdateModalView(latestStatus);
    if (installingView) {
      showOrUpdateModal(installingView, latestStatus);
      return;
    }
    const failedInstallView = installFailureModalView(latestStatus);
    if (failedInstallView) {
      showOrUpdateModal(failedInstallView, latestStatus);
      return;
    }
    const policyView = supportPolicyModalView(latestStatus?.supportPolicy);
    if (policyView) {
      if (updateActionInProgress(latestStatus)) {
        closeActiveModal();
        return;
      }
      const acknowledged = shownPolicyKeys.has(policyView.key);
      if (policyView.blocking || !acknowledged || activeModalKey === policyView.key) {
        if (!policyView.blocking) shownPolicyKeys.add(policyView.key);
        showOrUpdateModal(policyView, latestStatus);
      }
      return;
    }

    const updateView = availableUpdateModalView(latestStatus);
    if (updateView && (!shownUpdateKeys.has(updateView.key) || activeModalKey === updateView.key)) {
      shownUpdateKeys.add(updateView.key);
      showOrUpdateModal(updateView, latestStatus);
      return;
    }
    closeActiveModal();
  }

  if (typeof bridge.onUpdateStatus === 'function') {
    removeUpdateListener = bridge.onUpdateStatus(status => consider(status));
  }
  void bridge.getUpdateStatus().then(status => {
    latestStatus = status;
    consider(status);
  }).catch(() => {});

  function showOrUpdateModal(view, status) {
    const content = h(UpdateNoticeContent, {
      view,
      status,
      onLater: closeModal,
      onAction: action => void runSupportUpdateAction(action)
    });
    if (activeModalKey !== view.key) {
      activeModalKey = view.key;
      openModal({
        title: view.title,
        content,
        size: 'compact',
        escDisabled: view.blocking,
        onClose: () => { activeModalKey = ''; }
      });
      return;
    }
    updateModal({ title: view.title, content, escDisabled: view.blocking });
  }

  function closeActiveModal() {
    if (!activeModalKey) return;
    activeModalKey = '';
    closeModal();
  }

  async function runSupportUpdateAction(action = {}) {
    const method = action.method;
    if (!method || typeof bridge?.[method] !== 'function') return;
    const keepModalOpen = method === 'installUpdate';
    if (!keepModalOpen) closeModal();
    try {
      const result = await bridge[method](...(action.args || []));
      if (result?.status) latestStatus = { ...latestStatus, ...result.status };
      consider(latestStatus);
      if (result?.ok === false && !keepModalOpen) throw new Error(result.error || 'The update action failed.');
    } catch (error) {
      if (keepModalOpen) closeActiveModal();
      toast(messageOf(error), { variant: 'error' });
    }
  }

  return () => removeUpdateListener?.();
}

function updateActionInProgress(status = {}) {
  return ['checking', 'downloading', 'installing'].includes(String(status?.state || ''));
}

function supportUpdateAction(status = {}) {
  const state = String(status.state || 'idle');
  if (state === 'unsupported') return { kind: 'link', label: 'Open GitHub Releases' };
  if (state === 'available') return { kind: 'button', method: 'downloadUpdate', label: `Download v${cleanVersion(status.availableVersion) || 'update'}`, disabled: false, busy: false };
  if (state === 'downloaded') {
    if (status.installDeferred === true) return { kind: 'button', method: '', label: 'Install queued for when work finishes', disabled: true, busy: true };
    if (status.canDeferInstall === true) return { kind: 'button', method: 'installUpdate', args: [{ deferIfBusy: true }], label: 'Install when task finishes', disabled: false, busy: false };
    return {
      kind: 'button', method: 'installUpdate',
      label: status.installMode === 'open_dmg' ? 'Open DMG and close Rel.AI' : 'Install update',
      disabled: false, busy: false
    };
  }
  if (state === 'checking') return { kind: 'button', method: '', label: 'Checking for update…', disabled: true, busy: true };
  if (state === 'downloading') return { kind: 'button', method: '', label: 'Downloading update…', disabled: true, busy: true };
  if (state === 'installing') return { kind: 'button', method: '', label: 'Installing update…', disabled: true, busy: true };
  return { kind: 'button', method: 'checkForUpdates', label: state === 'error' ? 'Try update check again' : 'Check for update', disabled: false, busy: false };
}

function UpdateNoticeContent({ view, status, onLater, onAction }) {
  const action = supportUpdateAction(status);
  const detail = view.detail || (view.blocking
    ? 'You can still use the dashboard and update controls, but Rel.AI cannot work with ChatGPT until a supported version is installed.'
    : 'You can update now or continue. Rel.AI will show this notice again on a later launch until you update.');
  if (view.state === 'installing') {
    return h('div', { className: 'update-installing-modal', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', 'aria-busy': 'true' },
      h('div', { className: 'loading-mark', 'aria-hidden': 'true' }),
      h('p', null, view.description),
      h('p', { className: 'muted' }, detail)
    );
  }
  const primary = action.kind === 'link'
    ? h('a', { className: 'buttonlike primary', href: RELEASES_URL, target: '_blank', rel: 'noreferrer' }, action.label)
    : h('button', {
        type: 'button',
        className: 'primary',
        disabled: action.disabled,
        'aria-busy': action.busy ? 'true' : undefined,
        onClick: () => onAction(action)
      }, action.label);
  return h(React.Fragment, null,
    h('p', null, view.description),
    h('p', { className: 'muted' }, detail),
    h('div', { className: 'modal-actions' },
      view.allowLater ? h('button', { type: 'button', className: 'secondary', onClick: onLater }, 'Later') : null,
      primary
    )
  );
}

function cleanVersion(value) {
  return String(value || '').trim().replace(/^v/i, '').slice(0, 80);
}

function cleanIso(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function formatPolicyDate(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error || 'Application update action failed.');
}

export { availableUpdateModalView, initUpdateAvailableModal, installingUpdateModalView, supportPolicyModalView };
