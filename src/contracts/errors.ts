export const ERROR_CODES = Object.freeze({
  UNKNOWN: 'unknown',
  REQUEST_INVALID: 'request_invalid',
  CONFIGURATION_INVALID: 'configuration_invalid',
  LOCAL_SERVICE_START_FAILED: 'local_service_start_failed',
  LOCAL_SERVICE_STOP_FAILED: 'local_service_stop_failed',
  LOCAL_PORT_IN_USE: 'local_port_in_use',
  SECURE_TUNNEL_FAILED: 'secure_tunnel_failed',
  TUNNEL_RUNTIME_UNAVAILABLE: 'tunnel_runtime_unavailable',
  TUNNEL_CREDENTIALS_UNAVAILABLE: 'tunnel_credentials_unavailable',
  TUNNEL_AUTHENTICATION_FAILED: 'tunnel_authentication_failed',
  TUNNEL_ACCESS_DENIED: 'tunnel_access_denied',
  TUNNEL_NOT_FOUND: 'tunnel_not_found',
  TUNNEL_CONNECTION_INTERRUPTED: 'tunnel_connection_interrupted',
  PUBLIC_ENDPOINT_FAILED: 'public_endpoint_failed',
  DASHBOARD_UNAVAILABLE: 'dashboard_unavailable',
  WORKSPACE_UNAVAILABLE: 'workspace_unavailable',
  SETTINGS_SAVE_FAILED: 'settings_save_failed',
  DIAGNOSTICS_UNAVAILABLE: 'diagnostics_unavailable',
  DIAGNOSTICS_EXPORT_FAILED: 'diagnostics_export_failed',
  STATE_RESET_FAILED: 'state_reset_failed',
  UPDATE_FAILED: 'update_failed',
  UPDATE_NOT_SUPPORTED: 'update_not_supported',
  UPDATE_BUSY: 'update_busy',
  UPDATE_INSTALL_BLOCKED: 'update_install_blocked',
  UPDATE_REQUIRED: 'update_required',
  STARTUP_SETTING_NOT_SUPPORTED: 'startup_setting_not_supported',
  STARTUP_SETTING_FAILED: 'startup_setting_failed',
  LIFECYCLE_STATE_FAILED: 'lifecycle_state_failed'
} as const);

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

export interface ErrorGuidance {
  title: string;
  recovery: string;
  actionLabel: string;
  href: string;
  retryable: boolean;
}

