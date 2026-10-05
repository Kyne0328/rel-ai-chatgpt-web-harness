import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { fetchJson, postJson, requestDashboardRefresh } from '../../api.js';
import { copyText } from '../../clipboard.js';
import { confirmAction } from '../../components/confirm-dialog.js';
import { Icon } from '../../components/icons.js';
import { toast } from '../../components/toast.js';
import { formatDuration, timeAgo } from '../../utils.js';
import { getRouteParams, getWorkspaceFilter, replaceRouteParams, routeHref, setWorkspaceFilter } from '../../router.js';
import { activityEventId } from '../../activity-event.js';
import { orderWorkspacesAlphabetically } from '../../components/workspace-menu.js';
import { eventTimestampValue } from '../../../taskEvents.js';
import { classifyTaskChangedFiles } from '../../../taskSemanticProgress.js';
import { taskEntityView, workSessionStateView } from '../../task-identity.js';
import { StatusPill as UnifiedStatusPill } from '../../components/pill.js';
import { statusPillClass } from '../../status-tone.js';
import {
  isOngoingSession,
  mergeSessionDetail,
  mergeSessionEvents,
  operationForTool,
  orderChangedFiles,
  orderSessionEvents,
  semanticFileCounts,
  semanticProgressFor,
  sessionCountLabel,
  sessionDescription,
  sessionDurationMs,
  sessionIdentifier,
  sessionListTimestampValue,
  sessionNeedsAttention,
  sessionsForDisplay,
  taskTraceJsonl
} from './model.js';

const h = React.createElement;
const SESSION_PAGE_SIZE = 50;
const MOBILE_SESSION_PAGE_SIZE = 12;
const MOBILE_SESSION_QUERY = '(max-width: 760px)';
const TASK_HISTORY_PAGE_SIZE = 100;
const TASK_ACTIVITY_PAGE_SIZE = 200;
const TASK_HISTORY_URL = '/api/tasks/history';
const TASK_SESSION_URL = '/api/tasks/session';
const DETAIL_FILE_PREVIEW = 4;
const DETAIL_EVENT_PREVIEW = 8;
const SESSION_SLICES = Object.freeze(['config', 'tasks', 'auditTail']);

export function createSessionsRoute(useDashboardSlices) {
  return function SessionsRoute() {
    const data = useDashboardSlices(SESSION_SLICES);
    return h(SessionsPage, { data });
  };
}

