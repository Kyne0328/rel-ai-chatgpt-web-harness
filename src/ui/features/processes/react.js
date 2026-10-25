import React, { memo, useEffect, useMemo, useState } from 'react';
import './styles.css';
import { Icon } from '../../components/icons.js';
import { StatusPill } from '../../components/pill.js';
import { fetchJson, postJson, requestDashboardRefresh } from '../../api.js';
import { confirmAction } from '../../components/confirm-dialog.js';
import { processListView, processStopResult } from './index.js';
import { routeHref } from '../../router.js';

const h = React.createElement;
const PROCESS_STORE_KEYS = Object.freeze(['managedProcesses', 'commandOperations']);
const PROCESS_OUTPUT_CHUNK_BYTES = 256 * 1024;

export function createProcessesRoute(useDashboardSlices) {
  return function ProcessesRoute() {
    const data = useDashboardSlices(PROCESS_STORE_KEYS);
    const sampleKey = JSON.stringify((data.managedProcesses || [])
      .filter(process => ['starting', 'running', 'stopping'].includes(process.status))
      .map(process => [process.processId, process.pid]).sort());
    const processMemory = useProcessMemory(sampleKey);
    const model = useMemo(
      () => processListView({ ...data, processMemory }),
      [data, processMemory]
    );
    const rows = model.rows.filter(row => row.state.active);
    const recoveryRows = model.rows.filter(row => !row.state.terminal && !row.state.active && !row.recoveryArchived);
    const archivedRows = model.rows.filter(row => row.recoveryArchived);
    const recentRows = model.rows.filter(row => row.state.terminal).slice(0, 5);
    const count = `${model.running} running${model.queued ? ` · ${model.queued} queued` : ''}`;
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
        ),
        recoveryRows.length ? h('section', { className: 'card processes-recovery-card', 'aria-labelledby': 'process-recovery-heading' },
          h('div', { className: 'card-head' },
            h('div', null,
              h('h3', { id: 'process-recovery-heading' }, 'Recovery'),
              h('p', null, 'These records need cleanup verification. They are kept separate from active processes until their state can be confirmed.')
            ),
            h('span', { className: 'feature-count' }, `${recoveryRows.length} unresolved`)
          ),
          h('div', { className: 'card-body', 'data-process-recovery-list': true },
            recoveryRows.map(row => h(ProcessRow, { key: row.processId, row }))
          )
        ) : null,
        archivedRows.length ? h('details', { className: 'card recent-processes', 'data-archived-recovery': true },
          h('summary', null, `Archived recovery records · ${archivedRows.length}`),
          h('div', { className: 'recent-process-list' },
            archivedRows.map(row => h(ProcessRow, { key: row.processId, row }))
          )
        ) : null
      )
    );
  };
}

