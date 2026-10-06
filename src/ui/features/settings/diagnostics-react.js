import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson } from '../../api.js';
import { copyText } from '../../clipboard.js';
import { filterRadioField, filterSelectField, openFilterDrawer } from '../../components/filter-drawer.js';
import { Icon } from '../../components/icons.js';
import { RuntimeBuildIdentity } from '../../components/operation-diagnostics.js';
import { StatusPill } from '../../components/pill.js';
import { toast } from '../../components/toast.js';
import { getWorkspaceFilter } from '../../router.js';

import { timeAgo } from '../../utils.js';
import { restartConnection } from './connection-recovery.js';
import { ResourceDiagnostics } from './resource-diagnostics.js';

const h = React.createElement;
const LIVE_TAIL_REFRESH_DELAY_MS = 160;
const DEFAULT_FILTERS = Object.freeze({ search: '', scope: 'all', severity: 'all', source: 'all' });

const RUNTIME_SLICES = Object.freeze(['runtime', 'runtimeCompatibility']);

export function createDiagnosticsRoute(useDashboardSlices) {
  return function DiagnosticsRoute() {
    const data = useDashboardSlices(RUNTIME_SLICES);
    return h(DiagnosticsView, { runtime: data.runtime, runtimeCompatibility: data.runtimeCompatibility });
  };
}

