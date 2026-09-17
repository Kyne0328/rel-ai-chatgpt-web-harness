import '../styles/app.css';
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
import { HashRouter, useLocation } from 'react-router-dom';
import { Icon } from '../components/icons.js';
import { connectionLayerViews, connectionSummary } from '../connection-state.js';
import { classifyTaskActivity } from '../../taskActivityPresentation.js';
import {
  APPLICATION_NAV_ITEMS,
  MOBILE_MORE_NAV_ITEMS,
  MOBILE_PRIMARY_NAV_ITEMS,
  SETTINGS_NAV_ITEMS,
  SYSTEM_NAV_ITEMS,
  WORK_NAV_ITEMS,
  desktopNavigationOwner,
  navigationCommands,
  routeMetadata
} from '../navigation-catalog.js';
import { getOverlaySnapshot, removeToastOverlay, subscribeOverlay } from '../overlay-store.js';
import { normalizeRouteKey } from '../route-policy.js';
export { initConnectorRefreshModal } from '../connector-refresh-modal.js';
export { initUpdateAvailableModal } from '../update-available-modal.js';
export { applyLiveEvent, getSnapshot, init, patchLocalConnection, subscribe } from '../store.js';

const h = React.createElement;
const DashboardStoreContext = createContext(null);
const reactRouteComponents = new Map();
const reactRoutePreloads = new Map();
const uiListeners = new Set();
let foundationRoot = null;
let foundationOptions = {};
let sequence = 0;
let uiSnapshot = Object.freeze({
  connectionOverride: null,
  lastEventAt: 0,
  now: Date.now(),
  recovery: null,
  routeState: null
});

function useDashboardStore() {
  const store = useContext(DashboardStoreContext);
  if (!store) throw new Error('React dashboard components must render inside the dashboard store provider.');
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
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
registerReactSection('settings', createLazyRoute(() => import('../features/settings/react.js'), 'createSettingsRoute', useDashboardStore, 'settings'));
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
  const load = reactRoutePreloads.get(section);
  if (load) return Promise.allSettled([load()]);
  return Promise.allSettled([]);
}

export function preloadReactRoute(section) {
  return preloadReactRoutes(section);
}

export function mountReactFoundation(element, store, options = {}) {
  if (!element || !validStore(store)) return null;
  foundationOptions = { ...options };
  foundationRoot ||= createRoot(element);
  flushSync(() => {
    foundationRoot.render(h(
      DashboardStoreContext.Provider,
      { value: store },
      h(HashRouter, null, h(DashboardShell, foundationOptions))
    ));
  });
  return foundationRoot;
}

export function setShellNow(now) {
  const value = Number(now);
  updateUi({ now: Number.isFinite(value) ? value : Date.now() });
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
  const routerLocation = useLocation();
  return useMemo(() => {
    const pathname = String(routerLocation.pathname || '').replace(/^\/+/, '') || 'home';
    const routeKey = normalizeRouteKey(`${pathname}${routerLocation.search || ''}`);
    const path = routeKey.split('?')[0] || 'home';
    const section = path.split('/')[0] || 'home';
    const metadata = routeMetadata(path);
    const title = path === 'settings' || path.startsWith('settings/')
      ? `Settings · ${metadata.label}`
      : metadata.label;
    return Object.freeze({
      announcement: `${title} page loaded.`,
      description: metadata.description,
      key: routeKey,
      owner: desktopNavigationOwner(section),
      path,
      section,
      title
    });
  }, [routerLocation.pathname, routerLocation.search]);
}

