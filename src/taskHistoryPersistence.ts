import type { DatabaseSync } from 'node:sqlite';

type StoredSession = Record<string, unknown> & { id: string };

function upsertTaskHistorySession(db: DatabaseSync, session: StoredSession, updatedAtMs: unknown = Date.now()): { bytes: number; stamp: number } {
  const previous = db.prepare('SELECT updated_at_ms FROM task_history WHERE id=?').get(session.id) as { updated_at_ms?: unknown } | undefined;
  const stamp = Math.max(Math.floor(Number(updatedAtMs) || Date.now()), Number(previous?.updated_at_ms || 0) + 1);
  const payload = JSON.stringify(session);
  db.prepare(`INSERT INTO task_history(id,updated_at_ms,payload) VALUES(?,?,?)
    ON CONFLICT(id) DO UPDATE SET updated_at_ms=excluded.updated_at_ms,payload=excluded.payload`)
    .run(session.id, stamp, payload);
  return { bytes: Buffer.byteLength(payload), stamp };
}

export { upsertTaskHistorySession };
