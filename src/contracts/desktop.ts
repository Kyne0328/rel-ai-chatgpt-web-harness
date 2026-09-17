import type { TaskActivityDto } from './tasks.ts';
import type { ConnectionStateDto } from './connection.ts';
import type { DiagnosticReportDto } from './diagnostics.ts';

export type DesktopSurface = 'wizard' | 'fallback' | 'dashboard' | 'pulse';
export type DesktopIpcInputMode = 'handle' | 'on';

export interface DesktopStatusDto {
  serverRunning?: boolean;
  starting?: boolean;
  tunnelStatus?: string;
  tunnelId?: string;
  tunnelHealthUrl?: string;
  mcpUrl?: string;
  localMcpUrl?: string;
  localUrl?: string;
  error?: string;
  errorCode?: string;
  version?: string;
  taskActivity?: TaskActivityDto;
  connectionState?: ConnectionStateDto;
  [key: string]: unknown;
}

export interface DesktopWindowStateDto { maximized?: boolean; minimized?: boolean; [key: string]: unknown }
export interface DesktopBrowserTabDto {
  nativePageId: string;
  active: boolean;
  url: string;
  title: string;
  loading: boolean;
  createdAt: string;
}
export interface DesktopBrowserSessionDto {
  nativeSessionId: string;
  active: boolean;
  control: 'ai' | 'user';
  pageCount: number;
  url: string;
  title: string;
  createdAt: string;
}
export interface DesktopBrowserStateDto {
  ok?: boolean;
  available?: boolean;
  active?: boolean;
  activeSessionCount?: number;
  sessions?: readonly DesktopBrowserSessionDto[];
  control?: 'ai' | 'user';
  nativeSessionId?: string;
  nativePageId?: string;
  pageCount?: number;
  tabs?: readonly DesktopBrowserTabDto[];
  url?: string;
  title?: string;
  loading?: boolean;
  visible?: boolean;
  [key: string]: unknown;
}
export interface DesktopBrowserSurfaceBoundsDto { visible: boolean; x?: number; y?: number; width?: number; height?: number }
export interface DesktopIpcInputSpec { mode: DesktopIpcInputMode; windows: readonly DesktopSurface[]; failure: 'reject' | 'ignore' }

export interface DesktopIpcRequestMap {
  'wizard:done': [config: Record<string, unknown>];
  'wizard:cancel': [];
  'wizard:open-openai-setup': [destination: string];
  'recovery:get-config': [];
  'recovery:open-setup': [];
  'url:open-dashboard': [routeHash?: string];
  'notifications:get-enabled': [];
  'notifications:set-enabled': [enabled: boolean];
  'server:start': [];
  'server:stop': [];
  'recovery:restart-connection': [];
  'recovery:relaunch': [];
  'desktop:restart-connection': [];
  'desktop:relaunch': [];
  'desktop:logout': [payload: { clearData: boolean }];
  'desktop:quit': [];
  'desktop:get-status': [];
  'desktop:window:get-state': [];
  'desktop:window:minimize': [];
  'desktop:window:toggle-maximize': [];
  'desktop:window:close': [];
  'desktop:browser:get-state': [];
  'desktop:browser:set-bounds': [bounds: DesktopBrowserSurfaceBoundsDto];
  'desktop:browser:set-control': [owner: 'ai' | 'user'];
  'desktop:browser:select-session': [nativeSessionId: string];
  'desktop:browser:select-tab': [nativePageId: string];
  'desktop:browser:close-tab': [nativePageId: string];
  'desktop:browser:stop': [];
  'desktop:open-settings': [];
  'desktop:reload-dashboard': [routeHash?: string];
  'desktop:analytics:local': [month?: string];
  'desktop:settings:get': [];
  'desktop:settings:save': [settings: Record<string, unknown>];
  'desktop:lifecycle:get': [];
  'desktop:lifecycle:acknowledge-connector-refresh': [];
  'desktop:startup:set': [enabled: boolean];
  'desktop:keep-awake:set': [enabled: boolean];
  'desktop:app-preferences:set': [patch: Record<string, unknown>];
  'desktop:notifications:get': [];
  'desktop:notifications:set': [enabled: boolean];
  'desktop:notification-preferences:get': [];
  'desktop:notification-preferences:set': [patch: Record<string, unknown>];
  'desktop:update:get': [];
  'desktop:update:check': [];
  'desktop:update:download': [];
  'desktop:update:install': [];
  'desktop:diagnostics:export': [report: DiagnosticReportDto];
  'desktop:diagnostics:open-folder': [];
  'desktop:diagnostics:tunnel-doctor': [];
  'desktop:local-data:get': [];
  'desktop:local-data:clear-temporary': [];
  'desktop:local-data:open-folder': [];
  'desktop:code:get': [payload: { taskId: string }];
  'desktop:code:diff': [payload: { taskId: string; path: string }];
  'desktop:code:editors': [];
  'desktop:code:open-ide': [payload: { taskId: string; editorId: string }];
  'url:copy': [text: string];
  'desktop:stop-service': [];
  'window:fit-content': [size: { width: number; height: number }];
}

