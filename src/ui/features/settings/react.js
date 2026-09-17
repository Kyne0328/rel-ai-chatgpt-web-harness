import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { fetchJson, postJson, requestDashboardRefresh } from '../../api.js';
import { confirmAction } from '../../components/confirm-dialog.js';
import { Icon } from '../../components/icons.js';
import { openModal } from '../../components/modal.js';
import { toast } from '../../components/toast.js';
import { connectionLayerViews, connectionStateFor, connectionSummary, hasObservedMcpConnection } from '../../connection-state.js';
import { readDeveloperModeEnabled, readDeveloperOptionsUnlocked, unlockDeveloperOptions, writeDeveloperModeEnabled } from '../../developer-mode.js';
import { getUiPreferences, setThemePreference } from '../../preferences.js';
import { currentRoutePath } from '../../router.js';
import { chatGptFirstPrompt, chatGptGuideSteps, CHATGPT_CONNECTOR_CREATE_URL, RELAI_CONNECTOR_ICON_FILENAME, downloadRelaiConnectorIcon } from './connection-guidance.js';
import { restartConnection } from './connection-recovery.js';
import { supportPolicyView } from './desktop-update-policy.js';

const h = React.createElement;
const RELEASES_URL = 'https://github.com/Kyne0328/rel-ai-chatgpt-web-harness/releases';
const DEVELOPER_UNLOCK_CLICK_COUNT = 5;
const DEVELOPER_UNLOCK_WINDOW_MS = 2500;
const NOTIFICATION_DEFAULTS = Object.freeze({
  enabled: true,
  taskCompleted: true,
  errors: false,
  connectionStatus: true,
  applicationUpdates: true,
  ignoredUpdateVersion: ''
});
const NOTIFICATION_CATEGORIES = Object.freeze([
  ['taskCompleted', 'Task completed', 'Show a desktop alert after Rel.AI completes a task.'],
  ['errors', 'Errors', 'Show alerts when a project action, connection, or app update fails.'],
  ['connectionStatus', 'Connection status', 'Show alerts when ChatGPT connects, disconnects, or needs you to reconnect it.'],
  ['applicationUpdates', 'App updates', 'Show desktop alerts when an app update is available.']
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
    application: h(ApplicationPage, { computerControl: data.config?.computerControl }),
    about: h(AboutPage, { metadata: data.application || {}, buildStatus: data.desktopStatus?.buildStatus })
  }[page] || h(PreferencesPage);
  return h('div', { id: '__settings-content', className: 'settings-content', 'data-settings-react': page }, content);
}

function SettingsHeader({ title, description }) {
  return h('div', { className: 'settings-header' },
    h('h2', null, title),
    description ? h('p', null, description) : null
  );
}