function SessionsPage({ data = {} }) {
  const workspace = getWorkspaceFilter();
  const scopeKey = workspace || '__all__';
  const requestedId = String(getRouteParams().get('task') || '').trim();
  const [olderSessions, setOlderSessions] = useState([]);
  const [historyAvailability, setHistoryAvailability] = useState(() => new Map());
  const [historyLoadingScope, setHistoryLoadingScope] = useState('');
  const taskSource = useMemo(
    () => mergeTaskSources(olderSessions, Array.isArray(data.tasks) ? data.tasks : []),
    [data.tasks, olderSessions]
  );
  const allSessions = useMemo(() => sessionsForDisplay({ tasks: taskSource }, workspace), [taskSource, workspace]);
  const [taskQuery, setTaskQuery] = useState('');
  const [taskStatus, setTaskStatus] = useState('all');
  const sessions = useMemo(
    () => allSessions.filter(session => sessionMatchesFilters(session, taskQuery, taskStatus)),
    [allSessions, taskQuery, taskStatus]
  );
  const sessionById = useMemo(() => new Map(allSessions.map(session => [sessionIdentifier(session), session]).filter(([id]) => id)), [allSessions]);
  const pageSize = useSessionPageSize();
  const requestedIndex = requestedId ? sessions.findIndex(session => sessionIdentifier(session) === requestedId) : -1;
  const minimumVisible = Math.max(pageSize, requestedIndex >= 0 ? requestedIndex + 1 : 0);
  const [visibleByScope, setVisibleByScope] = useState(() => new Map());
  const visibleCount = Math.max(minimumVisible, Number(visibleByScope.get(scopeKey) || pageSize));
  const visibleSessions = sessions.slice(0, visibleCount);
  const remaining = Math.max(0, sessions.length - visibleSessions.length);
  const knownHistoryAvailability = historyAvailability.get(scopeKey);
  const canLoadOlder = knownHistoryAvailability !== undefined
    ? knownHistoryAvailability
    : workspace
      ? true
      : taskSource.length >= 100;
  const loadingOlder = historyLoadingScope === scopeKey;
  const openTaskCount = allSessions.reduce((count, session) => {
    const state = workSessionStateView(session);
    return count + (state.active === true || state.open === true ? 1 : 0);
  }, 0);
  const [selectedId, setSelectedId] = useState('');
  const taskListRef = useRef(null);
  const selectedIdRef = useRef('');
  selectedIdRef.current = selectedId;
  const [hydrated, setHydrated] = useState(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [olderExpanded, setOlderExpanded] = useState(false);
  const hydrationRequest = useRef(0);
  const selectedSummary = selectedId ? sessionById.get(selectedId) : null;
  const selectedSummaryHasTrace = Array.isArray(selectedSummary?.trace?.entries);
  const selectedHydrationCacheTtl = selectedSummary && isOngoingSession(selectedSummary) ? 1000 : 60_000;
  const selectedDetail = selectedSummary
    ? mergeSessionDetail(hydrated?.id === selectedId ? hydrated.session : {}, selectedSummary, data)
    : null;

  const selectSession = useCallback(id => {
    if (!id) return;
    // Keep mouse and keyboard selections in the route so a later task-data
    // refresh cannot restore the task from an older deep link.
    if (getRouteParams().get('task') !== id) replaceRouteParams({ task: id });
    if (selectedIdRef.current !== id) {
      setHydrated(null);
      setActiveTab('overview');
      setOlderExpanded(false);
    }
    setSelectedId(id);
  }, []);

  useEffect(() => {
    if (requestedId && sessionById.has(requestedId)) selectSession(requestedId);
  }, [requestedId, sessionById, selectSession]);

  useEffect(() => {
    if (!selectedId || selectedSummary) return;
    setSelectedId('');
    setHydrated(null);
  }, [selectedId, selectedSummary]);

  useEffect(() => {
    if (!selectedId || !selectedSummary) return undefined;
    const request = ++hydrationRequest.current;
    if (selectedSummaryHasTrace) {
      setHydrated({ id: selectedId, session: selectedSummary });
      return undefined;
    }
    let cancelled = false;
    void fetchJson(`${TASK_SESSION_URL}?task=${encodeURIComponent(selectedId)}`, { cacheTtlMs: selectedHydrationCacheTtl })
      .then(response => {
        if (cancelled || request !== hydrationRequest.current || response?.ok === false || !response?.session) return;
        setHydrated(previous => {
          const sameTask = previous?.id === selectedId;
          const previousEvents = sameTask ? previous.session?.events || [] : [];
          const session = {
            ...response.session,
            ...(response.trace ? { trace: response.trace } : {}),
            events: mergeSessionEvents(previousEvents, response.session.events || [])
          };
          return {
            id: selectedId,
            session,
            activity: sameTask && previous.activity?.pagingStarted === true
              ? previous.activity
              : { ...(response.activity || {}), pagingStarted: false }
          };
        });
      })
      .catch(error => {
        if (!cancelled && request === hydrationRequest.current) toast(error instanceof Error ? error.message : String(error), { variant: 'error' });
      });
    return () => {
      cancelled = true;
      hydrationRequest.current += 1;
    };
  }, [selectedHydrationCacheTtl, selectedId, selectedSummary, selectedSummaryHasTrace]);

  useEffect(() => {
    if (!selectedId || hydrated?.id !== selectedId) return;
    const liveEvents = (Array.isArray(data?.auditTail?.entries) ? data.auditTail.entries : [])
      .filter(event => String(event?.taskId || event?.sessionId || '').trim() === selectedId);
    if (!liveEvents.length) return;
    setHydrated(previous => {
      if (previous?.id !== selectedId) return previous;
      return {
        ...previous,
        session: {
          ...previous.session,
          events: mergeSessionEvents(previous.session?.events || [], liveEvents)
        }
      };
    });
  }, [data?.auditTail?.entries, hydrated?.id, selectedId]);

  const loadOlderActivity = useCallback(async () => {
    if (activityLoading || hydrated?.id !== selectedId || hydrated?.activity?.hasMore !== true || !hydrated.activity.nextCursor) return;
    setActivityLoading(true);
    try {
      const params = new URLSearchParams({
        task: selectedId,
        activityOnly: '1',
        activityLimit: String(TASK_ACTIVITY_PAGE_SIZE),
        activityCursor: JSON.stringify(hydrated.activity.nextCursor)
      });
      const response = await fetchJson(`${TASK_SESSION_URL}?${params.toString()}`, { pauseTimeoutWhenHidden: false });
      if (response?.ok === false || !Array.isArray(response?.activity?.entries)) {
        throw new Error(response?.error || 'Older task activity could not be loaded.');
      }
      setHydrated(previous => previous?.id === selectedId
        ? {
            ...previous,
            session: {
              ...previous.session,
              events: mergeSessionEvents(previous.session?.events || [], response.activity.entries)
            },
            activity: { ...(response.activity.page || {}), pagingStarted: true }
          }
        : previous);
      setOlderExpanded(true);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { variant: 'error' });
    } finally {
      setActivityLoading(false);
    }
  }, [activityLoading, hydrated, selectedId]);

  const showMoreVisible = useCallback(() => {
    setVisibleByScope(previous => {
      const next = new Map(previous);
      next.set(scopeKey, visibleCount + pageSize);
      return next;
    });
  }, [pageSize, scopeKey, visibleCount]);

  const loadOlderTasks = useCallback(async () => {
    if (historyLoadingScope) return;
    setHistoryLoadingScope(scopeKey);
    try {
      const params = new URLSearchParams({ limit: String(TASK_HISTORY_PAGE_SIZE) });
      if (workspace) params.set('workspace', workspace);
      const cursor = taskHistoryCursor(allSessions);
      if (cursor) params.set('cursor', JSON.stringify(cursor));
      const response = await fetchJson(`${TASK_HISTORY_URL}?${params.toString()}`, { pauseTimeoutWhenHidden: false });
      if (response?.ok === false || !Array.isArray(response?.tasks)) {
        throw new Error(response?.error || 'Task history could not be loaded.');
      }
      setOlderSessions(previous => mergeTaskSources(previous, response.tasks));
      setHistoryAvailability(previous => {
        const next = new Map(previous);
        next.set(scopeKey, response?.page?.hasMore === true);
        return next;
      });
      setVisibleByScope(previous => {
        const next = new Map(previous);
        next.set(scopeKey, Math.max(Number(next.get(scopeKey) || pageSize), visibleCount + pageSize));
        return next;
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { variant: 'error' });
    } finally {
      setHistoryLoadingScope('');
    }
  }, [allSessions, historyLoadingScope, pageSize, scopeKey, visibleCount, workspace]);

  const showMore = useCallback(() => {
    if (remaining > 0) {
      showMoreVisible();
      return;
    }
    if (canLoadOlder) void loadOlderTasks();
  }, [canLoadOlder, loadOlderTasks, remaining, showMoreVisible]);

  const onTaskListKeyDown = useCallback(event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const list = taskListRef.current;
    const current = event.target?.closest?.('.task-row');
    if (!list || !current || !list.contains(current)) return;
    const rows = [...list.querySelectorAll('.task-row')];
    const currentIndex = rows.indexOf(current);
    if (currentIndex < 0 || rows.length < 2) return;
    event.preventDefault();
    let nextIndex = currentIndex;
    if (event.key === 'ArrowDown') nextIndex = Math.min(rows.length - 1, currentIndex + 1);
    else if (event.key === 'ArrowUp') nextIndex = Math.max(0, currentIndex - 1);
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = rows.length - 1;
    const nextRow = rows[nextIndex];
    const id = String(nextRow?.dataset?.taskId || '');
    if (id) flushSync(() => selectSession(id));
    nextRow?.focus?.({ preventScroll: true });
    nextRow?.scrollIntoView?.({ block: 'nearest' });
  }, [selectSession]);

  return h('div', { className: 'section sessions-page', 'data-sessions-react': '' },
    h('div', { className: 'feature-toolbar sessions-toolbar' },
      h('div', { className: 'sessions-summary-line', 'data-session-summary': '' }, `${openTaskCount} open`),
      h('div', { className: 'section-head-actions sessions-filter-actions' },
        h('label', { className: 'sessions-search' },
          h('span', { className: 'sr-only' }, 'Search tasks'),
          h('input', {
            type: 'search',
            value: taskQuery,
            placeholder: 'Search tasks',
            'aria-label': 'Search tasks',
            onChange: event => setTaskQuery(event.target.value)
          })
        ),
        h('label', { className: 'filter-field' },
          h('span', { className: 'sr-only' }, 'Task status filter'),
          h('select', { 'aria-label': 'Task status filter', value: taskStatus, onChange: event => setTaskStatus(event.target.value) },
            h('option', { value: 'all' }, 'All statuses'),
            h('option', { value: 'open' }, 'Open'),
            h('option', { value: 'attention' }, 'Needs attention'),
            h('option', { value: 'completed' }, 'Completed'),
            h('option', { value: 'ended' }, 'Other ended')
          )
        ),
        h(ProjectFilter, { workspaces: data.config?.workspaces || [], selected: workspace }),
        h('span', { className: 'feature-count' }, sessions.length === allSessions.length
          ? sessionCountLabel(allSessions, workspace)
          : `${sessions.length} of ${allSessions.length} tasks`)
      )
    ),
    h('section', { className: 'card sessions-history-card' },
      h('div', { className: 'sessions-master-detail' },
        h('div', { className: 'card-body task-list', ref: taskListRef, onKeyDown: onTaskListKeyDown },
          visibleSessions.length
            ? h('ul', { className: 'task-list-items', role: 'list' },
                ...visibleSessions.map(session => h('li', { key: sessionIdentifier(session) },
                  h(TaskRow, {
                    session,
                    selected: sessionIdentifier(session) === selectedId,
                    onSelect: selectSession
                  })
                ))
              )
            : h('div', { className: 'empty' }, taskQuery || taskStatus !== 'all' ? 'No tasks match these filters.' : 'No tasks yet.'),
          (remaining > 0 || canLoadOlder) && h('div', { className: 'session-list-footer' },
            h('span', null, remaining > 0
              ? `${remaining} older task${remaining === 1 ? '' : 's'} hidden`
              : 'More retained task history is available'),
            h('button', {
              className: 'secondary',
              type: 'button',
              disabled: loadingOlder,
              onClick: showMore,
              'data-load-more-sessions': ''
            }, loadingOlder
              ? 'Loading…'
              : remaining > 0
                ? `Show ${Math.min(pageSize, remaining)} more`
                : 'Load older tasks')
          )
        ),
        h('aside', { className: 'session-inspector', 'data-session-inspector': '' },
          selectedDetail
            ? h(SessionInspector, {
                session: selectedDetail,
                activeTab,
                setActiveTab,
                olderExpanded,
                setOlderExpanded,
                activityHasMore: hydrated?.id === selectedId && hydrated?.activity?.hasMore === true,
                activityLoading,
                loadOlderActivity
              })
            : h('div', { className: 'inspector-empty' },
                h('strong', null, 'Select a task'),
                h('span', null, 'View its overview, activity, and technical details here.')
              )
        )
      )
    )
  );
}

