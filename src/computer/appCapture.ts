import type { ComputerAppImage, ComputerPixelProvenance } from './midsceneAdapter.ts';
import { normalizeAppName } from './computerPolicy.ts';

export function appCaptureUnavailable(reason = 'This runtime cannot establish app-only pixel provenance.'): Error & { code: string; retryable: boolean; requiresUserConfirmation: boolean } {
  return Object.assign(new Error(`${reason} No display capture was used. Try structured app observation, or use a supported visible application window.`), {
    code: 'COMPUTER_APP_CAPTURE_UNAVAILABLE', retryable: false, requiresUserConfirmation: false
  });
}

export function appInputTargetUnverified(): Error & { code: string; retryable: boolean; requiresUserConfirmation: boolean } {
  return Object.assign(new Error('The observed application window no longer owns the input target, or its ownership could not be verified. No input was sent. Expose the approved window, take a new observation, and retry.'), {
    code: 'COMPUTER_INPUT_TARGET_UNVERIFIED', retryable: false, requiresUserConfirmation: false
  });
}

export function validateAppPixelProvenance(value: unknown, app: string, displayId?: string, requestedAt = Date.now() - 10_000): ComputerPixelProvenance {
  const source = value as Partial<ComputerPixelProvenance> | null;
  if (!source || source.scope !== 'app-window' || !['win32-print-window', 'windows-graphics-capture'].includes(String(source.method))
      || normalizeAppName(source.app) !== normalizeAppName(app)
      || !/^[1-9][0-9]*$/.test(String(source.windowId || ''))
      || !Number.isSafeInteger(source.processId) || Number(source.processId) <= 0
      || !/^[1-9][0-9]*$/.test(String(source.processStartedAt || ''))
      || !source.displayId || (displayId && source.displayId !== displayId)
      || source.coordinateSpace !== 'window-local-pixels'
      || !Number.isSafeInteger(source.originX) || !Number.isSafeInteger(source.originY)
      || ((Number(source.originX) < 0 || Number(source.originY) < 0) && source.inputMappingReliable !== false)
      || (source.method === 'windows-graphics-capture' && (!Number.isFinite(source.frameQpc100ns) || !Number.isFinite(source.requestQpc100ns) || Number(source.requestQpc100ns) <= 0 || Number(source.frameQpc100ns) < Number(source.requestQpc100ns)))
      || !Number.isFinite(source.capturedAt) || Number(source.capturedAt) < requestedAt - 1000
      || Number(source.capturedAt) > Date.now() + 1000) {
    throw appCaptureUnavailable('Application window identity, display, coordinates, or capture freshness could not be verified.');
  }
  return Object.freeze({ ...source }) as ComputerPixelProvenance;
}

export function validateAppImage(value: unknown, app: string, displayId?: string, requestedAt?: number): ComputerAppImage {
  const image = value as Partial<ComputerAppImage> | null;
  const provenance = validateAppPixelProvenance(image?.provenance, app, displayId, requestedAt);
  if (!image || image.mimeType !== 'image/png' || !image.data
      || !Number.isSafeInteger(image.width) || Number(image.width) <= 0 || Number(image.width) > 8192
      || !Number.isSafeInteger(image.height) || Number(image.height) <= 0 || Number(image.height) > 8192
      || Number(image.width) * Number(image.height) > 16777216
      || !Number.isSafeInteger(image.bytes) || Number(image.bytes) <= 0 || Number(image.bytes) > 4194304
      || Buffer.byteLength(image.data, 'base64') !== image.bytes) {
    throw appCaptureUnavailable('Application image did not satisfy the bounded native-capture contract.');
  }
  return { ...image, provenance } as ComputerAppImage;
}
