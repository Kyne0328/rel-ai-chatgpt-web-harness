import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Icon } from '../../../src/ui/components/icons.js';

const h = React.createElement;
const specimenId = 'shared-control-coverage';
const specimens = renderToStaticMarkup(h('section', {
  id: specimenId, className: 'card', 'aria-label': 'Synthetic shared control specimens',
  style: { position: 'fixed', top: 16, left: 260, right: 24, zIndex: 1000, padding: 16, display: 'grid', gap: 12 }
},
  h('span', { id: 'shared-token-reference', hidden: true, style: {
    color: 'var(--ui-text-disabled)', backgroundColor: 'var(--ui-disabled-background)',
    border: '1px solid var(--ui-disabled-border)', outlineColor: 'var(--ui-focus-ring)'
  } }),
  h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
    h('button', { id: 'shared-disabled', type: 'button', disabled: true }, 'Disabled neutral'),
    h('button', { id: 'shared-primary-disabled', type: 'button', className: 'primary', disabled: true }, 'Disabled primary'),
    h('button', { id: 'shared-danger-disabled', type: 'button', className: 'danger', disabled: true }, 'Disabled danger'),
    h('button', { id: 'shared-aria-disabled', type: 'button', className: 'primary', 'aria-disabled': 'true' }, 'Unavailable primary'),
    h('button', { id: 'shared-busy', type: 'button', className: 'primary', disabled: true, 'aria-busy': 'true' }, 'Working'),
    h('button', { id: 'shared-danger', type: 'button', className: 'danger' }, 'Synthetic danger specimen')
  ),
  h('div', { style: { display: 'flex', gap: 8 } },
    h('button', { id: 'shared-focus-before', type: 'button' }, 'Focus starting point'),
    h('button', { id: 'shared-focus', type: 'button', className: 'secondary' }, 'Keyboard focus specimen')
  ),
  h('div', { style: { display: 'flex', gap: 8 } },
    [16, 24, 32].map(size => h('button', {
      key: size, type: 'button', className: 'command-trigger', 'aria-label': 'Icon size ' + size
    }, h(Icon, { name: 'puzzle', size, strokeWidth: 2, 'data-shared-icon-size': size })))
  )
));

