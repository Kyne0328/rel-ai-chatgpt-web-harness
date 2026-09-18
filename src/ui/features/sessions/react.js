import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { fetchJson } from '../../api.js';
import { copyText } from '../../clipboard.js';
import { toast } from '../../components/toast.js';
import { formatDuration, timeAgo } from '../../utils.js';
import { getRouteParams, getWorkspaceFilter, routeHref, setWorkspaceFilter } from '../../router.js';
import { activityEventId } from '../../activity-event.js';
import { orderWorkspacesAlphabetically } from '../../components/workspace-menu.js';
import { eventTimestampValue } from '../../../taskEvents.js';
import { classifyTaskChangedFiles } from '../../../taskSemanticProgress.js';
import { taskEntityView, workSessionStateView } from '../../task-identity.js';
import { statusPillClass, statusTone } from '../../status-tone.js';
import {
  isOngoingSession,
  mergeSessionDetail,
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
  sessionSummary,
  sessionsForDisplay,
  taskTraceJsonl
} from './model.js';

const h = React.createElement;
const SESSION_PAGE_SIZE = 50;
const TASK_SESSION_URL = '/api/tasks/session';
const DETAIL_FILE_PREVIEW = 12;
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
  const requestedId = String(getRouteParams().get('task') || '').trim();
  const sessions = useMemo(() => sessionsForDisplay(data, workspace), [data.tasks, workspace]);
  const sessionById = useMemo(() => new Map(sessions.map(session => [sessionIdentifier(session), session]).filter(([id]) => id)), [sessions]);
  const requestedIndex = requestedId ? sessions.findIndex(session => sessionIdentifier(session) === requestedId) : -1;
  const minimumVisible = Math.max(SESSION_PAGE_SIZE, requestedIndex >= 0 ? requestedIndex + 1 : 0);
  const [visibleByScope, setVisibleByScope] = useState(() => new Map());
  const scopeKey = workspace || '__all__';
  const visibleCount = Math.max(minimumVisible, Number(visibleByScope.get(scopeKey) || SESSION_PAGE_SIZE));
  const visibleSessions = sessions.slice(0, visibleCount);
  const remaining = Math.max(0, sessions.length - visibleSessions.length);
  const [selectedId, setSelectedId] = useState('');
  const selectedIdRef = useRef('');
  selectedIdRef.current = selectedId;
  const [hydrated, setHydrated] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [olderExpanded, setOlderExpanded] = useState(false);
  const hydrationRequest = useRef(0);
  const selectedSummary = selectedId ? sessionById.get(selectedId) : null;
  const selectedDetail = selectedSummary
    ? mergeSessionDetail(hydrated?.id === selectedId ? hydrated.session : {}, selectedSummary, data)
    : null;

  const selectSession = useCallback(id => {
    if (!id) return;
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
    if (Array.isArray(selectedSummary.trace?.entries)) {
      setHydrated({ id: selectedId, session: selectedSummary });
      return undefined;
    }
    let cancelled = false;
    void fetchJson(`${TASK_SESSION_URL}?task=${encodeURIComponent(selectedId)}`, { cache: 'no-store' })
      .then(response => {
        if (cancelled || request !== hydrationRequest.current || response?.ok === false || !response?.session) return;
        setHydrated({
          id: selectedId,
          session: { ...response.session, ...(response.trace ? { trace: response.trace } : {}) }
        });
      })
      .catch(error => {
        if (!cancelled && request === hydrationRequest.current) toast(error instanceof Error ? error.message : String(error), { variant: 'error' });
      });
    return () => {
      cancelled = true;
      hydrationRequest.current += 1;
    };
  }, [selectedId]);

  const showMore = useCallback(() => {
    setVisibleByScope(previous => {
      const next = new Map(previous);
      next.set(scopeKey, visibleCount + SESSION_PAGE_SIZE);
      return next;
    });
  }, [scopeKey, visibleCount]);

  return h('div', { className: 'section sessions-page', 'data-sessions-react': '' },
    h('div', { className: 'feature-toolbar sessions-toolbar' },
      h('div', { className: 'sessions-summary-line', 'data-session-summary': '' }, sessionSummary(sessions)),
      h('div', { className: 'section-head-actions' },
        h(ProjectFilter, { workspaces: data.config?.workspaces || [], selected: workspace }),
        h('span', { className: 'feature-count' }, sessionCountLabel(sessions, workspace))
      )
    ),
    h('section', { className: 'card sessions-history-card' },
      h('div', { className: 'card-head' },
        h('div', null, h('h3', null, 'Recent tasks')),
        h('div', { className: 'card-head-actions' },
          h('a', { className: 'section-action', href: '#activity' }, 'Activity'),
          h('a', { className: 'section-action', href: '#diagnostics' }, 'Troubleshooting')
        )
      ),
      h('div', { className: 'sessions-master-detail' },
        h('div', { className: 'card-body task-list' },
          visibleSessions.length
            ? visibleSessions.map(session => h(TaskRow, {
                key: sessionIdentifier(session),
                session,
                selected: sessionIdentifier(session) === selectedId,
                onSelect: selectSession
              }))
            : h('div', { className: 'empty' }, 'No tasks yet.'),
          remaining > 0 && h('div', { className: 'session-list-footer' },
            h('span', null, `${remaining} older task${remaining === 1 ? '' : 's'} hidden`),
            h('button', { className: 'secondary', type: 'button', onClick: showMore, 'data-load-more-sessions': '' }, `Show ${Math.min(SESSION_PAGE_SIZE, remaining)} more`)
          )
        ),
        h('aside', { className: 'session-inspector', 'data-session-inspector': '' },
          selectedDetail
            ? h(SessionInspector, {
                session: selectedDetail,
                activeTab,
                setActiveTab,
                olderExpanded,
                setOlderExpanded
              })
            : h('div', { className: 'inspector-empty' },
                h('strong', null, 'Select a task'),
                h('span', null, 'Choose a task to inspect its overview, activity, and technical details without leaving this page.')
              )
        )
      )
    )
  );
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
  const description = sessionDescription(session, live, operation, semantic);
  const toolCalls = Number(session.toolCallCount ?? session.calls ?? 0);
  const projectFiles = semanticFileCounts(session, semantic).product;
  const title = session.title || operation;
  return h('button', {
    className: `task-row${selected ? ' is-selected' : ''}`,
    type: 'button',
    'data-task-id': id,
    'aria-current': selected ? 'true' : undefined,
    'aria-label': `${title}. ${state.label}. ${description}`,
    title,
    onClick: () => flushSync(() => onSelect(id))
  },
    h('span', { className: 'task-row-status' }, h(StatusPill, { state })),
    h('span', { className: 'task-row-main' },
      h('strong', null, title),
      h('span', { className: 'task-row-description' }, `${session.workspace || 'project'} · ${toolCalls} tool call${toolCalls === 1 ? '' : 's'} · ${projectFiles} project file${projectFiles === 1 ? '' : 's'} · ${description}`)
    ),
    h('span', { className: 'task-row-time' }, h(SessionTime, { session, live })),
    h('span', { 'aria-hidden': 'true' }, '›')
  );
});

