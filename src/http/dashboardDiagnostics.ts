import { diagnosticResetRequestSchema } from '../contracts/diagnostics.ts';
import { ERROR_CODES, errorPayload } from '../contracts/errors.ts';
import { getDiagnosticsReport, resetDiagnostics } from '../core/diagnostics.ts';
import { readJsonBody, sendJson } from './io.ts';
import type { HttpRouteContext } from './types.ts';

async function handleApiDiagnostics(ctx: HttpRouteContext): Promise<void> {
  const workspace = String(ctx.parsed.searchParams.get('workspace') || '').trim();
  // The route registry authenticates a local dashboard session before this call.
  sendJson(ctx.res, 200, await getDiagnosticsReport(ctx.options, workspace, { includeManagedProcessMemory: true }));
}

async function handleApiDiagnosticsReset(ctx: HttpRouteContext): Promise<void> {
  const payload = await readJsonBody(ctx.req, ctx.options.maxBodyBytes);
  const parsed = diagnosticResetRequestSchema.safeParse(payload);
  if (!parsed.success) {
    sendJson(ctx.res, 400, errorPayload(
      ERROR_CODES.REQUEST_INVALID,
      'Diagnostic reset requires confirm=true and target history, runtime_logs, or analytics.'
    ));
    return;
  }
  const result = await resetDiagnostics(parsed.data.target, ctx.options);
  if (!result.ok) {
    sendJson(ctx.res, 409, errorPayload(result.errorCode, result.error));
    return;
  }
  sendJson(ctx.res, 200, result);
}

export { handleApiDiagnostics, handleApiDiagnosticsReset };