function Card({ title, className = '', children }) {
  return h('section', { className: ['card', className].filter(Boolean).join(' ') },
    h('div', { className: 'card-head' }, h('h3', null, title)),
    h('div', { className: 'card-body settings-panel-body' }, children)
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

function StatusPill({ label, tone = '' }) {
  return h('span', { className: `status-pill ${tone}`.trim() }, label);
}

function ConnectionPage({ data }) {
  const controlsRef = useRef(null);
  const state = connectionStateFor(data);
  const summary = connectionSummary(state);
  const action = connectionPrimaryAction(state);
  const guideMode = connectionGuideMode(state);
  const tunnelId = String(data.desktopStatus?.tunnelId || data.connection?.tunnelId || '');
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
  const refreshStatus = async () => {
    try {
      const status = await window.relaiDesktop?.getStatus?.();
      if (status) window.dispatchEvent(new CustomEvent('relai:desktop-status-refresh', { detail: status }));
    } catch {}
    window.dispatchEvent(new CustomEvent('relai:dashboard-refresh'));
    toast('Refreshing connection status…', { variant: 'info' });
  };

  return h('div', { className: 'section connection-page', 'data-connection-react': '' },
    h('section', { className: `card connection-summary-card ${summary.tone}` },
      h('div', { className: 'card-head' }, h('h3', null, 'ChatGPT connection'), h(StatusPill, { label: summary.label, tone: summary.tone })),
      h('div', { className: 'card-body connection-status-body' },
        h('div', { className: 'connection-status-copy' }, h('h2', null, summary.title), h('p', null, summary.message)),
        action.kind !== 'none' ? h('div', { className: 'connection-primary-action' }, connectionActionElement(action, { openSetup, openSettings, retry })) : null
      )
    ),
    h('div', { className: 'connection-support-row' },
      h('button', { className: 'secondary compact-button', type: 'button', onClick: () => void refreshStatus() }, 'Refresh status'),
      ['restart', 'settings'].includes(action.kind) ? h('button', { className: 'secondary compact-button', type: 'button', onClick: () => openSettings({ focus: true }) }, 'Review settings') : null,
      action.href === '#diagnostics' || action.kind === 'none' ? null : h('a', { className: 'buttonlike secondary compact-button', href: '#diagnostics' }, 'Troubleshooting')
    ),
    h(ConnectionLayers, { state, summary }),
    guideMode ? h(ConnectionGuide, { mode: guideMode, tunnelId, workspaceAlias }) : null,
    h('section', { id: 'connectionControls', className: 'connection-controls-section', ref: controlsRef },
      h(DesktopConnectionSettings, { expanded: String(state.publicEndpoint?.status || '') === 'disabled' })
    )
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
  if (summary.tone === 'working') return { kind: 'none' };
  if (summary.tone === 'bad' || summary.tone === 'warn') return { kind: 'route', href: '#diagnostics', label: 'Troubleshoot' };
  return { kind: 'route', href: '#tasks', label: 'Tasks' };
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
    h('summary', { className: 'connector-details-summary' },
      h('span', null, h('strong', null, 'Connection check'), h('small', null, 'This computer, Secure MCP Tunnel, and ChatGPT'))
    ),
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
  const [iconSaved, setIconSaved] = useState(false);
  const steps = chatGptGuideSteps({ mode, tunnelId });
  const title = mode === 'reconnect' ? 'Reconnect ChatGPT' : 'Connect ChatGPT';
  const saveIcon = () => {
    downloadRelaiConnectorIcon();
    setIconSaved(true);
  };
  return h('div', { className: 'connection-guide-region' },
    h('section', { className: 'card connection-guide-card' },
      h('div', { className: 'card-head' }, h('h3', null, title), h('span', { className: 'section-action' }, 'Connection setup')),
      h('div', { className: 'card-body' },
        h('div', { className: 'chatgpt-setup-guide compact' },
          h('div', { className: 'chatgpt-guide-heading' },
            h('strong', null, mode === 'reconnect' ? 'Reconnect ChatGPT' : 'Finish ChatGPT setup'),
            h('span', null, 'Use Tunnel + No authentication. Rel.AI keeps the local connection private.')
          ),
          mode === 'create' ? h('section', { className: 'chatgpt-connector-handoff', 'aria-label': 'ChatGPT connector setup' },
            h('dl', { className: 'chatgpt-connector-values' },
              h('dt', null, 'Name'), h('dd', null, 'Rel.AI MCP'),
              h('dt', null, 'Connection'), h('dd', null, 'Tunnel'),
              h('dt', null, 'Tunnel'), h('dd', { className: 'mono' }, tunnelId || 'Select this computer’s tunnel'),
              h('dt', null, 'Authentication'), h('dd', null, 'No authentication')
            ),
            h('div', { className: 'chatgpt-connector-actions', role: 'group', 'aria-label': 'ChatGPT connector setup actions' },
              h('button', { className: 'primary', type: 'button', onClick: () => window.open(CHATGPT_CONNECTOR_CREATE_URL, '_blank', 'noopener,noreferrer') }, 'ChatGPT setup'),
              h('button', { className: 'secondary', type: 'button', onClick: saveIcon }, iconSaved ? `Optional icon saved · ${RELAI_CONNECTOR_ICON_FILENAME}` : h(React.Fragment, null, 'Save optional Rel.AI icon ', h('span', null, 'PNG · under 10 KB')))
            ),
            h('p', { className: 'chatgpt-connector-note' }, iconSaved ? 'The icon is optional. Open ChatGPT setup when you are ready.' : 'Open ChatGPT now. You can add the Rel.AI icon after the connector works.')
          ) : null,
          h('ol', null, steps.map((step, index) => h('li', { key: index }, step))),
          h('div', { className: 'chatgpt-first-prompt' }, h('span', null, 'First test request'), h('code', null, chatGptFirstPrompt(workspaceAlias)))
        )
      )
    )
  );
}

function DesktopConnectionSettings({ expanded = false }) {
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState('');
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
        tunnelError: String(settings.tunnelError || '')
      };
      setForm(next);
      setSaved(connectionSnapshot(next));
      if (tunnelCredentialError(next)) setOpen(true);
    }).catch(error => {
      if (active) setForm({ loadError: messageOf(error) });
    });
    return () => { active = false; };
  }, [desktop]);

  useEffect(() => {
    const handler = event => {
      setOpen(true);
      if (event.detail?.focus) window.requestAnimationFrame(() => firstInputRef.current?.focus({ preventScroll: true }));
    };
    window.addEventListener('relai:connection-open-settings', handler);
    return () => window.removeEventListener('relai:connection-open-settings', handler);
  }, []);

  if (!desktop?.getSettings || !desktop?.saveSettings) return h('div', { className: 'empty' }, 'Connection settings are available inside the installed Rel.AI desktop app.');
  if (!form) return h('div', { className: 'settings-loading', role: 'status' }, 'Loading connection settings…');
  if (form.loadError) return h('div', { className: 'empty' }, `Connection settings could not be loaded: ${form.loadError}`);

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
      h(AccountWorkspaceSwitch),
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

