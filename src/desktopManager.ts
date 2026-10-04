import * as fs from 'node:fs';

import { assertComputerControlEnabled } from './computer/computerPolicy.ts';
import {
  assertDesktopClipboardSize,
  normalizeApplication,
  normalizeDesktopUri
} from './contracts/desktopValidation.js';
import { resolveWorkspaceSourcePath } from './workspaceSources.js';

type DesktopWorkspace = {
  alias?: string;
  path?: string;
  sourcePaths?: string[];
};

type DesktopActionArgs = Record<string, unknown> & {
  action?: unknown;
  path?: unknown;
  uri?: unknown;
  application?: unknown;
  text?: unknown;
};

type DesktopActionContext = {
  signal?: AbortSignal;
};

type NativeDesktopResult = Record<string, unknown> | void;
type NativeDesktopBridge = (payload: Record<string, unknown>) => NativeDesktopResult | Promise<NativeDesktopResult>;

let nativeDesktopBridge: NativeDesktopBridge | null = null;

function configureDesktopNativeBridge(bridge: NativeDesktopBridge | null): void {
  if (bridge !== null && typeof bridge !== 'function') throw new TypeError('Desktop native bridge must be a function or null.');
  nativeDesktopBridge = bridge;
}

async function runDesktopAction(
  workspace: DesktopWorkspace,
  config: Record<string, unknown>,
  args: DesktopActionArgs = {},
  context: DesktopActionContext = {}
): Promise<Record<string, unknown>> {
  context.signal?.throwIfAborted?.();
  assertComputerControlEnabled(config);
  const bridge = nativeDesktopBridge;
  if (!bridge) throw new Error('Structured desktop operations require the Rel.AI desktop launcher.');

  const action = String(args.action || '').trim();
  const base = { ok: true, workspace: String(workspace.alias || ''), action };
  let request: Record<string, unknown>;
  let publicResult: Record<string, unknown> = {};

  switch (action) {
    case 'open_path':
    case 'reveal_path': {
      const safe = resolveDesktopPath(workspace, args.path);
      request = { action, path: safe.absolutePath };
      publicResult = { path: safe.relativePath, kind: safe.kind };
      break;
    }
    case 'open_uri': {
      const uri = normalizeDesktopUri(args.uri);
      request = { action, uri };
      publicResult = { uri };
      break;
    }
    case 'launch_application': {
      const application = normalizeApplication(args.application);
      request = { action, application };
      publicResult = { application };
      break;
    }
    case 'clipboard_read':
      request = { action };
      break;
    case 'clipboard_write': {
      const text = normalizeClipboardText(args.text);
      request = { action, text };
      publicResult = { textLength: text.length };
      break;
    }
    default:
      throw new Error(`Unsupported structured desktop action: ${action || '(missing)'}.`);
  }

  const native = objectValue(await bridge(request));
  // Native desktop operations are not cancellable once dispatched. Do not report
  // cancellation after a bridge side effect may already have completed.
  const platform = String(native.platform || '').trim();

  if (action === 'clipboard_read') {
    const text = String(native.text ?? '');
    assertDesktopClipboardSize(text);
    return { ...base, ...(platform ? { platform } : {}), text, textLength: text.length };
  }

  return { ...base, ...(platform ? { platform } : {}), ...publicResult };
}

function resolveDesktopPath(workspace: DesktopWorkspace, value: unknown): {
  absolutePath: string;
  relativePath: string;
  kind: 'file' | 'directory';
} {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Desktop path is required.');
  const safe = resolveWorkspaceSourcePath(workspace, raw, { operation: 'read', label: 'Desktop path' });
  if (!fs.existsSync(safe.absolutePath)) throw new Error(`Desktop path does not exist: ${safe.relativePath}`);
  const stat = fs.statSync(safe.absolutePath);
  if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Desktop path must be a file or directory: ${safe.relativePath}`);
  return {
    absolutePath: safe.absolutePath,
    relativePath: safe.relativePath,
    kind: stat.isDirectory() ? 'directory' : 'file'
  };
}

function normalizeClipboardText(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Clipboard text must be a string.');
  const text = value.replaceAll('\u0000', '');
  assertDesktopClipboardSize(text);
  return text;
}

function objectValue(value: NativeDesktopResult): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export {
  configureDesktopNativeBridge,
  runDesktopAction
};
