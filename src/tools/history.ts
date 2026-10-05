import { createHash } from 'node:crypto';
import { getTaskHistoryDir, listSessionSummaryPage, listRecentSessionEventPage } from '../taskHistoryStorage.ts';
import type { SessionPageCursor, EventPageCursor } from '../taskHistoryStorage.ts';
import { principalFingerprint, principalForContext } from '../mcp/principal.ts';
import { assertAuthorizedToolCall } from '../mcp/authorizationPolicy.ts';
import { boundResponsePayload, responseByteLimit, utf8Head } from './responseBudget.js';
import { OPERATION_IDS as OP } from './operationIds.js';

type HistoryArgs = { workspace: string; kind?: 'tasks' | 'activity'; taskId?: string; limit?: number; cursor?: string; maxResponseBytes?: number };
type HistoryRecord = Record<string, any>;
type HistoryContext = { principal?: any; connector?: boolean };
interface HistoryTask { work_id: string; workspace: string; title: string; status: string; updatedAt: string; startedAt: string; endedAt: string; cursor: string; }
interface HistoryActivity { eventId: string; operationId: string; work_id: string; workspace: string; timestamp: string; tool: string; status: string; summary: string; errorCode: string; cursor: string; }

function workspaceHistory(config: Record<string, any>, args: HistoryArgs, context: HistoryContext = {}) {
  const workspace = String(args.workspace || '').trim();
  if (!workspace) throw historyError('Workspace is required for history.');
  const identity = principalForContext(context, context.connector === true);
  assertAuthorizedToolCall({ principal: identity, operationName: OP.WORK_HISTORY, workspace });
  const principal = principalFingerprint(identity);
  const kind = args.kind === 'activity' ? 'activity' : 'tasks';
  if (args.taskId && kind !== 'activity') throw historyError('taskId applies to kind activity. Omit taskId to list task summaries.');
  const scope = createHash('sha256').update(JSON.stringify([workspace, principal, kind, args.taskId || ''])).digest('base64url');
  const cursor = decodeCursor(args.cursor, scope, kind);
  const options = { workspace, principalFingerprint: principal, limit: Math.min(100, Math.max(1, Number(args.limit) || 20)), includeCursors: true };
  const directory = getTaskHistoryDir(config);
  if (kind === 'activity') {
    const page = listRecentSessionEventPage(directory, { ...options, ...(args.taskId ? { taskId: args.taskId } : {}), cursor: cursor as EventPageCursor | null });
    const entries: HistoryActivity[] = page.items.map((row: HistoryRecord) => ({
      eventId: short(row.eventId || row.id), operationId: short(row.operationId), work_id: short(row.taskId), workspace,
      timestamp: short(row.timestamp || row.at), tool: short(typeof row.tool === 'object' ? row.tool?.name : row.tool), status: short(row.status),
      summary: utf8Head(row.summary || row.title || '', 600), errorCode: short(row.errorCode || row.metadata?.errorCode),
      cursor: encodeCursor(row._pageCursor, scope)
    }));
    return boundResponsePayload({ ok: true, workspace, kind, entries, cursor: encodeCursor(page.cursor, scope), hasMore: page.hasMore }, responseByteLimit(args.maxResponseBytes) - 1024);
  }
  const page = listSessionSummaryPage(directory, { ...options, cursor: cursor as SessionPageCursor | null });
  const tasks: HistoryTask[] = page.items.map((row: HistoryRecord) => ({
    work_id: short(row.id || row.taskId), workspace, title: utf8Head(row.title || '', 400), status: short(row.status),
    updatedAt: short(row.updatedAt || row.lastActivityAt), startedAt: short(row.startedAt), endedAt: short(row.endedAt),
    cursor: encodeCursor(row._pageCursor, scope)
  }));
  return boundResponsePayload({ ok: true, workspace, kind, tasks, cursor: encodeCursor(page.cursor, scope), hasMore: page.hasMore }, responseByteLimit(args.maxResponseBytes) - 1024);
}
function short(value: unknown): string { return utf8Head(value == null ? '' : String(value), 200); }
function encodeCursor(cursor: unknown, scope: string): string { return cursor ? Buffer.from(JSON.stringify({ scope, cursor })).toString('base64url') : ''; }
function decodeCursor(value: string | undefined, scope: string, kind: string): SessionPageCursor | EventPageCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const c = parsed?.cursor;
    if (parsed.scope !== scope || !c || typeof c !== 'object') throw new Error();
    if (kind === 'tasks' && typeof c.id === 'string' && Number.isFinite(c.updatedAtMs) && c.updatedAtMs > 0) return c;
    if (kind === 'activity' && typeof c.taskId === 'string' && typeof c.eventTimestamp === 'string' && Number.isFinite(c.taskUpdatedAtMs) && c.taskUpdatedAtMs > 0 && Number.isInteger(c.eventIndex) && c.eventIndex >= 0) return c;
  } catch {}
  throw historyError('Invalid history cursor for this principal, workspace, kind, or taskId. Start a new history page without cursor.');
}
function historyError(message: string) { return Object.assign(new Error(message), { code: 'INVALID_HISTORY_REQUEST', retryable: true }); }
export { workspaceHistory };
