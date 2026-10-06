import React, { useState } from 'react';
import { StatusPill } from '../../components/pill.js';

const h = React.createElement;
const LANE_LABELS = Object.freeze({ heavy: 'Heavy commands and checks', repositoryQuery: 'Repository queries', persistent: 'Persistent processes' });

export function ResourceDiagnostics({ resources = {}, onRefresh }) {
  const [refreshing, setRefreshing] = useState(false);
  const host = resources?.host || {};
  const pressure = host.pressure || {};
  const node = resources?.node || {};
  const current = node.current || {};
  const trend = node.trend || {};
  const fileReadCache = resources?.caches?.fileReads || {};
  const stale = pressure.stale !== false;
  const state = stale ? 'unknown' : pressure.state || 'unknown';
  const stateLabel = state === 'normal' ? 'Normal pressure' : state === 'pressured' ? 'Memory pressure' : 'Pressure unknown';
  const lanes = Object.entries(host.lanes || {}).slice(0, 10);
  const decisions = Array.isArray(pressure.recentDecisions) ? pressure.recentDecisions.slice(-10).reverse() : [];
  const refresh = async () => {
    if (refreshing || !onRefresh) return;
    setRefreshing(true);
    try { await onRefresh(); } finally { setRefreshing(false); }
  };
  return h('section', { className: 'card resource-diagnostics', 'data-diagnostic-region': 'resources', 'aria-labelledby': 'resource-diagnostics-heading' },
    h('div', { className: 'card-head' },
      h('div', null, h('h3', { id: 'resource-diagnostics-heading' }, 'System resources'),
        h('p', null, 'Memory availability and running work.')),
      h('div', { className: 'resource-diagnostics-actions' },
        h(StatusPill, { label: stateLabel, tone: state === 'normal' ? 'neutral' : 'warning' }),
        onRefresh ? h('button', { className: 'secondary', type: 'button', disabled: refreshing, onClick: () => void refresh() }, refreshing ? 'Refreshing…' : 'Refresh resources') : null)
    ),
    h('div', { className: 'card-body resource-diagnostics-body' },
      h('p', { className: 'resource-diagnostics-reason', role: 'status' },
        pressure.reason || 'No host pressure sample is available.',
        stale ? ' Host measurements are stale or unavailable.' : ''),
      h('dl', { className: 'resource-diagnostics-metrics' },
        metric('Available physical memory', bytes(pressure.physicalAvailableBytes)),
        metric('Total physical memory', bytes(pressure.physicalTotalBytes)),
        metric('Rel.AI service memory', bytes(current.rssBytes))),
      h('div', { className: 'resource-diagnostics-lanes', 'aria-label': 'Resource admission lanes' }, lanes.length ? lanes.map(([name, lane]) => {
        const queue = host.queues?.[name] || {};
        return h('section', { className: 'resource-diagnostics-lane', key: name },
          h('h4', null, LANE_LABELS[name] || name),
          h('dl', { className: 'resource-diagnostics-metrics' },
            metric('Active / limit', `${count(lane.active)} / ${count(lane.limit)}`),
            metric('Queued', count(lane.queued))),
          lane.queued > 0 ? h('p', { className: 'resource-diagnostics-note' }, queue.blockedReason || 'Waiting for a slot.') : null
        );
      }) : h('p', { className: 'resource-diagnostics-note' }, 'Lane limits are unavailable.')),
      h('details', { className: 'resource-diagnostics-details', 'data-resource-technical': '' },
        h('summary', null, 'Technical resource details'),
      h('p', { className: 'resource-diagnostics-note' },
        `Source: ${pressure.source || 'unknown'} · ${sampleAge(pressure.ageMs)} · ${pressure.commitEnforced === true ? 'Commit admission enforced' : 'Commit admission unavailable'}`,
        pressure.error ? ` · ${pressure.error}` : ''),
      h('dl', { className: 'resource-diagnostics-metrics' },
        metric('Available physical memory', bytes(pressure.physicalAvailableBytes)),
        metric('Total physical memory', bytes(pressure.physicalTotalBytes)),
        metric('Commit used / limit', `${bytes(pressure.commitUsedBytes)} / ${bytes(pressure.commitLimitBytes)}`),
        metric('Commit headroom', bytes(pressure.commitAvailableBytes)),
        metric('Reserved for active and settling work', bytes(pressure.reservedBytes)),
        metric('Minimum heavy-work reservation', bytes(pressure.reservationBytes)),
        metric('Startup bytes awaiting resample', bytes(pressure.settlingReservedBytes)),
        metric('Startup reservations settling', count(pressure.settlingReservationCount)),
        metric('Oldest settling / minimum window', `${milliseconds(pressure.oldestSettlingMs)} / ${milliseconds(pressure.startupSettlingMs)}`),
        metric('Pages read in / second', rate(pressure.pagesInputPerSecond)),
        metric('Page disk reads / second', rate(pressure.pageReadsPerSecond)),
        metric('Physical / commit reserve floor', `${bytes(pressure.physicalFloorBytes)} / ${bytes(pressure.commitFloorBytes)}`)
      ),
      pressure.settlingReservationCount > 0 || pressure.settlingReservedBytes > 0 ? h('p', { className: 'resource-diagnostics-note' }, pressure.settlingReason || 'Startup work has released its slot. Its memory estimate remains reserved until a fresh host sample covers the settling window.') : null,
      h('p', { className: 'resource-diagnostics-note' }, pressure.pagingMeaning || 'Paging rates are unavailable. A sampled rate alone does not establish sustained memory thrashing.'),
      h('details', { className: 'resource-diagnostics-details' },
        h('summary', null, 'Current Node process memory'),
        h('p', { className: 'resource-diagnostics-note' }, `PID ${count(node.pid)} · ${sampleAge(node.ageMs)}${node.available === true ? '' : ' · Measurement unavailable'}`),
        node.error ? h('p', { className: 'resource-diagnostics-note' }, node.error) : null,
        h('dl', { className: 'resource-diagnostics-metrics' },
          metric('Resident memory (RSS)', bytes(current.rssBytes)),
          metric('Heap used / allocated', `${bytes(current.heapUsedBytes)} / ${bytes(current.heapTotalBytes)}`),
          metric('V8 heap limit', bytes(current.heapLimitBytes)),
          metric('External memory', bytes(current.externalBytes)),
          metric('ArrayBuffers (included in external)', bytes(current.arrayBuffersBytes))),
        h('p', { className: 'resource-diagnostics-note' }, node.interpretation || 'These metrics cover the current Node process, not Windows private commit or the complete Rel.AI process family. Memory values overlap and must not be added together.'),
        h('h4', null, 'File-read cache budget'),
        h('dl', { className: 'resource-diagnostics-metrics' },
          metric('Retained text / byte budget', `${bytes(fileReadCache.retainedBytes)} / ${bytes(fileReadCache.maxRetainedBytes)}`),
          metric('Text / metadata entries', `${count(fileReadCache.entries)} / ${count(fileReadCache.metadataEntries)}`),
          metric('Budget evictions', count(fileReadCache.evictions))),
        h('p', { className: 'resource-diagnostics-note' }, 'The cache budget counts retained UTF-8 content bytes; it does not measure JavaScript object or string heap overhead.'),
        h('h4', null, 'Bounded memory observations'),
        h('p', { className: 'resource-diagnostics-note' },
          `${count(trend.sampleCount)} of ${count(node.sampling?.maxSamples)} samples retained · ${milliseconds(trend.durationMs)} window. Sampled only on diagnostic reads, at most once every ${milliseconds(node.sampling?.intervalMs)}.`),
        trend.status === 'observed' ? h(React.Fragment, null,
          h('p', { className: 'resource-diagnostics-note' }, `Baseline: ${sampleTime(trend.baselineAtMs)}. First-to-last change over retained samples; this is not a leak assessment.`),
          h('dl', { className: 'resource-diagnostics-metrics' },
            metric('Baseline RSS / heap / external', `${bytes(trend.baseline?.rssBytes)} / ${bytes(trend.baseline?.heapUsedBytes)} / ${bytes(trend.baseline?.externalBytes)}`),
            metric('RSS change per minute', signedRate(trend.slopeBytesPerMinute?.rssBytes)),
            metric('Heap change per minute', signedRate(trend.slopeBytesPerMinute?.heapUsedBytes)),
            metric('External change per minute', signedRate(trend.slopeBytesPerMinute?.externalBytes))))
          : h('p', { className: 'resource-diagnostics-note' }, 'Trend unavailable: at least three successful samples spanning ten seconds are required.'),
        h('p', { className: 'resource-diagnostics-note' }, `Full process-family memory: unmeasured. ${resources?.children?.reason || 'No process-family memory probe is run by this snapshot.'}`)
      ),
      h(ManagedRootMemory, { snapshot: resources?.managedRoots }),
      decisions.length ? h('details', { className: 'resource-diagnostics-details' },
        h('summary', null, 'Recent pressure decisions'),
        h('ul', { className: 'resource-diagnostics-decisions' }, decisions.map((decision, index) => h('li', { key: `${decision.atMs}:${index}` },
          h('time', null, sampleTime(decision.atMs)), h('span', null, `${decision.state || 'unknown'}: ${decision.reason || 'No reason supplied'}`))))
      ) : null
      )
    )
  );
}

