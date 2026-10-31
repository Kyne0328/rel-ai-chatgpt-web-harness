import React, { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, Suspense } from 'react';
import { flushSync } from 'react-dom';
import { fetchJson, postJson, reconcileUnconfirmedResult, requestDashboardRefresh } from '../../api.js';
import { confirmAction } from '../../components/confirm-dialog.js';
import { copyText } from '../../clipboard.js';
import { Icon } from '../../components/icons.js';
import { toast } from '../../components/toast.js';
import { formatDuration, timeAgo } from '../../utils.js';
import { getRouteParams, getRouteSnapshot, getWorkspaceFilter, navigate, replaceRouteParams, routeHref, setWorkspaceFilter, subscribeRoute } from '../../router.js';
import { activityEventId } from '../../activity-event.js';
import { orderWorkspacesAlphabetically } from '../../components/workspace-menu.js';
import { eventTimestampValue } from '../../../taskEvents.js';
import { activityDescription, activityDisplayAction } from '../activity/model.js';
import { workSessionStateView } from '../../task-identity.js';
import { StatusPill as UnifiedStatusPill } from '../../components/pill.js';
import { statusPillClass } from '../../status-tone.js';
import { processListView } from '../processes/index.js';
import { ProcessRow, useProcessMemory } from '../processes/react.js';
import {
  isOngoingSession,
  goalModeNotice,
  mergeSessionDetail,
  mergeSessionEvents,
  operationForTool,
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
  taskControlMessage,
  taskProcessGroups,
  taskRunningOperations,
  taskRowActivity,
  taskToolCallCount,
  taskValidationView
} from './model.js';

const h = React.createElement;
const TaskDiffViewer = React.lazy(() => import('../code/react.js').then(module => ({ default: module.TaskDiffViewer })));
const SESSION_PAGE_SIZE = 50;
const MOBILE_SESSION_PAGE_SIZE = 12;
const MOBILE_SESSION_QUERY = '(max-width: 760px)';

function chatLinkLabel(goal) {
  const labels = { finding_chat: 'Finding the ChatGPT conversation…', linked: 'ChatGPT conversation linked.',
    waiting_for_account: 'Chat linking is waiting for ChatGPT sign-in.', rate_limited: 'Chat linking is waiting for the account cooldown.',
    conflicting_matches: 'Multiple chats contain this task receipt. Automatic linking is paused.',
    needs_attention: 'Chat linking needs attention.' };
  const label = goal.chatLink.state === 'rate_limited' && goal.chatLink.rateLimitReason === 'read_budget'
    ? 'Chat linking is waiting for Rel.AI’s next account read window.'
    : labels[goal.chatLink.state] || 'Verifying the ChatGPT conversation…';
  return goal.nextAttemptAt ? `${label} Next check: ${new Date(goal.nextAttemptAt).toLocaleTimeString()}.` : label;
}
const TASK_HISTORY_PAGE_SIZE = 100;
const TASK_HISTORY_URL = '/api/tasks/history';
const TASK_SESSION_URL = '/api/tasks/session';
const DETAIL_EVENT_PREVIEW = 8;
const DETAIL_EVENT_INCREMENT = 20;
const SESSION_SLICES = Object.freeze(['config', 'tasks', 'auditTail', 'managedProcesses', 'commandOperations']);

export function createSessionsRoute(useDashboardSlices) {
  return function SessionsRoute() {
    const data = useDashboardSlices(SESSION_SLICES);
    return h(SessionsPage, { data });
  };
}