function AccountWorkspaceSwitch() {
  return h('details', { className: 'settings-advanced connection-account-switch' },
    h('summary', null, 'Use a different OpenAI account or workspace'),
    h('div', { className: 'settings-panel-body connection-account-switch-body' },
      h('ol', null,
        h('li', null, 'Sign in to the OpenAI account that you want to use.'),
        h('li', null, 'Select or create a Secure MCP Tunnel in that organization.'),
        h('li', null, 'Create a runtime API key for that tunnel.'),
        h('li', null, 'Replace the Tunnel ID and runtime API key above. Then save the connection settings.'),
        h('li', null, 'In ChatGPT, update the existing Rel.AI connector if it is available in that workspace. Create one connector only if the workspace does not have it.')
      ),
      h('div', { className: 'connection-account-switch-actions' },
        h('a', { className: 'buttonlike secondary compact-button', href: 'https://platform.openai.com/settings/organization/tunnels', target: '_blank', rel: 'noopener noreferrer' }, 'OpenAI Tunnels'),
        h('a', { className: 'buttonlike secondary compact-button', href: 'https://platform.openai.com/settings/organization/api-keys', target: '_blank', rel: 'noopener noreferrer' }, 'OpenAI API Keys')
      )
    )
  );
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
    h(SettingsHeader, { title: 'Preferences', description: 'Change appearance and desktop notifications.' }),
    h(Card, { title: 'Appearance' },
      h('div', { className: 'settings-field' },
        h('span', null, 'Theme'),
        h(ThemeSwitch, { theme, onChange: value => { setTheme(value); setThemePreference(value); } }),
        h('p', { className: 'settings-help' }, 'Theme applies to the dashboard and Rel.AI Pulse. Setup and recovery windows follow your system appearance.')
      )
    ),
    h(DesktopNotificationsSettings)
  );
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
      help: 'Turn all desktop notifications on or off. Your choices below are kept while notifications are off.',
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
      h('p', { className: 'settings-help' }, 'Notifications for only this exact version are muted. Newer versions can still notify you.')
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

