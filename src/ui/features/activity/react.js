import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import './styles.css';
import { flushSync } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { fetchJson } from '../../api.js';
import { filterRadioField, filterSelectField, openFilterDrawer } from '../../components/filter-drawer.js';
import { Icon } from '../../components/icons.js';
import { StatusPill } from '../../components/pill.js';
import { OperationDiagnostics, RuntimeBuildIdentity } from '../../components/operation-diagnostics.js';
import { toast } from '../../components/toast.js';
import { copyText } from '../../clipboard.js';
import { getRouteParams, getWorkspaceFilter, navigate, replaceRouteParams, routeHref } from '../../router.js';
import { formatTerminalOutput, timeAgo } from '../../utils.js';
import { activityEventId } from '../../activity-event.js';
import { eventTimestampValue } from '../../../taskEvents.js';
import {
  activityAbsoluteTime,
  activityActionLabel,
  activityDisplayAction,
  activityFileLocation,
  activityFilterTransition,
  activityMessage,
  activitySessionView,
  activityStatusGroup,
  activityToolLabel,
  filterActivityEntries,
  mergeActivityEntries,
  normalizeStatusFilter,
  nextActivityExpiry,
  parseActivityHistoryResponse,
  replaceActivityHistory
} from './model.js';

const h = React.createElement;
const ACTIVITY_STORE_KEYS = Object.freeze(['auditTail', 'tasks', 'runtime', 'runtimeCompatibility']);
const EMPTY_FILTERS = Object.freeze({ search: '', timeRange: '1h', workspace: '', tool: '', status: '', task: '' });
const TIME_OPTIONS = Object.freeze([
  { value: '15m', label: 'Last 15 minutes' },
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: 'all', label: 'All time' }
]);
const STATUS_OPTIONS = Object.freeze([
  { value: '', label: 'All statuses' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'active', label: 'In progress' },
  { value: 'failed', label: 'Failed' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'other', label: 'Other' }
]);

export function createActivityRoute(useDashboardSlices) {
  return function ActivityRoute() {
    const data = useDashboardSlices(ACTIVITY_STORE_KEYS);
    return h(ActivityView, { data });
  };
}

