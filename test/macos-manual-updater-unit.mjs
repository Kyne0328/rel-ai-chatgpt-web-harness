import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CHECKSUM_ASSET_NAME,
  LATEST_MAC_URL,
  RELEASES_FEED_URL,
  checksumFor,
  createMacManualUpdater,
  parseRelease
} from '../electron/macos-manual-updater.js';

const roots = [];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-macos-updater-'));
  roots.push(root);
  return root;
}

function releaseFixture(version, arch, bytes, overrides = {}) {
  const assetName = `Rel.AI-MCP-${version}-mac-${arch}.dmg`;
  const assetUrl = `https://github.com/Kyne0328/rel-ai-chatgpt-web-harness/releases/download/${version}/${assetName}`;
  const checksumUrl = `https://github.com/Kyne0328/rel-ai-chatgpt-web-harness/releases/download/${version}/${CHECKSUM_ASSET_NAME}`;
  return {
    assetName,
    assetUrl,
    checksumUrl,
    metadata: [
      `version: ${version}`,
      'files:',
      `  - url: ${assetName}`,
      `    sha512: ${crypto.createHash('sha512').update(bytes).digest('base64')}`,
      `    size: ${bytes.length}`,
      `path: ${assetName}`,
      ''
    ].join('\n'),
    payload: {
      tag_name: version,
      draft: false,
      prerelease: false,
      published_at: '2026-08-29T00:00:00.000Z',
      body: 'macOS update notes',
      assets: [
        { name: assetName, browser_download_url: assetUrl, size: bytes.length },
        { name: CHECKSUM_ASSET_NAME, browser_download_url: checksumUrl, size: 200 }
      ],
      ...overrides
    }
  };
}

function rangeResponse(bytes, options = {}) {
  const range = String(options?.headers?.Range || '');
  if (!range) return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
  const match = range.match(/^bytes=(\d+)-$/);
  assert.ok(match, `unexpected range request: ${range}`);
  const offset = Number(match[1]);
  const remaining = bytes.subarray(offset);
  return new Response(remaining, {
    status: 206,
    headers: {
      'content-length': String(remaining.length),
      'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}`
    }
  });
}

const root = tempRoot();
const version = '0.28.0';
const bytes = Buffer.from('verified fake dmg bytes');
const fixture = releaseFixture(version, 'x64', bytes);
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
const checksumBody = `${digest}  ${fixture.assetName}\n`;
const fetchCalls = [];
let openedPath = '';
const progress = [];

const updater = createMacManualUpdater({
  app: { getPath: name => { assert.equal(name, 'userData'); return root; } },
  arch: 'x64',
  fetchImpl: async (url, options) => {
    fetchCalls.push({ url: String(url), range: String(options?.headers?.Range || '') });
    if (url === LATEST_MAC_URL) return new Response(fixture.metadata, { status: 200 });
    if (url === fixture.checksumUrl) return new Response(checksumBody, { status: 200 });
    if (url === fixture.assetUrl) return rangeResponse(bytes, options);
    return new Response('not found', { status: 404 });
  },
  openPath: async file => { openedPath = file; return ''; },
  now: (() => { let value = 1_000; return () => (value += 100); })()
});

const release = await updater.checkForUpdates();
assert.equal(release.version, version);
assert.equal(release.assetName, fixture.assetName);
assert.equal(release.releaseNotes, '', 'stable CDN metadata intentionally avoids the GitHub API release body');

const updateDirectory = path.join(root, 'updates');
fs.mkdirSync(updateDirectory, { recursive: true });
const expectedPath = path.join(updateDirectory, fixture.assetName);
const partialPath = `${expectedPath}.part`;
const partialLength = 7;
fs.writeFileSync(partialPath, bytes.subarray(0, partialLength));