function ApplicationPage({ computerControl }) {
  const [lifecycle, setLifecycle] = useState(undefined);
  const [desktopStatus, setDesktopStatus] = useState(undefined);
  const developerOptionsUnlocked = readDeveloperOptionsUnlocked();
  const [developerModeEnabled, setDeveloperModeState] = useState(() => readDeveloperModeEnabled());
  const desktop = window.relaiDesktop;
  useEffect(() => {
    let active = true;
    if (typeof desktop?.getLifecycleStatus !== 'function') setLifecycle(null);
    else void desktop.getLifecycleStatus().then(status => { if (active) setLifecycle(status); }).catch(() => { if (active) setLifecycle(null); });
    if (typeof desktop?.getStatus !== 'function') setDesktopStatus(null);
    else void desktop.getStatus().then(status => { if (active) setDesktopStatus(status); }).catch(() => { if (active) setDesktopStatus(null); });
    return () => { active = false; };
  }, [desktop]);
  return h(React.Fragment, null,
    h(SettingsHeader, { title: 'App', description: 'Startup, background behavior, updates, and local storage.' }),
    lifecycle === undefined ? h('div', { className: 'settings-loading', role: 'status' }, 'Loading app settings…') : h(React.Fragment, null,
      h(StartupSettings, { initial: lifecycle }),
      h(ComputerControlSettings, { initial: computerControl }),
      h(ApplicationUpdates, { lifecycle, buildStatus: desktopStatus?.buildStatus }),
      h(LocalDataSettings),
      developerOptionsUnlocked ? h(DeveloperOptions, {
        enabled: developerModeEnabled,
        onChange: enabled => setDeveloperModeState(writeDeveloperModeEnabled(enabled))
      }) : null,
      typeof desktop?.quitApp === 'function' || typeof desktop?.logout === 'function'
        ? h(Card, { title: 'Application controls' },
            typeof desktop?.logout === 'function' ? h(LogoutRow) : null,
            typeof desktop?.quitApp === 'function' ? h(QuitRow) : null
          )
        : null
    )
  );
}

function DeveloperOptions({ enabled, onChange }) {
  return h('details', { className: 'settings-advanced developer-options' },
    h('summary', null, 'Developer options'),
    h('div', { className: 'settings-panel-body' },
      h('p', { className: 'settings-help' }, 'Experimental developer features are kept here until they are ready for normal use.'),
      h(ToggleRow, {
        label: 'Developer mode',
        help: 'Show developer-only features such as Extensions in the main menu.',
        checked: enabled,
        onChange
      })
    )
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
      help: launch.supported ? 'Starts Rel.AI in the background after you sign in so it is ready when you need it.' : launch.reason || 'This build cannot register itself for sign-in.',
      onChange: value => void update('launchAtLogin', value)
    }),
    h(ToggleRow, {
      label: 'Keep Rel.AI running when I close the window', checked: state.keepRunningOnClose !== false, disabled: busy === 'keepRunningOnClose', busy: busy === 'keepRunningOnClose',
      enabledLabel: 'Keep running on close', disabledLabel: 'Quit on close',
      help: 'Keeps the local ChatGPT connection available in the system tray. Turn this off if closing the dashboard should quit Rel.AI completely.',
      onChange: value => void update('keepRunningOnClose', value)
    }),
    h(ToggleRow, {
      label: 'Show Rel.AI Pulse', checked: state.pulseEnabled !== false, disabled: busy === 'pulseEnabled', busy: busy === 'pulseEnabled',
      enabledLabel: 'Pulse on', disabledLabel: 'Pulse off',
      help: 'Shows a small local status card while Rel.AI is running. It highlights local work and action-required states; approvals still happen in ChatGPT.',
      onChange: value => void update('pulseEnabled', value)
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
      help: 'Skips optional repository pre-warming to reduce idle CPU and memory use. Repository analysis still runs normally when a task needs it.',
      onChange: value => void update('reducedBackgroundWork', value)
    }),
    state.updated ? h(LifecycleNotice, { tone: 'ok', title: 'Update completed', text: `Rel.AI started successfully after updating from v${state.previousVersion || 'an earlier version'} to v${state.currentVersion || 'the current version'}.` }) : null,
    state.recoveredAfterUncleanShutdown ? h(LifecycleNotice, { tone: 'warn', title: 'Rel.AI recovered after closing unexpectedly', text: 'Rel.AI did not close normally last time, but your settings were kept and the app started normally. Open Troubleshooting only if this keeps happening.' }) : null
  );
}

