import { readCoreManagedProcessOutput, stopCoreManagedProcess } from '../core/processes.ts';
import { readJsonBody, sendJson } from './io.ts';
import type { HttpRouteContext } from './types.ts';

function handleApiProcessOutput(ctx: HttpRouteContext): void {
  try {
    const processId = String(ctx.parsed.searchParams.get('processId') || '').trim();
    const stream = String(ctx.parsed.searchParams.get('stream') || '').trim();
    if (!processId) throw new Error('processId is required.');
    if (stream !== 'stdout' && stream !== 'stderr') throw new Error('stream must be stdout or stderr.');
    const offset = optionalNonNegativeInteger(ctx.parsed.searchParams.get('offset'), 'offset');
    const beforeOffset = optionalNonNegativeInteger(ctx.parsed.searchParams.get('beforeOffset'), 'beforeOffset');
    if (offset !== undefined && beforeOffset !== undefined) throw new Error('Use offset or beforeOffset, not both.');
    const maxBytes = optionalNonNegativeInteger(ctx.parsed.searchParams.get('maxBytes'), 'maxBytes') ?? 256 * 1024;
    if (maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error('maxBytes must be between 1 and 1048576 bytes.');
    sendJson(ctx.res, 200, readCoreManagedProcessOutput(processId, {
      stream,
      ...(offset !== undefined ? { offset } : {}),
      ...(beforeOffset !== undefined ? { beforeOffset } : {}),
      maxBytes
    }));
  } catch (error) {
    sendJson(ctx.res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleApiProcessStop(ctx: HttpRouteContext): Promise<void> {
  try {
    const payload = await readJsonBody(ctx.req, ctx.options.maxBodyBytes);
    const processId = String(payload.processId || '').trim();
    if (!processId) throw new Error('processId is required.');
    const graceMs = payload.graceMs === undefined ? 3000 : Number(payload.graceMs);
    if (!Number.isFinite(graceMs) || graceMs < 0 || graceMs > 30_000) {
      throw new Error('graceMs must be between 0 and 30000 milliseconds.');
    }
    sendJson(ctx.res, 200, await stopCoreManagedProcess(processId, graceMs));
  } catch (error) {
    sendJson(ctx.res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function optionalNonNegativeInteger(value: string | null, label: string): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer.`);
  return parsed;
}

export { handleApiProcessOutput, handleApiProcessStop };
