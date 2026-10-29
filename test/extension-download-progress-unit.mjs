import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadVerifiedFile, extensionProgress, parseExtensionCatalog } from '../src/extensions/registry.js';
import { reportExtensionProgress } from '../src/extensions/installProgress.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-extension-progress-'));
const fetchBefore = globalThis.fetch;
try {
  const bytes = Buffer.from('Known streamed content for verified extension download');
  globalThis.fetch = async () => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
  const samples = [];
  const output = path.join(dir, 'payload');
  await downloadVerifiedFile('https://downloads.test/archive', 10000, 'test archive', output,
    crypto.createHash('sha256').update(bytes).digest('hex'), { onProgress: (done, total) => samples.push([done, total]) });
  assert.deepEqual(fs.readFileSync(output), bytes);
  assert.deepEqual(samples.at(-1), [bytes.length, bytes.length]);
  reportExtensionProgress('kyne.progress-test', { status: 'installing', phase: 'Downloading', downloadedBytes: 128, totalBytes: 1024 });
  assert.equal(extensionProgress().find(item => item.id === 'kyne.progress-test').downloadedBytes, 128);
  reportExtensionProgress('kyne.progress-test', { status: 'completed', phase: 'Installed' });
  assert.equal(extensionProgress().find(item => item.id === 'kyne.progress-test').status, 'completed');
  const catalog = parseExtensionCatalog({ schemaVersion: 1, updatedAt: '2026-10-28', extensions: [{
    id: 'kyne.test', name: 'Test', description: 'Test extension', version: '1.0.0', kind: 'skill',
    manifestUrl: 'https://example.org/relai-extension.json', repository: 'https://example.org/',
    publisher: 'Tester', permissions: [], downloadBytes: 1310000000, downloadApproximate: true
  }] });
  assert.equal(catalog.extensions[0].downloadBytes, 1310000000);
  assert.throws(() => parseExtensionCatalog({ ...catalog, extensions: [{ ...catalog.extensions[0], downloadBytes: -1 }] }));
  console.log('Extension size metadata and verified stream progress passed.');
} finally {
  globalThis.fetch = fetchBefore;
  fs.rmSync(dir, { recursive: true, force: true });
}
