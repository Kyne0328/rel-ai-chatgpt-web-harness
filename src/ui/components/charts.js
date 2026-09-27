import React, { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip
} from 'chart.js';
import { color as chartColor } from 'chart.js/helpers';
import { Line } from 'react-chartjs-2';
import { COLOR_THEMES } from '../colorTokens.mjs';

ChartJS.register(CategoryScale, LinearScale, LineElement, PointElement, Filler, Tooltip);

const h = React.createElement;
const LIGHT_FALLBACK = Object.freeze({
  action: COLOR_THEMES.light.actionPrimary,
  border: COLOR_THEMES.light.borderSubtle,
  borderDefault: COLOR_THEMES.light.borderDefault,
  text: COLOR_THEMES.light.textSecondary,
  textMuted: COLOR_THEMES.light.textTertiary,
  surface: COLOR_THEMES.light.surfacePrimary,
  raised: COLOR_THEMES.light.surfaceRaised,
  success: COLOR_THEMES.light.statusSuccessForeground,
  danger: COLOR_THEMES.light.statusDangerForeground,
  warning: COLOR_THEMES.light.statusWarningForeground,
  reducedMotion: false
});

// Read live CSS tokens at import time when a document exists so first-frame
// chart colors match the active theme instead of always flashing light mode.
// Falls back to light tokens during SSR/tests.
function initialChartTheme() {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return LIGHT_FALLBACK;
  try {
    const styles = getComputedStyle(document.documentElement);
    if (!styles?.getPropertyValue) return LIGHT_FALLBACK;
    const token = (name, fallback) => String(styles.getPropertyValue(name) || '').trim() || fallback;
    if (!token('--ui-action-primary', '')) return LIGHT_FALLBACK;
    return Object.freeze({
      action: token('--ui-action-primary', LIGHT_FALLBACK.action),
      border: token('--ui-border-subtle', LIGHT_FALLBACK.border),
      borderDefault: token('--ui-border-default', LIGHT_FALLBACK.borderDefault),
      text: token('--ui-text-secondary', LIGHT_FALLBACK.text),
      textMuted: token('--ui-text-tertiary', LIGHT_FALLBACK.textMuted),
      surface: token('--ui-surface-primary', LIGHT_FALLBACK.surface),
      raised: token('--ui-surface-raised', LIGHT_FALLBACK.raised),
      success: token('--ui-status-success-foreground', LIGHT_FALLBACK.success),
      danger: token('--ui-status-danger-foreground', LIGHT_FALLBACK.danger),
      warning: token('--ui-status-warning-foreground', LIGHT_FALLBACK.warning),
      reducedMotion: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    });
  } catch { return LIGHT_FALLBACK; }
}

const DEFAULT_THEME = initialChartTheme();

