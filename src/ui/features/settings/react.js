import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { fetchJson, postJson, requestDashboardRefresh } from '../../api.js';
import { confirmAction } from '../../components/confirm-dialog.js';
import { Icon } from '../../components/icons.js';
import { openModal } from '../../components/modal.js';
import { StatusPill } from '../../components/pill.js';
import { toast } from '../../components/toast.js';
import { connectionLayerViews, connectionStateFor, connectionSummary, hasObservedMcpConnection, tunnelRuntimeView } from '../../connection-state.js';
import { DEVELOPER_FEATURES, readDeveloperFeatureEnabled, readDeveloperOptionsUnlocked, unlockDeveloperOptions, writeDeveloperFeatureEnabled } from '../../developer-mode.js';
import { getUiPreferences, setThemePreference } from '../../preferences.js';
import { currentRoutePath } from '../../router.js';
import { chatGptFirstPrompt, chatGptGuideSteps, CHATGPT_CONNECTOR_CREATE_URL } from './connection-guidance.js';
import { restartConnection } from './connection-recovery.js';
import { supportPolicyView } from './desktop-update-policy.js';

const h = React.createElement;
const RELEASES_URL = 'https://github.com/Kyne0328/rel-ai-chatgpt-web-harness/releases';
const DEVELOPER_UNLOCK_CLICK_COUNT = 5;
const DEVELOPER_UNLOCK_WINDOW_MS = 2500;
const DEVELOPER_FEATURE_FLAGS = Object.freeze(Object.values(DEVELOPER_FEATURES));
const NOTIFICATION_DEFAULTS = Object.freeze({
  enabled: true,
  taskCompleted: true,
  errors: false,
  connectionStatus: true,
  applicationUpdates: true,
  ignoredUpdateVersion: ''
});
const NOTIFICATION_CATEGORIES = Object.freeze([
  ['taskCompleted', 'Task completed', 'Notify you when a Rel.AI task finishes.'],
  ['errors', 'Errors', 'Notify you when a project action, connection, or app update fails.'],
  ['connectionStatus', 'Connection status', 'Notify you when ChatGPT connects, disconnects, or needs to reconnect.'],
  ['applicationUpdates', 'App updates', 'Notify you when a Rel.AI update is available.']
]);

export function createSettingsRoute(useDashboardStore) {
  return function SettingsRoute() {
    return h(SettingsView, { data: useDashboardStore() });
  };
}

export function SettingsView({ data = {}, subPage = '' }) {
  const path = subPage ? `settings/${subPage}` : currentRoutePath();
  const page = path === 'settings' ? 'preferences' : path.split('/')[1] || 'preferences';
  const content = {
    connection: h(ConnectionPage, { data }),
    preferences: h(PreferencesPage),
    privacy: h(PrivacyDataPage, { computerControl: data.config?.computerControl }),
    application: h(ApplicationPage),
    about: h(AboutPage, {
      metadata: data.application || {},
      buildStatus: data.desktopStatus?.buildStatus,
      runtime: data.runtime,
      repositoryRuntime: data.repositoryRuntime,
      runtimeCompatibility: data.runtimeCompatibility
    })
  }[page] || h(PreferencesPage);
  return h('div', { id: '__settings-content', className: 'settings-content', 'data-settings-react': page }, content);
}

function Card({ title, className = '', children }) {
  return h('section', { className: ['card', className].filter(Boolean).join(' ') },
    h('div', { className: 'card-head' }, h('h3', null, title)),
    h('div', { className: 'card-body settings-panel-body' }, children)
  );
}

function SettingsHeader({ title, description }) {
  return h('div', { className: 'settings-header' },
    h('h2', null, title),
    description ? h('p', null, description) : null
  );
}

function Toggle({ checked, disabled = false, busy = false, onChange, enabledLabel = 'Enabled', disabledLabel = 'Disabled', labelledBy, describedBy }) {
  return h('label', { className: 'toggle-control settings-toggle-control', 'aria-disabled': String(disabled), 'aria-busy': String(busy) },
    h('input', {
      className: 'toggle-input',
      type: 'checkbox',
      role: 'switch',
      checked: Boolean(checked),
      disabled,
      'aria-checked': String(Boolean(checked)),
      'aria-labelledby': labelledBy,
      'aria-describedby': describedBy,
      onChange: event => onChange?.(event.currentTarget.checked)
    }),
    h('span', { className: 'toggle-label' }, checked ? enabledLabel : disabledLabel)
  );
}

function ToggleRow({ label, help = '', checked, disabled = false, busy = false, onChange, enabledLabel, disabledLabel }) {
  const id = useId().replaceAll(':', '');
  const labelId = `settingsToggle${id}`;
  const helpId = `${labelId}Help`;
  return h('div', { className: 'setting-row settings-toggle-row' },
    h('div', { className: 'setting-row-copy' },
      h('strong', { id: labelId }, label),
      help ? h('span', { id: helpId }, help) : null
    ),
    h(Toggle, {
      checked, disabled, busy, onChange, enabledLabel, disabledLabel,
      labelledBy: labelId,
      describedBy: help ? helpId : undefined
    })
  );
}

function SettingsField({ label, help = '', error = '', children, inputId }) {
  return h('div', { className: 'settings-field' },
    h('label', { htmlFor: inputId }, label),
    children,
    help ? h('p', { className: 'settings-help', id: `${inputId}Help` }, help) : null,
    error ? h('div', { className: 'connection-key-error', id: `${inputId}Error`, role: 'alert' }, error) : null
  );
}


function ConnectionPage({ data }) {
  const controlsRef = useRef(null);
  const state = connectionStateFor(data);
  const summary = connectionSummary(state);
  const action = connectionPrimaryAction(state);
  const guideMode = connectionGuideMode(state);
  const tunnelId = String(data.desktopStatus?.tunnelId || data.connection?.tunnelId || '');
  const primaryTunnel = tunnelId ? {
    tunnelId,
    label: 'Primary connection',
    state: String(data.desktopStatus?.tunnelStatus || ''),
    retry: {
      scheduled: Boolean(data.desktopStatus?.tunnelNextRetryAt),
      inFlight: false
    }
  } : null;
  const workspaceAlias = data.config?.workspaces?.[0]?.alias || 'myapp';

  const openSettings = ({ focus = false } = {}) => {
    window.dispatchEvent(new CustomEvent('relai:connection-open-settings', { detail: { focus } }));
    controlsRef.current?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  };
  const openSetup = () => {
    const target = document.querySelector('.connection-guide-card') || controlsRef.current;
    target?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  };
  const retry = async () => {
    const result = await restartConnection();
    if (!result?.ok) {
      toast(result?.error || 'The connection could not be retried.', { variant: 'error' });
      openSettings({ focus: true });
      return;
    }
    toast('Connection retry started. Rel.AI is checking the Secure MCP Tunnel.', { variant: 'success' });
  };
  return h('div', { className: 'section connection-page', 'data-connection-react': '' },
    h('section', { className: `card connection-summary-card ${summary.tone}` },
      h('div', { className: 'card-head' }, h(StatusPill, { label: summary.label, tone: summary.tone })),
      h('div', { className: 'card-body connection-status-body' },
        h('div', { className: 'connection-status-copy' }, h('h2', null, summary.title), h('p', null, summary.message)),
        action.kind !== 'none' ? h('div', { className: 'connection-primary-action' }, connectionActionElement(action, { openSetup, openSettings, retry })) : null
      )
    ),
    action.kind !== 'none' ? h('div', { className: 'connection-support-row' },
      action.href === '#diagnostics' ? null : h('a', { className: 'buttonlike secondary compact-button', href: '#diagnostics' }, 'Troubleshooting')
    ) : null,
    h(ConnectionLayers, { state, summary }),
    guideMode ? h(ConnectionGuide, { mode: guideMode, tunnelId, workspaceAlias }) : null,
    h('section', { id: 'connectionControls', className: 'connection-controls-section', ref: controlsRef },
      h(DesktopConnectionSettings, { expanded: String(state.publicEndpoint?.status || '') === 'disabled', primaryTunnel })
    ),
    typeof window.relaiDesktop?.logout === 'function' ? h(Card, { title: 'Connection controls' }, h(LogoutRow)) : null
  );
}

function connectionPrimaryAction(state = {}) {
  const summary = connectionSummary(state);
  const local = String(state.localService?.status || '');
  const endpoint = String(state.publicEndpoint?.status || '');
  const errorCode = String(state.error?.code || '');
  if (local === 'failed' || local === 'stopped') return { kind: 'route', href: '#diagnostics', label: 'Troubleshoot' };
  if (endpoint === 'disabled') return { kind: 'control', label: 'Set up connection' };
  if (endpoint === 'unavailable') {
    if (errorCode === 'tunnel_authentication_failed') return { kind: 'settings', label: 'Replace runtime key' };
    if (errorCode === 'tunnel_access_denied') return { kind: 'settings', label: 'Review key permissions' };
    if (errorCode === 'tunnel_not_found') return { kind: 'settings', label: 'Review Tunnel ID' };
    return { kind: 'restart', label: 'Retry now' };
  }
  if (endpoint === 'degraded') return { kind: 'restart', label: 'Retry now' };
  if (endpoint === 'available' && Number(state.publicEndpoint?.issueCount || 0) > 0) return { kind: 'none' };
  if (summary.tone === 'working') return { kind: 'none' };
  if (summary.tone === 'bad' || summary.tone === 'warn') return { kind: 'route', href: '#diagnostics', label: 'Troubleshoot' };
  return { kind: 'none' };
}

function connectionActionElement(action, handlers) {
  if (action.kind === 'control') return h('button', { className: 'primary', type: 'button', onClick: handlers.openSetup }, action.label);
  if (action.kind === 'settings') return h('button', { className: 'primary', type: 'button', onClick: () => handlers.openSettings({ focus: true }) }, action.label);
  if (action.kind === 'restart') {
    return typeof window.relaiDesktop?.restartConnection === 'function'
      ? h('button', { className: 'primary', type: 'button', onClick: () => void handlers.retry() }, action.label)
      : h('button', { className: 'primary', type: 'button', onClick: () => handlers.openSettings({ focus: true }) }, 'Review connection settings');
  }
  return h('a', { className: 'buttonlike primary', href: action.href }, action.label);
}

function ConnectionLayers({ state, summary }) {
  const [open, setOpen] = useState(summary.tone === 'bad' || summary.tone === 'warn');
  return h('details', { className: 'card connector-details connection-layer-disclosure', open, onToggle: event => setOpen(event.currentTarget.open) },
    h('summary', { className: 'connector-details-summary' }, h('span', null, h('strong', null, 'Connection details'))),
    h('div', { className: 'connection-path' }, connectionLayerViews(state).map(layer => h('article', { className: `connection-path-step ${layer.tone}`, key: layer.key },
      h('div', { className: 'connection-layer-card-head' },
        h('span', { className: 'connection-layer-dot', 'aria-hidden': 'true' }),
        h('div', null, h('h4', null, layer.title), h('span', { className: `connection-layer-state ${layer.tone}` }, layer.label))
      ),
      h('p', null, layer.description)
    )))
  );
}

