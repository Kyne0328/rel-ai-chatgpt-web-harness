import React, { useCallback, useEffect, useRef, useState } from 'react';
import './styles.css';
import { fetchJson } from '../../api.js';
import { Icon } from '../../components/icons.js';
import { StatusPill } from '../../components/pill.js';
import { clipBrowserSurfaceBounds, releaseBrowserRouteControl } from './behavior.js';

const h = React.createElement;

function createBrowserRoute() {
  return function BrowserRoute() {
    const browser = window.relaiDesktop?.browser;
    const [state, setState] = useState(() => emptyState(Boolean(browser)));
    const [error, setError] = useState('');
    const [busy, setBusy] = useState('');
    const [copyStatus, setCopyStatus] = useState('');
    const [notice, setNotice] = useState('');
    const surfaceRef = useRef(null);
    const frameRef = useRef(0);
    const handoffRef = useRef('');
    handoffRef.current = String(state.handoffReason || '');

    const syncBounds = useCallback(() => {
      if (typeof browser?.setBounds !== 'function') return;
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = 0;
        const element = surfaceRef.current;
        if (!element || !state.active) {
          void Promise.resolve(browser.setBounds({ visible: false })).catch(() => {});
          return;
        }
        const bounds = clipBrowserSurfaceBounds(
          element.getBoundingClientRect(),
          window.innerWidth,
          window.innerHeight
        );
        if (!bounds.visible) {
          void Promise.resolve(browser.setBounds(bounds)).catch(() => {});
          return;
        }
        void Promise.resolve(browser.setBounds(bounds)).catch(nextError => setError(errorMessage(nextError)));
      });
    }, [browser, state.active]);

    useEffect(() => {
      if (!browser) return undefined;
      let active = true;
      const apply = next => {
        if (!active || !next || typeof next !== 'object') return;
        setState(current => ({ ...current, ...next, available: next.available !== false }));
      };
      const unsubscribe = typeof browser.onState === 'function' ? browser.onState(apply) : null;
      Promise.resolve(browser.getState?.()).then(apply).catch(nextError => {
        if (active) setError(errorMessage(nextError));
      });
      return () => {
        active = false;
        if (typeof unsubscribe === 'function') unsubscribe();
      };
    }, [browser]);

    useEffect(() => {
      if (!browser || typeof browser.setControl !== 'function') return undefined;
      return () => {
        if (!handoffRef.current) void releaseBrowserRouteControl(browser);
      };
    }, [browser]);

    useEffect(() => {
      if (!browser || !state.active) {
        if (browser) void Promise.resolve(browser.setBounds({ visible: false })).catch(() => {});
        return undefined;
      }
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(syncBounds) : null;
      if (surfaceRef.current) observer?.observe(surfaceRef.current);
      const schedule = () => syncBounds();
      window.addEventListener('resize', schedule);
      window.addEventListener('scroll', schedule, true);
      syncBounds();
      return () => {
        observer?.disconnect();
        window.removeEventListener('resize', schedule);
        window.removeEventListener('scroll', schedule, true);
        if (frameRef.current) cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
        void Promise.resolve(browser.setBounds({ visible: false })).catch(() => {});
      };
    }, [browser, state.active, syncBounds]);

    const tabListRef = useRef(null);
    const activeTabRef = useRef(null);
    useEffect(() => {
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
      activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
    }, [state.nativePageId, state.tabs?.length]);

    useEffect(() => {
      setCopyStatus('');
    }, [state.url]);

    useEffect(() => {
      if (!copyStatus) return undefined;
      const timer = window.setTimeout(() => setCopyStatus(''), 1200);
      return () => window.clearTimeout(timer);
    }, [copyStatus]);

    const run = async (key, action) => {
      if (busy === key || typeof action !== 'function') return;
      setBusy(key);
      setError('');
      setNotice('');
      try {
        const next = await action();
        if (next && typeof next === 'object') setState(current => ({ ...current, ...next }));
      } catch (nextError) {
        setError(errorMessage(nextError));
      } finally {
        setBusy(current => (current === key ? '' : current));
      }
    };

    const focusTab = useCallback(index => {
      const list = tabListRef.current;
      const buttons = list ? [...list.querySelectorAll('.browser-tab-select')] : [];
      const target = buttons[index];
      if (target) target.focus();
    }, []);

    const onTabListKeyDown = useCallback(event => {
      const list = tabListRef.current;
      if (!list) return;
      const buttons = [...list.querySelectorAll('.browser-tab-select')];
      const currentIndex = buttons.indexOf(document.activeElement);
      if (currentIndex < 0) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        focusTab((currentIndex + 1) % buttons.length);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        focusTab((currentIndex - 1 + buttons.length) % buttons.length);
      } else if (event.key === 'Home') {
        event.preventDefault();
        focusTab(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        focusTab(buttons.length - 1);
      }
    }, [focusTab]);

    if (!browser) return h(RemoteBrowserPreview);

    if (!state.active) {
      return h('section', { className: 'section browser-route' },
        h('div', { className: 'browser-empty card' },
          h(Icon, { name: 'browser', className: 'browser-empty-icon', size: 28 }),
          h('h2', null, 'No local browser session'),
          h('p', null, 'A live page appears here when ChatGPT starts a browser task. Sign-ins are remembered unless ChatGPT explicitly starts a private session.')
        ),
        notice ? h('div', { className: 'connection-notice good', role: 'status' }, notice) : null,
        error ? h('div', { className: 'connection-notice bad', role: 'alert' }, error) : null
      );
    }

    const userControl = state.control === 'user';
    const handoffReason = String(state.handoffReason || '');
    const permissions = Array.isArray(state.permissionRequests) ? state.permissionRequests : [];
    const permissionRequest = permissions[0] || null;
    const profile = state.profile === 'ephemeral' ? 'ephemeral' : 'persistent';
    const sessions = Array.isArray(state.sessions) ? state.sessions : [];
    const tabs = Array.isArray(state.tabs) ? state.tabs : [];
    const activeIndex = Math.max(0, tabs.findIndex(tab => tab?.active === true || String(tab?.nativePageId || '') === state.nativePageId));
    const pageHost = hostOf(state.url);
    const viewportLabel = formatViewport(state.viewport);
    return h('section', { className: 'section browser-route', 'data-browser-control': userControl ? 'user' : 'ai' },
      userControl ? h('div', { className: 'browser-takeover-banner', role: 'status' },
        h(Icon, { name: 'warning', size: 16 }),
        h('span', null,
          handoffReason
            ? `${handoffTitle(handoffReason)} Complete this step in the local browser. Enter passwords and verification codes here, not in ChatGPT. When finished, confirm in ChatGPT.`
            : 'Manual control is active. Return control to resume AI interaction.'
        ),
        handoffReason ? null : h('button', { className: 'secondary compact-button', type: 'button', disabled: busy === 'control' || busy === 'stop', onClick: () => { void run('control', () => browser.setControl('ai')); } }, busy === 'control' ? 'Returning…' : 'Return to AI')
      ) : null,
      permissionRequest ? h('div', { className: 'browser-permission-banner', role: 'region', 'aria-label': 'Site permission request' },
        h(Icon, { name: 'warning', size: 16 }),
        h('span', null, `${permissionRequest.origin || 'This site'} wants permission to use ${permissionLabel(permissionRequest.permission)}.`),
        h('div', { className: 'browser-permission-actions' },
          h('button', { className: 'secondary compact-button', type: 'button', disabled: busy === `permission:${permissionRequest.requestId}`, onClick: () => { void run(`permission:${permissionRequest.requestId}`, () => browser.respondPermission(permissionRequest.requestId, false)); } }, 'Deny'),
          h('button', { className: 'primary compact-button', type: 'button', disabled: busy === `permission:${permissionRequest.requestId}`, onClick: () => { void run(`permission:${permissionRequest.requestId}`, () => browser.respondPermission(permissionRequest.requestId, true)); } }, 'Allow for this session')
        )
      ) : null,
      h('div', { className: 'browser-chrome card' },
        sessions.length > 1
          ? h('div', { className: 'browser-sessions' },
              h('div', { className: 'browser-tabs-label' },
                h('span', { className: 'browser-count-badge', 'aria-hidden': 'true' }, String(sessions.length)),
                h('span', null, sessions.length === 1 ? 'session' : 'sessions')
              ),
              h('div', { className: 'browser-session-list', role: 'list', 'aria-label': 'Open browser sessions' },
                sessions.map((session, index) => {
                  const nativeSessionId = String(session?.nativeSessionId || '');
                  const activeSession = session?.active === true || nativeSessionId === state.nativeSessionId;
                  const label = sessionLabel(session, index);
                  const pending = busy === `session:${nativeSessionId}`;
                  return h('button', {
                    className: `browser-session-select${activeSession ? ' active' : ''}${pending ? ' pending' : ''}`,
                    type: 'button',
                    key: nativeSessionId || `${index}`,
                    disabled: pending || !nativeSessionId || (userControl && !activeSession),
                    'aria-current': activeSession ? 'page' : undefined,
                    'aria-label': `Show ${label}`,
                    title: session?.url ? `${label}\n${session.url}` : label,
                    onClick: () => { void run(`session:${nativeSessionId}`, () => browser.selectSession(nativeSessionId)); }
                  },
                    h('span', { className: 'browser-session-dot', 'aria-hidden': 'true' }),
                    h('span', { className: 'browser-session-name' }, label),
                    pending ? h('span', { className: 'browser-spinner', 'aria-hidden': 'true' }) : null
                  );
                })
              )
            )
          : null,
        h('div', { className: 'browser-tabbar' },
          h('div', { className: 'browser-tabs', 'aria-label': `${tabs.length} open ${tabs.length === 1 ? 'tab' : 'tabs'}` },
            tabs.length
              ? h('div', {
                  className: 'browser-tab-list',
                  role: 'tablist',
                  ref: tabListRef,
                  'aria-label': 'Open browser tabs',
                  onKeyDown: onTabListKeyDown
                },
                  tabs.map((tab, index) => {
                    const label = tabLabel(tab, index);
                    const nativePageId = String(tab?.nativePageId || '');
                    const activeTab = tab?.active === true || nativePageId === state.nativePageId;
                    const pendingSelect = busy === `tab:${nativePageId}`;
                    const pendingClose = busy === `close-tab:${nativePageId}`;
                    const tabBusy = pendingSelect || pendingClose;
                    const fullTitle = tab?.url && tab.url !== label ? `${label}\n${tab.url}` : (tab?.url || label);
                    return h('div', {
                      className: `browser-tab-item${activeTab ? ' active' : ''}${tab?.loading || pendingSelect ? ' loading' : ''}${tabBusy ? ' pending' : ''}`,
                      key: nativePageId || `${index}`,
                      role: 'presentation',
                      ref: activeTab ? activeTabRef : undefined,
                      'data-browser-tab-active': activeTab ? 'true' : 'false'
                    },
                      h('button', {
                        className: 'browser-tab-select',
                        type: 'button',
                        role: 'tab',
                        disabled: !nativePageId || pendingClose,
                        tabIndex: activeTab ? 0 : (activeIndex === 0 && index === 0 ? 0 : -1),
                        'aria-selected': activeTab ? 'true' : 'false',
                        'aria-label': `${label}${activeTab ? ', active tab' : `, tab ${index + 1} of ${tabs.length}`}${tab?.loading ? ', loading' : ''}`,
                        title: fullTitle,
                        onClick: () => { void run(`tab:${nativePageId}`, () => browser.selectTab(nativePageId)); },
                        onAuxClick: event => {
                          if (event?.button === 1 && nativePageId) {
                            event.preventDefault();
                            void run(`close-tab:${nativePageId}`, () => browser.closeTab(nativePageId));
                          }
                        }
                      },
                        tab?.loading || pendingSelect
                          ? h('span', { className: 'browser-spinner', 'aria-hidden': 'true' })
                          : h('span', { className: 'browser-tab-favicon', 'aria-hidden': 'true' }, faviconLetter(label)),
                        h('span', { className: 'browser-tab-title' }, label),
                        tab?.loading ? h('span', { className: 'browser-tab-loading-dots', 'aria-hidden': 'true' }, '•••') : null
                      ),
                      h('button', {
                        className: 'browser-tab-close',
                        type: 'button',
                        disabled: !nativePageId || tabBusy,
                        tabIndex: activeTab ? 0 : -1,
                        'aria-label': `Close ${label}`,
                        title: `Close ${label} (middle-click also closes)`,
                        onClick: event => {
                          event.stopPropagation();
                          void run(`close-tab:${nativePageId}`, () => browser.closeTab(nativePageId));
                        }
                      }, h(Icon, { name: 'close', size: 13 }))
                    );
                  })
                )
              : h('div', { className: 'browser-tabs-empty', role: 'status' },
                  h(Icon, { name: 'add', size: 14 }),
                  h('span', null, 'No tabs open.')
                )
          ),
          tabs.length > 1
            ? h('div', { className: 'browser-tab-count', title: `${tabs.length} open tabs`, 'aria-hidden': 'true' }, `${activeIndex + 1} / ${tabs.length}`)
            : null
        ),
        h('div', { className: 'browser-toolbar' },
          h('div', { className: 'browser-omnibox' },
            h('span', { className: `browser-secure${pageHost ? ' ok' : ''}`, title: pageHost ? `Site: ${pageHost}` : 'No page loaded', 'aria-hidden': 'true' },
              h(Icon, { name: pageHost ? 'success' : 'browser', size: 14 })
            ),
            h('div', { className: 'browser-page-copy' },
              h('div', { className: 'browser-page-title' }, state.loading ? 'Loading…' : (state.title || 'Local browser session')),
              h('div', { className: 'browser-page-url mono', title: state.url || '' }, state.url ? displayUrl(state.url) : 'about:blank')
            ),
            state.loading ? h('span', { className: 'browser-spinner browser-omnibox-spinner', 'aria-hidden': 'true' }) : null,
            state.url
              ? h('button', {
                  className: `browser-copy-url${copyStatus ? ' copied' : ''}`,
                  type: 'button',
                  'aria-label': copyStatus ? 'Page URL copied' : 'Copy page URL',
                  title: copyStatus ? 'Page URL copied' : 'Copy page URL',
                  onClick: () => {
                    void copyText(state.url).then(copied => {
                      if (copied) setCopyStatus('Page URL copied.');
                      else setError('Could not copy page URL.');
                    });
                  }
                }, h(Icon, { name: 'connection', size: 14 }))
              : null,
            h('span', { className: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, copyStatus)
          ),
          state.loading ? h('div', { className: 'browser-loading-bar', 'aria-hidden': 'true' }, h('i', null)) : null,
          h(StatusPill, { label: userControl ? 'Your control' : 'AI control', tone: userControl ? 'warn' : 'working' }),
          h(StatusPill, { label: profile === 'persistent' ? 'Sign-ins remembered' : 'Private session', tone: profile === 'persistent' ? 'good' : 'neutral' }),
          viewportLabel ? h('span', { className: 'browser-viewport-pill mono', title: 'AI browser viewport' }, viewportLabel) : null,
          h('div', { className: 'browser-toolbar-actions' },
            h('button', {
              className: userControl ? 'primary' : 'secondary',
              type: 'button',
              disabled: busy === 'control' || busy === 'stop',
              onClick: () => { void run('control', () => browser.setControl(userControl ? 'ai' : 'user')); }
            }, busy === 'control' ? 'Changing…' : (userControl ? 'Return to AI' : 'Take control')),
            h('button', {
              className: 'danger',
              type: 'button',
              disabled: busy === 'control' || busy === 'stop',
              'aria-label': 'Stop browser session',
              title: 'Stop browser session',
              onClick: () => { void run('stop', () => browser.stop()); }
            }, busy === 'stop' ? 'Stopping…' : 'Stop')
          )
        )
      ),
      notice ? h('div', { className: 'connection-notice good', role: 'status' }, notice) : null,
      error ? h('div', { className: 'connection-notice bad', role: 'alert' }, error) : null,
      h('div', {
        className: 'browser-surface-slot',
        ref: surfaceRef,
        role: 'region',
        'aria-label': userControl ? 'Live local browser. You have control.' : 'Live local browser. Rel.AI has control. User input is read-only.'
      },
        h('div', { className: 'browser-surface-placeholder', 'aria-hidden': 'true' },
          h(Icon, { name: userControl ? 'play' : 'browser', size: 20, className: 'browser-surface-icon' }),
          h('span', null, userControl ? 'You control this page.' : 'Take control to interact.'),
          h('span', { className: 'browser-surface-sub' }, pageHost ? pageHost : 'Live view renders here')
        )
      )
    );
  };
}