function DiagnosticsView({ runtime, runtimeCompatibility }) {
  const [report, setReport] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState('');
  const [tunnelDoctor, setTunnelDoctor] = useState(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState('');
  const reportRef = useRef(report);
  const liveRef = useRef(live);
  const refreshTimerRef = useRef(0);
  const loadingRef = useRef(false);
  const logRefs = useRef(new Map());
  const scrollStateRef = useRef(new Map());

  useEffect(() => { reportRef.current = report; }, [report]);
  useEffect(() => { liveRef.current = live; }, [live]);

  const captureLogPositions = useCallback(() => {
    for (const [key, element] of logRefs.current.entries()) {
      if (!element) continue;
      scrollStateRef.current.set(key, {
        top: element.scrollTop,
        follow: element.scrollHeight - element.scrollTop - element.clientHeight <= 24
      });
    }
  }, []);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const workspace = getWorkspaceFilter();
      const url = '/api/diagnostics' + (workspace ? `?workspace=${encodeURIComponent(workspace)}` : '');
      const result = await fetchJson(url, { cache: 'no-store' });
      if (!result?.ok) throw new Error(result?.error || 'Troubleshooting info could not be loaded.');
      if (silent) captureLogPositions();
      setReport(result);
      setLoadError('');
    } catch (error) {
      if (silent) {
        setLive(false);
        toast(messageOf(error), { variant: 'error' });
      } else {
        setReport(null);
        setLoadError(messageOf(error));
      }
    } finally {
      loadingRef.current = false;
    }
  }, [captureLogPositions]);

  useEffect(() => { void load(); }, [load]);

  const scheduleRefresh = useCallback(() => {
    if (document.visibilityState === 'hidden' || refreshTimerRef.current) return;
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = 0;
      void load({ silent: true });
    }, LIVE_TAIL_REFRESH_DELAY_MS);
  }, [load]);

  useEffect(() => {
    if (!live) return undefined;
    const onLive = event => {
      if (!liveRef.current || !location.hash.startsWith('#diagnostics')) return;
      const detail = event.detail || {};
      const change = detail.type === 'diagnostics.updated' ? detail.data?.change : null;
      if (['append', 'replace'].includes(change?.type) && change.entry && reportRef.current?.logs?.runtime) {
        const current = reportRef.current;
        const delta = applyRuntimeLogDelta(current.logs.runtime, change);
        if (delta.kind === 'duplicate') return;
        if (delta.kind === 'refresh') { scheduleRefresh(); return; }
        const next = { ...current, logs: { ...current.logs, runtime: delta.runtime } };
        reportRef.current = next;
        captureLogPositions();
        setReport(next);
        if (change.type === 'append' && ['warning', 'error'].includes(change.entry.level)) {
          setLiveAnnouncement(`New app log ${change.entry.level} from ${change.entry.source || 'Rel.AI'}.`);
        }
        return;
      }
      scheduleRefresh();
    };
    window.addEventListener('relai:diagnostics-live', onLive);
    return () => window.removeEventListener('relai:diagnostics-live', onLive);
  }, [captureLogPositions, live, scheduleRefresh]);

  useEffect(() => {
    if (!live) return undefined;
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible' || !liveRef.current || !location.hash.startsWith('#diagnostics')) return;
      void load({ silent: true });
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [live, load]);

  useEffect(() => () => window.clearTimeout(refreshTimerRef.current), []);

  useEffect(() => {
    for (const [key, element] of logRefs.current.entries()) {
      if (!element) continue;
      const previous = scrollStateRef.current.get(key);
      if (!previous || previous.follow) element.scrollTop = element.scrollHeight;
      else element.scrollTop = Math.min(previous.top, element.scrollHeight);
    }
  }, [report, filters]);

  const sources = useMemo(() => diagnosticSources(report), [report]);
  const normalizedFilters = useMemo(
    () => sources.includes(filters.source) ? filters : { ...filters, source: 'all' },
    [filters, sources]
  );
  const view = useMemo(() => filteredDiagnosticView(report, normalizedFilters), [report, normalizedFilters]);
  const summary = report ? `${view.findings.length} of ${view.totalFindings} findings · ${view.shownLogs} of ${view.totalLogs} log entries shown` : 'Loading diagnostics…';

  const clearFilters = () => { captureLogPositions(); setFilters(DEFAULT_FILTERS); };
  const copyReport = async () => {
    if (!report?.reportText) return;
    setBusy('copy');
    try {
      await copyText(report.reportText);
      toast('Diagnostic report copied.', { variant: 'success' });
    } catch {
      toast('Could not copy the report.', { variant: 'error' });
    } finally { setBusy(''); }
  };
  const exportReport = async () => {
    if (!report) return;
    setBusy('export');
    try {
      const result = typeof window.relaiDesktop?.exportDiagnosticState === 'function'
        ? await window.relaiDesktop.exportDiagnosticState(report)
        : downloadDiagnosticState(report);
      if (result?.ok === false) throw new Error(result.error || 'Could not export diagnostic state.');
    } catch (error) { toast(messageOf(error), { variant: 'error' }); }
    finally { setBusy(''); }
  };
  const openFolder = async () => {
    if (typeof window.relaiDesktop?.openDiagnosticsFolder !== 'function') return;
    setBusy('folder');
    try {
      const result = await window.relaiDesktop.openDiagnosticsFolder();
      if (result?.ok === false) throw new Error(result.error || 'Could not open the support folder.');
    } catch (error) { toast(messageOf(error), { variant: 'error' }); }
    finally { setBusy(''); }
  };
  const runTunnelDoctor = async () => {
    if (typeof window.relaiDesktop?.runTunnelDoctor !== 'function') return;
    setBusy('doctor');
    try {
      const result = await window.relaiDesktop.runTunnelDoctor();
      setTunnelDoctor(result);
      const presentation = tunnelDoctorPresentation(result);
      toast(presentation.toastMessage, { variant: presentation.toastVariant });
    } catch (error) {
      setTunnelDoctor({ ok: false, error: messageOf(error), checks: [] });
      toast(messageOf(error), { variant: 'error' });
    } finally { setBusy(''); }
  };

  return h('div', { className: 'settings-content system-content' },
    h('div', { className: 'diagnostic-page', 'data-diagnostics-react': '' },
      h('div', { className: 'section-head diagnostic-page-head' },
        h('div', { className: 'section-head-actions diagnostic-page-actions' },
          h('button', { className: 'secondary', type: 'button', disabled: !report?.reportText || busy === 'copy', onClick: () => void copyReport() },
            h(Icon, { name: 'copy', size: 14 }),
            h('span', null, busy === 'copy' ? 'Copying…' : 'Copy report')
          ),
          h('button', { className: 'secondary', type: 'button', disabled: !report || busy === 'export', onClick: () => void exportReport() },
            h(Icon, { name: 'download', size: 14 }),
            h('span', null, busy === 'export' ? 'Exporting…' : 'Export support information')
          ),
          typeof window.relaiDesktop?.runTunnelDoctor === 'function' ? h('button', { className: 'secondary', type: 'button', disabled: busy === 'doctor', onClick: () => void runTunnelDoctor() },
            h(Icon, { name: 'reliability', size: 14 }),
            h('span', null, busy === 'doctor' ? 'Running diagnostics…' : 'Run diagnostics')
          ) : null,
          typeof window.relaiDesktop?.openDiagnosticsFolder === 'function' ? h('details', { className: 'diagnostic-more-actions' },
            h('summary', null, 'More'),
            h('div', { className: 'diagnostic-more-actions-menu' },
              h('button', { className: 'secondary', type: 'button', disabled: busy === 'folder', onClick: () => void openFolder() },
                h(Icon, { name: 'folder', size: 14 }),
                h('span', null, busy === 'folder' ? 'Opening…' : 'Support folder')
              )
            )
          ) : null
        )
      ),
      h('div', { id: 'diagnosticFilterHost' },
        h(DiagnosticFilterBar, { filters: normalizedFilters, sources, summary, live, onChange: next => { captureLogPositions(); setFilters(next); }, onClear: clearFilters, onToggleLive: () => setLive(value => !value) })
      ),
      h('div', { className: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, liveAnnouncement),
      !report && !loadError ? h('div', { id: 'diagnosticSummary', className: 'diagnostic-summary' }, h('div', { className: 'empty', role: 'status' }, 'Loading troubleshooting info…')) : null,
      loadError ? h(DiagnosticUnavailable, { error: loadError, onRetry: () => void load() }) : null,
      report ? h('div', { id: 'diagnosticSummary', className: 'diagnostic-summary' },
        h(DiagnosticMetrics, { findings: view.findings }),
        h(ResourceDiagnostics, { resources: report.resourceDiagnostics, onRefresh: load }),
        h(RuntimeBuildIdentity, { runtime, compatibility: runtimeCompatibility }),
        report.tunnelHealth ? h(TunnelHealthSummary, { health: report.tunnelHealth }) : null,
        tunnelDoctor ? h(TunnelDoctorResult, { result: tunnelDoctor }) : null,
        h(DiagnosticFindings, { findings: view.findings, total: view.totalFindings, onReload: load }),
        h(DiagnosticLogs, { report, view, registerLog: (key, element) => { if (element) logRefs.current.set(key, element); else logRefs.current.delete(key); } })
      ) : null
    )
  );
}

function DiagnosticFilterBar({ filters, sources, summary, live, onChange, onClear, onToggleLive }) {
  const [search, setSearch] = useState(filters.search);
  const searchTimerRef = useRef(0);
  useEffect(() => { setSearch(filters.search); }, [filters.search]);
  useEffect(() => () => window.clearTimeout(searchTimerRef.current), []);
  const active = diagnosticFilterChips(filters);
  const openFilters = () => openDiagnosticFilters({ filters, sources, onChange });
  const updateSearch = value => {
    setSearch(value);
    window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => onChange({ ...filters, search: value.trim().toLowerCase() }), 120);
  };
  return h('section', { className: 'filter-bar', 'aria-label': 'Troubleshooting filters' },
    h('div', { className: 'filter-bar-controls' },
      h('label', { className: 'filter-search-control' },
        h('span', { className: 'sr-only' }, 'Search troubleshooting'),
        h('input', { type: 'search', className: 'filter-search-input', placeholder: 'Search code, source, message, or project', value: search, autoComplete: 'off', onChange: event => updateSearch(event.currentTarget.value) })
      ),
      h('button', {
        type: 'button',
        className: `secondary filter-open-button${active.length ? ' active' : ''}`,
        'aria-label': active.length ? `Open filters. ${active.length} active` : 'Open filters',
        onClick: openFilters
      }, active.length ? `Filters (${active.length})` : 'Filters'),
      h('div', { className: 'filter-bar-action' },
        h('button', {
          type: 'button',
          className: `secondary filter-state-toggle diagnostic-live-tail${live ? ' active' : ''}`,
          'data-live-tail': '',
          'aria-pressed': String(live),
          'aria-label': live ? 'Pause live updates' : 'Start live updates',
          title: live ? 'Pause live updates' : 'Start live updates',
          onClick: onToggleLive
        }, live ? 'Pause' : 'Live')
      )
    ),
    active.length ? h('div', { className: 'filter-chip-list', 'aria-label': 'Active filters' }, active.map(filter => h('button', {
      type: 'button', className: 'secondary filter-chip', key: filter.key,
      'aria-label': `Remove ${filter.label} filter: ${filter.value}`,
      onClick: () => onChange({ ...filters, [filter.key]: 'all' })
    }, h('span', null, `${filter.label}: ${filter.value}`), h(Icon, { name: 'close', size: 12 })))) : null,
    h('div', { className: 'filter-bar-footer' },
      h('span', { className: 'filter-summary', role: 'status', 'aria-live': 'polite' }, summary),
      h('button', { type: 'button', className: 'secondary filter-clear-button', hidden: !hasDiagnosticFilters(filters), onClick: () => { setSearch(''); onClear(); } }, 'Clear all')
    )
  );
}

