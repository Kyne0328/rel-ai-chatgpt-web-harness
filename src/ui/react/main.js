import React, {
  createContext,
  lazy,
  memo,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  Suspense
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as Dialog from '@radix-ui/react-dialog';
import { Icon } from '../components/icons.js';
import { OverlayFrame } from '../components/overlay-frame.js';
import { toast } from '../components/toast.js';
import { StatusPill } from '../components/pill.js';
import { connectionLayerViews, connectionStateFor, connectionSummary } from '../connection-state.js';
import { DEVELOPER_FEATURE_CHANGE_EVENT, DEVELOPER_FEATURES, readDeveloperFeatureEnabled } from '../developer-mode.js';
import { classifyTaskActivity } from '../../taskActivityPresentation.js';
import {
  DESKTOP_WORK_NAV_ITEMS,
  DESKTOP_SYSTEM_NAV_ITEMS,
  DESKTOP_SECONDARY_NAV_ITEMS,
  DESKTOP_UTILITY_NAV_ITEMS,
  EXTENSIONS_NAV_ITEM,
  MOBILE_MORE_NAV_ITEMS,
  MOBILE_PRIMARY_NAV_ITEMS,
  SETTINGS_NAV_ITEMS,
  SYSTEM_NAV_ITEMS,
  desktopNavigationOwner,
  navigationCommands,
  routeMetadata
} from '../navigation-catalog.js';
import { getOverlaySnapshot, removeToastOverlay, subscribeOverlay } from '../overlay-store.js';
import { getUiPreferences, setThemePreference } from '../preferences.js';
import { normalizeRouteKey } from '../route-policy.js';
import { getRouteSnapshot, initRouter, routeHref, subscribeRoute } from '../router.js';
import { timeAgo } from '../utils.js';
import { processStateView, workSessionStateView } from '../task-identity.js';
export { initConnectorRefreshModal } from '../connector-refresh-modal.js';
export { initUpdateAvailableModal } from '../update-available-modal.js';
export { applyLiveEvent, getSnapshot, init, patchLocalConnection, subscribe } from '../store.js';

if (import.meta.env?.DEV) void import('../styles/app.css');

const h = React.createElement;
const SHELL_STORE_KEYS = Object.freeze(['ok', 'config', 'connectionState', 'taskActivity', 'live', 'tasks']);
const DOCK_STORE_KEYS = Object.freeze(['taskActivity', 'auditTail', 'managedProcesses']);
const DashboardStoreContext = createContext(null);
const reactRouteComponents = new Map();
const reactRoutePreloads = new Map();
const reactRoutePreloadPromises = new Map();
const reactRouteWarmups = new Map([
  ['usage', () => Promise.all([
    import('../components/sparkline.js'),
    import('../components/charts.js')
  ])]
]);
const uiListeners = new Set();
let foundationRoot = null;
let foundationOptions = {};
let sequence = 0;
let uiSnapshot = Object.freeze({
  connectionOverride: null,
  lastEventAt: 0,
  recovery: null,
  routeState: null
});

function UpdateStatusPill() {
  const bridge = window.relaiDesktop;
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (!bridge?.getUpdateStatus) return undefined;
    let active = true;
    void bridge.getUpdateStatus().then(next => { if (active) setStatus(next); }).catch(() => {});
    const remove = typeof bridge.onUpdateStatus === 'function'
      ? bridge.onUpdateStatus(next => { if (active) setStatus(next); })
      : null;
    return () => {
      active = false;
      if (typeof remove === 'function') remove();
    };
  }, [bridge]);

  const state = String(status?.state || '');
  if (!['downloading', 'downloaded', 'installing'].includes(state) && status?.installDeferred !== true) return null;
  const percent = Math.max(0, Math.min(100, Number(status?.progress?.percent || 0)));
  const label = status?.installDeferred === true
    ? 'Update queued'
    : state === 'downloading'
      ? `Update ${Math.round(percent)}%`
      : state === 'downloaded'
        ? 'Update ready'
        : 'Updating';
  const tone = state === 'downloaded' && status?.installDeferred !== true ? 'ok' : 'working';
  return h(StatusPill, {
    className: 'connection-status-link',
    href: '#settings/about',
    tone,
    label,
    'aria-label': `Open App updates; ${label}`
  });
}

function useDashboardSlices(keys) {
  const store = useContext(DashboardStoreContext);
  const cache = useRef({ source: null, value: null });
  if (!store) throw new Error('React dashboard components must render inside the dashboard store provider.');
  const getSelectedSnapshot = useCallback(() => {
    const source = store.getSnapshot();
    const previous = cache.current;
    if (previous.value && keys.every(key => previous.source?.[key] === source?.[key])) return previous.value;
    const value = Object.fromEntries(keys.map(key => [key, source?.[key]]));
    cache.current = { source, value };
    return value;
  }, [keys, store]);
  return useSyncExternalStore(store.subscribe, getSelectedSnapshot, getSelectedSnapshot);
}

function registerReactSection(section, Component) {
  const id = String(section || '').trim();
  if (!id || typeof Component !== 'function') throw new Error('A React dashboard section requires a route id and component.');
  reactRouteComponents.set(id, Component);
}

registerReactSection('home', createLazyRoute(() => import('../features/home/react.js'), 'createHomeRoute', useDashboardSlices, 'home'));
registerReactSection('activity', createLazyRoute(() => import('../features/activity/react.js'), 'createActivityRoute', useDashboardSlices, 'activity'));
registerReactSection('tasks', createLazyRoute(() => import('../features/sessions/react.js'), 'createSessionsRoute', useDashboardSlices, 'tasks'));
registerReactSection('workspaces', createLazyRoute(() => import('../features/workspaces/react.js'), 'createWorkspacesRoute', useDashboardSlices, 'workspaces'));
registerReactSection('code', createLazyRoute(() => import('../features/code/react.js'), 'createCodeRoute', useDashboardSlices, 'code'));
registerReactSection('browser', createLazyRoute(() => import('../features/browser/react.js'), 'createBrowserRoute', undefined, 'browser'));
registerReactSection('extensions', createLazyRoute(() => import('../features/extensions/react.js'), 'createExtensionsRoute', undefined, 'extensions'));
registerReactSection('processes', createLazyRoute(() => import('../features/processes/react.js'), 'createProcessesRoute', useDashboardSlices, 'processes'));
registerReactSection('tools', createLazyRoute(() => import('../features/tools/react.js'), 'createToolsRoute', undefined, 'tools'));
registerReactSection('usage', createLazyRoute(() => import('../features/usage/react.js'), 'createUsageRoute', useDashboardSlices, 'usage'));
registerReactSection('settings', createLazyRoute(() => import('../features/settings/react.js'), 'createSettingsRoute', useDashboardSlices, 'settings'));
registerReactSection('diagnostics', createLazyRoute(() => import('../features/settings/diagnostics-react.js'), 'createDiagnosticsRoute', useDashboardSlices, 'diagnostics'));

function createLazyRoute(load, factoryName, storeHook, section) {
  if (section) reactRoutePreloads.set(section, load);
  else reactRoutePreloads.set(factoryName, load);
  const LazyComponent = lazy(async () => {
    const module = await load();
    const factory = module?.[factoryName];
    if (typeof factory !== 'function') throw new Error(`React route factory ${factoryName} is unavailable.`);
    return { default: storeHook ? factory(storeHook) : factory() };
  });
  return function LazyRoute() {
    return h(LazyComponent);
  };
}