function RemoteBrowserPreview() {
  const [preview, setPreview] = useState({ ok: true, available: true, active: false });
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    let timer = 0;
    const refresh = async () => {
      if (disposed) return;
      if (document.visibilityState === 'hidden') {
        timer = window.setTimeout(refresh, 2500);
        return;
      }
      try {
        const next = await fetchJson('/api/browser/preview', { cache: 'no-store', timeout: 10_000, pauseTimeoutWhenHidden: true });
        if (!disposed) {
          setPreview(next && typeof next === 'object' ? next : { ok: false, available: false, active: false });
          setError(next?.ok === false ? String(next.error || 'Browser preview is unavailable.') : '');
        }
      } catch (nextError) {
        if (!disposed) setError(errorMessage(nextError));
      } finally {
        if (!disposed) timer = window.setTimeout(refresh, 2500);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, []);

  const image = preview?.image;
  const imageSrc = image?.mimeType && image?.data ? `data:${image.mimeType};base64,${image.data}` : '';
  if (!preview?.available) {
    return h('section', { className: 'section browser-route' },
      h('div', { className: 'browser-empty card' },
        h(Icon, { name: 'browser', className: 'browser-empty-icon', size: 28 }),
        h('h2', null, 'Browser preview requires the Rel.AI desktop app.'),
        h('p', null, 'Open this dashboard in the desktop app to view local browser sessions.')
      )
    );
  }
  if (!preview?.active || !imageSrc) {
    return h('section', { className: 'section browser-route' },
      h('div', { className: 'browser-empty card' },
        h(Icon, { name: 'browser', className: 'browser-empty-icon', size: 28 }),
        h('h2', null, 'No local browser session is active.'),
        h('p', null, 'This remote dashboard will show periodic read-only viewport previews when Rel.AI opens a browser session.'),
        error ? h('div', { className: 'connection-notice bad', role: 'alert' }, error) : null
      )
    );
  }
  return h('section', { className: 'section browser-route' },
    h('div', { className: 'browser-remote card' },
      h('div', { className: 'browser-remote-head' },
        h('div', { className: 'browser-remote-copy' },
          h('strong', null, preview.title || 'Remote browser preview'),
          h('span', { className: 'mono', title: preview.url || '' }, preview.url || 'about:blank')
        ),
        h(StatusPill, { label: preview.control === 'user' ? 'User control' : 'AI control · Preview', tone: preview.control === 'user' ? 'warn' : 'working' })
      ),
      h('div', { className: 'browser-remote-frame' },
        h('img', {
          src: imageSrc,
          alt: `Read-only preview of ${preview.title || preview.url || 'the active Rel.AI browser page'}`,
          width: image.width || undefined,
          height: image.height || undefined
        })
      ),
      h('p', { className: 'browser-remote-note' }, 'Read-only snapshot · refreshes about every 2.5 seconds. Use the desktop app for live interaction.'),
      error ? h('div', { className: 'connection-notice bad', role: 'alert' }, error) : null
    )
  );
}

function emptyState(available) {
  return {
    ok: true,
    available,
    active: false,
    activeSessionCount: 0,
    control: 'ai',
    viewport: null,
    url: '',
    title: '',
    loading: false,
    visible: false,
    tabs: []
  };
}

function formatViewport(viewport) {
  const width = Number(viewport?.width);
  const height = Number(viewport?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return '';
  return `${Math.round(width)} × ${Math.round(height)}`;
}

function handoffTitle(reason) {
  if (reason === 'mfa') return 'Verification required.';
  if (reason === 'captcha') return 'CAPTCHA required.';
  if (reason === 'user_input') return 'Your input is required.';
  return 'Sign-in required.';
}

function permissionLabel(permission) {
  const value = String(permission || '').trim().replaceAll('-', ' ');
  return value || 'this browser feature';
}

function hostOf(url) {
  const value = String(url || '').trim();
  if (!value || value === 'about:blank') return '';
  try { return new URL(value).hostname || ''; } catch { return ''; }
}

function displayUrl(url) {
  const value = String(url || '');
  return value.length > 120 ? `${value.slice(0, 117)}…` : value;
}

function faviconLetter(label) {
  const value = String(label || '').trim();
  const char = value ? [...value][0] : '•';
  return (char || '•').toUpperCase();
}

async function copyText(value) {
  const text = String(value || '');
  if (!text) return false;
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  return fallbackCopy(text);
}

function fallbackCopy(text) {
  const area = document.createElement('textarea');
  try {
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    return document.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

function sessionLabel(session, index) {
  const title = String(session?.title || '').trim();
  if (title) return title;
  const url = String(session?.url || '').trim();
  if (url) {
    try { return new URL(url).hostname || url; } catch { return url; }
  }
  return `Session ${index + 1}`;
}

function tabLabel(tab, index) {
  const title = String(tab?.title || '').trim();
  if (title) return title;
  const url = String(tab?.url || '').trim();
  if (url && url !== 'about:blank') {
    try { return new URL(url).hostname || url; } catch { return url; }
  }
  return `Tab ${index + 1}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Browser action failed.');
}

export { clipBrowserSurfaceBounds, createBrowserRoute, releaseBrowserRouteControl };
