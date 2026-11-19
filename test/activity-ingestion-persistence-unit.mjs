import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dashboardTaskSession } from '../src/core/dashboard-runtime.ts';
import { createStdioPrincipal, principalFingerprint } from '../src/mcp/principal.ts';
import { workspaceHistory } from '../src/tools/history.ts';
import { flushAuditWrites, readAudit, safeLogAudit } from '../src/audit.js';
import { getTaskHistoryDir, listRecentSessionEventPage, listSessionSummaryPage, readSession, writeSession } from '../src/taskHistoryStorage.ts';
import { recordTaskIntegrityEvent, readTaskIntegrity } from '../src/taskIntegrity.ts';
import { recordTaskHistoryEvent, flushTaskHistoryPersistence } from '../src/taskHistoryStore.ts';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-identity-persistence-'));
const workspacePath = path.join(stateDir, 'workspace');
fs.mkdirSync(workspacePath);
const config = { stateDir, auditLogPath: path.join(stateDir, 'audit.jsonl'),
  workspaces: { repo: { path: workspacePath, commands: {}, testCommands: {} } } };
const directory = getTaskHistoryDir(config);
const legacy = { ts: '2026-10-05T00:00:00.000Z', workspace: 'repo', taskId: 'legacy',
  taskIdentityVersion: 2, taskIdExplicit: true, taskHistoryEligible: true, tool: 'read', ok: false, error: 'same failure' };