function openDiagnosticFilters({ filters, sources, onChange }) {
  openFilterDrawer({
    title: 'Troubleshooting filters',
    value: { scope: filters.scope, severity: filters.severity, source: filters.source },
    resetValue: { scope: 'all', severity: 'all', source: 'all' },
    renderFields(fields, draft) {
      fields.append(
        filterRadioField({
          key: 'scope',
          label: 'Scope',
          value: draft.scope,
          options: [
            { value: 'all', label: 'Everything' },
            { value: 'findings', label: 'Findings' },
            { value: 'service', label: 'App log' },
            { value: 'failed', label: 'Failed activity' }
          ],
          onChange: value => {
            draft.scope = value;
            if (value === 'findings') draft.source = 'all';
          }
        }),
        filterRadioField({
          key: 'severity',
          label: 'Severity',
          value: draft.severity,
          options: [
            { value: 'all', label: 'All severities' },
            { value: 'error', label: 'Blocking' },
            { value: 'warning', label: 'Warnings' },
            { value: 'info', label: 'Recommendations' },
            { value: 'debug', label: 'Debug logs' }
          ],
          onChange: value => { draft.severity = value; }
        }),
        filterSelectField({
          key: 'source',
          label: 'Source',
          value: draft.scope === 'findings' ? 'all' : draft.source,
          options: [{ value: 'all', label: 'All sources' }, ...sources.map(source => ({ value: source, label: source }))],
          disabled: draft.scope === 'findings',
          help: draft.scope === 'findings' ? 'Source applies to service and failed activity logs.' : '',
          onChange: value => { draft.source = value; }
        })
      );
    },
    onApply(draft) {
      const scope = draft.scope || 'all';
      onChange({
        ...filters,
        scope,
        severity: draft.severity || 'all',
        source: scope === 'findings' ? 'all' : draft.source || 'all'
      });
    }
  });
}