function ManagedRootMemory({ snapshot = {} }) {
  const value = snapshot || {};
  const stale = value.stale === true || (known(value.cacheAgeMs) && value.cacheAgeMs >= 5_000);
  const measured = root => !stale && root.identityVerified === true && root.measurementStatus === 'measured';
  const roots = (Array.isArray(value.roots) ? value.roots : []).slice(0, 20).sort((left, right) => {
    const leftBytes = measured(left) && known(left.privateBytes) ? left.privateBytes : -1;
    const rightBytes = measured(right) && known(right.privateBytes) ? right.privateBytes : -1;
    return rightBytes - leftBytes;
  });
  return h('details', { className: 'resource-diagnostics-details' },
    h('summary', null, 'Managed process roots'),
    h('p', { className: 'resource-diagnostics-note' },
      `${roots.length} shown of ${count(value.totalRootCount)} authorized managed roots · ${sampleAge(value.cacheAgeMs)}${stale ? ' · Stale sample; refresh to verify identity again.' : ''}`),
    h('p', { className: 'resource-diagnostics-note' }, 'Ranked by measured root private bytes, with unknown values last. This is a bounded list of Rel.AI-managed roots, not all OS processes or a complete process-family total. Detached descendants remain unknown.'),
    roots.length ? h('div', { className: 'resource-diagnostics-lanes' }, roots.map(root => h('section', {
      className: 'resource-diagnostics-lane resource-diagnostics-root', key: root.processId || root.pid, 'data-managed-root-id': root.processId || ''
    },
      h('h4', null, root.label || `Managed PID ${count(root.pid)}`),
      h('dl', { className: 'resource-diagnostics-metrics' },
        metric('PID', count(root.pid)),
        metric('Kind / lifecycle', `${root.kind || 'Unknown'} / ${root.lifecycle || 'Unknown'}`),
        metric('Status', root.identityVerified === true ? root.status || 'Unknown' : `Unverified (recorded ${root.status || 'unknown'})`),
        metric('Private bytes', measured(root) ? bytes(root.privateBytes) : 'Unknown'),
        metric('Working set', measured(root) ? bytes(root.workingSetBytes) : 'Unknown'),
        metric('Workspace', root.workspace || 'Unknown'),
        metric('Work session', root.workSessionId || 'None')),
      h('p', { className: 'resource-diagnostics-note' }, `Measured: ${root.sampledAt || 'Unknown'} · ${measured(root) ? 'Identity verified at sample time' : root.reason || 'Memory attribution unavailable'}`)
    ))) : h('p', { className: 'resource-diagnostics-note' }, value.scope === 'managed_roots_only' ? (value.totalRootCount === 0 ? 'No managed roots are active in this authorized scope.' : 'Managed-root detail is unavailable for this snapshot.') : 'Managed-root memory was not requested in this context.'),
    value.omittedRootCount > 0 ? h('p', { className: 'resource-diagnostics-note' }, `${count(value.omittedRootCount)} additional roots omitted from this bounded snapshot.`) : null,
    value.error || value.reason ? h('p', { className: 'resource-diagnostics-note' }, value.error || value.reason) : null
  );
}

function metric(label, value) {
  return h('div', { key: label }, h('dt', null, label), h('dd', null, value));
}
function known(value) { return typeof value === 'number' && Number.isFinite(value); }
function bytes(value) {
  if (!known(value) || value < 0) return 'Unknown';
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : `${(value / 1024 ** 2).toFixed(1)} MiB`;
}
function count(value) { return known(value) && value >= 0 ? String(Math.floor(value)) : 'Unknown'; }
function milliseconds(value) {
  if (!known(value) || value < 0) return 'Unknown';
  return value >= 60_000 ? `${(value / 60_000).toFixed(1)} min` : `${(value / 1000).toFixed(1)} s`;
}
function rate(value) { return known(value) && value >= 0 ? value.toFixed(1) : 'Unknown'; }
function sampleAge(ageMs) { return known(ageMs) ? `sample age ${milliseconds(ageMs)}` : 'sample time unknown'; }
function sampleTime(value) { return known(value) ? new Date(value).toLocaleTimeString() : 'Unknown time'; }
function signedRate(value) {
  if (!known(value)) return 'Unknown';
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}${bytes(Math.abs(value))}/min`;
}