export function AnalyticsTimelineChart({
  values = [],
  labels = [],
  detailedLabels = [],
  className = '',
  ariaLabel = '',
  ariaDescribedBy = '',
  valueLabel = 'Value',
  formatValue = value => String(value),
  missingValueLabel = '',
  peakIndex = -1,
  activeIndex = 0,
  onActiveIndexChange = () => {}
}) {
  const data = useMemo(() => safeValues(values), [values]);
  const theme = useChartTheme();
  const chartRef = useRef(null);
  const latestIndex = Math.max(0, lastDefinedIndex(data));
  const firstMeasuredIndex = data.findIndex(value => value !== null);
  const hasLeadingGap = firstMeasuredIndex > 0;
  const accent = theme.action;
  const trailingData = useMemo(() => trailingGapContinuation(data), [data]);
  const missingRanges = useMemo(() => missingValueLabel ? missingValueRanges(data) : [], [data, missingValueLabel]);
  const chartData = useMemo(() => ({
    labels,
    datasets: [{
      data,
      borderColor: accent,
      backgroundColor: withAlpha(accent, 0.08),
      borderWidth: 2,
      cubicInterpolationMode: 'monotone',
      tension: 0.34,
      fill: true,
      spanGaps: false,
      pointRadius: context => context.dataIndex === peakIndex || (hasLeadingGap && context.dataIndex === firstMeasuredIndex) ? 4 : 0,
      pointHoverRadius: 6,
      pointHitRadius: 22,
      pointBackgroundColor: context => context.dataIndex === peakIndex ? theme.warning : accent,
      pointBorderColor: theme.surface,
      pointBorderWidth: 2
    }, ...(trailingData ? [{
      data: trailingData,
      borderColor: withAlpha(accent, 0.5),
      backgroundColor: 'transparent',
      borderWidth: 2,
      borderDash: [4, 4],
      tension: 0,
      fill: false,
      spanGaps: true,
      pointRadius: 0,
      pointHoverRadius: 0,
      pointHitRadius: 0
    }] : [])]
  }), [accent, data, firstMeasuredIndex, hasLeadingGap, labels, peakIndex, theme.surface, theme.warning, trailingData]);
  const options = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: theme.reducedMotion ? false : { duration: 180 },
    interaction: { intersect: false, mode: 'index' },
    layout: { padding: { top: 8, right: 4, bottom: 0, left: 0 } },
    onHover: (_event, elements) => {
      const index = elements?.find(item => item.datasetIndex === 0)?.index;
      if (Number.isInteger(index)) onActiveIndexChange(index);
    },
    plugins: {
      missingDataBands: {
        ranges: missingRanges,
        dataLength: data.length,
        label: missingValueLabel,
        backgroundColor: withAlpha(theme.textMuted, 0.06),
        borderColor: withAlpha(theme.textMuted, 0.22),
        textColor: theme.textMuted
      },
      tooltip: {
        enabled: true,
        displayColors: false,
        backgroundColor: theme.raised,
        borderColor: theme.borderDefault,
        borderWidth: 1,
        titleColor: theme.text,
        bodyColor: theme.text,
        padding: 9,
        filter: item => item.datasetIndex === 0,
        callbacks: {
          title: items => detailedLabels[items?.[0]?.dataIndex] || labels[items?.[0]?.dataIndex] || '',
          label: context => `${valueLabel}: ${formatValue(context.raw == null ? null : Number(context.raw))}`
        }
      }
    },
    scales: {
      x: {
        grid: { display: false },
        border: { color: theme.borderDefault },
        ticks: {
          color: theme.text,
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 4,
          font: { size: 12, weight: 600 }
        }
      },
      y: {
        beginAtZero: true,
        border: { display: false },
        grid: { color: theme.border, lineWidth: 1 },
        ticks: {
          color: theme.text,
          maxTicksLimit: 5,
          padding: 8,
          font: { size: 12, weight: 600 },
          callback: value => formatValue(Number(value) || 0)
        }
      }
    }
  }), [data.length, detailedLabels, formatValue, labels, missingRanges, missingValueLabel, onActiveIndexChange, theme, valueLabel]);

  useEffect(() => {
    activateChartIndex(chartRef.current, activeIndex);
  }, [activeIndex, chartData, options]);

  const selectIndex = index => {
    const next = Math.max(0, Math.min(latestIndex, index));
    onActiveIndexChange(next);
    activateChartIndex(chartRef.current, next);
  };
  const onKeyDown = event => {
    let next = null;
    if (event.key === 'ArrowLeft') next = activeIndex - 1;
    else if (event.key === 'ArrowRight') next = activeIndex + 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End' || event.key === 'Escape') next = latestIndex;
    if (next === null) return;
    event.preventDefault();
    selectIndex(next);
  };

  return h('div', {
    className: ['analytics-chart-group', className].filter(Boolean).join(' '),
    role: 'group',
    tabIndex: 0,
    'aria-label': ariaLabel
      ? `${ariaLabel} Use Left and Right Arrow keys to inspect periods. Home selects the first period and End selects the latest.`
      : 'Analytics chart. Use Left and Right Arrow keys to inspect periods. Home selects the first period and End selects the latest.',
    'aria-describedby': ariaDescribedBy || undefined,
    onFocus: () => selectIndex(Number.isInteger(activeIndex) ? activeIndex : latestIndex),
    onKeyDown
  },
  h(Line, { ref: chartRef, data: chartData, options, plugins: [missingDataBandsPlugin], 'aria-hidden': 'true' }),
  h(AccessibleChartTable, {
    labels: detailedLabels.length ? detailedLabels : labels,
    values: data,
    valueLabel,
    formatValue,
    missingValueLabel
  }));
}

