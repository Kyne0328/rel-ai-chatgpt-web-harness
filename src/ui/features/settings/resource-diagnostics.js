import React, { useState } from 'react';
import { StatusPill } from '../../components/pill.js';

const h = React.createElement;
const LANE_LABELS = Object.freeze({ gitObservation: 'Git checks', heavy: 'Heavy commands and checks', repositoryQuery: 'Repository queries', persistent: 'Background processes' });

export function ResourceDiagnostics({ resources = {}, onRefresh }) {
  const [refreshing, setRefreshing] = useState(false);
  const host = resources?.host || {};
  const pressure = host.pressure || {};
  const node = resources?.node || {};
  const current = node.current || {};
  const trend = node.trend || {};
  const fileReadCache = resources?.caches?.fileReads || {};
  const stale = pressure.stale !== false;
  const state = !stale && known(pressure.physicalAvailableBytes) ? 'normal' : 'unknown';
  const stateLabel = state === 'normal' ? 'Memory readings available' : 'Memory readings unavailable';
  const lanes = Object.entries(host.lanes || {}).slice(0, 10);
  const physicalValid = !stale && fraction(pressure.physicalAvailableBytes, pressure.physicalTotalBytes) !== null;
  const usedPhysical = physicalValid ? pressure.physicalTotalBytes - pressure.physicalAvailableBytes : null;
  const serviceAvailable = node.available === true && node.stale !== true;
  const samples = (Array.isArray(node.samples) ? node.samples : []).slice(-60)
    .filter(sample => known(sample.sampledAtMs) && known(sample.rssBytes) && sample.rssBytes >= 0)
    .sort((a, b) => a.sampledAtMs - b.sampledAtMs);
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
        stale ? 'Host measurements are stale or unavailable.' : `Snapshot · ${sampleAge(pressure.ageMs)}`),
      h('div', { className: 'resource-overview' },
        h('section', { className: 'resource-stat', 'aria-label': 'Physical memory' },
          h('h4', null, 'Physical memory'),
          h('div', { className: 'resource-stat-value' }, physicalValid ? bytes(pressure.physicalAvailableBytes) : 'Unknown', h('span', null, 'available')),
          h(UtilizationBar, { label: 'Physical memory used', value: usedPhysical, maximum: physicalValid ? pressure.physicalTotalBytes : null,
            valueText: physicalValid ? `${bytes(usedPhysical)} used of ${bytes(pressure.physicalTotalBytes)}` : 'Current physical memory unavailable' }),
          h('div', { className: 'resource-stat-caption' }, physicalValid ? `${bytes(usedPhysical)} used / ${bytes(pressure.physicalTotalBytes)} total` : 'Refresh to obtain a current reading')),
        h('section', { className: 'resource-stat', 'aria-label': 'Rel.AI service memory' },
          h('h4', null, 'Rel.AI service'),
          h('div', { className: 'resource-stat-value' }, serviceAvailable ? bytes(current.rssBytes) : 'Unknown', h('span', null, 'resident memory')),
          h(MemoryHistory, { samples: serviceAvailable ? samples : [] }),
          h('div', { className: 'resource-stat-caption' }, 'Service process only')),
        h('section', { className: 'resource-stat', 'aria-label': 'File-read cache memory' },
          h('h4', null, 'File-read cache'),
          h('div', { className: 'resource-stat-value' }, bytes(fileReadCache.retainedBytes), h('span', null, 'retained text')),
          h(UtilizationBar, { label: 'File-read cache budget used', value: fileReadCache.retainedBytes, maximum: fileReadCache.maxRetainedBytes,
            valueText: `${bytes(fileReadCache.retainedBytes)} of ${bytes(fileReadCache.maxRetainedBytes)} budget` }),
          h('div', { className: 'resource-stat-caption' }, `${bytes(fileReadCache.maxRetainedBytes)} budget · ${count(fileReadCache.entries)} entries`))
      ),
      h('div', { className: 'resource-work-heading' }, h('h4', null, 'Running work'), h('span', null, 'Active / capacity')),
      h('div', { className: 'resource-diagnostics-lanes', role: 'group', 'aria-label': 'Resource admission lanes' }, lanes.length ? lanes.map(([name, lane]) => {
        const queue = host.queues?.[name] || {};
        const label = LANE_LABELS[name] || name;
        return h('section', { className: 'resource-diagnostics-lane', key: name },
          h('div', { className: 'resource-lane-heading' }, h('h4', null, label),
            h('strong', null, `${count(lane.active)} / ${count(lane.limit)}`)),
          h(UtilizationBar, { label: `${label} active`, value: lane.active, maximum: lane.limit,
            valueText: `${count(lane.active)} active of ${count(lane.limit)} capacity; ${count(lane.queued)} queued` }),
          lane.queued > 0 ? h('details', { className: 'resource-queue' },
            h('summary', null, `${count(lane.queued)} queued`),
            h('p', { className: 'resource-diagnostics-note' }, queue.blockedReason || 'Waiting for a slot.'))
            : h('span', { className: 'resource-stat-caption' }, known(lane.queued) ? 'No queued work' : 'Queue unavailable')
        );
      }) : h('p', { className: 'resource-diagnostics-note' }, 'Lane limits are unavailable.')),
      h('details', { className: 'resource-diagnostics-details', 'data-resource-technical': '' },
        h('summary', null, 'Technical resource details'),
      h('p', { className: 'resource-diagnostics-note' }, 'Memory readings are informational.'),
      h('p', { className: 'resource-diagnostics-note' },
        `Source: ${pressure.source || 'unknown'} · ${sampleAge(pressure.ageMs)}`,
        pressure.error ? ` · ${pressure.error}` : ''),
      h('dl', { className: 'resource-diagnostics-metrics' },
        metric('Available physical memory', bytes(pressure.physicalAvailableBytes)),
        metric('Total physical memory', bytes(pressure.physicalTotalBytes)),
        metric('Commit used / limit', `${bytes(pressure.commitUsedBytes)} / ${bytes(pressure.commitLimitBytes)}`),
        metric('Commit headroom', bytes(pressure.commitAvailableBytes)),
        metric('Pages read in / second', rate(pressure.pagesInputPerSecond)),
        metric('Page disk reads / second', rate(pressure.pageReadsPerSecond))
      ),
      pressure.pagingMeaning ? h('p', { className: 'resource-diagnostics-note' }, pressure.pagingMeaning) : null,
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
        node.interpretation ? h('p', { className: 'resource-diagnostics-note' }, node.interpretation) : null,
        samples.length ? h('details', { className: 'resource-diagnostics-details' },
          h('summary', null, `Memory history data (${samples.length} samples)`),
          h('div', { className: 'resource-history-data' }, h('table', null,
            h('caption', null, 'Recorded service memory samples'),
            h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Time'), h('th', { scope: 'col' }, 'Resident memory'))),
            h('tbody', null, samples.map((sample, index) => h('tr', { key: index },
              h('td', null, sampleTime(sample.sampledAtMs)), h('td', null, bytes(sample.rssBytes)))))))) : null,
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
      h(ManagedRootMemory, { snapshot: resources?.managedRoots })
      )
    )
  );
}

