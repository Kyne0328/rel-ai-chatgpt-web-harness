import fs from 'node:fs';
import path from 'node:path';
import { createHttpMcpSession } from '../../helpers/http-mcp.mjs';

const targetUrl = process.env.RELAI_PROBE_TARGET_URL;
const outputPath = process.env.RELAI_PROBE_OUTPUT_PATH;
const screenshotDir = process.env.RELAI_PROBE_SCREENSHOT_DIR;
const createWorkspacePath = process.env.RELAI_PROBE_CREATE_WORKSPACE_PATH;
const axePath = process.env.RELAI_PROBE_AXE_PATH;
const dashboardDelayMs = Math.max(0, Number(process.env.RELAI_PROBE_DASHBOARD_DELAY_MS || 0));
if (!targetUrl || !outputPath || !screenshotDir || !createWorkspacePath || !axePath) throw new Error('Electron dashboard probe environment is incomplete.');
fs.writeFileSync(outputPath, JSON.stringify({ stage: 'script_started', argv: process.argv }, null, 2));

let app;
let BrowserWindow;
const failures = [];
try {
  ({ app, BrowserWindow } = await import('electron'));
} catch (error) {
  fs.writeFileSync(outputPath, JSON.stringify({ stage: 'electron_import_failed', error: error?.stack || String(error) }, null, 2));
  throw error;
}