function DashboardShell({ desktop = null, onAddWorkspace = null } = {}) {
  const data = useDashboardStore();
  const ui = useSyncExternalStore(subscribeUi, () => uiSnapshot, () => uiSnapshot);
  const overlays = useSyncExternalStore(subscribeOverlay, getOverlaySnapshot, getOverlaySnapshot);
  const route = useRoutePresentation();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => document.documentElement.dataset.sidebar === 'collapsed');
  const [openAccordion, setOpenAccordion] = useState(() => (
    route.owner === 'system' || route.owner === 'settings' ? route.owner : ''
  ));
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteOpener = useRef(null);
  const previousRouteKey = useRef(route.key);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  useEffect(() => {
    document.title = `${route.title} · Rel.AI MCP`;
    if (route.owner === 'system' || route.owner === 'settings') setOpenAccordion(route.owner);
    setMobileMoreOpen(false);
  }, [route.owner, route.path, route.title]);

  useEffect(() => {
    const shouldFocusHeading = previousRouteKey.current !== route.key;
    previousRouteKey.current = route.key;
    if (shouldFocusHeading) document.getElementById('pageTitle')?.focus({ preventScroll: true });
    window.dispatchEvent(new CustomEvent('relai:route-mounted', {
      detail: { section: route.section, path: route.path, params: new URLSearchParams(route.key.split('?')[1] || '') }
    }));
  }, [route.key, route.path, route.section]);

  useEffect(() => {
    const onKeyDown = event => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      if (document.querySelector('#__relai-modal-backdrop, #__relai-drawer-backdrop')) return;
      paletteOpener.current = document.activeElement;
      setPaletteOpen(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
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
  const lastUpdated = lastUpdatedText(ui.lastEventAt, ui.now);
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘ K' : 'Ctrl K';
  const revisionKey = JSON.stringify(data?.live?.revisions || {});

  return h(React.Fragment, null,
    h(WindowTitlebar, { desktop, title: route.title }),
    h('a', { href: '#main', className: 'skip-link' }, 'Skip to content'),
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
        openAccordion,
        route,
        setOpenAccordion,
        toggleSidebar
      }),
      h('main', { id: 'main', className: 'main', tabIndex: -1, 'aria-labelledby': 'pageTitle' },
        h(MobileNavigation, { open: mobileMoreOpen, route, setOpen: setMobileMoreOpen }),
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
              'aria-expanded': paletteOpen ? 'true' : 'false',
              title: 'Open quick navigation',
              onClick: openPalette
            },
              h(Icon, { name: 'search' }),
              h('span', { className: 'command-trigger-label' }, 'Quick navigation'),
              h('kbd', null, shortcut)
            ),
            h('a', {
              className: `status-pill ${connection.tone} connection-status-link`,
              id: 'connectionStatus',
              href: '#settings/connection',
              'aria-label': `Open Connection settings; current status ${connection.label}`
            }, connection.label),
            h('span', { className: 'section-action', id: 'lastUpdated' }, lastUpdated)
          )
        ),
        h(RecoveryNotice, { recovery: ui.recovery }),
        h(RouteOutlet, { route, routeState: ui.routeState })
      )
    ),
    h(CommandPalette, {
      data,
      onAddWorkspace,
      onClose: closePalette,
      open: paletteOpen,
      opener: paletteOpener.current
    }),
    h(OverlayHost, { drawer: overlays.drawer, modal: overlays.modal }),
    h(ToastRegion, { toasts: overlays.toasts })
  );
}