function useSessionPageSize() {
  const mediaQuery = () => globalThis.window?.matchMedia?.(MOBILE_SESSION_QUERY);
  const [mobile, setMobile] = useState(() => mediaQuery()?.matches === true);
  useEffect(() => {
    const query = mediaQuery();
    if (!query) return undefined;
    const refresh = () => setMobile(query.matches);
    refresh();
    query.addEventListener?.('change', refresh);
    return () => query.removeEventListener?.('change', refresh);
  }, []);
  return mobile ? MOBILE_SESSION_PAGE_SIZE : SESSION_PAGE_SIZE;
}

function sessionMatchesFilters(session, query, status) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (normalizedQuery) {
    const searchable = [
      sessionIdentifier(session), session.workspace, session.title, session.objective, session.summary,
      session.currentActivity, session.currentStage, session.operation, session.lastTool
    ].map(value => String(value || '').toLowerCase()).join(' ');
    if (!searchable.includes(normalizedQuery)) return false;
  }
  if (!status || status === 'all') return true;
  const state = workSessionStateView(session);
  if (status === 'open') return state.active === true || state.open === true;
  if (status === 'attention') return sessionNeedsAttention(session) || ['waiting_for_approval', 'validation_failed', 'blocked', 'failed'].includes(state.status);
  if (status === 'completed') return state.status === 'completed';
  if (status === 'ended') return state.terminal === true && state.status !== 'completed' && !sessionNeedsAttention(session);
  return true;
}