app.commandLine.appendSwitch('force-prefers-reduced-motion', 'reduce');
app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  fs.writeFileSync(outputPath, JSON.stringify({ stage: 'app_ready' }, null, 2));
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep capture paint frames deterministic if another window becomes active.
      backgroundThrottling: false
    }
  });
  let delayedDashboardRequest = false;
  if (dashboardDelayMs > 0) {
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*'] }, (details, callback) => {
      if (!delayedDashboardRequest && details.url.includes('/api/dashboard/v10')) {
        delayedDashboardRequest = true;
        setTimeout(() => callback({}), dashboardDelayMs);
        return;
      }
      callback({});
    });
  }
  win.webContents.session.webRequest.onCompleted({ urls: ['http://*/*'] }, details => {
    if (details.statusCode >= 400) failures.push(`http:${details.statusCode}:${details.url}`);
  });
  win.webContents.session.webRequest.onErrorOccurred({ urls: ['http://*/*'] }, details => {
    if (expectedEventStreamClose(details)) return;
    failures.push(`network:${details.error}:${details.url}`);
  });
  const navigationCounts = { didStartNavigation: 0, didNavigate: 0, didFinishLoad: 0 };
  win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) navigationCounts.didStartNavigation += 1;
  });
  win.webContents.on('did-navigate', () => { navigationCounts.didNavigate += 1; });
  win.webContents.on('did-finish-load', () => { navigationCounts.didFinishLoad += 1; });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) failures.push(`console:${message}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => failures.push(`renderer:${details.reason}`));
  await win.loadURL(targetUrl);
  const hydrationBefore = await readHydrationState(win);
  if (dashboardDelayMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(350, Math.max(100, Math.floor(dashboardDelayMs / 2)))));
  const hydrationDuring = await readHydrationState(win);
  await waitFor(win, `document.querySelectorAll('.compact-workspace').length >= 1`);
  const hydrationAfter = await readHydrationState(win);
  const initialHydration = { before: hydrationBefore, during: hydrationDuring, after: hydrationAfter, delayedDashboardRequest };
  await win.webContents.executeJavaScript(`location.hash = '#tasks'`);
  await waitFor(win, `document.querySelectorAll('.task-row').length >= 9`);

  const accessibility = [await auditAccessibility(win, axePath, 'tasks')];

  const initial = await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('.task-row')];
    const progress = [...document.querySelectorAll('progress.task-progress-track')];
    const indeterminate = [...document.querySelectorAll('.task-progress.indeterminate')];
    const terminalRows = rows.filter(row => ['acceptance-completed', 'acceptance-failed', 'acceptance-cancelled'].includes(row.dataset.taskId));
    return {
      title: document.title,
      rowCount: rows.length,
      rowText: rows.map(row => row.textContent.trim()),
      determinateCount: progress.length,
      determinateValid: progress.every(item => item.max === 100 && item.hasAttribute('value') && item.getAttribute('aria-label')),
      indeterminateCount: indeterminate.length,
      indeterminateValid: indeterminate.every(item => Boolean(item.getAttribute('aria-label')) && !item.hasAttribute('aria-valuenow') && item.querySelector('.task-progress-track')?.getAttribute('aria-hidden') === 'true'),
      terminalRowCount: terminalRows.length,
      terminalLiveClockCount: terminalRows.filter(row => row.querySelector('[data-clock-elapsed-start]')).length,
      terminalDurationVisible: terminalRows.every(row => Boolean(row.querySelector('.task-row-time')?.textContent.trim())),
      terminalNoProgress: terminalRows.every(row => !row.querySelector('.task-progress')),
      unknownStatusCount: rows.filter(row => /unknown/i.test(row.textContent)).length,
      longTitleAccessible: rows.some(row => row.textContent.includes('Extremely long task title') && (row.getAttribute('aria-label') || row.getAttribute('title') || row.textContent.length > 80)),
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      highContrast: matchMedia('(forced-colors: active)').matches,
      bodyWidth: document.documentElement.scrollWidth,
      reactFoundationReady: document.querySelector('[data-react-dashboard-ready="true"]')?.getAttribute('data-react-dashboard-ready') === 'true',
      reactRevisionKey: document.querySelector('[data-react-dashboard-ready="true"]')?.getAttribute('data-store-revisions') || ''
    };
  })()`);

  const liveToolBefore = await win.webContents.executeJavaScript(`(() => {
    window.__relaiProbeSessionsPage = document.querySelector('.sessions-page');
    window.__relaiProbeLiveToolUpdate = null;
    window.__relaiProbeLiveToolListener = event => {
      if (event.detail?.type !== 'connection.updated') return;
      const recentEvents = event.detail?.data?.mcpConnection?.recentEvents || [];
      const request = recentEvents.find(item => (
        item?.type === 'mcp_request_received'
        && item?.method === 'tools/list'
        && item?.clientInfo?.name === 'dashboard-live-rendering-acceptance'
      ));
      if (!request) return;
      window.setTimeout(() => {
        window.__relaiProbeLiveToolUpdate = {
          type: event.detail.type,
          requestId: request.requestId || ''
        };
      }, 0);
    };
    window.addEventListener('relai:diagnostics-live', window.__relaiProbeLiveToolListener);
    return {
      routeReady: Boolean(window.__relaiProbeSessionsPage),
      updated: document.getElementById('lastUpdated')?.textContent.trim() || ''
    };
  })()`);
  fs.writeFileSync(outputPath, JSON.stringify({ stage: 'dashboard_ready', liveToolBefore }, null, 2));
  await waitFor(win, `Boolean(window.__relaiProbeLiveToolUpdate)`, 10_000);
  const liveToolUpdate = await win.webContents.executeJavaScript(`(() => {
    const current = document.querySelector('.sessions-page');
    const updated = document.getElementById('lastUpdated')?.textContent.trim() || '';
    return {
      received: Boolean(window.__relaiProbeLiveToolUpdate),
      eventType: window.__relaiProbeLiveToolUpdate?.type || '',
      requestId: window.__relaiProbeLiveToolUpdate?.requestId || '',
      beforeUpdated: ${JSON.stringify(liveToolBefore.updated)},
      afterUpdated: updated,
      sameRouteNode: Boolean(current && current === window.__relaiProbeSessionsPage),
      reactRevisionKey: document.querySelector('[data-react-dashboard-ready="true"]')?.getAttribute('data-store-revisions') || ''
    };
  })()`);

  await win.webContents.executeJavaScript(`localStorage.setItem('relai_debug', '1')`);
  const skipLinkInteractions = await exerciseSkipLink(win);
  const navigationInteractions = await exerciseNavigationControls(win, failures);
  const modalInteractions = await exerciseModalInteractions(win);
  accessibility.push(await auditAccessibility(win, axePath, 'workspaces'));
  const projectPersistence = await exerciseProjectPersistence(win, createWorkspacePath);

  const parsedTarget = new URL(targetUrl);
  const passiveMcpSession = await createHttpMcpSession(parsedTarget.origin, {
    token: parsedTarget.searchParams.get('token') || '',
    clientName: 'dashboard-passive-route-probe'
  });
  const passiveRouteStability = [];
  for (const route of [
    { hash: 'settings', ready: `document.querySelector('#__settings-content .theme-switch') && !document.querySelector('.settings-loading')` },
    { hash: 'diagnostics', ready: `document.querySelector('.diagnostic-page') && !document.querySelector('[data-copy-report]')?.disabled` },
    { hash: 'workspaces', ready: `document.querySelector('.workspace-grid')` },
    { hash: 'tools', ready: `document.querySelector('.tools-section') && document.getElementById('toolsCount')?.textContent.trim() !== 'Loading…'` }
  ]) {
    passiveRouteStability.push(await measurePassiveRouteStability(win, passiveMcpSession, navigationCounts, route));
  }
  await passiveMcpSession.close();
  const connectionSaveLifecycle = await exerciseConnectionSaveLifecycle(win);
  const usageRequestOrdering = await exerciseUsageRequestOrdering(win);
  const updateModalTransitions = await exerciseUpdateModalTransitions(win);

  await win.webContents.executeJavaScript(`location.hash = '#tasks'`);
  await waitFor(win, `document.querySelectorAll('.task-row').length >= 9`);
  const taskDetailImmediate = await win.webContents.executeJavaScript(`(() => {
    document.querySelector('.task-row')?.click();
    return Boolean(document.querySelector('[data-session-inspector] .session-detail'));
  })()`);
  await waitFor(win, `document.querySelector('[data-session-inspector] .session-detail')`);
  await waitFor(win, `document.querySelectorAll('[data-session-inspector] .task-event-link').length > 0`);
  const taskInteraction = await win.webContents.executeJavaScript(`(() => {
    const inspector = document.querySelector('[data-session-inspector]');
    const detail = inspector?.querySelector('.session-detail');
    return {
      inspector: Boolean(inspector && detail),
      selectedRow: Boolean(document.querySelector('.task-row.is-selected')),
      tabs: detail?.querySelectorAll('[data-session-tab]').length || 0,
      detailText: detail?.textContent || '',
      workSessionId: /Rel[.]AI task ID/.test(detail?.textContent || ''),
      processId: /Process ID/.test(detail?.textContent || ''),
      eventLinks: detail?.querySelectorAll('.task-event-link').length || 0
    };
  })()`);
  taskInteraction.immediate = taskDetailImmediate;
  const taskSelectionStability = await exerciseTaskSelectionStability(win);

  await win.webContents.setZoomFactor(1);
  win.setSize(1600, 900);
  await delay(150);
  await win.webContents.executeJavaScript(`location.hash = '#activity'`);
  await waitFor(win, `document.querySelector('.activity-table tbody .activity-row-trigger')`);
  const activityDesktopGeometry = await win.webContents.executeJavaScript(`(() => {
    const table = document.querySelector('.activity-table');
    const wrap = document.querySelector('#__activity-table-wrap .table-wrap');
    const headers = [...document.querySelectorAll('.activity-table thead th')]
      .filter(cell => getComputedStyle(cell).display !== 'none')
      .map(cell => ({ text: cell.textContent.trim(), width: cell.getBoundingClientRect().width }));
    const messageHeader = document.querySelector('.activity-table thead .activity-message-column');
    const messageCell = document.querySelector('.activity-message-cell');
    const headerRect = messageHeader?.getBoundingClientRect();
    const cellRect = messageCell?.getBoundingClientRect();
    const wrapRect = wrap?.getBoundingClientRect();
    const visibleHeaderWidth = headers.reduce((sum, item) => sum + item.width, 0);
    const measuredRows = [...document.querySelectorAll('.activity-data-row')].slice(0, 12);
    const messageLefts = measuredRows
      .map(row => row.querySelector('.activity-message-copy')?.getBoundingClientRect().left)
      .filter(Number.isFinite);
    const messageLeftOrigin = messageLefts[0] ?? 0;
    const messageLeftErrors = messageLefts.map(left => Math.abs(left - messageLeftOrigin));
    const statusLefts = measuredRows
      .map(row => row.querySelector('.activity-row-status')?.getBoundingClientRect().left)
      .filter(Number.isFinite);
    const statusLeftOrigin = statusLefts[0] ?? 0;
    const statusLeftErrors = statusLefts.map(left => Math.abs(left - statusLeftOrigin));
    return {
      viewportWidth: innerWidth,
      tableWidth: table?.getBoundingClientRect().width || 0,
      wrapWidth: wrapRect?.width || 0,
      visibleHeaderWidth,
      trailingWidthGap: Math.max(0, (wrapRect?.width || 0) - visibleHeaderWidth),
      visibleHeaders: headers.map(item => item.text),
      headerWidth: headerRect?.width || 0,
      cellWidth: cellRect?.width || 0,
      headerVisible: Boolean(messageHeader && getComputedStyle(messageHeader).display !== 'none' && headerRect && wrapRect && headerRect.width > 0 && headerRect.right > wrapRect.left && headerRect.left < wrapRect.right),
      cellVisible: Boolean(messageCell && getComputedStyle(messageCell).display !== 'none' && cellRect && wrapRect && cellRect.width > 0 && cellRect.right > wrapRect.left && cellRect.left < wrapRect.right),
      messageText: messageCell?.querySelector('.activity-message-copy')?.textContent.trim() || '',
      measuredMessageRows: messageLeftErrors.length,
      maxMessageLeftAlignmentError: messageLeftErrors.length ? Math.max(...messageLeftErrors) : 0,
      measuredStatusRows: statusLeftErrors.length,
      maxStatusLeftAlignmentError: statusLeftErrors.length ? Math.max(...statusLeftErrors) : 0
    };
  })()`);
  const activityLiveStability = await win.webContents.executeJavaScript(`(async () => {
    const beforeNode = document.querySelector('.activity-message-copy');
    const beforeText = beforeNode?.textContent.trim() || '';
    const tbody = document.getElementById('__activity-tbody');
    let childListMutations = 0;
    const observer = new MutationObserver(records => {
      childListMutations += records.filter(record => record.type === 'childList').length;
    });
    if (tbody) observer.observe(tbody, { childList: true, subtree: true });
    for (let index = 0; index < 3; index += 1) {
      window.dispatchEvent(new CustomEvent('relai:clock-tick', { detail: { now: Date.now() } }));
    }
    window.dispatchEvent(new CustomEvent('relai:dashboard-refresh'));
    await new Promise(resolve => setTimeout(resolve, 750));
    observer.disconnect();
    const afterNode = document.querySelector('.activity-message-copy');
    const pauseButton = document.getElementById('__activity-freeze');
    pauseButton?.click();
    const frozen = pauseButton?.getAttribute('aria-pressed') === 'true';
    pauseButton?.click();
    await new Promise(resolve => setTimeout(resolve, 750));
    const resumed = pauseButton?.getAttribute('aria-pressed') === 'false';
    return {
      beforeText,
      afterText: afterNode?.textContent.trim() || '',
      sameMessageNode: Boolean(beforeNode && beforeNode === afterNode),
      childListMutations,
      messageCount: document.querySelectorAll('.activity-message-copy').length,
      frozen,
      resumed,
      messageAfterResume: document.querySelector('.activity-message-copy')?.textContent.trim() || ''
    };
  })()`);
  const beforeFocus = await win.webContents.executeJavaScript(`document.activeElement?.tagName || ''`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'TAB' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'TAB' });
  await delay(50);
  const afterFocus = await win.webContents.executeJavaScript(`({tag: document.activeElement?.tagName || '', className: document.activeElement?.className || ''})`);
  await win.webContents.executeJavaScript(`document.querySelector('.activity-table tbody .activity-row-trigger')?.click()`);
  await waitFor(win, `document.querySelector('[data-activity-inspector] .activity-detail-head')`);
  const activityInteraction = await win.webContents.executeJavaScript(`(() => {
    const inspector = document.querySelector('[data-activity-inspector]');
    const detail = inspector?.querySelector('.activity-detail-head');
    const errorValue = inspector?.querySelector('.detail-pre, .activity-json-leaf code');
    return {
      expanded: Boolean(detail),
      selectedRow: Boolean(document.querySelector('.activity-table tbody tr.is-selected')),
      copyButton: Boolean([...inspector.querySelectorAll('button')].find(button => /copy event json/i.test(button.textContent))),
      errorWrapped: errorValue ? getComputedStyle(errorValue).overflowWrap !== 'normal' : false
    };
  })()`);
  const activitySelectionStability = await exerciseActivitySelectionStability(win);
  const operationDiagnostics = await exerciseOperationDiagnostics(win);
  await waitFor(win, `!document.querySelector('#__relai-drawer-backdrop')`);
  await win.webContents.executeJavaScript(`location.hash = '#tasks'`);
  await waitFor(win, `document.querySelectorAll('.task-row').length >= 9`);
  win.show();
  win.focus();
  await waitFor(win, `document.visibilityState === 'visible'`);
  await waitFor(win, `document.querySelector('[data-clock-elapsed-start]:not([data-clock-elapsed-end])')`);
  const clockBefore = await win.webContents.executeJavaScript(`document.querySelector('[data-clock-elapsed-start]:not([data-clock-elapsed-end])')?.textContent || ''`);
  await waitFor(
    win,
    `document.querySelector('[data-clock-elapsed-start]:not([data-clock-elapsed-end])')?.textContent !== ${JSON.stringify(clockBefore)}`,
    4000
  );
  const clockAfter = await win.webContents.executeJavaScript(`document.querySelector('[data-clock-elapsed-start]:not([data-clock-elapsed-end])')?.textContent || ''`);

  fs.mkdirSync(screenshotDir, { recursive: true });
  await delay(200);
  accessibility.push(await auditAccessibility(win, axePath, 'activity'));

  const responsive = [];
  for (const scenario of [
    { name: 'window-1024x768', width: 1024, height: 768, zoom: 1, theme: 'dark' },
    { name: 'window-640x720', width: 640, height: 720, zoom: 1, theme: 'dark' },
    { name: 'css-320-zoom-200', width: 640, height: 720, zoom: 2, theme: 'light' },
    { name: 'css-375-zoom-200', width: 750, height: 720, zoom: 2, theme: 'dark' },
    { name: 'zoom-400', width: 640, height: 720, zoom: 4, theme: 'light' },
    { name: 'css-320-zoom-400', width: 1280, height: 900, zoom: 4, theme: 'light' }
  ]) {
    fs.writeFileSync(outputPath, JSON.stringify({ stage: 'responsive-start', scenario: scenario.name }));
    await win.webContents.setZoomFactor(scenario.zoom);
    win.setSize(scenario.width, scenario.height);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'TAB' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'TAB' });
    await win.webContents.executeJavaScript(`(() => {
      document.documentElement.dataset.theme = ${JSON.stringify(scenario.theme)};
      const row = document.querySelector('.task-row');
      row?.scrollIntoView({ block: 'center', inline: 'nearest' });
      row?.focus();
    })()`);
    await delay(200);
    const focusBeforeTab = await win.webContents.executeJavaScript(`document.activeElement?.getAttribute('data-task-id') || document.activeElement?.id || document.activeElement?.tagName || ''`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'TAB' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'TAB' });
    await delay(50);
    const measurement = await win.webContents.executeJavaScript(`(() => {
      const intersects = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      };
      const topbar = document.querySelector('.topbar');
      const rows = [...document.querySelectorAll('.task-row')];
      const visibleRow = rows.find(intersects) || rows[0];
      const status = visibleRow?.querySelector('.status-pill');
      const primaryControls = [...document.querySelectorAll('.top-controls button, .top-controls a, .task-row')];
      const mobileNav = document.querySelector('.mobile-nav');
      const mobileMore = document.querySelector('.mobile-nav-more > summary');
      const mobileNavVisible = Boolean(mobileNav && getComputedStyle(mobileNav).display !== 'none');
      const active = document.activeElement;
      const activeStyle = active && active !== document.body ? getComputedStyle(active) : null;
      const focusVisible = Boolean(activeStyle && ((activeStyle.outlineStyle !== 'none' && activeStyle.outlineWidth !== '0px') || activeStyle.boxShadow !== 'none'));
      return {
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        mobileNavScrollable: Boolean(mobileNavVisible && mobileNav.scrollWidth > mobileNav.clientWidth + 1),
        mobileMoreVisible: Boolean(mobileNavVisible && intersects(mobileMore)),
        topbarIntersects: intersects(topbar),
        taskRowIntersects: rows.some(intersects),
        primaryControlIntersects: primaryControls.some(intersects),
        focusVisible,
        focusOutline: activeStyle ? activeStyle.outlineStyle + ' ' + activeStyle.outlineWidth : '',
        focusBoxShadow: activeStyle?.boxShadow || '',
        activeClass: active?.className || '',
        activeMatchesTaskRowFocus: Boolean(active?.matches?.('.task-row:focus')),
        focusAfterTab: active?.getAttribute('data-task-id') || active?.id || active?.tagName || '',
        statusText: status?.textContent.trim() || '',
        longContentContained: rows.length > 0 && rows.every(row => row.scrollWidth <= row.clientWidth + 1),
        theme: document.documentElement.dataset.theme,
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
        forcedColorsActive: matchMedia('(forced-colors: active)').matches,
        forcedColorsSupported: CSS.supports('forced-color-adjust', 'none')
      };
    })()`);
    if (measurement.viewportWidth <= 760) {
      await win.webContents.executeJavaScript(`document.querySelector('.task-row')?.click()`);
      await waitFor(win, `document.querySelector('[data-session-inspector] .task-detail-header h2')`);
      Object.assign(measurement, await win.webContents.executeJavaScript(`(() => {
        const heading = document.querySelector('[data-session-inspector] .task-detail-header h2');
        const rect = heading?.getBoundingClientRect();
        return {
          taskDetailFocused: document.activeElement === heading,
          taskDetailVisible: Boolean(rect && rect.bottom > 0 && rect.top < innerHeight)
        };
      })()`));
    }
    await win.webContents.executeJavaScript(`location.hash = '#activity'`);
    try {
      await waitFor(win, `document.querySelector('.activity-table tbody .activity-row-trigger')`);
    } catch (error) {
      const activityDebug = await win.webContents.executeJavaScript(`(() => ({
        hash: location.hash,
        table: Boolean(document.querySelector('.activity-table')),
        bodyText: document.getElementById('__activity-tbody')?.textContent.trim() || '',
        count: document.getElementById('__activity-count')?.textContent.trim() || '',
        summary: document.querySelector('#__activity-filter-bar .filter-summary')?.textContent.trim() || ''
      }))()`);
      throw new Error(`${error.message}; scenario=${scenario.name}; activity=${JSON.stringify(activityDebug)}`, { cause: error });
    }
    const activityMeasurement = await win.webContents.executeJavaScript(`(() => {
      const wrap = document.querySelector('#__activity-table-wrap .table-wrap');
      if (wrap) wrap.scrollLeft = 0;
      const cell = document.querySelector('.activity-table tbody .activity-row-trigger')?.closest('tr')?.querySelector('.activity-message-cell');
      const rect = cell?.getBoundingClientRect();
      const wrapRect = wrap?.getBoundingClientRect();
      return {
        activityHorizontalOverflow: Boolean(wrap && wrap.scrollWidth > wrap.clientWidth + 1),
        activityMessageVisible: Boolean(rect && wrapRect && rect.width > 0 && rect.right > wrapRect.left && rect.left < wrapRect.right && getComputedStyle(cell).display !== 'none'),
        activityMessageText: cell?.textContent.trim() || '',
        activityScrollLeft: wrap?.scrollLeft || 0
      };
    })()`);
    Object.assign(measurement, activityMeasurement);
    if (measurement.viewportWidth <= 1140) {
      Object.assign(measurement, await win.webContents.executeJavaScript(`(() => {
        const list = document.querySelector('.activity-list-pane');
        const inspector = document.querySelector('[data-activity-inspector]');
        const listRect = list?.getBoundingClientRect();
        const inspectorRect = inspector?.getBoundingClientRect();
        return {
          activityStacked: Boolean(listRect && inspectorRect && Math.abs(listRect.left - inspectorRect.left) <= 1 && inspectorRect.top >= listRect.bottom - 1)
        };
      })()`));
      await win.webContents.executeJavaScript(`document.querySelector('.activity-table tbody .activity-row-trigger')?.click()`);
      await waitFor(win, `document.querySelector('[data-activity-inspector] .activity-inspector-head h2')`);
      Object.assign(measurement, await win.webContents.executeJavaScript(`(() => {
        const heading = document.querySelector('[data-activity-inspector] .activity-inspector-head h2');
        const rect = heading?.getBoundingClientRect();
        return {
          activityDetailFocused: document.activeElement === heading,
          activityDetailVisible: Boolean(rect && rect.bottom > 0 && rect.top < innerHeight)
        };
      })()`));
    }
    fs.writeFileSync(outputPath, JSON.stringify({ stage: 'responsive-navigation', scenario: scenario.name }));
    await win.webContents.executeJavaScript(`(() => {
      const link = [...document.querySelectorAll('a[data-nav-id="tasks"]')].find(node => node.getBoundingClientRect().width > 0 && getComputedStyle(node).visibility !== 'hidden');
      if (!link) throw new Error('Visible Tasks navigation link is unavailable');
      link.click();
    })()`);
    await waitFor(win, `location.hash === '#tasks' && document.getElementById('pageTitle')?.textContent === 'Tasks' && document.querySelector('[data-nav-id="tasks"][aria-current="page"]') && document.querySelectorAll('.task-row').length >= 9`);
    // Route DOM availability precedes paint; preserve capture-time evidence before
    // restoring the first row to the same readable position used by this scenario.
    await waitForCapturePaint(win);
    measurement.captureBeforeScroll = await win.webContents.executeJavaScript(`(() => {
      const rows = [...document.querySelectorAll('.task-row')];
      const visibleRows = rows.filter(row => {
        const rect = row.getBoundingClientRect();
        const top = Math.max(rect.top, document.querySelector('.topbar')?.getBoundingClientRect().bottom || 0);
        const nav = document.querySelector('.mobile-nav');
        const bottom = Math.min(rect.bottom, nav && getComputedStyle(nav).display !== 'none' ? nav.getBoundingClientRect().top : innerHeight);
        return bottom > top && document.elementsFromPoint(rect.left + rect.width / 2, (top + bottom) / 2).some(node => node === row || row.contains(node));
      });
      return { trigger: 'visible Tasks link click', hash: location.hash, scrollY,
        firstRow: rows[0]?.getBoundingClientRect().toJSON(), unobscuredTaskRows: visibleRows.length };
    })()`);
    const beforeScrollScreenshot = path.join(screenshotDir, scenario.name + '-before-scroll.png');
    fs.writeFileSync(beforeScrollScreenshot, (await win.webContents.capturePage()).toPNG());
    measurement.captureBeforeScroll.screenshot = beforeScrollScreenshot;
    await win.webContents.executeJavaScript(`document.querySelector('.task-row')?.scrollIntoView({ block: 'center', inline: 'nearest' })`);
    await waitForCapturePaint(win);
    measurement.captureState = await win.webContents.executeJavaScript(`(() => {
      const topbar = document.querySelector('.topbar')?.getBoundingClientRect();
      const nav = document.querySelector('.mobile-nav');
      const navVisible = nav && getComputedStyle(nav).display !== 'none';
      const navRect = navVisible ? nav.getBoundingClientRect() : null;
      const contentTop = Math.max(0, topbar?.bottom || 0);
      const contentBottom = Math.min(innerHeight, navRect?.top ?? innerHeight);
      const rows = [...document.querySelectorAll('.task-row')].map(row => row.getBoundingClientRect().toJSON());
      const labels = navVisible ? [...nav.querySelectorAll(':scope > a .nav-label, :scope > details > summary .nav-label')].map(label => {
        const range = document.createRange();
        range.selectNodeContents(label);
        return { text: label.textContent, bounds: range.getBoundingClientRect().toJSON() };
      }) : [];
      return {
        hash: location.hash, title: document.getElementById('pageTitle')?.textContent,
        activeNavigation: [...document.querySelectorAll('[data-nav-id][aria-current="page"]')].map(node => node.dataset.navId),
        viewportWidth: innerWidth, viewportHeight: innerHeight, scrollY,
        contentTop, contentBottom, firstRow: rows[0],
        visibleTaskRows: rows.filter(rect => rect.bottom > contentTop && rect.top < contentBottom && rect.right > 0 && rect.left < innerWidth).length,
        navigationLabels: labels,
        navigationLabelsOverlap: labels.some((label, index) => index > 0 && label.bounds.left < labels[index - 1].bounds.right - 1)
      };
    })()`);
    measurement.name = scenario.name;
    measurement.zoomFactor = scenario.zoom;
    measurement.windowWidth = scenario.width;
    measurement.windowHeight = scenario.height;
    measurement.keyboardAdvanced = Boolean(focusBeforeTab && measurement.focusAfterTab && focusBeforeTab !== measurement.focusAfterTab);
    const screenshotPath = path.join(screenshotDir, `${scenario.name}.png`);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(screenshotPath, image.toPNG());
    measurement.screenshot = screenshotPath;
    responsive.push(measurement);
  }

  const result = {
    initialHydration,
    initial,
    liveToolUpdate,
    navigationInteractions,
    skipLinkInteractions,
    modalInteractions,
    projectPersistence,
    passiveRouteStability,
    connectionSaveLifecycle,
    usageRequestOrdering,
    updateModalTransitions,
    taskInteraction,
    taskSelectionStability,
    activityInteraction,
    activitySelectionStability,
    operationDiagnostics,
    activityDesktopGeometry,
    activityLiveStability,
    keyboard: { beforeFocus, afterFocus },
    clock: { before: clockBefore, after: clockAfter, changed: clockBefore !== clockAfter },
    responsive,
    accessibility,
    failures
  };
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  await win.close();
  app.quit();
}).catch(error => {
  fs.writeFileSync(outputPath, JSON.stringify({ error: `${error?.stack || String(error)}\n${failures.join('\n')}` }, null, 2));
  app.exit(1);
});