function diagnosticFilterChips(filters) {
  const chips = [];
  if (filters.scope !== 'all') chips.push({ key: 'scope', label: 'Scope', value: { findings: 'Findings', service: 'App log', failed: 'Failed activity' }[filters.scope] || filters.scope });
  if (filters.severity !== 'all') chips.push({ key: 'severity', label: 'Severity', value: { error: 'Blocking', warning: 'Warnings', info: 'Recommendations', debug: 'Debug logs' }[filters.severity] || filters.severity });
  if (filters.source !== 'all') chips.push({ key: 'source', label: 'Source', value: filters.source });
  return chips;
}
function hasDiagnosticFilters(filters) { return Boolean(filters.search || filters.scope !== 'all' || filters.severity !== 'all' || filters.source !== 'all'); }

function DiagnosticMetrics({ findings }) {
  const summary = { blocking: 0, warnings: 0, recommendations: 0 };
  for (const finding of findings) {
    if (finding.severity === 'error') summary.blocking += 1;
    else if (finding.severity === 'warning') summary.warnings += 1;
    else summary.recommendations += 1;
  }
  return h('div', { className: 'diagnostic-metrics', 'data-diagnostic-region': 'metrics' },
    h(Metric, { label: 'Blocking', count: summary.blocking, severity: 'error' }),
    h(Metric, { label: 'Warnings', count: summary.warnings, severity: 'warning' }),
    h(Metric, { label: 'Recommendations', count: summary.recommendations, severity: 'info' })
  );
}
function Metric({ label, count, severity }) { return h('div', { className: `diagnostic-metric ${severity}` }, h('span', null, label), h('strong', null, count)); }

function TunnelHealthSummary({ health = {} }) {
  const components = [
    { key: 'controlPlane', label: 'Control plane', value: health.controlPlane },
    { key: 'responseDelivery', label: 'Response delivery', value: health.responseDelivery }
  ].filter(item => item.value && typeof item.value === 'object');
  if (!components.length) return null;
  const recovering = components.some(item => String(item.value.status || '') === 'degraded');
  if (!recovering) return null;
  return h('section', { className: 'card diagnostic-doctor-card warning', 'data-diagnostic-region': 'tunnel-health' },
    h('div', { className: 'card-head' },
      h('div', null,
        h('h3', null, 'Secure tunnel health')
      ),
      h(StatusPill, { label: 'Recovering', tone: 'warn' })
    ),
    h('div', { className: 'card-body diagnostic-doctor-list' }, components.map(item => {
      const value = item.value || {};
      const degraded = String(value.status || '') === 'degraded';
      return h('article', { className: `diagnostic-doctor-check ${degraded ? 'warn' : 'ok'}`, key: item.key },
        h('div', { className: 'diagnostic-doctor-check-head' },
          h('strong', null, item.label),
          h(StatusPill, { label: String(value.status || 'unknown'), tone: degraded ? 'warn' : 'ok' })
        ),
        h('p', null, `State: ${String(value.state || 'unknown')}${value.reasonCode ? ` · ${value.reasonCode}` : ''}`)
      );
    }))
  );
}