export function useProcessMemory(sampleKey, enabled = true) {
  const [sample, setSample] = useState(null);
  useEffect(() => {
    const timestamps = (sample?.roots || []).map(root => Date.parse(root.sampledAt || '')).filter(Number.isFinite);
    if (!timestamps.length) return undefined;
    const timer = window.setTimeout(() => setSample(null), Math.max(0, Math.min(...timestamps) + 5000 - Date.now()));
    return () => window.clearTimeout(timer);
  }, [sample]);
  useEffect(() => {
    let disposed = false;
    let timer;
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      setSample(null);
      if (disposed || !enabled || document.visibilityState === 'hidden' || sampleKey === '[]') return;
      let delay = 5000;
      try {
        const response = await fetchJson('/api/processes/memory', { cache: 'no-store', pauseTimeoutWhenHidden: false });
        if (disposed || request !== generation || document.visibilityState === 'hidden') return;
        if (response?.ok !== false) {
          setSample(response);
          delay = Math.max(1000, 5000 - Math.max(0, Number(response.cacheAgeMs) || 0));
        }
      } catch { /* Optional measurements do not affect process control. */ }
      finally {
        if (!disposed && request === generation && document.visibilityState !== 'hidden') {
          timer = window.setTimeout(refresh, delay);
        }
      }
    };
    const visibilityChanged = () => {
      window.clearTimeout(timer);
      void refresh();
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    void refresh();
    return () => {
      disposed = true;
      generation += 1;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [sampleKey, enabled]);
  return enabled ? sample : null;
}

export const ProcessRow = memo(function ProcessRow({ row }) {
  const [stopState, setStopState] = useState('idle');
  const [stopError, setStopError] = useState('');
  const [archiveState, setArchiveState] = useState('idle');
  const [archiveError, setArchiveError] = useState('');
  const archive = async () => {
    if (archiveState === 'loading') return;
    const archived = !row.recoveryArchived;
    if (archived && !await confirmAction({ title: 'Archive unresolved record?',
      message: `Archive "${row.label}"?`,
      detail: 'This removes the entry from Recovery. Its logs and unconfirmed cleanup status are retained. It does not stop a process or release an unverified ownership lock. You can restore the record later.',
      confirmLabel: 'Archive record' })) return;
    setArchiveState('loading');
    setArchiveError('');
    try {
      const result = await postJson('/api/processes/recovery', { processId: row.processId, archived, expectedArchivedAt: row.recoveryArchivedAt });
      if (result?.ok === false) throw new Error(result.error || 'Recovery visibility could not be saved.');
      setArchiveState('idle');
    } catch (error) {
      setArchiveState('error');
      setArchiveError(String(error?.message || error));
    } finally { requestDashboardRefresh(); }
  };
  const stop = async () => {
    if (stopState === 'loading' || (row.stopProcessId == null && !row.operationId)) return;
    const confirmed = await confirmAction({
      title: row.operationId ? 'Stop command?' : 'Stop background process?',
      message: 'Are you sure you want to terminate "' + row.label + '"?',
      detail: row.operationId ? 'Stop only this command. Other commands and its task remain open. The status will update when execution settles.' : 'Rel.AI will request a stop, allow up to 3 seconds for a graceful exit, then try to end remaining subprocesses. Unsaved work may be lost. The process status will show whether stopping was confirmed.',
      confirmLabel: row.operationId ? 'Stop command' : 'Stop process',
      danger: true
    });
    if (!confirmed) return;
    setStopState('loading');
    setStopError('');
    try {
      const result = await postJson('/api/processes/stop', row.operationId ? { operationId: row.operationId } : { processId: row.stopProcessId, graceMs: 3000 }, { timeout: 10000 });
      const outcome = row.operationId
        ? { status: result?.ok === false ? 'error' : 'requested', message: result?.ok === false ? result.error || 'Stop could not be requested.' : '' }
        : processStopResult(result);
      setStopState(outcome.status);
      setStopError(outcome.message);
    } catch (error) {
      setStopState('error');
      setStopError(String(error?.message || 'The stop request could not be completed. Check the process status before retrying.').slice(0, 320));
    } finally {
      requestDashboardRefresh();
    }
  };
  const stopText = stopState === 'loading' || stopState === 'requested' ? 'Stopping…' : stopState === 'success' ? 'Stopped' : stopState === 'error' ? 'Try again' : 'Stop';
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
          h(StatusPill, { label: state.label, tone: state.pillClass }),
          row.memory ? h('span', { className: 'process-gauge-badge memory', title: `Root working set · sampled ${row.memory.sampledAt}. Descendants are not included.` }, `RAM ${formatBytes(row.memory.workingSetBytes)}`) : (
            state.active && !row.operationId ? h('span', { className: 'process-gauge-badge', title: 'A current, identity-verified memory reading is unavailable for this process.' }, 'RAM unavailable') : null
          )
        ),
        h('div', { className: 'process-meta' },
          h('span', null, row.project),
          row.operationId ? (row.taskId ? h('a', { href: routeHref('tasks', { workspace: row.project, task: row.taskId }) }, row.taskTitle) : h('span', null, row.taskTitle)) : null,
          row.startedAt ? h('span', null, 'Started ', h('span', { 'data-clock-relative': row.startedAt }, row.startedAgo)) : null,
          state.terminal && row.exitCode != null ? h('span', null, `Exit code ${row.exitCode}`) : null
        )
      ),
      h('div', { className: 'process-actions' },
        h('span', { className: 'process-elapsed' },
          state.active && row.startedAt
            ? h(React.Fragment, null, state.status === 'queued' ? 'Queued for ' : 'Running for ', h('span', { 'data-clock-elapsed-start': row.startedAt }, row.elapsed))
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
          disabled: stopState === 'loading' || stopState === 'success' || stopState === 'requested',
          onClick: () => { void stop(); }
        }, stopText) : null,
        row.canArchiveRecovery || row.recoveryArchived ? h('button', {
          className: 'secondary', type: 'button', 'data-archive-recovery': true,
          'aria-label': `${row.recoveryArchived ? 'Restore' : 'Archive'} ${row.label}`,
          disabled: archiveState === 'loading', onClick: () => { void archive(); }
        }, archiveState === 'loading' ? 'Saving…' : row.recoveryArchived ? 'Restore record' : 'Archive record') : null,
        state.status === 'stopping' ? h('span', { className: 'process-stop-state', role: 'status' }, 'Stopping…') : null
      )
    ),
    stopError && !state.terminal ? h('div', { className: 'connection-notice bad process-stop-error', role: 'alert' },
      h('strong', null, 'Stop not confirmed'),
      h('div', null, stopError)
    ) : null,
    archiveError ? h('div', { className: 'process-output-error', role: 'alert' }, archiveError) : null,
    row.recoveryArchived ? h('div', { className: 'process-output-notice' }, 'Archived record. Cleanup remains unconfirmed; automatic recovery checks and ownership protections remain in effect.') : null,
    h('div', { className: 'process-command-summary' }, h('code', null, row.commandSummary)),
    row.recoveryNote ? h('div', { className: 'process-output-notice', role: 'status' }, row.recoveryNote) : null,
    row.error || ['failed', 'orphaned', 'unknown'].includes(state.status)
      ? h('div', { className: `connection-notice ${state.status === 'failed' ? 'bad' : 'warn'} process-recovery` },
          h('strong', null, row.error || state.label),
          state.recovery !== row.error ? h('div', null, state.recovery) : null
        )
      : null,
    h(ProcessOutput, { processId: row.processId, operationId: row.operationId, output: row.output, active: state.active })
  );
});

