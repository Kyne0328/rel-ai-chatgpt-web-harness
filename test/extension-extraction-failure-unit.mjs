import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

if (process.argv[2] !== 'worker') {
  for (const failure of ['open', 'write', 'kill-no-close', 'timeout-no-close']) {
    const result = childProcess.spawnSync(process.execPath, [
      ...process.execArgv, fileURLToPath(import.meta.url), 'worker', failure
    ], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, `${failure}: ${result.stderr || result.stdout || result.error}`);
    assert.match(result.stdout, /Extraction failure rejected after output close/);
  }
} else {
  const failure = process.argv[3];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-extraction-failure-'));
  const archive = path.join(root, 'fixture.tar.xz');
  const originalSpawn = childProcess.spawn;
  const originalCreateWriteStream = fs.createWriteStream;
  let killed = false;
  let outputClosed = false;
  let killSignal;
  const originalSetTimeout = globalThis.setTimeout;
  if (failure === 'timeout-no-close') globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === 5 * 60_000 ? 0 : delay, ...args);
  fs.writeFileSync(archive, Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]));
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = signal => {
      killSignal = signal;
      if (failure.endsWith('no-close')) { killed = true; return false; }
      if (killed) return true;
      killed = true;
      setImmediate(() => {
        child.stdout.destroy();
        child.stderr.end();
        child.emit('close', null);
      });
      return true;
    };
    setImmediate(() => { if (!killed) child.stdout.write(Buffer.from('fixture tar bytes')); });
    return child;
  };
  fs.createWriteStream = () => {
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        if (failure === 'timeout-no-close') callback();
        else callback(Object.assign(new Error('Injected output write failure'), { code: 'ENOSPC' }));
      }
    });
    stream.once('close', () => { outputClosed = true; });
    if (failure === 'open') process.nextTick(() => {
      stream.destroy(Object.assign(new Error('Injected output open failure'), { code: 'EACCES' }));
    });
    return stream;
  };
  syncBuiltinESMExports();
  try {
    const { extractToolBundleZip } = await import('../src/extensions/toolBundle.js');
    await assert.rejects(extractToolBundleZip(archive, path.join(root, 'destination')), error => {
      assert.match(error.message, /Injected output|decompression timed out/);
      if (failure.endsWith('no-close')) assert.match(error.message, /Could not confirm termination.*4242/);
      return true;
    });
    assert.equal(killed, true, 'the decompressor must be stopped after a failed output stream');
    assert.equal(outputClosed, true, 'cleanup must not race the Node-owned output file');
    assert.equal(killSignal, 'SIGKILL', 'failure must force termination instead of relying on a cooperative child');
    assert.deepEqual(fs.readdirSync(root), ['fixture.tar.xz']);
    console.log('Extraction failure rejected after output close.');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    childProcess.spawn = originalSpawn;
    fs.createWriteStream = originalCreateWriteStream;
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