function mergeTaskSources(existing = [], incoming = []) {
  const byId = new Map();
  for (const task of [...existing, ...incoming]) {
    const id = sessionIdentifier(task);
    if (!id) continue;
    byId.set(id, { ...(byId.get(id) || {}), ...task });
  }
  return [...byId.values()];
}

function taskHistoryCursor(sessions = []) {
  let candidate = null;
  for (const session of sessions) {
    const updatedAtMs = Math.max(0, Number(session?.historyUpdatedAtMs || 0));
    const id = sessionIdentifier(session);
    if (!updatedAtMs || !id) continue;
    if (!candidate
      || updatedAtMs < candidate.updatedAtMs
      || (updatedAtMs === candidate.updatedAtMs && id > candidate.id)) {
      candidate = { updatedAtMs, id };
    }
  }
  return candidate;
}

function ProjectFilter({ workspaces = [], selected = '' }) {
  const options = orderWorkspacesAlphabetically(workspaces);
  return h('label', { className: 'filter-field' },
    h('span', { className: 'sr-only' }, 'Project filter'),
    h('select', {
      'aria-label': 'Project filter',
      value: selected,
      onChange: event => setWorkspaceFilter(event.target.value)
    },
      h('option', { value: '' }, 'All projects'),
      ...options.map(workspace => h('option', { key: workspace.alias, value: workspace.alias }, workspace.alias))
    )
  );
}

const TaskRow = memo(function TaskRow({ session, selected, onSelect }) {
  const id = sessionIdentifier(session);
  const state = workSessionStateView(session);
  const live = isOngoingSession(session);
  const semantic = semanticProgressFor(session);
  const operation = semantic.currentActivity || session.currentActivity || session.operation || operationForTool(session.lastTool);
  const toolCalls = Number(session.toolCallCount ?? session.calls ?? 0);
  const projectFiles = semanticFileCounts(session, semantic).product;
  const project = session.workspace || 'No project';
  const title = session.title || operation;
  return h('button', {
    className: `task-row${selected ? ' is-selected' : ''}`,
    type: 'button',
    'data-task-id': id,
    'aria-current': selected ? 'true' : undefined,
    'aria-label': `${title}. ${state.label}. ${project}. ${toolCalls} tool call${toolCalls === 1 ? '' : 's'}. ${projectFiles} project file${projectFiles === 1 ? '' : 's'}.`,
    title,
    onClick: () => flushSync(() => onSelect(id))
  },
    h('span', { className: 'task-row-status' }, h(StatusPill, { state })),
    h('span', { className: 'task-row-main' },
      h('strong', null, title),
      h('span', { className: 'task-row-meta' }, `${project} · ${toolCalls} tool call${toolCalls === 1 ? '' : 's'} · ${projectFiles} project file${projectFiles === 1 ? '' : 's'}`)
    ),
    h('span', { className: 'task-row-time' }, h(SessionTime, { session, live })),
    h(Icon, { name: 'chevronRight', size: 16 })
  );
});


function StatusPill({ state, label = state?.label || 'Unknown' }) {
  const status = state?.status || label;
  const pillClass = state?.pillClass || statusPillClass(status);
  return h(UnifiedStatusPill, { label, classOverride: pillClass });
}

function SessionTime({ session, live }) {
  if (live) {
    const start = session.startedAt || session.createdAt || '';
    return h('span', { 'data-clock-elapsed-start': start }, formatDuration(sessionDurationMs(session), { live: true }) || '0s');
  }
  const end = sessionListTimestampValue(session);
  return h('span', end ? { 'data-clock-relative': end } : null, timeAgo(end) || '—');
}