function DesktopSidebar({ collapsed, openAccordion, route, setOpenAccordion, toggleSidebar }) {
  const surface = document.documentElement.dataset.surface || 'browser';
  return h('aside', { className: 'sidebar', id: 'desktopSidebar' },
    h('div', { className: 'brand' },
      h('div', { className: 'brand-identity' },
        h('div', { className: 'logo' },
          h('img', { src: '/public/assets/relai-logo.png', alt: 'Rel.AI logo', width: 193, height: 187 })
        ),
        h('div', { className: 'brand-copy' }, h('strong', null, 'Rel.AI MCP'), h('span', null, 'project access'))
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
    h('div', { className: 'sidebar-group' },
      h('div', { className: 'sidebar-group-label' }, 'Work'),
      h('nav', { className: 'nav', 'aria-label': 'Work navigation' },
        WORK_NAV_ITEMS.map(item => h(NavLink, { key: item.id, item, active: route.owner === item.id }))
      )
    ),
    h('div', { className: 'sidebar-group secondary-nav' },
      h('div', { className: 'sidebar-group-label' }, 'Application'),
      h(SidebarAccordion, {
        parent: APPLICATION_NAV_ITEMS[0],
        items: SYSTEM_NAV_ITEMS,
        activeOwner: route.owner,
        activePath: route.path,
        openAccordion,
        setOpenAccordion
      }),
      h(SidebarAccordion, {
        parent: APPLICATION_NAV_ITEMS[1],
        items: SETTINGS_NAV_ITEMS,
        activeOwner: route.owner,
        activePath: route.path,
        openAccordion,
        setOpenAccordion
      })
    ),
    h('div', { className: 'sidebar-note' }, surface === 'desktop' ? 'Desktop app · live status' : 'Live status from this computer.')
  );
}

function SidebarAccordion({ parent, items, activeOwner, activePath, openAccordion, setOpenAccordion }) {
  const active = activeOwner === parent.id;
  const open = openAccordion === parent.id;
  return h('details', {
    className: 'sidebar-accordion',
    'data-nav-accordion': parent.id,
    open,
    onToggle: event => {
      const isOpen = event.currentTarget.open;
      setOpenAccordion(current => isOpen ? parent.id : (current === parent.id ? '' : current));
    }
  },
    h('summary', {
      className: active ? 'active' : undefined,
      'aria-label': parent.label,
      title: parent.label
    },
      h(NavIcon, { item: parent }),
      h('span', { className: 'nav-label' }, parent.label),
      h(Icon, { className: 'sidebar-accordion-chevron', name: 'chevronRight' })
    ),
    h('nav', { className: 'sidebar-subnav', 'aria-label': `${parent.label} navigation` },
      items.map(item => h(NavLink, { key: item.id, item, active: item.path === activePath }))
    )
  );
}

function MobileNavigation({ open, route, setOpen }) {
  const detailsRef = useRef(null);
  const moreActive = MOBILE_MORE_NAV_ITEMS.some(item => item.id === route.owner);
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
      active: route.owner === item.id,
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
        MOBILE_MORE_NAV_ITEMS.map(item => h(NavLink, {
          key: item.id,
          item,
          active: route.owner === item.id,
          onClick: () => setOpen(false)
        }))
      )
    )
  );
}

function NavLink({ item, active, onClick }) {
  return h('a', {
    href: item.href,
    'data-nav-id': item.id,
    'aria-label': item.label,
    'aria-current': active ? 'page' : undefined,
    title: item.label,
    className: active ? 'active' : undefined,
    onClick
  }, h(NavIcon, { item }), h('span', { className: 'nav-label' }, item.label));
}

function NavIcon({ item }) {
  return h(Icon, { className: 'nav-icon', name: item.icon });
}

