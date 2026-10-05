import React, { useMemo, useState } from 'react';
import { closeDrawer, openDrawer } from './drawer.js';

const h = React.createElement;

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