const downloaded = await updater.downloadUpdate({ version, onProgress: value => progress.push(value) });
assert.equal(downloaded.assetName, fixture.assetName);
assert.equal(fs.readFileSync(expectedPath).toString(), bytes.toString());
assert.equal(fs.existsSync(partialPath), false);
assert.ok(progress.length >= 1, 'download must publish progress');
assert.equal(progress.at(-1).percent, 100);
assert.ok(fetchCalls.some(call => call.url === fixture.assetUrl && call.range === `bytes=${partialLength}-`), 'partial DMGs must resume with an HTTP Range request');

await updater.downloadUpdate({ version, onProgress: value => progress.push(value) });
assert.equal(fetchCalls.filter(call => call.url === fixture.assetUrl).length, 1, 'a verified cached DMG must not be downloaded again');

const opened = await updater.openDownloaded(version);
assert.equal(opened.ok, true);
assert.equal(opened.assetName, fixture.assetName);
assert.equal(openedPath, expectedPath);

const armFixture = releaseFixture(version, 'arm64', bytes);
assert.equal(parseRelease(armFixture.payload, 'arm64').assetName, armFixture.assetName, 'Apple Silicon must select the arm64 DMG');
assert.equal(checksumFor(checksumBody, fixture.assetName), digest);

const betaRoot = tempRoot();
const betaFixture = releaseFixture('0.29.0-beta.1', 'x64', bytes, { prerelease: true });
const betaMetadataUrl = `https://github.com/Kyne0328/rel-ai-chatgpt-web-harness/releases/download/${betaFixture.payload.tag_name}/latest-mac.yml`;
const betaFeed = `<feed><entry><link rel="alternate" href="https://github.com/Kyne0328/rel-ai-chatgpt-web-harness/releases/tag/${betaFixture.payload.tag_name}" /></entry></feed>`;
const betaUpdater = createMacManualUpdater({
  app: { getPath: () => betaRoot },
  arch: 'x64',
  fetchImpl: async url => {
    if (url === RELEASES_FEED_URL) return new Response(betaFeed, { status: 200 });
    if (url === betaMetadataUrl) return new Response(betaFixture.metadata, { status: 200 });
    return new Response('not found', { status: 404 });
  },
  openPath: async () => ''
});
assert.equal((await betaUpdater.checkForUpdates({ channel: 'beta' })).version, '0.29.0-beta.1', 'beta channel must accept pre-release candidates');

const badRoot = tempRoot();
const badFixture = releaseFixture('0.28.1', 'x64', bytes);
const badUpdater = createMacManualUpdater({
  app: { getPath: () => badRoot },
  arch: 'x64',
  fetchImpl: async (url, options) => {
    if (url === LATEST_MAC_URL) return new Response(badFixture.metadata, { status: 200 });
    if (url === badFixture.checksumUrl) return new Response(`${'0'.repeat(64)}  ${badFixture.assetName}\n`, { status: 200 });
    if (url === badFixture.assetUrl) return rangeResponse(bytes, options);
    return new Response('not found', { status: 404 });
  },
  openPath: async () => ''
});
await badUpdater.checkForUpdates();
await assert.rejects(() => badUpdater.downloadUpdate({ version: '0.28.1' }), /SHA-256 verification/);
assert.equal(fs.existsSync(path.join(badRoot, 'updates', badFixture.assetName)), false, 'checksum failure must not promote the downloaded DMG');

const untrusted = releaseFixture('0.28.2', 'x64', bytes);
untrusted.payload.assets[0].browser_download_url = 'https://example.com/Rel.AI-MCP-0.28.2-mac-x64.dmg';
assert.throws(() => parseRelease(untrusted.payload, 'x64'), /untrusted download URL/i);

for (const candidate of [
  { tag_name: 'v0.28.0-beta.1', assets: [] },
  { tag_name: '0.28.0', draft: true, assets: [] },
  { tag_name: '0.28.0', prerelease: true, assets: [] }
]) {
  assert.throws(() => parseRelease(candidate, 'x64'));
}

for (const item of roots) fs.rmSync(item, { recursive: true, force: true });
console.log('macOS manual updater unit tests passed.');