function LifecycleNotice({ tone, title, text }) {
  return h('div', { className: `connection-notice ${tone} desktop-lifecycle-notice` }, h('strong', null, title), h('p', null, text));
}

function ComputerControlSettings({ initial = {} }) {
  const [enabled, setEnabled] = useState(initial?.enabled === true);
  const [busy, setBusy] = useState(false);
  useEffect(() => setEnabled(initial?.enabled === true), [initial?.enabled]);
  const help = 'Allow ChatGPT connected through Rel.AI to perform local desktop actions when a task needs them. Rel.AI uses direct file and app actions where possible and full pointer or keyboard control only when necessary. Operating-system permissions and privilege boundaries still apply.';
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

function ApplicationUpdates({ lifecycle, buildStatus }) {
  const bridge = window.relaiDesktop;
  const supported = Boolean(bridge?.getUpdateStatus && bridge?.checkForUpdates && bridge?.downloadUpdate && bridge?.installUpdate);
  const [status, setStatus] = useState(null);
  const [releaseNotes, setReleaseNotes] = useState(null);
  const [autoDownload, setAutoDownload] = useState(lifecycle?.autoDownloadUpdates === true);
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
  const run = async action => {
    const method = { check: 'checkForUpdates', download: 'downloadUpdate', install: 'installUpdate' }[action];
    if (!method) return;
    setBusy(action);
    try {
      const result = await bridge[method]();
      if (result?.status) setStatus(result.status);
      if (result?.ok === false) toast(result.error || 'The update action failed.', { variant: 'error' });
    } catch (error) {
      const message = messageOf(error);
      setStatus(current => ({ ...(current || {}), state: 'error', error: message, errorCode: 'update_failed' }));
      toast(message, { variant: 'error' });
    } finally { setBusy(''); }
  };
  const current = status || { state: 'idle' };
  const buildId = buildIdOf(buildStatus);
  const view = updateView(current, autoDownload);
  return h(Card, { title: 'App updates', className: 'application-update-panel' },
    h(ToggleRow, {
      label: 'Download verified updates automatically', checked: autoDownload, disabled: busy === 'auto', busy: busy === 'auto',
      enabledLabel: 'Automatic downloads on', disabledLabel: 'Ask before downloading',
      help: 'Downloads a verified update in the background when one is found. Rel.AI still asks before installing it or opening the macOS installer.',
      onChange: value => void updateAuto(value)
    }),
    h('div', { className: 'application-update-status', 'data-auto-download-updates': String(autoDownload) },
      h('div', { className: 'application-update-summary' },
        h('div', null,
          h('span', { className: 'application-update-label' }, 'Installed version'),
          h('strong', null, current.currentVersion ? `v${current.currentVersion}` : 'Unknown version'),
          buildId ? h('span', { className: 'application-update-label' }, 'Build') : null,
          buildId ? h('span', { className: 'application-update-build' }, buildId) : null
        ),
        h(StatusPill, { label: view.label, tone: view.tone })
      ),
      h('p', { className: 'muted application-update-copy' }, view.description),
      h(UpdateSupportPolicy, { policy: current.supportPolicy }),
      h(UpdateReleaseNotes, { status: current, releaseNotes }),
      current.state === 'downloading' ? h(UpdateProgress, { progress: current.progress }) : null,
      current.errorCode ? h('code', { className: 'application-update-code' }, `Error code: ${current.errorCode}`) : null,
      h('div', { className: 'connection-actions application-update-actions' },
        view.action ? h('button', { className: view.action.className, type: 'button', disabled: Boolean(busy), onClick: () => void run(view.action.id) }, busy === view.action.id ? `${view.action.label}…` : view.action.label) : null,
        view.secondary ? h('button', { className: 'secondary', type: 'button', disabled: Boolean(busy), onClick: () => void run(view.secondary.id) }, view.secondary.label) : null,
        h('a', { className: 'buttonlike secondary', href: RELEASES_URL, target: '_blank', rel: 'noreferrer' }, 'GitHub Releases'),
        current.state === 'error' ? h('a', { className: 'buttonlike secondary', href: '#diagnostics' }, 'Troubleshoot') : null
      )
    )
  );
}

function buildIdOf(buildStatus = {}) {
  return String(buildStatus?.buildId || '').trim();
}

function updateView(status = {}, autoDownload = false) {
  const state = String(status.state || 'idle');
  const currentVersion = status.currentVersion ? `v${status.currentVersion}` : 'Unknown version';
  const availableVersion = status.availableVersion ? `v${status.availableVersion}` : '';
  if (state === 'unsupported') return { label: 'Manual update', tone: 'warn', description: status.supportReason || 'This build must be updated manually from GitHub Releases.' };
  if (state === 'checking') return { label: 'Checking', tone: 'working', description: 'Checking for a newer version of Rel.AI.' };
  if (state === 'up_to_date') return { label: 'Up to date', tone: 'ok', description: `${currentVersion} is the latest available version. Rel.AI checks again once per day.`, action: { id: 'check', label: 'Check again', className: 'secondary' } };
  if (state === 'available') return { label: 'Update available', tone: 'warn', description: autoDownload ? `${availableVersion || 'A newer version'} is available. Rel.AI will download it automatically without restarting.` : `${availableVersion || 'A newer version'} is available. Downloading does not restart Rel.AI.`, action: { id: 'download', label: `Download ${availableVersion || 'update'}`, className: 'primary' }, secondary: { id: 'check', label: 'Check again' } };
  if (state === 'downloading') return { label: 'Downloading', tone: 'working', description: `Downloading ${availableVersion || 'the update'}. You can keep using Rel.AI while it downloads.` };
  if (state === 'downloaded') { const opensDmg = status.installMode === 'open_dmg'; return { label: 'Ready to install', tone: status.error ? 'warn' : 'ok', description: opensDmg ? `${availableVersion || 'The update'} is verified and downloaded. Open the DMG, then replace Rel.AI MCP in Applications.` : (status.error || `${availableVersion || 'The update'} is ready. Rel.AI stays open while it prepares the update, then restarts automatically for the final swap.`), action: { id: 'install', label: opensDmg ? 'DMG' : 'Install update', className: 'primary' } }; }
  if (state === 'installing') return { label: 'Installing', tone: 'working', description: 'Rel.AI is temporarily paused while it prepares the update. It will restart automatically when the final swap is ready.' };
  if (state === 'error') return { label: 'Update failed', tone: 'bad', description: status.error || 'The update could not be completed. The installed version is still available.', action: { id: 'check', label: 'Try again', className: 'primary' } };
  return { label: 'Updates enabled', tone: 'ok', description: autoDownload ? (status.installMode === 'open_dmg' ? 'Rel.AI watches for newly published releases and downloads verified updates automatically. It still asks before opening the macOS installer.' : 'Rel.AI watches for newly published releases and downloads verified updates automatically. It still asks before restarting to install.') : (status.installMode === 'open_dmg' ? 'Rel.AI watches for newly published releases while it is running and fully verifies updates at least once per day. Rel.AI asks before it downloads an update or opens the macOS installer.' : 'Rel.AI watches for newly published releases while it is running and fully verifies updates at least once per day. Rel.AI asks before it downloads an update or restarts.'), action: { id: 'check', label: 'Check for updates', className: 'secondary' } };
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
      detail: 'This removes aggregate action, reliability, timing, project, and failure-category history. Project files, task history, memory, settings, and external telemetry configuration are not changed.',
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
      h('small', null, 'Includes Rel.AI state, desktop app data, connection state, logs, indexes, and caches. Use Log out → Clear all local data to erase everything Rel.AI stores locally.')
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
    h('div', { className: 'setting-row-copy' }, h('strong', null, 'Log out'), h('span', null, 'Disconnect the saved OpenAI tunnel from this Rel.AI installation. You can choose whether to keep local Rel.AI data when you log out.')),
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

function AboutPage({ metadata, buildStatus = {} }) {
  const repositoryUrl = validatedGitHubUrl(metadata.repositoryUrl);
  const developer = metadata.developer || {};
  const developerUrl = validatedGitHubUrl(developer.profileUrl);
  const buildId = buildIdOf(buildStatus);
  const developerUnlockRef = useRef({ count: 0, startedAt: 0 });
  const onBuildClick = () => {
    if (readDeveloperOptionsUnlocked()) return;
    const next = advanceDeveloperUnlockClicks(developerUnlockRef.current);
    developerUnlockRef.current = next.unlocked ? { count: 0, startedAt: 0 } : next;
    if (!next.unlocked) return;
    unlockDeveloperOptions();
    toast('Developer options unlocked. Turn on Developer mode in App settings.', { variant: 'success' });
  };
  const documentLink = (path, label) => {
    const href = repositoryDocumentUrl(repositoryUrl, path);
    return href
      ? h('a', { className: 'settings-external-link about-detail-value', href, target: '_blank', rel: 'noopener noreferrer' }, label)
      : h('span', { className: 'about-detail-value' }, label);
  };
  return h(React.Fragment, null,
    h(SettingsHeader, { title: 'About Rel.AI', description: 'Rel.AI keeps your projects local and shares bounded tool results through your configured ChatGPT connection when a task needs them.' }),
    h(Card, { title: 'Application information' },
      h('div', { className: 'about-product' }, h('img', { src: '/public/assets/relai-logo.png', width: 193, height: 187, alt: '', 'aria-hidden': 'true' }), h('div', null,
        h('h4', null, metadata.name || 'Rel.AI MCP'),
        h('p', null, `Version: ${metadata.version ? `v${metadata.version}` : 'Unknown version'}`),
        buildId ? h('p', null, 'Build: ', h('button', {
          className: 'about-build-trigger',
          type: 'button',
          onClick: onBuildClick,
          'aria-label': `Build ${buildId}`
        }, buildId)) : null
      )),
      h(AboutRow, { label: 'Developer' }, h('span', { className: 'about-detail-value' }, 'Developed by ', developerUrl ? h('a', { className: 'settings-external-link about-detail-value', href: developerUrl, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `${developer.name} on GitHub (@${developer.username})` }, developer.name) : developer.name, developer.username ? ` (@${developer.username})` : '')),
      h(AboutRow, { label: 'Source code' }, repositoryUrl ? h('a', { className: 'settings-external-link about-detail-value', href: repositoryUrl, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Rel.AI MCP source code on GitHub' }, repositoryLabel(repositoryUrl)) : h('span', { className: 'about-detail-value' }, metadata.repositoryUrl || '')),
      h(AboutRow, { label: 'License' }, documentLink('LICENSE', String(metadata.license || 'Apache-2.0')))
    ),
    h(Card, { title: 'Legal & privacy' },
      h('p', { className: 'settings-help' }, 'These documents describe Rel.AI data handling, use of official project services, security reporting, and third-party software notices.'),
      h(AboutRow, { label: 'Privacy' }, documentLink('PRIVACY.md', 'Privacy Policy')),
      h(AboutRow, { label: 'Terms' }, documentLink('TERMS.md', 'Terms of Use')),
      h(AboutRow, { label: 'Security' }, documentLink('SECURITY.md', 'Security Policy')),
      h(AboutRow, { label: 'Third-party software' }, documentLink('THIRD_PARTY_NOTICES.md', 'Third-party notices')),
      h(AboutRow, { label: 'Attribution' }, documentLink('NOTICE', 'NOTICE'))
    )
  );
}

function AboutRow({ label, children }) {
  return h('div', { className: 'setting-row about-detail-row' }, h('div', { className: 'setting-row-copy' }, h('strong', null, label)), children);
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
function messageOf(error) { return error instanceof Error ? error.message : String(error || 'The operation failed.'); }
function prefersReducedMotion() { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true; }

export { advanceDeveloperUnlockClicks, connectionGuideMode, connectionPrimaryAction, normalizeNotificationPreferences, normalizeReleaseNoteText, updateView };
