import fs from 'node:fs';
import { app, BrowserWindow } from 'electron';

const targetUrl = process.env.RELAI_PROBE_TARGET_URL;
const outputPath = process.env.RELAI_PROBE_OUTPUT_PATH;
if (!targetUrl || !outputPath) throw new Error('Filter probe environment is incomplete.');
app.commandLine.appendSwitch('force-prefers-reduced-motion', 'reduce');
app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 820,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const failures = [];
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) failures.push('console:' + message); });
  try {
    await win.loadURL(targetUrl);
    await waitFor(win, `document.querySelector('#__activity-filter-bar .filter-search-input') && document.querySelectorAll('.activity-message-copy').length > 0`);

    const shared = await win.webContents.executeJavaScript(`(async () => {
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const setRadio = (root, label, value) => {
        const field = [...root.querySelectorAll('fieldset')].find(item => item.querySelector('legend')?.textContent.includes(label));
        const input = [...(field?.querySelectorAll('input[type="radio"]') || [])].find(item => item.value === value);
        if (!input) return false;
        input.click();
        return true;
      };
      const filterButton = document.querySelector('#__activity-filter-bar .filter-open-button');
      const search = document.querySelector('#__activity-filter-bar .filter-search-input');
      const filterButtonLabel = filterButton.getAttribute('aria-label') || '';
      filterButton.focus();
      filterButton.click();
      await delay(30);
      const drawer = document.querySelector('.filter-drawer');
      const focusedInside = drawer?.contains(document.activeElement) || false;
      const labelledBy = drawer?.getAttribute('aria-labelledby') || '';
      const title = labelledBy ? document.getElementById(labelledBy) : null;
      const dialogLabel = drawer?.getAttribute('role') === 'dialog' && Boolean(title?.textContent.trim());
      const fixedChoicesVisible = setRadio(drawer, 'Status', 'failed');
      [...drawer.querySelectorAll('button')].find(button => button.textContent.trim() === 'Cancel')?.click();
      await delay(30);
      const cancelPreserved = document.querySelectorAll('#__activity-filter-bar .filter-chip').length === 0;
      filterButton.click();
      await delay(30);
      const second = document.querySelector('.filter-drawer');
      setRadio(second, 'Time range', '24h');
      setRadio(second, 'Status', 'failed');
      [...second.querySelectorAll('button')].find(button => /Apply filters/.test(button.textContent))?.click();
      await delay(60);
      return {
        searchVisible: Boolean(search && getComputedStyle(search).display !== 'none'),
        searchLabel: search?.closest('label')?.textContent.trim() || '',
        filterButtonLabel,
        summaryRole: document.querySelector('#__activity-filter-bar .filter-summary')?.getAttribute('role') || '',
        dialogLabel,
        focusedInside,
        cancelPreserved,
        fixedChoicesVisible
      };
    })()`);
    await waitFor(win, `document.querySelectorAll('#__activity-filter-bar .filter-chip').length === 2 && !document.querySelector('.filter-drawer') && /events shown/.test(document.querySelector('#__activity-filter-bar .filter-summary')?.textContent || '')`);
    const activityApplied = await win.webContents.executeJavaScript(`(() => {
      const chips = [...document.querySelectorAll('#__activity-filter-bar .filter-chip')];
      const freeze = document.getElementById('__activity-freeze');
      return {
        chipText: chips.map(chip => chip.textContent.trim()),
        chipLabels: chips.map(chip => chip.getAttribute('aria-label') || ''),
        badge: document.querySelector('#__activity-filter-bar .filter-open-button')?.textContent.trim() || '',
        route: location.hash,
        summary: document.querySelector('#__activity-filter-bar .filter-summary')?.textContent.trim() || '',
        freezeExcluded: freeze?.getAttribute('aria-pressed') === 'false' && !/3/.test(document.querySelector('#__activity-filter-bar .filter-open-button')?.textContent || ''),
        freezeLabel: freeze?.getAttribute('aria-label') || '',
        freezeIconOnly: Boolean(freeze?.querySelector('svg') && !freeze.textContent.trim())
      };
    })()`);
    await win.webContents.executeJavaScript(`document.querySelector('#__activity-filter-bar [aria-label^="Remove Status filter"]')?.click()`);
    await waitFor(win, `!document.querySelector('#__activity-filter-bar [aria-label^="Remove Status filter"]') && !location.hash.includes('status=')`);
    await win.webContents.executeJavaScript(`location.hash = '#activity?task=acceptance-failed'`);
    await waitFor(win, `document.querySelector('#__activity-filter-bar [aria-label^="Remove Task filter"]')`);
    const taskChip = await win.webContents.executeJavaScript(`document.querySelector('#__activity-filter-bar [aria-label^="Remove Task filter"]')?.getAttribute('aria-label') || ''`);
    await win.webContents.executeJavaScript(`document.querySelector('#__activity-filter-bar .filter-clear-button')?.click()`);
    await waitFor(win, `document.querySelectorAll('#__activity-filter-bar .filter-chip').length === 0 && !location.hash.includes('?')`);

    const escapeFocus = await win.webContents.executeJavaScript(`(async () => {
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const trigger = document.querySelector('#__activity-filter-bar .filter-open-button');
      trigger.focus();
      trigger.click();
      await delay(30);
      document.getElementById('__relai-drawer-backdrop').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await delay(30);
      return { closed: !document.querySelector('.filter-drawer'), focusReturned: document.activeElement === trigger };
    })()`);

    win.setSize(420, 760);
    await delay(120);
    const mobileDrawer = await win.webContents.executeJavaScript(`(async () => {
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      document.querySelector('#__activity-filter-bar .filter-open-button').click();
      await delay(40);
      const drawer = document.querySelector('.filter-drawer');
      const body = drawer?.querySelector('.drawer-body');
      const footer = drawer?.querySelector('.filter-drawer-footer');
      const rect = drawer?.getBoundingClientRect();
      const footerRect = footer?.getBoundingClientRect();
      const result = {
        viewport: innerWidth,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        bottomSheet: Boolean(rect && Math.abs(rect.bottom - innerHeight) <= 2 && rect.left >= -1 && rect.right <= innerWidth + 1),
        scrollable: Boolean(body && ['auto', 'scroll'].includes(getComputedStyle(body).overflowY)),
        actionsReachable: Boolean(footerRect && footerRect.bottom <= innerHeight + 1 && footerRect.top >= 0)
      };
      [...drawer.querySelectorAll('button')].find(button => button.textContent.trim() === 'Cancel')?.click();
      return result;
    })()`);

    win.setSize(1100, 820);
    await win.webContents.executeJavaScript(`location.hash = '#diagnostics'`);
    await waitFor(win, `document.querySelector('#diagnosticFilterHost .filter-open-button') && document.querySelector('#diagnosticSummary')`);
    const diagnostics = await win.webContents.executeJavaScript(`(async () => {
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const setRadio = (root, label, value) => {
        const field = [...root.querySelectorAll('fieldset')].find(item => item.querySelector('legend')?.textContent.includes(label));
        const input = [...(field?.querySelectorAll('input[type="radio"]') || [])].find(item => item.value === value);
        if (!input) return false;
        input.click();
        return true;
      };
      const trigger = document.querySelector('#diagnosticFilterHost .filter-open-button');
      trigger.click(); await delay(30);
      let drawer = document.querySelector('.filter-drawer');
      const fixedChoicesVisible = setRadio(drawer, 'Scope', 'failed');
      [...drawer.querySelectorAll('button')].find(button => button.textContent.trim() === 'Cancel')?.click(); await delay(30);
      const cancelPreserved = document.querySelectorAll('#diagnosticFilterHost .filter-chip').length === 0;
      trigger.click(); await delay(30); drawer = document.querySelector('.filter-drawer');
      setRadio(drawer, 'Scope', 'failed');
      setRadio(drawer, 'Severity', 'error');
      [...drawer.querySelectorAll('button')].find(button => /Apply filters/.test(button.textContent))?.click(); await delay(80);
      const applied = {
        chips: [...document.querySelectorAll('#diagnosticFilterHost .filter-chip')].map(chip => chip.textContent.trim()),
        summary: document.querySelector('#diagnosticFilterHost .filter-summary')?.textContent.trim() || '',
        badge: document.querySelector('#diagnosticFilterHost .filter-open-button')?.textContent.trim() || '',
        liveTailPressed: document.querySelector('[data-live-tail]')?.getAttribute('aria-pressed'),
        reportActions: [...document.querySelectorAll('.diagnostic-page-actions button')].map(button => button.textContent.trim())
      };
      document.querySelector('#diagnosticFilterHost .filter-open-button').click(); await delay(30);
      drawer = document.querySelector('.filter-drawer');
      setRadio(drawer, 'Scope', 'findings');
      const source = [...drawer.querySelectorAll('label')].find(item => item.textContent.includes('Source'))?.querySelector('select');
      const sourceDisabledForFindings = source?.disabled === true && source.value === 'all';
      [...drawer.querySelectorAll('button')].find(button => button.textContent.trim() === 'Cancel')?.click();
      document.querySelector('#diagnosticFilterHost .filter-clear-button')?.click();
      const initialLiveTailLabel = document.querySelector('[data-live-tail]')?.getAttribute('aria-label') || '';
      document.querySelector('[data-live-tail]')?.click(); await delay(80);
      const liveTailStarted = document.querySelector('[data-live-tail]')?.getAttribute('aria-pressed') === 'true';
      const liveTailActiveLabel = document.querySelector('[data-live-tail]')?.getAttribute('aria-label') || '';
      document.querySelector('[data-live-tail]')?.click(); await delay(80);
      const liveTailStopped = document.querySelector('[data-live-tail]')?.getAttribute('aria-pressed') === 'false';
      const search = document.querySelector('#diagnosticFilterHost .filter-search-input');
      const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      inputValueSetter?.call(search, 'no-diagnostic-match-acceptance'); search.dispatchEvent(new Event('input', { bubbles: true })); await delay(220);
      const searchEmpty = /0 of .* findings.*0 of .* log entries shown/.test(document.querySelector('#diagnosticFilterHost .filter-summary')?.textContent || '');
      document.querySelector('#diagnosticFilterHost .filter-clear-button')?.click();
      const technicalFindingCodesGated = ![...document.querySelectorAll('[data-diagnostic-region="findings"] code')]
        .some(code => !code.closest('details[data-diagnostic-detail]'));
      const findingSeveritiesReadable = [...document.querySelectorAll('.diagnostic-severity')]
        .every(element => ['Blocking', 'Warning', 'Recommendation'].includes(element.textContent.trim()));
      return { cancelPreserved, fixedChoicesVisible, sourceDisabledForFindings, initialLiveTailLabel, liveTailActiveLabel, liveTailStarted, liveTailStopped, searchEmpty, technicalFindingCodesGated, findingSeveritiesReadable, applied };
    })()`);

    await win.webContents.executeJavaScript(`location.hash = '#tools'`);
    await waitFor(win, `document.querySelector('#toolsToolbar .filter-open-button') && document.querySelectorAll('.tool-card').length > 0`);
    const tools = await win.webContents.executeJavaScript(`(async () => {
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const search = document.querySelector('#toolsToolbar .filter-search-input');
      const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      inputValueSetter?.call(search, 'relai'); search.dispatchEvent(new Event('input', { bubbles: true })); await delay(30);
      document.querySelector('#toolsToolbar .filter-open-button').click(); await delay(30);
      const drawer = document.querySelector('.filter-drawer');
      const validate = drawer.querySelector('input[type="radio"][value="validate"]');
      validate.click();
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
      [...document.querySelector('.filter-drawer').querySelectorAll('button')].find(button => /Apply filters/.test(button.textContent))?.click();
      await new Promise(resolve => requestAnimationFrame(() => resolve()));
      const applied = {
        chip: document.querySelector('#toolsToolbar [aria-label^="Remove Capability filter"]')?.getAttribute('aria-label') || '',
        badge: document.querySelector('#toolsToolbar .filter-open-button')?.textContent.trim() || '',
        summary: document.querySelector('#toolsToolbar .filter-summary')?.textContent.trim() || '',
        visibleCards: document.querySelectorAll('.tool-card').length
      };
      document.querySelector('#toolsToolbar [aria-label^="Remove Capability filter"]')?.click(); await delay(30);
      const capabilityRemoved = !document.querySelector('#toolsToolbar [aria-label^="Remove Capability filter"]');
      document.querySelector('#toolsToolbar .filter-clear-button')?.click(); await delay(30);
      const cleared = document.querySelector('#toolsToolbar .filter-search-input')?.value === '';
      const emptySearch = document.querySelector('#toolsToolbar .filter-search-input');
      inputValueSetter?.call(emptySearch, 'no-tool-match-acceptance'); emptySearch.dispatchEvent(new Event('input', { bubbles: true })); await delay(60);
      const emptyState = /No matching tools/.test(document.querySelector('#toolsBody')?.textContent || '');
      document.querySelector('#toolsToolbar .filter-clear-button')?.click();
      return { applied, capabilityRemoved, searchCleared: cleared, emptyState };
    })()`);

    await win.webContents.executeJavaScript(`location.hash = '#settings'`);
    await waitFor(win, `document.querySelector('.settings-content .theme-switch') && !document.querySelector('.settings-rail')`);
    const settings = await win.webContents.executeJavaScript(`(async () => {
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const selects = [...document.querySelectorAll('.settings-content select')];
      const theme = document.querySelector('.theme-switch');
      const themes = [];
      for (const value of ['dark', 'light', 'system']) {
        theme.querySelector('[data-theme-option="' + value + '"]').click(); await delay(20);
        themes.push({ preference: document.documentElement.dataset.themePreference, resolved: document.documentElement.dataset.theme });
      }
      const systemTheme = theme.querySelector('[data-theme-option="system"]');
      systemTheme.focus();
      systemTheme.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await delay(20);
      return {
        themes,
        themeSwitchLabels: [...theme.querySelectorAll('[data-theme-option]')].map(button => button.getAttribute('aria-label')),
        themeSwitchIconsUseSvg: [...theme.querySelectorAll('[data-theme-option]')].every(button => Boolean(button.querySelector('svg'))),
        themeSwitchCheckedCount: theme.querySelectorAll('[aria-checked="true"]').length,
        themeSwitchRole: theme.getAttribute('role'),
        themeOptionRoles: [...theme.querySelectorAll('[data-theme-option]')].map(button => button.getAttribute('role')),
        themeKeyboardSelected: theme.querySelector('[aria-checked="true"]')?.dataset.themeOption || '',
        themeKeyboardFocused: document.activeElement?.dataset?.themeOption || '',
        densityControlRemoved: !selects.some(select => [...select.options].some(option => option.value === 'compact')),
        appearancePreviewRemoved: !document.querySelector('.appearance-preview'),
        legacyDensityIgnored: !document.documentElement.dataset.density,
        secondaryNavigationRemoved: !document.querySelector('.settings-rail') && document.querySelectorAll('.settings-nav-button').length === 0,
        labelsAssociated: [...document.querySelectorAll('.settings-content .settings-field')].every(field => {
          const label = field.querySelector(':scope > label');
          const control = field.querySelector('input, select, textarea');
          return !control || Boolean(label?.htmlFor && control.id === label.htmlFor);
        })
      };
    })()`);

    await win.webContents.executeJavaScript(`location.hash = '#workspaces'`);
    await waitFor(win, `document.querySelector('.workspace-grid')`);
    const workspaces = await win.webContents.executeJavaScript(`(async () => {
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      const waitUntil = async (predicate, timeout = 4000) => {
        const started = Date.now();
        while (Date.now() - started < timeout) {
          if (predicate()) return true;
          await delay(50);
        }
        return false;
      };
      const validationPreferenceRemoved = !document.querySelector('.workspace-validation-preferences');
      const validationMetricRemoved = !document.querySelector('.summary-metrics')?.textContent.includes('Validation ready');
      const redundantProjectActionsRemoved = !document.querySelector('[data-repository-details], .workspace-action-menu');
      [...document.querySelectorAll('.workspace-card button')].find(button => button.textContent.trim() === 'Edit project')?.click();
      const editDetailsConsolidated = await waitUntil(() => Boolean(document.querySelector('.modal-panel .ws-project-details-section .workspace-operational')));
      const aliasInput = document.querySelector('.modal-panel input[name="alias"]');
      if (!aliasInput) throw new Error('Edit project alias input did not render.');
      const aliasValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      aliasValueSetter?.call(aliasInput, 'bad project name');
      aliasInput.dispatchEvent(new Event('input', { bubbles: true }));
      await delay(20);
      const aliasError = document.getElementById('workspaceAliasError');
      const inlineAliasValidation = aliasInput.getAttribute('aria-invalid') === 'true'
        && Boolean(aliasError)
        && /Project names may use only/.test(aliasError.textContent || '');
      const aliasValidationToastAbsent = ![...document.querySelectorAll('.toast-copy')]
        .some(element => /Project names may use only/.test(element.textContent || ''));
      aliasValueSetter?.call(aliasInput, 'app');
      aliasInput.dispatchEvent(new Event('input', { bubbles: true }));
      await delay(20);
      const aliasValidationCleared = aliasInput.getAttribute('aria-invalid') === 'false' && !document.getElementById('workspaceAliasError');
      document.getElementById('__relai-modal-backdrop')?.click();
      await waitUntil(() => Boolean(document.querySelector('.modal-inline-confirm-card button.danger')));
      document.querySelector('.modal-inline-confirm-card button.danger')?.click();
      await waitUntil(() => !document.querySelector('#__relai-modal-backdrop'));
      location.hash = '#workspaces?workspace=app';
      await waitUntil(() => Boolean(document.querySelector('.workspace-focus-chip')));
      const focusChipLabel = document.querySelector('.workspace-focus-chip')?.getAttribute('aria-label') || '';
      location.hash = '#tasks';
      await waitUntil(() => Boolean(document.querySelector('select[aria-label="Project filter"]')));
      const projectFilter = document.querySelector('select[aria-label="Project filter"]');
      const projectOptions = [...projectFilter.options].map(option => option.textContent.trim());
      const projectFilterPresent = Boolean(projectFilter);
      const projectOptionsOrdered = projectOptions[0] === 'All projects' && projectOptions.slice(1).join('|') === [...projectOptions.slice(1)].sort((a, b) => a.localeCompare(b)).join('|');
      projectFilter?.focus();
      return {
        validationPreferenceRemoved,
        validationMetricRemoved,
        editDetailsConsolidated,
        inlineAliasValidation,
        aliasValidationToastAbsent,
        aliasValidationCleared,
        redundantProjectActionsRemoved,
        focusChipLabel,
        scopeName: projectFilter?.getAttribute('aria-label') || '',
        projectFilterPresent,
        projectOptionsOrdered,
        projectFilterKeyboardFocused: document.activeElement === projectFilter
      };
    })()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
    await waitFor(win, `location.hash.includes('workspace=app') && document.querySelector('select[aria-label="Project filter"]')?.value === 'app'`);
    workspaces.projectFilterUpdatesRoute = true;

    await win.webContents.executeJavaScript(`location.hash = '#settings/connection'`);
    await waitFor(win, `document.querySelector('.connection-primary-action')`);
    const connection = await win.webContents.executeJavaScript(`(() => ({
      primaryCount: document.querySelectorAll('.connection-primary-action > a, .connection-primary-action > button').length,
      primaryLabel: document.querySelector('.connection-primary-action')?.textContent.trim() || '',
      primaryTag: document.querySelector('.connection-primary-action > a, .connection-primary-action > button')?.tagName || '',
      detailsDisclosure: Boolean(document.querySelector('.connection-layer-disclosure')),
      technicalDetailsRemoved: !document.querySelector('.connector-technical-details') && !document.body.innerText.includes('Bounded synchronous fallback'),
      secondaryNavigationRemoved: !document.querySelector('.system-rail') && !document.querySelector('#__system-content .settings-rail'),
      navigationLabels: [...document.querySelectorAll('nav[aria-label]')].map(nav => nav.getAttribute('aria-label'))
    }))()`);

    const usage = await win.webContents.executeJavaScript(`(async () => {
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      window.relaiDesktop = {
        getGatewayStatus: async () => ({ connectionMode: 'direct' }),
        getGatewayUsage: async () => ({ ok: true }),
        getLocalUsage: async month => ({
          ok: true,
          source: 'local',
          month,
          totals: { requests: 0, toolCalls: 0, successes: 0, failures: 0, requestBytes: 0, resultBytes: 0, executionMs: 0, activeDays: 0 },
          tools: [], devices: [], workspaces: [], series: [], toolSeries: [], workspaceSeries: [], workspaceToolSeries: [],
          failureCategories: [], workspaceFailureCategories: [], failureCategorySeries: [], workspaceFailureCategorySeries: []
        })
      };
      location.hash = '#usage';
      const started = Date.now();
      while (!document.querySelector('.usage-overview') && Date.now() - started < 4000) await delay(50);
      const rangeButton = document.querySelector('[data-usage-range-option="7d"]');
      rangeButton?.click();
      await delay(80);
      const rangeRouteUpdated = location.hash.includes('range=7d');
      location.hash = '#usage?range=30d';
      await delay(80);
      const result = {
        overviewVisible: Boolean(document.querySelector('.usage-overview')),
        privacyCopyRemoved: !/Aggregate local analytics are retained|Minimal usage counting is always on|Data & privacy/i.test(document.querySelector('[data-usage-page]')?.textContent || ''),
        modalVisible: Boolean(document.querySelector('[role="dialog"] .modal-title')),
        inlineUnavailable: Boolean(document.querySelector('.usage-unavailable')),
        rangeLabels: [...document.querySelectorAll('[data-usage-range-option]')].map(button => button.textContent.trim()),
        rangePressedCount: document.querySelectorAll('[data-usage-range-option][aria-pressed="true"]').length,
        rangeSelectHidden: document.querySelector('[data-usage-range]')?.hidden === true,
        rangeRouteUpdated,
        sameRouteRangeSynced: document.querySelector('[data-usage-range]')?.value === '30d'
          && document.querySelector('[data-usage-range-option="30d"]')?.getAttribute('aria-pressed') === 'true'
      };
      delete window.relaiDesktop;
      return result;
    })()`);

    const browserTabs = await win.webContents.executeJavaScript(`(async () => {
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      let state = {
        ok: true,
        available: true,
        active: true,
        activeSessionCount: 1,
        control: 'ai',
        nativeSessionId: 'embedded_browser_acceptance1234567890',
        nativePageId: 'embedded_page_first1234567890123456',
        pageCount: 2,
        url: 'https://first.example.test/',
        title: 'First tab',
        loading: false,
        visible: true,
        tabs: [
          { nativePageId: 'embedded_page_first1234567890123456', active: true, url: 'https://first.example.test/', title: 'First tab', loading: false, createdAt: '2026-09-07T00:00:00.000Z' },
          { nativePageId: 'embedded_page_second123456789012345', active: false, url: 'https://second.example.test/', title: 'Second tab', loading: false, createdAt: '2026-09-07T00:00:01.000Z' }
        ]
      };
      const calls = [];
      const activeState = nativePageId => {
        const tabs = state.tabs.map(tab => ({ ...tab, active: tab.nativePageId === nativePageId }));
        const active = tabs.find(tab => tab.active) || null;
        state = { ...state, nativePageId, tabs, pageCount: tabs.length, url: active?.url || '', title: active?.title || '', loading: active?.loading === true };
        return state;
      };
      window.relaiDesktop = {
        browser: {
          getState: async () => state,
          onState: () => () => {},
          setBounds: async bounds => ({ ...state, visible: bounds?.visible === true }),
          setControl: async owner => (state = { ...state, control: owner }),
          selectTab: async nativePageId => { calls.push(['select', nativePageId]); return activeState(nativePageId); },
          closeTab: async nativePageId => {
            calls.push(['close', nativePageId]);
            const remaining = state.tabs.filter(tab => tab.nativePageId !== nativePageId);
            state = { ...state, tabs: remaining, pageCount: remaining.length };
            const nextId = state.nativePageId === nativePageId ? (remaining[0]?.nativePageId || '') : state.nativePageId;
            return activeState(nextId);
          },
          stop: async () => (state = { ...state, active: false })
        }
      };
      const originalMatchMedia = window.matchMedia;
      const originalScrollIntoView = Element.prototype.scrollIntoView;
      let tabScrollBehavior = '';
      let copiedValue = '';
      window.matchMedia = query => query === '(prefers-reduced-motion: reduce)'
        ? { matches: true, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }
        : originalMatchMedia.call(window, query);
      Element.prototype.scrollIntoView = function(options) {
        if (this.classList?.contains('browser-tab-item')) tabScrollBehavior = String(options?.behavior || '');
      };
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async value => { copiedValue = String(value || ''); } }
      });
      location.hash = '#browser';
      const started = Date.now();
      while (document.querySelectorAll('.browser-tab-item').length !== 2 && Date.now() - started < 4000) await delay(50);
      const before = {
        count: document.querySelectorAll('.browser-tab-item').length,
        activeCount: document.querySelectorAll('.browser-tab-item.active').length,
        labels: [...document.querySelectorAll('.browser-tab-title')].map(label => label.textContent.trim()),
        closeLabels: [...document.querySelectorAll('.browser-tab-close')].map(button => button.getAttribute('aria-label')),
        listLabel: document.querySelector('.browser-tab-list')?.getAttribute('aria-label') || ''
      };
      document.querySelector('.browser-copy-url')?.click();
      await delay(20);
      const copyFeedback = {
        copiedValue,
        label: document.querySelector('.browser-copy-url')?.getAttribute('aria-label') || '',
        liveText: document.querySelector('.browser-omnibox [role="status"]')?.textContent.trim() || ''
      };
      document.querySelectorAll('.browser-tab-select')[1]?.click();
      await delay(50);
      const selectedSecond = document.querySelectorAll('.browser-tab-item')[1]?.classList.contains('active') === true;
      document.querySelectorAll('.browser-tab-close')[1]?.click();
      await delay(50);
      const afterClose = {
        count: document.querySelectorAll('.browser-tab-item').length,
        activeCount: document.querySelectorAll('.browser-tab-item.active').length,
        title: document.querySelector('.browser-page-title')?.textContent.trim() || ''
      };
      window.matchMedia = originalMatchMedia;
      Element.prototype.scrollIntoView = originalScrollIntoView;
      delete window.relaiDesktop;
      return { before, selectedSecond, afterClose, calls, tabScrollBehavior, copyFeedback };
    })()`);

    const responsive = [];
    win.show();
    win.focus();
    await win.webContents.setZoomFactor(1);
    for (const requestedWidth of [980, 760, 520, 420]) {
      win.setContentSize(requestedWidth, 760);
      await delay(180);
      await win.webContents.executeJavaScript(`location.hash = '#activity'`);
      await waitFor(win, `document.querySelector('#__activity-filter-bar .filter-open-button')`);
      const measurement = await win.webContents.executeJavaScript(`(() => {
        const controls = [...document.querySelectorAll('#__activity-filter-bar input, #__activity-filter-bar button')].filter(control => control.getClientRects().length > 0 && !control.hidden);
        return {
          width: innerWidth,
          horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          controlsInViewport: controls.every(control => { const rect = control.getBoundingClientRect(); return rect.left >= -1 && rect.right <= innerWidth + 1; }),
          clippedControls: controls.map(control => { const rect = control.getBoundingClientRect(); return { text: control.getAttribute('aria-label') || control.textContent.trim() || control.placeholder || control.tagName, left: rect.left, right: rect.right, width: rect.width }; }).filter(item => item.left < -1 || item.right > innerWidth + 1),
          searchVisible: Boolean(document.querySelector('#__activity-filter-bar .filter-search-input')?.offsetParent),
          touchTargets: controls.every(control => control.getBoundingClientRect().height >= 30),
          breakpointActive: matchMedia('(max-width: ${requestedWidth}px)').matches
        };
      })()`);
      measurement.requestedWidth = requestedWidth;
      responsive.push(measurement);
    }
    win.setContentSize(840, 760);
    await win.webContents.setZoomFactor(2);
    await delay(180);
    await win.webContents.executeJavaScript(`location.hash = '#activity'`);
    await waitFor(win, `document.querySelector('#__activity-filter-bar .filter-open-button')`);
    const zoom200At420 = await win.webContents.executeJavaScript(`(() => {
      const controls = [...document.querySelectorAll('#__activity-filter-bar input, #__activity-filter-bar button')].filter(control => control.getClientRects().length > 0 && !control.hidden);
      return {
        width: innerWidth,
        zoomFactor: 2,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        controlsInViewport: controls.every(control => { const rect = control.getBoundingClientRect(); return rect.left >= -1 && rect.right <= innerWidth + 1; }),
        searchVisible: Boolean(document.querySelector('#__activity-filter-bar .filter-search-input')?.offsetParent)
      };
    })()`);
    await win.webContents.setZoomFactor(1);
    win.hide();

    let debuggerAttached = false;
    let forcedColors = { active: false, supported: false, visibleBoundary: false };
    try {
      win.webContents.debugger.attach('1.3');
      debuggerAttached = true;
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
      forcedColors = await win.webContents.executeJavaScript(`(() => {
        const button = document.querySelector('#__activity-filter-bar .filter-open-button');
        const style = button ? getComputedStyle(button) : null;
        return { active: matchMedia('(forced-colors: active)').matches, supported: CSS.supports('forced-color-adjust', 'none'), visibleBoundary: Boolean(style && style.borderStyle !== 'none' && style.borderWidth !== '0px') };
      })()`);
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
      if (debuggerAttached) { win.webContents.debugger.detach(); debuggerAttached = false; }
    } catch (error) {
      failures.push('forced-colors:' + (error?.message || String(error)));
      if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach();
      debuggerAttached = false;
    }

    fs.writeFileSync(outputPath, JSON.stringify({ shared, activityApplied, taskChip, escapeFocus, mobileDrawer, diagnostics, tools, settings, workspaces, connection, usage, browserTabs, responsive, zoom200At420, forcedColors, failures }, null, 2));
  } catch (error) {
    fs.writeFileSync(outputPath, JSON.stringify({ error: error?.stack || String(error), failures }, null, 2));
    process.exitCode = 1;
  } finally {
    win.destroy(); app.quit();
  }
}).catch(error => { fs.writeFileSync(outputPath, JSON.stringify({ error: error?.stack || String(error) }, null, 2)); app.exit(1); });

async function waitFor(win, expression, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await win.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await delay(50);
  }
  const diagnostic = await win.webContents.executeJavaScript(`({ hash: location.hash, text: document.body?.innerText?.slice(0, 1200) || '', route: document.getElementById('routeRoot')?.innerHTML?.slice(0, 1200) || '' })`).catch(() => null);
  throw new Error('Timed out waiting for: ' + expression + (diagnostic ? `\nPage state: ${JSON.stringify(diagnostic)}` : ''));
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