const ERROR_GUIDANCE: Readonly<Record<ErrorCode, ErrorGuidance>> = Object.freeze({
  [ERROR_CODES.UNKNOWN]: Object.freeze({ title: 'Something went wrong', recovery: 'Try the action again. Open Troubleshooting if the problem continues.', actionLabel: 'Troubleshoot', href: '#diagnostics', retryable: true }),
  [ERROR_CODES.REQUEST_INVALID]: Object.freeze({ title: 'Request could not be read', recovery: 'Check the submitted values and try again.', actionLabel: 'Review the form', href: '', retryable: true }),
  [ERROR_CODES.CONFIGURATION_INVALID]: Object.freeze({ title: 'Connection settings need attention', recovery: 'Open Connection settings, fix the highlighted value, and try again.', actionLabel: 'Open Connection settings', href: '#settings/connection', retryable: true }),
  [ERROR_CODES.LOCAL_SERVICE_START_FAILED]: Object.freeze({ title: 'Rel.AI could not start', recovery: 'Open Troubleshooting, review the error, fix the problem, and try again.', actionLabel: 'Troubleshoot', href: '#diagnostics', retryable: true }),
  [ERROR_CODES.LOCAL_SERVICE_STOP_FAILED]: Object.freeze({ title: 'Rel.AI could not stop', recovery: 'Try again. Restart the app if Rel.AI is still running.', actionLabel: 'Troubleshoot', href: '#diagnostics', retryable: true }),
  [ERROR_CODES.LOCAL_PORT_IN_USE]: Object.freeze({ title: 'Connection port is already in use', recovery: 'Choose another connection port or stop the process using the configured port.', actionLabel: 'Open Connection settings', href: '#settings/connection', retryable: true }),
  [ERROR_CODES.SECURE_TUNNEL_FAILED]: Object.freeze({ title: 'Secure MCP Tunnel could not start', recovery: 'Check the OpenAI Tunnel ID and runtime API key, then reconnect.', actionLabel: 'Open Connection', href: '#settings/connection', retryable: true }),
  [ERROR_CODES.TUNNEL_RUNTIME_UNAVAILABLE]: Object.freeze({ title: 'Something went wrong', recovery: 'Try the action again. Open Troubleshooting if the problem continues.', actionLabel: 'Troubleshoot', href: '#diagnostics', retryable: true }),
  [ERROR_CODES.TUNNEL_CREDENTIALS_UNAVAILABLE]: Object.freeze({ title: 'Tunnel runtime key is unavailable', recovery: 'Save the primary tunnel runtime API key again in Connection settings. Other configured tunnels can keep running.', actionLabel: 'Replace runtime key', href: '#settings/connection', retryable: false }),
  [ERROR_CODES.TUNNEL_AUTHENTICATION_FAILED]: Object.freeze({ title: 'Tunnel runtime key was rejected', recovery: 'Create or copy the correct OpenAI tunnel runtime API key, replace it in Connection, then reconnect.', actionLabel: 'Replace runtime key', href: '#settings/connection', retryable: true }),
  [ERROR_CODES.TUNNEL_ACCESS_DENIED]: Object.freeze({ title: 'Tunnel access was denied', recovery: 'Use a runtime key with Tunnels Read and Use access for this tunnel, then reconnect.', actionLabel: 'Open Connection', href: '#settings/connection', retryable: true }),
  [ERROR_CODES.TUNNEL_NOT_FOUND]: Object.freeze({ title: 'Secure MCP Tunnel was not found', recovery: 'Check that the Tunnel ID exists in the same OpenAI organization as the runtime key, then reconnect.', actionLabel: 'Open Connection', href: '#settings/connection', retryable: true }),
  [ERROR_CODES.TUNNEL_CONNECTION_INTERRUPTED]: Object.freeze({ title: 'Tunnel connection was interrupted', recovery: 'Rel.AI is retrying automatically. Check your network or OpenAI connectivity if the interruption continues.', actionLabel: 'Troubleshoot', href: '#diagnostics', retryable: true }),
  [ERROR_CODES.PUBLIC_ENDPOINT_FAILED]: Object.freeze({ title: 'Secure MCP Tunnel could not start', recovery: 'Check the OpenAI Secure MCP Tunnel settings, then reconnect.', actionLabel: 'Open Connection', href: '#settings/connection', retryable: true }),
  [ERROR_CODES.DASHBOARD_UNAVAILABLE]: Object.freeze({ title: 'Dashboard is unavailable', recovery: 'Try opening the dashboard again. Use the backup connection window only if it still does not load.', actionLabel: 'Retry dashboard', href: '#home', retryable: true }),
  [ERROR_CODES.WORKSPACE_UNAVAILABLE]: Object.freeze({ title: 'Project is unavailable', recovery: 'Fix the project folder or remove the project if you no longer use it.', actionLabel: 'Open Projects', href: '#workspaces', retryable: true }),
  [ERROR_CODES.SETTINGS_SAVE_FAILED]: Object.freeze({ title: 'Settings could not be saved', recovery: 'Review the changed values and retry. Existing saved settings were preserved.', actionLabel: 'Open Settings', href: '#settings', retryable: true }),
  [ERROR_CODES.DIAGNOSTICS_UNAVAILABLE]: Object.freeze({ title: 'Troubleshooting info is unavailable', recovery: 'Refresh the dashboard. Restart Rel.AI if the troubleshooting page still does not load.', actionLabel: 'Open Connection', href: '#settings/connection', retryable: true }),
  [ERROR_CODES.DIAGNOSTICS_EXPORT_FAILED]: Object.freeze({ title: 'Support report could not be copied', recovery: 'Try copying it again or review the report on this page.', actionLabel: 'Troubleshoot', href: '#diagnostics', retryable: true }),
  [ERROR_CODES.STATE_RESET_FAILED]: Object.freeze({ title: 'Saved troubleshooting data could not be cleared', recovery: 'Wait for active Rel.AI actions to finish, then try again.', actionLabel: 'Open Activity', href: '#activity', retryable: true }),
  [ERROR_CODES.UPDATE_FAILED]: Object.freeze({ title: 'Update failed', recovery: 'Keep the current version and retry the update later.', actionLabel: 'Troubleshoot', href: '#diagnostics', retryable: true }),
  [ERROR_CODES.UPDATE_NOT_SUPPORTED]: Object.freeze({ title: 'Automatic updates are unavailable', recovery: 'Use the installed Windows app or download the current version from GitHub Releases.', actionLabel: 'Open App settings', href: '#settings', retryable: false }),
  [ERROR_CODES.UPDATE_BUSY]: Object.freeze({ title: 'An update is already in progress', recovery: 'Wait for the current check, download, or installation to finish.', actionLabel: 'Open App settings', href: '#settings', retryable: true }),
  [ERROR_CODES.UPDATE_INSTALL_BLOCKED]: Object.freeze({ title: 'Update is ready to restart', recovery: 'Let active Rel.AI actions finish, then restart to install the update.', actionLabel: 'Open Tasks', href: '#tasks', retryable: true }),
  [ERROR_CODES.UPDATE_REQUIRED]: Object.freeze({ title: 'Update required', recovery: 'Install a supported Rel.AI version before starting more tasks.', actionLabel: 'Open App settings', href: '#settings', retryable: false }),
  [ERROR_CODES.STARTUP_SETTING_NOT_SUPPORTED]: Object.freeze({ title: 'Launch at sign-in is unavailable', recovery: 'Use the installed Windows app. Portable and browser versions cannot start automatically with Windows.', actionLabel: 'Open App settings', href: '#settings', retryable: false }),
  [ERROR_CODES.STARTUP_SETTING_FAILED]: Object.freeze({ title: 'Launch at sign-in could not be changed', recovery: 'Try again from App settings or check Windows startup-app permissions.', actionLabel: 'Open App settings', href: '#settings', retryable: true }),
  [ERROR_CODES.LIFECYCLE_STATE_FAILED]: Object.freeze({ title: 'App status could not be saved', recovery: 'Rel.AI can keep running, but some update or recovery history may be missing. Open Troubleshooting if this happens again.', actionLabel: 'Troubleshoot', href: '#diagnostics', retryable: true })
});

const knownErrorCodes = new Set<string>(Object.values(ERROR_CODES));

export function normalizeErrorCode(value: unknown): ErrorCode | '' {
  const code = String(value || '').trim();
  if (!code) return '';
  return knownErrorCodes.has(code) ? code as ErrorCode : ERROR_CODES.UNKNOWN;
}

export function errorGuidance(value: unknown): ErrorGuidance {
  const code = normalizeErrorCode(value) || ERROR_CODES.UNKNOWN;
  return ERROR_GUIDANCE[code];
}

export function errorPayload(code: unknown, message: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const errorCode = normalizeErrorCode(code) || ERROR_CODES.UNKNOWN;
  const guidance = errorGuidance(errorCode);
  return {
    ...extra,
    ok: false,
    errorCode,
    error: String(message || 'Unknown error'),
    title: guidance.title,
    recovery: {
      message: guidance.recovery,
      actionLabel: guidance.actionLabel,
      href: guidance.href,
      retryable: guidance.retryable
    }
  };
}