// Exercise production React presentation through normal aggregate refreshes. The
// fixture changes returned receipt data only; it never replaces feature DOM.



async function exerciseUpdateModalTransitions(win) {
  await win.webContents.executeJavaScript(`(async () => {
    const module = await import('/public/dashboard-react.js');
    const probe = { listener: null };
    probe.stop = module.initUpdateAvailableModal({
      bridge: {
        getUpdateStatus: async () => ({ state: 'available', availableVersion: '1.2.0' }),
        onUpdateStatus: listener => { probe.listener = listener; return () => { probe.listener = null; }; },
        installUpdate: async () => ({ ok: true, status: { state: 'installing', availableVersion: '1.2.0' } })
      }
    });
    window.__updateModalProbe = probe;
  })()`);
  await waitFor(win, `document.querySelector('.modal-title')?.textContent === 'Update available'`);
  await win.webContents.executeJavaScript(`window.__updateModalProbe.listener({ state: 'installing', availableVersion: '1.2.0' })`);
  await waitFor(win, `document.querySelector('.modal-title')?.textContent === 'Updating Rel.AI'`);
  const installingLocked = await win.webContents.executeJavaScript(`!document.querySelector('.modal-close')`);
  await win.webContents.executeJavaScript(`window.__updateModalProbe.listener({ state: 'downloaded', availableVersion: '1.2.0', error: 'Fixture update failed' })`);
  await waitFor(win, `document.querySelector('.modal-title')?.textContent === 'Update could not install'`);
  await win.webContents.executeJavaScript(`(() => {
    const probe = window.__updateModalProbe;
    probe.panel = document.querySelector('.modal-panel');
    probe.button = document.querySelector('.modal-actions .primary');
    probe.button.focus();
    probe.listener({ state: 'downloaded', availableVersion: '1.2.0', error: 'Fixture retry available' });
  })()`);
  await waitForCapturePaint(win);
  const repeated = await win.webContents.executeJavaScript(`(() => ({
    samePanel: window.__updateModalProbe.panel === document.querySelector('.modal-panel'),
    focusPreserved: window.__updateModalProbe.button === document.activeElement,
    closeAvailable: Boolean(document.querySelector('.modal-close'))
  }))()`);
  await win.webContents.executeJavaScript(`document.querySelector('.modal-actions .primary').click()`);
  await waitFor(win, `document.querySelector('.modal-title')?.textContent === 'Updating Rel.AI'`);
  await win.webContents.executeJavaScript(`window.__updateModalProbe.listener({ state: 'downloaded', availableVersion: '1.2.0', error: 'Fixture retry failed' })`);
  await waitFor(win, `document.querySelector('.modal-close')`);
  await win.webContents.executeJavaScript(`document.querySelector('.modal-close').click()`);
  await waitFor(win, `!document.querySelector('.modal-panel')`);
  const closed = await win.webContents.executeJavaScript(`(() => {
    window.__updateModalProbe.stop();
    delete window.__updateModalProbe;
    return { closed: !document.querySelector('.modal-panel'), focusReturned: document.activeElement?.id === 'pageTitle' };
  })()`);
  return { installingLocked, repeated, ...closed };
}

