import React from 'react';
import * as Dialog from '@radix-ui/react-dialog';

const h = React.createElement;
const MODAL_SIZES = new Set(['compact', 'standard', 'wide']);

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