function connectionGuideMode(state = {}) {
  const client = state.mcpClient || {};
  if (hasObservedMcpConnection(client)) return null;
  const authorization = String(state.chatgptReadiness?.status || '');
  const clientStatus = String(client.status || '');
  if (authorization === 'authentication_required' || authorization === 'authentication_failed' || clientStatus === 'reauthentication_required') return 'reconnect';
  return 'create';
}

function ConnectionGuide({ mode, tunnelId, workspaceAlias }) {
  const steps = chatGptGuideSteps({ mode, tunnelId });
  const title = mode === 'reconnect' ? 'Reconnect ChatGPT' : 'Connect ChatGPT';
  return h('div', { className: 'connection-guide-region' },
    h('section', { className: 'card connection-guide-card' },
      h('div', { className: 'card-head' }, h('h3', null, title), h('span', { className: 'section-action' }, 'Connection setup')),
      h('div', { className: 'card-body' },
        h('div', { className: 'chatgpt-setup-guide compact' },
          h('div', { className: 'chatgpt-guide-heading' },
            h('span', null, 'Use Tunnel + No authentication.')
          ),
          mode === 'create' ? h('section', { className: 'chatgpt-connector-handoff', 'aria-label': 'ChatGPT connector setup' },
            h('dl', { className: 'chatgpt-connector-values' },
              h('dt', null, 'Name'), h('dd', null, 'Rel.AI MCP'),
              h('dt', null, 'Connection'), h('dd', null, 'Tunnel'),
              h('dt', null, 'Tunnel'), h('dd', { className: 'mono' }, tunnelId || 'Select this computer’s tunnel'),
              h('dt', null, 'Authentication'), h('dd', null, 'No authentication')
            ),
            h('div', { className: 'chatgpt-connector-actions', role: 'group', 'aria-label': 'ChatGPT connector setup actions' },
              h('button', { className: 'primary', type: 'button', onClick: () => window.open(CHATGPT_CONNECTOR_CREATE_URL, '_blank', 'noopener,noreferrer') }, 'ChatGPT setup')
            )
          ) : null,
          h('ol', null, steps.map((step, index) => h('li', { key: index }, step))),
          h('div', { className: 'chatgpt-first-prompt' }, h('span', null, 'First test request'), h('code', null, chatGptFirstPrompt(workspaceAlias)))
        )
      )
    )
  );
}

function DesktopConnectionSettings({ expanded = false, primaryTunnel = null }) {
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [open, setOpen] = useState(expanded);
  const [showSecret, setShowSecret] = useState(false);
  const [validation, setValidation] = useState(null);
  const [saveState, setSaveState] = useState('idle');
  const firstInputRef = useRef(null);
  const desktop = window.relaiDesktop;

  useEffect(() => {
    if (!desktop?.getSettings || !desktop?.saveSettings) return undefined;
    let active = true;
    void desktop.getSettings().then(settings => {
      if (!active) return;
      const next = {
        port: Number(settings.port || 3333),
        tunnelId: String(settings.tunnelId || ''),
        tunnelApiKey: '',
        tunnelApiKeyConfigured: settings.tunnelApiKeyConfigured === true,
        tunnelErrorCode: String(settings.tunnelErrorCode || ''),
        tunnelError: String(settings.tunnelError || ''),
        additionalTunnels: Array.isArray(settings.additionalTunnels) ? settings.additionalTunnels : [],
        additionalTunnelStatuses: Array.isArray(settings.additionalTunnelStatuses) ? settings.additionalTunnelStatuses : []
      };
      setForm(next);
      setSaved(connectionSnapshot(next));
      if (tunnelCredentialError(next)) setOpen(true);
    }).catch(error => {
      if (active) setForm({ loadError: messageOf(error) });
    });
    return () => { active = false; };
  }, [desktop, loadAttempt]);

  useEffect(() => {
    const handler = event => {
      setOpen(true);
      if (event.detail?.focus) window.requestAnimationFrame(() => firstInputRef.current?.focus({ preventScroll: true }));
    };
    window.addEventListener('relai:connection-open-settings', handler);
    return () => window.removeEventListener('relai:connection-open-settings', handler);
  }, []);

  useEffect(() => {
    if (!desktop?.onStatus) return undefined;
    return desktop.onStatus(status => {
      if (!Array.isArray(status?.additionalTunnelStatuses)) return;
      setForm(current => current && !current.loadError
        ? { ...current, additionalTunnelStatuses: status.additionalTunnelStatuses }
        : current);
    });
  }, [desktop]);

  if (!desktop?.getSettings || !desktop?.saveSettings) return h('div', { className: 'empty' }, 'Connection settings are available inside the installed Rel.AI desktop app.');
  if (!form) return h('div', { className: 'settings-loading', role: 'status' }, 'Loading connection settings…');
  if (form.loadError) return h('div', { className: 'empty connection-settings-load-error' },
    h('p', { role: 'alert' }, `Connection settings could not be loaded: ${form.loadError}`),
    h('button', {
      className: 'secondary',
      type: 'button',
      onClick: () => {
        setForm(null);
        setLoadAttempt(attempt => attempt + 1);
      }
    }, 'Try again')
  );

  const dirty = connectionSnapshot(form) !== saved;
  const credentialError = tunnelCredentialError(form);
  const update = patch => {
    setValidation(null);
    setSaveState('idle');
    setForm(current => ({ ...current, ...patch }));
  };
  const save = async () => {
    const issue = validateConnectionSettings(form);
    if (issue) {
      setValidation(issue);
      setOpen(true);
      window.requestAnimationFrame(() => document.querySelector(`[data-connection-field="${issue.field}"]`)?.focus());
      return;
    }
    setSaveState('saving');
    setValidation(null);
    try {
      const result = await desktop.saveSettings({ port: form.port, tunnelId: form.tunnelId, tunnelApiKey: form.tunnelApiKey });
      const next = {
        ...form,
        tunnelApiKey: '',
        tunnelApiKeyConfigured: true,
        tunnelErrorCode: String(result?.errorCode || result?.status?.errorCode || ''),
        tunnelError: String(result?.error || result?.status?.error || '')
      };
      setForm(next);
      setSaved(connectionSnapshot({ ...next, tunnelErrorCode: '', tunnelError: '' }));
      requestDashboardRefresh();
      if (result?.ok === false) {
        setOpen(true);
        setSaveState('idle');
        toast(result.error || 'Connection settings were saved, but the Secure MCP Tunnel could not connect.', { variant: 'error' });
        return;
      }
      setForm(current => ({ ...current, tunnelErrorCode: '', tunnelError: '' }));
      setSaveState('saved');
      window.setTimeout(() => setSaveState(current => current === 'saved' ? 'idle' : current), 1200);
    } catch (error) {
      setSaveState('error');
      toast(messageOf(error), { variant: 'error' });
    }
  };
  const describedBy = field => [ `${field}Help`, validation?.field === field ? `${field}Error` : '' ].filter(Boolean).join(' ');

  return h('details', {
    className: 'card connector-details connection-settings-disclosure',
    id: 'tunnelSettings',
    open,
    onToggle: event => setOpen(event.currentTarget.open),
    'data-unsaved-changes': dirty ? 'true' : 'false'
  },
    h('summary', { className: 'connector-details-summary' }, h('span', null, h('strong', null, 'Connection settings'), h('small', null, 'Secure tunnel credentials and local port'))),
    h('div', { className: 'card-body settings-panel-body' },
      h('p', { className: 'muted' }, 'Use these settings when connecting this computer for the first time or fixing a connection problem.'),
      h(SettingsField, { label: 'Tunnel ID', help: 'The OpenAI Secure MCP Tunnel ID for this computer.', error: validation?.field === 'tunnelId' ? validation.message : '', inputId: 'tunnelId' },
        h('input', {
          id: 'tunnelId', type: 'text', value: form.tunnelId, autoComplete: 'off', spellCheck: false,
          ref: firstInputRef, 'data-connection-field': 'tunnelId', 'aria-invalid': validation?.field === 'tunnelId' ? 'true' : undefined,
          'aria-describedby': describedBy('tunnelId'), onChange: event => update({ tunnelId: event.currentTarget.value.trim() })
        })
      ),
      h(SettingsField, {
        label: 'Runtime API key',
        help: form.tunnelApiKeyConfigured ? 'The saved key is encrypted on this computer. Rel.AI does not show it again.' : 'Create a runtime API key for this Secure MCP Tunnel in OpenAI Platform.',
        error: validation?.field === 'tunnelApiKey' ? validation.message : '', inputId: 'tunnelApiKey'
      },
        h('div', { className: 'password-field' },
          h('input', {
            id: 'tunnelApiKey', type: showSecret ? 'text' : 'password', value: form.tunnelApiKey,
            placeholder: form.tunnelApiKeyConfigured ? 'Stored securely. Enter a new key only to replace it.' : 'Paste runtime API key',
            autoComplete: 'off', spellCheck: false, 'data-connection-field': 'tunnelApiKey',
            'aria-invalid': validation?.field === 'tunnelApiKey' ? 'true' : undefined, 'aria-describedby': describedBy('tunnelApiKey'),
            onChange: event => update({ tunnelApiKey: event.currentTarget.value.trim() })
          }),
          h('button', { className: 'secondary compact-button password-toggle', type: 'button', onClick: () => setShowSecret(value => !value) }, showSecret ? 'Hide' : 'Show')
        )
      ),
      credentialError ? h('div', { className: 'connection-key-error', role: 'alert' }, credentialError) : null,
      h(AdditionalTunnelConnections, {
        primary: primaryTunnel,
        connections: form.additionalTunnels,
        statuses: form.additionalTunnelStatuses,
        desktop,
        onChange: ({ connections, statuses }) => setForm(current => ({
          ...current,
          additionalTunnels: connections,
          additionalTunnelStatuses: statuses
        }))
      }),
      h('details', { className: 'settings-advanced connection-advanced-settings' },
        h('summary', null, 'Advanced local settings'),
        h('div', { className: 'settings-panel-body' },
          h(SettingsField, { label: 'Local connection port', help: 'Change this only when port 3333 conflicts with another local application.', error: validation?.field === 'port' ? validation.message : '', inputId: 'port' },
            h('input', {
              id: 'port', className: 'settings-number-control', type: 'number', min: '1024', max: '65535', step: '1', value: form.port,
              'data-connection-field': 'port', 'aria-invalid': validation?.field === 'port' ? 'true' : undefined,
              'aria-describedby': describedBy('port'), onChange: event => update({ port: Number(event.currentTarget.value) })
            })
          )
        )
      ),
      h('div', { className: 'connection-actions' },
        h('div', { className: 'muted' }, 'Changing the tunnel reconnects the tunnel only. Changing the local port restarts the full Rel.AI connection.'),
        h('button', { className: 'primary', type: 'button', disabled: saveState === 'saving', onClick: () => void save() },
          saveState === 'saving' ? 'Saving and restarting…' : saveState === 'saved' ? 'Connection settings saved' : saveState === 'error' ? 'Try again' : 'Save connection settings')
      )
    )
  );
}

