import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { closeDrawer, openDrawer } from './drawer.js';

const h = React.createElement;

export function FilterChoice({ label, value, options = [], onChange }) {
  const trigger = useRef(null);
  const menu = useRef(null);
  const [position, setPosition] = useState(null);
  const selected = options.find(option => option.value === value);
  const close = (restore = true) => {
    setPosition(null);
    if (restore) trigger.current?.focus();
  };
  useEffect(() => {
    if (!position) return undefined;
    const outside = event => {
      if (!menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) setPosition(null);
    };
    const resize = () => setPosition(null);
    const scroll = event => { if (!menu.current?.contains(event.target)) setPosition(null); };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    menu.current?.querySelector('[tabindex="0"]')?.focus();
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', resize); };
  }, [position]);
  const open = () => {
    if (position) { close(); return; }
    if (window.matchMedia('(max-width: 639px)').matches) {
      openFilterDrawer({ title: label, value: { choice: value }, resetValue: { choice: options[0]?.value || '' },
        renderFields(fields, draft) { fields.appendChild(filterRadioField({ label, value: draft.choice, options, onChange: next => { draft.choice = next; } })); },
        onApply: draft => onChange(draft.choice) });
      return;
    }
    const rect = trigger.current.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)), top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 180)) });
  };
  return h(React.Fragment, null,
    h('button', { ref: trigger, type: 'button', className: 'secondary filter-choice-trigger', 'aria-label': `${label}: ${selected?.label || label}`,
      'aria-haspopup': 'menu', 'aria-expanded': Boolean(position), onClick: open }, selected?.label || label),
    position ? createPortal(h('div', { ref: menu, className: 'filter-choice-popover', role: 'menu', 'aria-label': label,
      style: { left: position.left, top: position.top, maxHeight: Math.max(80, window.innerHeight - position.top - 8) }, onBlur: event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setPosition(null); },
      onKeyDown: event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll('[role="menuitemradio"]')];
        const index = items.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      } }, options.map(option => h('button', { key: option.value, type: 'button', role: 'menuitemradio',
        'aria-checked': option.value === value, tabIndex: option.value === value ? 0 : -1,
        onClick: () => { onChange(option.value); close(); } }, option.label))), document.body) : null
  );
}

function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

export function openFilterDrawer({
  title = 'Filters',
  value = {},
  resetValue = {},
  renderFields,
  onApply
} = {}) {
  return openDrawer({
    title,
    panelClass: 'filter-drawer',
    content: h(FilterDrawerContent, { value, resetValue, renderFields, onApply })
  });
}

function FilterDrawerContent({ value, resetValue, renderFields, onApply }) {
  const [draft, setDraft] = useState(() => clone(value));
  const [busy, setBusy] = useState(false);
  const fields = useMemo(() => {
    const collected = [];
    const collector = {
      append: (...items) => collected.push(...items.filter(Boolean)),
      appendChild: item => { if (item) collected.push(item); }
    };
    renderFields?.(collector, draft);
    return collected;
  }, [draft, renderFields]);

  const changeField = (field, nextValue) => {
    field.onChange?.(nextValue);
    setDraft(clone(draft));
  };
  const submit = async event => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await onApply?.(clone(draft));
      closeDrawer();
    } catch (error) {
      setBusy(false);
      throw error;
    }
  };

  return h('form', { className: 'filter-drawer-form', onSubmit: submit, 'aria-busy': busy ? 'true' : 'false' },
    h('div', { className: 'filter-drawer-fields' }, fields.map((field, index) => h(FilterField, {
      field,
      key: field.key || `${field.type}-${field.label}-${index}`,
      onChange: value => changeField(field, value)
    }))),
    h('div', { className: 'filter-drawer-footer' },
      h('div', { className: 'filter-drawer-secondary-actions' },
        h('button', { type: 'button', className: 'secondary', disabled: busy, onClick: () => setDraft(clone(resetValue)) }, 'Reset'),
        h('button', { type: 'button', className: 'secondary', disabled: busy, onClick: closeDrawer }, 'Cancel')
      ),
      h('button', { type: 'submit', className: 'primary', disabled: busy }, busy ? 'Applying…' : 'Apply filters')
    )
  );
}

function FilterField({ field, onChange }) {
  const radioId = React.useId();
  const fallbackId = React.useId();
  if (field.type === 'radio') {
    const slug = `filter-${String(field.key || field.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const name = `${slug}-${radioId.replace(/[^a-z0-9]+/gi, '')}`;
    return h('fieldset', { className: 'filter-field filter-radio-field' },
      h('legend', null, field.label),
      h('div', { className: 'filter-radio-options' }, (field.options || []).map(option => h('label', { key: option.value },
        h('input', {
          type: 'radio',
          name,
          value: option.value,
          checked: option.value === field.value,
          onChange: event => { if (event.currentTarget.checked) onChange(event.currentTarget.value); }
        }),
        h('span', null, option.label)
      )))
    );
  }
  const fieldId = `filter-select-${field.key || fallbackId}`;
  return h('label', { className: 'filter-field', htmlFor: fieldId },
    h('span', null, field.label),
    h('select', {
      id: fieldId,
      disabled: field.disabled === true,
      value: field.value,
      'aria-describedby': field.help ? `${fieldId}-help` : undefined,
      onChange: event => onChange(event.currentTarget.value)
    }, (field.options || []).map(option => h('option', { key: option.value, value: option.value }, option.label))),
    field.help ? h('small', { id: `${fieldId}-help` }, field.help) : null
  );
}

export function filterSelectField({ label, value, options, onChange, disabled = false, help = '', key = '' }) {
  return { type: 'select', key, label, value, options: options || [], onChange, disabled, help };
}

export function filterRadioField({ label, value, options, onChange, key = '' }) {
  return { type: 'radio', key, label, value, options: options || [], onChange };
}
