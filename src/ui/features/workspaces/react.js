import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import './styles.css';
import { Icon } from '../../components/icons.js';
import { StatusPill } from '../../components/pill.js';
import { toast } from '../../components/toast.js';
import { postJson, requestDashboardRefresh } from '../../api.js';
import { getRouteParams, getWorkspaceFilter, replaceRouteParams, routeHref } from '../../router.js';
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
  const views = useMemo(
    () => workspaces.map(workspace => workspaceCardView(workspace, healthByAlias.get(workspace.alias))),
    [workspaces, healthByAlias]
  );
  const findings = useMemo(() => actionableFindings(health), [health]);
  const [modal, setModal] = useState(null);

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
    h(DirectFilesystemAccess, { initial: data.config?.projectAccess }),
    !workspaces.length ? h(EmptyWorkspaceState, { onAdd: event => openForm('add', null, event.currentTarget) }) : h(React.Fragment, null,
      h('div', { className: 'workspace-grid workspace-grid-detailed' },
        views.map(view => h(WorkspaceCard, {
          key: view.alias,
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

function DirectFilesystemAccess({ initial = {} }) {
  const [enabled, setEnabled] = useState(initial?.directFilesystem === true);
  const [busy, setBusy] = useState(false);
  useEffect(() => setEnabled(initial?.directFilesystem === true), [initial?.directFilesystem]);
  const update = async value => {
    if (busy) return;
    setBusy(true);
    const result = await postJson('/api/workspaces', {
      action: 'project_access',
      directFilesystem: value
    }).catch(error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    setBusy(false);
    if (!result?.ok) {
      toast(result?.error || 'Could not save direct filesystem access.', { variant: 'error' });
      return;
    }
    const saved = result.config?.projectAccess?.directFilesystem === true;
    setEnabled(saved);
    requestDashboardRefresh();
    toast(saved ? 'Direct filesystem access enabled.' : 'Direct filesystem access disabled.', { variant: 'success' });
  };
  return h('section', { className: 'workspace-direct-access card', 'aria-labelledby': 'workspaceDirectAccessTitle' },
    h('div', { className: 'workspace-direct-access-copy' },
      h('strong', { id: 'workspaceDirectAccessTitle' }, 'Allow access outside projects'),
      h('p', null, 'When on, ChatGPT can read, search, and edit ordinary local files outside configured projects. Access is limited by this computer account and Rel.AI sensitive-path protections.')
    ),
    h('button', {
      className: 'workspace-direct-access-switch',
      type: 'button',
      role: 'switch',
      'aria-checked': String(enabled),
      'aria-labelledby': 'workspaceDirectAccessTitle',
      disabled: busy,
      onClick: () => { void update(!enabled); }
    }, busy ? 'Saving…' : enabled ? 'On' : 'Off')
  );
}

const WorkspaceCard = memo(function WorkspaceCard({ view, workspace, onEdit, onRepair }) {
  const [folderBusy, setFolderBusy] = useState(false);
  const repository = repositorySummary(view.operational);
  const pathParts = splitWorkspacePath(view.path);
  const notices = [];
  if (view.sessionActive) notices.push(view.taskHint ? `Active session: ${view.taskHint}` : 'Active editing session');
  if (view.cautionCount > 0) notices.push(`${view.cautionCount} protected configuration change${view.cautionCount === 1 ? '' : 's'} recorded`);
  const openFolder = async event => {
    if (folderBusy) return;
    setFolderBusy(true);
    const result = await postJson('/api/open-folder', { workspace: view.alias });
    setFolderBusy(false);
    if (result?.ok === false) toast(result.error || 'Folder opening is only available in the desktop app.', { variant: 'warn' });
    event.currentTarget?.focus?.();
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
    view.healthWarning ? h('div', { className: 'workspace-warning' },
      h('span', null, view.healthWarning),
      h('button', { className: 'secondary', type: 'button', onClick: event => onRepair(workspace, event.currentTarget) }, 'Fix folder')
    ) : null,
    h(WorkspaceReadiness, { available: view.available, repository }),
    notices.length ? h('div', { className: 'workspace-notice' }, notices.map(item => h('span', { key: item }, item))) : null,
    h('footer', { className: 'workspace-actions workspace-primary-actions' },
      document.documentElement.dataset.surface === 'desktop' ? h('button', {
        className: 'secondary', type: 'button', disabled: folderBusy, onClick: event => { void openFolder(event); }
      }, h(Icon, { name: 'folder', size: 14 }), h('span', null, folderBusy ? 'Opening…' : 'Project folder')) : null,
      h('button', { className: 'secondary', type: 'button', onClick: event => onEdit('edit', workspace, event.currentTarget) }, 'Edit project'),
      h('a', { className: 'buttonlike secondary', href: routeHref('usage', { workspace: view.alias }) }, 'Analytics')
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

function findingDotClass(severity) { return severity === 'error' ? 'bad' : severity === 'warning' ? 'warn' : ''; }
function cssEscape(value) { return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`); }
function prefersReducedMotion() { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true; }