function AdditionalTunnelConnections({ primary = null, connections = [], statuses = [], desktop, onChange }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ label: '', tunnelId: '', apiKey: '' });
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState('');
  const [validation, setValidation] = useState(null);

  const statusFor = tunnelId => statuses.find(status => status.tunnelId === tunnelId) || null;
  const rows = [
    ...(primary?.tunnelId ? [{ connection: primary, status: primary, primary: true }] : []),
    ...connections.map(connection => ({ connection, status: statusFor(connection.tunnelId), primary: false }))
  ];
  const statusSummary = tunnelConnectionStatusSummary(rows.map(row => row.status));
  const updateDraft = patch => {
    setValidation(null);
    setDraft(current => ({ ...current, ...patch }));
  };
  const add = async () => {
    const issue = validateAdditionalTunnel(draft);
    if (issue) {
      setValidation(issue);
      setOpen(true);
      return;
    }
    setBusy('add');
    try {
      const result = await desktop.saveTunnel({
        label: draft.label,
        tunnelId: draft.tunnelId,
        apiKey: draft.apiKey
      });
      onChange?.({
        connections: Array.isArray(result?.connections) ? result.connections : connections,
        statuses: Array.isArray(result?.statuses) ? result.statuses : statuses
      });
      setDraft({ label: '', tunnelId: '', apiKey: '' });
      setShowSecret(false);
      requestDashboardRefresh();
      if (result?.ok === false) {
        toast(result?.status?.error || 'The tunnel was saved, but it could not connect.', { variant: 'error' });
      } else {
        toast('ChatGPT tunnel added.', { variant: 'success' });
        setOpen(false);
      }
    } catch (error) {
      toast(messageOf(error), { variant: 'error' });
    } finally {
      setBusy('');
    }
  };
  const remove = async connection => {
    const confirmed = await confirmAction({
      title: `Remove ${connection.label}?`,
      message: 'Remove this ChatGPT tunnel from Rel.AI?',
      detail: 'This stops only this tunnel-client connection. The primary tunnel, local projects, tasks, and other ChatGPT tunnel connections are not changed.',
      confirmLabel: 'Remove tunnel',
      danger: true
    });
    if (!confirmed) return;
    setBusy(connection.tunnelId);
    try {
      const result = await desktop.removeTunnel(connection.tunnelId);
      onChange?.({
        connections: Array.isArray(result?.connections) ? result.connections : [],
        statuses: Array.isArray(result?.statuses) ? result.statuses : []
      });
      requestDashboardRefresh();
      toast('ChatGPT tunnel removed.', { variant: 'success' });
    } catch (error) {
      toast(messageOf(error), { variant: 'error' });
    } finally {
      setBusy('');
    }
  };

  return h('section', { className: 'additional-tunnels', 'aria-labelledby': 'additionalTunnelsTitle' },
    h('div', { className: 'additional-tunnels-heading' },
      h('div', null,
        h('strong', { id: 'additionalTunnelsTitle' }, 'ChatGPT tunnel connections'),
        h('p', { className: 'settings-help' }, 'Each ChatGPT account can use its own Secure MCP Tunnel. Every tunnel reaches this same local Rel.AI service and the same configured workspaces.')
      ),
      h('button', {
        className: 'secondary compact-button',
        type: 'button',
        onClick: () => setOpen(value => !value),
        'aria-expanded': String(open),
        'aria-controls': 'additionalTunnelForm'
      }, open ? 'Cancel' : 'Add tunnel')
    ),
    rows.length ? h(React.Fragment, null,
      h('p', { className: 'additional-tunnel-summary', role: 'status' }, statusSummary),
      h('div', { className: 'additional-tunnel-list' },
        rows.map(row => {
          const { connection, status } = row;
          const view = tunnelRuntimeView(status);
          return h('div', {
            className: 'additional-tunnel-row',
            key: connection.tunnelId,
            'data-primary': row.primary ? 'true' : undefined
          },
            h('div', { className: 'additional-tunnel-copy' },
              h('strong', null, connection.label || (row.primary ? 'Primary connection' : connection.tunnelId)),
              h('small', null, row.primary ? 'Primary ChatGPT tunnel' : 'Additional ChatGPT tunnel'),
              h('span', { className: 'mono' }, connection.tunnelId),
              !row.primary && status?.error ? h('small', { className: 'additional-tunnel-error' }, status.error) : null
            ),
            h('div', { className: 'additional-tunnel-actions' },
              h(StatusPill, { label: view.label, tone: view.tone }),
              row.primary ? null : h('button', {
                className: 'secondary compact-button',
                type: 'button',
                disabled: Boolean(busy),
                onClick: () => void remove(connection)
              }, busy === connection.tunnelId ? 'Removing…' : 'Remove')
            )
          );
        })
      )
    ) : h('p', { className: 'muted additional-tunnels-empty' }, 'No ChatGPT tunnel connection is configured yet.'),
    open ? h('div', { id: 'additionalTunnelForm', className: 'additional-tunnel-form' },
      h(SettingsField, {
        label: 'Connection name',
        help: 'A local label such as Personal, School, or Account 2.',
        error: validation?.field === 'label' ? validation.message : '',
        inputId: 'additionalTunnelLabel'
      }, h('input', {
        id: 'additionalTunnelLabel',
        type: 'text',
        value: draft.label,
        maxLength: 80,
        autoComplete: 'off',
        'aria-invalid': validation?.field === 'label' ? 'true' : undefined,
        'aria-describedby': validation?.field === 'label' ? 'additionalTunnelLabelError additionalTunnelLabelHelp' : 'additionalTunnelLabelHelp',
        onChange: event => updateDraft({ label: event.currentTarget.value })
      })),
      h(SettingsField, {
        label: 'Tunnel ID',
        help: 'Create this tunnel while signed in to the ChatGPT account that will use it.',
        error: validation?.field === 'tunnelId' ? validation.message : '',
        inputId: 'additionalTunnelId'
      }, h('input', {
        id: 'additionalTunnelId',
        type: 'text',
        value: draft.tunnelId,
        autoComplete: 'off',
        spellCheck: false,
        'aria-invalid': validation?.field === 'tunnelId' ? 'true' : undefined,
        'aria-describedby': validation?.field === 'tunnelId' ? 'additionalTunnelIdError additionalTunnelIdHelp' : 'additionalTunnelIdHelp',
        onChange: event => updateDraft({ tunnelId: event.currentTarget.value.trim() })
      })),
      h(SettingsField, {
        label: 'Runtime API key',
        help: 'The runtime key for that account’s tunnel is encrypted on this computer.',
        error: validation?.field === 'apiKey' ? validation.message : '',
        inputId: 'additionalTunnelApiKey'
      }, h('div', { className: 'password-field' },
        h('input', {
          id: 'additionalTunnelApiKey',
          type: showSecret ? 'text' : 'password',
          value: draft.apiKey,
          placeholder: 'Paste runtime API key',
          autoComplete: 'off',
          spellCheck: false,
          'aria-invalid': validation?.field === 'apiKey' ? 'true' : undefined,
          'aria-describedby': validation?.field === 'apiKey' ? 'additionalTunnelApiKeyError additionalTunnelApiKeyHelp' : 'additionalTunnelApiKeyHelp',
          onChange: event => updateDraft({ apiKey: event.currentTarget.value.trim() })
        }),
        h('button', {
          className: 'secondary compact-button password-toggle',
          type: 'button',
          onClick: () => setShowSecret(value => !value)
        }, showSecret ? 'Hide' : 'Show')
      )),
      h('div', { className: 'additional-tunnel-form-actions' },
        h('a', { className: 'buttonlike secondary compact-button', href: 'https://platform.openai.com/settings/organization/tunnels', target: '_blank', rel: 'noopener noreferrer' }, 'OpenAI Tunnels'),
        h('button', { className: 'primary', type: 'button', disabled: busy === 'add', onClick: () => void add() }, busy === 'add' ? 'Adding…' : 'Add ChatGPT tunnel')
      )
    ) : null
  );
}

function validateAdditionalTunnel(value) {
  if (String(value.label || '').trim().length > 80) return { field: 'label', message: 'Use a connection name of 80 characters or fewer.' };
  if (!/^tunnel_[A-Za-z0-9_-]{8,200}$/.test(String(value.tunnelId || '').trim())) return { field: 'tunnelId', message: 'Enter a valid OpenAI Secure MCP Tunnel ID beginning with tunnel_.' };
  if (String(value.apiKey || '').trim().length < 12 || /\s/.test(String(value.apiKey || '').trim())) return { field: 'apiKey', message: 'Enter the runtime API key for this tunnel with no spaces.' };
  return null;
}

function tunnelConnectionStatusSummary(statuses = []) {
  const views = statuses.map(tunnelRuntimeView);
  const count = status => views.filter(view => view.status === status).length;
  const parts = [`${views.length} tunnel${views.length === 1 ? '' : 's'}`];
  const connected = count('available');
  const reconnecting = count('degraded');
  const connecting = count('connecting');
  const failed = count('unavailable');
  const stopped = count('disabled');
  if (connected) parts.push(`${connected} connected`);
  if (reconnecting) parts.push(`${reconnecting} reconnecting`);
  if (connecting) parts.push(`${connecting} connecting`);
  if (failed) parts.push(`${failed} failed`);
  if (stopped) parts.push(`${stopped} stopped`);
  return parts.join(' · ');
}

function validateConnectionSettings(value) {
  if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) return { field: 'port', message: 'Enter a local connection port from 1024 to 65535.' };
  if (!/^tunnel_[A-Za-z0-9_-]{8,200}$/.test(value.tunnelId)) return { field: 'tunnelId', message: 'Enter a valid OpenAI Secure MCP Tunnel ID beginning with tunnel_.' };
  if (!value.tunnelApiKeyConfigured && !value.tunnelApiKey) return { field: 'tunnelApiKey', message: 'Enter the OpenAI Secure MCP Tunnel runtime API key.' };
  if (value.tunnelApiKey && (value.tunnelApiKey.length < 12 || /\s/.test(value.tunnelApiKey))) return { field: 'tunnelApiKey', message: 'Enter a valid runtime API key with no spaces.' };
  return null;
}

function connectionSnapshot(value) {
  return JSON.stringify({
    port: Number(value?.port || 0),
    tunnelId: String(value?.tunnelId || '').trim(),
    replacementKeyPresent: Boolean(String(value?.tunnelApiKey || '').trim())
  });
}

function tunnelCredentialError(value = {}) {
  const code = String(value.tunnelErrorCode || '');
  if (code === 'tunnel_authentication_failed') return value.tunnelError || 'OpenAI rejected the runtime API key. Replace it with the correct key, then reconnect.';
  if (code === 'tunnel_access_denied') return value.tunnelError || 'This runtime API key does not have access to the configured tunnel.';
  if (code === 'tunnel_not_found') return value.tunnelError || 'The configured tunnel could not be found for this OpenAI account.';
  return '';
}

