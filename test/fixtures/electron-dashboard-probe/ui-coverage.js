import fs from 'node:fs';
import path from 'node:path';
import { exerciseTooltipCoverage } from './tooltip-coverage.js';
import { exerciseSharedControlCoverage } from './shared-control-coverage.js';
import { UIUX_ROUTE_COVERAGE, UIUX_MANUAL_CHECKS } from '../../helpers/uiux-coverage-manifest.mjs';

export async function exerciseUIUXCoverage({ win, axePath, screenshotDir, auditAccessibility, waitFor, waitForCapturePaint }) {
  const routes = [];
  const extensionTabs = [];
  const accessibility = [];
  // This window has a fresh test-only profile. No real feature setting or
  // extension catalog is changed, and mutation endpoints are never invoked.
  await win.webContents.executeJavaScript(`(() => {
    window.__coverageOriginalFetch = window.fetch;
    window.__coverageOriginalDesktop = window.relaiDesktop;
    const installed = [
      { id: 'fixture.long-skill-identifier-for-reflow-and-unicode-測試', name: 'Fixture skill with a long readable title', version: '1.0.0', kind: 'skill', ready: true, description: 'Synthetic local coverage fixture.', permissions: [], publisher: 'Fixture publisher' },
      { id: 'fixture.command', name: 'Fixture command', version: '1.0.0', kind: 'cli', ready: false, missingCommands: ['fixture-command'], description: 'Setup-needed fixture.', permissions: [] }
    ];
    // Seed logs before any coverage route mounts, so the application's normal
    // history cache sees the synthetic dataset from its first coverage read.
    const entries = Array.from({ length: 160 }, (_, index) => ({ id: 'coverage-' + index, timestamp: new Date(Date.now() - index * 1000).toISOString(), tool: 'relai_read', status: 'completed', workspace: 'coverage-only', summary: 'Keyboard coverage event ' + index }));
    window.fetch = (...args) => {
      if (String(args[0]).includes('/api/logs')) return Promise.resolve(new Response(JSON.stringify({ ok: true, entries, page: { hasMore: false } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      if (String(args[0]).includes('/api/extensions')) return Promise.resolve(new Response(JSON.stringify({ ok: true, installed, catalog: installed.map(entry => ({ ...entry, installed: true, updateAvailable: false })), sources: [], installRoot: 'C:/fixture/extensions' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      return window.__coverageOriginalFetch(...args);
    };
    delete window.relaiDesktop;
    localStorage.setItem('relai_developer_feature_extensions_enabled', '1');
    window.dispatchEvent(new CustomEvent('relai:developer-feature-change', { detail: { feature: 'extensions', enabled: true } }));
  })()`);
  try {
    for (const theme of ['dark', 'light']) {
      for (const viewport of [{ name: 'desktop', width: 1180, height: 760, zoom: 1 }, { name: 'reflow-320', width: 1280, height: 900, zoom: 4 }]) {
        await win.webContents.setZoomFactor(viewport.zoom);
        win.setContentSize(viewport.width, viewport.height);
        for (const route of UIUX_ROUTE_COVERAGE) {
          await win.webContents.executeJavaScript(`(() => { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; location.hash = ${JSON.stringify('#' + route.route)}; })()`);
          await waitFor(win, `document.querySelector(${JSON.stringify(route.region)}) && !document.querySelector('.settings-loading, .extensions-loading-skeleton')`);
          await waitForCapturePaint(win);
          const result = await win.webContents.executeJavaScript(`(() => {
            const region = document.querySelector(${JSON.stringify(route.region)});
            const title = document.getElementById('pageTitle');
            const quick = document.getElementById('commandPaletteBtn');
            const overflow = [...document.querySelectorAll('main *')].filter(element => {
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && (rect.right > innerWidth + 2 || rect.left < -2) && getComputedStyle(element).position !== 'fixed';
            }).slice(0, 8).map(element => ({ tag: element.tagName, className: String(element.className), width: element.getBoundingClientRect().width }));
            return { hash: location.hash, title: title?.textContent.trim(), viewportWidth: innerWidth, viewportHeight: innerHeight,
              horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
              regionHasContent: Boolean(region?.textContent.trim()), quickNavigationName: quick?.getAttribute('aria-label') || '', overflow };
          })()`);
          const screenshot = path.join(screenshotDir, `coverage-${route.route.replaceAll('/', '-')}-${theme}-${viewport.name}.png`);
          fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
          routes.push({ route: route.route, theme, viewport: viewport.name, screenshot, ...result });
          // Audit every route in both themes. Reflow is measured separately so
          // axe is not mistaken for a substitute for geometry or manual checks.
          if (viewport.name === 'desktop') accessibility.push(await auditAccessibility(win, axePath, `${route.route}:${theme}`));
        }
        await win.webContents.executeJavaScript(`location.hash = '#extensions'`);
        await waitFor(win, `document.querySelector('[data-extension-tab="installed"]')`);
        for (const tab of ['installed', 'discover', 'sources', 'developer']) {
          await win.webContents.executeJavaScript(`document.querySelector('[data-extension-tab="${tab}"]').click()`);
          await waitFor(win, `document.querySelector('[data-extension-tab="${tab}"][aria-selected="true"]') && document.getElementById('extensions-panel-${tab}')`);
          await waitForCapturePaint(win);
          extensionTabs.push(await win.webContents.executeJavaScript(`({ tab: ${JSON.stringify(tab)}, theme: ${JSON.stringify(theme)}, viewport: ${JSON.stringify(viewport.name)}, horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, panelPresent: Boolean(document.getElementById('extensions-panel-${tab}')) })`));
          if (viewport.name === 'desktop') accessibility.push(await auditAccessibility(win, axePath, `extensions/${tab}:${theme}`));
        }
      }
    }
    const extensionSelection = await exerciseExtensionSelection(win, waitFor);
    const navigation = await exerciseNarrowNavigation(win, waitFor, waitForCapturePaint);
    const textSpacing = await exerciseTextSpacing(win, waitFor, waitForCapturePaint);
    const tooltipCoverage = await exerciseTooltipCoverage({ win, waitFor, waitForCapturePaint });
    const activityKeyboard = await exerciseActivityKeyboard(win, waitFor);
    const sharedControls = await exerciseSharedControlCoverage({ win, waitFor, waitForCapturePaint, screenshotDir });
    return { routes, extensionTabs, extensionSelection, navigation, textSpacing, activityKeyboard, tooltipCoverage, sharedControls, accessibility, manual: UIUX_MANUAL_CHECKS,
      runtime: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, arch: process.arch } };
  } finally {
    await win.webContents.executeJavaScript(`(() => { window.fetch = window.__coverageOriginalFetch; window.relaiDesktop = window.__coverageOriginalDesktop; delete window.__coverageOriginalFetch; delete window.__coverageOriginalDesktop; })()`);
  }
}

