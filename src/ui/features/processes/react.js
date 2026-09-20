import React, { memo, useMemo, useState } from 'react';
import { Icon } from '../../components/icons.js';
import { postJson, requestDashboardRefresh } from '../../api.js';
import { processListView } from './index.js';

const h = React.createElement;
const PROCESS_STORE_KEYS = Object.freeze(['managedProcesses', 'nativeTasks']);

export function createProcessesRoute(useDashboardSlices) {
  return function ProcessesRoute() {
    const data = useDashboardSlices(PROCESS_STORE_KEYS);
    const model = useMemo(
      () => processListView(data),
      [data.managedProcesses, data.nativeTasks]
    );
    const count = `${model.running} running${model.finished ? ` · ${model.finished} finished` : ''}`;

    return h('div', { className: 'settings-content system-content', 'data-processes-react': 'true' },
      h('div', { className: 'section processes-page runtime-observability-page' },
        h('div', { className: 'feature-toolbar processes-toolbar' },
          h('p', null, 'Long-running commands appear here until they finish or you stop them.'),
          h('span', { className: 'feature-count' }, count)
        ),
        h('section', { className: 'card processes-card' },
          h('div', { className: 'card-head' },
            h('h3', null, 'Running commands'),
            h('a', { className: 'section-action', href: '#activity' }, 'Activity', h('span', { 'aria-hidden': 'true' }, ' ›'))
          ),
          h('div', { className: 'card-body', 'data-process-list': true },
            model.rows.length
              ? model.rows.map(row => h(ProcessRow, { key: row.processId, row }))
              : h(EmptyProcesses)
          )
        )
      )
    );
  };
}

const ProcessRow = memo(function ProcessRow({ row }) {
  const [stopState, setStopState] = useState('idle');
  const [stopError, setStopError] = useState('');
  const stop = async () => {
    if (stopState === 'loading' || row.stopProcessId == null) return;
    setStopState('loading');
    setStopError('');
    const result = await postJson('/api/processes/stop', { processId: row.stopProcessId, graceMs: 3000 }, { timeout: 10000 });
    if (result?.ok === false) {
      setStopState('error');
      setStopError(String(result.error || 'The command could not be stopped.').slice(0, 320));
      return;
    }
    setStopState('success');
    setStopError('');
    requestDashboardRefresh();
  };
  const stopText = stopState === 'loading' ? 'Stopping…' : stopState === 'success' ? 'Stopped' : stopState === 'error' ? 'Try again' : 'Stop';
  const state = row.state;

  return h('article', {
    className: `process-row${state.active ? ' active' : ''}${state.terminal ? ' terminal' : ''}`,
    'data-process-id': row.processId,
    'aria-label': `${row.label}: ${state.label}`
  },
    h('div', { className: 'process-row-head' },
      h('div', { className: 'process-identity' },
        h('div', { className: 'process-title-line' },
          h('strong', null, row.label),
          h(StatusPill, { label: state.label, tone: state.pillClass })
        ),
        h('div', { className: 'process-meta' },
          h('span', null, row.project),
          row.startedAt ? h('span', null, 'Started ', h('span', { 'data-clock-relative': row.startedAt }, row.startedAgo)) : null,
          state.terminal && row.exitCode != null ? h('span', null, `Exit code ${row.exitCode}`) : null
        )
      ),
      h('div', { className: 'process-actions' },
        h('span', {
          className: 'process-elapsed',
          ...(state.active && row.startedAt ? { 'data-clock-elapsed-start': row.startedAt } : {})
        }, `${state.active ? 'Running for ' : ''}${row.elapsed}`),
        state.canStop ? h('button', {
          className: 'secondary danger',
          type: 'button',
          'data-stop-process': true,
          'data-focus-key': `process-stop-${row.processId}`,
          'aria-label': `Stop ${row.label}`,
          disabled: stopState === 'loading' || stopState === 'success',
          onClick: () => { void stop(); }
        }, stopText) : null,
        state.status === 'stopping' ? h('span', { className: 'process-stop-state', role: 'status' }, 'Stopping…') : null
      )
    ),
    stopError ? h('div', { className: 'connection-notice bad process-stop-error', role: 'alert' },
      h('strong', null, 'Could not stop command'),
      h('div', null, stopError)
    ) : null,
    h('div', { className: 'process-command-summary' }, h('span', null, 'Command'), h('code', null, row.commandSummary)),
    row.error || ['failed', 'orphaned', 'unknown'].includes(state.status)
      ? h('div', { className: `connection-notice ${state.status === 'failed' ? 'bad' : 'warn'} process-recovery` },
          h('strong', null, row.error || state.label),
          h('div', null, state.recovery)
        )
      : null,
    h(ProcessOutput, { output: row.output })
  );
});

function ProcessOutput({ output }) {
  return h('details', { className: 'process-output' },
    h('summary', null, 'Recent output'),
    output.hasOutput
      ? h(React.Fragment, null,
          output.stdout.trim() ? h(OutputBlock, { stream: 'stdout', value: output.stdout }) : null,
          output.stderr.trim() ? h(OutputBlock, { stream: 'stderr', value: output.stderr }) : null
        )
      : h('div', { className: 'process-output-empty', role: 'status' }, output.message)
  );
}

function OutputBlock({ stream, value }) {
  return h('div', { className: 'process-output-block' },
    h('span', null, stream),
    h('pre', { tabIndex: 0, 'aria-label': `Recent ${stream} output` }, String(value || '').trim())
  );
}

function StatusPill({ label, tone = '' }) {
  return h('span', { className: `status-pill ${tone}`.trim() }, label);
}

function EmptyProcesses() {
  return h('div', { className: 'empty-state' },
    h('span', { className: 'empty-state-icon', 'aria-hidden': 'true' }, h(Icon, { name: 'processes', size: 28 })),
    h('strong', { className: 'empty-state-title' }, 'No running commands'),
    h('p', { className: 'empty-state-copy' }, 'Servers, watchers, debuggers, and other long-running commands will appear here.')
  );
}
