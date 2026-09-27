function clipBrowserSurfaceBounds(rect, viewportWidth, viewportHeight) {
  const width = Math.max(0, Math.round(Number(viewportWidth) || 0));
  const height = Math.max(0, Math.round(Number(viewportHeight) || 0));
  const left = Number(rect?.left);
  const top = Number(rect?.top);
  const right = Number(rect?.right);
  const bottom = Number(rect?.bottom);
  if (![left, top, right, bottom].every(Number.isFinite) || width < 1 || height < 1) return { visible: false };

  const x = Math.max(0, Math.round(left));
  const y = Math.max(0, Math.round(top));
  const clippedRight = Math.min(width, Math.round(right));
  const clippedBottom = Math.min(height, Math.round(bottom));
  if (clippedRight <= x || clippedBottom <= y) return { visible: false };

  return {
    visible: true,
    x,
    y,
    width: clippedRight - x,
    height: clippedBottom - y
  };
}

async function releaseBrowserRouteControl(browser) {
  if (typeof browser?.setControl !== 'function') return false;
  try {
    await browser.setControl('ai');
    return true;
  } catch {
    return false;
  }
}

export { clipBrowserSurfaceBounds, releaseBrowserRouteControl };
