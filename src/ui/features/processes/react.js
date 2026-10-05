import React, { memo, useEffect, useMemo, useState } from 'react';
import './styles.css';
import { Icon } from '../../components/icons.js';
import { StatusPill } from '../../components/pill.js';
import { fetchJson, postJson, requestDashboardRefresh } from '../../api.js';
import { confirmAction } from '../../components/confirm-dialog.js';
import { processListView } from './index.js';

const h = React.createElement;
const PROCESS_STORE_KEYS = Object.freeze(['managedProcesses']);
const PROCESS_OUTPUT_CHUNK_BYTES = 256 * 1024;

export function createProcessesRoute(useDashboardSlices) {
  return function ProcessesRoute() {
    const data = useDashboardSlices(PROCESS_STORE_KEYS);
    const model = useMemo(
      () => processListView(data),
      [data]
    );
    const rows = model.rows.filter(row => !row.state.terminal);
    const attentionCount = rows.filter(row => !row.state.active).length;
    const recentRows = model.rows.filter(row => row.state.terminal).slice(0, 5);
    const count = `${model.running} running${attentionCount ? ` · ${attentionCount} ${attentionCount === 1 ? 'needs' : 'need'} attention` : ''}`;
    const recentLabel = model.finished > recentRows.length
      ? `Recently ended · latest ${recentRows.length}`
      : `Recently ended · ${recentRows.length}`;

    return h('div', { className: 'settings-content system-content', 'data-processes-react': 'true' },
      h('div', { className: 'section processes-page runtime-observability-page' },
        h('section', { className: 'card processes-card' },
          h('div', { className: 'card-head' },
            h('span', { className: 'feature-count' }, count),
            h('a', { className: 'section-action', href: '#activity' }, 'Activity', h(Icon, { name: 'chevronRight', size: 14 }))
          ),
          h('div', { className: 'card-body', 'data-process-list': true },
            rows.length
              ? rows.map(row => h(ProcessRow, { key: row.processId, row }))
              : h(EmptyProcesses)
          ),
          recentRows.length ? h('details', { className: 'recent-processes' },
            h('summary', null, recentLabel),
            h('div', { className: 'recent-process-list' }, recentRows.map(row => h(ProcessRow, { key: row.processId, row })))
          ) : null
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
    const confirmed = await confirmAction({
      title: 'Stop background process?',
      message: 'Are you sure you want to terminate "' + row.label + '"?',
      detail: 'Any running commands or subprocesses associated with this process will be stopped immediately.',
      confirmLabel: 'Stop process',
      danger: true
    });
    if (!confirmed) return;
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
        h('span', { className: 'process-elapsed' },
          state.active && row.startedAt
            ? h(React.Fragment, null, 'Running for ', h('span', { 'data-clock-elapsed-start': row.startedAt }, row.elapsed))
            : h(React.Fragment, null,
                row.elapsed,
                row.endedAt ? ' · ' : null,
                row.endedAt ? h('span', { 'data-clock-relative': row.endedAt }, row.endedAgo) : null
              )
        ),
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
    h('div', { className: 'process-command-summary' }, h('code', null, row.commandSummary)),
    row.error || ['failed', 'orphaned', 'unknown'].includes(state.status)
      ? h('div', { className: `connection-notice ${state.status === 'failed' ? 'bad' : 'warn'} process-recovery` },
          h('strong', null, row.error || state.label),
          h('div', null, state.recovery)
        )
      : null,
    h(ProcessOutput, { processId: row.processId, output: row.output, active: state.active })
  );
});

function ProcessOutput({ processId, output, active = false }) {
  const stdoutVisible = output.stdout.trim() || output.stdoutMeta.totalBytes > 0;
  const stderrVisible = output.stderr.trim() || output.stderrMeta.totalBytes > 0;
  return h('details', { className: 'process-output', open: active && output.hasOutput },
    h('summary', null, active ? 'Live output' : 'Recent output'),
    output.hasOutput
      ? h(React.Fragment, null,
          stdoutVisible ? h(OutputBlock, { processId, stream: 'stdout', value: output.stdout, meta: output.stdoutMeta, active }) : null,
          stderrVisible ? h(OutputBlock, { processId, stream: 'stderr', value: output.stderr, meta: output.stderrMeta, active }) : null
        )
      : h('div', { className: 'process-output-empty', role: 'status' }, output.message)
  );
}

function OutputBlock({ processId, stream, value, meta, active }) {
  const [history, setHistory] = useState(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setHistory(null);
    setLoadingEarlier(false);
    setError('');
  }, [processId, stream]);

  const startOffset = history?.startOffset ?? meta.tailStartOffset;
  const nextOffset = history?.nextOffset ?? meta.totalBytes;
  const visible = history?.text ?? value;
  const canLoadEarlier = startOffset > meta.retainedFromOffset;
  const latestTailOnly = !history && meta.tailTruncated;

  useEffect(() => {
    if (!history || history.nextOffset >= meta.totalBytes) return undefined;
    let cancelled = false;
    const offset = history.nextOffset;
    const remaining = Math.max(0, meta.totalBytes - offset);
    if (!remaining) return undefined;
    void readProcessOutputRange(processId, stream, {
      offset,
      maxBytes: Math.min(PROCESS_OUTPUT_CHUNK_BYTES, remaining)
    }).then(range => {
      if (cancelled) return;
      setHistory(current => {
        if (!current || current.nextOffset !== offset) return current;
        const gapBytes = Math.max(0, Number(range.offset || 0) - current.nextOffset);
        const gap = gapBytes ? `\n[${formatBytes(gapBytes)} of ${stream} output was no longer retained before it could be loaded]\n` : '';
        return {
          ...current,
          text: `${current.text}${gap}${String(range.text || '')}`,
          nextOffset: Number(range.nextOffset || current.nextOffset),
          gap: current.gap || gapBytes > 0
        };
      });
      setError('');
    }).catch(nextError => {
      if (!cancelled) setError(errorMessage(nextError));
    });
    return () => { cancelled = true; };
  }, [history, meta.totalBytes, processId, stream]);

  const loadEarlier = async () => {
    if (loadingEarlier || !canLoadEarlier) return;
    setLoadingEarlier(true);
    setError('');
    try {
      const range = await readProcessOutputRange(processId, stream, {
        beforeOffset: startOffset,
        maxBytes: PROCESS_OUTPUT_CHUNK_BYTES
      });
      setHistory(current => {
        const base = current || {
          text: value,
          startOffset: meta.tailStartOffset,
          nextOffset: meta.totalBytes,
          gap: false
        };
        const rangeStart = Number(range.offset || 0);
        const rangeEnd = Number(range.nextOffset || rangeStart);
        if (rangeStart >= base.startOffset || !range.text) return base;
        const gapBytes = Math.max(0, base.startOffset - rangeEnd);
        const gap = gapBytes ? `\n[${formatBytes(gapBytes)} of ${stream} output is no longer retained]\n` : '';
        return {
          ...base,
          text: `${String(range.text || '')}${gap}${base.text}`,
          startOffset: rangeStart,
          gap: base.gap || gapBytes > 0
        };
      });
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setLoadingEarlier(false);
    }
  };

  const shownBytes = Math.max(0, nextOffset - startOffset);
  return h('div', { className: 'process-output-block' },
    h('div', { className: 'process-output-block-head' },
      h('span', null, stream),
      h('small', null, `${formatBytes(shownBytes)} shown of ${formatBytes(meta.totalBytes)}`)
    ),
    latestTailOnly ? h('div', { className: 'process-output-notice' },
      `Showing the latest ${formatBytes(meta.totalBytes - meta.tailStartOffset)}. Earlier retained output is available.`
    ) : null,
    meta.retentionTruncated ? h('div', { className: 'process-output-notice warning' },
      `The first ${formatBytes(meta.retainedFromOffset)} is no longer retained by Rel.AI.`
    ) : null,
    meta.droppedBytes > 0 ? h('div', { className: 'process-output-notice warning' },
      `${formatBytes(meta.droppedBytes)} was dropped while Rel.AI was capturing this ${stream} stream.`
    ) : null,
    history?.gap ? h('div', { className: 'process-output-notice warning' }, 'A gap in this output could not be recovered from retained logs.') : null,
    error ? h('div', { className: 'process-output-error', role: 'alert' }, error) : null,
    h('pre', { tabIndex: 0, 'aria-label': `Recent ${stream} output` }, formatTerminalOutput(visible).trim()),
    canLoadEarlier ? h('div', { className: 'process-output-actions' },
      h('button', {
        className: 'secondary compact-button',
        type: 'button',
        disabled: loadingEarlier,
        'aria-label': `Load earlier ${stream} output`,
        onClick: () => { void loadEarlier(); }
      }, loadingEarlier ? 'Loading earlier output…' : 'Load earlier output'),
      h('span', null, `${formatBytes(startOffset - meta.retainedFromOffset)} earlier retained`)
    ) : active && history ? h('div', { className: 'process-output-following', role: 'status' }, 'Full retained history loaded · following new output') : null
  );
}

async function readProcessOutputRange(processId, stream, { offset, beforeOffset, maxBytes }) {
  const params = new URLSearchParams({
    processId,
    stream,
    maxBytes: String(maxBytes)
  });
  if (offset !== undefined) params.set('offset', String(offset));
  if (beforeOffset !== undefined) params.set('beforeOffset', String(beforeOffset));
  const result = await fetchJson(`/api/processes/output?${params.toString()}`, { cache: 'no-store', pauseTimeoutWhenHidden: false });
  if (result?.ok === false || !result?.range) throw new Error(result?.error || 'Process output could not be loaded.');
  return result.range;
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Process output could not be loaded.');
}

function formatTerminalOutput(raw) {
  if (raw == null) return '';
  const text = String(raw);
  const stripped = text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B[@-Z\\-_]/g, '');
  return stripped.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}


function EmptyProcesses() {
  return h('div', { className: 'empty-state' },
    h('span', { className: 'empty-state-icon', 'aria-hidden': 'true' }, h(Icon, { name: 'processes', size: 28 })),
    h('strong', { className: 'empty-state-title' }, 'No running commands'),
    h('p', { className: 'empty-state-copy' }, 'Servers, watchers, debuggers, and other long-running commands appear here while they are active.')
  );
}
