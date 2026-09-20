import assert from 'node:assert/strict';
import { observeRepeatCall, resetRepeatCallGuard } from '../src/tools/repeatCallGuard.js';
import { OPERATION_IDS as OP } from '../src/tools/operationIds.js';

resetRepeatCallGuard();
const base = { connector: true, taskId: 'task-1', operationName: OP.READ, args: { work_id: 'task-1', workspace: 'app', paths: ['README.md'] }, mutationGeneration: 2 };
assert.equal(observeRepeatCall(base), null);
assert.equal(observeRepeatCall(base), null);
const third = observeRepeatCall(base);
assert.equal(third.count, 3);
assert.match(third.warning, /repeated 3 times/i);

assert.equal(observeRepeatCall({ ...base, mutationGeneration: 3 }), null, 'a task mutation must reset the repeat streak');
assert.equal(observeRepeatCall({ ...base, mutationGeneration: 3, args: { ...base.args, paths: ['package.json'] } }), null, 'a different request must reset the repeat streak');

for (let index = 0; index < 5; index += 1) {
  assert.equal(observeRepeatCall({ connector: true, taskId: 'task-1', operationName: OP.WORK_STATUS, args: { work_id: 'task-1' } }), null, 'status polling must never warn');
  assert.equal(observeRepeatCall({ connector: true, taskId: 'task-1', operationName: OP.PROCESS_READ, args: { work_id: 'task-1', processId: 'proc-1' } }), null, 'process polling must never warn');
  assert.equal(observeRepeatCall({ connector: true, taskId: 'task-1', operationName: OP.WORK_FINISH, args: { work_id: 'task-1', summary: 'done' } }), null, 'idempotent terminal retries must never warn');
  assert.equal(observeRepeatCall({ connector: true, taskId: 'task-1', operationName: OP.WORK_STOP, args: { work_id: 'task-1', operationId: 'op-1' } }), null, 'operation-stop retries must never warn');
  assert.equal(observeRepeatCall({ connector: true, taskId: 'task-1', operationName: OP.WORK_CANCEL, args: { work_id: 'task-1', reason: 'cancel' } }), null, 'idempotent cancellation retries must never warn');
}
assert.equal(observeRepeatCall({ ...base, connector: false }), null, 'non-connector internal calls must not participate in the MCP repeat guard');

resetRepeatCallGuard();
console.log('Exact repeat call advisory guard tests passed.');
