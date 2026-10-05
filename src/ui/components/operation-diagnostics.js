import React, { useEffect, useId, useState } from 'react';
import { diagnosticDuration, diagnosticTime, operationDiagnostics, runtimeBuildDiagnostics } from '../operation-diagnostics.js';

const h = React.createElement;

function DiagnosticHelp({ label = 'More information', children }) {
  const [open, setOpen] = useState(false);
  const tooltipId = `operation-diagnostics-help-${useId().replaceAll(':', '')}`;
  return h('span', {
    className: `operation-diagnostics-help${open ? ' is-open' : ''}`,
    onPointerEnter: () => setOpen(true),
    onPointerLeave: () => setOpen(false),
    onFocus: () => setOpen(true),
    onBlur: () => setOpen(false)
  },
  h('button', {
    type: 'button',
    className: 'operation-diagnostics-help-trigger',
    'aria-label': label,
    'aria-describedby': tooltipId,
    'aria-expanded': open ? 'true' : 'false',
    onClick: () => setOpen(value => !value),
    onKeyDown: event => {
      if (event.key === 'Escape') {
        setOpen(false);
        event.stopPropagation();
      }
    }
  }, '?'),
  h('span', { id: tooltipId, role: 'tooltip', className: 'operation-diagnostics-tooltip' }, children));
}

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
      h('div', { className: 'operation-diagnostics-heading' },
        h('strong', { className: 'operation-diagnostics-title' }, view.title),
        view.detail ? h(DiagnosticHelp, { label: `About ${view.title}` }, view.detail) : null
      ),
      view.warning ? h('p', { className: 'operation-diagnostics-warning' }, view.warning) : null
    ),
    h('details', null,
      h('summary', null, 'Details'),
      view.currentElapsedMs !== null ? h('p', null, 'Elapsed: ',
        h('span', { 'data-clock-elapsed-start': live ? view.phaseStartedAt : undefined }, diagnosticDuration(view.currentElapsedMs))) : null,
      h('dl', { className: 'operation-diagnostics-facts' }, ...facts.map(([label, value]) => h('div', { key: label },
        h('dt', null, label), h('dd', null, String(value))
      ))),
      h('strong', null, 'Phase timing'),
      view.phases.length ? h('ul', { className: 'operation-phase-durations' }, ...view.phases.map((stage, index) => h('li', {
        key: `${stage.phase}:${stage.startedAt ?? 'unknown'}:${index}`
      }, h('span', null, stage.label), h('span', null, diagnosticDuration(stage.durationMs), stage.endedAt === null && stage.durationMs !== null ? ' so far' : ''))))
        : h('p', null, 'No phase timing recorded.'),
      view.phasesTruncated ? h('p', null, 'Some stages omitted.') : null
    )
  );
}

export function RuntimeBuildIdentity({ runtime, compatibility }) {
  const view = runtimeBuildDiagnostics(runtime, compatibility);
  const help = `${view.parityReason} Cached parity applies only to the recorded source snapshot; historical events may have used another build.`;
  return h('details', { className: 'operation-diagnostics runtime-build-identity', 'data-runtime-build-identity': '' },
    h('summary', null, 'Runtime: ', view.buildId),
    h('dl', { className: 'operation-diagnostics-facts' }, ...view.facts.map(([label, value]) => h('div', { key: label },
      h('dt', null, label), h('dd', null, value)
    ))),
    h(DiagnosticHelp, { label: 'About runtime details' }, help)
  );
}
