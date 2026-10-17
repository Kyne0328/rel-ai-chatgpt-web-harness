// Keep the Electron native browser bridge ready without eagerly loading Playwright.
export type NativeBrowserBridge = (
  payload: Record<string, unknown>,
  options?: Readonly<{ signal?: AbortSignal }>
) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;

let nativeBrowserBridge: NativeBrowserBridge | null = null;

export function configureBrowserNativeBridge(bridge: NativeBrowserBridge | null): void {
  if (bridge !== null && typeof bridge !== 'function') throw new TypeError('Browser native bridge must be a function or null.');
  nativeBrowserBridge = bridge;
}

export function getBrowserNativeBridge(): NativeBrowserBridge | null {
  return nativeBrowserBridge;
}