export type DesktopIpcRequestChannel = keyof DesktopIpcRequestMap;
export type DesktopIpcInputContract = Readonly<Record<DesktopIpcRequestChannel, DesktopIpcInputSpec>>;

export interface DesktopIpcResponseMap {
  'desktop:get-status': DesktopStatusDto;
  'desktop:window:get-state': DesktopWindowStateDto;
  'desktop:window:toggle-maximize': DesktopWindowStateDto;
  'desktop:window:minimize': Record<string, unknown>;
  'desktop:window:close': Record<string, unknown>;
  'desktop:browser:get-state': DesktopBrowserStateDto;
  'desktop:browser:set-bounds': DesktopBrowserStateDto;
  'desktop:browser:set-control': DesktopBrowserStateDto;
  'desktop:browser:select-session': DesktopBrowserStateDto;
  'desktop:browser:select-tab': DesktopBrowserStateDto;
  'desktop:browser:close-tab': DesktopBrowserStateDto;
  'desktop:browser:stop': Record<string, unknown>;
  'desktop:settings:get': Record<string, unknown>;
  'desktop:settings:save': Record<string, unknown>;
  'desktop:lifecycle:get': Record<string, unknown>;
  'desktop:lifecycle:acknowledge-connector-refresh': Record<string, unknown>;
  'desktop:analytics:local': Record<string, unknown>;
  'desktop:diagnostics:export': Record<string, unknown>;
  'desktop:diagnostics:tunnel-doctor': Record<string, unknown>;
  [channel: string]: unknown;
}

export interface DesktopIpcEventMap {
  'server:status': DesktopStatusDto;
  'server:log': Record<string, unknown> | string;
  'desktop:window-state': DesktopWindowStateDto;
  'desktop:browser-state': DesktopBrowserStateDto;
  'desktop:update-status': Record<string, unknown>;
  'pulse:update': Record<string, unknown>;
}