function TunnelDoctorResult({ result = {} }) {
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const presentation = tunnelDoctorPresentation(result);
  return h('section', { className: `card diagnostic-doctor-card${presentation.needsAttention ? ' warning' : ''}`, 'data-diagnostic-region': 'tunnel-doctor' },
    h('div', { className: 'card-head' },
      h('div', null,
        h('h3', null, 'Secure MCP Tunnel diagnostics'),
        h('p', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
          h('span', { className: 'sr-only' }, `${presentation.label}. `),
          presentation.message
        )
      ),
      h(StatusPill, { label: presentation.label, tone: presentation.tone })
    ),
    h('div', { className: 'card-body diagnostic-doctor-list' },
      checks.length ? checks.map((check, index) => {
        const checkView = tunnelDoctorCheckPresentation(check);
        const next = Array.isArray(check?.next) ? check.next.filter(Boolean) : [];
        return h('article', { className: `diagnostic-doctor-check ${checkView.tone}`.trim(), key: check?.id || index },
          h('div', { className: 'diagnostic-doctor-check-head' }, h('code', null, checkView.label || `check-${index + 1}`), h('strong', null, checkView.statusLabel)),
          checkView.tone !== 'pass' && checkView.summary ? h('p', null, checkView.summary) : null,
          checkView.tone !== 'pass' && checkView.why ? h('p', null, h('strong', null, 'Why: '), checkView.why) : null,
          next.length
            ? checkView.optionalSetup
              ? h('details', { className: 'diagnostic-doctor-optional-setup' },
                  h('summary', null, 'Optional setup'),
                  h('ul', null, next.map((item, itemIndex) => h('li', { key: itemIndex }, item)))
                )
              : h('ul', null, next.map((item, itemIndex) => h('li', { key: itemIndex }, item)))
            : null
        );
      }) : h('div', { className: 'diagnostic-log-empty' }, result.error || 'No individual tunnel checks were returned.'),
      result.truncated ? h('small', null, 'Technical output was truncated to keep this diagnostic bounded.') : null,
      result.rawOutput ? h('div', { className: 'diagnostic-copy diagnostic-doctor-raw' },
        h('details', null,
          h('summary', null, 'Technical output'),
          h('pre', null, result.rawOutput)
        )
      ) : null
    )
  );
}

function tunnelDoctorPresentation(result = {}) {
  const checks = Array.isArray(result.checks) ? result.checks : [];
  const statuses = checks.map(check => String(check?.status || 'UNKNOWN').toUpperCase());
  const failedChecks = Array.isArray(result.failedChecks) ? result.failedChecks.filter(Boolean) : [];
  const resultState = String(result.result || '').toLowerCase();
  const exitCode = Number(result.exitCode);
  const hasExitFailure = Number.isFinite(exitCode) && exitCode !== 0;
  const hasCheckFailure = failedChecks.length > 0 || statuses.includes('FAIL');
  const needsAttention = Boolean(result.error) || resultState === 'fail' || hasExitFailure || hasCheckFailure;
  const skipped = statuses.filter(status => status === 'SKIP').length;
  const passOrSkipOnly = statuses.length > 0 && statuses.every(status => status === 'PASS' || status === 'SKIP');
  const healthy = !needsAttention && (result.ok === true || resultState === 'pass' || passOrSkipOnly);

  if (!healthy) {
    return {
      needsAttention: true,
      tone: 'warn',
      label: 'Needs attention',
      message: result.error || 'One or more tunnel checks need attention.',
      toastMessage: result.error || 'Secure MCP Tunnel diagnostics found a problem.',
      toastVariant: 'warn'
    };
  }
  if (skipped > 0) {
    const noun = skipped === 1 ? 'optional check' : 'optional checks';
    return {
      needsAttention: false,
      tone: 'good',
      label: 'Healthy',
      message: `Tunnel checks passed. ${skipped} ${noun} ${skipped === 1 ? 'was' : 'were'} skipped because ${skipped === 1 ? 'it is' : 'they are'} not required.`,
      toastMessage: `Secure MCP Tunnel is healthy. ${skipped} ${noun} ${skipped === 1 ? 'was' : 'were'} skipped.`,
      toastVariant: 'success'
    };
  }
  return {
    needsAttention: false,
    tone: 'good',
    label: 'Passed',
    message: 'All tunnel checks passed.',
    toastMessage: 'Secure MCP Tunnel diagnostics passed.',
    toastVariant: 'success'
  };
}