function PreferencesPage() {
  const [theme, setTheme] = useState(() => getUiPreferences().theme);
  return h(React.Fragment, null,
    h(SettingsHeader, { title: 'Preferences' }),
    h(Card, { title: 'Appearance' },
      h('div', { className: 'settings-field' },
        h('span', null, 'Theme'),
        h(ThemeSwitch, { theme, onChange: value => { setTheme(value); setThemePreference(value); } }),
        h('p', { className: 'settings-help' }, 'Applies to the dashboard and Rel.AI Pulse. Setup and recovery windows follow your system appearance.')
      )
    ),
    h(PulsePreference),
    h(DesktopNotificationsSettings)
  );
}

function PulsePreference() {
  const desktop = window.relaiDesktop;
  const [enabled, setEnabled] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (typeof desktop?.getLifecycleStatus !== 'function') return undefined;
    let active = true;
    void desktop.getLifecycleStatus().then(status => { if (active) setEnabled(status?.pulseEnabled !== false); }).catch(() => { if (active) setEnabled(null); });
    return () => { active = false; };
  }, [desktop]);
  if (typeof desktop?.getLifecycleStatus !== 'function' || typeof desktop?.setAppPreferences !== 'function') {
    return h(Card, { title: 'Rel.AI Pulse' }, h('p', { className: 'settings-help' }, 'Pulse settings are available only inside the installed Rel.AI desktop app.'));
  }
  if (enabled == null) return h(Card, { title: 'Rel.AI Pulse' }, h('div', { className: 'settings-loading', role: 'status' }, 'Loading Pulse preference…'));
  const update = async value => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await desktop.setAppPreferences({ pulseEnabled: value });
      if (result?.ok === false) throw new Error(result.error || 'Rel.AI Pulse preference could not be changed.');
      setEnabled(typeof result?.status?.pulseEnabled === 'boolean' ? result.status.pulseEnabled : value);
    } catch (error) { toast(messageOf(error), { variant: 'error' }); }
    finally { setBusy(false); }
  };
  return h(Card, { title: 'Rel.AI Pulse' }, h(ToggleRow, {
    label: 'Show Rel.AI Pulse', checked: enabled, disabled: busy, busy,
    enabledLabel: 'Pulse on', disabledLabel: 'Pulse off',
    help: 'Show a small status card for Rel.AI activity. Approvals still happen in ChatGPT.',
    onChange: value => void update(value)
  }));
}

function PrivacyDataPage({ computerControl }) {
  return h(React.Fragment, null,
    h(SettingsHeader, { title: 'Privacy & data' }),
    h(ComputerControlSettings, { initial: computerControl }),
    h(BrowserDataSettings),
    h(TelemetrySettings),
    h(LocalDataSettings)
  );
}

function BrowserDataSettings() {
  const browser = window.relaiDesktop?.browser;
  const [model, setModel] = useState({ loading: true, sites: [], activePersistent: false, error: '' });
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    if (!browser?.listSavedSites || !browser?.getState) return;
    try {
      const [saved, state] = await Promise.all([browser.listSavedSites(), browser.getState()]);
      const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
      setModel({
        loading: false,
        sites: Array.isArray(saved?.sites) ? saved.sites : [],
        activePersistent: sessions.some(session => session?.profile === 'persistent'),
        error: ''
      });
    } catch (error) {
      setModel(current => ({ ...current, loading: false, error: messageOf(error) }));
    }
  }, [browser]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => typeof browser?.onState === 'function' ? browser.onState(state => {
    const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
    setModel(current => ({ ...current, activePersistent: sessions.some(session => session?.profile === 'persistent') }));
  }) : undefined, [browser]);
  if (!browser?.listSavedSites || !browser?.clearSavedSite || !browser?.clearSavedData) {
    return h(Card, { title: 'Browser data' }, h('p', { className: 'settings-help' }, 'Saved browser-data controls are available only inside the installed Rel.AI desktop app.'));
  }

  const clearSite = async site => {
    const confirmed = await confirmAction({
      title: `Remove saved data for ${site.host}?`,
      message: `Remove Rel.AI browser data for ${site.host}?`,
      detail: 'This signs Rel.AI out of this site and removes its cookies and site storage from all saved Rel.AI browser profiles. Other sites are not changed.',
      confirmLabel: 'Remove site data',
      danger: true
    });
    if (!confirmed) return;
    setBusy(site.origin);
    try {
      const result = await browser.clearSavedSite(site.origin);
      if (result?.ok === false) throw new Error(result.error || 'Saved site data could not be removed.');
      toast(`Saved browser data removed for ${site.host}.`, { variant: 'success' });
      await load();
    } catch (error) { toast(messageOf(error), { variant: 'error' }); }
    finally { setBusy(''); }
  };
  const clearAll = async () => {
    const confirmed = await confirmAction({
      title: 'Clear all saved browser data?',
      message: 'Clear all saved Rel.AI browser sign-ins and site data?',
      detail: 'This signs Rel.AI out of saved sites in every persistent browser profile. Private browser sessions are not affected.',
      confirmLabel: 'Clear all browser data',
      danger: true
    });
    if (!confirmed) return;
    setBusy('all');
    try {
      const result = await browser.clearSavedData();
      if (result?.ok === false) throw new Error(result.error || 'Saved browser data could not be cleared.');
      toast(result?.cleared === true ? 'Saved browser data cleared.' : 'No saved browser data was found.', { variant: 'success' });
      await load();
    } catch (error) { toast(messageOf(error), { variant: 'error' }); }
    finally { setBusy(''); }
  };

  const sites = Array.isArray(model.sites) ? model.sites : [];
  const accountSites = sites.filter(site => !isDevelopmentBrowserSite(site));
  const developmentSites = sites.filter(isDevelopmentBrowserSite);
  const countLabel = model.loading
    ? 'Loading saved sites…'
    : model.error
      ? 'Saved sites unavailable'
      : `${sites.length} saved ${sites.length === 1 ? 'site' : 'sites'}`;

  return h(Card, { title: 'Browser data', className: 'browser-data-settings' },
    h('div', { className: 'browser-profile-summary' },
      h('div', { className: 'setting-row-copy' },
        h('strong', null, 'Remember site sign-ins'),
        h('span', null, 'Rel.AI reuses authenticated sessions in its own dedicated browser profile. It does not automatically use your personal Chrome profile. ChatGPT can explicitly start a private session when sign-ins should not be retained.')
      ),
      h(StatusPill, { label: 'On', tone: 'good' })
    ),
    h('details', { className: 'browser-site-disclosure' },
      h('summary', { className: 'browser-site-disclosure-summary' },
        h('span', null,
          h('strong', null, 'Manage saved sites'),
          h('small', null, countLabel)
        )
      ),
      h('div', { className: 'browser-site-disclosure-body' },
        model.loading ? h('div', { className: 'settings-loading', role: 'status' }, 'Loading saved sites…') : null,
        model.error ? h('p', { className: 'settings-help', role: 'alert' }, model.error) : null,
        !model.loading && !model.error && accountSites.length
          ? h(BrowserSiteList, { sites: accountSites, busy, disabled: model.activePersistent, onRemove: clearSite })
          : null,
        !model.loading && !model.error && developmentSites.length
          ? h('details', { className: 'browser-development-sites' },
            h('summary', null,
              h('span', null, 'Development sites'),
              h('small', null, `${developmentSites.length} ${developmentSites.length === 1 ? 'site' : 'sites'}`)
            ),
            h('div', { className: 'browser-development-sites-body' },
              h(BrowserSiteList, { sites: developmentSites, busy, disabled: model.activePersistent, onRemove: clearSite })
            )
          )
          : null,
        !model.loading && !model.error && !sites.length
          ? h('div', { className: 'browser-sites-empty' }, 'No saved site data found.')
          : null,
        model.activePersistent
          ? h('p', { className: 'settings-help browser-site-warning' }, 'Stop persistent browser sessions before removing saved browser data.')
          : null,
        !model.loading && !model.error && sites.length
          ? h('div', { className: 'browser-site-actions' },
            h('button', {
              className: 'secondary danger',
              type: 'button',
              disabled: model.activePersistent || Boolean(busy),
              onClick: () => void clearAll()
            }, busy === 'all' ? 'Clearing…' : 'Clear all browser data')
          )
          : null
      )
    )
  );
}
function BrowserSiteList({ sites, busy, disabled, onRemove }) {
  return h('div', { className: 'browser-site-list' },
    sites.map(site => h('div', { className: 'browser-site-row', key: site.origin },
      h('div', { className: 'browser-site-copy' },
        h('strong', null, site.host || site.origin),
        Number(site.profileCount || 0) > 1
          ? h('span', null, `${site.profileCount} Rel.AI profiles`)
          : null
      ),
      h('button', {
        className: 'secondary compact-button',
        type: 'button',
        disabled: disabled || Boolean(busy),
        onClick: () => void onRemove(site)
      }, busy === site.origin ? 'Removing…' : 'Remove data')
    ))
  );
}

function isDevelopmentBrowserSite(site = {}) {
  try {
    const hostname = new URL(String(site.origin || '')).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname === '0.0.0.0'
      || hostname === '::1'
      || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}


function ThemeSwitch({ theme, onChange }) {
  const options = [
    ['system', 'Follow system appearance'], ['dark', 'Dark theme'], ['light', 'Light theme']
  ];
  const refs = useRef([]);
  const selectIndex = index => {
    const option = options[index];
    if (!option) return;
    refs.current[index]?.focus();
    onChange(option[0]);
  };
  return h('div', { className: 'theme-switch', role: 'radiogroup', 'aria-label': 'Theme', onKeyDown: event => {
    const index = options.findIndex(([value]) => value === theme);
    let next = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    if (next == null) return;
    event.preventDefault();
    selectIndex(next);
  } }, options.map(([value, label], index) => h('button', {
    key: value, type: 'button', className: 'theme-switch-option', title: label, role: 'radio', 'data-theme-option': value,
    'aria-label': label, 'aria-checked': String(theme === value), tabIndex: theme === value ? 0 : -1,
    ref: element => { refs.current[index] = element; }, onClick: () => onChange(value)
  }, h(Icon, { name: value }))));
}

function DesktopNotificationsSettings() {
  const bridge = window.relaiDesktop;
  const [preferences, setPreferences] = useState(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!bridge?.getNotificationPreferences) return undefined;
    let active = true;
    void bridge.getNotificationPreferences().then(result => {
      if (active) setPreferences(normalizeNotificationPreferences(result?.preferences || result));
    }).catch(() => { if (active) setPreferences(null); });
    return () => { active = false; };
  }, [bridge]);

  if (!bridge?.setNotificationPreferences || !bridge?.getNotificationPreferences || !preferences) {
    return h(Card, { title: 'Desktop notifications' }, h('p', { className: 'muted' }, 'Desktop notification controls are available only inside the installed Rel.AI desktop app.'));
  }
  const update = async patch => {
    if (pending) return;
    const previous = preferences;
    setPending(true);
    try {
      const result = await bridge.setNotificationPreferences(patch);
      if (result?.ok === false) throw new Error(result.error || 'Desktop notification preferences could not be changed.');
      setPreferences(normalizeNotificationPreferences(result?.preferences || { ...preferences, ...patch }));
    } catch (error) {
      setPreferences(previous);
      toast(messageOf(error), { variant: 'error' });
    } finally {
      setPending(false);
    }
  };
  return h(Card, { title: 'Desktop notifications' },
    h(ToggleRow, {
      label: 'Desktop notifications', checked: preferences.enabled, disabled: pending, busy: pending,
      enabledLabel: 'Notifications on', disabledLabel: 'Notifications off',
      help: 'Turn desktop notifications on or off. Your category choices are kept while notifications are off.',
      onChange: value => void update({ enabled: value })
    }),
    NOTIFICATION_CATEGORIES.map(([key, label, help]) => h(ToggleRow, {
      key, label, help, checked: preferences[key], disabled: pending || !preferences.enabled, busy: pending,
      enabledLabel: 'On', disabledLabel: 'Off', onChange: value => void update({ [key]: value })
    })),
    preferences.ignoredUpdateVersion ? h('div', { className: 'settings-field' },
      h('span', null, 'Muted update notification'),
      h('div', { className: 'connection-actions' },
        h('code', null, `v${preferences.ignoredUpdateVersion}`),
        h('button', { className: 'secondary', type: 'button', disabled: pending, onClick: () => void update({ ignoredUpdateVersion: '' }) }, `Show notifications for v${preferences.ignoredUpdateVersion} again`)
      ),
      h('p', { className: 'settings-help' }, 'Only this version is muted. Newer versions can still notify you.')
    ) : null
  );
}