function SessionsPage({ data = {} }) {
  const route = useSyncExternalStore(subscribeRoute, getRouteSnapshot, getRouteSnapshot);
  const routeParams = useMemo(() => new URLSearchParams(route.search), [route.search]);
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
  const routeSearch = routeParams.get('search') || '';
  const [taskQuery, setTaskQuery] = useState(routeSearch);
  const taskStatus = routeParams.get('taskStatus') || 'all';
  useEffect(() => { setTaskQuery(routeSearch); }, [routeSearch]);
  const changeTaskQuery = value => {
    setTaskQuery(value);
    replaceRouteParams({ search: value });
  };
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
  const [selectedId, setSelectedId] = useState(requestedId);
  const taskListRef = useRef(null);
  const selectedIdRef = useRef('');
  selectedIdRef.current = selectedId;
  const [hydrated, setHydrated] = useState(null);
  const [hydrationState, setHydrationState] = useState(null);
  const [detailRefresh, setDetailRefresh] = useState(null);
  const requestedTab = routeParams.get('tab');
  const validTabs = useMemo(() => new Set(['overview', 'details', 'changes', 'activity', 'processes']), []);
  const [activeTab, setActiveTab] = useState(() => validTabs.has(requestedTab) ? requestedTab : 'overview');
  useEffect(() => {
    setActiveTab(validTabs.has(requestedTab) ? requestedTab : 'overview');
  }, [requestedTab, validTabs]);
  const selectTab = useCallback(tab => {
    setActiveTab(tab);
    replaceRouteParams({ tab: tab === 'overview' ? null : tab });
  }, []);
  const hydrationRequest = useRef(0);
  const activityPageLoading = useRef(false);
  const selectedSummary = selectedId ? sessionById.get(selectedId) : null;
  const selectedSummaryHasTrace = Array.isArray(selectedSummary?.trace?.entries);
  const selectedSummaryAvailable = Boolean(selectedSummary);
  // An off-page task has no summary of its own; a dashboard refresh must recheck its retained detail.
  const offPageRefresh = selectedSummaryAvailable ? null : data.tasks;
  const selectedSummaryRef = useRef(selectedSummary);
  selectedSummaryRef.current = selectedSummary;
  const selectedHydrationCacheTtl = selectedSummary && isOngoingSession(selectedSummary) ? 1000 : 60_000;
  const selectedHydratedSession = hydrated?.id === selectedId ? hydrated.session : null;
  const selectedDetail = selectedId === requestedId && (selectedSummary || selectedHydratedSession)
    ? mergeSessionDetail(selectedHydratedSession || {}, selectedSummary || {}, data)
    : null;

  const selectSession = useCallback(id => {
    if (!id) return;
    // Keep mouse and keyboard selections in the route so a later task-data
    // refresh cannot restore the task from an older deep link.
    if (getRouteParams().get('task') !== id) replaceRouteParams({ task: id, tab: null, file: null });
    if (selectedIdRef.current !== id) {
      setHydrated(null);
      setHydrationState(null);
      setDetailRefresh(null);
      setActiveTab(validTabs.has(getRouteParams().get('tab')) ? getRouteParams().get('tab') : 'overview');
    }
    setSelectedId(id);
  }, [validTabs]);

  const refreshSelectedSession = useCallback(id => {
    if (selectedIdRef.current === id) setDetailRefresh({ id });
  }, []);

  useEffect(() => {
    // A retained task can be older than the initial history page. Resolve its
    // deep link directly instead of requiring a summary in the loaded list.
    if (requestedId) selectSession(requestedId);
  }, [requestedId, selectSession]);

  useEffect(() => {
    if (requestedId) return;
    setSelectedId('');
    setHydrated(null);
    setHydrationState(null);
  }, [requestedId]);

  useEffect(() => {
    if (!selectedId) return undefined;
    const request = ++hydrationRequest.current;
    const forceRefresh = detailRefresh?.id === selectedId;
    const summary = selectedSummaryRef.current;
    // On selection, load the retained activity page, not the entire diagnostic trace.
    if (selectedSummaryHasTrace && !forceRefresh && Array.isArray(summary.events) && summary.events.length) {
      setHydrated({ id: selectedId, session: summary });
      setHydrationState({ id: selectedId, status: 'ready' });
      return undefined;
    }
    let cancelled = false;
    setHydrationState(previous => previous?.id === selectedId && previous.status === 'ready'
      ? previous : { id: selectedId, status: 'loading' });
    void fetchJson(`${TASK_SESSION_URL}?task=${encodeURIComponent(selectedId)}${summary ? '&activityOnly=1' : ''}`, {
      cacheTtlMs: selectedHydrationCacheTtl,
      // Off-page detail has no live summary to supersede a cached response.
      ...(forceRefresh || !summary ? { cache: 'no-store' } : {})
    })
      .then(response => {
        if (cancelled || request !== hydrationRequest.current) return;
        const returnedSession = summary && response?.activity?.entries
          ? { ...summary, events: response.activity.entries }
          : response?.session;
        if (response?.ok === false || !returnedSession) {
          const unavailable = response?.httpStatus === 404 || (response?.ok !== false && !returnedSession);
          setHydrationState({
            id: selectedId,
            status: unavailable ? 'unavailable' : 'error',
            message: response?.error || (unavailable ? 'No retained details were found for this task.' : 'Task details could not be loaded.')
          });
          return;
        }
        if (sessionIdentifier(returnedSession) !== selectedId) {
          setHydrationState({ id: selectedId, status: 'error', message: 'The returned details did not match the requested task. Try again.' });
          return;
        }
        setHydrationState({ id: selectedId, status: 'ready' });
        setHydrated(previous => {
          const sameTask = previous?.id === selectedId;
          const previousEvents = sameTask ? previous.session?.events || [] : [];
          const session = {
            ...returnedSession,
            ...(response.trace ? { trace: response.trace } : {}),
            events: mergeSessionEvents(previousEvents, returnedSession.events || [])
          };
          return {
            id: selectedId,
            session,
            activity: response.activity?.page || response.activity || {}
          };
        });
      })
      .catch(error => {
        if (!cancelled && request === hydrationRequest.current) {
          setHydrationState({ id: selectedId, status: 'error', message: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      cancelled = true;
      hydrationRequest.current += 1;
    };
  }, [detailRefresh, offPageRefresh, selectedHydrationCacheTtl,
    selectedId, selectedSummaryAvailable, selectedSummaryHasTrace]);

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

  const loadMoreActivity = useCallback(async () => {
    const taskId = selectedIdRef.current;
    const page = hydrated?.id === taskId ? hydrated.activity : null;
    if (!taskId || !page?.hasMore || !page.nextCursor || activityPageLoading.current) return false;
    activityPageLoading.current = true;
    try {
      const params = new URLSearchParams({
        task: taskId, activityOnly: '1', activityLimit: '200',
        activityCursor: JSON.stringify(page.nextCursor)
      });
      const response = await fetchJson(`${TASK_SESSION_URL}?${params.toString()}`, { cache: 'no-store', pauseTimeoutWhenHidden: false });
      if (response?.ok === false || !Array.isArray(response?.activity?.entries)) {
        throw new Error(response?.error || 'Older task activity could not be loaded.');
      }
      if (selectedIdRef.current !== taskId) return false;
      setHydrated(previous => previous?.id !== taskId ? previous : {
        ...previous,
        activity: response.activity.page,
        session: { ...previous.session, events: mergeSessionEvents(previous.session.events || [], response.activity.entries) }
      });
      return true;
    } finally {
      activityPageLoading.current = false;
    }
  }, [hydrated]);

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
            'aria-describedby': 'task-search-scope',
            maxLength: 200,
            onChange: event => changeTaskQuery(event.target.value)
          })
        ),
        h('label', { className: 'filter-field' },
          h('span', { className: 'sr-only' }, 'Task status filter'),
          h('select', { 'aria-label': 'Task status filter', value: taskStatus, onChange: event => replaceRouteParams({ taskStatus: event.target.value }) },
            h('option', { value: 'all' }, 'All statuses'),
            h('option', { value: 'open' }, 'Open'),
            h('option', { value: 'attention' }, 'Needs attention'),
            h('option', { value: 'completed' }, 'Completed'),
            h('option', { value: 'ended' }, 'Other ended')
          )
        ),
        (taskQuery || taskStatus !== 'all') ? h('button', {
          className: 'secondary', type: 'button',
          onClick: () => { setTaskQuery(''); replaceRouteParams({ search: null, taskStatus: null }); }
        }, 'Clear filters') : null,
        h(ProjectFilter, { workspaces: data.config?.workspaces || [], selected: workspace }),
        h('span', { className: 'feature-count' }, sessions.length === allSessions.length
          ? sessionCountLabel(allSessions, workspace)
          : `${sessions.length} of ${allSessions.length} tasks`)
      )
    ),
    h('p', { id: 'task-search-scope', className: 'sessions-summary-line', 'data-task-search-scope': '' },
      `Search and status filters apply to ${allSessions.length} loaded task${allSessions.length === 1 ? '' : 's'}${workspace ? ` in ${workspace}` : ''}.${canLoadOlder ? ' Load older tasks to search more retained history.' : ''}`
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
            : h('div', { className: 'empty' }, taskQuery || taskStatus !== 'all' ? 'No loaded tasks match these filters.' : 'No tasks loaded.'),
          (remaining > 0 || canLoadOlder) && h('div', { className: 'session-list-footer' },
            h('span', null, remaining > 0
              ? `${remaining} older task${remaining === 1 ? '' : 's'} hidden`
              : knownHistoryAvailability === true ? 'More retained task history is available' : 'Check for older retained tasks'),
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
          selectedDetail && !sessions.some(session => sessionIdentifier(session) === requestedId)
            ? h('p', { className: 'sessions-summary-line', 'data-task-selection-context': '' }, 'This selected task is outside the loaded, filtered list.')
            : null,
          requestedId ? h(TaskDetailFeedback, {
            taskId: requestedId,
            state: hydrationState?.id === requestedId ? hydrationState : { status: 'loading' },
            hasDetail: Boolean(selectedDetail),
            onRetry: () => refreshSelectedSession(requestedId)
          }) : null,
          selectedDetail
            ? h(SessionInspector, {
                key: selectedId,
                session: selectedDetail,
                activeTab,
                setActiveTab: selectTab,
                activityHasMore: hydrated?.id === selectedId && hydrated?.activity?.hasMore === true,
                onLoadMoreActivity: loadMoreActivity,
                onControlComplete: refreshSelectedSession,
                managedProcesses: data.managedProcesses || [],
                commandOperations: data.commandOperations || [],
                requestedFilePath: routeParams.get('file') || ''
              })
            : !requestedId ? h('div', { className: 'inspector-empty' },
                h('strong', null, 'Select a task'),
                h('span', null, 'Review its progress, changes, checks, and activity.')
              ) : null
        )
      )
    )
  );
}