export function preloadReactRoutes(section = 'home') {
  const id = String(section || '').trim() || 'home';
  const load = reactRoutePreloads.get(id);
  if (!load) return Promise.allSettled([]);
  const existing = reactRoutePreloadPromises.get(id);
  if (existing) return existing;
  const warmup = reactRouteWarmups.get(id);
  const pending = Promise.allSettled([
    Promise.resolve().then(load),
    ...(warmup ? [Promise.resolve().then(warmup)] : [])
  ]).then(results => {
    if (results.some(result => result.status === 'rejected')) reactRoutePreloadPromises.delete(id);
    return results;
  }).catch(() => {
    reactRoutePreloadPromises.delete(id);
    return [];
  });
  reactRoutePreloadPromises.set(id, pending);
  return pending;
}

export function preloadReactRoute(section) {
  return preloadReactRoutes(section);
}

export function mountReactFoundation(element, store, options = {}) {
  if (!element || !validStore(store)) return null;
  initRouter();
  foundationOptions = { ...options };
  foundationRoot ||= createRoot(element);
  flushSync(() => {
    foundationRoot.render(h(
      DashboardStoreContext.Provider,
      { value: store },
      h(DashboardShell, foundationOptions)
    ));
  });
  return foundationRoot;
}

export function setShellLastEventAt(timestamp) {
  const value = Number(timestamp);
  updateUi({ lastEventAt: Number.isFinite(value) && value > 0 ? value : 0 });
}

export function setShellConnectionOverride(presentation) {
  const next = presentation && presentation.label
    ? { label: String(presentation.label), tone: String(presentation.tone || 'warn') }
    : null;
  updateUi({ connectionOverride: next });
}

export function showShellRecoveryNotice(options = {}) {
  updateUi({
    recovery: {
      id: ++sequence,
      kind: options.kind === 'restored' ? 'restored' : 'error',
      title: String(options.title || ''),
      description: String(options.description || ''),
      primaryLabel: String(options.primaryLabel || ''),
      primaryBusyLabel: String(options.primaryBusyLabel || options.primaryLabel || ''),
      onPrimary: typeof options.onPrimary === 'function' ? options.onPrimary : null,
      secondaryLabel: String(options.secondaryLabel || ''),
      secondaryBusyLabel: String(options.secondaryBusyLabel || options.secondaryLabel || ''),
      onSecondary: typeof options.onSecondary === 'function' ? options.onSecondary : null,
      diagnosticsHref: String(options.diagnosticsHref || '#diagnostics')
    }
  });
}

export function clearShellRecoveryNotice() {
  updateUi({ recovery: null });
}

export function showShellDashboardState(options = {}) {
  updateUi({
    routeState: {
      id: ++sequence,
      kind: options.kind === 'error' ? 'error' : 'loading',
      title: String(options.title || ''),
      description: String(options.description || ''),
      primaryLabel: String(options.primaryLabel || ''),
      primaryBusyLabel: String(options.primaryBusyLabel || options.primaryLabel || ''),
      onPrimary: typeof options.onPrimary === 'function' ? options.onPrimary : null,
      secondaryLabel: String(options.secondaryLabel || ''),
      secondaryBusyLabel: String(options.secondaryBusyLabel || options.secondaryLabel || ''),
      onSecondary: typeof options.onSecondary === 'function' ? options.onSecondary : null,
      diagnosticsHref: String(options.diagnosticsHref || '#diagnostics')
    }
  });
}

export function clearShellDashboardState() {
  updateUi({ routeState: null });
}

function validStore(store) {
  return typeof store?.getSnapshot === 'function' && typeof store?.subscribe === 'function';
}

function subscribeUi(listener) {
  uiListeners.add(listener);
  return () => uiListeners.delete(listener);
}

function updateUi(patch, { sync = false } = {}) {
  uiSnapshot = Object.freeze({ ...uiSnapshot, ...patch });
  const notify = () => uiListeners.forEach(listener => listener());
  if (sync && foundationRoot) flushSync(notify);
  else notify();
}

function useRoutePresentation() {
  const routeSnapshot = useSyncExternalStore(subscribeRoute, getRouteSnapshot, getRouteSnapshot);
  return useMemo(() => {
    const routeKey = routeSnapshot.key;
    const path = routeKey.split('?')[0] || 'home';
    const section = path.split('/')[0] || 'home';
    const metadata = routeMetadata(path);
    const title = path === 'settings' || path.startsWith('settings/')
      ? `Settings · ${metadata.label}`
      : metadata.label;
    const searchParams = new URLSearchParams(routeSnapshot.search?.slice(1) || routeKey.split('?')[1] || '');
    const workspace = searchParams.get('workspace') || '';
    return Object.freeze({
      announcement: `${title} page loaded.`,
      description: metadata.description,
      key: routeKey,
      owner: desktopNavigationOwner(section),
      path,
      section,
      title,
      workspace
    });
  }, [routeSnapshot]);
}

