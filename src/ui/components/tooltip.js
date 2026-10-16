import React, { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const h = React.createElement;

// One non-interactive explanation: focus stays on the trigger, including on Escape.
// The body portal escapes scroll containers; viewport measurement supports Chrome 120.
export function Tooltip({ children, content, className = '', id }) {
  const generatedId = useId();
  const tooltipId = id || `ui-tooltip-${generatedId.replaceAll(':', '')}`;
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const triggerRef = useRef(null);
  const tooltipRef = useRef(null);
  const closeTimer = useRef(null);
  const hover = useRef(false);
  const focused = useRef(false);
  const dismissed = useRef(false);
  const pinned = useRef(false);

  const cancelClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const show = () => {
    cancelClose();
    if (!dismissed.current) {
      if (!open) setPosition(null);
      setOpen(true);
    }
  };
  const leave = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (!hover.current && !focused.current) {
        pinned.current = false;
        dismissed.current = false;
        setOpen(false);
      }
    }, 160);
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!open) return undefined;
    const dismiss = event => {
      if (event.key !== 'Escape') return;
      dismissed.current = true;
      pinned.current = false;
      setOpen(false);
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener('keydown', dismiss, true);
    return () => document.removeEventListener('keydown', dismiss, true);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const anchor = triggerRef.current?.getBoundingClientRect();
      const popup = tooltipRef.current?.getBoundingClientRect();
      if (!anchor || !popup) return;
      const viewport = window.visualViewport;
      const leftEdge = viewport?.offsetLeft || 0;
      const topEdge = viewport?.offsetTop || 0;
      const width = viewport?.width || document.documentElement.clientWidth;
      const height = viewport?.height || document.documentElement.clientHeight;
      const margin = 8;
      let clip = { left: leftEdge, top: topEdge, right: leftEdge + width, bottom: topEdge + height };
      for (let ancestor = triggerRef.current.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const rect = ancestor.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) clip = { ...clip, left: Math.max(clip.left, rect.left), right: Math.min(clip.right, rect.right) };
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) clip = { ...clip, top: Math.max(clip.top, rect.top), bottom: Math.min(clip.bottom, rect.bottom) };
      }
      if (anchor.right <= clip.left || anchor.left >= clip.right || anchor.bottom <= clip.top || anchor.top >= clip.bottom) {
        hover.current = false;
        setOpen(false);
        return;
      }
      const left = Math.max(leftEdge + margin, Math.min(anchor.left + (anchor.width - popup.width) / 2, leftEdge + width - popup.width - margin));
      // Touch the trigger edge so a slow pointer transfer never crosses a dead gap.
      const below = anchor.bottom;
      const above = anchor.top - popup.height;
      const top = Math.max(topEdge + margin, Math.min(below + popup.height <= topEdge + height - margin ? below : above, topEdge + height - popup.height - margin));
      setPosition(previous => previous?.left === left && previous?.top === top ? previous : { left, top });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    if (triggerRef.current) observer?.observe(triggerRef.current);
    if (tooltipRef.current) observer?.observe(tooltipRef.current);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
      observer?.disconnect();
    };
  }, [open]);

  const trigger = cloneElement(children, {
    ref: element => {
      triggerRef.current = element;
      const originalRef = children.props.ref;
      if (typeof originalRef === 'function') originalRef(element);
      else if (originalRef) originalRef.current = element;
    },
    'aria-describedby': [children.props['aria-describedby'], tooltipId].filter(Boolean).join(' '),
    onPointerEnter: event => {
      children.props.onPointerEnter?.(event);
      hover.current = true;
      show();
    },
    onPointerLeave: event => {
      children.props.onPointerLeave?.(event);
      hover.current = false;
      leave();
    },
    onFocus: event => {
      children.props.onFocus?.(event);
      focused.current = true;
      dismissed.current = false;
      show();
    },
    onBlur: event => {
      children.props.onBlur?.(event);
      focused.current = false;
      dismissed.current = false;
      leave();
    },
    onClick: event => {
      children.props.onClick?.(event);
      if (event.defaultPrevented) return;
      pinned.current = !pinned.current;
      dismissed.current = !pinned.current;
      if (pinned.current && !open) setPosition(null);
      setOpen(pinned.current);
    }
  });
  const tooltip = h('span', {
    id: tooltipId,
    ref: tooltipRef,
    role: 'tooltip',
    hidden: !open,
    className: `ui-tooltip ${className}`.trim(),
    // Measure at its natural size before revealing a newly opened explanation.
    // This also avoids one frame at the previous anchor after scrolling.
    style: { ...position, visibility: position ? 'visible' : 'hidden' },
    onPointerEnter: () => { hover.current = true; show(); },
    onPointerLeave: () => { hover.current = false; leave(); }
  }, content);
  return h(React.Fragment, null, trigger,
    typeof document === 'undefined' ? tooltip : createPortal(tooltip, document.body));
}
