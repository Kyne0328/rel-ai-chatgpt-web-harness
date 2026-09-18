import assert from 'node:assert/strict';
import path from 'node:path';

import { makeProcessEnvironment, normalizeAllowedKeys } from '../src/processEnvironment.js';

const source = {
  PATH: '/usr/bin',
  HOME: '/home/test',
  GITHUB_TOKEN: 'secret',
  AWS_SECRET_ACCESS_KEY: 'secret',
  CUSTOM_SAFE: 'kept only when allowed',
  NODE_OPTIONS: '--inspect'
};

const safe = makeProcessEnvironment({}, { source });
if (process.platform === 'win32') {
  assert.equal(safe.PATH.split(path.delimiter)[0], path.dirname(process.execPath));
  assert.ok(safe.PATH.split(path.delimiter).includes('/usr/bin'));
} else {
  assert.equal(safe.PATH, '/usr/bin');
}
assert.equal(safe.HOME, '/home/test');
assert.equal(safe.REL_AI_MCP, '1');
assert.equal(safe.GITHUB_TOKEN, undefined);
assert.equal(safe.AWS_SECRET_ACCESS_KEY, undefined);
assert.equal(safe.CUSTOM_SAFE, undefined);
assert.equal(safe.NODE_OPTIONS, undefined);

const allowed = makeProcessEnvironment({}, { source, allow: ['CUSTOM_SAFE', 'GITHUB_TOKEN'] });
assert.equal(allowed.CUSTOM_SAFE, 'kept only when allowed');
assert.equal(allowed.GITHUB_TOKEN, 'secret');

const explicit = makeProcessEnvironment({ API_TOKEN: 'explicit' }, { source });
assert.equal(explicit.API_TOKEN, 'explicit');
assert.throws(() => makeProcessEnvironment({ NODE_OPTIONS: '--inspect' }, { source }), /cannot be passed/);
assert.deepEqual(normalizeAllowedKeys('ONE, TWO THREE'), ['ONE', 'TWO', 'THREE']);

console.log('process environment policy passed');
