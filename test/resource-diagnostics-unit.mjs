import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createNodeMemorySampler, resourceDiagnosticsSnapshot } from '../src/resourceDiagnostics.js';
import { buildDiagnosticReport } from '../src/diagnostics.js';
import { hostResourceDiagnosticSnapshot } from '../src/hostResourceScheduler.js';
import { ResourceDiagnostics } from '../src/ui/features/settings/resource-diagnostics.js';

let atMs = 10_000;
let reads = 0;
let failed = false;
const sampler = createNodeMemorySampler({
  now: () => atMs,
  intervalMs: 1, // The observer must never allow a high-frequency read loop.
  maxSamples: 1_000,
  readMemory: () => {
    reads += 1;
    if (failed) throw new Error('password=private-collector-error');
    return { rss: 100_000 + reads * 100, heapUsed: 10_000 + reads * 10, heapTotal: 20_000, external: 2_000 - reads, arrayBuffers: 100 };
  },
  readHeap: () => ({ heap_size_limit: 200_000 })
});

const first = sampler.snapshot();
assert.equal(reads, 1);
assert.equal(first.current.rssBytes, 100_100);
assert.equal(first.current.heapLimitBytes, 200_000);
assert.equal(first.sampling.intervalMs, 5_000);
assert.equal(first.sampling.maxSamples, 60);
assert.equal(first.trend.status, 'insufficient-samples');
assert.equal(first.trend.slopeBytesPerMinute.rssBytes, null);
for (let i = 0; i < 1_000; i += 1) sampler.snapshot();
assert.equal(reads, 1, 'diagnostic reads must use the memory sample cache');
atMs += 4_999;
assert.equal(sampler.snapshot().ageMs, 4_999);
assert.equal(reads, 1);
atMs += 1;
assert.equal(sampler.snapshot().trend.status, 'insufficient-samples');
atMs += 5_000;
const third = sampler.snapshot();
assert.equal(reads, 3);
assert.equal(third.trend.status, 'observed');
assert.equal(third.trend.durationMs, 10_000);
assert.equal(third.trend.slopeBytesPerMinute.rssBytes, 1_200);
assert.equal(third.trend.slopeBytesPerMinute.externalBytes, -12);
assert.equal(third.trend.baseline.rssBytes, 100_100);
third.samples[0].rssBytes = 999;
third.trend.baseline.rssBytes = 999;
assert.equal(sampler.snapshot().samples[0].rssBytes, 100_100, 'callers must not mutate retained samples');

for (let i = 0; i < 100; i += 1) { atMs += 5_000; sampler.snapshot(); }
const bounded = sampler.snapshot();
assert.equal(bounded.samples.length, 60);
assert.equal(bounded.trend.sampleCount, 60);
assert.equal(bounded.trend.baselineAtMs, bounded.samples[0].sampledAtMs);
assert.equal(bounded.trend.durationMs, 59 * 5_000);
assert.match(bounded.interpretation, /not evidence of a memory leak/);
assert.match(bounded.interpretation, /do not measure Windows private commit/);

failed = true;
atMs += 5_000;
const unavailable = sampler.snapshot();
assert.equal(unavailable.available, false);
assert.equal(unavailable.stale, true);
assert.equal(unavailable.samples.length, 60);
assert.equal(unavailable.ageMs, 5_000);
assert.doesNotMatch(JSON.stringify(unavailable), /private-collector-error/);
const failedReadCount = reads;
sampler.snapshot();
assert.equal(reads, failedReadCount, 'failed collection must also be rate limited');
failed = false;
atMs += 5_000;
assert.equal(sampler.snapshot().available, true);
atMs = 1;
assert.equal(sampler.snapshot().samples.length, 1, 'clock rollback starts a fresh measurement baseline');
assert.equal(sampler.snapshot().trend.status, 'insufficient-samples');

const missing = createNodeMemorySampler({ now: () => 0, readMemory: () => ({ rss: NaN, heapUsed: -1 }), readHeap: () => ({}) }).snapshot();
assert.equal(missing.available, false);
assert.equal(missing.current, null);
assert.equal(missing.trend.slopeBytesPerMinute.rssBytes, null);