export function AnalyticsBubbleMatrixChart({ cells = [], xLabels = [], yLabels = [], className = '', ariaLabel = 'Activity matrix' }) {
  const bubbleRefs = useRef([]);
  const normalized = useMemo(() => (Array.isArray(cells) ? cells : [])
    .map(cell => ({
      ...cell,
      x: Number(cell?.x),
      y: Number(cell?.y),
      value: Math.max(0, Number(cell?.value) || 0),
      share: Math.max(0, Number(cell?.share) || 0)
    }))
    .filter(cell => Number.isInteger(cell.x) && Number.isInteger(cell.y) && cell.value > 0), [cells]);
  const cellIndex = useMemo(() => new Map(normalized.map((cell, index) => [`${cell.y}:${cell.x}`, index])), [normalized]);
  const maxValue = Math.max(1, ...normalized.map(cell => cell.value));
  const minWidth = Math.max(720, 176 + xLabels.length * 74);

  if (!normalized.length) return null;

  const onBubbleKeyDown = (event, currentIndex) => {
    let next = null;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = normalized.length - 1;
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) next = bubbleNeighborIndex(normalized, currentIndex, event.key);
    if (next == null || next === currentIndex) return;
    event.preventDefault();
    bubbleRefs.current[next]?.focus?.();
  };

  const gridChildren = [
    h('div', { key: 'corner', className: 'analytics-matrix-corner', 'aria-hidden': 'true' }, 'Work type'),
    ...xLabels.map((label, x) => h('div', {
      key: `column-${x}`,
      className: 'analytics-matrix-column-label',
      title: label,
      'aria-hidden': 'true'
    }, h('span', null, label))),
    ...yLabels.flatMap((label, y) => [
      h('div', { key: `row-${y}`, className: 'analytics-matrix-row-label', title: label, 'aria-hidden': 'true' }, label),
      ...xLabels.map((_columnLabel, x) => {
        const index = cellIndex.get(`${y}:${x}`);
        const cell = Number.isInteger(index) ? normalized[index] : null;
        if (!cell) return h('div', { key: `cell-${y}-${x}`, className: 'analytics-matrix-cell', 'aria-hidden': 'true' });
        const workType = cell.intentLabel || yLabels[cell.y] || 'Work type';
        const useCase = cell.useCaseLabel || xLabels[cell.x] || 'Use case';
        const valueText = `${cell.value.toLocaleString()} ${cell.value === 1 ? 'action' : 'actions'}`;
        const shareText = `${formatMatrixShare(cell.share)} of ${workType} activity`;
        return h('div', { key: `cell-${y}-${x}`, className: 'analytics-matrix-cell' },
          h('button', {
            ref: element => { bubbleRefs.current[index] = element; },
            type: 'button',
            className: 'analytics-matrix-bubble',
            style: {
              '--matrix-bubble-size': `${matrixBubbleSize(cell.value, maxValue)}px`,
              '--matrix-bubble-opacity': String(matrixBubbleOpacity(cell.value, maxValue))
            },
            'aria-label': `${workType} × ${useCase}: ${valueText}; ${shareText}`,
            title: `${workType} × ${useCase}: ${valueText}`,
            onKeyDown: event => onBubbleKeyDown(event, index)
          },
          h('span', { className: 'analytics-matrix-tooltip', 'aria-hidden': 'true' },
            h('strong', null, `${workType} × ${useCase}`),
            h('span', null, valueText),
            h('small', null, shareText)
          ))
        );
      })
    ])
  ];

  return h('div', {
    className: ['analytics-chart-group', 'analytics-categorical-matrix', className].filter(Boolean).join(' '),
    role: 'group',
    'aria-label': `${ariaLabel}. Bubble size and intensity represent action count. Tab between populated cells or use arrow keys to move through the matrix.`
  },
  h('div', {
    className: 'analytics-matrix-grid',
    style: {
      '--matrix-columns': String(Math.max(1, xLabels.length)),
      '--matrix-rows': String(Math.max(1, yLabels.length)),
      '--matrix-min-width': `${minWidth}px`
    }
  }, gridChildren),
  h(AccessibleMatrixTable, { cells: normalized, xLabels, yLabels }));
}