function ActivityView({ data = {} }) {
  const initialRoute = useMemo(readRouteState, []);
  const [filterState, setFilterState] = useState(initialRoute.filters);
  const [requestedEventId, setRequestedEventId] = useState(initialRoute.eventId);
  const [allEntries, setAllEntries] = useState(() => replaceActivityHistory(data.auditTail?.entries || []));
  const [paused, setPaused] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [historyCursor, setHistoryCursor] = useState(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [olderHistoryLoading, setOlderHistoryLoading] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState(initialRoute.eventId);
  const [now, setNow] = useState(() => Date.now());
  const [copyState, setCopyState] = useState('idle');
  const [liveAnnouncement, setLiveAnnouncement] = useState('');
  const [unseenLiveCount, setUnseenLiveCount] = useState(0);
  const [highlightedEventIds, setHighlightedEventIds] = useState(() => new Set());
  const allEntriesRef = useRef(allEntries);
  const pausedRef = useRef(paused);
  const pausedEntriesRef = useRef([]);
  const liveEntriesSinceLoadRef = useRef([]);
  const historyLoadingRef = useRef(true);
  const historyRequestRef = useRef(0);
  const historyRetryRef = useRef(false);
  const nextExpiryRef = useRef(Number.POSITIVE_INFINITY);
  const searchTimerRef = useRef(0);
  const copyTimerRef = useRef(0);
  const inspectorHeadingRef = useRef(null);
  const listPaneRef = useRef(null);
  const listAtTopRef = useRef(true);
  const tableWrapRef = useRef(null);
  const selectionFocusRef = useRef(false);
  const liveAnnouncementReadyRef = useRef(false);
  const liveAnnouncementTimerRef = useRef(0);
  const pendingLiveAnnouncementRef = useRef(0);
  const highlightTimersRef = useRef(new Set());

  useEffect(() => { allEntriesRef.current = allEntries; }, [allEntries]);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { historyLoadingRef.current = historyLoading; }, [historyLoading]);

  const sessionIndex = useMemo(() => buildSessionIndex(data.tasks), [data.tasks]);
  const filterOptions = useMemo(() => ({
    workspaces: uniqueValues(allEntries, entry => entry.workspace),
    tools: uniqueValues(allEntries, toolName)
  }), [allEntries]);
  const filteredEntries = useMemo(() => filterActivityEntries(allEntries, filterState, now, {
    sorted: true,
    sessionTitle: entry => activitySessionView(entry, sessionIndex).title
  }), [allEntries, filterState, now, sessionIndex]);
  const rowVirtualizer = useVirtualizer({
    count: filteredEntries.length,
    getScrollElement: () => listPaneRef.current,
    estimateSize: () => 54,
    overscan: 8,
    getItemKey: index => activityEventId(filteredEntries[index]) || index
  });
  const filteredEntriesRef = useRef(filteredEntries);
  const rowVirtualizerRef = useRef(rowVirtualizer);
  filteredEntriesRef.current = filteredEntries;
  rowVirtualizerRef.current = rowVirtualizer;
  const selectedEntry = useMemo(
    () => allEntries.find(entry => activityEventId(entry) === selectedEventId) || null,
    [allEntries, selectedEventId]
  );
  const activeFilters = useMemo(
    () => activityFilters(filterState, sessionIndex),
    [filterState, sessionIndex]
  );

  useEffect(() => {
    nextExpiryRef.current = nextActivityExpiry(allEntries, filterState, now);
  }, [allEntries, filterState, now]);

  const mergeIntoVisibleEntries = useCallback(entries => {
    if (!Array.isArray(entries) || entries.length === 0) return false;
    const current = allEntriesRef.current;
    const merged = mergeActivityEntries(current, entries);
    if (!merged.changed) return false;
    allEntriesRef.current = merged.entries;
    setAllEntries(merged.entries);
    return true;
  }, []);

  const loadHistory = useCallback(async mode => {
    const requestId = ++historyRequestRef.current;
    try {
      const response = await fetchJson('/api/logs?limit=500', { pauseTimeoutWhenHidden: false, cacheTtlMs: 15_000 });
      if (requestId !== historyRequestRef.current) return false;
      const parsed = parseActivityHistoryResponse(response);
      if (!parsed.ok) throw new Error(parsed.error);
      if (mode === 'replace') {
        const stored = replaceActivityHistory(parsed.entries);
        const merged = mergeActivityEntries(stored, liveEntriesSinceLoadRef.current).entries;
        liveEntriesSinceLoadRef.current = [];
        allEntriesRef.current = merged;
        setAllEntries(merged);
        setHistoryCursor(parsed.nextCursor);
        setHistoryHasMore(parsed.hasMore);
      } else {
        mergeIntoVisibleEntries(parsed.entries);
      }
      historyRetryRef.current = false;
      historyLoadingRef.current = false;
      setHistoryLoading(false);
      setLoadError('');
      return true;
    } catch (error) {
      if (requestId !== historyRequestRef.current) return false;
      const message = error instanceof Error ? error.message : String(error);
      if (mode === 'replace') {
        const live = mergeActivityEntries(allEntriesRef.current, liveEntriesSinceLoadRef.current).entries;
        liveEntriesSinceLoadRef.current = [];
        allEntriesRef.current = live;
        setAllEntries(live);
        historyLoadingRef.current = false;
        setHistoryLoading(false);
        setLoadError(message);
        historyRetryRef.current = document.visibilityState !== 'visible';
      } else {
        toast(`Live activity resumed, but stored history could not be refreshed: ${message}`, { variant: 'warn', duration: 3600 });
      }
      return false;
    }
  }, [mergeIntoVisibleEntries]);

  const loadOlderHistory = useCallback(async () => {
    if (!historyHasMore || !historyCursor || olderHistoryLoading) return;
    setOlderHistoryLoading(true);
    try {
      const params = new URLSearchParams({
        limit: '500',
        cursor: JSON.stringify(historyCursor)
      });
      const response = await fetchJson(`/api/logs?${params.toString()}`, { pauseTimeoutWhenHidden: false });
      const parsed = parseActivityHistoryResponse(response);
      if (!parsed.ok) throw new Error(parsed.error);
      mergeIntoVisibleEntries(parsed.entries);
      setHistoryCursor(parsed.nextCursor);
      setHistoryHasMore(parsed.hasMore);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { variant: 'error' });
    } finally {
      setOlderHistoryLoading(false);
    }
  }, [historyCursor, historyHasMore, mergeIntoVisibleEntries, olderHistoryLoading]);

  useEffect(() => {
    const highlightTimers = highlightTimersRef.current;
    void loadHistory('replace');
    return () => {
      historyRequestRef.current += 1;
      window.clearTimeout(searchTimerRef.current);
      window.clearTimeout(copyTimerRef.current);
      window.clearTimeout(liveAnnouncementTimerRef.current);
      for (const timer of highlightTimers) window.clearTimeout(timer);
      highlightTimers.clear();
    };
  }, [loadHistory]);

  useEffect(() => {
    const timer = window.setTimeout(() => { liveAnnouncementReadyRef.current = true; }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const liveEntries = data.auditTail?.entries;
  useEffect(() => {
    if (!Array.isArray(liveEntries) || liveEntries.length === 0) return;
    const knownIds = new Set(allEntriesRef.current.map(activityEventId));
    const newEventIds = [];
    for (const entry of liveEntries) {
      const id = activityEventId(entry);
      if (!id || knownIds.has(id)) continue;
      knownIds.add(id);
      newEventIds.push(id);
    }
    const newCount = newEventIds.length;
    if (historyLoadingRef.current) {
      liveEntriesSinceLoadRef.current = mergeActivityEntries(liveEntriesSinceLoadRef.current, liveEntries).entries;
    }
    if (pausedRef.current) {
      pausedEntriesRef.current = mergeActivityEntries(pausedEntriesRef.current, liveEntries).entries;
      return;
    }
    mergeIntoVisibleEntries(liveEntries);
    if (!liveAnnouncementReadyRef.current) {
      liveAnnouncementReadyRef.current = true;
      return;
    }
    if (newCount > 0) {
      if (!listAtTopRef.current) setUnseenLiveCount(count => count + newCount);
      setHighlightedEventIds(current => {
        const next = new Set(current);
        for (const id of newEventIds) next.add(id);
        return next;
      });
      let highlightTimer = 0;
      highlightTimer = window.setTimeout(() => {
        highlightTimersRef.current.delete(highlightTimer);
        setHighlightedEventIds(current => {
          if (!newEventIds.some(id => current.has(id))) return current;
          const next = new Set(current);
          for (const id of newEventIds) next.delete(id);
          return next;
        });
      }, 1400);
      highlightTimersRef.current.add(highlightTimer);
      pendingLiveAnnouncementRef.current += newCount;
      window.clearTimeout(liveAnnouncementTimerRef.current);
      liveAnnouncementTimerRef.current = window.setTimeout(() => {
        const count = pendingLiveAnnouncementRef.current;
        pendingLiveAnnouncementRef.current = 0;
        setLiveAnnouncement(`${count} new activity ${count === 1 ? 'event' : 'events'} received.`);
      }, 700);
    }
  }, [liveEntries, mergeIntoVisibleEntries]);

  useEffect(() => {
    const onClockTick = event => {
      const tickNow = Number(event?.detail?.now || Date.now());
      if (tickNow >= nextExpiryRef.current) setNow(tickNow);
    };
    const onHashChange = () => {
      const route = readRouteState();
      setFilterState(route.filters);
      setRequestedEventId(route.eventId);
      if (route.eventId) setSelectedEventId(route.eventId);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible' || !historyRetryRef.current) return;
      historyRetryRef.current = false;
      historyLoadingRef.current = true;
      setHistoryLoading(true);
      setLoadError('');
      void loadHistory('replace');
    };
    window.addEventListener('relai:clock-tick', onClockTick);
    window.addEventListener('hashchange', onHashChange);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('relai:clock-tick', onClockTick);
      window.removeEventListener('hashchange', onHashChange);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [loadHistory]);

  useEffect(() => {
    if (!requestedEventId) return;
    if (allEntries.some(entry => activityEventId(entry) === requestedEventId)) setSelectedEventId(requestedEventId);
  }, [allEntries, requestedEventId]);

  useEffect(() => {
    if (!selectedEventId) return;
    const index = filteredEntriesRef.current.findIndex(entry => activityEventId(entry) === selectedEventId);
    if (index >= 0) rowVirtualizerRef.current?.scrollToIndex(index, { align: 'auto' });
  }, [selectedEventId]);

  useEffect(() => {
    if (!selectionFocusRef.current || !selectedEventId) return;
    selectionFocusRef.current = false;
    if (!window.matchMedia('(max-width: 1140px)').matches) return;
    const heading = inspectorHeadingRef.current;
    if (!(heading instanceof HTMLElement)) return;
    heading.focus({ preventScroll: true });
    // In the stacked layout, a longer inspector can sit below the list and
    // viewport. Reveal explicit selections once; live updates must not scroll.
    heading.scrollIntoView({ behavior: 'instant', block: 'start', inline: 'nearest' });
  }, [selectedEventId, selectedEntry]);

  const syncRoute = useCallback(next => {
    setRequestedEventId('');
    replaceRouteParams({ ...activityRouteParams(next), event: null });
  }, []);

  const resetListScroll = useCallback(() => {
    if (tableWrapRef.current) tableWrapRef.current.scrollLeft = 0;
    setUnseenLiveCount(0);
  }, []);

  const applyFilters = useCallback(draft => {
    setFilterState(current => {
      const transition = activityFilterTransition(current, draft);
      const next = transition.filterState;
      if (transition.workspaceChanged) navigate('activity', activityRouteParams(next));
      else syncRoute(next);
      return next;
    });
    resetListScroll();
  }, [resetListScroll, syncRoute]);

  const removeFilter = useCallback(key => {
    setFilterState(current => {
      const next = { ...current };
      if (key === 'timeRange') next.timeRange = '1h';
      else next[key] = '';
      if (key === 'workspace') navigate('activity', activityRouteParams(next));
      else syncRoute(next);
      return next;
    });
    resetListScroll();
  }, [resetListScroll, syncRoute]);

  const clearFilters = useCallback(() => {
    setFilterState(current => {
      const next = { ...EMPTY_FILTERS };
      if (current.workspace) navigate('activity', activityRouteParams(next));
      else syncRoute(next);
      return next;
    });
    resetListScroll();
  }, [resetListScroll, syncRoute]);

  const onSearch = useCallback(value => {
    window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = window.setTimeout(() => {
      setFilterState(current => {
        const next = { ...current, search: value };
        syncRoute(next);
        return next;
      });
      resetListScroll();
    }, 160);
  }, [resetListScroll, syncRoute]);

  const openFilters = useCallback(() => {
    openActivityFilters({ filterState, filterOptions, onApply: applyFilters });
  }, [applyFilters, filterOptions, filterState]);

  const togglePause = useCallback(async () => {
    if (!pausedRef.current) {
      pausedRef.current = true;
      pausedEntriesRef.current = [];
      flushSync(() => setPaused(true));
      return;
    }
    pausedRef.current = false;
    flushSync(() => setPaused(false));
    const buffered = pausedEntriesRef.current;
    pausedEntriesRef.current = [];
    mergeIntoVisibleEntries(buffered);
    await loadHistory('merge');
  }, [loadHistory, mergeIntoVisibleEntries]);

  const selectEntry = useCallback(entry => {
    const eventId = activityEventId(entry);
    window.clearTimeout(copyTimerRef.current);
    setCopyState('idle');
    selectionFocusRef.current = true;
    setRequestedEventId(eventId);
    replaceRouteParams({ event: eventId });
    setSelectedEventId(eventId);
  }, []);

  const onListScroll = useCallback(event => {
    const atTop = event.currentTarget.scrollTop <= 24;
    listAtTopRef.current = atTop;
    if (atTop) setUnseenLiveCount(0);
  }, []);

  const jumpToLatest = useCallback(() => {
    listAtTopRef.current = true;
    setUnseenLiveCount(0);
    rowVirtualizerRef.current?.scrollToIndex?.(0, { align: 'start' });
    if (listPaneRef.current) listPaneRef.current.scrollTop = 0;
  }, []);

  const copySelected = useCallback(async () => {
    if (!selectedEntry) return;
    try {
      await copyText(JSON.stringify(safeEventProjection(selectedEntry), null, 2));
      window.clearTimeout(copyTimerRef.current);
      setCopyState('success');
      copyTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1200);
    } catch {
      toast('Clipboard access failed.', { variant: 'error' });
    }
  }, [selectedEntry]);

  const summary = historyLoading
    ? 'Loading stored activity history…'
    : loadError
      ? `${filteredEntries.length} live event${filteredEntries.length === 1 ? '' : 's'} shown · stored history could not be loaded.`
      : `${filteredEntries.length} of ${allEntries.length} events shown`;
  const count = historyLoading
    ? 'Loading…'
    : loadError
      ? (filteredEntries.length ? `${filteredEntries.length} live event${filteredEntries.length === 1 ? '' : 's'} · history unavailable` : 'History unavailable')
      : `${filteredEntries.length} event${filteredEntries.length === 1 ? '' : 's'}`;

  return h('div', { className: 'section activity-page' },
    h('div', { className: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, liveAnnouncement),
    h(ActivityFilterBar, {
      filterState,
      filters: activeFilters,
      summary,
      paused,
      onSearch,
      onOpenFilters: openFilters,
      onClearAll: clearFilters,
      onRemoveFilter: removeFilter,
      onTogglePause: togglePause
    }),
    h('div', { id: '__activity-table-wrap', className: 'card activity-event-card' },
      h('div', { className: 'card-head' },
        h('h3', null, 'Activity history'),
        h('span', { className: 'section-action', id: '__activity-count' }, count)
      ),
      h('div', { className: 'activity-master-detail' },
        h('div', { className: 'activity-list-pane', ref: listPaneRef, onScroll: onListScroll },
          unseenLiveCount > 0 ? h('div', { className: 'activity-live-tail' },
            h('button', { className: 'secondary compact-button', type: 'button', onClick: jumpToLatest },
              h(Icon, { name: 'activity', size: 14 }),
              `${unseenLiveCount} new ${unseenLiveCount === 1 ? 'event' : 'events'} · Jump to latest`
            )
          ) : null,
          h('div', { className: 'card-body' },
            h('div', { className: 'table-wrap', ref: tableWrapRef },
              h('table', { className: 'data-table activity-table' },
                h('caption', { className: 'sr-only' }, 'Activity history'),
                h('colgroup', null,
                  h('col', { className: 'activity-col-time' }),
                  h('col', { className: 'activity-col-message' })
                ),
                h('thead', null, h('tr', null,
                  h('th', { scope: 'col', className: 'activity-time-column' }, 'Time'),
                  h('th', { scope: 'col', className: 'activity-message-column' }, 'Activity')
                )),
                h('tbody', { id: '__activity-tbody' },
                  renderActivityRows({
                    entries: filteredEntries,
                    historyLoading,
                    loadError,
                    requestedEventId,
                    selectedEventId,
                    sessionIndex,
                    highlightedEventIds,
                    onSelect: selectEntry,
                    virtualizer: rowVirtualizer
                  })
                )
              )
            )
          ),
          historyHasMore && !historyLoading && !loadError
            ? h('div', { className: 'activity-history-footer' },
                h('span', null, `${allEntries.length} retained event${allEntries.length === 1 ? '' : 's'} loaded`),
                h('button', {
                  className: 'secondary',
                  type: 'button',
                  disabled: olderHistoryLoading,
                  onClick: () => { void loadOlderHistory(); },
                  'data-load-older-activity': ''
                }, olderHistoryLoading ? 'Loading…' : 'Load older activity')
              )
            : null
        ),
        h(ActivityInspector, {
          entry: selectedEntry,
          runtime: data.runtime,
          runtimeCompatibility: data.runtimeCompatibility,
          sessionIndex,
          headingRef: inspectorHeadingRef,
          copyState,
          onCopy: copySelected
        })
      )
    )
  );
}

const ActivityFilterBar = memo(function ActivityFilterBar({
  filterState,
  filters,
  summary,
  paused,
  onSearch,
  onOpenFilters,
  onClearAll,
  onRemoveFilter,
  onTogglePause
}) {
  return h('div', { id: '__activity-filter-bar' },
    h('section', { className: 'filter-bar', 'aria-label': 'List filters' },
      h('div', { className: 'filter-bar-controls' },
        h('label', { className: 'filter-search-control' },
          h('span', { className: 'sr-only' }, 'Search activity'),
          h('input', {
            type: 'search',
            className: 'filter-search-input',
            placeholder: 'Search activity',
            defaultValue: filterState.search,
            autoComplete: 'off',
            onInput: event => onSearch(event.currentTarget.value)
          })
        ),
        h('button', {
          type: 'button',
          className: `secondary filter-open-button${filters.length ? ' active' : ''}`,
          'aria-label': filters.length ? `Open filters. ${filters.length} active` : 'Open filters',
          onClick: onOpenFilters
        }, filters.length ? `Filters (${filters.length})` : 'Filters'),
        h('div', { className: 'filter-bar-action' },
          h('button', {
            id: '__activity-freeze',
            type: 'button',
            className: `secondary filter-state-toggle activity-freeze${paused ? ' active' : ''}`,
            'aria-pressed': paused,
            'aria-label': paused ? 'Resume live activity' : 'Freeze live activity',
            title: paused ? 'Resume live activity' : 'Freeze live activity',
            onClick: onTogglePause
          }, h(Icon, { name: paused ? 'play' : 'pause' }))
        )
      ),
      filters.length ? h('div', { className: 'filter-chip-list', 'aria-label': 'Active filters' },
        filters.map(filter => h('button', {
          key: filter.key,
          type: 'button',
          className: 'secondary filter-chip',
          'aria-label': `Remove ${filter.label} filter: ${filter.value}`,
          onClick: () => onRemoveFilter(filter.key)
        }, h('span', null, `${filter.label}: ${filter.value}`), h(Icon, { name: 'close', size: 12 })))
      ) : null,
      h('span', { className: 'filter-summary sr-only', role: 'status', 'aria-live': 'polite' }, summary),
      hasActiveFilters(filterState) ? h('div', { className: 'filter-bar-footer activity-filter-footer' },
        h('button', {
          type: 'button',
          className: 'secondary filter-clear-button',
          onClick: onClearAll
        }, 'Clear all')
      ) : null
    )
  );
});

const ActivityRowStatus = memo(function ActivityRowStatus({ value }) {
  return h(StatusPill, { value });
});

const ActivityRow = memo(function ActivityRow({ entry, requested, selected, isNew, taskTitle, project, onSelect, measureElement, virtualIndex }) {
  const group = activityStatusGroup(entry);
  const status = entry.status || (group === 'other' ? 'unknown' : group);
  const message = activityMessage(entry);
  const timestamp = eventTimestampValue(entry);
  const absoluteTime = activityAbsoluteTime(entry);
  const action = activityDisplayAction(entry);
  const eventId = activityEventId(entry);
  const className = [
    'activity-data-row',
    requested ? 'activity-requested-row' : '',
    selected ? 'is-selected' : '',
    isNew ? 'is-new-event' : ''
  ].filter(Boolean).join(' ');
  const activate = () => onSelect(entry);
  return h('tr', {
    className,
    ref: measureElement,
    'data-index': virtualIndex,
    'data-activity-event-id': eventId
  },
    h('td', {
      className: 'activity-time-column nowrap small',
      title: absoluteTime,
      'data-clock-relative': timestamp
    }, timeAgo(timestamp) || '—'),
    h('td', { className: 'activity-message-column activity-message-cell' },
      h('button', {
        className: 'activity-row-trigger',
        type: 'button',
        'data-focus-key': `activity-${eventId}`,
        'aria-label': activityActionLabel(entry),
        onClick: activate
      },
        h('span', { className: 'activity-row-status' }, h(ActivityRowStatus, { value: status })),
        h('span', { className: 'activity-message-copy', title: message }, message),
        h('span', { className: 'activity-row-meta' },
          h('span', { className: 'activity-row-action' }, action),
          h('span', { className: 'activity-row-task', title: taskTitle }, taskTitle),
          h('span', { className: 'activity-row-project', title: project }, project)
        )
      )
    )
  );
});

function renderActivityRows({ entries, historyLoading, loadError, requestedEventId, selectedEventId, sessionIndex, highlightedEventIds, onSelect, virtualizer }) {
  if (entries.length) {
    const virtualRows = virtualizer.getVirtualItems();
    const totalSize = virtualizer.getTotalSize();
    const paddingTop = virtualRows.length ? virtualRows[0].start : 0;
    const paddingBottom = virtualRows.length ? Math.max(0, totalSize - virtualRows.at(-1).end) : 0;
    return [
      paddingTop ? h(ActivitySpacerRow, { key: 'virtual-top', height: paddingTop }) : null,
      ...virtualRows.map(row => {
        const entry = entries[row.index];
        const eventId = activityEventId(entry);
        const session = activitySessionView(entry, sessionIndex);
        return h(ActivityRow, {
          key: eventId,
          entry,
          requested: Boolean(requestedEventId && eventId === requestedEventId),
          selected: Boolean(selectedEventId && eventId === selectedEventId),
          isNew: highlightedEventIds?.has(eventId) === true,
          taskTitle: session.title || 'Task',
          project: session.workspace || entry.workspace || 'No project',
          onSelect,
          measureElement: virtualizer.measureElement,
          virtualIndex: row.index
        });
      }),
      paddingBottom ? h(ActivitySpacerRow, { key: 'virtual-bottom', height: paddingBottom }) : null
    ];
  }
  if (historyLoading) {
    return Array.from({ length: 6 }, (_, index) => h('tr', { className: 'activity-skeleton-row', 'aria-hidden': 'true', key: `skeleton-${index}` },
      h('td', { className: 'activity-time-column' }, h('span', { className: 'activity-skeleton activity-skeleton-time' })),
      h('td', { className: 'activity-message-column activity-message-cell' },
        h('span', { className: `activity-skeleton activity-skeleton-message${index % 3 === 1 ? ' activity-skeleton-message-short' : ''}` }),
        h('span', { className: 'activity-skeleton-meta' },
          h('span', { className: 'activity-skeleton activity-skeleton-status' }),
          h('span', { className: 'activity-skeleton activity-skeleton-context' })
        )
      )
    ));
  }
  const message = loadError
    ? 'Activity history could not be loaded. Live events will appear here when available.'
    : 'No activity matches these filters.';
  return h('tr', null, h('td', { colSpan: 2 }, h('div', { className: 'empty' }, message)));
}

function ActivitySpacerRow({ height }) {
  return h('tr', { className: 'activity-virtual-spacer', 'aria-hidden': 'true' },
    h('td', { colSpan: 2, style: { height: `${Math.max(0, height)}px` } })
  );
}

function ActivityInspector({ entry, runtime, runtimeCompatibility, sessionIndex, headingRef, copyState, onCopy }) {
  if (!entry) {
    return h('aside', { className: 'activity-inspector', 'data-activity-inspector': '' },
      h('div', { className: 'inspector-empty' }, h('strong', null, 'Select an activity'))
    );
  }
  const group = activityStatusGroup(entry);
  const displayStatus = entry.status || (group === 'other' ? 'unknown' : group);
  const session = activitySessionView(entry, sessionIndex);
  const heading = activityDisplayAction(entry) || 'Activity detail';
  const message = activityMessage(entry);
  const target = activityTargetLabel(entry);
  const result = activityResultText(entry);
  const command = String(entry.command || '').trim();
  const stdout = String(entry.stdout ?? entry.result?.stdout ?? entry.metadata?.stdout ?? '');
  const stderr = String(entry.stderr ?? entry.result?.stderr ?? entry.metadata?.stderr ?? '');
  const isCommandRun = Boolean(command) || Boolean(stdout) || Boolean(stderr) || entry.action === 'execute' || entry.metadata?.exitCode !== undefined;
  const fileLocation = activityFileLocation(entry);
  const error = activityErrorText(entry);
  const summaryText = distinctActivityText(message, heading) ? message : '';
  const targetText = distinctActivityText(target, fileLocation) ? target : '';
  const resultText = distinctActivityText(result, message, heading) ? result : '';
  const fileLocationText = distinctActivityText(fileLocation, target) ? fileLocation : '';
  const errorText = distinctActivityText(error, message, result) ? error : '';
  const fields = [
    ['Tool', toolName(entry)],
    ['Action', entry.action || entry.operation || 'execute'],
    ['Category', entry.category || 'tool'],
    ['Event ID', entry.eventId || entry.id || '—'],
    ['Rel.AI task ID', entry.taskId || entry.sessionId || '—'],
    ...(entry.sequence != null ? [['Sequence', entry.sequence]] : [])
  ];
  return h('aside', { className: 'activity-inspector', 'data-activity-inspector': '' },
    h('div', { className: 'activity-inspector-head' },
      h('h2', { tabIndex: -1, ref: headingRef }, heading)
    ),
    h('div', { className: 'detail-stack activity-detail' },
      h('div', { className: 'activity-detail-head' },
        h(StatusPill, { value: displayStatus }),
        h('span', { className: 'activity-detail-time muted' }, activityAbsoluteTime(entry))
      ),
      summaryText ? h('p', { className: 'activity-detail-summary' }, summaryText) : null,
      session.id ? h('section', { className: 'activity-session-context' },
        h('div', { className: 'activity-session-copy' },
          h('strong', null, session.title),
          h('span', null, [session.workspace, session.shortId].filter(Boolean).join(' · '))
        ),
        h('div', { className: 'activity-session-actions' },
          h('a', {
            className: 'section-action',
            href: routeHref('tasks', { workspace: session.workspace || entry.workspace, task: session.id })
          }, 'Open task'),
          h('a', {
            className: 'section-action',
            href: routeHref('activity', { workspace: session.workspace || entry.workspace, task: session.id, time: 'all' })
          }, 'Task activity')
        )
      ) : null,
      h(OperationDiagnostics, { key: activityEventId(entry), operation: entry, live: group === 'active' }),
      readableSection('Target', targetText),
      command ? h(CommandDetail, { command }) : null,
      isCommandRun ? h(StreamOutputDetail, { title: 'Standard output', output: stdout, stream: 'stdout' }) : null,
      isCommandRun ? h(StreamOutputDetail, { title: 'Standard error', output: stderr, stream: 'stderr' }) : null,
      readableSection('Result', resultText),
      readableSection('File location', fileLocationText),
      readableSection('Error', errorText, 'activity-detail-error'),
      h(RuntimeBuildIdentity, { runtime, compatibility: runtimeCompatibility }),
      h('details', { className: 'activity-detail-technical' },
        h('summary', null, 'Technical details'),
        h('div', { className: 'activity-detail-fields' },
          fields.map(([label, value]) => h('div', { className: 'detail-field', key: label },
            h('span', { className: 'detail-field-label' }, label),
            h('span', null, String(value))
          ))
        ),
        h(RawDetail, { title: 'Raw target', value: entry.target, key: 'raw-target' }),
        h(RawDetail, { title: 'Raw result', value: entry.result, key: 'raw-result' }),
        h(RawDetail, { title: 'Safe metadata', value: entry.metadata, key: 'safe-metadata' }),
        h(RawDetail, { title: 'Raw error', value: entry.error, key: 'raw-error' }),
        h('button', {
          type: 'button',
          className: 'secondary',
          'data-state': copyState === 'success' ? 'success' : undefined,
          onClick: onCopy
        }, copyState === 'success' ? 'Copied' : 'Copy event JSON')
      )
    )
  );
}

function CommandDetail({ command }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(0);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  const copyCommand = async () => {
    try {
      await copyText(command);
      setCopied(true);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      toast('Clipboard access failed.', { variant: 'error' });
    }
  };
  return h('section', { className: 'activity-detail-section activity-detail-command', 'data-activity-command': '' },
    h('div', { className: 'activity-detail-command-head' },
      h('h3', null, 'Command'),
      h('button', { type: 'button', className: 'secondary compact-button', onClick: () => { void copyCommand(); } }, copied ? 'Copied' : 'Copy command')
    ),
    h('pre', null, h('code', null, command))
  );
}

function StreamOutputDetail({ title, output, stream = 'stdout' }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(0);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  const formatted = formatTerminalOutput(String(output || '')).trim();
  const copyStream = async () => {
    try {
      await copyText(formatted);
      setCopied(true);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      toast('Clipboard access failed.', { variant: 'error' });
    }
  };
  return h('section', {
    className: `activity-detail-section activity-detail-stream activity-stream-${stream}`,
    'data-activity-stream': stream
  },
    h('div', { className: 'activity-detail-stream-head' },
      h('h3', null, title),
      formatted ? h('button', {
        type: 'button',
        className: 'secondary compact-button',
        onClick: () => { void copyStream(); }
      }, copied ? 'Copied' : `Copy ${title.toLowerCase()}`) : null
    ),
    formatted
      ? h('pre', { tabIndex: 0, 'aria-label': `${title} output` },
          h('code', null, formatted)
        )
      : h('p', { className: 'muted activity-stream-empty' }, `No ${title.toLowerCase()} recorded.`)
  );
}

function readableSection(title, value, className = '') {
  if (!value) return null;
  return h('section', { className: ['activity-detail-section', className].filter(Boolean).join(' '), key: title },
    h('h3', null, title),
    h('p', null, value)
  );
}

function distinctActivityText(value, ...others) {
  const normalized = normalizeActivityText(value);
  if (!normalized) return false;
  return !others.some(other => normalizeActivityText(other) === normalized);
}

function normalizeActivityText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

const JSON_NO_MATCH = Symbol('json-no-match');

function RawDetail({ title, value }) {
  const [query, setQuery] = useState('');
  const [treeRevision, setTreeRevision] = useState({ id: 0, open: true });
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef(0);
  const empty = value === undefined || value === null || value === '' || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
  const objectValue = value && typeof value === 'object';
  const normalizedQuery = query.trim().toLowerCase();
  const filteredValue = useMemo(() => objectValue ? filterJsonValue(value, normalizedQuery) : value, [normalizedQuery, objectValue, value]);

  useEffect(() => () => window.clearTimeout(copyTimerRef.current), []);
  if (empty) return null;

  const copyValue = async () => {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    try {
      const ok = await copyText(text);
      if (ok === false) throw new Error('Clipboard write failed.');
      setCopied(true);
      window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1200);
    } catch {
      toast('Clipboard access failed.', { variant: 'error' });
    }
  };

  return h('section', { className: 'activity-detail-raw' },
    h('div', { className: 'activity-detail-raw-head' },
      h('h4', null, title),
      h('div', { className: 'activity-detail-raw-actions' },
        objectValue ? h('button', {
          type: 'button',
          className: 'secondary compact-button',
          'aria-expanded': treeRevision.open,
          onClick: () => setTreeRevision(current => ({ id: current.id + 1, open: !current.open }))
        }, treeRevision.open ? 'Collapse all' : 'Expand all') : null,
        h('button', { type: 'button', className: 'secondary compact-button', onClick: () => { void copyValue(); } }, copied ? 'Copied' : 'Copy value')
      )
    ),
    objectValue ? h('label', { className: 'activity-json-search' },
      h('span', { className: 'sr-only' }, `Search ${title}`),
      h(Icon, { name: 'search', size: 14 }),
      h('input', { type: 'search', value: query, placeholder: 'Search keys or values', onChange: event => setQuery(event.target.value) })
    ) : null,
    objectValue
      ? filteredValue === JSON_NO_MATCH
        ? h('div', { className: 'activity-json-empty' }, 'No matching keys or values.')
        : h('div', { className: 'activity-json-tree' }, h(JsonTreeNode, { value: filteredValue, treeRevision, root: true }))
      : h('pre', { className: 'detail-pre' }, String(value))
  );
}

function JsonTreeNode({ label = '', value, treeRevision, root = false }) {
  const branch = value && typeof value === 'object';
  const [open, setOpen] = useState(true);
  useEffect(() => { setOpen(treeRevision.open); }, [treeRevision]);
  if (!branch) {
    return h('div', { className: 'activity-json-leaf' },
      label !== '' ? h('span', { className: 'activity-json-key' }, label) : null,
      label !== '' ? h('span', { 'aria-hidden': 'true' }, ':') : null,
      h('code', null, jsonPrimitive(value))
    );
  }
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value);
  const typeLabel = Array.isArray(value) ? `Array · ${entries.length}` : `Object · ${entries.length}`;
  return h('details', { className: `activity-json-branch${root ? ' is-root' : ''}`, open, onToggle: event => setOpen(event.currentTarget.open) },
    h('summary', null,
      label !== '' ? h('span', { className: 'activity-json-key' }, label) : null,
      h('span', { className: 'activity-json-type' }, typeLabel)
    ),
    h('div', { className: 'activity-json-children' },
      entries.map(([key, child]) => h(JsonTreeNode, { key, label: key, value: child, treeRevision }))
    )
  );
}

function filterJsonValue(value, query, key = '') {
  if (!query) return value;
  if (String(key).toLowerCase().includes(query)) return value;
  if (!value || typeof value !== 'object') return String(value).toLowerCase().includes(query) ? value : JSON_NO_MATCH;
  if (Array.isArray(value)) {
    const filtered = [];
    value.forEach((item, index) => {
      const match = filterJsonValue(item, query, index);
      if (match !== JSON_NO_MATCH) filtered.push(match);
    });
    return filtered.length ? filtered : JSON_NO_MATCH;
  }
  const filtered = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const match = filterJsonValue(childValue, query, childKey);
    if (match !== JSON_NO_MATCH) filtered[childKey] = match;
  }
  return Object.keys(filtered).length ? filtered : JSON_NO_MATCH;
}

