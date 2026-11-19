import React from 'react';
import * as Dialog from '@radix-ui/react-dialog';

const h = React.createElement;
const MODAL_SIZES = new Set(['compact', 'standard', 'wide']);


/** Restore keyboard focus only if the closing overlay still owns it. */
export function restoreOverlayFocus(event, opener) {
  const closing = event.currentTarget;
  const outside = element => element instanceof HTMLElement && element.isConnected
    && element !== document.body && element !== document.documentElement
    && !(closing instanceof HTMLElement && closing.contains(element));
  const active = document.activeElement;
  if (outside(active) && !active.matches(':disabled') && !active.closest('[inert], [hidden]')
      && (typeof active.checkVisibility === 'function' ? active.checkVisibility({ visibilityProperty: true })
        : active.getClientRects().length > 0 && getComputedStyle(active).visibility === 'visible')) {
    // A route heading or a newer dialog already received intentional focus.
    event.preventDefault();
    return;
  }
  for (const target of [opener, document.getElementById('pageTitle'), document.getElementById('main')]) {
    if (!outside(target)) continue;
    target.focus({ preventScroll: true });
    // Being connected doesn't mean a disabled or newly hidden opener took focus.
    if (document.activeElement === target) {
      event.preventDefault();
      return;
    }
  }
  // If the document has no usable fallback, leave Radix's default restoration enabled.
}

// A presentation shell only. The owner retains dismissal, async/busy and
// unsaved-change policy, nested confirmations, and initial/return focus hooks.
export function OverlayFrame({
  open = true,
  onOpenChange,
  kind = 'modal',
  size = 'standard',
  className = '',
  backdropProps = {},
  contentProps = {},
  panelProps = {},
  children
}) {
  const drawer = kind === 'drawer';
  const panelClass = drawer ? 'drawer-panel' : `modal-panel modal-${MODAL_SIZES.has(size) ? size : 'standard'}`;
  return h(Dialog.Root, { open, onOpenChange },
    h(Dialog.Portal, null,
      h(Dialog.Overlay, {
        ...backdropProps,
        className: ['overlay-backdrop', drawer ? 'drawer-backdrop' : 'modal-backdrop', backdropProps.className].filter(Boolean).join(' ')
      }),
      h(Dialog.Content, { ...contentProps, asChild: true },
        h('div', {
          ...panelProps,
          className: [panelClass, className, panelProps.className].filter(Boolean).join(' ')
        }, children)
      )
    )
  );
}
