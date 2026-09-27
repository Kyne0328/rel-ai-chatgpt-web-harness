import React, { memo } from 'react';
import { statusPillClass } from '../status-tone.js';

const h = React.createElement;

const TONE_TO_PILL_CLASS = Object.freeze({
  danger: 'bad',
  warning: 'warn',
  information: 'working',
  success: 'ok',
  neutral: '',
  bad: 'bad',
  warn: 'warn',
  working: 'working',
  ok: 'ok',
  good: 'ok',
  ready: 'ok',
  info: 'working'
});

export function pillClass(value) {
  return statusPillClass(value);
}

export const StatusPill = memo(function StatusPill({
  label,
  value,
  state,
  tone,
  classOverride = '',
  className = '',
  href,
  children,
  ...props
}) {
  const displayLabel = String(
    children || label || value || (typeof state === 'object' ? state?.label || state?.status : state) || 'Unknown'
  );
  const statusKey = typeof state === 'object' ? state?.status || displayLabel : (state || value || label || displayLabel);
  const rawTone = tone || (typeof state === 'object' && state?.pillClass ? state.pillClass : '');
  const resolvedClass = classOverride || (rawTone ? (TONE_TO_PILL_CLASS[rawTone] ?? rawTone) : statusPillClass(statusKey));
  const fullClassName = ['status-pill', resolvedClass, className].filter(Boolean).join(' ');

  if (href) {
    return h('a', { className: fullClassName, href, ...props }, displayLabel);
  }
  return h('span', { className: fullClassName, ...props }, displayLabel);
});