function SessionInspector({ session, activeTab, setActiveTab, olderExpanded, setOlderExpanded, activityHasMore, activityLoading, loadOlderActivity }) {
  const headingRef = useRef(null);
  const previousId = useRef('');
  const id = sessionIdentifier(session);
  useEffect(() => {
    if (previousId.current === id) return;
    previousId.current = id;
    if (!window.matchMedia('(max-width: 760px)').matches) return;
    headingRef.current?.focus({ preventScroll: true });
  }, [id]);

  const identities = taskEntityView(session);
  const state = workSessionStateView(session);
  const live = isOngoingSession(session);
  const semantic = semanticProgressFor(session);
  const fileCounts = semanticFileCounts(session, semantic);
  const operationValue = session.operation || operationForTool(session.lastTool) || '—';
  const currentTitle = live ? (semantic.currentStage || state.label) : state.label;
  const currentCopy = live
    ? (semantic.currentActivity || operationValue || 'Task is open.')
    : (session.summary || session.endReason || sessionDescription(session, false, operationValue, semantic));
  const [controlKey, setControlKey] = useState('');
  useEffect(() => setControlKey(''), [id]);
  const runningOperations = live && Array.isArray(session.currentOperations) ? session.currentOperations : [];
  const controlTask = useCallback(async (action, operationId = '') => {
    const key = operationId ? `stop:${operationId}` : action;
    if (action === 'cancel') {
      const confirmed = await confirmAction({
        title: 'Cancel task?',
        message: 'Cancel this task and stop its current actions?',
        detail: 'Long-running commands continue. You can stop them from Running commands.',
        confirmLabel: 'Cancel task',
        danger: true
      });
      if (!confirmed) return;
    }
    setControlKey(key);
    try {
      const result = await postJson('/api/tasks/control', {
        action,
        work_id: id,
        ...(operationId ? { operationId } : {})
      }, { timeout: 10000, pauseTimeoutWhenHidden: false });
      if (result?.ok === false) {
        toast(result.error || 'The task action could not be completed.', { variant: 'error' });
        return;
      }
      toast(action === 'cancel'
        ? (result.status === 'cancelled' ? 'Task cancelled.' : 'Task cancellation requested.')
        : result.stoppedOperationCount
          ? `Stop requested for ${result.stoppedOperationCount} running action${result.stoppedOperationCount === 1 ? '' : 's'}.`
          : 'No matching running action needed to be stopped.', { variant: 'success' });
      requestDashboardRefresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { variant: 'error' });
    } finally {
      setControlKey('');
    }
  }, [id]);

  return h('div', { className: 'detail-stack session-detail' },
    h('header', { className: 'task-detail-header' },
      h('div', null,
        h('h2', { ref: headingRef, tabIndex: -1 }, session.title || operationValue)
      ),
      h('div', { className: 'task-detail-header-actions' },
        h(StatusPill, { state }),
        live && runningOperations.length ? h('button', {
          className: 'secondary', type: 'button', 'data-stop-task-operations': '',
          disabled: Boolean(controlKey),
          onClick: () => { void controlTask('stop'); }
        }, controlKey === 'stop' ? 'Stopping…' : 'Stop running actions') : null,
        live ? h('button', {
          className: 'secondary danger', type: 'button', 'data-cancel-task': '',
          disabled: Boolean(controlKey),
          onClick: () => { void controlTask('cancel'); }
        }, controlKey === 'cancel' ? 'Cancelling…' : 'Cancel task') : null
      )
    ),
    h(SessionTabs, { activeTab, setActiveTab }),
    h('div', { className: 'inspector-panel', id: 'session-panel-overview', role: 'tabpanel', 'aria-labelledby': 'session-tab-overview', tabIndex: 0, hidden: activeTab !== 'overview', 'data-session-panel': 'overview' },
      h('div', { className: 'task-detail-current' },
        live ? h('strong', null, currentTitle) : null,
        h('span', null, currentCopy)
      ),
      h(PlanSection, { plan: session.plan }),
      h('div', { className: 'task-detail-grid task-detail-facts' },
        h(Detail, { label: 'Project', value: session.workspace || 'No project' }),
        h(DurationDetail, { session, live }),
        h(Detail, { label: 'Tool calls', value: session.toolCallCount ?? session.calls ?? 0 }),
        h(Detail, { label: 'Project files', value: fileCounts.product }),
        fileCounts.support > 0 ? h(Detail, { label: 'Support artifacts', value: fileCounts.support }) : null
      ),
      h(AttentionSection, { session }),
      h(FailureHistorySection, { session }),
      h(ChangedFilesSection, { files: session.changedFiles || [], session }),
      h(OriginalRequest, { objective: session.objective })
    ),
    h('div', { className: 'inspector-panel', id: 'session-panel-activity', role: 'tabpanel', 'aria-labelledby': 'session-tab-activity', tabIndex: 0, hidden: activeTab !== 'activity', 'data-session-panel': 'activity' },
      h(TaskTraceSection, { session, olderExpanded, setOlderExpanded, activityHasMore, activityLoading, loadOlderActivity }),
      h('div', { className: 'session-inline-actions' },
        h('a', { className: 'buttonlike secondary', href: routeHref('activity', { workspace: session.workspace, task: id, time: 'all' }) }, 'Open in Activity')
      )
    ),
    h('div', { className: 'inspector-panel', id: 'session-panel-technical', role: 'tabpanel', 'aria-labelledby': 'session-tab-technical', tabIndex: 0, hidden: activeTab !== 'technical', 'data-session-panel': 'technical' },
      h(TechnicalDetails, { session, identities, state, operationValue, controlKey, onStopOperation: operationId => controlTask('stop', operationId) }),
      session.trace?.entries?.length
        ? h('div', { className: 'session-inline-actions' }, h('button', { className: 'secondary', type: 'button', onClick: () => exportTrace(session), 'data-export-task-trace': '' }, 'Export trace (.jsonl)'))
        : null
    )
  );
}