function normalizeNotificationPreferences(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const bool = (key, fallback) => typeof source[key] === 'boolean' ? source[key] : fallback;
  return {
    enabled: bool('enabled', NOTIFICATION_DEFAULTS.enabled),
    taskCompleted: bool('taskCompleted', NOTIFICATION_DEFAULTS.taskCompleted),
    errors: bool('errors', NOTIFICATION_DEFAULTS.errors),
    connectionStatus: bool('connectionStatus', NOTIFICATION_DEFAULTS.connectionStatus),
    applicationUpdates: bool('applicationUpdates', NOTIFICATION_DEFAULTS.applicationUpdates),
    ignoredUpdateVersion: String(source.ignoredUpdateVersion || '').trim().replace(/^v/i, '').slice(0, 80)
  };
}

function ApplicationPage() {
  const [lifecycle, setLifecycle] = useState(undefined);
  const developerOptionsUnlocked = readDeveloperOptionsUnlocked();
  const [developerFeatures, setDeveloperFeatures] = useState(() => Object.fromEntries(
    DEVELOPER_FEATURE_FLAGS.map(feature => [feature.id, readDeveloperFeatureEnabled(feature.id)])
  ));
  const desktop = window.relaiDesktop;
  useEffect(() => {
    let active = true;
    if (typeof desktop?.getLifecycleStatus !== 'function') setLifecycle(null);
    else void desktop.getLifecycleStatus().then(status => { if (active) setLifecycle(status); }).catch(() => { if (active) setLifecycle(null); });
    return () => { active = false; };
  }, [desktop]);
  return h(React.Fragment, null,
    h(SettingsHeader, { title: 'App' }),
    lifecycle === undefined ? h('div', { className: 'settings-loading', role: 'status' }, 'Loading app settings…') : h(React.Fragment, null,
      h(StartupSettings, { initial: lifecycle }),
      h(ApplicationUpdates, { lifecycle }),
      developerOptionsUnlocked ? h(DeveloperOptions, {
        enabledFeatures: developerFeatures,
        onChange: (feature, enabled) => setDeveloperFeatures(current => ({
          ...current,
          [feature]: writeDeveloperFeatureEnabled(feature, enabled)
        }))
      }) : null,
      typeof desktop?.quitApp === 'function' ? h(Card, { title: 'Application controls' }, h(QuitRow)) : null
    )
  );
}

function DeveloperOptions({ enabledFeatures, onChange }) {
  return h('details', { className: 'settings-advanced developer-options' },
    h('summary', null, 'Developer options'),
    h('div', { className: 'settings-panel-body' },
      h('p', { className: 'settings-help' }, 'Enable only the experimental features you want to use.'),
      DEVELOPER_FEATURE_FLAGS.map(feature => h(ToggleRow, {
        key: feature.id,
        label: feature.label,
        help: feature.help,
        checked: enabledFeatures[feature.id] === true,
        onChange: enabled => onChange(feature.id, enabled)
      }))
    )
  );
}