function tunnelDoctorCheckPresentation(check = {}) {
  const id = String(check?.id || '');
  const status = String(check?.status || 'UNKNOWN').toUpperCase();
  if (status === 'PASS') return { label: id, statusLabel: 'Passed', tone: 'pass', summary: check?.summary || '', why: check?.why || '', optionalSetup: false };
  if (status === 'FAIL') return { label: id, statusLabel: 'Failed', tone: 'fail', summary: check?.summary || '', why: check?.why || '', optionalSetup: false };
  if (status === 'SKIP' && id === 'codex_plugin') {
    return {
      label: 'Codex integration',
      statusLabel: 'Optional',
      tone: 'optional',
      summary: 'Codex-native tunnel controls are optional and are not enabled.',
      why: 'Rel.AI and the Secure MCP Tunnel work normally without this plugin. Install it only if you want Codex-native tunnel controls.',
      optionalSetup: true
    };
  }
  if (status === 'SKIP') return { label: id, statusLabel: 'Skipped', tone: 'skip', summary: check?.summary || '', why: check?.why || '', optionalSetup: false };
  return { label: id, statusLabel: status, tone: '', summary: check?.summary || '', why: check?.why || '', optionalSetup: false };
}

function DiagnosticFindings({ findings, total, onReload }) {
  if (!findings.length) return total === 0
    ? h('div', { className: 'diagnostic-clear', 'data-diagnostic-region': 'findings' }, h('strong', null, 'No current problems'), h('span', null, 'Logs below may still contain earlier failures.'))
    : h('div', { className: 'diagnostic-log-empty', 'data-diagnostic-region': 'findings' }, h('strong', null, 'No findings match the current filters.'));
  return h('div', { className: 'diagnostic-list', 'data-diagnostic-region': 'findings' }, findings.map(finding => h(DiagnosticFinding, { finding, key: finding.code, onReload })));
}

function DiagnosticFinding({ finding, onReload }) {
  const [busy, setBusy] = useState(false);
  const canRestart = finding.action?.kind === 'restart_connection' && typeof window.relaiDesktop?.restartConnection === 'function';
  const retry = async () => {
    setBusy(true);
    const result = await restartConnection();
    setBusy(false);
    if (!result?.ok) { toast(result?.error || 'The connection could not be restarted.', { variant: 'error' }); return; }
    toast('Connection retry started. Rel.AI is checking the Secure MCP Tunnel.', { variant: 'success' });
    await onReload({ silent: true });
  };
  return h('article', { className: `diagnostic-finding ${finding.severity}` },
    h('div', { className: 'diagnostic-severity' }, findingSeverityLabel(finding.severity)),
    h('div', { className: 'diagnostic-copy' },
      h('h3', null, finding.title),
      h('p', null, h('strong', null, 'Impact:'), ` ${finding.impact}`),
      h('p', null, h('strong', null, 'Recommended action:'), ` ${finding.recommendation}`),
      Array.isArray(finding.context) && finding.context.length ? h('div', { className: 'diagnostic-context' }, finding.context.map((entry, index) => h('div', { className: 'diagnostic-context-row', key: index }, h('code', null, entry.tool || 'configuration change'), h('span', entry.ts ? { 'data-clock-relative': entry.ts } : null, entry.ts ? timeAgo(entry.ts) : ''), h('small', null, entry.path || entry.reason || 'No additional context recorded.')))) : null,
      canRestart ? h(React.Fragment, null, h('button', { className: 'secondary compact-button', type: 'button', disabled: busy, onClick: () => void retry() }, busy ? 'Retrying connection…' : (finding.action.label || 'Restart connection')), h('a', { className: 'buttonlike secondary compact-button', href: finding.action.href || '#settings/connection' }, 'Review connection settings')) : finding.action?.href ? h('a', { className: 'buttonlike secondary compact-button', href: finding.action.href }, finding.action.label || 'Details') : null,
      h('details', { 'data-diagnostic-detail': finding.code }, h('summary', null, 'Technical details'), h('p', null, h('strong', null, 'Code:'), ' ', h('code', null, finding.code)), h('pre', null, JSON.stringify(finding.details || {}, null, 2)))
    )
  );
}
function findingSeverityLabel(severity) { return severity === 'error' ? 'Blocking' : severity === 'warning' ? 'Warning' : 'Recommendation'; }

