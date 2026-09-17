import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createSseWriter } from '../src/http/io.ts';

class FakeResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  blocked = true;
  writes = [];

  write(value) {
    this.writes.push(String(value));
    return !this.blocked;
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
}

const response = new FakeResponse();
const stream = createSseWriter(response, { maxQueuedBytes: 256 });
assert.equal(stream.send('first', { value: 1 }, { id: 'stream:1' }), true);
assert.equal(response.writes.length, 1, 'the first frame should be attempted immediately');
const second = stream.send('second', { value: 2 });
const third = stream.send('third', { value: 3 });
assert.equal(second, true);
assert.equal(third, true);
assert.ok(stream.queuedBytes > 0, 'frames should remain queued while the response is backpressured');

response.blocked = false;
response.emit('drain');
assert.equal(stream.queuedBytes, 0, 'drain should release all queued frames');
assert.deepEqual(response.writes.map(frame => frame.match(/^event: ([^\n]+)/m)?.[1]), ['first', 'second', 'third']);

let overflowNotified = false;
const overflowResponse = new FakeResponse();
const overflowStream = createSseWriter(overflowResponse, {
  maxQueuedBytes: 64,
  onOverflow: () => { overflowNotified = true; }
});
overflowStream.send('first', 'x');
assert.equal(overflowStream.send('large', 'x'.repeat(100)), false);
assert.equal(overflowNotified, true, 'queue overflow should notify the connection owner');
assert.equal(overflowResponse.destroyed, true, 'queue overflow should close a slow response');

console.log('HTTP SSE FIFO, drain, and bounded queue tests passed.');