function jsonPrimitive(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  return String(value);
}

function openActivityFilters({ filterState, filterOptions, onApply }) {
  openFilterDrawer({
    title: 'Activity filters',
    value: {
      timeRange: filterState.timeRange,
      workspace: filterState.workspace,
      tool: filterState.tool,
      status: filterState.status
    },
    resetValue: { timeRange: '1h', workspace: '', tool: '', status: '' },
    renderFields(fields, draft) {
      fields.append(
        filterRadioField({
          label: 'Time range',
          value: draft.timeRange,
          options: TIME_OPTIONS,
          onChange: value => { draft.timeRange = value; }
        }),
        filterSelectField({
          label: 'Project',
          value: draft.workspace,
          options: activitySelectOptions('All projects', filterOptions.workspaces, draft.workspace),
          onChange: value => { draft.workspace = value; }
        }),
        filterSelectField({
          label: 'Action',
          value: draft.tool,
          options: activitySelectOptions('All actions', filterOptions.tools, draft.tool, activityToolLabel),
          onChange: value => { draft.tool = value; }
        }),
        filterRadioField({
          label: 'Status',
          value: draft.status,
          options: STATUS_OPTIONS,
          onChange: value => { draft.status = value; }
        })
      );
    },
    onApply
  });
}

function readRouteState() {
  const params = getRouteParams();
  const requestedRange = String(params.get('time') || '').toLowerCase();
  return {
    filters: {
      search: params.get('search') || '',
      timeRange: ['15m', '1h', '24h', '7d', 'all'].includes(requestedRange) ? requestedRange : '1h',
      workspace: getWorkspaceFilter(),
      tool: params.get('tool') || '',
      status: normalizeStatusFilter(params.get('status')),
      task: params.get('task') || ''
    },
    eventId: params.get('event') || ''
  };
}