try {
  // Place the same two records at the end of a file larger than the tail budget.
  fs.writeFileSync(config.auditLogPath, `${JSON.stringify({ note: 'x'.repeat(300000) })}\n${JSON.stringify(legacy)}\n${JSON.stringify(legacy)}\n`);
  const tail = readAudit(config, { limit: 2 }).entries;
  const full = readAudit(config, { fullScan: true, limit: 2 }).entries;
  assert.deepEqual(tail.map(event => event.eventId), full.map(event => event.eventId));
  assert.notEqual(tail[0].eventId, tail[1].eventId, 'identical physical audit rows are distinct occurrences');
  for (const event of [...full, ...readAudit(config, { fullScan: true, limit: 2 }).entries]) recordTaskHistoryEvent(config, event);
  await flushTaskHistoryPersistence();
  let stored = readSession(directory, 'legacy');
  assert.equal(stored.calls, 2);
  assert.equal(stored.failures, 2);
  fs.renameSync(config.auditLogPath, `${config.auditLogPath}.1`);
  fs.writeFileSync(config.auditLogPath, '');
  const rotated = readAudit(config, { fullScan: true, limit: 2 }).entries;
  assert.deepEqual(rotated.map(event => event.eventId), tail.map(event => event.eventId), 'rename rotation must preserve import identity');
  for (const event of rotated) recordTaskHistoryEvent(config, event);
  await flushTaskHistoryPersistence();
  stored = readSession(directory, 'legacy');
  assert.equal(stored.calls, 2);

  // Actual ingestion requires authoritative work state; imported history alone
  // must never reconstruct that safety state. Initialize it through the real
  // work-begin integrity path, retaining a deferred (unneeded here) Git baseline.
  await recordTaskIntegrityEvent(config, { ...legacy, taskId: 'fresh', tool: 'work.begin', ok: true, deferBaseline: true });
  assert.equal(readTaskIntegrity(config, 'fresh', 'repo').taskId, 'fresh');
  const fresh = await safeLogAudit(config, { ...legacy, taskId: 'fresh' }, { strictIntegrity: true });
  assert.ok(fresh, 'a valid task audit must reach actual ingestion');
  assert.ok(fresh.eventId && fresh.auditId);
  await flushAuditWrites(config.auditLogPath);
  const diskEntry = fs.readFileSync(config.auditLogPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)).find(entry => entry.taskId === 'fresh');
  assert.equal(diskEntry.eventId, fresh.eventId, 'canonical identity must be written to the physical audit record');
  assert.equal(diskEntry.auditId, fresh.auditId);
  const persisted = readAudit(config, { taskId: 'fresh' }).entries[0];
  assert.equal(persisted.eventId, fresh.eventId);
  recordTaskHistoryEvent(config, { ...persisted });
  await flushTaskHistoryPersistence();
  assert.equal(readSession(directory, 'fresh').calls, 1);

  for (const [id, workspace, principalFingerprint] of [['mine-a', 'repo', 'owner-a'], ['mine-b', 'repo', 'owner-a'], ['other', 'repo', 'owner-b'], ['other-workspace', 'elsewhere', 'owner-a']]) {
    writeSession(directory, { version: 3, id, taskId: id, sessionId: id, workspace, principalFingerprint, status: 'completed',
      events: [{ id: `persisted-${id}`, timestamp: '2026-10-05T01:00:00.000Z', status: 'succeeded' }] });
  }
  const page = listSessionSummaryPage(directory, { workspace: 'repo', principalFingerprint: 'owner-a', limit: 1, includeCursors: true });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].principalFingerprint, 'owner-a');
  assert.deepEqual(page.items[0]._pageCursor, page.cursor);
  const next = listSessionSummaryPage(directory, { workspace: 'repo', principalFingerprint: 'owner-a', cursor: page.items[0]._pageCursor, includeCursors: true });
  assert.equal(next.items.length, 1);
  assert.notEqual(page.items[0].id, next.items[0].id);
  const activity = listRecentSessionEventPage(directory, { workspace: 'repo', principalFingerprint: 'owner-a', limit: 1, includeCursors: true });
  assert.equal(activity.items.length, 1);
  assert.deepEqual(activity.items[0]._pageCursor, activity.cursor);
  assert.match(activity.items[0].eventId, /^persisted-mine-/);
  const activityNext = listRecentSessionEventPage(directory, { workspace: 'repo', principalFingerprint: 'owner-a', cursor: activity.items[0]._pageCursor });
  assert.equal(activityNext.items.length, 1);
  assert.notEqual(activityNext.items[0].eventId, activity.items[0].eventId);

  // Imported activity can lack a clock time. SQLite sorts those rows last;
  // '' must round-trip as a real cursor position on both public read paths.
  const principal = createStdioPrincipal();
  const taskId = 'untimed-history';
  writeSession(directory, { id: taskId, workspace: 'repo', principalFingerprint: principalFingerprint(principal),
    status: 'completed', events: [{ eventId: 'oldest-index' }, { eventId: 'newer-index' },
      { eventId: 'dated', timestamp: '2026-10-05T01:00:00.000Z' }] });
  const configPath = path.join(stateDir, 'fixture-config.json');
  const previousConfig = process.env.REL_AI_MCP_CONFIG;
  fs.writeFileSync(configPath, JSON.stringify({ ...config, version: 7 }));
  process.env.REL_AI_MCP_CONFIG = configPath;
  try {
    for (const read of [
      cursor => {
        const page = workspaceHistory(config, { workspace: 'repo', kind: 'activity', taskId, limit: 1, cursor }, { principal });
        return [page.entries, page.cursor, page.hasMore];
      },
      cursor => {
        const { entries, page } = dashboardTaskSession(taskId, { activityLimit: 1, activityOnly: true, activityCursor: cursor }).activity;
        return [entries, page.nextCursor, page.hasMore];
      }
    ]) {
      let cursor;
      for (const [id, more] of [['dated', true], ['newer-index', true], ['oldest-index', false]]) {
        const [entries, next, hasMore] = read(cursor);
        assert.deepEqual([entries.map(event => event.eventId), hasMore], [[id], more], 'dated and untimed activity must page exactly once and terminate');
        cursor = next;
      }
      assert.deepEqual(read(cursor)[0], []);
    }
  } finally {
    if (previousConfig === undefined) delete process.env.REL_AI_MCP_CONFIG;
    else process.env.REL_AI_MCP_CONFIG = previousConfig;
  }

  console.log('Audit ingestion, full/tail/rotation replay, durable counters, scoped history and per-row continuation cursors passed.');
} finally {
  await flushAuditWrites(config.auditLogPath);
  await flushTaskHistoryPersistence();
  fs.rmSync(stateDir, { recursive: true, force: true });
}