function WindowTitlebar({ desktop, title }) {
  const [state, setState] = useState(() => normalizeWindowState({
    platform: document.documentElement.dataset.platform || 'other',
    customTitleBar: document.documentElement.dataset.windowChrome === 'custom',
    controls: document.documentElement.dataset.windowChrome === 'custom' ? 'custom' : 'native',
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
      h('strong', null, 'Rel.AI MCP'),
      h('span', { id: 'windowContext' }, title)
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
  return h('div', {
    className: 'dashboard-state',
    role: loading ? 'status' : 'alert',
    'aria-live': loading ? 'polite' : undefined,
    'aria-busy': loading ? 'true' : undefined
  }, h('div', { className: 'dashboard-state-card' },
    loading ? h('div', { className: 'loading-mark', 'aria-hidden': 'true' }) : h(StatusPill, { label: 'Connection error', tone: 'bad' }),
    h('h2', null, title),
    h('p', null, description),
    loading ? h('div', { className: 'skeleton-grid', 'aria-hidden': 'true' },
      h('div', { className: 'skeleton-block' }),
      h('div', { className: 'skeleton-block' }),
      h('div', { className: 'skeleton-block' })
    ) : h('div', { className: 'dashboard-state-actions' },
      onPrimary ? h('button', { className: 'primary', type: 'button', disabled: Boolean(busy), onClick: () => { void run('primary', onPrimary); } }, busy === 'primary' ? primaryBusyLabel : primaryLabel) : null,
      onSecondary ? h('button', { className: 'secondary', type: 'button', disabled: Boolean(busy), onClick: () => { void run('secondary', onSecondary); } }, busy === 'secondary' ? secondaryBusyLabel : secondaryLabel) : null,
      diagnosticsHref ? h('a', { className: 'buttonlike secondary', href: diagnosticsHref }, 'Open Troubleshooting') : null
    )
  ));
}

function StatusPill({ label, tone = '' }) {
  return h('span', { className: `status-pill ${tone}`.trim() }, label);
}

function connectionPresentation(data = {}) {
  if (data?.ok === false) return { label: 'Error', tone: 'bad' };
  const connection = connectionSummary(data?.connectionState);
  if (connection.tone !== 'ok') return { label: connection.label, tone: connection.tone };
  const task = classifyTaskActivity(data?.taskActivity);
  if (task.category === 'attention') return { label: 'Action required', tone: 'bad' };
  if (task.category === 'working') return { label: `${Math.max(1, task.taskCount)} running`, tone: 'working' };
  if (task.category === 'waiting') return { label: `${Math.max(1, task.taskCount)} open`, tone: 'warn' };
  const dashboardLayer = connectionLayerViews(data?.connectionState).find(layer => layer.key === 'dashboardUpdates');
  if (dashboardLayer) return { label: dashboardLayer.label, tone: dashboardLayer.tone };
  return { label: 'Available', tone: 'ok', callCount: task.activeCalls };
}

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

function CommandPalette({ data, onAddWorkspace, onClose, open, opener }) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const commands = useMemo(() => buildCommands(data, onAddWorkspace, onClose), [data?.config?.workspaces, onAddWorkspace, onClose]);
  const visible = useMemo(() => {
    const normalized = normalizeSearch(query);
    return commands.filter(command => !normalized || command.searchText.includes(normalized)).slice(0, 14);
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

  const execute = command => {
    if (!command) return;
    Promise.resolve(command.run()).catch(debugError);
  };
  const activeId = visible.length ? `command-option-${safeIndex}` : undefined;
  return h(Dialog.Root, {
    open,
    onOpenChange: next => { if (!next) onClose(); }
  }, h(Dialog.Portal, null,
    h(Dialog.Overlay, { asChild: true },
      h('div', { id: '__relai-modal-backdrop', className: 'overlay-backdrop modal-backdrop' },
        h(Dialog.Content, {
          asChild: true,
          onOpenAutoFocus: event => {
            event.preventDefault();
            queueMicrotask(() => inputRef.current?.focus({ preventScroll: true }));
          },
          onCloseAutoFocus: event => {
            event.preventDefault();
            if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
          }
        }, h('div', { className: 'modal-panel modal-wide command-panel' },
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
              h('div', { className: 'command-list', id: 'commandPaletteList', role: 'listbox', 'aria-label': 'Quick navigation results' },
                visible.length
                  ? visible.map((command, index) => h('div', {
                      className: `command-option${index === safeIndex ? ' active' : ''}`,
                      id: `command-option-${index}`,
                      key: command.id,
                      role: 'option',
                      'aria-selected': index === safeIndex ? 'true' : 'false',
                      'data-command-index': String(index),
                      onMouseEnter: () => { if (index !== safeIndex) setActiveIndex(index); },
                      onClick: () => execute(command),
                      onTouchStart: () => { if (index !== safeIndex) setActiveIndex(index); }
                    },
                    h('span', { className: 'command-option-copy' }, h('strong', null, command.label), h('small', null, command.description)),
                    h('span', { className: 'command-group' }, command.group)
                  ))
                  : h('div', { className: 'command-empty' }, 'No matching page, action, or project.')
              )
            )
          )
        ))
      )
    )
  ));
}

function buildCommands(data, onAddWorkspace, closePalette) {
  const commands = navigationCommands().map(item => ({
    id: item.path.replaceAll('/', '-'),
    label: item.group === 'Settings' ? `Settings · ${item.label}` : item.label,
    description: item.description,
    group: item.group,
    href: item.href,
    run: () => { closePalette(); location.hash = item.href; }
  }));
  if (typeof onAddWorkspace === 'function') {
    commands.push({
      id: 'add-workspace',
      label: 'Add project',
      description: 'Choose another project folder for ChatGPT.',
      group: 'Action',
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
      href,
      run: () => { closePalette(); location.hash = href; }
    });
  }
  return commands.map(command => ({
    ...command,
    searchText: normalizeSearch([command.label, command.description, command.group].join(' '))
  }));
}

function normalizeSearch(value) {
  return String(value || '').trim().toLowerCase();
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
  return h(Dialog.Root, {
    open: true,
    onOpenChange: next => {
      if (next) return;
      const current = descriptorRef.current;
      if (current.confirmation) current.confirmation.onCancel?.();
      else if (current.dismissEnabled) void current.onDismiss?.();
    }
  }, h(Dialog.Portal, null,
    h(Dialog.Overlay, { asChild: true },
      h('div', {
        id: '__relai-modal-backdrop',
        className: 'overlay-backdrop modal-backdrop',
        'data-react-overlay': 'modal'
      }, h(Dialog.Content, {
        asChild: true,
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
      }, h('div', { className: `modal-panel modal-${descriptor.size}` },
        h('header', { className: 'modal-head', inert: descriptor.confirmation ? true : undefined },
          h(Dialog.Title, { asChild: true }, h('h2', { className: 'modal-title' }, descriptor.title)),
          descriptor.showClose ? h('button', {
            type: 'button',
            className: 'modal-close',
            'aria-label': descriptor.title ? `Close ${descriptor.title}` : 'Close dialog',
            onClick: () => { void descriptor.onDismiss?.(); }
          }, h(CloseIcon)) : null
        ),
        h('div', { className: 'modal-body', inert: descriptor.confirmation ? true : undefined }, h(OverlayContent, { content: descriptor.content })),
        descriptor.confirmation ? h(ModalConfirmation, { confirmation: descriptor.confirmation }) : null
      )))
    )
  ));
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
  return h(Dialog.Root, {
    open: true,
    onOpenChange: next => { if (!next) descriptor.onDismiss?.(); }
  }, h(Dialog.Portal, null,
    h(Dialog.Overlay, { asChild: true },
      h('div', {
        id: '__relai-drawer-backdrop',
        className: 'overlay-backdrop drawer-backdrop',
        'data-react-overlay': 'drawer'
      }, h(Dialog.Content, {
        asChild: true,
        onCloseAutoFocus: event => {
          event.preventDefault();
          if (descriptor.opener instanceof HTMLElement && descriptor.opener.isConnected) descriptor.opener.focus({ preventScroll: true });
          else document.getElementById('pageTitle')?.focus({ preventScroll: true });
        }
      }, h('div', { className: ['drawer-panel', descriptor.panelClass].filter(Boolean).join(' ') },
        h('div', { className: 'drawer-head' },
          h(Dialog.Title, { asChild: true }, h('h2', { className: 'drawer-title' }, descriptor.title)),
          h('button', {
            className: 'secondary compact-button',
            type: 'button',
            'aria-label': descriptor.title ? `Close ${descriptor.title}` : 'Close dialog',
            onClick: descriptor.onDismiss
          }, 'Close')
        ),
        h('div', { className: 'drawer-body' }, descriptor.content)
      )))
    )
  ));
});

function CloseIcon() {
  return h(Icon, { name: 'close' });
}

const ToastRegion = memo(function ToastRegion({ toasts }) {
  if (!toasts.length) return null;
  return createPortal(h('div', { className: 'toast-region', 'data-react-toast-region': 'true' },
    toasts.map(toast => h(ToastItem, { key: toast.id, toast }))
  ), document.body);
});

function ToastItem({ toast }) {
  const timerRef = useRef(null);
  const startedAtRef = useRef(0);
  const remainingRef = useRef(Math.max(0, Number(toast.duration || 0)));
  const pausedRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    startedAtRef.current = 0;
  };
  const schedule = () => {
    clearTimer();
    if (pausedRef.current || remainingRef.current <= 0) return;
    startedAtRef.current = Date.now();
    timerRef.current = window.setTimeout(() => removeToastOverlay(toast.id), remainingRef.current);
  };
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
  }, [toast.duration, toast.id, toast.revision]);

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
