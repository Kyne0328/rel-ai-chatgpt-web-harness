import React, { useMemo } from 'react';

const h = React.createElement;
const VIEWBOX_WIDTH = 100;
const VIEWBOX_HEIGHT = 28;
const PADDING = 2;

export function SparkChart({ values = [], className = '', tone = '', ariaLabel = '', decorative = true }) {
  const points = useMemo(() => sparklinePoints(values), [values]);
  if (!points.length) return null;

  const toneLabel = tone === 'good' ? 'positive trend' : tone === 'bad' ? 'negative trend' : 'trend';
  const roleProps = decorative && !ariaLabel
    ? { 'aria-hidden': 'true' }
    : { role: 'img', 'aria-label': ariaLabel || `Sparkline showing ${toneLabel}` };

  return h('svg', {
    className,
    viewBox: `0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`,
    preserveAspectRatio: 'none',
    focusable: 'false',
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
