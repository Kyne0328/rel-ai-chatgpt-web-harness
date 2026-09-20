import { parentPort, workerData } from 'node:worker_threads';
import { collectTextFiles } from '../safety.js';

try {
  const result = collectTextFiles(workerData.root, workerData.options || {});
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
}
