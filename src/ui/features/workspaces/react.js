import React, { Suspense, lazy, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './styles.css';
import { Icon } from '../../components/icons.js';
import { StatusPill } from '../../components/pill.js';
import { toast } from '../../components/toast.js';
import { postJson, requestDashboardRefresh } from '../../api.js';
import { getRouteParams, getWorkspaceFilter, replaceRouteParams, routeHref } from '../../router.js';
import { analyticsRangeScope } from '../usage/range-model.js';
import { loadAnalyticsModels } from '../usage/data.js';
import {
  actionableFindings,
  findingSeverityLabel,
  humanizeFindingCode,
  orderedWorkspaces,
  repositorySummary,
  workspaceCardView
} from './model.js';
import { DeleteProjectModal, ProjectFormModal, RepairProjectModal } from './react-modals.js';

const h = React.createElement;
const SparkChart = lazy(() => import('../../components/sparkline.js').then(module => ({ default: module.SparkChart })));
const WORKSPACE_STORE_KEYS = Object.freeze(['config', 'health']);

export function createWorkspacesRoute(useDashboardSlices) {
  return function WorkspacesRoute() {
    return h(WorkspacesView, { data: useDashboardSlices(WORKSPACE_STORE_KEYS) });
  };
}

function WorkspacesView({ data = {} }) {
  const allWorkspaces = useMemo(
    () => Array.isArray(data.config?.workspaces) ? data.config.workspaces : [],
    [data.config?.workspaces]
  );
  const workspaceFilter = getWorkspaceFilter();
  const routeParams = getRouteParams();
  const focusRequest = routeParams.get('focus') || '';
  const focusAlias = routeParams.get('workspace') || '';
  const createRequest = routeParams.get('create') === '1';
  const workspaces = useMemo(
    () => orderedWorkspaces(allWorkspaces, workspaceFilter),
    [allWorkspaces, workspaceFilter]
  );
  const workspaceByAlias = useMemo(
    () => new Map(allWorkspaces.map(workspace => [workspace.alias, workspace])),
    [allWorkspaces]
  );
  const health = useMemo(() => data.health || {}, [data.health]);
  const healthByAlias = useMemo(
    () => new Map((Array.isArray(health.workspaces) ? health.workspaces : []).map(item => [item.alias, item])),
    [health.workspaces]
  );
  const findings = useMemo(() => actionableFindings(health), [health]);
  const views = useMemo(
    () => workspaces.map(workspace => workspaceCardView(workspace, healthByAlias.get(workspace.alias),
      findings.find(finding => finding.workspace === workspace.alias && finding.severity === 'error'))),
    [workspaces, healthByAlias, findings]
  );
  const availableCount = views.filter(view => view.ready).length;
  const [modal, setModal] = useState(null);
  const analyticsAliases = useMemo(() => views.map(view => view.alias), [views]);
  const analyticsState = useWorkspaceAnalytics(analyticsAliases);

  useLayoutEffect(() => {
    if (!focusAlias || focusRequest !== '1') return;
    const card = document.querySelector(`[data-workspace-card="${cssEscape(focusAlias)}"]`);
    if (!(card instanceof HTMLElement)) return;
    card.tabIndex = -1;
    card.classList.add('workspace-card-focused');
    card.focus({ preventScroll: true });
    card.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    replaceRouteParams({ focus: null });
    const timer = window.setTimeout(() => card.classList.remove('workspace-card-focused'), 1800);
    return () => window.clearTimeout(timer);
  }, [focusAlias, focusRequest]);

  useEffect(() => {
    if (!createRequest) return;
    replaceRouteParams({ create: null });
    setModal({ kind: 'form', mode: 'add', opener: document.getElementById('commandPaletteBtn') });
  }, [createRequest]);

  const openForm = useCallback((mode, workspace, opener) => setModal({ kind: 'form', mode, workspace, opener }), []);
  const openRepair = useCallback((workspace, opener) => setModal({ kind: 'repair', workspace, opener }), []);
  const openDelete = useCallback((alias, opener) => setModal({ kind: 'delete', alias, opener }), []);
  const closeModal = useCallback(() => setModal(null), []);
  const fileAccess = h(ProjectFileAccessStatus, { enabled: data.config?.projectAccess?.directFilesystem === true });

  return h('div', { className: 'section', 'data-workspaces-react': '' },
    h('div', { className: 'feature-toolbar workspace-toolbar' },
      h('div', { className: 'section-head-actions' },
        workspaceFilter ? h('a', {
          className: 'buttonlike secondary compact-button workspace-focus-chip',
          href: '#workspaces',
          'aria-label': `Clear selected project filter: ${workspaceFilter}`,
          title: 'Show all projects'
        }, h('span', null, workspaceFilter), h(Icon, { name: 'close', size: 14 })) : null,
        h('span', { className: 'feature-count' }, `${allWorkspaces.length} project${allWorkspaces.length === 1 ? '' : 's'}`),
        h('button', { className: 'primary', type: 'button', onClick: event => openForm('add', null, event.currentTarget) }, 'Add project')
      )
    ),
    fileAccess,
    !workspaces.length ? h(EmptyWorkspaceState, { onAdd: event => openForm('add', null, event.currentTarget) }) : h(React.Fragment, null,
      h('div', { className: 'workspace-status-summary', role: 'group', 'aria-label': 'Project readiness summary' },
        h('span', null, h('strong', null, `${availableCount}/${workspaces.length}`), ' ready for ChatGPT'),
        h('span', { className: findings.length ? 'attention' : '' }, h('strong', null, findings.length), findings.length === 1 ? ' issue needs attention' : ' issues need attention')
      ),
      h('div', { className: 'workspace-grid workspace-grid-detailed' },
        views.map(view => h(WorkspaceCard, {
          key: view.alias,
          analytics: analyticsState.scopes.get(view.alias) || null,
          analyticsStatus: analyticsState.status,
          view,
          workspace: workspaceByAlias.get(view.alias),
          onEdit: openForm,
          onRepair: openRepair
        }))
      ),
      findings.length ? h(HealthFindings, { findings, workspaces: allWorkspaces, onRepair: openRepair, onDelete: openDelete }) : null
    ),
    modal?.kind === 'form' ? h(ProjectFormModal, {
      configuredWorkspaces: allWorkspaces,
      mode: modal.mode,
      workspace: modal.workspace,
      opener: modal.opener,
      onClose: closeModal
    }) : null,
    modal?.kind === 'repair' ? h(RepairProjectModal, {
      configuredWorkspaces: allWorkspaces,
      workspace: modal.workspace,
      opener: modal.opener,
      onClose: closeModal
    }) : null,
    modal?.kind === 'delete' ? h(DeleteProjectModal, {
      alias: modal.alias,
      opener: modal.opener,
      onClose: closeModal
    }) : null
  );
}

function ProjectFileAccessStatus({ enabled }) {
  return h('section', { className: 'workspace-direct-access', 'aria-label': 'File access' },
    h('div', { className: 'workspace-direct-access-copy' },
      h('strong', null, 'File access'),
      h('p', null, `Access outside projects: ${enabled ? 'On' : 'Off'}`)
    ),
    h('a', { className: 'buttonlike secondary compact-button', href: '#settings/privacy' }, 'Manage')
  );
}

const WorkspaceCard = memo(function WorkspaceCard({ analytics, analyticsStatus, view, workspace, onEdit, onRepair }) {
  const [folderBusy, setFolderBusy] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState('');
  const repository = repositorySummary(view.operational);
  const pathParts = splitWorkspacePath(view.path);
  const notices = [];
  if (view.cautionCount > 0) notices.push(`${view.cautionCount} protected configuration change${view.cautionCount === 1 ? '' : 's'} recorded`);
  const openFolder = async event => {
    if (folderBusy) return;
    setFolderBusy(true);
    const result = await postJson('/api/open-folder', { workspace: view.alias });
    setFolderBusy(false);
    if (result?.ok === false) toast(result.error || 'Folder opening is only available in the desktop app.', { variant: 'warn' });
    event.currentTarget?.focus?.();
  };
  const verifyRecovery = async () => {
    if (recoveryBusy) return;
    setRecoveryBusy(true);
    try {
      const result = await postJson('/api/workspace/mutation-recovery', { workspace: view.alias }, { pauseTimeoutWhenHidden: false });
      if (result?.ok === false) throw new Error(result.error || 'Cleanup check failed.');
      const message = result.blocked ? 'Rel.AI still cannot confirm that the previous action stopped.' : 'Project changes are available.';
      setRecoveryMessage(message);
      toast(message, { variant: result.blocked ? 'warn' : 'success' });
      // Refresh the projection after proof-backed recovery; never clear the lock in the UI.
      requestDashboardRefresh();
    } catch (error) {
      toast(String(error?.message || error), { variant: 'error' });
    } finally { setRecoveryBusy(false); }
  };
  return h('article', { className: 'workspace-card workspace-card-detailed', 'data-workspace-card': view.alias },
    h('header', { className: 'workspace-card-head' },
      h('div', { className: 'workspace-identity' },
        h('strong', null, view.alias),
        h('div', { className: 'workspace-path', title: view.path },
          h('span', { className: 'workspace-path-prefix' }, pathParts.prefix),
          h('span', { className: 'workspace-path-tail' }, pathParts.tail)
        )
      ),
      h(StatusPill, { label: view.statusLabel })
    ),
    view.mutationBlock ? h('div', { className: 'workspace-warning', role: 'status', 'data-workspace-mutation-block': view.alias },
      h('span', null, 'Rel.AI is checking whether a previous action fully stopped. Changes are temporarily paused to keep this project safe.'),
      h('button', { type: 'button', className: 'secondary', disabled: recoveryBusy,
        onClick: () => { void verifyRecovery(); } }, recoveryBusy ? 'Checking…' : 'Check again'),
      recoveryMessage ? h('small', { role: 'status' }, recoveryMessage) : null
    ) : null,
    view.healthWarning ? h('div', { className: 'workspace-warning' },
      h('span', null, view.healthWarning),
      h('button', { className: 'secondary', type: 'button', onClick: event => onRepair(workspace, event.currentTarget) }, 'Fix folder')
    ) : null,
    h(WorkspaceReadiness, { available: view.available, repository }),
    notices.length ? h('div', { className: 'workspace-notice' }, notices.map(item => h('span', { key: item }, item))) : null,
    analytics
      ? h(WorkspaceAnalytics, { scope: analytics })
      : analyticsStatus === 'loading'
        ? h(WorkspaceAnalyticsState, { label: 'Loading analytics…', loading: true })
        : analyticsStatus === 'error'
          ? h(WorkspaceAnalyticsState, { label: 'Analytics unavailable' })
          : null,
    h('footer', { className: 'workspace-actions workspace-primary-actions' },
      h('a', { className: 'buttonlike secondary', href: routeHref('tasks', { workspace: view.alias }), 'aria-label': `View tasks for ${view.alias}` }, 'View tasks'),
      h('a', { className: 'buttonlike secondary', href: routeHref('activity', { workspace: view.alias }), 'aria-label': `Activity for ${view.alias}` }, 'Activity'),
      h('details', { className: 'workspace-more' },
        h('summary', { 'aria-label': `More actions for ${view.alias}` }, 'More', h(Icon, { name: 'chevronDown', size: 14 })),
        h('div', { className: 'workspace-more-menu' },
          document.documentElement.dataset.surface === 'desktop' ? h('button', {
            className: 'secondary', type: 'button', disabled: folderBusy, onClick: event => { void openFolder(event); }
          }, h(Icon, { name: 'folder', size: 14 }), h('span', null, folderBusy ? 'Opening…' : 'Project folder')) : null,
          h('button', { className: 'secondary', type: 'button', onClick: event => onEdit('edit', workspace, event.currentTarget) }, 'Edit project'),
          h('a', { className: 'buttonlike secondary', href: routeHref('usage', { workspace: view.alias }) }, 'Analytics')
        )
      )
    )
  );
});

function splitWorkspacePath(value) {
  const path = String(value || '');
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (separator < 0) return { prefix: '', tail: path };
  return { prefix: path.slice(0, separator + 1), tail: path.slice(separator + 1) };
}

function WorkspaceReadiness({ available, repository }) {
  return h('section', { className: `workspace-readiness${available ? ' compact good' : ' bad'}`, 'aria-label': 'Project status' },
    available ? null : h('div', { className: 'workspace-access-summary' },
      h('span', { className: 'workspace-readiness-icon', 'aria-hidden': 'true' }, h(Icon, { name: 'warning', size: 16 })),
      h('div', { className: 'workspace-readiness-copy' },
        h('strong', null, 'Project folder unavailable'),
        h('p', null, 'Fix the project folder before using this project.')
      )
    ),
    h('dl', { className: 'workspace-readiness-facts' },
      h('div', { className: `workspace-readiness-fact ${repository.tone}` },
        h('dt', null, h('i', { 'aria-hidden': 'true' }), repository.kindLabel),
        h('dd', null, h('strong', null, repository.label), h('small', null, repository.description))
      )
    )
  );
}

function HealthFindings({ findings, workspaces, onDelete, onRepair }) {
  return h('section', { className: 'card' },
    h('div', { className: 'card-head' }, h('h3', null, 'Needs attention'), h('a', { className: 'section-action', href: '#diagnostics' }, 'Troubleshoot')),
    h('div', { className: 'card-body list' }, findings.map((finding, index) => {
      const alias = finding.workspace || '';
      const actionable = finding.code === 'workspace_unavailable' && alias;
      const title = finding.message || humanizeFindingCode(finding.code) || 'Project needs attention';
      const context = alias ? `Project: ${alias}` : 'Open Troubleshooting for details.';
      const content = h(React.Fragment, null,
        h('span', { className: `dot ${findingDotClass(finding.severity)}` }),
        h('div', { className: 'finding-main' }, h('div', { className: 'item-title' }, title), h('div', { className: 'item-sub' }, context))
      );
      if (actionable) {
        const workspace = workspaces.find(item => item.alias === alias);
        return h('div', { className: 'list-item finding-row', key: `${finding.code}-${alias}-${index}` },
          content,
          h('div', { className: 'finding-actions' },
            h('button', { className: 'secondary', type: 'button', onClick: event => onRepair(workspace, event.currentTarget) }, 'Fix folder'),
            h('button', { className: 'secondary danger', type: 'button', onClick: event => onDelete(alias, event.currentTarget) }, 'Remove')
          )
        );
      }
      return h('a', { className: 'list-item finding-link', href: '#diagnostics', key: `${finding.code}-${index}` },
        content,
        h('div', { className: 'item-time' }, h(StatusPill, { label: findingSeverityLabel(finding.severity), tone: findingDotClass(finding.severity) }))
      );
    }))
  );
}

function EmptyWorkspaceState({ onAdd }) {
  return h('section', { className: 'workspace-empty-state' },
    h('div', { className: 'workspace-empty-mark', 'aria-hidden': 'true' }, h(Icon, { name: 'add', size: 24 })),
    h('strong', null, 'Add your first project'),
    h('p', null, 'Select a local folder and give it a short name.'),
    h('button', { className: 'primary', type: 'button', onClick: onAdd }, 'Add project')
  );
}

function WorkspaceAnalytics({ scope }) {
  const completed = Number(scope?.completed || 0);
  const toolCalls = Number(scope?.toolCalls || 0);
  const successRate = Number(scope?.operationSuccessRate || 0);
  const infrastructureFailures = Number(scope?.infrastructureFailures || 0);
  const averageDuration = Number(scope?.averageDuration || 0);
  const values = Array.isArray(scope?.points) ? scope.points.map(point => Number(point.toolCalls || 0)) : [];
  return h('section', { className: 'workspace-analytics-mini', 'aria-label': `${scope.workspace || 'Project'} analytics` },
    h('div', { className: 'workspace-analytics-head' }, h('span', null, 'Last 24h')),
    h('div', { className: 'workspace-analytics-metrics' },
      h(MiniMetric, { label: 'Actions', value: formatInteger(toolCalls) }),
      h(MiniMetric, { label: 'Successful', value: completed ? formatPercent(successRate) : '—' }),
      h(MiniMetric, { label: 'Average time', value: completed ? formatDuration(averageDuration) : '—' })
    ),
    infrastructureFailures ? h('div', { className: 'connection-notice bad', role: 'status' }, `${formatInteger(infrastructureFailures)} Rel.AI internal ${infrastructureFailures === 1 ? 'error' : 'errors'}`) : null,
    values.length
      ? h(Suspense, { fallback: h('span', { className: 'workspace-analytics-sparkline-empty', 'aria-hidden': 'true' }) }, h(SparkChart, { values, className: 'workspace-analytics-sparkline' }))
      : h('span', { className: 'workspace-analytics-sparkline-empty', 'aria-hidden': 'true' })
  );
}

function MiniMetric({ label, value }) { return h('div', null, h('span', null, label), h('strong', null, value)); }

function WorkspaceAnalyticsState({ label, loading = false }) {
  return h('section', { className: 'workspace-analytics-mini', role: 'status', 'aria-live': 'polite', 'aria-busy': loading ? 'true' : undefined },
    h('div', { className: 'workspace-analytics-head' }, h('span', null, label)),
    loading ? h('span', { className: 'workspace-analytics-sparkline-empty', 'aria-hidden': 'true' }) : null
  );
}

function useWorkspaceAnalytics(aliases) {
  const key = aliases.join('\u0000');
  const previousKeyRef = useRef('');
  const [state, setState] = useState(() => ({ scopes: new Map(), status: 'loading' }));
  useEffect(() => {
    const desktop = globalThis.window?.relaiDesktop;
    if (!aliases.length || !desktop?.getLocalUsage) {
      previousKeyRef.current = key;
      setState({ scopes: new Map(), status: 'unavailable' });
      return undefined;
    }
    let active = true;
    const aliasChanged = previousKeyRef.current !== key;
    previousKeyRef.current = key;
    const load = () => {
      setState(current => ({ ...current, status: 'loading' }));
      void loadAnalyticsModels({ desktop, range: '24h', now: new Date() })
        .then(({ bounds, models }) => {
          if (!active) return;
          setState({ scopes: new Map(aliases.map(alias => [alias, analyticsRangeScope(models, bounds, { workspace: alias })])), status: 'ready' });
        })
        .catch(() => { if (active) setState(current => ({ ...current, status: 'error' })); });
    };
    if (aliasChanged) {
      load();
      return () => { active = false; };
    }
    const timer = window.setTimeout(load, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [aliases, key]);
  return state;
}

function findingDotClass(severity) { return severity === 'error' ? 'bad' : severity === 'warning' ? 'warn' : ''; }
function cssEscape(value) { return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`); }
function prefersReducedMotion() { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true; }
function formatInteger(value) { return Math.floor(Number(value) || 0).toLocaleString(); }
function formatPercent(value) { const number = Number(value) || 0; return `${number.toFixed(number >= 10 ? 1 : 2)}%`; }
function formatDuration(value) { const ms = Number(value) || 0; if (ms < 1000) return `${Math.floor(ms)} ms`; const seconds = ms / 1000; if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)} s`; return `${(seconds / 60).toFixed(1)} min`; }