export const DESKTOP_IPC = Object.freeze({
  WIZARD_DONE: 'wizard:done',
  WIZARD_CANCEL: 'wizard:cancel',
  WIZARD_OPEN_OPENAI_SETUP: 'wizard:open-openai-setup',
  RECOVERY_GET_CONFIG: 'recovery:get-config',
  RECOVERY_OPEN_SETUP: 'recovery:open-setup',
  URL_OPEN_DASHBOARD: 'url:open-dashboard',
  NOTIFICATIONS_GET_ENABLED: 'notifications:get-enabled',
  NOTIFICATIONS_SET_ENABLED: 'notifications:set-enabled',
  SERVER_START: 'server:start',
  SERVER_STOP: 'server:stop',
  RECOVERY_RESTART_CONNECTION: 'recovery:restart-connection',
  RECOVERY_RELAUNCH: 'recovery:relaunch',
  DESKTOP_RESTART_CONNECTION: 'desktop:restart-connection',
  DESKTOP_RELAUNCH: 'desktop:relaunch',
  DESKTOP_LOGOUT: 'desktop:logout',
  DESKTOP_QUIT: 'desktop:quit',
  DESKTOP_GET_STATUS: 'desktop:get-status',
  DESKTOP_WINDOW_GET_STATE: 'desktop:window:get-state',
  DESKTOP_WINDOW_MINIMIZE: 'desktop:window:minimize',
  DESKTOP_WINDOW_TOGGLE_MAXIMIZE: 'desktop:window:toggle-maximize',
  DESKTOP_WINDOW_CLOSE: 'desktop:window:close',
  DESKTOP_BROWSER_GET_STATE: 'desktop:browser:get-state',
  DESKTOP_BROWSER_SET_BOUNDS: 'desktop:browser:set-bounds',
  DESKTOP_BROWSER_SET_CONTROL: 'desktop:browser:set-control',
  DESKTOP_BROWSER_SELECT_SESSION: 'desktop:browser:select-session',
  DESKTOP_BROWSER_SELECT_TAB: 'desktop:browser:select-tab',
  DESKTOP_BROWSER_CLOSE_TAB: 'desktop:browser:close-tab',
  DESKTOP_BROWSER_STOP: 'desktop:browser:stop',
  DESKTOP_OPEN_SETTINGS: 'desktop:open-settings',
  DESKTOP_RELOAD_DASHBOARD: 'desktop:reload-dashboard',
  DESKTOP_ANALYTICS_LOCAL: 'desktop:analytics:local',
  DESKTOP_SETTINGS_GET: 'desktop:settings:get',
  DESKTOP_SETTINGS_SAVE: 'desktop:settings:save',
  DESKTOP_LIFECYCLE_GET: 'desktop:lifecycle:get',
  DESKTOP_LIFECYCLE_ACK_CONNECTOR_REFRESH: 'desktop:lifecycle:acknowledge-connector-refresh',
  DESKTOP_STARTUP_SET: 'desktop:startup:set',
  DESKTOP_KEEP_AWAKE_SET: 'desktop:keep-awake:set',
  DESKTOP_APP_PREFERENCES_SET: 'desktop:app-preferences:set',
  DESKTOP_NOTIFICATIONS_GET: 'desktop:notifications:get',
  DESKTOP_NOTIFICATIONS_SET: 'desktop:notifications:set',
  DESKTOP_NOTIFICATION_PREFERENCES_GET: 'desktop:notification-preferences:get',
  DESKTOP_NOTIFICATION_PREFERENCES_SET: 'desktop:notification-preferences:set',
  DESKTOP_UPDATE_GET: 'desktop:update:get',
  DESKTOP_UPDATE_CHECK: 'desktop:update:check',
  DESKTOP_UPDATE_DOWNLOAD: 'desktop:update:download',
  DESKTOP_UPDATE_INSTALL: 'desktop:update:install',
  DESKTOP_DIAGNOSTICS_EXPORT: 'desktop:diagnostics:export',
  DESKTOP_DIAGNOSTICS_OPEN_FOLDER: 'desktop:diagnostics:open-folder',
  DESKTOP_DIAGNOSTICS_TUNNEL_DOCTOR: 'desktop:diagnostics:tunnel-doctor',
  DESKTOP_LOCAL_DATA_GET: 'desktop:local-data:get',
  DESKTOP_LOCAL_DATA_CLEAR_TEMPORARY: 'desktop:local-data:clear-temporary',
  DESKTOP_LOCAL_DATA_OPEN_FOLDER: 'desktop:local-data:open-folder',
  DESKTOP_CODE_GET: 'desktop:code:get',
  DESKTOP_CODE_DIFF: 'desktop:code:diff',
  DESKTOP_CODE_EDITORS: 'desktop:code:editors',
  DESKTOP_CODE_OPEN_IDE: 'desktop:code:open-ide',
  URL_COPY: 'url:copy',
  DESKTOP_STOP_SERVICE: 'desktop:stop-service',
  WINDOW_FIT_CONTENT: 'window:fit-content',
  SERVER_STATUS: 'server:status',
  SERVER_LOG: 'server:log',
  DESKTOP_WINDOW_STATE: 'desktop:window-state',
  DESKTOP_BROWSER_STATE: 'desktop:browser-state',
  DESKTOP_UPDATE_STATUS: 'desktop:update-status',
  PULSE_SET_EXPANDED: 'pulse:set-expanded',
  PULSE_UPDATE: 'pulse:update'
} as const);

export type DesktopIpcChannel = typeof DESKTOP_IPC[keyof typeof DESKTOP_IPC];
export const DESKTOP_IPC_CHANNELS = Object.freeze(Object.values(DESKTOP_IPC)) as readonly DesktopIpcChannel[];