function TelemetrySettings() {
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let active = true;
    void fetchJson('/api/telemetry', { cache: 'no-store' }).then(result => {
      if (!active) return;
      if (!result?.ok) throw new Error(result?.error || 'Telemetry settings could not be loaded.');
      setSettings(result.settings || {});
      setLoadError('');
    }).catch(error => {
      if (!active) return;
      setLoadError(messageOf(error));
    });
    return () => { active = false; };
  }, []);

  const updateDiagnostics = async enabled => {
    if (!settings || busy) return;
    setBusy(true);
    try {
      const result = await postJson('/api/telemetry', { diagnosticsEnabled: enabled });
      if (!result?.ok) throw new Error(result?.error || 'Diagnostic telemetry could not be changed.');
      setSettings(result.settings || {});
      toast(enabled ? 'Diagnostic telemetry enabled.' : 'Diagnostic telemetry disabled.', { variant: 'success' });
    } catch (error) {
      toast(messageOf(error), { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  if (!settings) {
    return h(Card, { title: 'Diagnostics' },
      h('p', { className: 'settings-help', role: loadError ? 'alert' : 'status' }, loadError || 'Loading telemetry settings…')
    );
  }

  const diagnosticsEnabled = settings.diagnosticsEnabled !== false;
  const lastDiagnosticSuccess = String(settings.diagnosticsLastSuccessAt || '');
  const lastDiagnosticFailure = String(settings.diagnosticsLastFailureAt || '');
  const diagnosticDelivery = !diagnosticsEnabled
    ? 'Diagnostic export is off.'
    : lastDiagnosticFailure && (!lastDiagnosticSuccess || Date.parse(lastDiagnosticFailure) > Date.parse(lastDiagnosticSuccess))
      ? `Last delivery failed ${new Date(lastDiagnosticFailure).toLocaleString()}. Rel.AI will keep working and retry on later batches.`
      : lastDiagnosticSuccess
        ? `Last diagnostic batch delivered ${new Date(lastDiagnosticSuccess).toLocaleString()}.`
        : settings.diagnosticsActive
          ? 'Diagnostic exporter is ready. No successful batch has been recorded in this app session yet.'
          : 'Diagnostic exporter is not currently active.';
  return h(Card, { title: 'Diagnostics' },
    h(ToggleRow, {
      label: 'Diagnostic telemetry',
      checked: diagnosticsEnabled,
      disabled: busy,
      busy,
      enabledLabel: 'Diagnostic telemetry on',
      disabledLabel: 'Diagnostic telemetry off',
      help: 'Helps identify reliability and performance problems. Diagnostic traces can include tool and project identifiers, timings, and complete command text with common credential patterns redacted. Prompts, file contents, command output, and raw error messages are not added as telemetry fields.',
      onChange: value => void updateDiagnostics(value)
    }),
    h('p', { className: 'settings-help', role: 'status' }, diagnosticDelivery)
  );
}

function StartupSettings({ initial }) {
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState('');
  const desktop = window.relaiDesktop;
  useEffect(() => setState(initial), [initial]);
  if (!state) return h(Card, { title: 'Startup & background', className: 'desktop-startup-panel' }, h('p', { className: 'muted' }, 'Application controls are available only inside the installed desktop app.'));

  const update = async (key, enabled) => {
    setBusy(key);
    try {
      let result;
      if (key === 'launchAtLogin') result = await desktop?.setLaunchAtLogin?.(enabled);
      else if (key === 'keepAwake') result = await desktop?.setKeepAwake?.(enabled);
      else result = await desktop?.setAppPreferences?.({ [key]: enabled });
      const nextStatus = result?.status || {};
      if (key === 'launchAtLogin') setState(current => ({ ...current, launchAtLogin: { ...current.launchAtLogin, ...nextStatus.launchAtLogin } }));
      else setState(current => ({ ...current, [key]: nextStatus[key] === true }));
      if (result?.ok === false) toast(result.error || 'Application setting could not be changed.', { variant: 'error' });
    } catch (error) {
      toast(messageOf(error), { variant: 'error' });
    } finally {
      setBusy('');
    }
  };
  const launch = state.launchAtLogin || {};
  return h(Card, { title: 'Startup & background', className: 'desktop-startup-panel' },
    h(ToggleRow, {
      label: 'Launch Rel.AI at sign-in', checked: launch.enabled === true, disabled: busy === 'launchAtLogin' || !launch.supported, busy: busy === 'launchAtLogin',
      enabledLabel: 'Launch at sign-in on', disabledLabel: 'Launch at sign-in off',
      help: launch.supported ? 'Start Rel.AI after you sign in.' : launch.reason || 'This build cannot register itself for sign-in.',
      onChange: value => void update('launchAtLogin', value)
    }),
    h(ToggleRow, {
      label: 'Keep Rel.AI running when I close the window', checked: state.keepRunningOnClose !== false, disabled: busy === 'keepRunningOnClose', busy: busy === 'keepRunningOnClose',
      enabledLabel: 'Keep running on close', disabledLabel: 'Quit on close',
      help: 'Keep the local ChatGPT connection available after you close the dashboard.',
      onChange: value => void update('keepRunningOnClose', value)
    }),
    h(ToggleRow, {
      label: 'Keep computer awake', checked: state.keepAwake === true, disabled: busy === 'keepAwake', busy: busy === 'keepAwake',
      enabledLabel: 'Keep computer awake on', disabledLabel: 'Keep computer awake off',
      help: 'Prevents this computer from automatically sleeping or hibernating while Rel.AI is running. The display can still turn off normally.',
      onChange: value => void update('keepAwake', value)
    }),
    h(ToggleRow, {
      label: 'Reduced background work', checked: state.reducedBackgroundWork === true, disabled: busy === 'reducedBackgroundWork', busy: busy === 'reducedBackgroundWork',
      enabledLabel: 'Reduced background work on', disabledLabel: 'Reduced background work off',
      help: 'Skip optional repository preparation to reduce idle CPU and memory use. Repository analysis still runs when a task needs it.',
      onChange: value => void update('reducedBackgroundWork', value)
    }),
    state.updated ? h(LifecycleNotice, { tone: 'ok', title: 'Update completed', text: `Rel.AI started successfully after updating from v${state.previousVersion || 'an earlier version'} to v${state.currentVersion || 'the current version'}.` }) : null
  );
}

function LifecycleNotice({ tone, title, text }) {
  return h('div', { className: `connection-notice ${tone} desktop-lifecycle-notice` }, h('strong', null, title), h('p', null, text));
}

function ComputerControlSettings({ initial = {} }) {
  const [enabled, setEnabled] = useState(initial?.enabled === true);
  const [busy, setBusy] = useState(false);
  useEffect(() => setEnabled(initial?.enabled === true), [initial?.enabled]);
  const help = 'Allow ChatGPT to use local desktop actions through Rel.AI. Rel.AI uses direct file and app actions when possible. Full pointer or keyboard control is used only when necessary. Operating-system permissions still apply.';
  const update = async value => {
    setBusy(true);
    const result = await postJson('/api/computer', { enabled: value }, { cache: 'no-store' }).catch(error => ({ ok: false, error: messageOf(error) }));
    setBusy(false);
    if (!result?.ok) { toast(result?.error || 'Could not save computer control settings.', { variant: 'error' }); return; }
    setEnabled(result?.settings?.enabled === true);
    toast(value ? 'Computer control is enabled.' : 'Computer control is disabled.', { variant: 'success' });
  };
  return h(Card, { title: 'Computer control' }, h(ToggleRow, {
    label: 'Allow computer control', checked: enabled, disabled: busy, busy,
    enabledLabel: 'Allowed', disabledLabel: 'Off', help, onChange: value => void update(value)
  }));
}

function ApplicationUpdates({ lifecycle }) {
  const bridge = window.relaiDesktop;
  const supported = Boolean(bridge?.getUpdateStatus && bridge?.checkForUpdates && bridge?.downloadUpdate && bridge?.installUpdate);
  const [status, setStatus] = useState(null);
  const [releaseNotes, setReleaseNotes] = useState(null);
  const [autoDownload, setAutoDownload] = useState(lifecycle?.autoDownloadUpdates !== false);
  const [updateChannel, setUpdateChannel] = useState(lifecycle?.updateChannel === 'beta' ? 'beta' : 'stable');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (!supported) return undefined;
    let active = true;
    const remove = typeof bridge.onUpdateStatus === 'function' ? bridge.onUpdateStatus(next => { if (active) setStatus(next); }) : null;
    void Promise.all([ bridge.getUpdateStatus(), fetchJson('/api/release-notes').catch(() => null) ]).then(([nextStatus, notes]) => {
      if (!active) return;
      setStatus(nextStatus);
      setReleaseNotes(notes?.ok === false ? null : notes);
    }).catch(error => { if (active) setStatus({ state: 'error', error: messageOf(error), errorCode: 'update_failed' }); });
    return () => { active = false; if (typeof remove === 'function') remove(); };
  }, [bridge, supported]);

  if (!supported) return h(Card, { title: 'App updates', className: 'application-update-panel' },
    h('div', { className: 'application-update-summary' }, h('div', null, h('span', { className: 'application-update-label' }, 'Update method'), h('strong', null, 'Manual download')), h(StatusPill, { label: 'Desktop required', tone: 'warn' })),
    h('p', { className: 'muted application-update-copy' }, 'Automatic updates are managed by the installed Rel.AI desktop app.'),
    h('div', { className: 'connection-actions' }, h('a', { className: 'buttonlike secondary', href: RELEASES_URL, target: '_blank', rel: 'noreferrer' }, 'GitHub Releases'))
  );
  const updateAuto = async value => {
    if (typeof bridge.setAppPreferences !== 'function') return;
    setBusy('auto');
    try {
      const result = await bridge.setAppPreferences({ autoDownloadUpdates: value });
      const actual = result?.status?.autoDownloadUpdates === true;
      setAutoDownload(actual);
      if (result?.ok === false) toast(result.error || 'Automatic update downloads could not be changed.', { variant: 'error' });
    } catch (error) { toast(messageOf(error), { variant: 'error' }); }
    finally { setBusy(''); }
  };
  const updateReleaseChannel = async value => {
    if (typeof bridge.setAppPreferences !== 'function') return;
    setBusy('channel');
    try {
      const result = await bridge.setAppPreferences({ updateChannel: value });
      const actual = result?.status?.updateChannel === 'beta' ? 'beta' : 'stable';
      setUpdateChannel(actual);
      if (result?.ok === false) toast(result.error || 'The update channel could not be changed.', { variant: 'error' });
    } catch (error) { toast(messageOf(error), { variant: 'error' }); }
    finally { setBusy(''); }
  };
  const run = async action => {
    const method = { check: 'checkForUpdates', download: 'downloadUpdate', install: 'installUpdate', defer: 'installUpdate' }[action];
    if (!method) return;
    setBusy(action);
    try {
      const args = action === 'defer' ? [{ deferIfBusy: true }] : [];
      const result = await bridge[method](...args);
      if (result?.status) setStatus(result.status);
      if (result?.ok === false) toast(result.error || 'The update action failed.', { variant: 'error' });
    } catch (error) {
      const message = messageOf(error);
      setStatus(current => ({ ...(current || {}), state: 'error', error: message, errorCode: 'update_failed' }));
      toast(message, { variant: 'error' });
    } finally { setBusy(''); }
  };
  const current = status || { state: 'idle' };
  const view = updateView(current, autoDownload);
  const showReleaseNotes = ['available', 'downloading', 'downloaded', 'installing'].includes(String(current.state || ''));
  return h(Card, { title: 'App updates', className: 'application-update-panel' },
    h(SettingsField, { label: 'Release channel', inputId: 'updateReleaseChannel', help: 'Stable is recommended for normal use. Beta receives pre-release builds intended mainly for developers and testers.' },
      h('select', {
        id: 'updateReleaseChannel',
        value: updateChannel,
        disabled: busy === 'channel',
        'aria-describedby': updateChannel === 'beta' ? 'updateReleaseChannelHelp updateReleaseChannelWarning' : 'updateReleaseChannelHelp',
        onChange: event => void updateReleaseChannel(event.currentTarget.value)
      },
        h('option', { value: 'stable' }, 'Stable'),
        h('option', { value: 'beta' }, 'Beta / pre-release (developers & testers)')
      )
    ),
    updateChannel === 'beta' ? h('div', {
      className: 'application-update-beta-warning',
      id: 'updateReleaseChannelWarning',
      role: 'alert',
      'aria-atomic': 'true'
    },
      h('span', { className: 'application-update-beta-warning-icon', 'aria-hidden': 'true' }, h(Icon, { name: 'warning', size: 16 })),
      h('div', null,
        h('strong', null, 'Beta builds can contain serious bugs or incomplete changes'),
        h('p', null, 'Use Stable for normal work. You may need to reinstall if a beta build fails.')
      )
    ) : null,
    h(ToggleRow, {
      label: 'Download verified updates automatically', checked: autoDownload, disabled: busy === 'auto', busy: busy === 'auto',
      enabledLabel: 'Automatic downloads on', disabledLabel: 'Ask before downloading',
      help: 'Downloads verified updates automatically. Rel.AI still asks before installation.',
      onChange: value => void updateAuto(value)
    }),
    h('div', { className: 'application-update-status', 'data-auto-download-updates': String(autoDownload), 'data-update-channel': updateChannel },
      h('div', { className: 'application-update-summary' },
        h('div', null,
          h('span', { className: 'application-update-label' }, 'Installed version'),
          h('strong', null, current.currentVersion ? `v${current.currentVersion}` : 'Unknown version')
        ),
        h(StatusPill, { label: view.label, tone: view.tone })
      ),
      view.description ? h('p', { className: 'muted application-update-copy' }, view.description) : null,
      h(UpdateSupportPolicy, { policy: current.supportPolicy }),
      h(UpdateSynchronizationNotice, { synchronization: current.updateSynchronization }),
      showReleaseNotes ? h(UpdateReleaseNotes, { status: current, releaseNotes }) : null,
      current.state === 'downloading' ? h(UpdateProgress, { progress: current.progress }) : null,
      current.errorCode ? h('code', { className: 'application-update-code' }, `Error code: ${current.errorCode}`) : null,
      h('div', { className: 'connection-actions application-update-actions' },
        view.action ? h('button', { className: view.action.className, type: 'button', disabled: Boolean(busy), onClick: () => void run(view.action.id) }, busy === view.action.id ? `${view.action.label}…` : view.action.label) : null,
        view.secondary ? h('button', { className: 'secondary', type: 'button', disabled: Boolean(busy), onClick: () => void run(view.secondary.id) }, view.secondary.label) : null,
        ['unsupported', 'error'].includes(String(current.state || '')) ? h('a', { className: 'buttonlike secondary', href: RELEASES_URL, target: '_blank', rel: 'noreferrer' }, 'GitHub Releases') : null,
        current.state === 'error' ? h('a', { className: 'buttonlike secondary', href: '#diagnostics' }, 'Troubleshoot') : null
      )
    )
  );
}

function updateView(status = {}, autoDownload = false) {
  const state = String(status.state || 'idle');
  const availableVersion = status.availableVersion ? `v${status.availableVersion}` : '';
  if (state === 'unsupported') return { label: 'Manual update', tone: 'warn', description: status.supportReason || 'This build must be updated manually from GitHub Releases.' };
  if (state === 'checking') return { label: 'Checking', tone: 'working', description: 'Checking for a newer version of Rel.AI.' };
  if (state === 'up_to_date') return { label: 'Up to date', tone: 'ok', description: 'Rel.AI checks automatically once per day.', action: { id: 'check', label: 'Check again', className: 'secondary' } };
  if (state === 'available') return { label: 'Update available', tone: 'warn', description: autoDownload ? `${availableVersion || 'A newer version'} is available. Rel.AI will download it automatically without restarting.` : `${availableVersion || 'A newer version'} is available. Downloading does not restart Rel.AI.`, action: { id: 'download', label: `Download ${availableVersion || 'update'}`, className: 'primary' }, secondary: { id: 'check', label: 'Check again' } };
  if (state === 'downloading') return { label: 'Downloading', tone: 'working', description: `Downloading ${availableVersion || 'the update'}. You can keep using Rel.AI while it downloads.` };
  if (state === 'downloaded') {
    const opensDmg = status.installMode === 'open_dmg';
    if (status.installDeferred === true) return { label: 'Install queued', tone: 'working', description: `${availableVersion || 'The update'} is verified and will install automatically when active Rel.AI work finishes.` };
    if (status.canDeferInstall === true) return { label: 'Task in progress', tone: 'warn', description: `${availableVersion || 'The update'} is verified. Finish the active task, or queue installation for as soon as Rel.AI becomes idle.`, action: { id: 'defer', label: 'Install when task finishes', className: 'primary' } };
    return { label: 'Ready to install', tone: status.error ? 'warn' : 'ok', description: opensDmg ? `${availableVersion || 'The update'} is verified and downloaded. Opening the DMG will close Rel.AI so you can replace it in Applications.` : (status.error || `${availableVersion || 'The update'} is ready. Rel.AI stays open while it prepares the update, then restarts automatically to finish installation.`), action: { id: 'install', label: opensDmg ? 'Open DMG and close Rel.AI' : 'Install update', className: 'primary' } };
  }
  if (state === 'installing') return { label: 'Installing', tone: 'working', description: 'Rel.AI is temporarily paused while it prepares the update. It restarts automatically to finish installation.' };
  if (state === 'error') return { label: 'Update failed', tone: 'bad', description: status.error || 'The update could not be completed. The installed version is still available.', action: { id: 'check', label: 'Try again', className: 'primary' } };
  return { label: 'Updates enabled', tone: 'ok', description: '', action: { id: 'check', label: 'Check for updates', className: 'secondary' } };
}

function UpdateSynchronizationNotice({ synchronization }) {
  if (!synchronization || synchronization.status === 'current') return null;
  const deviceUpdate = synchronization.deviceUpdateRequired === true;
  const toolRefresh = synchronization.toolRefreshRequired === true;
  const message = deviceUpdate
    ? 'This update changes the Rel.AI device protocol. After restart, update any connected device-side Rel.AI component before using that device again.'
    : toolRefresh
      ? 'This update changes ChatGPT tool definitions. After Rel.AI restarts, you will be prompted to refresh the ChatGPT connector.'
      : '';
  if (!message) return null;
  return h('div', { className: 'connection-notice warn application-update-sync', role: 'status' },
    h('strong', null, deviceUpdate ? 'Device update required' : 'ChatGPT refresh required'),
    h('p', null, message)
  );
}

function UpdateSupportPolicy({ policy }) {
  if (!policy || String(policy.state || '') === 'current') return null;
  const view = supportPolicyView(policy);
  return h('div', { className: 'application-update-policy' },
    h('div', { className: 'application-update-summary' },
      h('div', null, h('span', { className: 'application-update-label' }, 'Version support'), h('strong', null, policy.minimumSupportedVersion ? `v${policy.minimumSupportedVersion} or newer` : 'Check unavailable')),
      h(StatusPill, { label: view.label, tone: view.tone })
    ),
    h('p', { className: 'muted application-update-copy' }, view.description)
  );
}

function UpdateReleaseNotes({ status, releaseNotes }) {
  const available = Array.isArray(status.releaseNotes) ? status.releaseNotes.filter(entry => String(entry?.note || '').trim()) : [];
  if (available.length) return h('details', { className: 'application-update-release-notes', open: true },
    h('summary', null, `What's new in ${status.availableVersion ? `v${status.availableVersion}` : 'the update'}`),
    h('div', { className: 'application-update-release-notes-body' }, available.map((entry, index) => h('div', { className: 'application-update-release-note', key: `${entry.version || ''}-${index}` }, entry.version && entry.version !== status.availableVersion ? h('strong', null, `v${entry.version}`) : null, h('p', null, normalizeReleaseNoteText(entry.note)))))
  );
  const releases = Array.isArray(releaseNotes?.releases) ? releaseNotes.releases.filter(entry => String(entry?.version || '').trim()) : [];
  if (releases.length) return h('details', { className: 'application-update-release-notes' }, h('summary', null, 'What changed'), h('div', { className: 'application-update-release-notes-body' }, releases.map(release => h(ChangelogRelease, { release, key: release.version }))));
  const bullets = Array.isArray(releaseNotes?.bullets) ? releaseNotes.bullets.filter(Boolean).slice(0, 8) : [];
  if (!releaseNotes?.version || (!releaseNotes?.headline && !bullets.length)) return null;
  return h('details', { className: 'application-update-release-notes' },
    h('summary', null, `What changed · v${releaseNotes.version}`),
    h('div', { className: 'application-update-release-notes-body' }, releaseNotes.headline ? h('p', { className: 'application-update-release-headline' }, releaseNotes.headline) : null, bullets.length ? h('ul', null, bullets.map((item, index) => h('li', { key: index }, item))) : null)
  );
}

function ChangelogRelease({ release }) {
  const sections = Array.isArray(release.sections) ? release.sections : [];
  const bullets = Array.isArray(release.bullets) ? release.bullets.filter(Boolean) : [];
  return h('section', { className: 'application-update-release-note' },
    h('strong', null, `v${release.version}${release.date ? ` · ${release.date}` : ''}`),
    sections.length ? sections.map((section, index) => h('div', { className: 'application-update-release-note', key: index }, section.title ? h('strong', null, section.title) : null, Array.isArray(section.bullets) && section.bullets.length ? h('ul', null, section.bullets.map((item, itemIndex) => h('li', { key: itemIndex }, item))) : null)) : h(React.Fragment, null, release.headline ? h('p', { className: 'application-update-release-headline' }, release.headline) : null, bullets.length ? h('ul', null, bullets.map((item, index) => h('li', { key: index }, item))) : null)
  );
}

function UpdateProgress({ progress = {} }) {
  const percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
  const transferred = formatBytes(progress.transferred);
  const total = formatBytes(progress.total);
  const speed = formatBytes(progress.bytesPerSecond);
  return h('div', { className: 'application-update-progress' },
    h('progress', { max: 100, value: percent, 'aria-label': 'Update download progress' }, `${percent}%`),
    h('span', null, `${percent.toFixed(1)}%${total ? ` · ${transferred} of ${total}` : ''}${speed ? ` · ${speed}/s` : ''}`)
  );
}

function LocalDataSettings() {
  const bridge = window.relaiDesktop;
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    if (!bridge?.getLocalDataUsage) return;
    try {
      const result = await bridge.getLocalDataUsage();
      if (result?.ok === false) throw new Error(result.error || 'Local data use could not be calculated.');
      setUsage(result || {}); setError('');
    } catch (loadError) { setError(messageOf(loadError)); }
  }, [bridge]);
  useEffect(() => { void load(); }, [load]);
  if (!bridge?.getLocalDataUsage) return h(Card, { title: 'Local data & storage', className: 'desktop-local-data-panel' }, h('p', { className: 'settings-help' }, 'Local data controls are available only inside the installed Rel.AI desktop app.'));
  if (!usage && !error) return h(Card, { title: 'Local data & storage', className: 'desktop-local-data-panel' }, h('div', { className: 'settings-loading', role: 'status' }, 'Calculating local data use…'));
  if (!usage) return h(Card, { title: 'Local data & storage', className: 'desktop-local-data-panel' }, h('p', { className: 'settings-help' }, error));
  const categories = usage.categories || {};
  const active = Math.max(0, Number(usage.activeTaskCount || 0));
  const clearTemporary = async () => {
    const confirmed = await confirmAction({ title: 'Clear temporary output', message: 'Clear saved temporary command output?', detail: 'This removes retained command-output files. Project files, task history, and other local data are not changed.', confirmLabel: 'Clear temporary output', danger: true });
    if (!confirmed) return;
    setBusy('temporary');
    const result = await bridge.clearTemporaryLocalData().catch(actionError => ({ ok: false, error: messageOf(actionError) }));
    setBusy('');
    if (!result?.ok) { toast(result?.error || 'Temporary command output could not be cleared.', { variant: 'error' }); return; }
    toast('Temporary command output cleared.', { variant: 'success' }); await load();
  };
  const clearHistory = async () => {
    const confirmed = await confirmAction({ title: 'Clear task history', message: 'Clear saved task and activity history?', detail: 'This history cannot be restored. Project files, connection settings, and other local data are not changed.', confirmLabel: 'Clear history', danger: true });
    if (!confirmed) return;
    setBusy('history');
    const result = await postJson('/api/diagnostics/reset', { target: 'history', confirm: true }).catch(actionError => ({ ok: false, error: messageOf(actionError) }));
    setBusy('');
    if (!result?.ok) { toast(result?.error || 'Task and activity history could not be cleared.', { variant: 'error' }); return; }
    toast(result.message || 'Task and activity history cleared.', { variant: 'success' }); requestDashboardRefresh(); await load();
  };
  const clearAnalytics = async () => {
    const confirmed = await confirmAction({
      title: 'Clear analytics',
      message: 'Clear local analytics history?',
      detail: 'This deletes local analytics history. It does not change project files, task history, memory, settings, or external telemetry settings.',
      confirmLabel: 'Clear analytics',
      danger: true
    });
    if (!confirmed) return;
    setBusy('analytics');
    const result = await postJson('/api/diagnostics/reset', { target: 'analytics', confirm: true }).catch(actionError => ({ ok: false, error: messageOf(actionError) }));
    setBusy('');
    if (!result?.ok) { toast(result?.error || 'Local analytics could not be cleared.', { variant: 'error' }); return; }
    toast(result.message || 'Local analytics cleared.', { variant: 'success' }); requestDashboardRefresh(); await load();
  };
  const clearAppLog = async () => {
    const confirmed = await confirmAction({ title: 'Clear app log', message: 'Clear the saved app log?', detail: 'The saved troubleshooting log cannot be restored. Project files, connection settings, and other local data are not changed.', confirmLabel: 'Clear app log', danger: true });
    if (!confirmed) return;
    setBusy('logs');
    const result = await postJson('/api/diagnostics/reset', { target: 'runtime_logs', confirm: true }).catch(actionError => ({ ok: false, error: messageOf(actionError) }));
    setBusy('');
    if (!result?.ok) { toast(result?.error || 'The saved app log could not be cleared.', { variant: 'error' }); return; }
    toast(result.message || 'Saved app log cleared.', { variant: 'success' }); requestDashboardRefresh(); await load();
  };
  const openFolder = async () => {
    setBusy('folder');
    const result = await bridge.openLocalDataFolder().catch(actionError => ({ ok: false, error: messageOf(actionError) }));
    setBusy('');
    if (!result?.ok) toast(result?.error || 'The Rel.AI data folder could not be opened.', { variant: 'error' });
  };
  return h(Card, { title: 'Local data & storage', className: 'desktop-local-data-panel' },
    h('div', { className: 'local-data-summary' },
      h('div', null, h('span', null, 'Total Rel.AI local data'), h('strong', null, `${formatBytes(usage.totalBytes, { zero: true })}${usage.approximate ? ' approx.' : ''}`)),
      h('small', null, 'Log out in Connection can remove all local Rel.AI data.')
    ),
    h('div', { className: 'local-data-list' },
      h(DataRow, { label: 'Task & activity history', bytes: categories.history?.bytes }),
      h(DataRow, { label: 'Saved app log', bytes: categories.logs?.bytes }),
      h(DataRow, { label: 'Temporary command output', bytes: categories.temporary?.bytes }),
      h(DataRow, { label: 'Repository indexes', bytes: categories.indexes?.bytes }),
      h(DataRow, { label: 'Other Rel.AI app data', bytes: categories.other?.bytes })
    ),
    h('div', { className: 'local-data-actions' },
      h('button', { className: 'secondary', type: 'button', disabled: active > 0 || busy === 'temporary', onClick: () => void clearTemporary() }, busy === 'temporary' ? 'Clearing…' : 'Clear temporary output'),
      h('button', { className: 'secondary danger', type: 'button', disabled: active > 0 || busy === 'history', onClick: () => void clearHistory() }, busy === 'history' ? 'Clearing…' : 'Clear task & activity history'),
      h('button', { className: 'secondary danger', type: 'button', disabled: busy === 'analytics', onClick: () => void clearAnalytics() }, busy === 'analytics' ? 'Clearing…' : 'Clear analytics'),
      h('button', { className: 'secondary danger', type: 'button', disabled: busy === 'logs', onClick: () => void clearAppLog() }, busy === 'logs' ? 'Clearing…' : 'Clear app log'),
      h('button', { className: 'secondary', type: 'button', disabled: busy === 'folder', onClick: () => void openFolder() }, busy === 'folder' ? 'Opening…' : 'Data folder')
    ),
    active > 0 ? h('p', { className: 'settings-help' }, `Finish the ${active === 1 ? 'active task' : `${active} active tasks`} before clearing local task data.`) : null
  );
}

