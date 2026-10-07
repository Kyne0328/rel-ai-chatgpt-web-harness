// Retain a bounded byte tail without stopping the child's output drain.
export function createTestOutputTail(maxBytes = 1024 * 1024) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Output byte limit must be a positive integer.');
  let chunks = [];
  let retained = 0;
  let total = 0;
  return {
    append(value) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
      total += bytes.length;
      if (bytes.length >= maxBytes) {
        chunks = [Buffer.from(bytes.subarray(bytes.length - maxBytes))];
        retained = maxBytes;
        return;
      }
      chunks.push(Buffer.from(bytes));
      retained += bytes.length;
      while (retained > maxBytes) {
        const excess = retained - maxBytes;
        const first = chunks[0];
        if (first.length <= excess) { retained -= first.length; chunks.shift(); }
        else { chunks[0] = Buffer.from(first.subarray(excess)); retained -= excess; }
      }
    },
    snapshot() {
      return { text: Buffer.concat(chunks, retained).toString('utf8'), totalBytes: total,
        retainedBytes: retained, truncated: total > retained };
    }
  };
}
