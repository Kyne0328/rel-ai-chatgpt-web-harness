import React, { useEffect, useState } from 'react';
import { diagnosticDuration, diagnosticTime, operationDiagnostics, runtimeBuildDiagnostics } from '../operation-diagnostics.js';
import { useDeveloperFeatureEnabled } from '../developer-mode-react.js';

import { Tooltip } from './tooltip.js';

const h = React.createElement;

function DiagnosticHelp({ label = 'More information', children }) {
  return h(Tooltip, { content: children, className: 'operation-diagnostics-tooltip' },
    h('button', { type: 'button', className: 'operation-diagnostics-help-trigger', 'aria-label': label }, '?'));
}

export function OperationDiagnostics({ operation, live = false }) {
  const technicalDetailsEnabled = useDeveloperFeatureEnabled('technicalDetails');
  const [wasLive, setWasLive] = useState(live);
  useEffect(() => { if (live) setWasLive(true); }, [live]);
  const announce = live || wasLive;
  const view = operationDiagnostics(operation);
  if (!technicalDetailsEnabled) return null;
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
  const technicalDetailsEnabled = useDeveloperFeatureEnabled('technicalDetails');
  const view = runtimeBuildDiagnostics(runtime, compatibility);
  if (!technicalDetailsEnabled) return null;
  const help = `${view.parityReason} Cached parity applies only to the recorded source snapshot; historical events may have used another build.`;
  const basicFields = new Set(['Build ID', 'Source revision', 'Built at', 'Runtime started']);
  const compatibilityFields = new Set(['Dirty source', 'Release metadata', 'Source/build parity', 'Parity checked']);
  const renderFacts = facts => h('dl', { className: 'operation-diagnostics-facts' }, ...facts.map(([label, value]) => h('div', { key: label },
    h('dt', null, label), h('dd', null, value)
  )));
  return h('details', { className: 'operation-diagnostics runtime-build-identity', 'data-runtime-build-identity': '' },
    h('summary', null, 'Runtime details', h('span', { className: 'runtime-build-summary' }, `Build ${view.buildId.slice(0, 12)}`)),
    h('div', { className: 'runtime-build-content' },
      h('section', null, h('h4', null, 'Current build'),
        renderFacts(view.facts.filter(([label]) => basicFields.has(label)))),
      h('section', null, h('h4', null, 'Source and compatibility'),
        renderFacts(view.facts.filter(([label]) => compatibilityFields.has(label)))),
      h('details', { className: 'runtime-build-identifiers' },
        h('summary', null, 'Technical identifiers'),
        renderFacts(view.facts.filter(([label]) => !basicFields.has(label) && !compatibilityFields.has(label)))),
      h(DiagnosticHelp, { label: 'About runtime details' }, help)
    )
  );
}