async function exerciseUsageRequestOrdering(win) {
  await win.webContents.executeJavaScript(`(() => {
    const hourMs = 60 * 60 * 1000;
    const hour = Math.floor(Date.now() / hourMs) * hourMs;
    // The earlier 24h request contains 2 actions; the selected 7d range contains
    // 13. A stale result cannot pass merely by adopting the current button label.
    const series = [[1, 2], [72, 11]].map(([hoursAgo, toolCalls]) => ({
      hour: new Date(hour - hoursAgo * hourMs).toISOString().slice(0, 13),
      requests: toolCalls, toolCalls, successes: toolCalls, failures: 0, executionMs: toolCalls * 10
    }));
    const probe = {
      calls: [], pending: [],
      snapshot: month => {
        const rows = series.filter(row => row.hour.startsWith(month));
        const totals = { requests: 0, toolCalls: 0, successes: 0, failures: 0, executionMs: 0, activeDays: new Set(rows.map(row => row.hour.slice(0, 10))).size };
        for (const row of rows) for (const key of ['requests', 'toolCalls', 'successes', 'failures', 'executionMs']) totals[key] += row[key];
        return { month, totals, series: rows };
      }
    };
    window.__usageRequestProbe = probe;
    window.relaiDesktop = {
      getLocalUsage: month => {
        probe.calls.push(month);
        return new Promise((resolve, reject) => probe.pending.push({ month, resolve, reject }));
      }
    };
    location.hash = '#usage';
  })()`);
  await waitFor(win, `window.__usageRequestProbe.pending.length > 0 && document.querySelector('[data-usage-range-option="7d"]')`);
  await win.webContents.executeJavaScript(`document.querySelector('[data-usage-range-option="7d"]').click()`);
  await waitFor(win, `document.querySelector('[data-usage-range-option="7d"]').getAttribute('aria-pressed') === 'true'`);
  const monthRequestsDeduplicated = await win.webContents.executeJavaScript(`(() => {
    const probe = window.__usageRequestProbe;
    const deduplicated = probe.calls.length === new Set(probe.calls).size;
    for (const request of probe.pending.splice(0)) request.resolve(window.__usageRequestProbe.snapshot(request.month));
    return deduplicated;
  })()`);
  await waitFor(win, `document.querySelector('[data-usage-content]')?.getAttribute('aria-busy') !== 'true' && document.querySelector('.usage-overview')`);
  const loadedRange = await win.webContents.executeJavaScript(`(() => {
    const selected = document.querySelector('[data-usage-range-option][aria-pressed="true"]');
    const actions = [...document.querySelectorAll('.usage-metric')].find(node => node.querySelector('.usage-metric-label')?.textContent === 'Actions');
    return {
      selectedRangeMatchesData: selected.dataset.usageRangeOption === '7d' && document.querySelector('.usage-overview').getAttribute('aria-label').includes(selected.title),
      renderedActions: Number(actions?.querySelector('.usage-metric-value strong')?.textContent)
    };
  })()`);
  await win.webContents.executeJavaScript(`document.querySelector('[data-usage-refresh]').click()`);
  await waitFor(win, `window.__usageRequestProbe.pending.length > 0`);
  await win.webContents.executeJavaScript(`window.__usageRequestProbe.pending.splice(0).forEach(request => request.reject(new Error('Fixture analytics failure')))`);
  await waitFor(win, `document.querySelector('[data-usage-unavailable]')`);
  const failed = await win.webContents.executeJavaScript(`document.querySelector('[data-usage-unavailable]').textContent.includes('Fixture analytics failure')`);
  await win.webContents.executeJavaScript(`document.querySelector('[data-usage-retry]').click()`);
  await waitFor(win, `window.__usageRequestProbe.pending.length > 0`);
  await win.webContents.executeJavaScript(`window.__usageRequestProbe.pending.splice(0).forEach(request => request.resolve(window.__usageRequestProbe.snapshot(request.month)))`);
  await waitFor(win, `document.querySelector('[data-usage-content]')?.getAttribute('aria-busy') !== 'true' && document.querySelector('.usage-overview')`);
  const recovered = await win.webContents.executeJavaScript(`!document.querySelector('[data-usage-unavailable]') && !document.querySelector('[data-usage-refresh]').disabled`);
  await win.webContents.executeJavaScript(`document.querySelector('[data-usage-refresh]').click()`);
  await waitFor(win, `window.__usageRequestProbe.pending.length > 0`);
  await win.webContents.executeJavaScript(`location.hash = '#tasks'`);
  await waitFor(win, `document.querySelector('.sessions-page')`);
  const routeAfterLateResult = await win.webContents.executeJavaScript(`(async () => {
    window.__usageRequestProbe.pending.splice(0).forEach(request => request.resolve(window.__usageRequestProbe.snapshot(request.month)));
    await new Promise(resolve => setTimeout(resolve, 0));
    delete window.relaiDesktop;
    delete window.__usageRequestProbe;
    return location.hash;
  })()`);
  return { monthRequestsDeduplicated, ...loadedRange, failed, recovered, routeAfterLateResult };
}