function StatusPill({ state, label = state?.label || 'Unknown' }) {
  const status = state?.status || label;
  const tone = statusTone(status);
  const pillClass = state?.pillClass || statusPillClass(status);
  return h('span', { className: `status-pill ${pillClass}`.trim() },
    label,
    h('span', { className: 'sr-only' }, ` (${tone})`)
  );
}

function SessionTime({ session, live }) {
  if (live) {
    const start = session.startedAt || session.createdAt || '';
    return h('span', { 'data-clock-elapsed-start': start }, formatDuration(sessionDurationMs(session), { live: true }) || '0s');
  }
  const end = sessionListTimestampValue(session);
  return h('span', end ? { 'data-clock-relative': end } : null, timeAgo(end) || '—');
}

function SessionInspector({ session, activeTab, setActiveTab, olderExpanded, setOlderExpanded }) {
  const headingRef = useRef(null);
  const previousId = useRef('');
  const id = sessionIdentifier(session);
  useEffect(() => {
    if (previousId.current === id) return;
    previousId.current = id;
    if (!window.matchMedia('(max-width: 760px)').matches) return;
    headingRef.current?.focus({ preventScroll: true });
    headingRef.current?.scrollIntoView({ block: 'start', inline: 'nearest' });
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

  return h('div', { className: 'detail-stack session-detail' },
    h('header', { className: 'task-detail-header' },
      h('div', null,
        h('span', { className: 'overview-kicker' }, 'Task'),
        h('h2', { ref: headingRef, tabIndex: -1 }, session.title || operationValue),
        session.objective ? h('p', null, session.objective) : null
      ),
      h(StatusPill, { state })
    ),
    h(SessionTabs, { activeTab, setActiveTab }),
    h('div', { className: 'inspector-panel', id: 'session-panel-overview', role: 'tabpanel', 'aria-labelledby': 'session-tab-overview', tabIndex: 0, hidden: activeTab !== 'overview', 'data-session-panel': 'overview' },
      h('div', { className: 'task-detail-current' },
        h('strong', null, currentTitle),
        h('span', null, currentCopy)
      ),
      h(PlanSection, { plan: session.plan }),
      h('div', { className: 'task-detail-grid task-detail-facts' },
        h(Detail, { label: 'Project', value: session.workspace || '—' }),
        h(DurationDetail, { session, live }),
        h(Detail, { label: 'Tool calls', value: session.toolCallCount ?? session.calls ?? 0 }),
        h(Detail, { label: 'Project files', value: fileCounts.product }),
        fileCounts.support > 0 ? h(Detail, { label: 'Support artifacts', value: fileCounts.support }) : null
      ),
      h(AttentionSection, { session }),
      h(FailureHistorySection, { session }),
      h(ChangedFilesSection, { files: session.changedFiles || [], session })
    ),
    h('div', { className: 'inspector-panel', id: 'session-panel-activity', role: 'tabpanel', 'aria-labelledby': 'session-tab-activity', tabIndex: 0, hidden: activeTab !== 'activity', 'data-session-panel': 'activity' },
      h(TaskTraceSection, { session, olderExpanded, setOlderExpanded }),
      h('div', { className: 'session-inline-actions' },
        h('a', { className: 'buttonlike secondary', href: routeHref('activity', { workspace: session.workspace, task: id, time: 'all' }) }, 'View in all Activity')
      )
    ),
    h('div', { className: 'inspector-panel', id: 'session-panel-technical', role: 'tabpanel', 'aria-labelledby': 'session-tab-technical', tabIndex: 0, hidden: activeTab !== 'technical', 'data-session-panel': 'technical' },
      h(TechnicalDetails, { session, identities, state, operationValue }),
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
  if (!steps.length) return null;
  const resolved = steps.filter(step => ['completed', 'skipped'].includes(String(step?.status || ''))).length;
  return h('section', { className: 'task-detail-section task-plan-section', 'data-task-plan': '' },
    h('div', { className: 'task-detail-heading' },
      h('h3', null, 'Plan'),
      h('span', { 'aria-label': `${resolved} of ${steps.length} steps resolved` }, `${resolved}/${steps.length}`)
    ),
    h('ol', { className: 'task-plan-list' },
      ...steps.map((step, index) => {
        const status = String(step?.status || 'pending');
        const marker = status === 'completed' ? '✓' : status === 'skipped' ? '–' : status === 'in_progress' ? '●' : status === 'blocked' ? '!' : '○';
        const statusLabel = status === 'in_progress' ? 'In progress' : status.charAt(0).toUpperCase() + status.slice(1);
        return h('li', { key: `${String(step?.id || 'step')}:${index}`, className: `task-plan-step is-${status}`, 'data-plan-step-status': status },
          h('span', { className: 'task-plan-marker', role: 'img', 'aria-label': statusLabel }, marker),
          h('span', { className: 'task-plan-copy' },
            h('strong', null, String(step?.title || `Step ${index + 1}`)),
            step?.detail ? h('span', null, String(step.detail)) : null
          )
        );
      })
    )
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
  const callLabel = `${failures} tool call${failures === 1 ? '' : 's'}`;
  return h('section', { className: 'task-detail-section task-detail-history' },
    h('h3', null, completed ? 'Recovered during task' : 'Earlier failed tool calls'),
    h('p', null, completed
      ? `${callLabel} failed earlier, but the task later completed. The failures remain visible in Activity.`
      : `${callLabel} failed earlier. They remain visible in Activity and do not change the task's current status.`)
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
  const moreControl = hiddenCount ? h('button', {
    className: 'task-file-more',
    type: 'button',
    'aria-expanded': expanded ? 'true' : 'false',
    onClick: () => setExpanded(value => !value)
  }, expanded ? 'Show fewer files' : `Show ${hiddenCount} more file${hiddenCount === 1 ? '' : 's'}`) : null;
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

function TaskTraceSection({ session, olderExpanded, setOlderExpanded }) {
  const ordered = orderSessionEvents(session.events || []);
  if (!ordered.length) return h('div', { className: 'inspector-empty compact' },
    h('strong', null, 'No activity recorded'),
    h('span', null, 'Task activity will appear here as Rel.AI tools run.')
  );
  const visible = ordered.slice(0, DETAIL_EVENT_PREVIEW);
  const hidden = ordered.slice(DETAIL_EVENT_PREVIEW);
  return h('section', { className: 'task-detail-section' },
    h('div', { className: 'task-detail-heading' }, h('h3', null, 'Task activity'), h('span', null, ordered.length)),
    h('p', { className: 'task-detail-note' }, 'One row per recorded Rel.AI operation. Raw audit trace remains available under Technical.'),
    h('div', { className: 'task-event-list' },
      ...visible.map(event => h(EventRow, { key: activityEventId(event) || `${eventTimestampValue(event)}:${event.operation || event.tool || ''}`, event, session })),
      hidden.length && !olderExpanded
        ? h('button', { className: 'secondary task-event-more', type: 'button', onClick: () => setOlderExpanded(true), 'data-show-older-events': '' }, `Show ${hidden.length} older event${hidden.length === 1 ? '' : 's'}`)
        : null,
      ...(olderExpanded ? hidden.map(event => h(EventRow, { key: activityEventId(event) || `${eventTimestampValue(event)}:${event.operation || event.tool || ''}`, event, session, older: true })) : [])
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

function TechnicalDetails({ session, identities, state, operationValue }) {
  return h('div', { className: 'task-detail-technical is-expanded' },
    h('section', { className: 'task-detail-section' },
      h('div', { className: 'task-detail-heading' }, h('h3', null, 'Identifiers')),
      h('div', { className: 'task-detail-grid' },
        h(IdentifierDetail, { label: 'Work session ID', value: identities.logicalTaskId || sessionIdentifier(session) || '—' }),
        identities.processId ? h(IdentifierDetail, { label: 'Process ID', value: identities.processId }) : null,
        session.correlation?.conversationId ? h(IdentifierDetail, { label: 'Conversation ID', value: session.correlation.conversationId }) : null
      )
    ),
    h('section', { className: 'task-detail-section' },
      h('div', { className: 'task-detail-heading' }, h('h3', null, 'Runtime')),
      h('div', { className: 'task-detail-grid' },
        h(Detail, { label: 'State', value: state.label }),
        h(Detail, { label: 'Last operation', value: operationValue }),
        h(Detail, { label: 'Validation', value: session.validation || 'not run' }),
        h(Detail, { label: 'End reason', value: session.endReason || (state.terminal ? 'completed' : 'still open') }),
        h(Detail, { label: 'Completion confirmed', value: session.completionKnown ? 'Yes' : 'No' })
      )
    ),
    h(CurrentOperations, { session })
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

function CurrentOperations({ session }) {
  const executable = ['running', 'validating', 'working'].includes(String(session?.status || '')) && Number(session?.activeCalls || 0) > 0;
  const operations = executable && Array.isArray(session.currentOperations) ? session.currentOperations : [];
  if (!operations.length) return null;
  return h('section', { className: 'task-detail-section' },
    h('div', { className: 'task-detail-heading' }, h('h3', null, 'Running operations'), h('span', null, operations.length)),
    h('div', { className: 'task-event-list' }, ...operations.map((operation, index) => h('div', { className: 'task-event', key: operation.invocationId || operation.operationId || `${operation.startedAt || ''}:${index}` },
      h('span', { 'data-clock-elapsed-start': operation.startedAt || '' }, formatDuration(Date.now() - Number(operation.startedAt || Date.now()), { live: true })),
      h('code', null, operation.label || operation.tool || 'operation'),
      h(StatusPill, { state: { status: 'running', pillClass: 'working' }, label: 'running' })
    )))
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