function input(mode: DesktopIpcInputMode, windows: readonly DesktopSurface[], failure: 'reject' | 'ignore'): DesktopIpcInputSpec {
  return Object.freeze({ mode, windows: Object.freeze(windows), failure });
}

export const DESKTOP_IPC_INPUT_CONTRACT = Object.freeze({
  [DESKTOP_IPC.WIZARD_DONE]: input('handle', ['wizard'], 'reject'),
  [DESKTOP_IPC.WIZARD_CANCEL]: input('handle', ['wizard'], 'reject'),
  [DESKTOP_IPC.WIZARD_OPEN_OPENAI_SETUP]: input('handle', ['wizard'], 'reject'),
  [DESKTOP_IPC.RECOVERY_GET_CONFIG]: input('handle', ['wizard'], 'reject'),
  [DESKTOP_IPC.RECOVERY_OPEN_SETUP]: input('handle', ['fallback'], 'reject'),
  [DESKTOP_IPC.URL_OPEN_DASHBOARD]: input('handle', ['fallback', 'pulse'], 'reject'),
  [DESKTOP_IPC.PULSE_SET_EXPANDED]: input('handle', ['pulse'], 'reject'),
  [DESKTOP_IPC.NOTIFICATIONS_GET_ENABLED]: input('handle', ['fallback'], 'reject'),
  [DESKTOP_IPC.NOTIFICATIONS_SET_ENABLED]: input('handle', ['fallback'], 'reject'),
  [DESKTOP_IPC.SERVER_START]: input('handle', ['fallback'], 'reject'),
  [DESKTOP_IPC.SERVER_STOP]: input('handle', ['fallback'], 'reject'),
  [DESKTOP_IPC.RECOVERY_RESTART_CONNECTION]: input('handle', ['fallback'], 'reject'),
  [DESKTOP_IPC.RECOVERY_RELAUNCH]: input('handle', ['fallback'], 'reject'),
  [DESKTOP_IPC.DESKTOP_RESTART_CONNECTION]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_RELAUNCH]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_LOGOUT]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_QUIT]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_GET_STATUS]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_WINDOW_GET_STATE]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_WINDOW_MINIMIZE]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_WINDOW_TOGGLE_MAXIMIZE]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_WINDOW_CLOSE]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_BROWSER_GET_STATE]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_BROWSER_SET_BOUNDS]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_BROWSER_SET_CONTROL]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_BROWSER_SELECT_SESSION]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_BROWSER_SELECT_TAB]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_BROWSER_CLOSE_TAB]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_BROWSER_STOP]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_OPEN_SETTINGS]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_RELOAD_DASHBOARD]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_ANALYTICS_LOCAL]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_SETTINGS_GET]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_SETTINGS_SAVE]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_LIFECYCLE_GET]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_LIFECYCLE_ACK_CONNECTOR_REFRESH]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_STARTUP_SET]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_KEEP_AWAKE_SET]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_APP_PREFERENCES_SET]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_NOTIFICATIONS_GET]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_NOTIFICATIONS_SET]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_NOTIFICATION_PREFERENCES_GET]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_NOTIFICATION_PREFERENCES_SET]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_UPDATE_GET]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_UPDATE_CHECK]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_UPDATE_DOWNLOAD]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_UPDATE_INSTALL]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_DIAGNOSTICS_EXPORT]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_DIAGNOSTICS_OPEN_FOLDER]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_DIAGNOSTICS_TUNNEL_DOCTOR]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_LOCAL_DATA_GET]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_LOCAL_DATA_CLEAR_TEMPORARY]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_LOCAL_DATA_OPEN_FOLDER]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_CODE_GET]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_CODE_DIFF]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_CODE_EDITORS]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_CODE_OPEN_IDE]: input('handle', ['dashboard'], 'reject'),
  [DESKTOP_IPC.URL_COPY]: input('handle', ['wizard', 'fallback', 'dashboard'], 'reject'),
  [DESKTOP_IPC.DESKTOP_STOP_SERVICE]: input('on', ['dashboard'], 'ignore'),
  [DESKTOP_IPC.WINDOW_FIT_CONTENT]: input('on', ['wizard', 'fallback'], 'ignore')
}) satisfies DesktopIpcInputContract;
