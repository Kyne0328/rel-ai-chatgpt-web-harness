import { parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

import { withStateDatabase } from './stateDatabase.ts';
import { upsertTaskHistorySession } from './taskHistoryPersistence.ts';

if (!parentPort) throw new Error('Task history storage worker requires a parent port.');

parentPort.on('message', message => {
  const id = Number(message?.id || 0);
  const started = performance.now();
  try {
    const result = withStateDatabase({ stateDir: String(message.stateDir || '') }, db =>
      upsertTaskHistorySession(db, message.session, message.updatedAtMs), { transaction: true });
    parentPort.postMessage({
      id,
      ok: true,
      bytes: Number(result?.bytes || 0),
      durationMs: performance.now() - started
    });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: {
        message: error instanceof Error ? error.message : String(error || 'Task history write failed.'),
        code: error && typeof error === 'object' && 'code' in error ? String(error.code || '') : ''
      },
      durationMs: performance.now() - started
    });
  }
});
