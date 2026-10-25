import assert from 'node:assert/strict';

// All data and bridge methods here are test-window fixtures. No operational
// mutation endpoint, native install, restart or process stop is invoked.
export async function exerciseTooltipCoverage({ win, waitFor, waitForCapturePaint }) {
  const size = win.getContentSize();
  const zoom = win.webContents.getZoomFactor();
  const visible = win.isVisible();
  win.show();
  win.focus();
  await win.webContents.setZoomFactor(1);
  win.setContentSize(1180, 760);
  await win.webContents.executeJavaScript(`(() => {
    window.__tooltipCoverageDesktop = window.relaiDesktop;
    window.__tooltipCoverageFetch = window.fetch;
    const hour = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString().slice(0, 13);
    const useCases = ['explore', 'edit', 'execute', 'validate', 'browser', 'desktop', 'review_recover', 'publish', 'other'];
    const matrix = ['bugfix', 'feature'].flatMap(intent => useCases.map(useCase => ({ hour, intent, useCase, toolCalls: 1, successes: 1, failures: 0, executionMs: 10 })));
    window.relaiDesktop = {
      getLocalUsage: async month => {
        const current = hour.startsWith(month);
        const total = current ? matrix.length : 0;
        return { month, totals: { requests: total, toolCalls: total, successes: total, failures: 0, executionMs: total * 10, activeDays: current ? 1 : 0 },
          series: current ? [{ hour, requests: total, toolCalls: total, successes: total, failures: 0, executionMs: total * 10 }] : [],
          activityMatrixSeries: current ? matrix : [] };
      }
    };
    location.hash = '#usage';
  })()`);
  const results = { themes: [], edges: [], diagnostics: null };
  try {
    await waitFor(win, `document.querySelectorAll('.analytics-matrix-bubble').length === 18`);
    for (const theme of ['dark', 'light']) {
      await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      const metric = await exerciseTrigger('.usage-metric-help-trigger', 0);
      const matrix = await exerciseTrigger('.analytics-matrix-bubble', 0);
      const chart = await win.webContents.executeJavaScript(`(() => {
        const table = document.querySelector('.analytics-categorical-matrix table');
        const triggers = [...document.querySelectorAll('.analytics-matrix-bubble')];
        triggers[0].focus();
        return { caption: table?.caption?.textContent, values: [...(table?.querySelectorAll('td') || [])].map(node => Number(node.textContent)), names: triggers.map(node => node.getAttribute('aria-label')), initial: document.activeElement?.getAttribute('aria-label') };
      })()`);
      key('Right');
      await waitFor(win, `document.activeElement?.matches('.analytics-matrix-bubble') && document.activeElement.getAttribute('aria-label') !== ${JSON.stringify(chart.initial)}`);
      const arrowTarget = await win.webContents.executeJavaScript(`document.activeElement.getAttribute('aria-label')`);
      assert.equal(chart.values.length, 18, 'Matrix table must retain every populated value');
      assert.equal(chart.values.reduce((sum, value) => sum + value, 0), 18);
      assert.ok(chart.names.every(name => name && name.includes('action')), 'Matrix names must retain action values');
      key('Escape');
      results.themes.push({ theme, metric, matrix, chart, arrowTarget });
    }

    await win.webContents.setZoomFactor(4);
    win.setContentSize(1280, 900);
    for (const [kind, selector, indices] of [['metric', '.usage-metric-help-trigger', [0, 3]], ['matrix', '.analytics-matrix-bubble', [0, 8, 9, 17]]]) {
      for (const index of indices) {
        await activate(selector, index);
        const geometry = await measure();
        assert.ok(geometry.visible && geometry.anchored, `${kind} tooltip at edge ${index} must be visible beside its trigger: ${JSON.stringify(geometry)}`);
        assert.ok(geometry.contained, `${kind} tooltip at edge ${index} must fit its viewport`);
        assert.equal(geometry.viewportWidth, 320);
        key('Escape');
        await waitFor(win, `document.getElementById(window.__tooltipActiveTrigger.getAttribute('aria-describedby')).hidden`);
        results.edges.push({ kind, index, ...geometry });
      }
    }
    // A focused cell can be scrolled out of a local viewport without losing
    // focus. Its explanation must not float elsewhere on the page.
    await activate('.analytics-matrix-bubble', 0);
    await win.webContents.executeJavaScript(`document.querySelector('.usage-matrix-scroll').scrollLeft = document.querySelector('.usage-matrix-scroll').scrollWidth`);
    await waitFor(win, `document.getElementById(window.__tooltipActiveTrigger.getAttribute('aria-describedby')).hidden`);
    results.clippedAnchorDismissed = true;

    await win.webContents.setZoomFactor(1);
    win.setContentSize(1180, 760);
    await win.webContents.executeJavaScript(`(() => {
      const startedAt = new Date(Date.now() - 1000).toISOString();
      const entry = { id: 'tooltip-diagnostic', eventId: 'tooltip-diagnostic', timestamp: startedAt, tool: 'relai_read', workspace: 'tooltip-fixture', status: 'running', summary: 'Tooltip diagnostics fixture',
        metadata: { timeline: { phase: 'queued', phaseStartedAt: startedAt, lastProgressAt: startedAt, executed: false, deadlineKind: 'admission', blocking: { owner: 'Synthetic workspace writer' }, phases: [{ phase: 'queued', startedAt, durationMs: 1000 }] } } };
      window.fetch = async (...args) => {
        const response = await window.__tooltipCoverageFetch(...args);
        if (!String(args[0]).includes('/api/dashboard/v10')) return response;
        const data = await response.json();
        data.auditTail = { ...(data.auditTail || {}), entries: [...(data.auditTail?.entries || []).filter(row => row.id !== entry.id), entry] };
        return new Response(JSON.stringify(data), { status: response.status, headers: response.headers });
      };
      location.hash = '#activity?workspace=tooltip-fixture&time=all';
      window.dispatchEvent(new CustomEvent('relai:dashboard-refresh'));
    })()`);
    // Activity derives a stable hashed DOM identity rather than exposing source IDs.
    const diagnosticTrigger = `[...document.querySelectorAll('.activity-row-trigger')].find(button => button.textContent?.includes('Tooltip diagnostics fixture'))`;
    await waitFor(win, diagnosticTrigger);
    await win.webContents.executeJavaScript(`(${diagnosticTrigger}).click()`);
    await waitFor(win, `document.querySelector('.operation-diagnostics-help-trigger')`);
    results.diagnostics = await exerciseTrigger('.operation-diagnostics-help-trigger', 0);
    return results;
  } finally {
    await win.webContents.executeJavaScript(`(() => {
      window.fetch = window.__tooltipCoverageFetch;
      window.relaiDesktop = window.__tooltipCoverageDesktop;
      delete window.__tooltipCoverageFetch;
      delete window.__tooltipCoverageDesktop;
      delete window.__tooltipActiveTrigger;
      window.dispatchEvent(new CustomEvent('relai:dashboard-refresh'));
    })()`);
    await win.webContents.setZoomFactor(zoom);
    win.setContentSize(...size);
    if (!visible) win.hide();
  }

  function key(keyCode) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  }
  async function activate(selector, index) {
    await win.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      document.activeElement?.blur();
      trigger.scrollIntoView({ block: 'center', inline: 'nearest' });
      window.__tooltipActiveTrigger = trigger;
    })()`);
    await waitForCapturePaint(win);
    win.focus();
    win.webContents.focus();
    await waitFor(win, `document.hasFocus()`);
    await win.webContents.executeJavaScript(`window.__tooltipActiveTrigger.focus()`);
    await waitFor(win, `(() => { const popup = document.getElementById(window.__tooltipActiveTrigger.getAttribute('aria-describedby')); return popup && !popup.hidden && getComputedStyle(popup).visibility === 'visible' && popup.getBoundingClientRect().width > 0; })()`);
    await waitForCapturePaint(win);
  }
  async function measure() {
    return win.webContents.executeJavaScript(`(() => {
      const trigger = window.__tooltipActiveTrigger;
      const popup = document.getElementById(trigger.getAttribute('aria-describedby'));
      const box = element => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      const anchor = box(trigger), tooltip = box(popup);
      const verticalDistance = Math.max(0, tooltip.top - anchor.bottom, anchor.top - tooltip.bottom);
      const visible = !popup.hidden && getComputedStyle(popup).visibility === 'visible' && tooltip.width > 0 && tooltip.height > 0;
      return { anchor, tooltip, hidden: popup.hidden, visible, role: popup.getAttribute('role'), viewportWidth: innerWidth,
        anchored: visible && tooltip.right > anchor.left && tooltip.left < anchor.right && verticalDistance <= 2,
        contained: tooltip.left >= -1 && tooltip.top >= -1 && tooltip.right <= innerWidth + 1 && tooltip.bottom <= innerHeight + 1 };
    })()`);
  }
  async function exerciseTrigger(selector, index) {
    await activate(selector, index);
    const initial = await measure();
    assert.equal(initial.role, 'tooltip');
    assert.ok(initial.visible && initial.anchored, `Tooltip must be visible beside its trigger: ${JSON.stringify(initial)}`);
    assert.ok(initial.contained, 'Tooltip must remain inside viewport');
    key('Escape');
    await waitFor(win, `document.getElementById(window.__tooltipActiveTrigger.getAttribute('aria-describedby')).hidden`);
    const focusPreserved = await win.webContents.executeJavaScript(`document.activeElement === window.__tooltipActiveTrigger`);
    assert.equal(focusPreserved, true, 'Escape must preserve trigger focus');

    // Hover without focus so focus persistence cannot hide a broken transfer.
    await win.webContents.executeJavaScript(`document.activeElement.blur()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
    await new Promise(resolve => setTimeout(resolve, 220));
    const center = { x: Math.round(initial.anchor.left + initial.anchor.width / 2), y: Math.round(initial.anchor.top + initial.anchor.height / 2) };
    win.webContents.sendInputEvent({ type: 'mouseMove', ...center });
    await waitFor(win, `document.getElementById(window.__tooltipActiveTrigger.getAttribute('aria-describedby')).hidden === false`);
    const hovered = await measure();
    assert.ok(hovered.visible && hovered.anchored, `Hovered tooltip must stay anchored: ${JSON.stringify(hovered)}`);
    const below = hovered.tooltip.top >= hovered.anchor.bottom - 1;
    const overlapLeft = Math.max(hovered.anchor.left, hovered.tooltip.left);
    const overlapRight = Math.min(hovered.anchor.right, hovered.tooltip.right);
    const x = Math.round((overlapLeft + overlapRight) / 2);
    const gap = below ? hovered.tooltip.top - hovered.anchor.bottom : hovered.anchor.top - hovered.tooltip.bottom;
    const seam = below
      ? (gap > 1 ? (hovered.anchor.bottom + hovered.tooltip.top) / 2 : hovered.tooltip.top + 1)
      : (gap > 1 ? (hovered.anchor.top + hovered.tooltip.bottom) / 2 : hovered.tooltip.bottom - 1);
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y: Math.round(seam) });
    // Deliberately slower than the close grace; this verifies continuous hover,
    // rather than relying on an arbitrary fast mouse movement in the fixture.
    await new Promise(resolve => setTimeout(resolve, 300));
    const seamVisible = await win.webContents.executeJavaScript(`!document.getElementById(window.__tooltipActiveTrigger.getAttribute('aria-describedby')).hidden`);
    assert.equal(seamVisible, true, 'Slow pointer transfer must keep the tooltip visible');
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y: Math.round(hovered.tooltip.top + hovered.tooltip.height / 2) });
    await new Promise(resolve => setTimeout(resolve, 300));
    const popupHoverVisible = await win.webContents.executeJavaScript(`!document.getElementById(window.__tooltipActiveTrigger.getAttribute('aria-describedby')).hidden`);
    assert.equal(popupHoverVisible, true, 'Hovering explanation content must retain it');
    key('Escape');
    await waitFor(win, `document.getElementById(window.__tooltipActiveTrigger.getAttribute('aria-describedby')).hidden`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
    return { initial, focusPreserved, seamVisible, popupHoverVisible, measuredGap: gap };
  }
}