async function exerciseExtensionSelection(win, waitFor) {
  await win.webContents.setZoomFactor(1);
  win.setSize(1180, 760);
  await win.webContents.executeJavaScript(`document.querySelector('[data-extension-tab="installed"]').click()`);
  await waitFor(win, `document.querySelector('.extensions-search-input')`);
  const before = await win.webContents.executeJavaScript(`(() => {
    const search = document.querySelector('.extensions-search-input');
    const name = search.getAttribute('aria-label') || [...(search.labels || [])].map(label => label.textContent.trim()).join(' ');
    const skills = [...document.querySelectorAll('.extensions-filter-pill')].find(button => button.textContent.trim() === 'Skills');
    skills?.click();
    return { name, skillsPresent: Boolean(skills) };
  })()`);
  await waitFor(win, `[...document.querySelectorAll('.extensions-filter-pill')].find(button => button.textContent.trim() === 'Skills')?.getAttribute('aria-pressed') === 'true'`);
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('.extensions-filter-pill')].find(button => button.textContent.trim() === 'Skills').click()`);
  await waitFor(win, `[...document.querySelectorAll('.extensions-filter-pill')].find(button => button.textContent.trim() === 'All types')?.getAttribute('aria-pressed') === 'true'`);
  await win.webContents.executeJavaScript(`(() => { const search = document.querySelector('.extensions-search-input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, 'fixture'); search.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(win, `document.querySelector('.extensions-search-input')?.value === 'fixture'`);
  const afterName = await win.webContents.executeJavaScript(`(() => { const search = document.querySelector('.extensions-search-input'); return search.getAttribute('aria-label') || [...(search.labels || [])].map(label => label.textContent.trim()).join(' '); })()`);
  await win.webContents.executeJavaScript(`document.querySelector('[data-extension-tab="developer"]').click()`);
  await waitFor(win, `document.querySelector('input[type="radio"]')`);
  const radiosBefore = await win.webContents.executeJavaScript(`(() => { const radios = [...document.querySelectorAll('input[type="radio"]')]; (radios.find(input => input.checked) || radios[0]).focus(); return radios.map(input => ({ value: input.value, checked: input.checked })); })()`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
  await waitFor(win, `document.activeElement?.matches('input[type="radio"]') && document.activeElement.checked`);
  const radiosAfter = await win.webContents.executeJavaScript(`[...document.querySelectorAll('input[type="radio"]')].map(input => ({ value: input.value, checked: input.checked }))`);
  return { before, afterName, toggledBackToAll: true, radiosBefore, radiosAfter };
}

async function exerciseNarrowNavigation(win, waitFor, waitForCapturePaint) {
  const results = [];
  for (const width of [320, 375, 760, 761, 980]) {
    await win.webContents.setZoomFactor(2);
    win.setContentSize(width * 2, 900);
    await win.webContents.executeJavaScript(`location.hash = '#tasks'`);
    await waitFor(win, `document.querySelector('[data-sessions-react]')`);
    await waitForCapturePaint(win);
    for (const route of UIUX_ROUTE_COVERAGE.filter(item => ['processes', 'diagnostics', 'tools', 'usage'].includes(item.route) || item.route.startsWith('settings'))) {
      const found = await win.webContents.executeJavaScript(`(() => {
        for (const details of document.querySelectorAll('.mobile-nav details, .sidebar details')) details.open = true;
        const links = [...document.querySelectorAll('nav a, .sidebar a')].filter(link => link.getAttribute('href') === ${JSON.stringify('#' + route.route)});
        const link = links.find(item => { const rect = item.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(item).visibility !== 'hidden'; });
        if (!link) return false;
        link.focus(); link.click(); return true;
      })()`);
      if (found) await waitFor(win, `document.querySelector(${JSON.stringify(route.region)})`);
      results.push({ requestedWidth: width, route: route.route, found, actualWidth: await win.webContents.executeJavaScript('innerWidth'), quickNavigationName: await win.webContents.executeJavaScript(`document.getElementById('commandPaletteBtn')?.getAttribute('aria-label')`), shortcut: await win.webContents.executeJavaScript(`document.getElementById('commandPaletteBtn')?.getAttribute('aria-keyshortcuts')`) });
    }
  }
  return results;
}

async function exerciseTextSpacing(win, waitFor, waitForCapturePaint) {
  await win.webContents.setZoomFactor(2);
  win.setContentSize(640, 900);
  await win.webContents.executeJavaScript(`(() => {
    const style = document.createElement('style'); style.id = 'coverage-text-spacing';
    style.textContent = '* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-block-end: 2em !important; }';
    document.head.append(style);
  })()`);
  const results = [];
  try {
    for (const route of UIUX_ROUTE_COVERAGE.filter(item => ['tasks', 'workspaces', 'settings', 'extensions'].includes(item.route))) {
      await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify('#' + route.route)}`);
      await waitFor(win, `document.querySelector(${JSON.stringify(route.region)})`);
      await waitForCapturePaint(win);
      results.push(await win.webContents.executeJavaScript(`({ route: ${JSON.stringify(route.route)}, viewportWidth: innerWidth, horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 })`));
    }
  } finally { await win.webContents.executeJavaScript(`document.getElementById('coverage-text-spacing')?.remove()`); }
  return results;
}

async function exerciseActivityKeyboard(win, waitFor) {
  await win.webContents.setZoomFactor(1);
  win.setContentSize(1180, 760);
  await win.webContents.executeJavaScript(`(() => {
    window.__activityCoverageFetch = window.fetch;
    const entries = Array.from({ length: 160 }, (_, index) => ({ id: 'coverage-' + index, timestamp: new Date(Date.now() - index * 1000).toISOString(), tool: 'relai_read', status: 'completed', workspace: 'coverage-only', summary: 'Keyboard coverage event ' + index }));
    window.fetch = async (...args) => {
      if (String(args[0]).includes('/api/logs')) return new Response(JSON.stringify({ ok: true, entries, page: { hasMore: false } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      const response = await window.__activityCoverageFetch(...args);
      if (!String(args[0]).includes('/api/dashboard/v10')) return response;
      const data = await response.json();
      data.auditTail = { ...(data.auditTail || {}), entries };
      return new Response(JSON.stringify(data), { status: response.status, headers: response.headers });
    };
    location.hash = '#activity?workspace=coverage-only';
    window.dispatchEvent(new CustomEvent('relai:dashboard-refresh'));
  })()`);
  try {
    await waitFor(win, `document.querySelector('.activity-table')?.getAttribute('aria-rowcount') === '161'`);
    const before = await win.webContents.executeJavaScript(`(() => {
      document.querySelector('.activity-row-trigger').focus();
      return { mountedRows: document.querySelectorAll('.activity-data-row').length, rowCount: Number(document.querySelector('.activity-table').getAttribute('aria-rowcount')) };
    })()`);
    const visited = [];
    for (let index = 0; index < 160; index += 1) {
      await waitFor(win, `Number(document.activeElement?.closest('.activity-data-row')?.getAttribute('aria-rowindex')) === ${index + 2}`);
      visited.push(await win.webContents.executeJavaScript(`Number(document.activeElement.closest('.activity-data-row').getAttribute('aria-rowindex'))`));
      if (index < 159) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
      }
    }
    for (const [key, rowIndex] of [['Home', 2], ['End', 161], ['PageUp', 151], ['PageDown', 161]]) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
      await waitFor(win, `Number(document.activeElement?.closest('.activity-data-row')?.getAttribute('aria-rowindex')) === ${rowIndex}`);
    }
    const focusedBeforeTick = await win.webContents.executeJavaScript(`document.activeElement.closest('.activity-data-row').dataset.activityEventId`);
    await win.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('relai:clock-tick', { detail: { now: Date.now() + 1000 } }))`);
    const focusedAfterTick = await win.webContents.executeJavaScript(`document.activeElement?.closest('.activity-data-row')?.dataset.activityEventId`);
    // Retain the focused final row while pointer-scrolling elsewhere, then let
    // native Tab use that still-mounted origin before the blur releases it.
    await win.webContents.executeJavaScript(`(() => {
      window.__activityPinnedTrigger = document.activeElement;
      document.querySelector('.activity-list-pane').scrollTop = 0;
      const next = document.createElement('button');
      next.id = 'activity-coverage-next';
      next.textContent = 'Next fixture control';
      document.querySelector('.activity-table').after(next);
    })()`);
    await waitFor(win, `window.__activityPinnedTrigger?.isConnected && document.querySelector('.activity-list-pane').scrollTop === 0`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await waitFor(win, `document.activeElement?.id === 'activity-coverage-next'`);
    const offrangeTab = true;
    await win.webContents.executeJavaScript(`document.getElementById('activity-coverage-next').remove(); delete window.__activityPinnedTrigger;`);
    return { before, visited, focusedBeforeTick, focusedAfterTick, offrangeTab };
  } finally {
    await win.webContents.executeJavaScript(`(() => { window.fetch = window.__activityCoverageFetch; delete window.__activityCoverageFetch; })()`);
  }
}