function DataRow({ label, bytes }) { return h('div', { className: 'local-data-row' }, h('span', null, label), h('strong', null, formatBytes(bytes, { zero: true }))); }

function LogoutRow() {
  const [busy, setBusy] = useState(false);
  const logout = async () => {
    const keepData = await requestLogoutChoice();
    if (keepData === null) return;
    setBusy(true);
    try {
      await window.relaiDesktop.logout(!keepData);
    } catch (error) {
      setBusy(false);
      toast(messageOf(error), { variant: 'error' });
    }
  };
  return h('div', { className: 'setting-row' },
    h('div', { className: 'setting-row-copy' }, h('strong', null, 'Log out'), h('span', null, 'Disconnect the saved OpenAI tunnel from this Rel.AI installation.')),
    h('button', { className: 'secondary settings-nowrap-action', type: 'button', disabled: busy, onClick: () => void logout() }, busy ? 'Logging out…' : 'Log out')
  );
}

function requestLogoutChoice() {
  return new Promise(resolve => {
    let settled = false;
    let modal = null;
    const settle = value => {
      if (settled) return;
      settled = true;
      modal?.close();
      resolve(value);
    };
    modal = openModal({
      title: 'Log out of Rel.AI',
      content: h(LogoutChoice, { onCancel: () => settle(null), onConfirm: keepData => settle(keepData) }),
      size: 'standard',
      onClose: () => { if (!settled) { settled = true; resolve(null); } }
    });
  });
}

