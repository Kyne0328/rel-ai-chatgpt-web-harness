import fs from 'node:fs';
import path from 'node:path';

// Native owners spool bounded output independently of the desktop. A reader
// holds no target pipe and can reconnect at any offset after runtime loss.
function observeDurableProcessOutput(directory, onChunk, afterBatch = async () => {}) {
  const offsets = { stdout: 0, stderr: 0 };
  let pending = Promise.resolve();
  let failure = '';
  let closed = false;
  let reading = false;
  const read = async final => {
    for (const stream of ['stdout', 'stderr']) {
      const file = path.join(directory, stream + '.log');
      let descriptor;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size < offsets[stream]) throw new Error('Durable output was replaced.');
        descriptor = fs.openSync(file, 'r');
        const buffer = Buffer.allocUnsafe(65536);
        let budget = final ? Infinity : 1024 * 1024;
        while (offsets[stream] < stat.size && budget > 0) {
          const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, stat.size - offsets[stream]), offsets[stream]);
          if (!count) break;
          onChunk(stream, Buffer.from(buffer.subarray(0, count)));
          offsets[stream] += count;
          budget -= count;
          await afterBatch(stream);
        }
      } catch (error) {
        if (error.code !== 'ENOENT') failure = String(error.message || error);
      } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    }
  };
  const timer = setInterval(() => {
    if (!closed && !reading) {
      reading = true;
      pending = pending.then(() => read(false)).finally(() => { reading = false; });
    }
  }, 100);
  timer.unref?.();
  return {
    async finish() {
      closed = true;
      clearInterval(timer);
      await pending;
      await read(true);
      return failure;
    }
  };
}

export { observeDurableProcessOutput };