// Presentation-only specimens have no handlers or submit behavior. Routes and
// the blank Project dialog use production components; no mutation is submitted.
export async function exerciseSharedControlCoverage({ win, waitFor, waitForCapturePaint, screenshotDir }) {
  const original = {
    size: win.getContentSize(), zoom: win.webContents.getZoomFactor(), visible: win.isVisible(),
    page: await win.webContents.executeJavaScript(`({ hash: location.hash, theme: document.documentElement.dataset.theme })`)
  };
  const report = { themes: [], overlays: [], projectNavigation: null, checks: [], failures: [] };
  const check = (name, passed, detail) => {
    report.checks.push({ name, passed: Boolean(passed), detail });
    if (!passed) report.failures.push(name);
  };
  const evaluate = source => win.webContents.executeJavaScript(source);
  const key = keyCode => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    if (keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: String.fromCharCode(13) });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  };
  const paint = async () => {
    await waitForCapturePaint(win);
    await evaluate(`Promise.all(document.getAnimations().filter(animation =>
      animation.effect?.target?.closest?.('#${specimenId}') &&
      Number.isFinite(animation.effect.getComputedTiming().endTime)
    ).map(animation => animation.finished.catch(() => {})))`);
  };
  const styleOf = id => evaluate(`(() => {
    const element = document.getElementById(${JSON.stringify(id)});
    const style = getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor, border: style.borderTopColor,
      cursor: style.cursor, opacity: style.opacity, transform: style.transform, shadow: style.boxShadow,
      height: element.getBoundingClientRect().height, hovered: element.matches(':hover'),
      focused: element === document.activeElement, focusVisible: element.matches(':focus-visible'),
      outlineColor: style.outlineColor, outlineWidth: parseFloat(style.outlineWidth), outlineStyle: style.outlineStyle };
  })()`);
  const colorsEqual = (left, right) => ['color', 'background', 'border', 'opacity'].every(key => left[key] === right[key]);
  const mouse = async (id, type) => {
    const center = await evaluate(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    win.webContents.sendInputEvent({ type, ...center, ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) });
    await paint();
  };
  win.show();
  win.focus();
  await win.webContents.setZoomFactor(1);
  win.setContentSize(1180, 760);
  try {
    await evaluate(String.raw`(() => {
      window.__sharedControlsFetch = window.fetch;
      window.__sharedControlsRequests = [];
      const fixture = {"session":{"work_id":"shared-controls-retained","title":"Shared controls retained fixture","workspace":"shared-controls-fixture","status":"completed","changedFiles":["src/controls.js"],"events":[]},"files":{"ok":true,"work_id":"shared-controls-retained","workspace":"shared-controls-fixture","workspaceMode":"visible","integrationStatus":"not_applicable","status":"completed","readOnly":true,"writable":false,"files":["src/controls.js"],"changedFiles":["src/controls.js"],"changedFileStatuses":{"src/controls.js":{"code":"M","label":"Modified","tone":"warning"}},"changedFileCount":1,"fileCount":1,"historyMode":"live","historyAvailable":true,"commitHead":"","commitHeads":[],"commitSource":"","truncated":false},"diff":{"ok":true,"work_id":"shared-controls-retained","workspace":"shared-controls-fixture","path":"src/controls.js","content":"export const fixture = true;\n","baseContent":"export const fixture = false;\n","sha256":"1111111111111111111111111111111111111111111111111111111111111111","language":"javascript","writable":false,"readOnly":true,"historyMode":"live","commitHead":""}};
      window.fetch = (input, options) => {
        const url = new URL(String(input?.url || input), location.href);
        const method = String(options?.method || input?.method || 'GET').toUpperCase();
        const task = url.searchParams.get('task');
        if (method === 'GET' && task === fixture.session.work_id) {
          const responses = {
            '/api/tasks/session': { ok: true, session: fixture.session },
            '/api/tasks/files': fixture.files,
            '/api/tasks/diff': fixture.diff
          };
          if (Object.hasOwn(responses, url.pathname)) {
            window.__sharedControlsRequests.push({ path: url.pathname, task, file: url.searchParams.get('file') });
            return Promise.resolve(new Response(JSON.stringify(responses[url.pathname]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
          }
        }
        return window.__sharedControlsFetch(input, options);
      };
    })()`);
    for (const theme of ['dark', 'light']) {
      await evaluate(`(() => { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; location.hash = '#code?task=shared-controls-retained&file=src%2Fcontrols.js'; })()`);
      let fieldsReady = true;
      try {
        await waitFor(win, `document.querySelector('[data-code-task]')?.value === 'shared-controls-retained' && document.querySelector('[data-code-search]') && document.querySelector('[data-code-file="src/controls.js"]')`, 5000);
      } catch (error) {
        if (!String(error.message).startsWith('Timed out waiting for:')) throw error;
        fieldsReady = false;
        const context = await evaluate(`({ hash: location.hash, title: document.getElementById('pageTitle')?.textContent, content: document.getElementById('routeRoot')?.textContent?.slice(0, 1000), requests: window.__sharedControlsRequests })`);
        check(theme + ': retained Changes fixture mounts actual fields', false, { error: error.message, context });
      }
      if (fieldsReady) check(theme + ': retained Changes fixture mounts actual fields', true);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
      await evaluate(`document.activeElement?.blur()`);
      await waitForCapturePaint(win);
      const fields = await evaluate(`(${measureChangesFields.toString()})(document, getComputedStyle)`);
      check(theme + ': Changes has enabled task and file-filter fields', fields.some(field => field.id === 'codeTaskSelect') && fields.some(field => field.search), fields);
      for (const field of fields) {
        check(theme + ': enabled ' + field.name + ' boundary is at least 3:1 against adjacent fills',
          field.borderWidth > 0 && field.insideRatio >= 3 && field.outsideRatio >= 3, field);
      }

      await evaluate(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(specimens)})`);
      await paint();
      const baseline = await styleOf('shared-disabled');
      const tokens = await styleOf('shared-token-reference');
      check(theme + ': disabled baseline uses semantic availability colors', colorsEqual(baseline, tokens) && baseline.height >= 44, { baseline, tokens });
      const disabled = [];
      for (const id of ['shared-primary-disabled', 'shared-danger-disabled', 'shared-aria-disabled']) {
        await mouse(id, 'mouseMove');
        const hover = await styleOf(id);
        await mouse(id, 'mouseDown');
        const active = await styleOf(id);
        await mouse(id, 'mouseUp');
        check(theme + ': ' + id + ' hover/press preserves disabled presentation',
          hover.hovered && colorsEqual(hover, baseline) && colorsEqual(active, baseline) &&
          hover.transform === 'none' && active.transform === 'none' && active.shadow === 'none' &&
          hover.cursor === 'not-allowed', { hover, active, baseline });
        disabled.push({ id, hover, active });
      }
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
      await paint();
      const danger = await styleOf('shared-danger');
      await mouse('shared-danger', 'mouseMove');
      const dangerHover = await styleOf('shared-danger');
      await mouse('shared-danger', 'mouseDown');
      const dangerActive = await styleOf('shared-danger');
      await mouse('shared-danger', 'mouseUp');
      check(theme + ': danger hover and press retain semantic danger colors',
        dangerHover.hovered && dangerHover.background === danger.background && dangerHover.color === danger.color &&
        dangerHover.border === danger.color && dangerActive.background === danger.background && dangerActive.color === danger.color,
        { danger, dangerHover, dangerActive });
      const busy = await styleOf('shared-busy');
      await mouse('shared-busy', 'mouseDown');
      const busyPressed = await styleOf('shared-busy');
      await mouse('shared-busy', 'mouseUp');
      check(theme + ': busy disabled control stays unavailable with progress feedback',
        colorsEqual(busy, baseline) && colorsEqual(busyPressed, baseline) && busy.cursor === 'progress' && busyPressed.transform === 'none',
        { busy, busyPressed });
      await evaluate(`document.getElementById('shared-focus-before').focus()`);
      key('Tab');
      await waitFor(win, `document.activeElement?.id === 'shared-focus'`);
      const focus = await styleOf('shared-focus');
      check(theme + ': keyboard focus has a visible outline and normal 44px target',
        focus.focusVisible && focus.outlineWidth >= 2 && focus.outlineStyle !== 'none' && focus.outlineColor === tokens.outlineColor && focus.height >= 44, focus);
      const icons = await evaluate(`[...document.querySelectorAll('[data-shared-icon-size]')].map(icon => {
        const style = getComputedStyle(icon), rect = icon.getBoundingClientRect();
        return { requested: Number(icon.dataset.sharedIconSize), width: rect.width, height: rect.height,
          strokeWidth: parseFloat(style.strokeWidth), decorative: icon.getAttribute('aria-hidden') === 'true' };
      })`);
      check(theme + ': explicit Icon sizes survive production command-trigger CSS',
        icons.length === 3 && icons.every(icon => icon.width === icon.requested && icon.height === icon.requested && icon.strokeWidth === 2 && icon.decorative), icons);
      report.themes.push({ theme, fields, baseline, disabled, danger, dangerHover, dangerActive, busy, focus, icons });
      await evaluate(`document.getElementById('${specimenId}').remove()`);

      try {
      await evaluate(`location.hash = '#workspaces'`);
      await waitFor(win, `document.querySelector('.workspace-grid') && [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Add project')`);
      await waitForCapturePaint(win);
      win.focus();
      win.webContents.focus();
      await evaluate(`(() => {
        const opener = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Add project');
        window.__sharedCoverageProjectOpener = opener;
        window.__sharedControlsEnter = null;
        opener.addEventListener('keypress', event => {
          window.__sharedControlsEnter = { trusted: event.isTrusted, charCode: event.charCode, key: event.key };
        }, { once: true });
        opener.focus();
      })()`);
      await waitFor(win, `document.hasFocus() && document.activeElement === window.__sharedCoverageProjectOpener`);
      check(theme + ': Add project has keyboard focus before activation', true);
      key('Enter');
      await waitFor(win, `document.querySelector('.modal-title')?.textContent === 'Create project' && window.__sharedControlsEnter?.trusted === true && window.__sharedControlsEnter?.charCode === 13`);
      await waitForCapturePaint(win);
      const overlay = await evaluate(`(() => {
        const panel = document.querySelector('.modal-panel'), rect = panel.getBoundingClientRect();
        return { theme: ${JSON.stringify(theme)}, keyboard: window.__sharedControlsEnter, role: panel.getAttribute('role'), radius: getComputedStyle(panel).borderRadius,
          left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          viewportWidth: innerWidth, viewportHeight: innerHeight,
          focusedInside: panel.contains(document.activeElement), inlineConfirmation: Boolean(document.querySelector('.modal-inline-confirm-layer')) };
      })()`);
      if (screenshotDir) {
        overlay.screenshot = path.join(screenshotDir, 'shared-project-overlay-' + theme + '.png');
        fs.writeFileSync(overlay.screenshot, (await win.webContents.capturePage()).toPNG());
      }
      check(theme + ': shared Project overlay is contained with initial focus',
        overlay.role === 'dialog' && overlay.focusedInside && !overlay.inlineConfirmation &&
        overlay.left >= 0 && overlay.right <= overlay.viewportWidth && overlay.top >= 0 && overlay.bottom <= overlay.viewportHeight, overlay);
      key('Escape');
      await waitFor(win, `!document.querySelector('.modal-panel')`);
      // Radix restores focus after dialog teardown; verify the outcome, not the interim frame.
      await waitFor(win, `document.activeElement === window.__sharedCoverageProjectOpener`).catch(() => {});
      overlay.focusRestored = await evaluate(`document.activeElement === window.__sharedCoverageProjectOpener`);
      check(theme + ': clean Project Escape restores opener focus', overlay.focusRestored, overlay);
      report.overlays.push(overlay);
      await evaluate(`delete window.__sharedCoverageProjectOpener`);
      } catch (error) {
        if (!String(error.message).startsWith('Timed out waiting for:')) throw error;
        report.overlays.push({ theme, optionalCaptureError: error.message });
        const closing = await evaluate(`(() => {
          const owned = window.__sharedCoverageProjectOpener && document.querySelector('.modal-title')?.textContent === 'Create project';
          if (owned) document.querySelector('.modal-panel .modal-close')?.click();
          delete window.__sharedCoverageProjectOpener;
          return Boolean(owned);
        })()`);
        if (closing) await waitFor(win, `!document.querySelector('.modal-panel')`);
      }
    }

    await win.webContents.setZoomFactor(4);
    win.setContentSize(1280, 900);
    await evaluate(`location.hash = '#home'`);
    await waitFor(win, `document.querySelector('.mobile-nav [data-nav-id="home"][aria-current="page"]')`);
    await evaluate(`location.hash = '#workspaces'`);
    await waitFor(win, `document.querySelector('.workspace-grid') && document.getElementById('pageTitle')?.textContent === 'Projects'`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
    await waitForCapturePaint(win);
    const navigation = await evaluate(`(() => {
      const links = [...document.querySelectorAll('.mobile-nav > a')].map(link => ({
        id: link.dataset.navId, current: link.getAttribute('aria-current'), active: link.classList.contains('active'),
        hovered: link.matches(':hover'), focused: link === document.activeElement, background: getComputedStyle(link).backgroundColor
      }));
      const more = document.querySelector('.mobile-nav-more');
      const add = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Add project');
      add.focus(); // Browser-default focus scrolling; do not manually reveal the target.
      return { viewportWidth: innerWidth, links, moreActive: more.classList.contains('active') };
    })()`);
    await waitForCapturePaint(win);
    navigation.addProject = await evaluate(`(() => {
      const button = document.activeElement, r = button.getBoundingClientRect();
      const nav = document.querySelector('.mobile-nav').getBoundingClientRect();
      const topbar = document.querySelector('.topbar').getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { label: button.textContent.trim(), top: r.top, bottom: r.bottom, navTop: nav.top,
        topbarBottom: topbar.bottom, viewportHeight: innerHeight, centerUnobscured: Boolean(hit && button.contains(hit)),
        aboveNavigation: r.bottom <= nav.top + 1, belowHeader: r.top >= topbar.bottom - 1 };
    })()`);
    check('320px Projects direct route marks only Projects current',
      navigation.viewportWidth === 320 && navigation.links.filter(link => link.current === 'page').map(link => link.id).join() === 'workspaces' &&
      navigation.links.find(link => link.id === 'workspaces')?.active && !navigation.moreActive, navigation);
    check('320px browser focus scrolling reveals Add project above fixed navigation',
      navigation.addProject.label === 'Add project' && navigation.addProject.centerUnobscured && navigation.addProject.aboveNavigation && navigation.addProject.belowHeader, navigation.addProject);
    report.projectNavigation = navigation;
    return report;
  } catch (error) {
    report.error = error?.stack || String(error);
    throw error;
  } finally {
    // Persist measured outcomes before cleanup, including on a late independent failure.
    if (screenshotDir) fs.writeFileSync(path.join(screenshotDir, 'shared-controls.json'), JSON.stringify(report, null, 2));
    report.fixtureRequests = await evaluate(`window.__sharedControlsRequests || []`);
    report.lastProjectKeyboard = await evaluate(`({ focused: document.hasFocus(), active: document.activeElement?.outerHTML, enter: window.__sharedControlsEnter })`);
    if (screenshotDir) fs.writeFileSync(path.join(screenshotDir, 'shared-controls.json'), JSON.stringify(report, null, 2));
    // Close only the untouched dialog opened by this helper, via its real close
    // policy. Never dismiss another dialog or discard a draft.
    await evaluate(`(() => {
      document.getElementById('${specimenId}')?.remove();
      if (window.__sharedCoverageProjectOpener && document.querySelector('.modal-title')?.textContent === 'Create project') document.querySelector('.modal-panel .modal-close')?.click();
      delete window.__sharedCoverageProjectOpener;
      if (window.__sharedControlsFetch) window.fetch = window.__sharedControlsFetch;
      delete window.__sharedControlsFetch;
      delete window.__sharedControlsRequests;
      delete window.__sharedControlsEnter;
      if (${JSON.stringify(original.page.theme)} === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = ${JSON.stringify(original.page.theme)};
      location.hash = ${JSON.stringify(original.page.hash)};
    })()`);
    await win.webContents.setZoomFactor(original.zoom);
    win.setContentSize(...original.size);
    if (!original.visible) win.hide();
  }
}