function LogoutChoice({ onCancel, onConfirm }) {
  const [keepData, setKeepData] = useState(true);
  return h('div', { className: 'confirm-dialog' },
    h('div', { className: 'confirm-dialog-copy' },
      h('strong', null, 'Log out of Rel.AI?'),
      h('span', null, 'Logging out always removes the saved OpenAI tunnel connection from this installation.'),
      h('label', { className: 'toggle-control' },
        h('input', {
          type: 'checkbox',
          checked: keepData,
          onChange: event => setKeepData(event.currentTarget.checked)
        }),
        h('span', null, 'Keep my local Rel.AI data')
      ),
      h('span', null, keepData
        ? 'Project configuration, task and activity history, analytics, repository indexes, caches, and app preferences will stay on this computer.'
        : 'All Rel.AI-owned local data will be deleted before logout. Project folders and project files are never deleted.')
    ),
    h('div', { className: 'modal-actions' },
      h('button', { type: 'button', className: 'secondary', onClick: onCancel }, 'Cancel'),
      h('button', { type: 'button', className: keepData ? 'primary' : 'danger', onClick: () => onConfirm(keepData) }, 'Log out')
    )
  );
}

function QuitRow() {
  const [busy, setBusy] = useState(false);
  const quit = async () => {
    setBusy(true);
    try { await window.relaiDesktop.quitApp(); }
    catch (error) { setBusy(false); toast(messageOf(error), { variant: 'error' }); }
  };
  return h('div', { className: 'setting-row' },
    h('div', { className: 'setting-row-copy' }, h('strong', null, 'Quit Rel.AI MCP'), h('span', null, 'Stop the local connection and close Rel.AI completely.')),
    h('button', { className: 'secondary', type: 'button', disabled: busy, onClick: () => void quit() }, busy ? 'Quitting…' : 'Quit Rel.AI MCP')
  );
}

function AboutPage({ metadata, buildStatus = {}, runtime = {}, repositoryRuntime = {}, runtimeCompatibility = {} }) {
  const repositoryUrl = validatedGitHubUrl(metadata.repositoryUrl);
  const developer = metadata.developer || {};
  const developerUrl = validatedGitHubUrl(developer.profileUrl);
  const buildId = buildIdOf(buildStatus);
  const runtimeNotice = runtimeCompatibilityNotice(runtime, repositoryRuntime, runtimeCompatibility);
  const developerUnlockRef = useRef({ count: 0, startedAt: 0 });
  const onBuildClick = () => {
    if (readDeveloperOptionsUnlocked()) return;
    const next = advanceDeveloperUnlockClicks(developerUnlockRef.current);
    developerUnlockRef.current = next.unlocked ? { count: 0, startedAt: 0 } : next;
    if (!next.unlocked) return;
    unlockDeveloperOptions();
    toast('Developer options unlocked. Choose the features you want to enable in App settings.', { variant: 'success' });
  };
  const documentLink = (path, label) => {
    const href = repositoryDocumentUrl(repositoryUrl, path);
    return href
      ? h('a', { className: 'settings-external-link about-detail-value', href, target: '_blank', rel: 'noopener noreferrer' }, label)
      : h('span', { className: 'about-detail-value' }, label);
  };
  return h(React.Fragment, null,
    h(SettingsHeader, { title: 'About Rel.AI' }),
    h(Card, { title: 'Application information' },
      h('div', { className: 'about-product' }, h('div', null,
        h('h4', null, metadata.name || 'Rel.AI MCP'),
        h('p', null, 'Version: ', h('button', {
          className: 'about-build-trigger',
          type: 'button',
          onClick: onBuildClick,
          'aria-label': `Version ${metadata.version ? `v${metadata.version}` : 'unknown'}`
        }, metadata.version ? `v${metadata.version}` : 'Unknown')),
        buildId ? h('p', null, 'Build: ', h('code', null, buildId)) : null
      )),
      runtimeNotice ? h('div', { className: 'connection-notice warn about-runtime-mismatch', role: 'status' },
        h('strong', null, runtimeNotice.title),
        h('div', null, runtimeNotice.message)
      ) : null,
      developer.name ? h(AboutRow, { label: 'Developer' }, h('span', { className: 'about-detail-value' }, developerUrl ? h('a', { className: 'settings-external-link about-detail-value', href: developerUrl, target: '_blank', rel: 'noopener noreferrer', 'aria-label': developer.username ? `${developer.name} on GitHub (@${developer.username})` : `${developer.name} on GitHub` }, developer.name) : developer.name, developer.username ? ` (@${developer.username})` : '')) : null,
      h(AboutRow, { label: 'Source code' }, repositoryUrl ? h('a', { className: 'settings-external-link about-detail-value', href: repositoryUrl, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Rel.AI MCP source code on GitHub' }, repositoryLabel(repositoryUrl)) : h('span', { className: 'about-detail-value' }, metadata.repositoryUrl || ''))
    ),
    h(Card, { title: 'Legal & privacy' },
      h(AboutRow, { label: 'Privacy' }, documentLink('PRIVACY.md', 'Privacy Policy')),
      h(AboutRow, { label: 'Terms' }, documentLink('TERMS.md', 'Terms of Use')),
      h(AboutRow, { label: 'Security' }, documentLink('SECURITY.md', 'Security Policy')),
      h(AboutRow, { label: 'Licenses & notices' }, h('span', { className: 'about-detail-value' },
        documentLink('LICENSE', String(metadata.license || 'License')), ' · ',
        documentLink('THIRD_PARTY_NOTICES.md', 'Third-party'), ' · ',
        documentLink('NOTICE', 'NOTICE')
      ))
    )
  );
}

function AboutRow({ label, children }) {
  return h('div', { className: 'setting-row about-detail-row' }, h('div', { className: 'setting-row-copy' }, h('strong', null, label)), children);
}

function buildIdOf(buildStatus = {}) { return String(buildStatus?.buildId || '').trim(); }

function runtimeCompatibilityNotice(runtime = {}, repositoryRuntime = {}, compatibility = {}) {
  if (compatibility?.available !== true || compatibility?.metadataMatches !== false) return null;
  const runningVersion = String(runtime?.applicationVersion || runtime?.packageVersion || '').trim();
  const sourceVersion = String(repositoryRuntime?.applicationVersion || repositoryRuntime?.packageVersion || '').trim();
  if (!runningVersion || !sourceVersion) return null;
  const activeTasksPreventRestart = compatibility?.activeTasksPreventRestart === true;
  const restartRequired = compatibility?.restartRequired === true;
  if (runningVersion === sourceVersion && !restartRequired) return null;
  const title = restartRequired ? 'Restart required to load current source' : 'Running runtime differs from current source';
  const message = activeTasksPreventRestart
    ? `Rel.AI is running v${runningVersion} while this source tree is v${sourceVersion}. Finish active tasks before restarting Rel.AI to load the current source.`
    : restartRequired
      ? `Rel.AI is running v${runningVersion} while this source tree is v${sourceVersion}. Restart Rel.AI to load the current source and tools.`
      : `Rel.AI is running v${runningVersion} while this source tree is v${sourceVersion}. The running version is compatible, but its behavior may not match this source exactly.`;
  return { title, message, runningVersion, sourceVersion };
}

function advanceDeveloperUnlockClicks(state = {}, now = Date.now()) {
  const startedAt = Number(state.startedAt || 0);
  const withinWindow = startedAt > 0 && now - startedAt <= DEVELOPER_UNLOCK_WINDOW_MS;
  const count = withinWindow ? Number(state.count || 0) + 1 : 1;
  const nextStartedAt = withinWindow ? startedAt : now;
  return { count, startedAt: nextStartedAt, unlocked: count >= DEVELOPER_UNLOCK_CLICK_COUNT };
}

function validatedGitHubUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}
function repositoryLabel(value) { try { return new URL(value).pathname.replace(/^\/+|\/+$/g, ''); } catch { return String(value || ''); } }
function repositoryDocumentUrl(repositoryUrl, filePath) {
  if (!repositoryUrl) return '';
  try {
    const url = new URL(repositoryUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password) return '';
    const repositoryPath = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    if (!repositoryPath || repositoryPath.split('/').length !== 2) return '';
    const documentPath = String(filePath || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return documentPath ? `https://github.com/${repositoryPath}/blob/main/${documentPath}` : '';
  } catch { return ''; }
}
function formatBytes(value, { zero = false } = {}) { let bytes = Number(value || 0); if (!Number.isFinite(bytes) || bytes < 0) bytes = 0; if (bytes === 0) return zero ? '0 B' : ''; const units = ['B', 'KB', 'MB', 'GB', 'TB']; let unit = 0; while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit += 1; } return `${bytes >= 10 || unit === 0 ? bytes.toFixed(0) : bytes.toFixed(1)} ${units[unit]}`; }
function normalizeReleaseNoteText(value) { return String(value || '').replace(/<\s*br\s*\/?\s*>/gi, '\n').replace(/<\s*li(?:\s[^>]*)?>/gi, '\n• ').replace(/<\s*\/\s*li\s*>/gi, '\n').replace(/<\s*\/?\s*(?:h[1-6]|p|div|ul|ol|section|article)(?:\s[^>]*)?>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); }
function messageOf(error) { return error instanceof Error ? error.message : String(error || 'The action failed.'); }
function prefersReducedMotion() { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true; }

export { advanceDeveloperUnlockClicks, connectionGuideMode, connectionPrimaryAction, normalizeNotificationPreferences, normalizeReleaseNoteText, runtimeCompatibilityNotice, updateView };