function DashboardShell({ desktop = null, onAddWorkspace = null } = {}) {
  const data = useDashboardSlices(SHELL_STORE_KEYS);
  const ui = useSyncExternalStore(subscribeUi, () => uiSnapshot, () => uiSnapshot);
  const overlays = useSyncExternalStore(subscribeOverlay, getOverlaySnapshot, getOverlaySnapshot);
  const route = useRoutePresentation();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => document.documentElement.dataset.sidebar === 'collapsed');
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [extensionsEnabled, setExtensionsEnabled] = useState(() => readDeveloperFeatureEnabled('extensions'));
  const paletteOpener = useRef(null);
  const previousRoutePath = useRef(route.path);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const [dockOpen, setDockOpen] = useState(() => {
    try { return localStorage.getItem('relai_dock_open') === '1'; } catch { return false; }
  });
  const [dockTab, setDockTab] = useState('events');
  const toggleDock = useCallback(() => {
    setDockOpen(prev => {
      const next = !prev;
      try { localStorage.setItem('relai_dock_open', next ? '1' : '0'); } catch {}
      return next;
    });
  }, []);

  useEffect(() => {
    document.title = `${route.title} · Rel.AI MCP`;
    setMobileMoreOpen(false);
  }, [route.owner, route.path, route.title]);

  useEffect(() => {
    // Parameter changes select content within the page. Preserve the task
    // inspector or keyboard row focus instead of moving it to the page title.
    const shouldFocusHeading = previousRoutePath.current !== route.path;
    previousRoutePath.current = route.path;
    if (shouldFocusHeading) document.getElementById('pageTitle')?.focus({ preventScroll: true });
    window.dispatchEvent(new CustomEvent('relai:route-mounted', {
      detail: { section: route.section, path: route.path, params: new URLSearchParams(route.key.split('?')[1] || '') }
    }));
  }, [route.key, route.path, route.section]);

  useEffect(() => {
    const onKeyDown = event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j') {
        if (event.defaultPrevented || document.querySelector('#__relai-modal-backdrop, #__relai-drawer-backdrop')) return;
        event.preventDefault();
        toggleDock();
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      if (document.querySelector('#__relai-modal-backdrop, #__relai-drawer-backdrop')) return;
      paletteOpener.current = document.activeElement;
      setPaletteOpen(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [toggleDock]);

  useEffect(() => {
    const refreshExtensionsFlag = event => {
      if (event?.detail?.feature && event.detail.feature !== 'extensions') return;
      setExtensionsEnabled(readDeveloperFeatureEnabled('extensions'));
    };
    const onStorage = event => {
      if (event.key === DEVELOPER_FEATURES.extensions.storageKey) refreshExtensionsFlag();
    };
    window.addEventListener(DEVELOPER_FEATURE_CHANGE_EVENT, refreshExtensionsFlag);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(DEVELOPER_FEATURE_CHANGE_EVENT, refreshExtensionsFlag);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const toggleSidebar = () => {
    const nextCollapsed = !sidebarCollapsed;
    setSidebarCollapsed(nextCollapsed);
    document.documentElement.dataset.sidebar = nextCollapsed ? 'collapsed' : 'expanded';
    try { localStorage.setItem('relai_sidebar_collapsed', nextCollapsed ? '1' : '0'); } catch {}
  };
  const openPalette = event => {
    if (document.querySelector('#__relai-modal-backdrop, #__relai-drawer-backdrop')) return;
    paletteOpener.current = event.currentTarget;
    setPaletteOpen(true);
  };
  const connection = ui.connectionOverride || connectionPresentation(data);
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘ K' : 'Ctrl K';
  const revisionKey = JSON.stringify(data?.live?.revisions || {});

  return h(React.Fragment, null,
    h(WindowTitlebar, { desktop }),
    h('a', {
      href: '#main',
      className: 'skip-link',
      onClick: event => {
        event.preventDefault();
        document.getElementById('main')?.focus();
      }
    }, 'Skip to content'),
    h('div', {
      className: 'sr-only',
      id: 'routeAnnouncer',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true'
    }, route.announcement),
    h('div', {
      className: 'app-shell',
      'data-react-dashboard-ready': 'true',
      'data-store-revisions': revisionKey
    },
      h(DesktopSidebar, {
        collapsed: sidebarCollapsed,
        extensionsEnabled,
        route,
        toggleSidebar
      }),
      h('main', { id: 'main', className: 'main', tabIndex: -1, 'aria-labelledby': 'pageTitle' },
        h(MobileNavigation, { extensionsEnabled, open: mobileMoreOpen, route, setOpen: setMobileMoreOpen }),
        h('header', { className: 'topbar' },
          h('div', { className: 'title-wrap' },
            h('h1', { className: 'page-title', id: 'pageTitle', tabIndex: -1 }, route.title),
            h('div', { className: 'page-subtitle', id: 'subtitle' }, route.description)
          ),
          h('div', { className: 'top-controls' },
            h('button', {
              className: 'secondary command-trigger',
              id: 'commandPaletteBtn',
              type: 'button',
              'aria-haspopup': 'dialog',
              'aria-label': `Open quick navigation ${shortcut}`,
              'aria-keyshortcuts': /Mac|iPhone|iPad/.test(navigator.platform || '') ? 'Meta+K' : 'Control+K',
              'aria-expanded': paletteOpen ? 'true' : 'false',
              title: 'Open quick navigation',
              onClick: openPalette
            },
              h(Icon, { name: 'search' }),
              h('span', { className: 'command-trigger-label' }, 'Quick navigation '),
              h('kbd', { 'aria-hidden': 'true' }, shortcut)
            ),
            h('button', {
              className: `secondary command-trigger runtime-dock-btn${dockOpen ? ' active' : ''}`,
              type: 'button',
              'aria-expanded': dockOpen ? 'true' : 'false',
              'aria-label': /Mac|iPhone|iPad/.test(navigator.platform || '') ? 'Runtime ⌘J — toggle execution dock' : 'Runtime Ctrl J — toggle execution dock',
              title: `Toggle runtime dock (${/Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘J' : 'Ctrl+J'})`,
              onClick: toggleDock
            },
              h(Icon, { name: 'terminal' }),
              h('span', { className: 'command-trigger-label' }, 'Runtime '),
              h('kbd', { 'aria-hidden': 'true' }, /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘J' : 'Ctrl J')
            ),
            h(UpdateStatusPill),
            h(StatusPill, {
              id: 'connectionStatus',
              className: 'connection-status-link',
              href: '#settings/connection',
              tone: connection.tone,
              label: connection.label,
              'aria-label': `Open Connection settings; current status ${connection.label}`
            }),
            h(LastUpdatedClock, { lastEventAt: ui.lastEventAt })
          )
        ),
        h(RecoveryNotice, { recovery: ui.recovery }),
        h(RouteOutlet, { route, routeState: ui.routeState }),
        dockOpen ? h(RuntimeDock, {
          activeTab: dockTab,
          onSelectTab: setDockTab,
          onClose: () => {
            setDockOpen(false);
            document.querySelector('.runtime-dock-btn')?.focus({ preventScroll: true });
            try { localStorage.setItem('relai_dock_open', '0'); } catch {}
          }
        }) : null
      )
    ),
    h(CommandPalette, {
      data,
      desktop,
      extensionsEnabled,
      onAddWorkspace,
      onClose: closePalette,
      open: paletteOpen,
      opener: paletteOpener.current
    }),
    h(OverlayHost, { drawer: overlays.drawer, modal: overlays.modal }),
    h(ToastRegion, { toasts: overlays.toasts })
  );
}


function RuntimeDock({ activeTab = 'events', onSelectTab, onClose }) {
  const data = useDashboardSlices(DOCK_STORE_KEYS);
  const auditEntries = Array.isArray(data.auditTail?.entries) ? data.auditTail.entries.slice(-20).reverse() : [];
  const managedProcesses = Array.isArray(data.managedProcesses) ? data.managedProcesses : [];
  const activeProcesses = managedProcesses.filter(p => !['stopped', 'exited', 'failed'].includes(String(p?.status || '').toLowerCase()));
  const activeTask = classifyTaskActivity(data.taskActivity).primaryTask;

  useEffect(() => {
    const handleKey = event => {
      if (event.key === 'Escape' && !event.defaultPrevented && event.target.closest?.('.runtime-dock')) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return h('aside', { className: 'runtime-dock', 'aria-label': 'Runtime execution dock', role: 'region' },
    h('div', { className: 'runtime-dock-header' },
      h('div', { className: 'runtime-dock-tabs', role: 'tablist', 'aria-label': 'Runtime views', onKeyDown: event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'events' : event.key === 'End' ? 'processes' : activeTab === 'events' ? 'processes' : 'events';
        onSelectTab(next);
        event.currentTarget.querySelector(`#runtime-tab-${next}`)?.focus();
      } },
        h('button', {
          type: 'button',
          role: 'tab',
          id: 'runtime-tab-events',
          tabIndex: activeTab === 'events' ? 0 : -1,
          'aria-controls': 'runtime-dock-panel',
          className: `runtime-dock-tab${activeTab === 'events' ? ' active' : ''}`,
          'aria-selected': activeTab === 'events' ? 'true' : 'false',
          onClick: () => onSelectTab('events')
        },
          'Live Events',
          auditEntries.length ? h('span', { className: 'task-tab-badge' }, auditEntries.length) : null
        ),
        h('button', {
          type: 'button',
          role: 'tab',
          id: 'runtime-tab-processes',
          tabIndex: activeTab === 'processes' ? 0 : -1,
          'aria-controls': 'runtime-dock-panel',
          className: `runtime-dock-tab${activeTab === 'processes' ? ' active' : ''}`,
          'aria-selected': activeTab === 'processes' ? 'true' : 'false',
          onClick: () => onSelectTab('processes')
        },
          'Active Processes',
          activeProcesses.length ? h('span', { className: 'task-tab-badge' }, activeProcesses.length) : null
        )
      ),
      h('div', { className: 'runtime-dock-actions' },
        activeTab === 'events'
          ? h('a', { className: 'section-action', href: routeHref('activity') }, 'View all activity →')
          : h('a', { className: 'section-action', href: routeHref('processes') }, 'View all processes →'),
        h('button', {
          type: 'button',
          className: 'runtime-dock-close',
          'aria-label': 'Close runtime dock',
          onClick: onClose
        }, h(Icon, { name: 'close', size: 14 }))
      )
    ),
    h('div', { className: 'runtime-dock-body', id: 'runtime-dock-panel', role: 'tabpanel', 'aria-labelledby': `runtime-tab-${activeTab}`, tabIndex: 0 },
      activeTab === 'events'
        ? h(RuntimeDockEvents, { entries: auditEntries, activeTask })
        : h(RuntimeDockProcesses, { processes: activeProcesses })
    )
  );
}

function RuntimeDockEvents({ entries = [], activeTask = null }) {
  if (!entries.length && !activeTask) {
    return h('div', { className: 'runtime-dock-empty' }, 'No live tool execution events recorded in this session.');
  }
  return h('div', { className: 'runtime-dock-list' },
    activeTask ? h('div', { className: 'runtime-dock-item active-executing' },
      h('span', { className: 'runtime-dock-status status-working', 'aria-hidden': 'true' }),
      h('strong', { className: 'runtime-dock-tool' }, activeTask.lastTool || activeTask.tool?.name || 'Active task'),
      h('span', { className: 'runtime-dock-summary' }, activeTask.currentActivity || activeTask.title || 'Executing…'),
      h('span', { className: 'runtime-dock-time' }, workSessionStateView(activeTask).label)
    ) : null,
    entries.map((entry, idx) => {
      const time = entry.ts || entry.timestamp || '';
      const statusTone = entry.status === 'succeeded' || entry.status === 'ok' ? 'status-ok' : entry.status === 'failed' || entry.status === 'error' ? 'status-error' : 'status-neutral';
      return h('div', { className: 'runtime-dock-item', key: entry.id || `${entry.ts}-${idx}` },
        h('span', { className: `runtime-dock-status ${statusTone}`, 'aria-hidden': 'true' }),
        h('code', { className: 'runtime-dock-tool' }, entry.tool?.name || entry.tool || entry.source || 'tool'),
        h('span', { className: 'runtime-dock-summary' }, entry.summary || entry.message || entry.action || '—'),
        h('span', { className: 'runtime-dock-time', 'data-clock-relative': time }, timeAgo(time))
      );
    })
  );
}

function RuntimeDockProcesses({ processes = [] }) {
  if (!processes.length) {
    return h('div', { className: 'runtime-dock-empty' }, 'No background child processes currently active.');
  }
  return h('div', { className: 'runtime-dock-list' },
    processes.map((proc, idx) => {
      const state = processStateView(proc);
      const pidText = proc.pid ? `PID ${proc.pid}` : '';
      const key = proc.processId || proc.id || `${proc.pid}-${idx}`;
      return h('div', { className: 'runtime-dock-item', key },
        h('span', { className: `runtime-dock-status ${state.active ? 'status-working' : 'status-error'}`, 'aria-hidden': 'true' }),
        h('strong', { className: 'runtime-dock-tool' }, proc.label || proc.commandSummary || 'Managed process'),
        h('span', { className: 'runtime-dock-summary' }, pidText ? `${pidText} · ${proc.workspace || 'managed'}` : proc.workspace || 'managed'),
        h('span', { className: 'runtime-dock-time' }, state.label)
      );
    })
  );
}

function DesktopSidebar({ collapsed, extensionsEnabled, route, toggleSidebar }) {
  const surface = document.documentElement.dataset.surface || 'browser';
  return h('aside', { className: 'sidebar', id: 'desktopSidebar' },
    h('div', { className: 'brand' },
      h('div', { className: 'brand-identity' },
        h('div', { className: 'logo' },
          h('img', { src: '/public/assets/relai-logo.png', alt: 'Rel.AI logo', width: 193, height: 187 })
        ),
        h('div', { className: 'brand-copy' }, h('strong', null, 'Rel.AI MCP'))
      ),
      h('button', {
        className: 'sidebar-toggle',
        id: 'sidebarToggle',
        type: 'button',
        'aria-controls': 'desktopSidebar',
        'aria-expanded': collapsed ? 'false' : 'true',
        'aria-label': collapsed ? 'Expand sidebar' : 'Collapse sidebar',
        title: collapsed ? 'Expand sidebar' : 'Collapse sidebar',
        onClick: toggleSidebar
      }, h(Icon, { name: collapsed ? 'sidebarOpen' : 'sidebarClose' }))
    ),
    h('div', { className: 'sidebar-navigation' },
      h('div', { className: 'sidebar-group' },
        h('div', { className: 'sidebar-group-label' }, 'Work'),
        h('nav', { className: 'nav', 'aria-label': 'Work navigation' },
          DESKTOP_WORK_NAV_ITEMS.map(item => h(NavLink, { key: item.id, item, active: route.path === item.path || (item.id === 'tasks' && route.path === 'code') }))
        )
      ),
      h('div', { className: 'sidebar-group secondary-nav' },
        h('div', { className: 'sidebar-group-label' }, 'System'),
        h('nav', { className: 'nav', 'aria-label': 'System navigation' },
          DESKTOP_SYSTEM_NAV_ITEMS.map(item => h(NavLink, { key: item.id, item, active: route.path === item.path }))
        )
      )
    ),
    h('div', { className: 'sidebar-utilities secondary-nav' },
      h('div', { className: 'sidebar-group-label' }, 'Utilities'),
      h('nav', { className: 'nav', 'aria-label': 'Utilities navigation' },
        DESKTOP_UTILITY_NAV_ITEMS.map(item => h(NavLink, {
          key: item.id, item,
          active: item.id === 'settings'
            ? route.owner === 'settings'
            : route.path === item.path
        }))
      ),
      h('details', { className: 'sidebar-more', open: DESKTOP_SECONDARY_NAV_ITEMS.some(item => item.path === route.path) || route.path === 'extensions' ? true : undefined },
        h('summary', { title: 'More navigation', 'aria-label': 'More navigation' },
          h(Icon, { className: 'nav-icon', name: 'more' }), h('span', { className: 'nav-label' }, 'More')
        ),
        h('nav', { className: 'nav', 'aria-label': 'More navigation' },
          DESKTOP_SECONDARY_NAV_ITEMS.map(item => h(NavLink, { key: item.id, item, active: route.path === item.path })),
          extensionsEnabled ? h(NavLink, { item: EXTENSIONS_NAV_ITEM, active: route.owner === EXTENSIONS_NAV_ITEM.id }) : null
        )
      )
    ),
    h('div', { className: 'sidebar-note' },
      h('span', null, surface === 'desktop' ? 'Desktop app' : 'This computer')
    )
  );
}

function MobileNavigation({ extensionsEnabled, open, route, setOpen }) {
  const detailsRef = useRef(null);
  const moreItems = extensionsEnabled ? [...MOBILE_MORE_NAV_ITEMS, EXTENSIONS_NAV_ITEM] : MOBILE_MORE_NAV_ITEMS;
  const moreActive = moreItems.some(item => item.id === route.owner);
  useEffect(() => {
    const onPointerDown = event => {
      if (open && detailsRef.current && !detailsRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, setOpen]);

  return h('nav', { className: 'mobile-nav', 'aria-label': 'Mobile navigation' },
    MOBILE_PRIMARY_NAV_ITEMS.map(item => h(NavLink, {
      key: item.id,
      item,
      active: route.owner === item.id || (item.id === 'tasks' && route.path === 'code'),
      onClick: () => setOpen(false)
    })),
    h('details', {
      className: `mobile-nav-more${moreActive ? ' active' : ''}`,
      ref: detailsRef,
      open,
      onToggle: event => setOpen(event.currentTarget.open),
      onKeyDown: event => {
        if (event.key !== 'Escape' || !event.currentTarget.open) return;
        event.preventDefault();
        setOpen(false);
        event.currentTarget.querySelector(':scope > summary')?.focus();
      }
    },
      h('summary', { className: moreActive ? 'active' : undefined, 'aria-label': 'More navigation', title: 'More' },
        h(Icon, { className: 'nav-icon', name: 'more' }),
        h('span', { className: 'nav-label' }, 'More')
      ),
      h('div', { className: 'mobile-nav-more-menu' },
        moreItems.filter(item => item.id !== 'system' && item.id !== 'settings').map(item => h(NavLink, {
          key: item.id,
          item,
          active: route.path === item.path,
          onClick: () => setOpen(false)
        })),
        [
          { id: 'system', label: 'System', items: SYSTEM_NAV_ITEMS },
          { id: 'settings', label: 'Settings', items: SETTINGS_NAV_ITEMS }
        ].map(group => h('section', {
          key: group.id,
          className: 'mobile-nav-group',
          'aria-labelledby': `mobile-nav-${group.id}-title`
        },
          h('h2', { className: 'mobile-nav-group-title', id: `mobile-nav-${group.id}-title` }, group.label),
          group.items.map(item => h(NavLink, {
            key: item.id,
            item,
            active: route.path === item.path,
            onClick: () => setOpen(false)
          }))
        ))
      )
    )
  );
}

function NavLink({ item, active, onClick }) {
  const preload = () => preloadReactNavigationTarget(item.href);
  return h('a', {
    href: item.href,
    'data-nav-id': item.id,
    'aria-label': item.label,
    'aria-current': active ? 'page' : undefined,
    title: item.label,
    className: active ? 'active' : undefined,
    onPointerEnter: preload,
    onPointerDown: preload,
    onFocus: preload,
    onClick
  }, h(NavIcon, { item }), h('span', { className: 'nav-label' }, item.label));
}

function preloadReactNavigationTarget(href) {
  const raw = String(href || '').replace(/^#/, '');
  const key = normalizeRouteKey(raw || 'home');
  const section = key.split('?')[0].split('/')[0] || 'home';
  void preloadReactRoute(section);
}

function NavIcon({ item }) {
  return h(Icon, { className: 'nav-icon', name: item.icon });
}

function WindowTitlebar({ desktop }) {
  const [state, setState] = useState(() => normalizeWindowState({
    platform: document.documentElement.dataset.platform || 'other',
    customTitleBar: document.documentElement.dataset.windowChrome === 'custom',
    controls: 'native',
    maximized: document.documentElement.dataset.windowMaximized === 'true'
  }));

  useEffect(() => {
    let active = true;
    if (!desktop || typeof desktop.getWindowState !== 'function') {
      applyWindowState(setState, { customTitleBar: false, controls: 'native', platform: 'other', maximized: false });
      return undefined;
    }
    const apply = next => { if (active) applyWindowState(setState, next); };
    const remove = typeof desktop.onWindowState === 'function' ? desktop.onWindowState(apply) : null;
    Promise.resolve(desktop.getWindowState()).then(apply).catch(debugError);
    return () => {
      active = false;
      if (typeof remove === 'function') remove();
    };
  }, [desktop]);

  const maximized = state.maximized === true;
  const maximizeLabel = maximized ? 'Restore window' : 'Maximize window';
  const controlsHidden = state.customTitleBar !== true || state.controls !== 'custom';
  return h('header', { className: 'window-titlebar', id: 'windowTitlebar', 'aria-label': 'Application title bar' },
    h('div', { className: 'window-titlebar-identity', 'aria-hidden': 'true' },
      h('img', { src: '/public/assets/relai-logo.png', alt: '', 'aria-hidden': 'true', width: 193, height: 187 }),
      h('strong', null, 'Rel.AI MCP')
    ),
    h('div', { className: 'window-titlebar-drag', 'aria-hidden': 'true' }),
    h('div', {
      className: 'window-titlebar-controls',
      id: 'windowTitlebarControls',
      role: 'group',
      'aria-label': 'Window controls',
      hidden: controlsHidden
    },
      h(WindowButton, {
        id: 'windowMinimizeBtn',
        label: 'Minimize window',
        onClick: () => runWindowAction(desktop?.minimizeWindow, setState),
        icon: 'minimize'
      }),
      h(WindowButton, {
        id: 'windowMaximizeBtn',
        label: maximizeLabel,
        maximized,
        onClick: () => runWindowAction(desktop?.toggleMaximizeWindow, setState),
        icon: maximized ? 'restore' : 'maximize'
      }),
      h(WindowButton, {
        id: 'windowCloseBtn',
        label: 'Close window',
        className: 'window-titlebar-close',
        onClick: () => runWindowAction(desktop?.closeWindow, setState),
        icon: 'close'
      })
    )
  );
}

function WindowButton({ id, label, className = '', onClick, icon, maximized }) {
  return h('button', {
    className: ['window-titlebar-button', className].filter(Boolean).join(' '),
    id,
    type: 'button',
    'aria-label': label,
    title: label,
    'data-maximized': maximized == null ? undefined : (maximized ? 'true' : 'false'),
    onClick
  }, h(Icon, { name: icon, size: 12, strokeWidth: 1.7 }));
}

function normalizeWindowState(state = {}) {
  const platform = ['win32', 'darwin', 'linux', 'other'].includes(state.platform) ? state.platform : 'other';
  return {
    controls: state.controls === 'custom' ? 'custom' : 'native',
    customTitleBar: state.customTitleBar === true,
    maximized: state.maximized === true,
    platform
  };
}

function applyWindowState(setState, state = {}) {
  const next = normalizeWindowState(state);
  const root = document.documentElement;
  root.dataset.platform = next.platform;
  root.dataset.windowChrome = next.customTitleBar ? 'custom' : 'native';
  root.dataset.windowMaximized = next.maximized ? 'true' : 'false';
  setState(next);
}

function runWindowAction(action, setState) {
  if (typeof action !== 'function') return;
  Promise.resolve(action()).then(state => {
    if (state && Object.hasOwn(state, 'customTitleBar')) applyWindowState(setState, state);
  }).catch(debugError);
}

const RouteOutlet = memo(function RouteOutlet({ route, routeState }) {
  if (routeState) {
    return h('div', { id: 'routeRoot', className: 'route-root' }, h(DashboardState, routeState));
  }
  const Component = reactRouteComponents.get(route.section) || reactRouteComponents.get('home');
  return h('div', { id: 'routeRoot', className: 'route-root' },
    h(RouteErrorBoundary, { routeKey: route.key },
      h(Suspense, {
        key: route.section,
        fallback: h(DashboardState, {
          kind: 'loading',
          title: `Loading ${route.title}…`,
          description: 'Preparing this page.'
        })
      }, Component ? h(Component) : null)
    )
  );
});

class RouteErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(previousProps) {
    if (previousProps.routeKey !== this.props.routeKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return h(DashboardState, {
      kind: 'error',
      title: 'This page could not load.',
      description: this.state.error instanceof Error ? this.state.error.message : String(this.state.error || 'The page could not be loaded.'),
      primaryLabel: 'Retry page',
      primaryBusyLabel: 'Reloading page…',
      onPrimary: retryActiveRoute,
      diagnosticsHref: '#diagnostics'
    });
  }
}

function retryActiveRoute() {
  const desktop = window.relaiDesktop;
  if (typeof desktop?.reloadDashboard === 'function') return desktop.reloadDashboard(window.location.hash || '#home');
  window.location.reload();
  return undefined;
}

function DashboardState({ kind = 'loading', title, description, primaryLabel = '', primaryBusyLabel = '', onPrimary = null, secondaryLabel = '', secondaryBusyLabel = '', onSecondary = null, diagnosticsHref = '' }) {
  const [busy, setBusy] = useState('');
  const loading = kind === 'loading';
  const run = async (key, action) => {
    if (busy || typeof action !== 'function') return;
    setBusy(key);
    try { await action(); } finally { setBusy(''); }
  };
  if (loading) {
    return h('div', {
      className: 'dashboard-state dashboard-state-loading',
      role: 'status',
      'aria-live': 'polite',
      'aria-busy': 'true'
    },
    h('span', { className: 'sr-only' }, title || 'Loading page'),
    h('div', { className: 'dashboard-loading-skeleton', 'aria-hidden': 'true' },
      h('div', { className: 'dashboard-loading-line dashboard-loading-title' }),
      h('div', { className: 'dashboard-loading-line dashboard-loading-copy' }),
      h('div', { className: 'skeleton-grid' },
        h('div', { className: 'skeleton-block' }),
        h('div', { className: 'skeleton-block' }),
        h('div', { className: 'skeleton-block' })
      )
    ));
  }
  return h('div', {
    className: 'dashboard-state',
    role: 'alert'
  }, h('div', { className: 'dashboard-state-card' },
    h(StatusPill, { label: 'Connection error', tone: 'bad' }),
    h('h2', null, title),
    h('p', null, description),
    h('div', { className: 'dashboard-state-actions' },
      onPrimary ? h('button', { className: 'primary', type: 'button', disabled: Boolean(busy), onClick: () => { void run('primary', onPrimary); } }, busy === 'primary' ? primaryBusyLabel : primaryLabel) : null,
      onSecondary ? h('button', { className: 'secondary', type: 'button', disabled: Boolean(busy), onClick: () => { void run('secondary', onSecondary); } }, busy === 'secondary' ? secondaryBusyLabel : secondaryLabel) : null,
      diagnosticsHref ? h('a', { className: 'buttonlike secondary', href: diagnosticsHref }, 'Open Troubleshooting') : null
    )
  ));
}


function connectionPresentation(data = {}) {
  if (data?.ok === false) return { label: 'Error', tone: 'bad' };
  const state = connectionStateFor(data);
  const connection = connectionSummary(state);
  if (connection.tone !== 'ok') return { label: connection.label, tone: connection.tone };
  const task = classifyTaskActivity(data?.taskActivity);
  if (task.category === 'attention') return { label: 'Action required', tone: 'bad' };
  if (task.category === 'working') return { label: `${Math.max(1, task.taskCount)} running`, tone: 'working' };
  if (task.category === 'waiting') return { label: `${Math.max(1, task.taskCount)} open`, tone: 'warn' };
  const dashboardLayer = connectionLayerViews(state).find(layer => layer.key === 'dashboardUpdates');
  if (dashboardLayer) return { label: dashboardLayer.label, tone: dashboardLayer.tone };
  return { label: 'Available', tone: 'ok', callCount: task.activeCalls };
}

const LastUpdatedClock = memo(function LastUpdatedClock({ lastEventAt }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!lastEventAt) return undefined;
    const onTick = event => {
      const value = Number(event?.detail?.now);
      setNow(Number.isFinite(value) ? value : Date.now());
    };
    window.addEventListener('relai:clock-tick', onTick);
    return () => window.removeEventListener('relai:clock-tick', onTick);
  }, [lastEventAt]);
  return h('span', { className: 'section-action', id: 'lastUpdated' }, lastUpdatedText(lastEventAt, now));
});

function lastUpdatedText(lastEventAt, now) {
  if (!lastEventAt) return '';
  const seconds = Math.max(0, Math.floor((now - lastEventAt) / 1000));
  if (seconds < 5) return 'Updated just now';
  if (seconds < 60) return `Updated ${seconds}s ago`;
  return `Updated ${Math.floor(seconds / 60)}m ago`;
}

function RecoveryNotice({ recovery }) {
  const [busy, setBusy] = useState('');
  useEffect(() => {
    setBusy('');
    if (recovery?.kind !== 'restored') return undefined;
    const timer = window.setTimeout(clearShellRecoveryNotice, 3000);
    return () => window.clearTimeout(timer);
  }, [recovery?.id, recovery?.kind]);
  if (!recovery) return null;
  const restored = recovery.kind === 'restored';
  const run = async (key, action) => {
    if (busy || typeof action !== 'function') return;
    setBusy(key);
    try { await action(); } finally { setBusy(''); }
  };
  return h('section', {
    id: 'dashboardRecoveryNotice',
    className: `connection-notice${restored ? '' : ' bad'}`,
    role: restored ? 'status' : 'alert',
    'aria-live': 'polite'
  },
    h('strong', null, recovery.title),
    h('div', null, recovery.description),
    restored ? null : h('div', { className: 'dashboard-state-actions' },
      recovery.onPrimary ? h('button', {
        className: 'primary',
        type: 'button',
        disabled: Boolean(busy),
        onClick: () => { void run('primary', recovery.onPrimary); }
      }, busy === 'primary' ? recovery.primaryBusyLabel : recovery.primaryLabel) : null,
      recovery.onSecondary ? h('button', {
        className: 'secondary',
        type: 'button',
        disabled: Boolean(busy),
        onClick: () => { void run('secondary', recovery.onSecondary); }
      }, busy === 'secondary' ? recovery.secondaryBusyLabel : recovery.secondaryLabel) : null,
      h('a', { className: 'buttonlike secondary', href: recovery.diagnosticsHref }, 'Open Troubleshooting')
    )
  );
}

function CommandPalette({ data, desktop, extensionsEnabled, onAddWorkspace, onClose, open, opener }) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [resultAnnouncement, setResultAnnouncement] = useState('');
  const inputRef = useRef(null);
  const commands = useMemo(() => buildCommands(data, desktop, extensionsEnabled, onAddWorkspace, onClose), [data, desktop, extensionsEnabled, onAddWorkspace, onClose]);
  const visible = useMemo(() => {
    return rankCommands(commands, query).slice(0, 14);
  }, [commands, query]);
  const safeIndex = visible.length ? Math.min(activeIndex, visible.length - 1) : 0;

  useEffect(() => {
    if (activeIndex !== safeIndex) setActiveIndex(safeIndex);
  }, [activeIndex, safeIndex]);
  useEffect(() => {
    if (!open) {
      setQuery('');
      setActiveIndex(0);
    }
  }, [open]);
  useEffect(() => {
    if (!open || !visible.length) return;
    document.getElementById(`command-option-${safeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, safeIndex, visible.length]);
  useEffect(() => {
    if (!open) {
      setResultAnnouncement('');
      return undefined;
    }
    const timer = window.setTimeout(() => {
      const count = visible.length;
      setResultAnnouncement(`${count} ${count === 1 ? 'result' : 'results'} available.`);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [open, query, visible.length]);

  const execute = command => {
    if (!command) return;
    Promise.resolve().then(() => command.run()).catch(error => {
      debugError(error);
      toast(`Could not complete ${command.label.toLowerCase()}. Try again or open Troubleshooting.`, { variant: 'error' });
    });
  };
  const activeId = visible.length ? `command-option-${safeIndex}` : undefined;
  return h(OverlayFrame, {
    open,
    size: 'wide',
    className: 'command-panel',
    onOpenChange: next => { if (!next) onClose(); },
    backdropProps: { id: '__relai-modal-backdrop' },
    contentProps: {
      onOpenAutoFocus: event => {
        event.preventDefault();
        queueMicrotask(() => inputRef.current?.focus({ preventScroll: true }));
      },
      onCloseAutoFocus: event => {
        event.preventDefault();
        if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
        else document.getElementById('pageTitle')?.focus({ preventScroll: true });
      }
    }
  },
    h('header', { className: 'modal-head' },
      h(Dialog.Title, { asChild: true }, h('h2', { className: 'modal-title' }, 'Quick navigation'))
    ),
    h('div', { className: 'modal-body' },
      h('div', { className: 'command-palette' },
        h('label', { className: 'command-search-wrap' },
          h('span', { className: 'sr-only' }, 'Search pages, settings, actions, and projects'),
          h(Icon, { name: 'search' }),
          h('input', {
            className: 'command-search',
            type: 'search',
            role: 'combobox',
            autoComplete: 'off',
            placeholder: 'Search pages, actions, or projects',
            'aria-autocomplete': 'list',
            'aria-expanded': visible.length ? 'true' : 'false',
            'aria-controls': 'commandPaletteList',
            'aria-describedby': 'commandPaletteHelp',
            'aria-activedescendant': activeId,
            ref: inputRef,
            value: query,
            onChange: event => { setQuery(event.target.value); setActiveIndex(0); },
            onKeyDown: event => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex(index => visible.length ? (index + 1) % visible.length : 0);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex(index => visible.length ? (index - 1 + visible.length) % visible.length : 0);
              } else if (event.key === 'Enter' && visible[safeIndex]) {
                event.preventDefault();
                execute(visible[safeIndex]);
              }
            }
          }),
          h('kbd', null, 'Esc')
        ),
        h(Dialog.Description, { asChild: true }, h('div', { className: 'command-help' }, h('span', { id: 'commandPaletteHelp' }, 'Use ↑ and ↓ to move, then press Enter.'))),
        h('span', { className: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, resultAnnouncement),
        h('div', { className: 'command-list', id: 'commandPaletteList', role: 'listbox', 'aria-label': 'Quick navigation results' },
          visible.length
            ? visible.map((command, index) => h('div', {
                className: `command-option${index === safeIndex ? ' active' : ''}`,
                id: `command-option-${index}`,
                key: command.id,
                role: 'option',
                'aria-selected': index === safeIndex ? 'true' : 'false',
                'data-command-index': String(index),
                onMouseEnter: () => {
                  if (index !== safeIndex) setActiveIndex(index);
                  preloadReactNavigationTarget(command.href);
                },
                onClick: () => execute(command),
                onTouchStart: () => {
                  if (index !== safeIndex) setActiveIndex(index);
                  preloadReactNavigationTarget(command.href);
                }
              },
              h('span', { className: 'command-option-start' },
                command.icon ? h(Icon, { name: command.icon, className: 'command-option-icon' }) : null,
                h('span', { className: 'command-option-copy' }, h('strong', null, command.label), h('small', null, command.description))
              ),
              h('span', { className: 'command-group' }, command.group)
            ))
            : h('div', { className: 'command-empty' }, 'No matching page, action, or project.')
        )
      )
    )
  );
}

function buildCommands(data, desktop, extensionsEnabled, onAddWorkspace, closePalette) {
  const commands = navigationCommands({ includeExtensions: extensionsEnabled }).map(item => ({
    id: item.path.replaceAll('/', '-'),
    label: item.group === 'Settings' ? `Settings · ${item.label}` : item.label,
    description: item.description,
    group: item.group,
    icon: item.icon || item.id,
    href: item.href,
    run: () => { closePalette(); location.hash = item.href; }
  }));
  commands.push({
    id: 'toggle-theme',
    label: 'Toggle light / dark theme',
    description: 'Switch the dashboard between light and dark appearance.',
    group: 'Action',
    icon: 'dark',
    searchAliases: 'theme dark light appearance color',
    run: () => {
      const current = document.documentElement.dataset.theme || getUiPreferences().theme;
      setThemePreference(current === 'light' ? 'dark' : 'light');
      closePalette();
    }
  });
  if (typeof desktop?.restartConnection === 'function') {
    commands.push({
      id: 'restart-connection',
      label: 'Restart connection service',
      description: 'Restart the local Rel.AI connection service.',
      group: 'Action',
      icon: 'refresh',
      searchAliases: 'connection reconnect restart service',
      run: async () => { closePalette(); await desktop.restartConnection(); }
    });
  }
  if (typeof onAddWorkspace === 'function') {
    commands.push({
      id: 'add-workspace',
      label: 'Add project',
      description: 'Choose another project folder for ChatGPT.',
      group: 'Action',
      icon: 'add',
      run: async () => { closePalette(); await onAddWorkspace(); }
    });
  }
  for (const workspace of data?.config?.workspaces || []) {
    const alias = String(workspace.alias || '').trim();
    if (!alias) continue;
    const params = new URLSearchParams({ workspace: alias, focus: '1' });
    const href = `#${normalizeRouteKey(`workspaces?${params.toString()}`)}`;
    commands.push({
      id: `workspace-${alias}`,
      label: `Project · ${alias}`,
      description: workspace.path || 'Open project status and actions.',
      group: 'Project',
      icon: 'folder',
      href,
      run: () => { closePalette(); location.hash = href; }
    });
  }
  const seenTaskIds = new Set();
  const rawTasks = [
    ...(Array.isArray(data?.tasks) ? data.tasks : []),
    ...(Array.isArray(data?.taskActivity?.tasks) ? data.taskActivity.tasks : [])
  ];
  for (const task of rawTasks) {
    const id = String(task.id || task.taskId || task.work_id || '').trim();
    if (!id || seenTaskIds.has(id)) continue;
    seenTaskIds.add(id);
    const title = String(task.title || task.operation || id).trim();
    const href = `#tasks?task=${id}`;
    commands.push({
      id: id.startsWith('task-') ? id : `task-${id}`,
      label: title,
      description: task.description || task.summary || (task.workspace ? `Project · ${task.workspace}` : 'View task details.'),
      group: 'Task',
      icon: 'tasks',
      href,
      searchAliases: [id, task.workspace, task.status, 'task', 'tasks'].filter(Boolean).join(' '),
      run: () => { closePalette(); location.hash = href; }
    });
  }
  return commands.map(command => ({
    ...command,
    searchText: normalizeSearch([command.label, command.description, command.group, command.searchAliases].join(' '))
  }));
}

function normalizeSearch(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function fuzzyMatch(pattern, text) {
  if (!pattern) return true;
  if (!text) return false;
  let pIdx = 0;
  let tIdx = 0;
  while (pIdx < pattern.length && tIdx < text.length) {
    if (pattern[pIdx] === text[tIdx]) {
      pIdx++;
    }
    tIdx++;
  }
  return pIdx === pattern.length;
}

function commandMatchesQuery(command, query) {
  const normalized = normalizeSearch(query);
  if (!normalized) return true;
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  return tokens.every(token => (
    command.searchText.includes(token) || (token.length >= 2 && fuzzyMatch(token, command.searchText))
  ));
}

function rankCommands(commands, query) {
  const normalized = normalizeSearch(query);
  if (!normalized) return [...commands];
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const rank = command => {
    const label = normalizeSearch(command.label);
    if (label === normalized) return 0;
    if (label.includes(normalized)) return 1;
    if (tokens.every(token => label.includes(token))) return 2;
    if (command.searchText.includes(normalized)) return 3;
    if (tokens.every(token => command.searchText.includes(token))) return 4;
    return 5;
  };
  return commands.filter(command => commandMatchesQuery(command, query))
    .map(command => ({ command, score: rank(command) }))
    .sort((left, right) => left.score - right.score)
    .map(({ command }) => command);
}

const OverlayHost = memo(function OverlayHost({ drawer, modal }) {
  return h(React.Fragment, null,
    modal ? h(ModalPortal, { descriptor: modal }) : null,
    drawer ? h(DrawerPortal, { descriptor: drawer }) : null
  );
});

const ModalPortal = memo(function ModalPortal({ descriptor }) {
  const descriptorRef = useRef(descriptor);
  descriptorRef.current = descriptor;
  return h(OverlayFrame, {
    open: true,
    size: descriptor.size,
    onOpenChange: next => {
      if (next) return;
      const current = descriptorRef.current;
      if (current.confirmation) current.confirmation.onCancel?.();
      else if (current.dismissEnabled) void current.onDismiss?.();
    },
    backdropProps: { id: '__relai-modal-backdrop', 'data-react-overlay': 'modal' },
    contentProps: {
      'aria-describedby': descriptor.description ? '__relai-modal-desc' : undefined,
      onEscapeKeyDown: event => {
        if (descriptor.confirmation || !descriptor.dismissEnabled) event.preventDefault();
      },
      onPointerDownOutside: event => {
        if (descriptor.confirmation || !descriptor.dismissEnabled) event.preventDefault();
      },
      onCloseAutoFocus: event => {
        event.preventDefault();
        if (descriptor.opener instanceof HTMLElement && descriptor.opener.isConnected) descriptor.opener.focus({ preventScroll: true });
        else document.getElementById('pageTitle')?.focus({ preventScroll: true });
      }
    }
  },
    h('header', { className: 'modal-head', inert: descriptor.confirmation ? true : undefined },
      h(Dialog.Title, { asChild: true }, h('h2', { className: 'modal-title' }, descriptor.title)),
      h(Dialog.Description, { id: '__relai-modal-desc', className: 'sr-only' }, descriptor.description || descriptor.title || 'Dialog'),
      descriptor.showClose ? h('button', {
        type: 'button',
        className: 'modal-close',
        'aria-label': descriptor.title ? `Close ${descriptor.title}` : 'Close dialog',
        onClick: () => { void descriptor.onDismiss?.(); }
      }, h(CloseIcon)) : null
    ),
    h('div', { className: 'modal-body', inert: descriptor.confirmation ? true : undefined }, h(OverlayContent, { content: descriptor.content })),
    descriptor.confirmation ? h(ModalConfirmation, { confirmation: descriptor.confirmation }) : null
  );
});

function OverlayContent({ content }) {
  if (content?.kind !== 'confirm-dialog') return content;
  return h('div', { className: 'confirm-dialog' },
    h('div', { className: 'confirm-dialog-copy' },
      h('strong', null, content.message),
      content.detail ? h('span', null, content.detail) : null
    ),
    h('div', { className: 'modal-actions' },
      h('button', {
        type: 'button',
        className: 'secondary',
        autoFocus: content.danger,
        onClick: content.onCancel
      }, content.cancelLabel),
      h('button', {
        type: 'button',
        className: content.danger ? 'danger' : 'primary',
        autoFocus: !content.danger,
        onClick: content.onConfirm
      }, content.confirmLabel)
    )
  );
}

function ModalConfirmation({ confirmation }) {
  const focusRef = useRef(null);
  return h(AlertDialog.Root, {
    open: true,
    onOpenChange: next => { if (!next) confirmation.onCancel?.(); }
  }, h('div', { className: 'modal-inline-confirm-layer' },
    h(AlertDialog.Content, {
      asChild: true,
      onOpenAutoFocus: event => {
        event.preventDefault();
        queueMicrotask(() => focusRef.current?.focus({ preventScroll: true }));
      }
    }, h('section', { className: 'modal-inline-confirm-card' },
      h(AlertDialog.Title, { asChild: true },
        h('h3', { className: 'modal-inline-confirm-title' }, confirmation.title)
      ),
      h(AlertDialog.Description, { asChild: true },
        h('div', { className: 'confirm-dialog-copy' },
          h('strong', null, confirmation.message),
          confirmation.detail ? h('span', null, confirmation.detail) : null
        )
      ),
      h('div', { className: 'modal-actions' },
        h(AlertDialog.Cancel, { asChild: true },
          h('button', {
            type: 'button',
            className: 'secondary',
            ref: confirmation.danger ? focusRef : undefined
          }, confirmation.cancelLabel)
        ),
        h(AlertDialog.Action, { asChild: true },
          h('button', {
            type: 'button',
            className: confirmation.danger ? 'danger' : 'primary',
            onClick: confirmation.onConfirm,
            ref: confirmation.danger ? undefined : focusRef
          }, confirmation.confirmLabel)
        )
      )
    ))
  ));
}

const DrawerPortal = memo(function DrawerPortal({ descriptor }) {
  return h(OverlayFrame, {
    open: true,
    kind: 'drawer',
    className: descriptor.panelClass,
    onOpenChange: next => { if (!next) descriptor.onDismiss?.(); },
    backdropProps: { id: '__relai-drawer-backdrop', 'data-react-overlay': 'drawer' },
    contentProps: {
      'aria-describedby': descriptor.description ? '__relai-drawer-desc' : undefined,
      onCloseAutoFocus: event => {
        event.preventDefault();
        if (descriptor.opener instanceof HTMLElement && descriptor.opener.isConnected) descriptor.opener.focus({ preventScroll: true });
        else document.getElementById('pageTitle')?.focus({ preventScroll: true });
      }
    }
  },
    h('div', { className: 'drawer-head' },
      h(Dialog.Title, { asChild: true }, h('h2', { className: 'drawer-title' }, descriptor.title)),
      h(Dialog.Description, { id: '__relai-drawer-desc', className: 'sr-only' }, descriptor.description || descriptor.title || 'Drawer navigation'),
      h('button', {
        className: 'secondary compact-button',
        type: 'button',
        'aria-label': descriptor.title ? `Close ${descriptor.title}` : 'Close dialog',
        onClick: descriptor.onDismiss
      }, 'Close')
    ),
    h('div', { className: 'drawer-body' }, descriptor.content)
  );
});

function CloseIcon() {
  return h(Icon, { name: 'close' });
}

const ToastRegion = memo(function ToastRegion({ toasts }) {
  return createPortal(h('div', {
    className: 'toast-region',
    role: 'region',
    'aria-label': 'Notifications',
    'aria-live': 'polite',
    'data-react-toast-region': 'true'
  },
    toasts.map(toast => h(ToastItem, { key: toast.id, toast }))
  ), document.body);
});

function ToastItem({ toast }) {
  const timerRef = useRef(null);
  const startedAtRef = useRef(0);
  const remainingRef = useRef(Math.max(0, Number(toast.duration || 0)));
  const pausedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    startedAtRef.current = 0;
  }, []);
  const schedule = useCallback(() => {
    clearTimer();
    if (pausedRef.current || remainingRef.current <= 0) return;
    startedAtRef.current = Date.now();
    timerRef.current = window.setTimeout(() => removeToastOverlay(toast.id), remainingRef.current);
  }, [clearTimer, toast.id]);
  const pause = () => {
    if (pausedRef.current) return;
    pausedRef.current = true;
    if (timerRef.current && startedAtRef.current) {
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAtRef.current));
    }
    clearTimer();
  };
  const resume = () => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    schedule();
  };

  useEffect(() => {
    remainingRef.current = Math.max(0, Number(toast.duration || 0));
    pausedRef.current = false;
    schedule();
    return clearTimer;
  }, [clearTimer, schedule, toast.duration, toast.id, toast.revision]);

  return h('div', {
    className: `toast toast-${toast.tone}`,
    'data-react-toast-id': toast.id,
    onMouseEnter: pause,
    onMouseLeave: resume,
    onFocus: pause,
    onBlur: event => { if (!event.currentTarget.contains(event.relatedTarget)) resume(); }
  },
    h('span', { className: 'toast-marker', 'aria-hidden': 'true' }, h(Icon, { name: toast.icon || 'info', size: 14 })),
    h('span', {
      className: 'toast-copy',
      role: toast.role,
      'aria-atomic': 'true',
      'aria-label': toast.ariaLabel
    }, toast.text),
    h('button', {
      type: 'button',
      className: 'toast-dismiss',
      'aria-label': toast.dismissLabel,
      onClick: () => removeToastOverlay(toast.id)
    }, h(CloseIcon))
  );
}

function debugError(error) {
  if (window.localStorage?.getItem('relai_debug') === '1') console.error(error);
}

export { buildCommands, commandMatchesQuery, normalizeSearch, rankCommands, DesktopSidebar };