function AccessibleMatrixTable({ cells, xLabels, yLabels }) {
  const values = new Map(cells.map(cell => [`${cell.y}:${cell.x}`, cell.value]));
  return h('table', { className: 'sr-only' },
    h('caption', null, 'Work type by use case chart data'),
    h('thead', null, h('tr', null,
      h('th', { scope: 'col' }, 'Work type'),
      xLabels.map((label, index) => h('th', { key: `${label}-${index}`, scope: 'col' }, label))
    )),
    h('tbody', null, yLabels.map((label, y) => h('tr', { key: `${label}-${y}` },
      h('th', { scope: 'row' }, label),
      xLabels.map((_, x) => h('td', { key: `${y}:${x}` }, Number(values.get(`${y}:${x}`) || 0).toLocaleString()))
    )))
  );
}

function bubbleNeighborIndex(cells, currentIndex, key) {
  const current = cells[currentIndex];
  if (!current) return currentIndex;
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
  const direction = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
  const candidates = cells.map((cell, index) => ({ cell, index })).filter(({ cell }) => {
    const delta = horizontal ? cell.x - current.x : cell.y - current.y;
    return delta * direction > 0;
  });
  if (!candidates.length) return currentIndex;
  candidates.sort((left, right) => {
    const primaryLeft = Math.abs((horizontal ? left.cell.x : left.cell.y) - (horizontal ? current.x : current.y));
    const primaryRight = Math.abs((horizontal ? right.cell.x : right.cell.y) - (horizontal ? current.x : current.y));
    const crossLeft = Math.abs((horizontal ? left.cell.y : left.cell.x) - (horizontal ? current.y : current.x));
    const crossRight = Math.abs((horizontal ? right.cell.y : right.cell.x) - (horizontal ? current.y : current.x));
    return crossLeft - crossRight || primaryLeft - primaryRight || left.index - right.index;
  });
  return candidates[0].index;
}

function matrixBubbleSize(value, maxValue) {
  const ratio = Math.max(0, Number(value) || 0) / Math.max(1, Number(maxValue) || 1);
  return Math.round(10 + Math.sqrt(ratio) * 24);
}

function matrixBubbleOpacity(value, maxValue) {
  const ratio = Math.max(0, Number(value) || 0) / Math.max(1, Number(maxValue) || 1);
  return Math.min(1, 0.5 + Math.sqrt(ratio) * 0.5).toFixed(2);
}

function formatMatrixShare(value) {
  const number = Math.max(0, Number(value) || 0);
  return `${number.toFixed(number >= 10 ? 0 : 1)}%`;
}

function AccessibleChartTable({ labels, values, valueLabel, formatValue, missingValueLabel = '' }) {
  return h('table', { className: 'sr-only' },
    h('caption', null, 'Chart data'),
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Time'), h('th', { scope: 'col' }, valueLabel))),
    h('tbody', null, values.map((value, index) => h('tr', { key: `${index}-${labels[index] || ''}` },
      h('td', null, labels[index] || `Period ${index + 1}`),
      h('td', null, value === null && missingValueLabel ? missingValueLabel : formatValue(value))
    )))
  );
}

function activateChartIndex(chart, index) {
  if (!chart || !Number.isInteger(index) || index < 0) return;
  const element = chart.getDatasetMeta?.(0)?.data?.[index];
  if (!element) return;
  const active = [{ datasetIndex: 0, index }];
  chart.setActiveElements?.(active);
  chart.tooltip?.setActiveElements?.(active, { x: element.x, y: element.y });
  chart.update?.('none');
}

const chartThemeListeners = new Set();
let chartThemeCleanup = null;
let chartThemeRevision = 0;

function subscribeChartTheme(listener) {
  chartThemeListeners.add(listener);
  if (chartThemeListeners.size === 1) chartThemeCleanup = observeChartTheme();
  return () => {
    chartThemeListeners.delete(listener);
    if (!chartThemeListeners.size && chartThemeCleanup) {
      chartThemeCleanup();
      chartThemeCleanup = null;
    }
  };
}

function observeChartTheme() {
  if (typeof document === 'undefined') return () => {};
  const refresh = () => {
    chartThemeRevision += 1;
    for (const listener of chartThemeListeners) listener();
  };
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(refresh) : null;
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const media = typeof matchMedia === 'function'
    ? [matchMedia('(prefers-color-scheme: dark)'), matchMedia('(prefers-reduced-motion: reduce)'), matchMedia('(forced-colors: active)')]
    : [];
  for (const query of media) query.addEventListener?.('change', refresh);
  return () => {
    observer?.disconnect();
    for (const query of media) query.removeEventListener?.('change', refresh);
  };
}

