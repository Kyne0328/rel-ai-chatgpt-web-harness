import { readConfig, writeConfig } from '../config.js';
import { setTelemetryDiagnosticsEnabled, telemetryStatus } from '../telemetry.js';

function telemetrySettings(config = readConfig()): Record<string, unknown> {
  const status = telemetryStatus(config);
  return {
    usageReportingRequired: true,
    usageReportingConfigured: status.usageReportingEnabled === true,
    usageReportingActive: status.usageInitialized === true,
    usageLastAttemptAt: status.usageLastAttemptAt,
    usageLastSuccessAt: status.usageLastSuccessAt,
    usageLastFailureAt: status.usageLastFailureAt,
    diagnosticsEnabled: config.telemetry?.diagnosticsEnabled !== false,
    diagnosticsActive: status.initialized === true,
    diagnosticsLastAttemptAt: status.diagnosticsLastAttemptAt,
    diagnosticsLastSuccessAt: status.diagnosticsLastSuccessAt,
    diagnosticsLastFailureAt: status.diagnosticsLastFailureAt,
    endpointConfigured: status.endpointConfigured === true,
    sampleRatio: status.sampleRatio
  };
}

export function getTelemetrySettings(): Record<string, unknown> {
  return { ok: true, settings: telemetrySettings() };
}

export async function updateTelemetryDiagnosticsEnabled(enabled: boolean): Promise<Record<string, unknown>> {
  const current = readConfig();
  const next = structuredClone(current);
  next.telemetry = {
    ...current.telemetry,
    diagnosticsEnabled: enabled === true
  };
  const config = writeConfig(next);
  await setTelemetryDiagnosticsEnabled(config, enabled);
  return { ok: true, settings: telemetrySettings(config) };
}