function SessionTabs({ activeTab, setActiveTab }) {
  const tabs = ['overview', 'activity', 'technical'];
  const onKeyDown = event => {
    const current = tabs.indexOf(activeTab);
    let next = null;
    if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next == null) return;
    event.preventDefault();
    setActiveTab(tabs[next]);
    event.currentTarget.querySelector(`[data-session-tab="${tabs[next]}"]`)?.focus({ preventScroll: true });
  };
  return h('div', { className: 'inspector-tabs', role: 'tablist', 'aria-label': 'Task details', onKeyDown },
    ...tabs.map(tab => h('button', {
      key: tab,
      className: `inspector-tab${activeTab === tab ? ' is-active' : ''}`,
      id: `session-tab-${tab}`,
      type: 'button',
      role: 'tab',
      'aria-selected': activeTab === tab ? 'true' : 'false',
      'aria-controls': `session-panel-${tab}`,
      tabIndex: activeTab === tab ? 0 : -1,
      'data-session-tab': tab,
      onClick: () => setActiveTab(tab)
    }, tab.charAt(0).toUpperCase() + tab.slice(1)))
  );
}

function Detail({ label, value }) {
  return h('div', null, h('span', null, label), h('strong', null, String(value)));
}

function DurationDetail({ session, live }) {
  if (!live) return h(Detail, { label: 'Duration', value: formatDuration(sessionDurationMs(session), { historical: true }) });
  const start = session.startedAt || session.createdAt || '';
  return h('div', null,
    h('span', null, 'Duration'),
    h('strong', { className: 'task-detail-clock', 'data-clock-elapsed-start': start }, formatDuration(sessionDurationMs(session), { live: true }))
  );
}

function PlanSection({ plan }) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (!steps.length) {
    return h('section', { className: 'task-detail-section task-plan-section', 'data-task-plan': '', 'data-task-plan-missing': '' },
      h('div', { className: 'task-detail-heading' },
        h('h3', null, 'Plan'),
        h('span', null, 'Required')
      ),
      h('p', { className: 'task-detail-note' }, 'Waiting for a plan before project work continues.')
    );
  }
  const resolved = steps.filter(step => ['completed', 'skipped'].includes(String(step?.status || ''))).length;
  const list = h('ol', { className: 'task-plan-list' },
    ...steps.map((step, index) => {
      const status = String(step?.status || 'pending');
      const markerIcon = status === 'completed' ? 'check' : status === 'skipped' ? 'minimize' : status === 'blocked' ? 'warning' : 'circle';
      const statusLabel = status === 'in_progress' ? 'In progress' : status.charAt(0).toUpperCase() + status.slice(1);
      const marker = status === 'in_progress'
        ? h('span', { className: 'task-plan-active-dot', 'aria-hidden': 'true' })
        : h(Icon, { name: markerIcon, size: 12 });
      return h('li', { key: `${String(step?.id || 'step')}:${index}`, className: `task-plan-step is-${status}`, 'data-plan-step-status': status },
        h('span', { className: 'task-plan-marker', role: 'img', 'aria-label': statusLabel }, marker),
        h('span', { className: 'task-plan-copy' },
          h('strong', null, String(step?.title || `Step ${index + 1}`)),
          step?.detail ? h('span', null, String(step.detail)) : null
        )
      );
    })
  );
  return h('section', { className: 'task-detail-section task-plan-section', 'data-task-plan': '' },
    h('div', { className: 'task-detail-heading' },
      h('h3', null, 'Plan'),
      h('span', { 'aria-label': `${resolved} of ${steps.length} steps resolved` }, `${resolved}/${steps.length}`)
    ),
    list
  );
}

function AttentionSection({ session }) {
  if (!sessionNeedsAttention(session)) return null;
  const items = [];
  const failures = Number(session.failures || session.failedToolCallCount || 0);
  if (failures) items.push(`${failures} tool call${failures === 1 ? '' : 's'} failed`);
  if (session.validation === 'failed' || session.status === 'validation_failed') items.push('Checks failed');
  if (session.status === 'blocked') items.push(session.endReason || workSessionStateView(session).label);
  if (session.status === 'failed') items.push(session.endReason || 'The task ended with an unresolved problem');
  return h('section', { className: 'task-detail-section task-detail-problems' },
    h('h3', null, 'Needs attention'),
    h('ul', null, ...items.map((item, index) => h('li', { key: `${item}:${index}` }, item)))
  );
}