async function exerciseConnectionSaveLifecycle(win) {
  await win.webContents.executeJavaScript(`(() => {
    const probe = { calls: [], pending: [], listeners: new Set() };
    window.__connectionSaveProbe = probe;
    window.relaiDesktop = {
      getSettings: async () => ({
        port: 3333, tunnelId: 'tunnel_primary1234', tunnelApiKeyConfigured: true,
        additionalTunnels: [{ tunnelId: 'tunnel_secondary1234', label: 'Secondary' }],
        additionalTunnelStatuses: [{ tunnelId: 'tunnel_secondary1234', state: 'starting' }]
      }),
      saveSettings: settings => {
        probe.calls.push(settings);
        return new Promise((resolve, reject) => probe.pending.push({ resolve, reject }));
      },
      onStatus: listener => { probe.listeners.add(listener); return () => probe.listeners.delete(listener); }
    };
    location.hash = '#settings/connection';
  })()`);
  await waitFor(win, `document.querySelector('#port')`);
  const pending = await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#tunnelSettings').open = true;
    document.querySelector('.connection-advanced-settings').open = true;
    const port = document.querySelector('#port');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(port, '3344');
    port.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  if (!pending) throw new Error('Connection form did not open.');
  await waitFor(win, `document.querySelector('#tunnelSettings').dataset.unsavedChanges === 'true'`);
  await win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('#tunnelSettings .connection-actions button');
    button.click();
    button.click();
  })()`);
  await waitFor(win, `document.querySelector('#tunnelSettings .connection-actions button').disabled`);
  const during = await win.webContents.executeJavaScript(`(() => {
    const probe = window.__connectionSaveProbe;
    const locked = ['tunnelId', 'tunnelApiKey', 'port'].every(id => document.getElementById(id).disabled);
    for (const listener of probe.listeners) listener({
      additionalTunnelStatuses: [{ tunnelId: 'tunnel_secondary1234', state: 'running' }]
    });
    probe.pending.shift().resolve({ ok: true });
    return { calls: probe.calls.length, locked };
  })()`);
  await waitFor(win, `!document.querySelector('#port').disabled && document.querySelector('#tunnelSettings').dataset.unsavedChanges === 'false'`);
  const after = await win.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.additional-tunnel-row')].find(node => !node.dataset.primary);
    const result = { port: document.querySelector('#port').value, latestTunnelStatus: row?.textContent.includes('Connected') === true };
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(document.querySelector('#port'), '3355');
    document.querySelector('#port').dispatchEvent(new Event('input', { bubbles: true }));
    return result;
  })()`);
  await waitFor(win, `document.querySelector('#tunnelSettings').dataset.unsavedChanges === 'true'`);
  await win.webContents.executeJavaScript(`document.querySelector('#tunnelSettings .connection-actions button').click()`);
  await waitFor(win, `window.__connectionSaveProbe.pending.length === 1`);
  await win.webContents.executeJavaScript(`window.__connectionSaveProbe.pending.shift().reject(new Error('Fixture save failed'))`);
  await waitFor(win, `document.querySelector('#tunnelSettings .connection-actions button').textContent === 'Try again'`);
  const failed = await win.webContents.executeJavaScript(`(() => ({
    editable: !document.querySelector('#port').disabled,
    port: document.querySelector('#port').value,
    dirty: document.querySelector('#tunnelSettings').dataset.unsavedChanges
  }))()`);
  await win.webContents.executeJavaScript(`document.querySelector('#tunnelSettings .connection-actions button').click()`);
  await waitFor(win, `window.__connectionSaveProbe.pending.length === 1`);
  await win.webContents.executeJavaScript(`window.__connectionSaveProbe.pending.shift().resolve({ ok: true })`);
  await waitFor(win, `!document.querySelector('#port').disabled && document.querySelector('#tunnelSettings').dataset.unsavedChanges === 'false'`);
  const recovered = await win.webContents.executeJavaScript(`(() => {
    const result = { ports: window.__connectionSaveProbe.calls.map(call => call.port), dirty: document.querySelector('#tunnelSettings').dataset.unsavedChanges };
    document.querySelectorAll('.toast-dismiss').forEach(button => button.click());
    delete window.relaiDesktop;
    delete window.__connectionSaveProbe;
    location.hash = '#tasks';
    return result;
  })()`);
  return { during, after, failed, recovered };
}

async function exerciseOperationDiagnostics(win) {
  const size = win.getSize();
  const zoom = win.webContents.getZoomFactor();
  const visible = win.isVisible();
  win.show();
  win.focus();
  const startedAt = new Date(Date.now() - 5000).toISOString();
  const timeline = {
    phase: 'queued', phaseStartedAt: startedAt, lastProgressAt: startedAt,
    executed: false, deadlineKind: 'admission', terminationCertainty: 'not-started',
    blocking: { owner: 'Workspace writer', operationId: `owner-${'x'.repeat(160)}`, taskId: 'acceptance-owner' },
    phases: [{ phase: 'accepted', startedAt, endedAt: startedAt, durationMs: 123 }, { phase: 'queued', startedAt, durationMs: 2000 }]
  };
  await win.webContents.executeJavaScript(`(() => {
    window.__relaiDiagnosticsOriginalFetch = window.fetch;
    window.__relaiDiagnosticsFixture = { status: 'completed', timeline: null };
    window.__relaiDiagnosticsFetches = 0;
    window.fetch = async (...args) => {
      const response = await window.__relaiDiagnosticsOriginalFetch(...args);
      if (!String(args[0]).includes('/api/dashboard/v10')) return response;
      const data = await response.json();
      const fixture = window.__relaiDiagnosticsFixture;
      data.auditTail.entries = data.auditTail.entries.map(entry => entry.taskId === 'acceptance-running'
        ? { ...entry, status: fixture.status, operationId: 'diagnostic-operation', summary: 'Operation diagnostics fixture',
          metadata: fixture.timeline ? { timeline: fixture.timeline } : {} } : entry);
      data.runtime = { ...(data.runtime || {}), buildIdentity: { buildId: 'diagnostic-build', dirty: true,
        sourceRevision: 'revision-fixture', sourceFingerprint: 'fingerprint-fixture', startedAt: ${JSON.stringify(startedAt)}, schemaDigest: 'schema-fixture' } };
      data.runtimeCompatibility = { metadataMatches: true, sourceParity: { status: 'unknown', verified: false } };
      window.__relaiDiagnosticsFetches += 1;
      return new Response(JSON.stringify(data), { status: response.status, headers: response.headers });
    };
    location.hash = '#activity?time=all&task=acceptance-running';
    window.dispatchEvent(new CustomEvent('relai:dashboard-refresh'));
  })()`);
  try {
    await waitFor(win, `window.__relaiDiagnosticsFetches > 0 && document.querySelector('.activity-row-trigger')?.textContent.includes('Operation diagnostics fixture')`);
    await win.webContents.executeJavaScript(`document.querySelector('.activity-row-trigger').click()`);
    await waitFor(win, `document.querySelector('[data-operation-diagnostics="unknown"]') && document.querySelector('[data-runtime-build-identity]')?.textContent.includes('diagnostic-build')`);
    const legacy = await win.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('[data-operation-diagnostics]');
      const fields = [...panel.querySelectorAll('dl > div')];
      return {
        unknownTiming: fields.find(item => item.querySelector('dt')?.textContent === 'Phase started')?.querySelector('dd')?.textContent === 'Unknown',
        unknownTermination: fields.find(item => item.querySelector('dt')?.textContent === 'Process termination')?.querySelector('dd')?.textContent === 'unknown',
        liveClocks: panel.querySelectorAll('[data-clock-elapsed-start]').length
      };
    })()`);
    const refresh = async fixture => {
      const before = await win.webContents.executeJavaScript('window.__relaiDiagnosticsFetches');
      await win.webContents.executeJavaScript(`window.__relaiDiagnosticsFixture = ${JSON.stringify(fixture)}; window.dispatchEvent(new CustomEvent('relai:dashboard-refresh'))`);
      await waitFor(win, `window.__relaiDiagnosticsFetches > ${before}`);
      await waitForCapturePaint(win);
    };
    await refresh({ status: 'running', timeline });
    await waitFor(win, `document.querySelector('[data-operation-diagnostics="queued"] [role="status"]')?.textContent.includes('Waiting for this owner')`);
    await win.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('[data-operation-diagnostics]');
      const details = panel.querySelector('details');
      details.open = false;
      details.querySelector('summary').focus();
      window.__relaiDiagnosticsEnter = null;
      details.querySelector('summary').addEventListener('keypress', event => {
        window.__relaiDiagnosticsEnter = { trusted: event.isTrusted, charCode: event.charCode, key: event.key };
      }, { once: true });
      window.__relaiDiagnosticsPanel = panel;
      window.__relaiDiagnosticsDetails = details;
      window.__relaiDiagnosticsStatus = panel.querySelector('[role="status"]');
      window.__relaiDiagnosticsMutations = 0;
      window.__relaiDiagnosticsObserver = new MutationObserver(records => { window.__relaiDiagnosticsMutations += records.length; });
      window.__relaiDiagnosticsObserver.observe(window.__relaiDiagnosticsStatus, { childList: true, characterData: true, subtree: true });
    })()`);
    win.focus();
    win.webContents.focus();
    await waitFor(win, `document.hasFocus() && document.activeElement === document.querySelector('[data-operation-diagnostics] summary')`);
    // sendInputEvent keyDown is a raw-key event. Native summary activation also
    // needs the Enter character/keypress stage of a real keyboard sequence.
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: String.fromCharCode(13) });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    try {
      await waitFor(win, `document.querySelector('[data-operation-diagnostics] details')?.open && window.__relaiDiagnosticsEnter?.trusted === true && window.__relaiDiagnosticsEnter?.charCode === 13`);
    } catch (error) {
      const keyboard = await win.webContents.executeJavaScript(`({ focused: document.hasFocus(), active: document.activeElement?.outerHTML, enter: window.__relaiDiagnosticsEnter, open: document.querySelector('[data-operation-diagnostics] details')?.open })`);
      throw new Error(`${error.message}; native summary keyboard=${JSON.stringify(keyboard)}`, { cause: error });
    }
    const keyboardExpanded = true;
    for (let index = 0; index < 3; index += 1) await refresh({ status: 'running', timeline });
    const repeated = await win.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('[data-operation-diagnostics]');
      return {
        samePanel: panel === window.__relaiDiagnosticsPanel,
        sameDisclosure: panel.querySelector('details') === window.__relaiDiagnosticsDetails,
        expanded: panel.querySelector('details').open,
        focusPreserved: document.activeElement === panel.querySelector('summary'),
        statusMutations: window.__relaiDiagnosticsMutations,
        measuredDuration: panel.textContent.includes('123 ms'),
        clockOutsideAnnouncement: !panel.querySelector('[role="status"] [data-clock-elapsed-start]')
      };
    })()`);
    await win.webContents.setZoomFactor(2);
    win.setSize(750, 900);
    await delay(150);
    await win.webContents.executeJavaScript(`document.querySelector('[data-operation-diagnostics] summary').scrollIntoView({ block: 'center' })`);
    await waitForCapturePaint(win);
    const narrow = await win.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('[data-operation-diagnostics]');
      const bounds = panel.getBoundingClientRect();
      const summary = panel.querySelector('summary').getBoundingClientRect();
      return {
        viewportWidth: innerWidth,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        factsContained: [...panel.querySelectorAll('dd')].every(node => { const rect = node.getBoundingClientRect(); return rect.left >= bounds.left && rect.right <= bounds.right + 1; }),
        summaryReachable: summary.width > 0 && summary.top >= 0 && summary.bottom <= innerHeight,
        expanded: panel.querySelector('details').open
      };
    })()`);
    fs.mkdirSync(screenshotDir, { recursive: true });
    narrow.screenshot = path.join(screenshotDir, 'operation-diagnostics-narrow.png');
    fs.writeFileSync(narrow.screenshot, (await win.webContents.capturePage()).toPNG());
    await refresh({ status: 'running', timeline: { ...timeline, phase: 'draining-output', executed: true, childExitedAt: startedAt, terminationCertainty: 'unknown' } });
    await waitFor(win, `document.querySelector('[data-operation-diagnostics="draining-output"]')?.textContent.includes('Command exited, collecting result')`);
    const collecting = await win.webContents.executeJavaScript(`({
      samePanel: document.querySelector('[data-operation-diagnostics]') === window.__relaiDiagnosticsPanel,
      expanded: document.querySelector('[data-operation-diagnostics] details')?.open,
      sameLiveRegion: document.querySelector('[data-operation-diagnostics] [role="status"]') === window.__relaiDiagnosticsStatus
    })`);
    await refresh({ status: 'completed', timeline: { ...timeline, phase: 'result-ready', executed: true, terminationCertainty: 'unconfirmed' } });
    await waitFor(win, `document.querySelector('[data-operation-diagnostics="result-ready"]')?.textContent.includes('Result ready')`);
    const ready = await win.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('[data-operation-diagnostics]');
      const build = document.querySelector('[data-runtime-build-identity]');
      return {
        samePanel: panel === window.__relaiDiagnosticsPanel,
        sameLiveRegion: panel.querySelector('[role="status"]') === window.__relaiDiagnosticsStatus,
        noLiveClock: panel.querySelectorAll('[data-clock-elapsed-start]').length === 0,
        uncertaintyVisible: panel.querySelector('.operation-diagnostics-warning')?.textContent.includes('termination is unconfirmed') === true,
        cachedBuild: build.textContent.includes('diagnostic-build'),
        parityUnknown: [...build.querySelectorAll('dl > div')].some(node => node.querySelector('dt')?.textContent === 'Source/build parity' && node.querySelector('dd')?.textContent === 'Unknown')
      };
    })()`);
    return { legacy, keyboardExpanded, repeated, narrow, collecting, ready };
  } finally {
    await win.webContents.executeJavaScript(`(() => {
      window.__relaiDiagnosticsObserver?.disconnect();
      window.fetch = window.__relaiDiagnosticsOriginalFetch;
      for (const key of Object.keys(window).filter(key => key.startsWith('__relaiDiagnostics'))) delete window[key];
      window.dispatchEvent(new CustomEvent('relai:dashboard-refresh'));
    })()`);
    await win.webContents.setZoomFactor(zoom);
    win.setSize(...size);
    if (!visible) win.hide();
  }
}

async function exerciseActivitySelectionStability(win) {
  const ids = await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('[data-activity-event-id]')];
    return {
      original: rows.find(row => row.textContent.includes('completed task'))?.dataset.activityEventId || '',
      selected: rows.find(row => row.textContent.includes('Extremely long task title'))?.dataset.activityEventId || ''
    };
  })()`);
  if (!ids.original || !ids.selected) throw new Error('Activity selection fixtures are missing.');
  await win.webContents.executeJavaScript(`location.hash = '#activity?time=all&event=' + ${JSON.stringify(encodeURIComponent(ids.original))}`);
  await waitFor(win, `document.querySelector('tr.is-selected')?.dataset.activityEventId === ${JSON.stringify(ids.original)}`);
  await win.webContents.executeJavaScript(`(() => {
    [...document.querySelectorAll('[data-activity-event-id]')].find(row => row.dataset.activityEventId === ${JSON.stringify(ids.selected)})?.querySelector('.activity-row-trigger')?.click();
    window.__relaiActivityOriginalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await window.__relaiActivityOriginalFetch(...args);
      if (!String(args[0]).includes('/api/dashboard/v10')) return response;
      const data = await response.json();
      data.auditTail.entries = data.auditTail.entries.map(entry => entry.taskId === 'acceptance-running'
        ? { ...entry, summary: 'Activity selection refresh received' } : entry);
      return new Response(JSON.stringify(data), { status: response.status, headers: response.headers });
    };
    window.dispatchEvent(new CustomEvent('relai:dashboard-refresh'));
  })()`);
  await waitFor(win, `[...document.querySelectorAll('[data-activity-event-id]')].some(row => row.dataset.activityEventId === ${JSON.stringify(ids.selected)} && row.textContent.includes('Activity selection refresh received'))`);
  await delay(50);
  return win.webContents.executeJavaScript(`(() => {
    window.fetch = window.__relaiActivityOriginalFetch;
    delete window.__relaiActivityOriginalFetch;
    return {
      expected: ${JSON.stringify(ids.selected)},
      selected: document.querySelector('tr.is-selected')?.dataset.activityEventId || '',
      routeEvent: new URLSearchParams(location.hash.split('?')[1] || '').get('event')
    };
  })()`);
}