function measureChangesFields(document, getComputedStyle) {
  const rgba = value => {
    const match = /^rgba?\(([^)]+)\)$/.exec(value);
    if (!match) throw new Error('Unsupported computed color: ' + value);
    const values = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [values[0], values[1], values[2], values[3] ?? 1];
  };
  const over = (foreground, background) => {
    const alpha = foreground[3] + background[3] * (1 - foreground[3]);
    return [0, 1, 2].map(index => alpha ? (foreground[index] * foreground[3] + background[index] * background[3] * (1 - foreground[3])) / alpha : 0).concat(alpha);
  };
  const background = element => element ? over(rgba(getComputedStyle(element).backgroundColor), background(element.parentElement)) : [255, 255, 255, 1];
  const luminance = rgb => rgb.slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05);
  return [...document.querySelectorAll('.code-task-control select, .code-toolbar-actions select, .code-explorer-head input')]
    .filter(field => !field.disabled && field.getBoundingClientRect().width > 0)
    .map(field => {
      const style = getComputedStyle(field), inside = background(field), outside = background(field.parentElement);
      const border = over(rgba(style.borderTopColor), inside);
      return { id: field.id, search: field.matches('[data-code-search]'),
        name: field.getAttribute('aria-label') || [...(field.labels || [])].map(label => label.textContent.trim()).join(' '),
        borderWidth: parseFloat(style.borderTopWidth), borderColor: style.borderTopColor, fill: inside, outside,
        insideRatio: contrast(border, inside), outsideRatio: contrast(border, outside) };
    });
}
