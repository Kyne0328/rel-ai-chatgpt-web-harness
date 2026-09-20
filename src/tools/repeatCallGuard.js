import * as crypto from 'node:crypto';
import { LRUCache } from 'lru-cache';
import { stableJson } from '../workflow/contracts.js';
import { OPERATION_IDS as OP } from './operationIds.js';

const REPEAT_WARNING_THRESHOLD = 3;
const MAX_TRACKED_TASKS = 500;
const POLLING_OPERATIONS = new Set([
  OP.WORK_STATUS,
  OP.WORK_STOP,
  OP.WORK_CANCEL,
  OP.WORK_FINISH,
  OP.PROCESS_READ,
  OP.PROCESS_LIST,
  OP.VALIDATE_HTTP
]);
const taskState = new LRUCache({ max: MAX_TRACKED_TASKS });

function observeRepeatCall({ connector = false, taskId = '', operationName = '', args = {}, mutationGeneration = 0 } = {}) {
  const id = String(taskId || '').trim();
  const operation = String(operationName || '').trim();
  if (!connector || !id || !operation || POLLING_OPERATIONS.has(operation)) return null;

  const fingerprint = repeatFingerprint(operation, args);
  const generation = Number(mutationGeneration || 0);
  const previous = taskState.get(id);
  const count = previous?.fingerprint === fingerprint && previous?.mutationGeneration === generation
    ? previous.count + 1
    : 1;
  taskState.set(id, { fingerprint, mutationGeneration: generation, count });

  if (count < REPEAT_WARNING_THRESHOLD) return null;
  return {
    count,
    warning: `This exact Rel.AI request has repeated ${count} times without an intervening task mutation. Reuse the prior result or change approach unless repetition is intentional.`
  };
}

function repeatFingerprint(operationName, args) {
  const publicArgs = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (key === 'work_id' || key.startsWith('_')) continue;
    publicArgs[key] = value;
  }
  return crypto.createHash('sha256')
    .update(`${operationName}\n${stableJson(publicArgs)}`)
    .digest('base64url');
}

function resetRepeatCallGuard() {
  taskState.clear();
}

export { observeRepeatCall, resetRepeatCallGuard };