async function exerciseTaskSelectionStability(win) {
  await win.webContents.executeJavaScript(`location.hash = '#tasks?task=acceptance-completed'`);
  await waitFor(win, `document.querySelector('.task-row.is-selected')?.dataset.taskId === 'acceptance-completed'`);
  const immediate = await win.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-task-id="acceptance-running"]')?.click();
    document.querySelector('[data-session-tab="activity"]')?.click();
    return document.querySelector('.task-row.is-selected')?.dataset.taskId || '';
  })()`);
  // Confirm that an aggregate refresh actually changes task data before checking
  // selection. A timer alone could pass without exercising the live-data effect.
  await win.webContents.executeJavaScript(`(() => {
    window.__relaiSelectionOriginalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await window.__relaiSelectionOriginalFetch(...args);
      if (!String(args[0]).includes('/api/dashboard/v10')) return response;
      const data = await response.json();
      data.tasks = data.tasks.map(task => task.id === 'acceptance-completed'
        ? { ...task, title: 'Completed task after selection refresh' } : task);
      return new Response(JSON.stringify(data), { status: response.status, headers: response.headers });
    };
    window.dispatchEvent(new CustomEvent('relai:dashboard-refresh'));
  })()`);
  await waitFor(win, `document.querySelector('[data-task-id="acceptance-completed"]')?.textContent.includes('Completed task after selection refresh')`);
  await delay(50);
  const afterRefresh = await win.webContents.executeJavaScript(`(() => {
    window.fetch = window.__relaiSelectionOriginalFetch;
    delete window.__relaiSelectionOriginalFetch;
    return {
      selected: document.querySelector('.task-row.is-selected')?.dataset.taskId || '',
      routeTask: new URLSearchParams(location.hash.split('?')[1] || '').get('task'),
      activeTab: document.querySelector('[data-session-tab][aria-selected="true"]')?.dataset.sessionTab || ''
    };
  })()`);
  await win.webContents.executeJavaScript(`location.hash = '#tasks?task=acceptance-queued'`);
  await waitFor(win, `document.querySelector('.task-row.is-selected')?.dataset.taskId === 'acceptance-queued'`);
  const nextId = await win.webContents.executeJavaScript(`(() => {
    const current = document.querySelector('.task-row.is-selected');
    const rows = [...document.querySelectorAll('.task-row')];
    current.focus();
    return rows[rows.indexOf(current) + 1]?.dataset.taskId || '';
  })()`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
  await waitFor(win, `document.querySelector('.task-row.is-selected')?.dataset.taskId === ${JSON.stringify(nextId)}`);
  const keyboard = await win.webContents.executeJavaScript(`({
    selected: document.querySelector('.task-row.is-selected')?.dataset.taskId || '',
    focused: document.activeElement?.dataset.taskId || '',
    routeTask: new URLSearchParams(location.hash.split('?')[1] || '').get('task')
  })`);
  return { immediate, afterRefresh, keyboard, nextId };
}

async function auditAccessibility(win, runtimePath, route) {
  if (!await win.webContents.executeJavaScript(`Boolean(window.axe?.run)`)) {
    const source = fs.readFileSync(runtimePath, 'utf8');
    await win.webContents.executeJavaScript(`${source}\n//# sourceURL=relai-axe-core.js`);
  }
  return await win.webContents.executeJavaScript(`axe.run(document, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    resultTypes: ['violations']
  }).then(result => ({
    route: ${JSON.stringify(route)},
    violations: result.violations.map(item => ({
      id: item.id,
      impact: item.impact || '',
      help: item.help,
      nodes: item.nodes.length
    }))
  }))`);
}

async function readHydrationState(win) {
  return win.webContents.executeJavaScript(`(() => ({
    loading: Boolean(document.querySelector('.dashboard-state')),
    loadingText: document.querySelector('.dashboard-state')?.textContent?.trim() || '',
    falseEmpty: Boolean(document.querySelector('.compact-workspace-list > .empty')),
    workspaceCount: document.querySelectorAll('.compact-workspace').length
  }))()`);
}

