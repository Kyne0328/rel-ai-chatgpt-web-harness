import { z } from 'zod';

export const DIAGNOSTIC_RESET_TARGETS = Object.freeze(['history', 'runtime_logs', 'analytics'] as const);
export type DiagnosticResetTarget = typeof DIAGNOSTIC_RESET_TARGETS[number];
export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface DiagnosticFindingDto {
  severity: DiagnosticSeverity;
  code: string;
  title: string;
  impact: string;
  recommendation: string;
  details?: Record<string, unknown>;
  context?: Record<string, unknown>[];
  action?: { kind?: string; label?: string; href?: string };
  [key: string]: unknown;
}

export interface DiagnosticReportDto {
  ok: true;
  generatedAt: string;
  scope: { workspace: string };
  application: { version: string; build: string };
  summary: Record<string, number>;
  findings: DiagnosticFindingDto[];
  tunnelHealth?: Record<string, unknown> | null;
  logs: Record<string, unknown>;
  reportText: string;
}

export const diagnosticResetRequestSchema = z.object({
  target: z.enum(DIAGNOSTIC_RESET_TARGETS),
  confirm: z.literal(true)
}).passthrough();
