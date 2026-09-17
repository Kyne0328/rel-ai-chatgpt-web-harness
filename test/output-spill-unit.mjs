import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOutputSpillWriter, outputSpillOwner, readOutputSpill } from '../src/outputSpill.js';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-output-spill-'));
const config = { stateDir };
const spillRoot = path.join(stateDir, 'output-spills');

try {
  const tasklessOwner = outputSpillOwner({ workspace: 'app', principal: 'principal-a' });
  assert.ok(tasklessOwner, 'authorized workspace execution must derive a taskless output owner');
  assert.equal(tasklessOwner, outputSpillOwner({ workspace: 'app', principal: 'principal-a' }));
  assert.notEqual(tasklessOwner, outputSpillOwner({ workspace: 'app', principal: 'principal-b' }), 'different principals must not share taskless output refs');
  const tasklessWriter = createOutputSpillWriter(config, tasklessOwner);
  tasklessWriter.start('taskless output');
  const tasklessResult = await tasklessWriter.finish();
  const tasklessSpill = readOutputSpill(config, tasklessOwner, tasklessResult.outputRef);
  assert.equal(fs.readFileSync(tasklessSpill.file, 'utf8'), 'taskless output');
  assert.throws(
    () => readOutputSpill(config, outputSpillOwner({ workspace: 'app', principal: 'principal-b' }), tasklessResult.outputRef),
    /not found for this authorized execution scope/i
  );

  const boundedWriter = createOutputSpillWriter(config, 'bounded-queue');
  boundedWriter.start(Buffer.alloc(8 * 1024 * 1024, 0x62));
  assert.ok(boundedWriter.pendingBytes <= 4 * 1024 * 1024, 'spill queue must remain bounded before asynchronous writes drain');
  const boundedResult = await boundedWriter.finish();
  assert.equal(boundedResult?.spillTruncated, true, 'spill queue overflow must be reported as truncation');
  const boundedSpill = readOutputSpill(config, 'bounded-queue', boundedResult.outputRef);
  assert.ok(fs.statSync(boundedSpill.file).size <= 4 * 1024 * 1024, 'bounded spill queue must cap queued output');

  fs.mkdirSync(path.join(spillRoot, 'legacy-empty-task'), { recursive: true });

  for (let index = 0; index < 120; index += 1) {
    const writer = createOutputSpillWriter(config, `task-${index}`);
    writer.start(`spill-${index}`);
    const result = await writer.finish();
    assert.ok(result?.outputRef, `spill ${index} must produce an outputRef`);
  }

  const directories = fs.readdirSync(spillRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);
  const logFiles = directories.flatMap(directory => fs.readdirSync(path.join(spillRoot, directory))
    .filter(name => name.endsWith('.log')));

  assert.equal(logFiles.length, 100, 'spill pruning must enforce the 100-file retention bound');
  assert.equal(directories.length, logFiles.length, 'spill pruning must remove empty per-task directories');
  assert.equal(directories.includes('legacy-empty-task'), false, 'spill pruning must remove legacy empty task directories');

  const activeWriters = Array.from({ length: 101 }, (_, index) => createOutputSpillWriter(config, `active-${index}`));
  for (const [index, writer] of activeWriters.entries()) writer.start(`active-spill-${index}`);
  const activeResults = await Promise.all(activeWriters.map(writer => writer.finish()));
  assert.equal(activeResults.filter(Boolean).length, 100, 'the file cap must refuse a new spill rather than unlink an active writer');
  const firstActive = activeResults[0];
  assert.ok(firstActive?.outputRef);
  const firstActiveSpill = readOutputSpill(config, 'active-0', firstActive.outputRef);
  assert.equal(fs.readFileSync(firstActiveSpill.file, 'utf8'), 'active-spill-0', 'an active spill must survive pruning by later writers');
  const activeLogCount = fs.readdirSync(spillRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => fs.readdirSync(path.join(spillRoot, entry.name)).filter(name => name.endsWith('.log')))
    .length;
  assert.equal(activeLogCount, 100, 'active spill protection must preserve the global file-count bound');

  const concurrentWriters = Array.from({ length: 9 }, (_, index) => createOutputSpillWriter(config, `concurrent-${index}`));
  for (const writer of concurrentWriters) writer.start();
  const block = Buffer.alloc(32 * 1024 * 1024, 0x61);
  const concurrentResults = concurrentWriters.map(writer => {
    writer.append(block);
    return writer.finish();
  });
  const finishedConcurrentResults = await Promise.all(concurrentResults);
  const totalSpillBytes = fs.readdirSync(spillRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => fs.readdirSync(path.join(spillRoot, entry.name))
      .filter(name => name.endsWith('.log'))
      .map(name => fs.statSync(path.join(spillRoot, entry.name, name)).size))
    .reduce((sum, size) => sum + size, 0);
  assert.ok(totalSpillBytes <= 256 * 1024 * 1024, 'concurrent spill writers must enforce the 256 MiB global retention bound');
  assert.ok(finishedConcurrentResults.some(result => result?.spillTruncated), 'a writer must truncate when concurrent spills exhaust the global bound');
} finally {
  fs.rmSync(stateDir, { recursive: true, force: true });
}

console.log('Output spill retention removes empty task directories while preserving bounded logs.');