async function exerciseProjectPersistence(win, sourcePath) {
  await win.webContents.setZoomFactor(1);
  win.setSize(1180, 760);
  await win.webContents.executeJavaScript(`location.hash = '#workspaces'`);
  await waitFor(win, `document.querySelector('[data-workspaces-react]')`);
  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Add project')?.click()`);
  await waitFor(win, `document.querySelector('.modal-title')?.textContent === 'Create project'`);
  await win.webContents.executeJavaScript(`(() => {
    const alias = document.querySelector('.modal-panel input[name="alias"]');
    const paths = document.querySelector('.modal-panel textarea[name="paths"]');
    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    const setTextarea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setInput?.call(alias, 'acceptance-created');
    alias?.dispatchEvent(new Event('input', { bubbles: true }));
    setTextarea?.call(paths, ${JSON.stringify(sourcePath)});
    paths?.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.modal-panel button')).find(button => button.textContent.trim() === 'Create project')?.click()`);
  await waitFor(win, `document.querySelector('[data-workspace-card="acceptance-created"]') && !document.querySelector('#__relai-modal-backdrop')`);
  const created = await win.webContents.executeJavaScript(`Boolean(document.querySelector('[data-workspace-card="acceptance-created"]'))`);

  await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('[data-workspace-card="acceptance-created"]');
    Array.from(card?.querySelectorAll('button') || []).find(button => button.textContent.trim() === 'Edit project')?.click();
  })()`);
  await waitFor(win, `document.querySelector('.modal-title')?.textContent === 'Edit project'`);
  await win.webContents.executeJavaScript(`(() => {
    const alias = document.querySelector('.modal-panel input[name="alias"]');
    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setInput?.call(alias, 'acceptance-created-edited');
    alias?.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.modal-panel button')).find(button => button.textContent.trim() === 'Save')?.click()`);
  await waitFor(win, `document.querySelector('[data-workspace-card="acceptance-created-edited"]') && !document.querySelector('#__relai-modal-backdrop')`);
  return await win.webContents.executeJavaScript(`(() => ({
    created: ${JSON.stringify(created)},
    edited: Boolean(document.querySelector('[data-workspace-card="acceptance-created-edited"]')),
    oldAliasRemoved: !document.querySelector('[data-workspace-card="acceptance-created"]'),
    finalAlias: document.querySelector('[data-workspace-card="acceptance-created-edited"]')?.getAttribute('data-workspace-card') || '',
    recentProjectsAbsent: !document.querySelector('.workspace-recents') && !document.body.textContent.includes('Recent projects')
  }))()`);
}

async function exerciseModalInteractions(win) {
  await win.webContents.setZoomFactor(1);
  win.setSize(1180, 760);
  await win.webContents.executeJavaScript(`location.hash = '#workspaces'`);
  await waitFor(win, `Array.from(document.querySelectorAll('.workspace-grid button')).some(button => button.textContent.trim() === 'Edit project')`);

  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.workspace-grid button')).find(button => button.textContent.trim() === 'Edit project')?.click()`);
  await waitFor(win, `document.querySelector('.modal-title')?.textContent === 'Edit project'`);
  const editDetailsConsolidated = await win.webContents.executeJavaScript(`Boolean(document.querySelector('.modal-panel .ws-project-details-section .workspace-operational'))`);
  const sharedCloseVisible = await win.webContents.executeJavaScript(`Boolean(document.querySelector('.modal-panel .modal-close'))`);
  const modalGeometry = await win.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.modal-panel');
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width || window.innerWidth;
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      viewportWidth,
      viewportHeight,
      centerErrorX: Math.abs((rect.left + rect.right) / 2 - viewportWidth / 2),
      centerErrorY: Math.abs((rect.top + rect.bottom) / 2 - viewportHeight / 2)
    };
  })()`);
  const editedAlias = await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.modal-panel input[name="alias"]');
    if (!input) return '';
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setValue?.call(input, input.value + '-unsaved');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.modal-panel button')).find(button => button.textContent.trim() === 'Delete project from Rel.AI')?.click()`);
  await waitFor(win, `document.querySelector('.modal-inline-confirm-layer')`);
  const editDeleteOpen = await win.webContents.executeJavaScript(`(() => ({
    title: document.querySelector('.modal-title')?.textContent || '',
    alias: document.querySelector('.modal-panel input[name="alias"]')?.value || '',
    inlineConfirm: Boolean(document.querySelector('.modal-inline-confirm-layer'))
  }))()`);
  await win.webContents.executeJavaScript(`document.querySelector('.modal-inline-confirm-card .modal-actions .secondary')?.click()`);
  await waitFor(win, `!document.querySelector('.modal-inline-confirm-layer')`);
  const editAfterDeleteCancel = await win.webContents.executeJavaScript(`(() => ({
    title: document.querySelector('.modal-title')?.textContent || '',
    alias: document.querySelector('.modal-panel input[name="alias"]')?.value || ''
  }))()`);

  await win.webContents.executeJavaScript(`document.querySelector('.modal-close')?.click()`);
  await waitFor(win, `document.querySelector('.modal-inline-confirm-title')?.textContent === 'Discard changes?'`);
  const dirtyClosePrompted = await win.webContents.executeJavaScript(`Boolean(document.querySelector('.modal-inline-confirm-card'))`);
  await win.webContents.executeJavaScript(`document.querySelector('.modal-inline-confirm-card .modal-actions .secondary')?.click()`);
  await waitFor(win, `!document.querySelector('.modal-inline-confirm-layer')`);
  const editAfterDiscardCancel = await win.webContents.executeJavaScript(`(() => ({
    title: document.querySelector('.modal-title')?.textContent || '',
    alias: document.querySelector('.modal-panel input[name="alias"]')?.value || ''
  }))()`);

  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.modal-panel a')).find(link => link.textContent.trim() === 'View tasks')?.click()`);
  await waitFor(win, `document.querySelector('.modal-inline-confirm-title')?.textContent === 'Discard changes?'`);
  await win.webContents.executeJavaScript(`document.querySelector('.modal-inline-confirm-card .modal-actions .secondary')?.click()`);
  await waitFor(win, `!document.querySelector('.modal-inline-confirm-layer')`);
  const routeChangeCancelPreserved = await win.webContents.executeJavaScript(`location.hash === '#workspaces' && document.querySelector('.modal-title')?.textContent === 'Edit project'`);
  await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.modal-panel a')).find(link => link.textContent.trim() === 'View tasks')?.click()`);
  await waitFor(win, `document.querySelector('.modal-inline-confirm-card button.danger')`);
  await win.webContents.executeJavaScript(`document.querySelector('.modal-inline-confirm-card button.danger')?.click()`);
  await waitFor(win, `location.hash.startsWith('#tasks') && document.querySelectorAll('.task-row').length >= 9`);
  const routeChangeConfirmNavigated = await win.webContents.executeJavaScript(`location.hash.startsWith('#tasks')`);

  return {
    editDeleteCancelPreserved: editDeleteOpen.inlineConfirm
      && editDeleteOpen.title === 'Edit project'
      && editDeleteOpen.alias === editedAlias
      && editAfterDeleteCancel.title === 'Edit project'
      && editAfterDeleteCancel.alias === editedAlias,
    dirtyClosePrompted,
    dirtyCancelPreserved: editAfterDiscardCancel.title === 'Edit project' && editAfterDiscardCancel.alias === editedAlias,
    discardClosed: !await win.webContents.executeJavaScript(`Boolean(document.querySelector('#__relai-modal-backdrop'))`),
    editDetailsConsolidated,
    routeChangeCancelPreserved,
    routeChangeConfirmNavigated,
    sharedCloseVisible,
    modalGeometry
  };
}

async function measurePassiveRouteStability(win, mcpSession, navigationCounts, route) {
  await win.webContents.executeJavaScript(`(() => {
    window.removeEventListener('relai:route-mounted', window.__relaiPassiveRouteMountListener);
    window.__relaiPassiveRouteMounted = false;
    const expectedPath = ${JSON.stringify(route.hash)};
    window.__relaiPassiveRouteMountListener = event => {
      if (event.detail?.path !== expectedPath) return;
      window.__relaiPassiveRouteMounted = true;
      window.removeEventListener('relai:route-mounted', window.__relaiPassiveRouteMountListener);
      window.__relaiPassiveRouteMountListener = null;
    };
    window.addEventListener('relai:route-mounted', window.__relaiPassiveRouteMountListener);
    location.hash = ${JSON.stringify(`#${route.hash}`)};
  })()`);
  await waitFor(win, `window.__relaiPassiveRouteMounted === true && (${route.ready})`);
  const beforeNavigation = { ...navigationCounts };
  const captured = await win.webContents.executeJavaScript(`(() => {
    const routeRoot = document.getElementById('routeRoot');
    window.__relaiPassiveRouteNode = routeRoot?.firstElementChild || null;
    window.__relaiPassiveLoadingSeen = false;
    window.__relaiPassiveObserver?.disconnect();
    const loadingPattern = /Loading (?:preferences|application settings|advanced settings|connection details|diagnostics|skills|tools)/i;
    const containsLoading = node => {
      if (!(node instanceof Element)) return false;
      if (node.matches('.settings-loading,.connection-loading')) return true;
      if (node.querySelector('.settings-loading,.connection-loading')) return true;
      return loadingPattern.test(node.textContent || '');
    };
    window.__relaiPassiveObserver = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (containsLoading(node)) window.__relaiPassiveLoadingSeen = true;
        }
      }
    });
    if (routeRoot) window.__relaiPassiveObserver.observe(routeRoot, { childList: true, subtree: true });
    return Boolean(window.__relaiPassiveRouteNode);
  })()`);
  if (!captured) throw new Error(`Passive route probe could not capture #${route.hash}.`);
  const listed = await mcpSession.request('tools/list');
  if (listed.response.status !== 200) throw new Error(`Passive route MCP request failed on #${route.hash}: ${listed.response.status}`);
  await delay(500);
  const dom = await win.webContents.executeJavaScript(`(() => {
    const routeRoot = document.getElementById('routeRoot');
    const current = routeRoot?.firstElementChild || null;
    const result = {
      sameRouteNode: Boolean(current && current === window.__relaiPassiveRouteNode),
      loadingSeen: window.__relaiPassiveLoadingSeen === true,
      routeText: current?.textContent?.slice(0, 160) || ''
    };
    window.__relaiPassiveObserver?.disconnect();
    window.__relaiPassiveObserver = null;
    return result;
  })()`);
  return {
    route: route.hash,
    ...dom,
    mainFrameNavigationDelta: {
      didStartNavigation: navigationCounts.didStartNavigation - beforeNavigation.didStartNavigation,
      didNavigate: navigationCounts.didNavigate - beforeNavigation.didNavigate,
      didFinishLoad: navigationCounts.didFinishLoad - beforeNavigation.didFinishLoad
    }
  };
}