function DiagnosticLogs({ report, view, registerLog }) {
  const runtime = report.logs?.runtime || { available: false, entries: [] };
  const runtimeEmpty = runtime.available ? 'No app messages match the current filters.' : 'App logs are available in the desktop app.';
  return h('div', { className: 'diagnostic-log-grid', 'data-diagnostic-region': 'logs' },
    h(LogPanel, { keyName: 'runtime', title: 'App log', entries: view.runtime, emptyText: runtimeEmpty, available: runtime.available, subtitle: runtime.persistent ? (runtime.persistence?.healthy === false ? 'Rel.AI cannot save logs now. Logs from this session are still visible.' : 'Saved locally with sensitive values removed') : '', registerLog }),
    h(LogPanel, { keyName: 'failed', title: 'Failed activity', entries: view.failed, emptyText: 'No failed activity matches the current filters.', available: true, subtitle: '', registerLog })
  );
}
function LogPanel({ keyName, title, entries, emptyText, available, subtitle, registerLog }) {
  return h('section', { className: 'card diagnostic-log-card' },
    h('div', { className: 'card-head' }, h('div', null, h('h3', null, title), subtitle ? h('p', null, subtitle) : null), h('span', { className: 'section-action' }, available ? `${entries.length} shown` : 'Unavailable')),
    h('div', { className: 'card-body diagnostic-log-list', role: 'log', 'aria-label': title, ref: element => registerLog(keyName, element) }, available && entries.length ? entries.map((entry, index) => h(LogRow, { entry, key: `${entry.ts || 'unknown'}:${entry.eventId || index}` })) : h('div', { className: 'diagnostic-log-empty' }, emptyText))
  );
}
function LogRow({ entry }) {
  const message = entry.message || entry.error || 'Recorded diagnostic event';
  const source = entry.source || entry.tool || 'activity';
  const component = entry.component ? `${source}/${entry.component}` : source;
  const level = entry.level || (entry.error ? 'error' : 'info');
  const repeatCount = Math.max(1, Number(entry.repeatCount || 1));
  const context = {
    ...(entry.code || entry.errorCode ? { code: entry.code || entry.errorCode } : {}),
    ...(entry.workspace ? { project: entry.workspace } : {}),
    ...(entry.taskId ? { task: entry.taskId } : {}),
    ...(entry.eventId ? { event: entry.eventId } : {}),
    ...(entry.tool && entry.source ? { tool: entry.tool } : {}),
    ...(entry.operation ? { operation: entry.operation } : {}),
    ...(entry.details && typeof entry.details === 'object' ? entry.details : {})
  };
  return h('details', { className: `diagnostic-log-row ${level}` },
    h('summary', { className: 'diagnostic-log-summary' },
      h('time', { dateTime: entry.ts || '' }, localLogTime(entry.lastTs || entry.ts)),
      h('span', { className: `diagnostic-log-level ${level}` }, levelLabel(level)),
      h('code', { title: component }, component), h('span', { className: 'diagnostic-log-message' }, message), repeatCount > 1 ? h('span', { className: 'diagnostic-log-repeat' }, `×${repeatCount}`) : null
    ),
    h('div', { className: 'diagnostic-log-details' }, Object.keys(context).length ? h(React.Fragment, null, h('strong', null, 'Technical details'), h('pre', null, JSON.stringify(context, null, 2))) : h('span', null, 'No additional technical details.'))
  );
}
function localLogTime(value) { const timestamp = Date.parse(String(value || '')); return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString(undefined, { hour12: false }) : 'Unknown time'; }
function levelLabel(level) { return level === 'error' ? 'Error' : level === 'warning' ? 'Warning' : level === 'debug' ? 'Debug' : 'Info'; }

function DiagnosticUnavailable({ error, onRetry }) {
  return h('div', { id: 'diagnosticSummary', className: 'diagnostic-summary' }, h('div', { className: 'diagnostic-clear diagnostic-unavailable' },
    h('strong', null, 'Troubleshooting info unavailable'), h('span', null, error), h('small', null, 'Refresh the dashboard or restart the Rel.AI connection.'),
    h('div', { className: 'connection-actions' }, h('button', { className: 'secondary', type: 'button', onClick: onRetry }, 'Retry'), h('a', { className: 'buttonlike secondary', href: '#settings/connection' }, 'Connection'))
  ));
}