function TaskDetailFeedback({ taskId, state, hasDetail, onRetry }) {
  if (state.status === 'ready' || (state.status === 'loading' && hasDetail)) return null;
  const loading = state.status === 'loading';
  const title = loading ? 'Loading task…'
    : state.status === 'unavailable' ? 'Task details unavailable' : 'Could not load task details';
  return h('div', {
    className: hasDetail ? 'connection-notice' : 'inspector-empty',
    role: loading ? 'status' : 'alert',
    'aria-busy': loading,
    'data-task-detail-state': state.status
  },
    h('strong', null, title),
    !hasDetail ? h('span', { className: 'mono' }, taskId) : null,
    !loading ? h('span', null, `${state.message || 'Try loading this task again.'}${hasDetail ? ' Showing the last available task details.' : ''}`) : null,
    !loading ? h('button', { className: 'secondary', type: 'button', 'data-retry-task-detail': '', onClick: onRetry }, 'Retry task details') : null
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
  const toolCalls = taskToolCallCount(session);
  const projectFiles = semanticFileCounts(session, semantic).product;
  const project = session.workspace || 'No project';
  const title = session.title || operation;
  const activity = taskRowActivity(session, semantic);
  return h('button', {
    className: `task-row${selected ? ' is-selected' : ''}`,
    type: 'button',
    'data-task-id': id,
    'aria-current': selected ? 'true' : undefined,
    title,
    onClick: () => flushSync(() => onSelect(id))
  },
    h('span', { className: 'task-row-status' }, h(StatusPill, { state })),
    h('span', { className: 'task-row-main' },
      h('strong', null, title),
      activity && activity !== title ? h('span', { className: 'task-row-activity', title: activity }, activity) : null,
      h('span', { className: 'task-row-meta' }, `${project}${session.goalMode?.goalActive ? ' · Goal' : ''} · ${toolCalls === null ? 'Tool calls not recorded' : `${toolCalls} tool call${toolCalls === 1 ? '' : 's'}`} · ${projectFiles} project file${projectFiles === 1 ? '' : 's'}`)
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

function SessionInspector({ session, activeTab, setActiveTab, activityHasMore, onLoadMoreActivity, onControlComplete, managedProcesses = [], commandOperations = [], requestedFilePath = '' }) {
  const headingRef = useRef(null);
  const previousId = useRef('');
  const id = sessionIdentifier(session);
  const [changesVisited, setChangesVisited] = useState(() => activeTab === 'changes');
  const [selectedDiffFile, setSelectedDiffFile] = useState(requestedFilePath);

  useEffect(() => {
    if (activeTab === 'changes') setChangesVisited(true);
  }, [activeTab]);

  useEffect(() => {
    if (requestedFilePath) setSelectedDiffFile(requestedFilePath);
  }, [requestedFilePath]);

  useEffect(() => {
    if (previousId.current === id) return;
    previousId.current = id;
    if (!window.matchMedia('(max-width: 760px)').matches) return;
    headingRef.current?.focus({ preventScroll: true });
    // A selected task's inspector follows the list on narrow screens. Reveal
    // the new selection once; hydration and live updates keep the same ID.
    headingRef.current?.scrollIntoView({ behavior: 'instant', block: 'start', inline: 'nearest' });
  }, [id]);

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
  const [controlNotice, setControlNotice] = useState('');
  useEffect(() => { setControlKey(''); }, [id]);
  const activeGoal = session.goalMode?.goalActive === true;
  const goalNotice = goalModeNotice(session.goalMode);
  const runningOperations = taskRunningOperations(session);

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
      const mutation = await postJson('/api/tasks/control', {
        action,
        work_id: id,
        ...(operationId ? { operationId } : {})
      }, { timeout: 10000, pauseTimeoutWhenHidden: false });
      const result = await reconcileUnconfirmedResult(mutation, action === 'cancel' || action === 'goal_stop' ? async () => {
        const state = await fetchJson(`${TASK_SESSION_URL}?task=${encodeURIComponent(id)}`, { cache: 'no-store', pauseTimeoutWhenHidden: false });
        if (!state?.ok || sessionIdentifier(state.session) !== id) return false;
        return action === 'cancel' ? state.session.status === 'cancelled'
          : state.session.goalMode?.goalActive === false;
      } : null);
      if (result?.ok === false) {
        toast(result.error || 'The task action could not be completed.', { variant: result.outcomeUnknown ? 'warn' : 'error' });
        return;
      }
      const message = result.reconciled ? (action === 'cancel' ? 'Task cancellation confirmed.' : 'Goal stopped.')
        : taskControlMessage(action, result);
      setControlNotice(message);
      toast(message, { variant: result.processCleanup?.complete === false ? 'warn' : 'success' });
      requestDashboardRefresh();
      // Off-page tasks may remain absent from the refreshed summary list.
      onControlComplete?.(id);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { variant: 'error' });
    } finally {
      setControlKey('');
    }
  }, [id, onControlComplete]);

  const openLinkedChat = async () => {
    setControlKey('open_chat');
    try {
      const result = await window.relaiDesktop.browser.goalLoginStart({
        tunnelId: session.goalMode.tunnelId, conversationId: session.goalMode.conversationId
      });
      if (result?.ok === false) throw new Error(result.error || 'The linked chat could not be opened.');
      navigate('browser');
    } catch (error) { toast(error instanceof Error ? error.message : String(error), { variant: 'error' }); }
    finally { setControlKey(''); }
  };

  const ownedProcessCount = taskProcessGroups(managedProcesses, id, session.workspace).owned.length;
  const taskCommands = commandOperations.filter(command => String(command.workId || '') === id);
  const commandIds = new Set(taskCommands.map(command => String(command.operationId || '')));
  const otherOperations = taskRunningOperations(session).filter(operation =>
    !commandIds.has(String(operation.id || operation.operationId || operation.invocationId || '')));
  const tabCounts = {
    changes: fileCounts.product + fileCounts.support,
    processes: ownedProcessCount + taskCommands.length + otherOperations.length,
    processesLabel: `${taskCommands.length + otherOperations.length} task operations and ${ownedProcessCount} managed commands`
  };

  return h('div', { className: 'detail-stack session-detail' },
    h('header', { className: 'task-detail-header' },
      h('div', null,
        h('h2', { ref: headingRef, tabIndex: -1 }, session.title || operationValue),
        h('p', { className: 'task-project-context' }, 'Project: ', h('strong', null, session.workspace || 'No project'))
      ),
      h('div', { className: 'task-detail-header-actions' },
        h(StatusPill, { state }),
        session.goalMode?.state === 'needs_auth' || session.goalMode?.authRequired ? h('a', { href: routeHref('settings/connection', { tunnel: session.goalMode.tunnelId }), className: 'buttonlike secondary' }, 'Sign in to ChatGPT') : null,
        activeGoal ? h('button', {
          className: 'secondary', type: 'button', 'data-stop-goal': '',
          title: 'Stop automatic ChatGPT continuations without cancelling the task.',
          disabled: Boolean(controlKey),
          onClick: () => { void controlTask('goal_stop'); }
        }, controlKey === 'goal_stop' ? 'Stopping…' : 'Stop Goal') : null,
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
    controlNotice ? h('p', { className: 'connection-notice', role: 'status' }, controlNotice) : null,
    h('div', { className: 'inspector-navigation' },
      h(SessionTabs, { activeTab, setActiveTab, counts: tabCounts })
    ),
    h('div', { className: 'inspector-panel', id: 'session-panel-overview', role: 'tabpanel', 'aria-labelledby': 'session-tab-overview', tabIndex: 0, hidden: activeTab !== 'overview', 'data-session-panel': 'overview' },
      h('div', { className: 'task-detail-current' },
        live ? h('strong', null, currentTitle) : null,
        h('span', null, currentCopy)
      ),
      session.goalMode?.chatLink && session.goalMode.chatLink.state !== 'inactive' ? h('div', { className: 'detail-stack', 'data-chat-link': '' },
        h('p', { role: 'status' }, chatLinkLabel(session.goalMode)),
        session.goalMode.chatLink.state === 'linked' && session.goalMode.tunnelId
          && typeof window.relaiDesktop?.browser?.goalLoginStart === 'function'
          ? h('button', { type: 'button', className: 'secondary', disabled: Boolean(controlKey),
            onClick: () => { void openLinkedChat(); } }, controlKey === 'open_chat' ? 'Opening…' : 'Open linked chat') : null,
        !session.goalMode.goalActive && session.goalMode.error
          ? h('p', { className: 'connection-notice', role: 'status' }, session.goalMode.error) : null
      ) : null,
      goalNotice
        ? h('p', { className: goalNotice.waiting ? 'connection-notice' : 'connection-notice bad',
          role: 'status', 'data-goal-pause': '' }, goalNotice.message)
        : null,
      h(PlanSection, { plan: session.plan }),
      h('div', { className: 'task-detail-grid task-detail-facts' },
        h(Detail, { label: 'Project', value: session.workspace || 'No project' }),
        h(DurationDetail, { session, live }),
        h(Detail, { label: 'Tool calls', value: taskToolCallCount(session) ?? 'Not recorded' }),
        h(Detail, { label: 'Project files', value: fileCounts.product }),
        fileCounts.support > 0 ? h(Detail, { label: 'Support artifacts', value: fileCounts.support }) : null
      ),
      h(AttentionSection, { session }),
      h(FailureHistorySection, { session }),
      h(OriginalRequest, { objective: session.objective })
    ),
    h('div', { className: 'inspector-panel', id: 'session-panel-details', role: 'tabpanel', 'aria-labelledby': 'session-tab-details', tabIndex: 0, hidden: activeTab !== 'details', 'data-session-panel': 'details' },
      h(TaskDetailsSection, { session, state, fileCounts })
    ),
    h('div', { className: 'inspector-panel', id: 'session-panel-changes', role: 'tabpanel', 'aria-labelledby': 'session-tab-changes', tabIndex: 0, hidden: activeTab !== 'changes', 'data-session-panel': 'changes' },
      changesVisited ? h(Suspense, {
        fallback: h('div', { className: 'code-editor-message', role: 'status' }, 'Loading diff viewer…')
      }, h(TaskDiffViewer, {
        taskId: id,
        initialFilePath: selectedDiffFile,
        active: activeTab === 'changes',
        changeRevision: session.changeRevision,
        onSelectFile: path => {
          setSelectedDiffFile(path);
          replaceRouteParams({ tab: 'changes', file: path });
        }
      })) : null
    ),
    h('div', { className: 'inspector-panel', id: 'session-panel-activity', role: 'tabpanel', 'aria-labelledby': 'session-tab-activity', tabIndex: 0, hidden: activeTab !== 'activity', 'data-session-panel': 'activity' },
      activeTab === 'activity' ? h(TaskTraceSection, { session, activityHasMore, onLoadMoreActivity }) : null
    ),
    h('div', { className: 'inspector-panel', id: 'session-panel-processes', role: 'tabpanel', 'aria-labelledby': 'session-tab-processes', tabIndex: 0, hidden: activeTab !== 'processes', 'data-session-panel': 'processes' },
      h(TaskProcessesSection, { session, taskId: id, workspace: session.workspace, managedProcesses,
        commandOperations: taskCommands, active: activeTab === 'processes', controlKey,
        onStopOperation: operationId => controlTask('stop', operationId) })
    ),

  );
}

function TaskDetailsSection({ session, state, fileCounts }) {
  const conversationId = session.goalMode?.conversationId || session.correlation?.conversationId || '';
  const createdAt = session.startedAtIso || session.createdAt || session.startedAt;
  const finishedAt = session.completedAt || session.cancelledAt || session.endedAt || session.inactiveAt;
  const dateLabel = value => {
    const raw = String(value || '');
    const numeric = /^\d{10,13}$/.test(raw) ? Number(raw) : null;
    const timestamp = numeric === null ? Date.parse(raw) : numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : 'Not recorded';
  };
  const validation = taskValidationView(session).statusLabel;
  return h('div', { className: 'detail-stack task-full-details', 'data-task-details': '' },
    h('section', { className: 'task-detail-section' },
      h('h3', null, 'Task and conversation'),
      h('div', { className: 'task-identifier-rows', 'data-task-identifiers': '' },
        h(TaskIdentifier, { label: 'Work ID', value: sessionIdentifier(session) }),
        conversationId ? h(TaskIdentifier, { label: 'Conversation ID', value: conversationId })
          : h('p', { className: 'task-detail-note' }, 'No verified ChatGPT conversation ID is recorded for this task.')
      )
    ),
    h('section', { className: 'task-detail-section' },
      h('h3', null, 'Execution'),
      h('div', { className: 'task-details-grid' },
        h(Detail, { label: 'Project', value: session.workspace || 'No project' }),
        h(Detail, { label: 'Status', value: state.label }),
        h(Detail, { label: 'Mode', value: session.goalMode?.goalActive ? 'Goal Mode' : session.goalMode ? 'Goal Mode inactive' : 'Normal task' }),
        session.goalMode?.state ? h(Detail, { label: 'Goal state', value: session.goalMode.state }) : null,
        session.goalMode?.tunnelId ? h(Detail, { label: 'Tunnel ID', value: session.goalMode.tunnelId }) : null,
        h(Detail, { label: 'Started', value: dateLabel(createdAt) }),
        h(Detail, { label: 'Ended', value: dateLabel(finishedAt) }),
        h(DurationDetail, { session, live: isOngoingSession(session) })
      )
    ),
    h('section', { className: 'task-detail-section' },
      h('h3', null, 'Recorded work'),
      h('div', { className: 'task-details-grid' },
        h(Detail, { label: 'Tool calls', value: taskToolCallCount(session) ?? 'Not recorded' }),
        h(Detail, { label: 'Project files', value: fileCounts.product }),
        h(Detail, { label: 'Support artifacts', value: fileCounts.support }),
        h(Detail, { label: 'Failed calls', value: session.failedToolCallCount ?? session.failures ?? 'Not recorded' }),
        h(Detail, { label: 'Validation', value: validation })
      )
    ),
    session.objective ? h('section', { className: 'task-detail-section' },
      h('h3', null, 'Original objective'),
      h('p', { className: 'task-details-long-text' }, session.objective)
    ) : null,
    session.summary || session.resultSummary || session.errorSummary || session.endReason
      ? h('section', { className: 'task-detail-section' },
        h('h3', null, 'Outcome'),
        h('p', { className: 'task-details-long-text' }, session.summary || session.resultSummary || session.errorSummary || session.endReason)
      ) : null
  );
}

function TaskIdentifier({ label, value }) {
  return h('div', { className: 'task-detail-identifier' },
    h('div', null, h('span', null, label), h('code', null, value)),
    h('button', {
      className: 'secondary compact-button',
      type: 'button',
      'aria-label': `Copy ${label}`,
      onClick: () => {
        void copyText(value).then(() => toast(`${label} copied.`, { variant: 'success' }))
          .catch(error => toast(error instanceof Error ? error.message : String(error), { variant: 'error' }));
      }
    }, h(Icon, { name: 'copy', size: 14 }), 'Copy')
  );
}

function SessionTabs({ activeTab, setActiveTab, counts = {} }) {
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'details', label: 'Details' },
    { id: 'changes', label: 'Changes', badge: counts.changes, countLabel: `${counts.changes || 0} changed files` },
    { id: 'activity', label: 'Activity' },
    { id: 'processes', label: 'Processes', badge: counts.processes, countLabel: counts.processesLabel }
  ];
  const tabIds = tabs.map(t => t.id);
  const onKeyDown = event => {
    const current = Math.max(0, tabIds.indexOf(activeTab));
    let next = null;
    if (event.key === 'ArrowLeft') next = (current - 1 + tabIds.length) % tabIds.length;
    else if (event.key === 'ArrowRight') next = (current + 1) % tabIds.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabIds.length - 1;
    if (next == null) return;
    event.preventDefault();
    setActiveTab(tabIds[next]);
    event.currentTarget.querySelector(`[data-session-tab="${tabIds[next]}"]`)?.focus({ preventScroll: true });
    event.currentTarget.querySelector(`[data-session-tab="${tabIds[next]}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  return h('div', { className: 'inspector-tabs', role: 'tablist', 'aria-label': 'Task details', onKeyDown },
    ...tabs.map(tab => h('button', {
      key: tab.id,
      className: `inspector-tab${activeTab === tab.id ? ' is-active' : ''}`,
      id: `session-tab-${tab.id}`,
      type: 'button',
      role: 'tab',
      'aria-selected': activeTab === tab.id ? 'true' : 'false',
      'aria-controls': `session-panel-${tab.id}`,
      tabIndex: activeTab === tab.id ? 0 : -1,
      'data-session-tab': tab.id,
      'aria-description': tab.countLabel,
      title: tab.countLabel ? `${tab.label}: ${tab.countLabel}` : undefined,
      onClick: () => setActiveTab(tab.id)
    },
      h('span', null, tab.label),
      ' ',
      tab.badge !== undefined && tab.badge !== null && tab.badge !== 0
        ? h('span', { className: 'task-tab-badge' }, tab.badge)
        : null
    ))
  );
}

function TaskProcessesSection({ session, taskId, workspace = '', managedProcesses = [], commandOperations = [], active = false, controlKey = '', onStopOperation }) {
  const { owned } = taskProcessGroups(managedProcesses, taskId, workspace);
  const represented = new Set(commandOperations.map(command => String(command.operationId || '')));
  const operations = taskRunningOperations(session).filter(operation =>
    !represented.has(String(operation.id || operation.operationId || operation.invocationId || '')));
  const relevant = owned;
  const sampleKey = JSON.stringify(relevant.filter(process => ['starting', 'running', 'stopping'].includes(process.status))
    .map(process => [process.processId, process.pid]).sort());
  const processMemory = useProcessMemory(sampleKey, active);
  const rows = processListView({ managedProcesses: relevant, commandOperations, processMemory }).rows;
  const categories = [
    { title: 'Task commands', processes: owned.filter(process => process.lifecycle === 'task') },
    { title: 'Persistent commands', processes: owned.filter(process => process.lifecycle === 'persistent') },
    { title: 'Other task commands', processes: owned.filter(process => !['task', 'persistent'].includes(process.lifecycle)) }
  ];
  const renderProcess = process => h(ProcessRow, { key: process.processId, row: rows.find(row => row.processId === process.processId) });
  if (!active) return null;
  return h('div', { className: 'task-processes-container detail-stack' },
    h(CurrentOperations, { session, controlKey, onStopOperation, excludedOperationIds: represented }),
    commandOperations.length ? h('section', { className: 'task-detail-section task-process-group' },
      h('div', { className: 'task-detail-heading' }, h('h3', null, 'Command executions'), h('span', null, commandOperations.length)),
      commandOperations.map(command => h(ProcessRow, { key: `command:${command.operationId}`,
        row: rows.find(row => row.operationId === command.operationId) }))) : null,
    !owned.length && !commandOperations.length && !operations.length ? h('div', { className: 'inspector-empty compact' },
      h('strong', null, 'No running operations or managed commands'),
      h('span', null, 'Task operations and commands started by this task appear here.')) : null,
    categories.filter(category => category.processes.length).map(category =>
      h('section', { key: category.title, className: 'task-detail-section task-process-group' },
        h('div', { className: 'task-detail-heading' }, h('h3', null, category.title), h('span', null, category.processes.length)),
        category.processes.map(renderProcess))),
    h('a', { className: 'buttonlike secondary', href: routeHref('processes') }, 'View all running commands')
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
  const [expandedSteps, setExpandedSteps] = useState(() => new Set());

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

  const toggleStep = stepKey => {
    setExpandedSteps(prev => {
      const next = new Set(prev);
      if (next.has(stepKey)) next.delete(stepKey);
      else next.add(stepKey);
      return next;
    });
  };

  const list = h('ol', { className: 'task-plan-list' },
    steps.map((step, index) => {
          const status = String(step?.status || 'pending');
          const stepKey = String(step?.id || `step-${index}`);
          const hasDetail = Boolean(step?.detail);
          const isExpanded = hasDetail && expandedSteps.has(stepKey);
          const markerIcon = status === 'completed' ? 'check' : status === 'skipped' ? 'minimize' : status === 'blocked' ? 'warning' : 'circle';
          const statusLabel = status === 'in_progress' ? 'In progress' : status.charAt(0).toUpperCase() + status.slice(1);
          const marker = status === 'in_progress'
            ? h('span', { className: 'task-plan-active-dot', 'aria-hidden': 'true' })
            : h(Icon, { name: markerIcon, size: 12 });
          return h('li', {
            key: `${String(step?.id || 'step')}:${index}`,
            className: `task-plan-step is-${status}${isExpanded ? ' is-expanded' : ''}`,
            'data-plan-step-status': status
          },
            h('span', { className: 'task-plan-marker', role: 'img', 'aria-label': statusLabel }, marker),
            h('span', { className: 'task-plan-copy' },
              hasDetail
                ? h('button', {
                    type: 'button',
                    className: 'task-plan-toggle',
                    'aria-expanded': isExpanded,
                    'aria-controls': `task-plan-detail-${index}`,
                    'aria-label': `${isExpanded ? 'Collapse' : 'Expand'} details for ${String(step?.title || `Step ${index + 1}`)}`,
                    onClick: () => toggleStep(stepKey)
                  },
                    h('strong', null, String(step?.title || `Step ${index + 1}`)),
                    h(Icon, { name: isExpanded ? 'chevronUp' : 'chevronDown', size: 12, className: 'task-plan-toggle-icon' })
                  )
                : h('div', { className: 'task-plan-header' },
                    h('strong', null, String(step?.title || `Step ${index + 1}`))
                  ),
              isExpanded && step?.detail
                ? h('span', { id: `task-plan-detail-${index}`, className: 'task-plan-detail' }, String(step.detail))
                : null
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
      h('a', { href: taskActivityHref(session) }, 'View activity')
    )
  );
}

function taskActivityHref(session, eventParams = {}) {
  const params = getRouteParams();
  const taskId = sessionIdentifier(session);
  return routeHref('activity', {
    workspace: session.workspace,
    task: taskId,
    time: 'all',
    ...eventParams,
    from: 'tasks',
    returnTask: taskId,
    returnWorkspace: params.get('workspace') || '',
    returnSearch: params.get('search'),
    returnTaskStatus: params.get('taskStatus')
  });
}

function OriginalRequest({ objective }) {
  if (!objective) return null;
  return h('details', { className: 'task-detail-section task-original-request' },
    h('summary', null, 'Original request'),
    h('p', null, objective)
  );
}

function TaskTraceSection({ session, activityHasMore = false, onLoadMoreActivity }) {
  const [visibleCount, setVisibleCount] = useState(DETAIL_EVENT_PREVIEW);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState('');
  const ordered = orderSessionEvents(session.events || []);
  const recent = ordered.slice(0, visibleCount);
  const hasBuffered = ordered.length > visibleCount;
  const canLoadMore = activityHasMore && typeof onLoadMoreActivity === 'function';
  const showMore = async () => {
    if (loadingMore) return;
    setLoadError('');
    if (hasBuffered) {
      setVisibleCount(count => count + DETAIL_EVENT_INCREMENT);
      return;
    }
    if (!canLoadMore) return;
    setLoadingMore(true);
    try {
      const loaded = await onLoadMoreActivity();
      if (!loaded) throw new Error('Older activity is not available yet.');
      setVisibleCount(count => count + DETAIL_EVENT_INCREMENT);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingMore(false);
    }
  };
  return h('section', { className: 'task-detail-section task-activity-summary' },
    h('div', { className: 'task-detail-heading' },
      h('h3', null, 'Recent activity')
    ),
    recent.length ? h('div', { className: 'task-event-scroll', role: 'list', 'aria-label': 'Recent task activity' },
      recent.map((event, index) => h('div', { role: 'listitem', key: activityEventId(event) || index },
        h(EventRow, { event, session })))
    ) : h('p', { className: 'task-detail-note' }, 'No activity recorded.'),
    hasBuffered || canLoadMore ? h('button', {
      className: 'secondary compact-button task-activity-show-more', type: 'button',
      'data-load-more-task-activity': '', disabled: loadingMore, 'aria-busy': loadingMore,
      onClick: () => { void showMore(); }
    }, loadingMore ? 'Loading…' : 'View more activity') : null,
    loadError ? h('p', { className: 'task-detail-note', role: 'alert' }, loadError) : null,
    h('a', { className: 'section-action task-activity-view-all', href: taskActivityHref(session) }, 'View all activity')
  );
}

function EventRow({ event, session }) {
  const operation = activityDisplayAction(event);
  const description = activityDescription(event);
  const timestamp = eventTimestampValue(event);
  const status = event.status || (event.ok === false ? 'failed' : 'succeeded');
  const durationMs = event.durationMs != null && Number.isFinite(Number(event.durationMs))
    ? Number(event.durationMs)
    : (event.elapsedMs != null && Number.isFinite(Number(event.elapsedMs)) ? Number(event.elapsedMs) : null);
  const durationLabel = durationMs != null
    ? (durationMs >= 1000 ? `${(durationMs / 1000).toFixed(durationMs < 10000 ? 1 : 0)}s` : `${Math.round(durationMs)}ms`)
    : (event.elapsed || event.duration || event.elapsedTime ? String(event.elapsed || event.duration || event.elapsedTime) : '');
  const href = taskActivityHref(session, {
    workspace: event.workspace || session.workspace,
    task: event.taskId || sessionIdentifier(session),
    event: activityEventId(event)
  });
  return h('a', {
    className: 'task-event task-event-link',
    'data-task-event-link': '',
    href,
    'aria-label': `Open ${operation} event in Activity`
  },
    h('span', { 'data-clock-relative': timestamp }, timeAgo(timestamp)),
    h('span', { className: 'task-event-copy' },
      h('strong', { title: operation }, operation),
      description ? h('small', { title: description }, description) : null
    ),
    h('div', { className: 'task-event-meta' },
      durationLabel ? h('span', { className: 'task-event-duration', 'aria-label': `Duration: ${durationLabel}` }, durationLabel) : null,
      h(StatusPill, { state: { status, pillClass: '' }, label: status })
    )
  );
}

function CurrentOperations({ session, controlKey = '', onStopOperation, excludedOperationIds = new Set() }) {
  const operations = taskRunningOperations(session).filter(operation =>
    !excludedOperationIds.has(String(operation.id || operation.operationId || operation.invocationId || '')));
  if (!operations.length) return null;
  return h('section', { className: 'task-detail-section' },
    h('div', { className: 'task-detail-heading' }, h('h3', null, 'Running operations'), h('span', null, operations.length)),
    h('div', { className: 'task-event-list' }, ...operations.map((operation, index) => {
      const operationId = String(operation.id || operation.operationId || operation.invocationId || '');
      const stopping = Boolean(operation.stopRequestedAt) || controlKey === `stop:${operationId}`;
      return h('div', { className: 'task-event', 'data-task-operation': operationId, key: operationId || `${operation.startedAt || ''}:${index}` },
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