const host = {
  lanes: { heavy: { limit: 2, active: 1, queued: 3, commandLine: 'must-not-export-command' } },
  pressure: {
    state: 'pressured', reason: 'physical headroom below floor', source: 'windows-memory-status', sampledAtMs: 10_000,
    stale: false, ageMs: 20, physicalAvailableBytes: 1024 ** 3, physicalTotalBytes: 8 * 1024 ** 3,
    commitLimitBytes: 16 * 1024 ** 3, commitUsedBytes: 15 * 1024 ** 3, commitAvailableBytes: 1024 ** 3,
    settlingReservedBytes: 128 * 1024 ** 2, settlingReservationCount: 1, startupSettlingMs: 5_000, oldestSettlingMs: 3_000, settlingReason: 'Awaiting fresh host sample after startup.',
    pagesInputPerSecond: 12.5, pageReadsPerSecond: 3, pagingMeaning: 'Sampled rates; not evidence of sustained thrashing.',
    commitEnforced: true, reservedBytes: 512 * 1024 ** 2, reservationBytes: 512 * 1024 ** 2,
    physicalFloorBytes: 1024 ** 3, commitFloorBytes: 1024 ** 3, error: 'token=redaction-check',
    recentDecisions: Array.from({ length: 40 }, (_, i) => ({ atMs: i, state: 'pressured', reason: 'headroom', commandLine: 'must-not-export-command' }))
  },
  queues: { heavy: { oldestWaitMs: 20_000, blockedReason: 'memory pressure', maxQueued: 32, maxQueuedPerOwner: 8, commandLine: 'must-not-export-command' } }
};
const resources = { host, node: third, caches: { fileReads: { entries: 2, metadataEntries: 3, retainedBytes: 1024, maxRetainedBytes: 32 * 1024 ** 2, evictions: 1, commandLine: 'must-not-export-command' } }, children: { measured: false, reason: 'Child memory is not measured.', commandLine: 'must-not-export-command' } };
const report = buildDiagnosticReport({ resourceDiagnostics: resources });
assert.equal(report.resourceDiagnostics.host.pressure.recentDecisions.length, 20);
assert.equal(report.resourceDiagnostics.node.current.rssBytes, third.current.rssBytes);
assert.doesNotMatch(JSON.stringify(report), /must-not-export-command|redaction-check/);
assert.match(report.reportText, /Commit used \/ limit \/ available/);
assert.match(report.reportText, /Startup settling: 134217728 reserved bytes, 1 reservations/);
assert.equal(report.resourceDiagnostics.host.pressure.pagesInputPerSecond, 12.5);
assert.match(report.reportText, /Pages in \/ disk reads per second: 12.5 \/ 3.0/);
assert.equal(buildDiagnosticReport({ resourceDiagnostics: { host: { pressure: { pagesInputPerSecond: null } } } }).resourceDiagnostics.host.pressure.pagesInputPerSecond, null);
assert.match(report.reportText, /active 1 \/ limit 2, queued 3/);
assert.equal(report.resourceDiagnostics.caches.fileReads.maxRetainedBytes, 32 * 1024 ** 2);
assert.match(report.reportText, /File-read cache: 1024 \/ 33554432 UTF-8 content bytes/);
assert.match(report.reportText, /Observed first-to-last change/);
assert.match(report.reportText, /not evidence of a memory leak/);