function activityFilters(filterState, sessionIndex) {
  const filters = [];
  const add = (key, label, value, display = value) => {
    if (value) filters.push({ key, label, value: display });
  };
  if (filterState.timeRange !== '1h') add('timeRange', 'Time', filterState.timeRange, filterState.timeRange === 'all' ? 'All time' : filterState.timeRange);
  add('workspace', 'Project', filterState.workspace);
  add('tool', 'Action', filterState.tool, activityToolLabel(filterState.tool));
  add('status', 'Status', filterState.status, statusFilterLabel(filterState.status));
  if (filterState.task) {
    const session = sessionIndex.get(filterState.task);
    add('task', 'Task', filterState.task, session?.title || `Task ${filterState.task.slice(0, 8)}`);
  }
  return filters;
}

function statusFilterLabel(status) {
  return {
    succeeded: 'succeeded',
    active: 'in progress',
    failed: 'failed',
    blocked: 'blocked',
    cancelled: 'cancelled',
    other: 'other'
  }[status] || status;
}

function activityRouteParams(filterState) {
  return {
    workspace: filterState.workspace,
    search: filterState.search || null,
    time: filterState.timeRange === '1h' ? null : filterState.timeRange,
    tool: filterState.tool || null,
    status: filterState.status || null,
    task: filterState.task || null
  };
}