function FailureHistorySection({ session }) {
  const failures = Number(session.failures || session.failedToolCallCount || 0);
  if (!failures || sessionNeedsAttention(session)) return null;
  const completed = workSessionStateView(session).status === 'completed';
  const label = completed
    ? `${failures} recovered tool-call failure${failures === 1 ? '' : 's'}`
    : `${failures} earlier tool-call failure${failures === 1 ? '' : 's'}`;
  return h('section', { className: 'task-detail-section task-detail-history' },
    h('p', null,
      h('span', null, label),
      h('span', { 'aria-hidden': 'true' }, ' · '),
      h('a', { href: routeHref('activity', { workspace: session.workspace, task: sessionIdentifier(session), time: 'all' }) }, 'View activity')
    )
  );
}

function ChangedFilesSection({ files, session }) {
  const classified = classifyTaskChangedFiles(orderChangedFiles(files));
  return h(React.Fragment, null,
    h(ChangedFileGroup, { title: 'Project files', files: classified.productFiles, session }),
    h(ChangedFileGroup, { title: 'Support artifacts', files: classified.supportArtifacts })
  );
}

function ChangedFileGroup({ title, files, session = null }) {
  const [expanded, setExpanded] = useState(false);
  const ordered = orderChangedFiles(files);
  if (!ordered.length) return null;
  const hiddenCount = Math.max(0, ordered.length - DETAIL_FILE_PREVIEW);
  const visible = expanded ? ordered : ordered.slice(0, DETAIL_FILE_PREVIEW);
  const moreControl = hiddenCount
    ? session
      ? h('a', { className: 'task-file-more', href: routeHref('code', { task: sessionIdentifier(session) }) }, `View all ${ordered.length} in Changes`)
      : h('button', {
          className: 'task-file-more',
          type: 'button',
          'aria-expanded': expanded ? 'true' : 'false',
          onClick: () => setExpanded(value => !value)
        }, expanded ? 'Show fewer files' : `Show ${hiddenCount} more file${hiddenCount === 1 ? '' : 's'}`)
    : null;
  return h('section', { className: 'task-detail-section' },
    h('div', { className: 'task-detail-heading' }, h('h3', null, title), h('span', null, ordered.length)),
    h(FileList, { files: visible, session, moreControl })
  );
}

function FileList({ files, session = null, moreControl = null }) {
  const taskId = session ? sessionIdentifier(session) : '';
  const rows = files.map(file => {
    if (!taskId) return h('li', { key: file }, h('code', null, file));
    return h('li', { className: 'task-file-link-row', key: file },
      h('a', {
        className: 'task-file-link',
        href: routeHref('code', { task: taskId, file }),
        'aria-label': `Open ${file} in Changes`
      }, h('code', null, file))
    );
  });
  if (moreControl) rows.push(h('li', { className: 'task-file-more-row', key: 'more-files' }, moreControl));
  return h('ul', { className: 'task-file-list' }, ...rows);
}

function OriginalRequest({ objective }) {
  if (!objective) return null;
  return h('details', { className: 'task-detail-section task-original-request' },
    h('summary', null, 'Original request'),
    h('p', null, objective)
  );
}

function TaskTraceSection({ session, olderExpanded, setOlderExpanded, activityHasMore, activityLoading, loadOlderActivity }) {
  const ordered = orderSessionEvents(session.events || []);
  if (!ordered.length) return h('div', { className: 'inspector-empty compact' },
    h('strong', null, 'No activity recorded'),
    h('span', null, 'Task activity will appear here as Rel.AI tools run.')
  );
  const visible = ordered.slice(0, DETAIL_EVENT_PREVIEW);
  const hidden = ordered.slice(DETAIL_EVENT_PREVIEW);
  return h('section', { className: 'task-detail-section' },
    h('div', { className: 'task-detail-heading' }, h('h3', null, 'Task activity'), h('span', null, ordered.length)),
    h('p', { className: 'task-detail-note' }, 'The raw trace is available under Technical.'),
    h('div', { className: 'task-event-list' },
      ...visible.map(event => h(EventRow, { key: activityEventId(event) || `${eventTimestampValue(event)}:${event.operation || event.tool || ''}`, event, session })),
      hidden.length && !olderExpanded
        ? h('button', { className: 'secondary task-event-more', type: 'button', onClick: () => setOlderExpanded(true), 'data-show-older-events': '' }, `Show ${hidden.length} older event${hidden.length === 1 ? '' : 's'}`)
        : null,
      ...(olderExpanded ? hidden.map(event => h(EventRow, { key: activityEventId(event) || `${eventTimestampValue(event)}:${event.operation || event.tool || ''}`, event, session, older: true })) : []),
      olderExpanded && activityHasMore
        ? h('button', {
            className: 'secondary task-event-more',
            type: 'button',
            disabled: activityLoading,
            onClick: loadOlderActivity,
            'data-load-older-task-activity': ''
          }, activityLoading ? 'Loading…' : 'Load older activity')
        : null
    )
  );
}