const render = value => renderToStaticMarkup(React.createElement(ResourceDiagnostics, { resources: value, onRefresh: () => {} }));
const markup = render(report.resourceDiagnostics);
assert.match(markup, /System resources/);
assert.match(markup, /Memory pressure/);
assert.match(markup, /Commit headroom/);
assert.match(markup, /Heavy commands and checks/);
assert.match(markup, /Minimum heavy-work reservation/);
assert.match(markup, /Startup bytes awaiting resample/);
assert.match(markup, /Awaiting fresh host sample after startup/);
assert.match(markup, /Pages read in \/ second/);
assert.doesNotMatch(markup, /Estimate per heavy task/);
assert.match(markup, /1 \/ 2/);
assert.match(markup, /Current Node process memory/);
assert.match(markup, /External memory/);
assert.match(markup, /File-read cache budget/);
assert.match(markup, /does not measure JavaScript object or string heap overhead/);
assert.match(markup, /RSS change per minute/);
assert.match(markup, /not a leak assessment/);
assert.match(markup, /Full process-family memory: unmeasured/);
assert.match(markup, /Refresh resources/);
assert.match(render(null), /Pressure unknown/);
assert.match(render(null), /Trend unavailable/);
assert.match(render({ host: { pressure: { state: 'normal', stale: true } } }), /Pressure unknown/);
assert.doesNotMatch(render({ host: { pressure: { state: 'normal', stale: true } } }), /Normal pressure/);
assert.match(render({ host: { pressure: { state: 'normal', stale: false, physicalAvailableBytes: 0 } } }), /0\.0 MiB/);


const measuredRoot = (processId, privateBytes, extra = {}) => ({
  processId, pid: 123, workspace: 'fixture', workSessionId: 'work-1', label: processId,
  kind: 'service', lifecycle: 'task', status: 'running', privateBytes, workingSetBytes: privateBytes / 2,
  sampledAt: new Date().toISOString(), identityVerified: true, measurementStatus: 'measured', ...extra
});
const rootResources = {
  managedRoots: { scope: 'managed_roots_only', totalRootCount: 3, cacheAgeMs: 0, stale: false, descendantAttribution: 'unknown', roots: [
    measuredRoot('root-low', 1024 ** 2),
    measuredRoot('root-unknown', 9 * 1024 ** 3, { identityVerified: false, reason: 'identity mismatch', purpose: 'must-not-export-purpose', commandLine: 'must-not-export-command' }),
    measuredRoot('root-high', 4 * 1024 ** 2)
  ] }
};
const rootReport = buildDiagnosticReport({ resourceDiagnostics: rootResources });
assert.equal(rootReport.resourceDiagnostics.managedRoots.roots[1].privateBytes, null, 'unverified identity must never retain attributed bytes');
assert.doesNotMatch(JSON.stringify(rootReport), /must-not-export-purpose|must-not-export-command/);
const rootMarkup = render(rootReport.resourceDiagnostics);
assert.ok(rootMarkup.indexOf('data-managed-root-id="root-high"') < rootMarkup.indexOf('data-managed-root-id="root-low"'));
assert.ok(rootMarkup.indexOf('data-managed-root-id="root-low"') < rootMarkup.indexOf('data-managed-root-id="root-unknown"'));
assert.match(rootMarkup, /Detached descendants remain unknown/);
assert.match(rootMarkup, /Unverified \(recorded running\)/);
assert.doesNotMatch(rootMarkup, /9.00 GiB/);
const staleRootReport = buildDiagnosticReport({ resourceDiagnostics: { managedRoots: { ...rootResources.managedRoots, cacheAgeMs: 5_000 } } });
assert.equal(staleRootReport.resourceDiagnostics.managedRoots.roots[0].privateBytes, null);
assert.equal(staleRootReport.resourceDiagnostics.managedRoots.roots[0].measurementStatus, 'unknown');
assert.match(render(staleRootReport.resourceDiagnostics), /Stale sample/);
const boundedRootReport = buildDiagnosticReport({ resourceDiagnostics: { managedRoots: { ...rootResources.managedRoots, roots: Array.from({ length: 50 }, (_, i) => measuredRoot('root-' + i, i)) } } });
assert.equal(boundedRootReport.resourceDiagnostics.managedRoots.roots.length, 20);

// Public diagnostics can be sampled with no ownership enumeration or new probe.
const live = resourceDiagnosticsSnapshot(hostResourceDiagnosticSnapshot());
assert.equal(live.node.scope, 'current-node-process');
assert.equal(live.node.pid, process.pid);
assert.equal(live.children.measured, false);
assert.ok(live.node.samples.length <= 60);
assert.doesNotThrow(() => buildDiagnosticReport({ resourceDiagnostics: live }));
console.log('Resource diagnostics caching, bounded memory evidence, redaction, and UI rendering passed.');
