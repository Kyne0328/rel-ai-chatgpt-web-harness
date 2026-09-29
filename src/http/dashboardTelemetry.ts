import { telemetrySettingsPatchSchema } from '../contracts/telemetry.ts';
import { getTelemetrySettings, updateTelemetryDiagnosticsEnabled } from '../core/telemetry-settings.ts';
import { readJsonBody, sendJson } from './io.ts';
import type { HttpRouteContext } from './types.ts';

function handleApiTelemetry(ctx: HttpRouteContext): void {
  sendJson(ctx.res, 200, getTelemetrySettings());
}

async function handleApiTelemetryAction(ctx: HttpRouteContext): Promise<void> {
  try {
    const payload = await readJsonBody(ctx.req, ctx.options.maxBodyBytes);
    const parsed = telemetrySettingsPatchSchema.safeParse(payload);
    if (!parsed.success) throw new Error('Diagnostic telemetry enabled must be a boolean.');
    sendJson(ctx.res, 200, await updateTelemetryDiagnosticsEnabled(parsed.data.diagnosticsEnabled));
  } catch (error) {
    sendJson(ctx.res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export { handleApiTelemetry, handleApiTelemetryAction };