function fraction(value, maximum) {
  return known(value) && value >= 0 && known(maximum) && maximum > 0 && value <= maximum ? value / maximum : null;
}

function UtilizationBar({ label, value, maximum, valueText }) {
  const ratio = fraction(value, maximum);
  const percentage = ratio === null ? null : Math.round(ratio * 100);
  return h('div', { className: `resource-utilization${ratio === null ? ' unavailable' : ''}`,
    role: ratio === null ? 'img' : 'meter', 'aria-label': ratio === null ? `${label}: unavailable` : label,
    ...(ratio === null ? {} : { 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percentage, 'aria-valuetext': valueText }),
    title: valueText },
    ratio === null ? null : h('span', { style: { width: `${ratio * 100}%` } }));
}

function MemoryHistory({ samples }) {
  if (samples.length < 2 || samples.at(-1).sampledAtMs <= samples[0].sampledAtMs) {
    return h('div', { className: 'resource-chart-empty' }, samples.length ? '1 sample · refresh to build history' : 'History unavailable');
  }
  const first = samples[0], last = samples.at(-1);
  const maximum = Math.max(...samples.map(sample => sample.rssBytes), 1);
  const points = samples.map(sample => `${4 + (sample.sampledAtMs - first.sampledAtMs) / (last.sampledAtMs - first.sampledAtMs) * 292},${56 - sample.rssBytes / maximum * 48}`).join(' ');
  return h('figure', { className: 'resource-memory-history' },
    h('svg', { viewBox: '0 0 300 64', preserveAspectRatio: 'none', role: 'img',
      'aria-label': `Service memory: ${samples.length} samples over ${milliseconds(last.sampledAtMs - first.sampledAtMs)}, from ${bytes(first.rssBytes)} to ${bytes(last.rssBytes)}. Vertical scale 0 to ${bytes(maximum)}.` },
      h('line', { x1: 4, x2: 296, y1: 56, y2: 56, className: 'resource-chart-baseline' }),
      h('polyline', { points, fill: 'none', className: 'resource-chart-line', vectorEffect: 'non-scaling-stroke' })),
    h('figcaption', null, `${samples.length} recorded samples · ${milliseconds(last.sampledAtMs - first.sampledAtMs)}`));
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
    roots.length ? h('p', { className: 'resource-diagnostics-note' }, 'Ranked by measured root private bytes, with unknown values last. This is a bounded list of Rel.AI-managed roots, not all OS processes or a complete process-family total. Detached descendants remain unknown.') : null,
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
    ))) : (value.scope === 'managed_roots_only' ? h('p', { className: 'resource-diagnostics-note' }, value.totalRootCount === 0 ? 'No managed roots are active.' : 'Managed-root detail is unavailable.') : null),
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
  if (value > 0 && value < 1024 ** 2) return value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${Math.round(value)} B`;
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