function ProcessOutput({ processId, operationId, output, active = false }) {
  const stdoutVisible = output.stdout.trim() || output.stdoutMeta.totalBytes > 0;
  const stderrVisible = output.stderr.trim() || output.stderrMeta.totalBytes > 0;
  return h('details', { className: 'process-output', open: active && output.hasOutput },
    h('summary', null, active ? 'Live output' : 'Recent output'),
    output.hasOutput
      ? h(React.Fragment, null,
          stdoutVisible ? h(OutputBlock, { processId, operationId, stream: 'stdout', value: output.stdout, meta: output.stdoutMeta, active }) : null,
          stderrVisible ? h(OutputBlock, { processId, operationId, stream: 'stderr', value: output.stderr, meta: output.stderrMeta, active }) : null
        )
      : h('div', { className: 'process-output-empty', role: 'status' }, output.message)
  );
}

function OutputBlock({ processId, operationId, stream, value, meta, active }) {
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
      operationId,
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
  }, [history, meta.totalBytes, processId, operationId, stream]);

  const loadEarlier = async () => {
    if (loadingEarlier || !canLoadEarlier) return;
    setLoadingEarlier(true);
    setError('');
    try {
      const range = await readProcessOutputRange(processId, stream, {
        operationId,
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
    h('pre', { tabIndex: 0, 'aria-label': `Recent ${stream} output` }, renderTerminalOutput(visible)),
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

async function readProcessOutputRange(processId, stream, { operationId, offset, beforeOffset, maxBytes }) {
  const params = new URLSearchParams({
    ...(operationId ? { operationId } : { processId }),
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

function map256Color(idx) {
  if (idx === 1 || idx === 9) return 'ansi-red';
  if (idx === 2 || idx === 10) return 'ansi-green';
  if (idx === 3 || idx === 11) return 'ansi-yellow';
  if (idx === 4 || idx === 6 || idx === 12 || idx === 14) return 'ansi-info';
  return null;
}

function renderTerminalOutput(raw) {
  if (raw == null) return [''];
  const text = String(raw)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\[[0-9;?:*]*[ -/]*[@-ln-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  if (!text.trim()) return [''];

  // eslint-disable-next-line no-control-regex
  const sgrRegex = /\x1B\[([0-9;:]*)m/g;
  const elements = [];
  let lastIndex = 0;
  let currentColor = null;
  let isBold = false;
  let key = 0;

  const pushChunk = content => {
    if (!content) return;
    const classes = [];
    if (currentColor) classes.push(currentColor);
    if (isBold) classes.push('ansi-bold');

    if (classes.length > 0) {
      elements.push(h('span', { key: `ansi-${key++}`, className: classes.join(' ') }, content));
    } else {
      elements.push(content);
    }
  };

  let match;
  while ((match = sgrRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      pushChunk(text.slice(lastIndex, match.index));
    }
    lastIndex = sgrRegex.lastIndex;

    const params = match[1] ? match[1].split(';') : ['0'];
    let i = 0;
    while (i < params.length) {
      const param = params[i];
      if (param.includes(':')) {
        const sub = param.split(':').map(s => parseInt(s, 10) || 0);
        const cmd = sub[0];
        if (cmd === 38) {
          if (sub[1] === 5) currentColor = map256Color(sub[2]);
          else if (sub[1] === 2) currentColor = null;
        } else if (cmd === 48) {
          // background extended - skip as a unit
        } else if (cmd === 0) {
          currentColor = null;
          isBold = false;
        }
        i++;
        continue;
      }

      const code = parseInt(param, 10) || 0;
      if (code === 0) {
        currentColor = null;
        isBold = false;
        i++;
      } else if (code === 1) {
        isBold = true;
        i++;
      } else if (code === 22) {
        isBold = false;
        i++;
      } else if (code === 31 || code === 91) {
        currentColor = 'ansi-red';
        i++;
      } else if (code === 32 || code === 92) {
        currentColor = 'ansi-green';
        i++;
      } else if (code === 33 || code === 93) {
        currentColor = 'ansi-yellow';
        i++;
      } else if (code === 34 || code === 36 || code === 94 || code === 96) {
        currentColor = 'ansi-info';
        i++;
      } else if (code === 39 || (code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        // Unmapped foreground colors use the default text color rather than
        // inheriting a previous semantic color such as error red.
        currentColor = null;
        i++;
      } else if (code === 38 || code === 48) {
        const mode = parseInt(params[i + 1], 10) || 0;
        if (mode === 5) {
          const colorIdx = parseInt(params[i + 2], 10) || 0;
          if (code === 38) currentColor = map256Color(colorIdx);
          i += 3;
        } else if (mode === 2) {
          if (code === 38) currentColor = null;
          i += 5;
        } else {
          i++;
        }
      } else {
        i++;
      }
    }
  }

  if (lastIndex < text.length) {
    pushChunk(text.slice(lastIndex));
  }

  return elements.length > 0 ? elements : [''];
}


function EmptyProcesses() {
  return h('div', { className: 'empty-state' },
    h('span', { className: 'empty-state-icon', 'aria-hidden': 'true' }, h(Icon, { name: 'processes', size: 28 })),
    h('strong', { className: 'empty-state-title' }, 'No running commands'),
    h('p', { className: 'empty-state-copy' }, 'Servers, watchers, debuggers, and other long-running commands appear here while they are active.')
  );
}
