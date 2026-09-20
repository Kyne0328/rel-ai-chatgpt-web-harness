import assert from 'node:assert/strict';

import { isExplicitBranchChange } from '../src/tools/execution.js';
import { OPERATION_IDS as OP } from '../src/tools/operationIds.js';

assert.equal(isExplicitBranchChange(OP.EXEC, { executable: 'git', argv: ['reset', '--hard', 'HEAD'] }), true);
assert.equal(isExplicitBranchChange(OP.EXEC, { executable: 'git', argv: ['merge', 'feature'] }), true);
assert.equal(isExplicitBranchChange(OP.EXEC, { executable: 'git', argv: ['rebase', 'main'] }), true);
assert.equal(isExplicitBranchChange(OP.EXEC, { executable: 'git', argv: ['switch', 'feature'] }), true);
assert.equal(isExplicitBranchChange(OP.EXEC, { executable: 'git', argv: ['status', '--short'] }), false);
assert.equal(isExplicitBranchChange(OP.EXEC, { executable: 'git', argv: ['checkout', '--', 'file.txt'] }), false);
assert.equal(isExplicitBranchChange(OP.EXEC, { command: 'git reset --hard HEAD' }), true);
assert.equal(isExplicitBranchChange(OP.EXEC, { command: 'git status --short' }), false);
assert.equal(isExplicitBranchChange(OP.READ, { executable: 'git', argv: ['reset', '--hard', 'HEAD'] }), false);

console.log('Repository-global raw Git mutations use workspace-exclusive classification.');
