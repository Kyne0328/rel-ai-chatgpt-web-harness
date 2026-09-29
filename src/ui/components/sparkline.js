import React, { useMemo } from 'react';

const h = React.createElement;
const VIEWBOX_WIDTH = 100;
const VIEWBOX_HEIGHT = 28;
const PADDING = 2;

export function SparkChart({
  values = [],
  className = '',
  tone = '',
  ariaLabel = '',
  ariaDescribedBy = '',
  decorative = true,
  interactive = false,
  activeIndex = null,
  onActiveIndexChange = () => {}
}) {
  const points = useMemo(() => sparklinePoints(values), [values]);
  if (!points.length) return null;

  const latestIndex = points.at(-1)?.index || 0;
  const selectedIndex = Number.isInteger(activeIndex)
    ? Math.max(0, Math.min(latestIndex, activeIndex))
    : latestIndex;
  const activePoint = interactive ? points.find(point => point.index === selectedIndex) : null;
  const toneLabel = tone === 'good' ? 'positive trend' : tone === 'bad' ? 'negative trend' : 'trend';
  const roleProps = interactive
    ? {
        role: 'group',
        tabIndex: 0,
        focusable: 'true',
        'aria-label': `${ariaLabel || `Sparkline showing ${toneLabel}`} Use Left and Right Arrow keys to inspect periods. Home selects the first period and End selects the latest.`,
        'aria-describedby': ariaDescribedBy || undefined,
        onFocus: () => onActiveIndexChange(selectedIndex),
        onKeyDown: event => {
          let next = null;
          if (event.key === 'ArrowLeft') next = selectedIndex - 1;
          else if (event.key === 'ArrowRight') next = selectedIndex + 1;
          else if (event.key === 'Home') next = 0;
          else if (event.key === 'End' || event.key === 'Escape') next = latestIndex;
          if (next === null) return;
          event.preventDefault();
          onActiveIndexChange(Math.max(0, Math.min(latestIndex, next)));
        }
      }
    : decorative && !ariaLabel
      ? { focusable: 'false', 'aria-hidden': 'true' }
      : { focusable: 'false', role: 'img', 'aria-label': ariaLabel || `Sparkline showing ${toneLabel}` };

  return h('svg', {
    className,
    viewBox: `0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`,
    preserveAspectRatio: 'none',
    ...roleProps
  },
  h('polyline', {
    className: `sparkline-fill${tone ? ` ${tone}` : ''}`,
    points: fillPoints(points),
    vectorEffect: 'non-scaling-stroke'
  }),
  h('polyline', {
    className: `sparkline-line${tone ? ` ${tone}` : ''}`,
    points: points.map(point => `${point.x},${point.y}`).join(' '),
    vectorEffect: 'non-scaling-stroke'
  }),
  interactive ? hitRegions(values.length, onActiveIndexChange) : null,
  activePoint ? h('line', {
    className: 'sparkline-active-guide',
    x1: activePoint.x,
    x2: activePoint.x,
    y1: PADDING,
    y2: VIEWBOX_HEIGHT - PADDING,
    vectorEffect: 'non-scaling-stroke',
    'aria-hidden': 'true'
  }) : null);
}

function hitRegions(count, onActiveIndexChange) {
  const safeCount = Math.max(1, Number(count) || 0);
  const width = VIEWBOX_WIDTH / safeCount;
  return Array.from({ length: safeCount }, (_, index) => h('rect', {
    key: `sparkline-hit-${index}`,
    x: index * width,
    y: 0,
    width,
    height: VIEWBOX_HEIGHT,
    fill: 'transparent',
    pointerEvents: 'all',
    'aria-hidden': 'true',
    onPointerEnter: () => onActiveIndexChange(index),
    onPointerDown: () => onActiveIndexChange(index)
  }));
}

function sparklinePoints(values) {
  const source = Array.isArray(values) ? values : [];
  const measured = source
    .map((value, index) => ({ value: finiteNonNegative(value), index }))
    .filter(point => point.value !== null);
  if (!measured.length) return [];

  const max = Math.max(...measured.map(point => point.value));
  const min = Math.min(...measured.map(point => point.value));
  const range = Math.max(1, max - min);
  const denominator = Math.max(1, source.length - 1);
  return measured.map(point => ({
    index: point.index,
    value: point.value,
    x: PADDING + ((VIEWBOX_WIDTH - (PADDING * 2)) * point.index / denominator),
    y: PADDING + ((VIEWBOX_HEIGHT - (PADDING * 2)) * (max - point.value) / range)
  }));
}

function fillPoints(points) {
  const baseline = VIEWBOX_HEIGHT - PADDING;
  return [
    `${points[0].x},${baseline}`,
    ...points.map(point => `${point.x},${point.y}`),
    `${points.at(-1).x},${baseline}`
  ].join(' ');
}

function finiteNonNegative(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
