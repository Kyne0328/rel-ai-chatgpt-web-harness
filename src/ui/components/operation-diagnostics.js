import React, { useEffect, useState } from 'react';
import { diagnosticDuration, diagnosticTime, operationDiagnostics, runtimeBuildDiagnostics } from '../operation-diagnostics.js';

const h = React.createElement;

export function OperationDiagnostics({ operation, live = false }) {
  const [wasLive, setWasLive] = useState(live);
  useEffect(() => { if (live) setWasLive(true); }, [live]);
  const announce = live || wasLive;
  const view = operationDiagnostics(operation);
  const facts = [
    ['Operation', view.operationId || 'Unknown'],
    ['Current phase', view.phaseLabel],
    ['Phase started', diagnosticTime(view.phaseStartedAt)],
    ['Last progress', diagnosticTime(view.lastProgressAt)],
    ['Blocking owner', view.owner || 'Unknown'],
    ['Blocking operation', view.blockingOperationId || 'Unknown'],
    ['Blocking task', view.blockingTaskId || 'Unknown'],
    ['Queue position', view.queuePosition ?? 'Unknown'],
    ['Deadline kind', view.deadlineKind],
    ['Execution started', view.executed === null ? 'Unknown' : view.executed ? 'Yes' : 'No'],
    ['Child exited', diagnosticTime(view.childExitedAt)],
    ['Process termination', view.terminationCertainty]
  ];
  return h('section', { className: 'operation-diagnostics', 'data-operation-diagnostics': view.phase || 'unknown', 'aria-label': 'Operation diagnostics' },
    // Keep elapsed clocks outside the polite region: announce phase changes, not every second.
    h('div', { role: announce ? 'status' : undefined, 'aria-atomic': announce ? 'true' : undefined },
      h('strong', { className: 'operation-diagnostics-title' }, view.title),
      h('p', null, view.detail),
      view.warning ? h('p', { className: 'operation-diagnostics-warning' }, view.warning) : null
    ),
    h('details', null,
      h('summary', null, 'Timing and ownership'),
      view.currentElapsedMs !== null ? h('p', null, 'Current phase elapsed: ',
        h('span', { 'data-clock-elapsed-start': live ? view.phaseStartedAt : undefined }, diagnosticDuration(view.currentElapsedMs))) : null,
      h('dl', { className: 'operation-diagnostics-facts' }, ...facts.map(([label, value]) => h('div', { key: label },
        h('dt', null, label), h('dd', null, String(value))
      ))),
      h('strong', null, 'Recorded phase durations'),
      view.phases.length ? h('ul', { className: 'operation-phase-durations' }, ...view.phases.map((stage, index) => h('li', {
        key: `${stage.phase}:${stage.startedAt ?? 'unknown'}:${index}`
      }, h('span', null, stage.label), h('span', null, diagnosticDuration(stage.durationMs), stage.endedAt === null && stage.durationMs !== null ? ' so far' : ''))))
        : h('p', null, 'Unknown. This record has no measured phase durations.'),
      view.phasesTruncated ? h('p', null, 'Some recorded stages were omitted from this bounded timeline.') : null,
      h('p', null, 'Elapsed time alone does not identify a stall. Missing measurements are shown as unknown.')
    )
  );
}

export function RuntimeBuildIdentity({ runtime, compatibility }) {
  const view = runtimeBuildDiagnostics(runtime, compatibility);
  return h('details', { className: 'operation-diagnostics runtime-build-identity', 'data-runtime-build-identity': '' },
    h('summary', null, 'Connected runtime (cached): ', view.buildId),
    h('dl', { className: 'operation-diagnostics-facts' }, ...view.facts.map(([label, value]) => h('div', { key: label },
      h('dt', null, label), h('dd', null, value)
    ))),
    h('p', null, view.parityReason),
    h('p', null, 'Cached parity describes the source snapshot at the recorded comparison time. It does not verify every loaded module.'),
    h('p', null, 'Current connection only. Historical operations may have run on a different build.')
  );
}