function hasActiveFilters(filterState) {
  return Boolean(
    filterState.search ||
    filterState.workspace ||
    filterState.tool ||
    filterState.status ||
    filterState.task ||
    filterState.timeRange !== '1h'
  );
}

function activitySelectOptions(allLabel, values, selected, labelFor = value => value) {
  const options = selected && !values.includes(selected) ? [selected, ...values] : values;
  return [{ value: '', label: allLabel }, ...options.map(value => ({ value, label: labelFor(value) }))];
}

function buildSessionIndex(tasks = []) {
  const sessions = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const id = String(task?.id || task?.taskId || task?.work_id || '').trim();
    if (!id) continue;
    sessions.set(id, {
      id,
      title: task.title || task.objective || task.currentActivity || 'Task',
      workspace: task.workspace || '',
      status: task.status || ''
    });
  }
  return sessions;
}

function uniqueValues(entries, selector) {
  return [...new Set(entries.map(selector).filter(Boolean).map(String))].sort((left, right) => left.localeCompare(right));
}

function toolName(entry) {
  return entry?.tool?.name || entry?.tool || entry?.type || 'activity';
}

function activityTargetLabel(entry) {
  if (typeof entry.path === 'string' && entry.path.trim()) return entry.path.trim();
  if (typeof entry.target === 'string' && entry.target.trim()) return entry.target.trim();
  return entry.target?.workspaceRelativePath || entry.target?.path || '';
}

function activityResultText(entry) {
  if (typeof entry.result === 'string') return entry.result.trim();
  return String(entry.result?.outcome || entry.result?.summary || '').trim();
}

function activityErrorText(entry) {
  if (typeof entry.error === 'string') return entry.error.trim();
  return String(entry.error?.message || '').trim();
}

function safeEventProjection(entry) {
  if (entry?.safeCopy && typeof entry.safeCopy === 'object') return entry.safeCopy;
  return {
    eventId: entry.eventId || entry.id,
    taskId: entry.taskId,
    sessionId: entry.sessionId,
    sequence: entry.sequence,
    timestamp: entry.timestamp || entry.ts,
    category: entry.category,
    action: entry.action,
    status: entry.status || activityStatusGroup(entry),
    title: entry.title || entry.operation,
    summary: entry.summary || entry.message || activityMessage(entry),
    durationMs: entry.durationMs || entry.ms,
    tool: entry.tool,
    workspace: entry.workspace,
    target: entry.target || (entry.path ? { workspaceRelativePath: entry.path } : undefined),
    result: entry.result,
    error: entry.error,
    command: entry.command,
    metadata: entry.metadata
  };
}