function chartThemeSnapshot() {
  return chartThemeRevision;
}

function useChartTheme() {
  const revision = useSyncExternalStore(subscribeChartTheme, chartThemeSnapshot, chartThemeSnapshot);
  return useMemo(() => {
    void revision;
    return readChartTheme();
  }, [revision]);
}

function readChartTheme() {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return DEFAULT_THEME;
  const styles = getComputedStyle(document.documentElement);
  const token = (name, fallback) => String(styles.getPropertyValue(name) || '').trim() || fallback;
  return {
    action: token('--ui-action-primary', DEFAULT_THEME.action),
    border: token('--ui-border-subtle', DEFAULT_THEME.border),
    borderDefault: token('--ui-border-default', DEFAULT_THEME.borderDefault),
    text: token('--ui-text-secondary', DEFAULT_THEME.text),
    textMuted: token('--ui-text-tertiary', DEFAULT_THEME.textMuted),
    surface: token('--ui-surface-primary', DEFAULT_THEME.surface),
    raised: token('--ui-surface-raised', DEFAULT_THEME.raised),
    success: token('--ui-status-success-foreground', DEFAULT_THEME.success),
    danger: token('--ui-status-danger-foreground', DEFAULT_THEME.danger),
    warning: token('--ui-status-warning-foreground', DEFAULT_THEME.warning),
    reducedMotion: typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  };
}

function safeValues(values) {
  return (Array.isArray(values) ? values : []).map(value => {
    if (value == null) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  });
}

function lastDefinedIndex(values) {
  for (let index = values.length - 1; index >= 0; index -= 1) if (values[index] !== null) return index;
  return -1;
}

function trailingGapContinuation(values) {
  const last = lastDefinedIndex(values);
  if (last < 0 || last >= values.length - 1) return null;
  const continuation = new Array(values.length).fill(null);
  continuation[last] = values[last];
  continuation[values.length - 1] = values[last];
  return continuation;
}

function missingValueRanges(values) {
  const ranges = [];
  let start = -1;
  for (let index = 0; index <= values.length; index += 1) {
    if (index < values.length && values[index] === null) {
      if (start < 0) start = index;
      continue;
    }
    if (start >= 0) {
      ranges.push({ start, end: index - 1 });
      start = -1;
    }
  }
  return ranges;
}

const missingDataBandsPlugin = {
  id: 'missingDataBands',
  beforeDatasetsDraw(chart, _args, options) {
    const ranges = Array.isArray(options?.ranges) ? options.ranges : [];
    const dataLength = Math.max(0, Number(options?.dataLength) || 0);
    const xScale = chart?.scales?.x;
    const area = chart?.chartArea;
    if (!ranges.length || !dataLength || !xScale || !area) return;

    const pixel = index => xScale.getPixelForValue(index);
    const ctx = chart.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
    ctx.clip();

    for (const range of ranges) {
      const left = range.start <= 0
        ? area.left
        : (pixel(range.start - 1) + pixel(range.start)) / 2;
      const right = range.end >= dataLength - 1
        ? area.right
        : (pixel(range.end) + pixel(range.end + 1)) / 2;
      const width = Math.max(0, right - left);
      if (!width) continue;

      ctx.fillStyle = options.backgroundColor;
      ctx.fillRect(left, area.top, width, area.bottom - area.top);
      ctx.strokeStyle = options.borderColor;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      for (const edge of [left, right]) {
        ctx.beginPath();
        ctx.moveTo(edge, area.top);
        ctx.lineTo(edge, area.bottom);
        ctx.stroke();
      }

      if (options.label && width >= 96) {
        ctx.setLineDash([]);
        ctx.fillStyle = options.textColor;
        ctx.font = `600 11px ${ChartJS.defaults.font.family}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(options.label, left + width / 2, area.top + 8, width - 12);
      }
    }
    ctx.restore();
  }
};

function withAlpha(color, alpha) {
  const parsed = chartColor(color);
  return parsed.valid ? parsed.alpha(alpha).rgbString() : color;
}