function applyRuntimeLogDelta(runtime = {}, change = {}) {
  const currentRevision = finiteRevision(runtime.revision);
  const incomingRevision = finiteRevision(change.revision);
  if (incomingRevision && incomingRevision <= currentRevision) return { kind: 'duplicate', runtime };
  if (incomingRevision && incomingRevision > currentRevision + 1) return { kind: 'refresh', runtime };
  const entries = Array.isArray(runtime.entries) ? runtime.entries : [];
  let nextEntries;
  if (change.type === 'replace') {
    const index = Number.isInteger(Number(change.index)) ? Number(change.index) : entries.length - 1;
    if (index < 0 || index >= entries.length) return { kind: 'refresh', runtime };
    nextEntries = [...entries];
    nextEntries[index] = change.entry;
  } else if (change.type === 'append') {
    nextEntries = [...entries, change.entry].slice(-100);
  } else {
    return { kind: 'refresh', runtime };
  }
  return {
    kind: 'applied',
    runtime: {
      ...runtime,
      entries: nextEntries,
      count: Math.max(Number(change.count || 0), change.type === 'append' ? Number(runtime.count || 0) + 1 : nextEntries.length, nextEntries.length),
      revision: incomingRevision || currentRevision
    }
  };
}

function diagnosticSources(report) {
  if (!report) return [];
  const sources = new Set();
  for (const entry of report.logs?.runtime?.entries || []) sources.add(String(entry.source || 'desktop'));
  for (const entry of report.logs?.failedActivity || []) sources.add(String(entry.tool || 'activity'));
  return [...sources].filter(Boolean).sort((left, right) => left.localeCompare(right));
}
function filteredDiagnosticView(report, filters) {
  if (!report) return { findings: [], runtime: [], failed: [], totalFindings: 0, totalLogs: 0, shownLogs: 0 };
  const showFindings = filters.scope === 'all' || filters.scope === 'findings';
  const showService = filters.scope === 'all' || filters.scope === 'service';
  const showFailed = filters.scope === 'all' || filters.scope === 'failed';
  const matchesSearch = values => !filters.search || values.some(value => String(value || '').toLowerCase().includes(filters.search));
  const findings = showFindings ? (report.findings || []).filter(finding => (filters.severity === 'all' || finding.severity === filters.severity) && matchesSearch([finding.code, finding.title, finding.impact, finding.recommendation, JSON.stringify(finding.context || [])])) : [];
  const matchesLog = (entry, kind) => {
    const level = kind === 'failed' ? 'error' : entry.level || (entry.error ? 'error' : 'info');
    const source = String(kind === 'failed' ? entry.tool || 'activity' : entry.source || 'desktop');
    if (filters.severity === 'all' && kind === 'runtime' && level === 'debug') return false;
    if (filters.severity !== 'all' && level !== filters.severity) return false;
    if (filters.source !== 'all' && source !== filters.source) return false;
    return matchesSearch([source, entry.component, entry.code, entry.errorCode, entry.message, entry.error, entry.workspace, entry.taskId, entry.eventId, JSON.stringify(entry.details || {})]);
  };
  const runtime = showService ? (report.logs?.runtime?.entries || []).filter(entry => matchesLog(entry, 'runtime')) : [];
  const failed = showFailed ? (report.logs?.failedActivity || []).filter(entry => matchesLog(entry, 'failed')) : [];
  return { findings, runtime, failed, totalFindings: (report.findings || []).length, totalLogs: (report.logs?.runtime?.entries || []).length + (report.logs?.failedActivity || []).length, shownLogs: runtime.length + failed.length };
}
function finiteRevision(value) { const revision = Number(value); return Number.isFinite(revision) ? Math.max(0, revision) : 0; }
function downloadDiagnosticState(report) { const exportedAt = new Date().toISOString(); const payload = { schemaVersion: 1, exportedAt, report }; const filename = `relai-diagnostic-state-${exportedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-')}.json`; const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.hidden = true; document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 0); return { ok: true, filename }; }
function messageOf(error) { return error instanceof Error ? error.message : String(error || 'The action failed.'); }

export { applyRuntimeLogDelta, diagnosticSources, filteredDiagnosticView };
