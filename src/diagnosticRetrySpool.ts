import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJsonFile, writeJsonAtomic } from './durableState.ts';
import { getStateDir } from './stateLayout.js';

// Retain only small, classified failures when a diagnostic batch could not be
// delivered. Full spans, commands, workspace paths and messages are never spooled.
const MAX_RECORDS = 64;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface DiagnosticFailureRecord {
  id: string;
  observedAt: string;
  tool: string;
  code: string;
  category: string;
  outcome: string;
}
interface DiagnosticSpan {
  name: string;
  attributes: Record<string, unknown>;
  status?: { code?: number };
}

function fileFor(config: { stateDir?: string }): string {
  return path.join(getStateDir(config as Record<string, unknown>), 'diagnostic-failure-retry.json');
}

function safeCode(value: unknown): string {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(value) ? value : 'UNCLASSIFIED_ERROR';
}

function safeField(value: unknown, expression: RegExp, fallback: string): string {
  return typeof value === 'string' && expression.test(value) ? value : fallback;
}

export function queuedDiagnosticFailures(config: { stateDir?: string }): DiagnosticFailureRecord[] {
  const stored = readJsonFile<{ records?: DiagnosticFailureRecord[] }>(fileFor(config), {
    validate: value => Boolean(value && typeof value === 'object' && !Array.isArray(value))
  });
  const now = Date.now();
  return (Array.isArray(stored?.records) ? stored.records : [])
    .filter(record => record && typeof record.id === 'string'
      && /^[0-9a-f-]{36}$/i.test(record.id)
      && Number.isFinite(Date.parse(record.observedAt))
      && now - Date.parse(record.observedAt) >= 0
      && now - Date.parse(record.observedAt) <= RETENTION_MS)
    .slice(-MAX_RECORDS);
}

function save(config: { stateDir?: string }, records: DiagnosticFailureRecord[]): void {
  const filename = fileFor(config);
  if (!records.length) {
    try { fs.unlinkSync(filename); } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
    return;
  }
  writeJsonAtomic(filename, { schemaVersion: 1, records: records.slice(-MAX_RECORDS) }, { mode: 0o600 });
}

export function retainFailedDiagnosticBatch(config: { stateDir?: string }, spans: readonly DiagnosticSpan[]): number {
  const additions = spans.filter(span => ['relai.tool.call', 'relai.logical_task.start'].includes(span.name)
    && (span.status?.code === 2 || ['exception', 'failed_result'].includes(String(span.attributes?.['relai.tool.outcome']))))
    .map(span => ({
      id: crypto.randomUUID(),
      observedAt: new Date().toISOString(),
      tool: safeField(span.attributes?.['relai.tool.name'], /^relai_[a-z_]{1,45}$/, 'unknown'),
      code: safeCode(span.attributes?.['relai.error.code']),
      category: safeField(span.attributes?.['relai.error.category'], /^[a-z_]{2,32}$/, 'unclassified'),
      outcome: safeField(span.attributes?.['relai.tool.outcome'], /^(exception|failed_result)$/, 'exception')
    }));
  if (!additions.length) return 0;
  save(config, [...queuedDiagnosticFailures(config), ...additions]);
  return additions.length;
}

export function acknowledgeDiagnosticFailures(config: { stateDir?: string }, ids: readonly string[]): void {
  if (!ids.length) return;
  const completed = new Set(ids);
  const before = queuedDiagnosticFailures(config);
  const after = before.filter(record => !completed.has(record.id));
  if (after.length !== before.length) save(config, after);
}

export function clearQueuedDiagnosticFailures(config: { stateDir?: string }): void {
  save(config, []);
}