function expectedEventStreamClose(details) {
  if (details?.error !== 'net::ERR_FAILED') return false;
  try { return new URL(String(details.url || '')).pathname === '/events'; } catch { return false; }
}

async function exerciseNavigationControls(win, failures) {
  const scenarios = [
    { selector: '.nav a[data-nav-id="home"]', hash: '#home', ready: `document.querySelector('[data-home-react]')` },
    { selector: '.nav a[data-nav-id="tasks"]', hash: '#tasks', ready: `document.querySelector('[data-sessions-react]')` },
    { selector: '.nav a[data-nav-id="code"]', hash: '#code', ready: `document.querySelector('[data-code-react]')` },
    { selector: '.nav a[data-nav-id="workspaces"]', hash: '#workspaces', ready: `document.querySelector('[data-workspaces-react]')` },
    { selector: '.nav a[data-nav-id="activity"]', hash: '#activity', ready: `document.querySelector('.activity-master-detail')` },
    { opener: '[data-nav-accordion="system"] > summary', selector: '[data-nav-accordion="system"] .sidebar-subnav a[data-nav-id="processes"]', hash: '#processes', ready: `document.querySelector('[data-processes-react="true"]')` },
    { opener: '[data-nav-accordion="system"] > summary', selector: '[data-nav-accordion="system"] .sidebar-subnav a[data-nav-id="diagnostics"]', hash: '#diagnostics', ready: `document.querySelector('.diagnostic-page')` },
    { opener: '[data-nav-accordion="system"] > summary', selector: '[data-nav-accordion="system"] .sidebar-subnav a[data-nav-id="tools"]', hash: '#tools', ready: `document.querySelector('[data-tools-react="true"]')` },
    { opener: '[data-nav-accordion="system"] > summary', selector: '[data-nav-accordion="system"] .sidebar-subnav a[data-nav-id="usage"]', hash: '#usage', ready: `document.querySelector('[data-usage-react="true"]')` },
    { opener: '[data-nav-accordion="settings"] > summary', selector: '[data-nav-accordion="settings"] .sidebar-subnav a[data-nav-id="connection"]', hash: '#settings/connection', ready: `document.querySelector('#__settings-content .connection-page')` },
    { opener: '[data-nav-accordion="settings"] > summary', selector: '[data-nav-accordion="settings"] .sidebar-subnav a[data-nav-id="preferences"]', hash: '#settings', ready: `document.querySelector('#__settings-content .theme-switch') && !document.querySelector('.settings-loading')` },
    { opener: '[data-nav-accordion="settings"] > summary', selector: '[data-nav-accordion="settings"] .sidebar-subnav a[data-nav-id="application"]', hash: '#settings/application', ready: `document.querySelector('#__settings-content .application-update-panel') && !document.querySelector('.settings-loading')` },
    { opener: '[data-nav-accordion="settings"] > summary', selector: '[data-nav-accordion="settings"] .sidebar-subnav a[data-nav-id="about"]', hash: '#settings/about', ready: `document.querySelector('#__settings-content .about-product') && !document.querySelector('.settings-loading')` }
  ];
  const results = [];
  for (const scenario of scenarios) {
    if (scenario.opener) {
      const openerTarget = await win.webContents.executeJavaScript(`(() => {
        const opener = document.querySelector(${JSON.stringify(scenario.opener)});
        if (!opener || opener.parentElement?.open === true) return null;
        opener.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = opener.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
      })()`);
      if (openerTarget) {
        win.webContents.sendInputEvent({ type: 'mouseMove', x: openerTarget.x, y: openerTarget.y });
        win.webContents.sendInputEvent({ type: 'mouseDown', x: openerTarget.x, y: openerTarget.y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x: openerTarget.x, y: openerTarget.y, button: 'left', clickCount: 1 });
      }
      await waitFor(win, `document.querySelector(${JSON.stringify(scenario.opener)})?.parentElement?.open === true`);
    }
    const hitTarget = await win.webContents.executeJavaScript(`(() => {
      const control = document.querySelector(${JSON.stringify(scenario.selector)});
      if (!control) return null;
      control.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = control.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const hit = document.elementFromPoint(x, y);
      return { x, y, tag: hit?.tagName || '', label: hit?.textContent?.trim() || '', ownsControl: Boolean(hit && (hit === control || control.contains(hit))) };
    })()`);
    if (!hitTarget) throw new Error(`Navigation control is missing: ${scenario.selector}`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: hitTarget.x, y: hitTarget.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: hitTarget.x, y: hitTarget.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: hitTarget.x, y: hitTarget.y, button: 'left', clickCount: 1 });
    try {
      await waitFor(win, `location.hash === ${JSON.stringify(scenario.hash)} && (${scenario.ready})`);
    } catch (error) {
      const state = await win.webContents.executeJavaScript(`({ hash: location.hash, title: document.title, pageTitle: document.getElementById('pageTitle')?.textContent || '', content: document.getElementById('routeRoot')?.textContent?.slice(0, 300) || '' })`);
      throw new Error(`${error.message} hit=${JSON.stringify(hitTarget)} state=${JSON.stringify(state)} failures=${JSON.stringify(failures)}`, { cause: error });
    }
    results.push({ ...scenario, hitTarget, opened: true });
  }
  return results;
}


async function exerciseSkipLink(win) {
  win.show();
  win.focus();
  const results = [];
  for (const dirty of [false, true]) {
    for (const activation of ['keyboard', 'pointer']) {
      await win.webContents.executeJavaScript(`location.hash = '#tasks?workspace=app'`);
      await waitFor(win, `location.hash === '#tasks?workspace=app' && document.querySelector('.sessions-page')`);
      const before = await win.webContents.executeJavaScript(`(() => {
        const main = document.getElementById('main');
        const form = document.createElement('form');
        form.id = '__skip-link-draft';
        form.dataset.unsavedChanges = ${JSON.stringify(String(dirty))};
        const input = document.createElement('input');
        input.value = 'unsaved draft';
        form.appendChild(input);
        main.appendChild(form);
        window.__skipLinkRouteNode = document.querySelector('.sessions-page');
        const link = document.querySelector('.skip-link');
        link.focus();
        return { hash: location.hash, historyLength: history.length, title: document.title };
      })()`);
      if (activation === 'keyboard') {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      } else {
        await waitFor(win, `(() => {
          const rect = document.querySelector('.skip-link')?.getBoundingClientRect();
          return rect && rect.top >= 0 && rect.bottom <= innerHeight;
        })()`);
        const target = await win.webContents.executeJavaScript(`(() => {
          const link = document.querySelector('.skip-link');
          const rect = link.getBoundingClientRect();
          const x = Math.round(rect.left + rect.width / 2);
          const y = Math.round(rect.top + rect.height / 2);
          const hit = document.elementFromPoint(x, y);
          return { x, y, reachable: hit === link || link.contains(hit) };
        })()`);
        if (!target.reachable) throw new Error('Focused skip link must be reachable by pointer.');
        win.webContents.sendInputEvent({ type: 'mouseDown', x: target.x, y: target.y, button: 'left', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', x: target.x, y: target.y, button: 'left', clickCount: 1 });
      }
      await delay(100);
      const after = await win.webContents.executeJavaScript(`(() => {
        const form = document.getElementById('__skip-link-draft');
        const state = { hash: location.hash, historyLength: history.length, title: document.title,
          focused: document.activeElement?.id || '',
          sameRouteNode: document.querySelector('.sessions-page') === window.__skipLinkRouteNode,
          dirty: form?.dataset.unsavedChanges, draft: form?.querySelector('input')?.value,
          dialog: Boolean(document.querySelector('[role="dialog"], [role="alertdialog"]')) };
        form?.remove();
        delete window.__skipLinkRouteNode;
        return state;
      })()`);
      const result = { activation, dirty, before, after };
      results.push(result);
      if (after.focused !== 'main' || after.hash !== before.hash || after.historyLength !== before.historyLength
        || after.title !== before.title || !after.sameRouteNode || after.dialog
        || after.dirty !== String(dirty) || after.draft !== 'unsaved draft') {
        throw new Error(`Skip to content must preserve the current route and draft: ${JSON.stringify(result)}`);
      }
    }
  }
  return results;
}

async function waitForCapturePaint(win) {
  let timer;
  try {
    await Promise.race([
      win.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Capture paint did not settle within 5 seconds.')), 5000); })
    ]);
  } finally { clearTimeout(timer); }
}

async function waitFor(win, expression, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await win.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await delay(50);
  }
  const state = await win.webContents.executeJavaScript(`({ hash: location.hash, text: document.body.innerText.slice(0, 2000) })`);
  throw new Error(`Timed out waiting for: ${expression}; renderer=${JSON.stringify(state)}`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
