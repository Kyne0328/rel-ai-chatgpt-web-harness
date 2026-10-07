import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { downloadVerifiedFile } from '../src/extensions/registry.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-download-cleanup-'));
const original = { fetch: globalThis.fetch, open: fs.openSync, write: fs.writeSync, rm: fs.rmSync };
const bytes = Buffer.from('small benign stream fixture');
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
try {
  for (const mode of ['success', 'short-write', 'zero-write', 'write-error', 'open-error', 'cancel-error', 'remove-error', 'checksum-error', 'existing-file']) {
    const destination = path.join(root, mode + '.bin');
    if (mode === 'existing-file') fs.writeFileSync(destination, 'preserved existing file');
    let fd, signal, cancelled = false, body, injected = false;
    const failure = Object.assign(new Error('Original exact fixture disk failure'), { code: mode === 'open-error' ? 'EACCES' : 'ENOSPC' });
    globalThis.fetch = async (_url, options) => {
      signal = options.signal;
      body = new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 5));
          controller.enqueue(bytes.subarray(5));
          controller.close();
        },
        cancel() {
          cancelled = true;
          if (mode === 'cancel-error') throw new Error('Secondary fixture cancellation failure');
        }
      }, { highWaterMark: 0 });
      return new Response(body);
    };
    fs.openSync = function(file, ...args) {
      if (path.resolve(String(file)) === destination && mode === 'open-error') {
        injected = true; throw failure;
      }
      const result = original.open.call(fs, file, ...args);
      if (path.resolve(String(file)) === destination) fd = result;
      return result;
    };
    fs.writeSync = function(current, buffer, offset, length, ...args) {
      if (current === fd) {
        if (['write-error', 'cancel-error', 'remove-error'].includes(mode)) { injected = true; throw failure; }
        if (mode === 'zero-write') { injected = true; return 0; }
        if (mode === 'short-write') {
          injected = true;
          return original.write.call(fs, current, buffer, offset, Math.min(2, length), ...args);
        }
      }
      return original.write.call(fs, current, buffer, offset, length, ...args);
    };
    fs.rmSync = function(file, ...args) {
      if (path.resolve(String(file)) === destination && mode === 'remove-error') throw new Error('Secondary cleanup failure');
      return original.rm.call(fs, file, ...args);
    };
    syncBuiltinESMExports();
    let result, error;
    try { result = await downloadVerifiedFile('https://fixture.test/artifact', 1024, 'fixture artifact', destination, mode === 'checksum-error' ? '0'.repeat(64) : sha256); }
    catch (caught) { error = caught; }
    finally { fs.openSync = original.open; fs.writeSync = original.write; fs.rmSync = original.rm; syncBuiltinESMExports(); }
    if (['success', 'short-write'].includes(mode)) {
      assert.equal(error, undefined);
      assert.equal(result.bytes, bytes.length);
      assert.deepEqual(fs.readFileSync(destination), bytes, 'all short writes must be completed');
      assert.equal(signal.aborted, false);
      assert.equal(cancelled, false);
    } else {
      assert.ok(error, mode + ' must reject');
      assert.equal(signal.aborted, true, mode + ' must abort its request');
      if (!['checksum-error'].includes(mode)) assert.equal(cancelled, true, mode + ' must cancel the unread stream');
      if (['write-error', 'open-error', 'cancel-error', 'remove-error'].includes(mode)) {
        assert.equal(error, failure, 'cleanup failures must not replace the original disk error');
        assert.equal(injected, true);
      }
      if (mode === 'zero-write') assert.equal(error.code, 'EIO');
      if (mode === 'existing-file') assert.equal(fs.readFileSync(destination, 'utf8'), 'preserved existing file');
      else if (mode !== 'remove-error') assert.equal(fs.existsSync(destination), false);
    }
    assert.equal(body.locked, false);
    if (fd !== undefined) assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' }, 'download descriptor must be closed');
    console.log(JSON.stringify({ case: mode, succeeded: !error, errorCode: error?.code, requestAborted: signal.aborted, bodyCancelled: cancelled, bodyLocked: body.locked }));
  }
} finally {
  fs.openSync = original.open; fs.writeSync = original.write; fs.rmSync = original.rm; syncBuiltinESMExports();
  globalThis.fetch = original.fetch;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
console.log('Streaming download success, partial writes and error cleanup contracts passed.');