function EventRow({ event, session, older = false }) {
  const operation = event.title || event.tool?.operation || event.operation || operationForTool(event.tool?.name || event.tool);
  const timestamp = eventTimestampValue(event);
  const status = event.status || (event.ok === false ? 'failed' : 'succeeded');
  const command = String(event.command || '').trim();
  const href = routeHref('activity', {
    workspace: event.workspace || session.workspace,
    task: event.taskId || sessionIdentifier(session),
    event: activityEventId(event),
    time: 'all'
  });
  return h('a', {
    className: 'task-event task-event-link',
    'data-task-event-link': '',
    'data-task-older-event': older ? '' : undefined,
    href,
    'aria-label': `Open ${operation} event in Activity`
  },
    h('span', { 'data-clock-relative': timestamp }, timeAgo(timestamp)),
    h('span', { className: 'task-event-copy' },
      h('code', { title: event.tool?.name || event.tool || '' }, operation),
      event.summary ? h('small', null, event.summary) : null,
      command ? h('small', { className: 'task-event-command' }, h('span', null, 'Command'), h('code', null, command)) : null
    ),
    h(StatusPill, { state: { status, pillClass: '' }, label: status })
  );
}

function TechnicalDetails({ session, identities, state, operationValue, controlKey, onStopOperation }) {
  return h('div', { className: 'task-detail-technical is-expanded' },
    h('section', { className: 'task-detail-section' },
      h('div', { className: 'task-detail-heading' }, h('h3', null, 'Identifiers')),
      h('div', { className: 'task-detail-grid' },
        h(IdentifierDetail, { label: 'Rel.AI task ID', value: identities.logicalTaskId || sessionIdentifier(session) || '—' }),
        identities.processId ? h(IdentifierDetail, { label: 'Process ID', value: identities.processId }) : null,
        session.correlation?.conversationId ? h(IdentifierDetail, { label: 'Conversation ID', value: session.correlation.conversationId }) : null
      )
    ),
    h('section', { className: 'task-detail-section' },
      h('div', { className: 'task-detail-heading' }, h('h3', null, 'Runtime')),
      h('div', { className: 'task-detail-grid' },
        h(Detail, { label: 'State', value: state.label }),
        h(Detail, { label: 'Last action', value: operationValue }),
        h(Detail, { label: 'Validation', value: session.validation || 'not run' }),
        h(Detail, { label: 'End reason', value: session.endReason || (state.terminal ? 'completed' : 'still open') }),
        h(Detail, { label: 'Completion confirmed', value: session.completionKnown ? 'Yes' : 'No' })
      )
    ),
    h(CurrentOperations, { session, controlKey, onStopOperation })
  );
}

function IdentifierDetail({ label, value }) {
  const copy = () => void copyText(value)
    .then(() => toast('Identifier copied.', { variant: 'success' }))
    .catch(error => toast(error instanceof Error ? error.message : String(error), { variant: 'error' }));
  return h('div', null,
    h('span', null, label),
    h('strong', { className: 'task-detail-identifier' },
      h('code', null, value),
      h('button', { className: 'runtime-copy-id', type: 'button', onClick: copy, 'data-copy-value': value, 'aria-label': `Copy ${label} ${value}` }, 'Copy')
    )
  );
}

function CurrentOperations({ session, controlKey = '', onStopOperation }) {
  const executable = ['running', 'validating', 'working'].includes(String(session?.status || '')) && Number(session?.activeCalls || 0) > 0;
  const operations = executable && Array.isArray(session.currentOperations) ? session.currentOperations : [];
  if (!operations.length) return null;
  return h('section', { className: 'task-detail-section' },
    h('div', { className: 'task-detail-heading' }, h('h3', null, 'Running actions'), h('span', null, operations.length)),
    h('div', { className: 'task-event-list' }, ...operations.map((operation, index) => {
      const operationId = String(operation.id || operation.operationId || operation.invocationId || '');
      const stopping = Boolean(operation.stopRequestedAt) || controlKey === `stop:${operationId}`;
      return h('div', { className: 'task-event', key: operationId || `${operation.startedAt || ''}:${index}` },
        h('span', { 'data-clock-elapsed-start': operation.startedAt || '' }, formatDuration(Date.now() - Number(operation.startedAt || Date.now()), { live: true })),
        h('code', null, operation.label || operation.tool || 'action'),
        h('div', { className: 'task-operation-actions' },
          h(StatusPill, { state: { status: stopping ? 'stopping' : 'running', pillClass: 'working' }, label: stopping ? 'stopping' : 'running' }),
          operationId ? h('button', {
            className: 'secondary compact-button', type: 'button', 'data-stop-task-operation': operationId,
            disabled: Boolean(controlKey) || stopping,
            'aria-label': `Stop ${operation.label || operation.tool || 'running action'}`,
            onClick: () => { void onStopOperation?.(operationId); }
          }, stopping ? 'Stopping…' : 'Stop') : null
        )
      );
    }))
  );
}

function exportTrace(session) {
  const jsonl = taskTraceJsonl(session);
  if (!jsonl) return;
  const blob = new Blob([jsonl], { type: 'application/x-ndjson;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `relai-task-trace-${sessionIdentifier(session).slice(0, 24) || 'task'}.jsonl`;
  link.click();
  URL.revokeObjectURL(url);
}
