import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { compareUpdateVersions, isUpdateVersion } from './update-version.js';

const RELEASE_BASE_URL = 'https://github.com/Kyne0328/rel-ai-chatgpt-web-harness/releases';
const LATEST_MAC_URL = `${RELEASE_BASE_URL}/latest/download/latest-mac.yml`;
const RELEASES_FEED_URL = `${RELEASE_BASE_URL}.atom`;
const RELEASE_DOWNLOAD_PREFIX = '/Kyne0328/rel-ai-chatgpt-web-harness/releases/download/';
const CHECKSUM_ASSET_NAME = 'SHA256SUMS.txt';
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_CHECKSUM_BYTES = 1024 * 1024;

function createMacManualUpdater(options = {}) {
  const {
    app,
    arch = process.arch,
    fetchImpl = globalThis.fetch,
    openPath,
    now = () => Date.now(),
    onLog = () => {}
  } = options;
  if (!app || typeof app.getPath !== 'function') throw new TypeError('Electron app is required for macOS updates.');
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported macOS update architecture: ${arch}.`);
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required for macOS updates.');
  if (typeof openPath !== 'function') throw new TypeError('A file opener is required for macOS updates.');

  let release = null;
  let downloadedPath = '';

  async function checkForUpdates({ channel = 'stable' } = {}) {
    if (channel === 'beta') {
      const feedResponse = await fetchTrusted(RELEASES_FEED_URL, 'GitHub release feed', fetchImpl, {
        headers: { 'User-Agent': 'Rel.AI-MCP-Updater' }
      });
      const tag = latestReleaseTagFromFeed(await boundedText(feedResponse, MAX_METADATA_BYTES));
      const metadataUrl = `${RELEASE_BASE_URL}/download/${encodeURIComponent(tag)}/latest-mac.yml`;
      const metadataResponse = await fetchTrusted(metadataUrl, 'macOS beta release metadata', fetchImpl, {
        headers: { 'User-Agent': 'Rel.AI-MCP-Updater' }
      });
      release = parseMacMetadata(await boundedText(metadataResponse, MAX_METADATA_BYTES), arch, { allowPrerelease: true, tag });
    } else {
      const response = await fetchTrusted(LATEST_MAC_URL, 'macOS release metadata', fetchImpl, {
        headers: { 'User-Agent': 'Rel.AI-MCP-Updater' }
      });
      release = parseMacMetadata(await boundedText(response, MAX_METADATA_BYTES), arch);
    }
    downloadedPath = '';
    return publicRelease(release);
  }

  async function downloadUpdate({ version, onProgress = () => {} } = {}) {
    const requestedVersion = String(version || '').trim();
    if (!release || release.version !== requestedVersion) {
      throw new Error('macOS update metadata is stale. Check for updates again before downloading.');
    }

    const checksumResponse = await fetchTrusted(release.checksumUrl, 'release checksum manifest', fetchImpl, {
      headers: { 'User-Agent': 'Rel.AI-MCP-Updater' }
    });
    const checksumText = await boundedText(checksumResponse, MAX_CHECKSUM_BYTES);
    const expectedSha256 = checksumFor(checksumText, release.assetName);
    if (!expectedSha256) throw new Error(`Release checksum metadata does not contain ${release.assetName}.`);

    const updateDirectory = path.join(app.getPath('userData'), 'updates');
    const target = path.join(updateDirectory, release.assetName);
    const temporary = `${target}.part`;
    fs.mkdirSync(updateDirectory, { recursive: true, mode: 0o700 });

    if (fs.existsSync(target) && await sha256File(target) === expectedSha256) {
      downloadedPath = target;
      const total = fs.statSync(target).size;
      onProgress({ percent: 100, transferred: total, total, bytesPerSecond: 0 });
      onLog(`Reusing verified macOS update ${release.assetName}.`);
      return { ...publicRelease(release), assetName: release.assetName };
    }
    fs.rmSync(target, { force: true });

    let resumeOffset = partialSize(temporary, release.assetSize);
    let response = await requestDmg(release.assetUrl, resumeOffset);
    if (resumeOffset > 0 && response.status === 416) {
      fs.rmSync(temporary, { force: true });
      resumeOffset = 0;
      response = await requestDmg(release.assetUrl, 0);
    }
    if (resumeOffset > 0 && response.status !== 206) {
      fs.rmSync(temporary, { force: true });
      resumeOffset = 0;
    } else if (resumeOffset > 0) {
      const contentRange = String(response.headers.get('content-range') || '');
      if (!contentRange.startsWith(`bytes ${resumeOffset}-`)) {
        fs.rmSync(temporary, { force: true });
        resumeOffset = 0;
        response = await requestDmg(release.assetUrl, 0);
      }
    }
    if (!response.ok) throw new Error(`macOS update DMG request failed with HTTP ${response.status || 'unknown'}.`);
    if (!response.body?.getReader) throw new Error('The macOS update download did not provide a readable response body.');

    const append = resumeOffset > 0 && response.status === 206;
    const handle = await fs.promises.open(temporary, append ? 'a' : 'w', 0o600);
    const reader = response.body.getReader();
    const responseBytes = positiveInteger(response.headers.get('content-length'));
    const total = contentRangeTotal(response.headers.get('content-range'))
      || release.assetSize
      || (append ? resumeOffset + responseBytes : responseBytes);
    let transferred = append ? resumeOffset : 0;
    let downloadedThisRun = 0;
    const startedAt = now();
    if (transferred > 0) {
      onProgress({
        percent: total > 0 ? (transferred / total) * 100 : 0,
        transferred,
        total,
        bytesPerSecond: 0
      });
      onLog(`Resuming macOS update ${release.assetName} from byte ${transferred}.`);
    }
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        await writeAll(handle, value);
        transferred += value.byteLength;
        downloadedThisRun += value.byteLength;
        const elapsedMs = Math.max(1, now() - startedAt);
        onProgress({
          percent: total > 0 ? (transferred / total) * 100 : 0,
          transferred,
          total,
          bytesPerSecond: Math.round((downloadedThisRun * 1000) / elapsedMs)
        });
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      await handle.close();
    }

    if (release.assetSize > 0 && transferred < release.assetSize) {
      throw new Error(`macOS update download ended early at ${transferred} of ${release.assetSize} bytes.`);
    }
    if (release.assetSize > 0 && transferred > release.assetSize) {
      fs.rmSync(temporary, { force: true });
      throw new Error(`macOS update download exceeded the expected size for ${release.assetName}.`);
    }
    const actualSha256 = await sha256File(temporary);
    if (actualSha256 !== expectedSha256) {
      fs.rmSync(temporary, { force: true });
      throw new Error(`Downloaded macOS update failed SHA-256 verification for ${release.assetName}.`);
    }
    fs.renameSync(temporary, target);
    downloadedPath = target;
    onProgress({ percent: 100, transferred, total: total || transferred, bytesPerSecond: 0 });
    onLog(`Verified macOS update ${release.assetName}.`);
    return { ...publicRelease(release), assetName: release.assetName };
  }

  async function requestDmg(url, offset) {
    const headers = { 'User-Agent': 'Rel.AI-MCP-Updater' };
    if (offset > 0) headers.Range = `bytes=${offset}-`;
    return fetchTrusted(url, 'macOS update DMG', fetchImpl, {
      headers,
      allowedErrorStatuses: offset > 0 ? [416] : []
    });
  }

  async function openDownloaded(version) {
    const requestedVersion = String(version || '').trim();
    if (!release || release.version !== requestedVersion || !downloadedPath || !fs.existsSync(downloadedPath)) {
      throw new Error('The verified macOS update DMG is no longer available. Download it again.');
    }
    const openError = await openPath(downloadedPath);
    if (String(openError || '').trim()) throw new Error(`macOS could not open the update DMG: ${String(openError).trim()}`);
    return { ok: true, assetName: path.basename(downloadedPath) };
  }

  return { checkForUpdates, downloadUpdate, openDownloaded };
}

function parseMacMetadata(source, arch, options = {}) {
  const lines = String(source || '').split(/\r?\n/);
  const versionLine = lines.find(line => /^version:\s*/.test(line));
  const version = cleanVersion(versionLine?.replace(/^version:\s*/, ''), options.allowPrerelease === true);
  if (!version) throw new Error('macOS release metadata contains an invalid stable version.');
  const assetName = `Rel.AI-MCP-${version}-mac-${arch}.dmg`;
  let currentName = '';
  let assetSize = 0;
  for (const rawLine of lines) {
    const file = rawLine.match(/^\s*-\s+(?:url|path):\s*(.+?)\s*$/);
    if (file) {
      currentName = yamlScalar(file[1]);
      continue;
    }
    const size = rawLine.match(/^\s+size:\s*(\d+)\s*$/);
    if (size && currentName === assetName) assetSize = positiveInteger(size[1]);
  }
  if (!lines.some(line => line.includes(assetName))) {
    throw new Error(`macOS release metadata does not contain ${assetName}.`);
  }
  return releaseFromVersion(version, arch, assetSize, options.tag || version);
}

function parseRelease(payload, arch, options = {}) {
  if (!payload || typeof payload !== 'object' || payload.draft === true) {
    throw new Error('GitHub did not return a usable Rel.AI release.');
  }
  const allowPrerelease = options.allowPrerelease === true;
  if (payload.prerelease === true && !allowPrerelease) throw new Error('GitHub did not return a stable Rel.AI release.');
  const version = cleanVersion(payload.tag_name, allowPrerelease);
  if (!version) throw new Error('GitHub release metadata contains an invalid version.');
  const assetName = `Rel.AI-MCP-${version}-mac-${arch}.dmg`;
  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  const asset = assets.find(candidate => String(candidate?.name || '') === assetName);
  const checksum = assets.find(candidate => String(candidate?.name || '') === CHECKSUM_ASSET_NAME);
  if (!asset?.browser_download_url) throw new Error(`GitHub release ${version} does not contain ${assetName}.`);
  if (!checksum?.browser_download_url) throw new Error(`GitHub release ${version} does not contain ${CHECKSUM_ASSET_NAME}.`);
  assertTrustedDownloadUrl(asset.browser_download_url);
  assertTrustedDownloadUrl(checksum.browser_download_url);
  return {
    version,
    releaseDate: String(payload.published_at || '').trim(),
    releaseNotes: String(payload.body || '').trim(),
    assetName,
    assetUrl: String(asset.browser_download_url),
    assetSize: positiveInteger(asset.size),
    checksumUrl: String(checksum.browser_download_url)
  };
}

function latestReleaseTagFromFeed(source) {
  const tags = [];
  const pattern = /href="https:\/\/github\.com\/Kyne0328\/rel-ai-chatgpt-web-harness\/releases\/tag\/([^"?#]+)"/g;
  for (const match of String(source || '').matchAll(pattern)) {
    let tag;
    try { tag = decodeURIComponent(match[1]); } catch { continue; }
    const version = tag.replace(/^v/i, '');
    if (isUpdateVersion(version, { allowPrerelease: true })) tags.push({ tag, version });
  }
  if (!tags.length) throw new Error('GitHub release feed did not contain a valid Rel.AI release tag.');
  tags.sort((left, right) => compareUpdateVersions(right.version, left.version, { allowPrerelease: true }));
  return tags[0].tag;
}

function releaseFromVersion(version, arch, assetSize = 0, tag = version) {
  const assetName = `Rel.AI-MCP-${version}-mac-${arch}.dmg`;
  const releaseRoot = `${RELEASE_BASE_URL}/download/${encodeURIComponent(tag)}`;
  return {
    version,
    releaseDate: '',
    releaseNotes: '',
    assetName,
    assetUrl: `${releaseRoot}/${encodeURIComponent(assetName)}`,
    assetSize,
    checksumUrl: `${releaseRoot}/${CHECKSUM_ASSET_NAME}`
  };
}

function publicRelease(value) {
  return {
    version: value.version,
    releaseDate: value.releaseDate,
    releaseNotes: value.releaseNotes,
    assetName: value.assetName
  };
}

async function fetchTrusted(url, label, fetchImpl, options = {}) {
  assertTrustedUrl(url);
  const { allowedErrorStatuses = [], ...fetchOptions } = options;
  const response = await fetchImpl(url, { redirect: 'follow', ...fetchOptions });
  if (!response?.ok && !allowedErrorStatuses.includes(Number(response?.status))) {
    throw new Error(`${label} request failed with HTTP ${response?.status || 'unknown'}.`);
  }
  return response;
}

function assertTrustedUrl(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:') throw new Error('Update URLs must use HTTPS.');
  if (url.hostname === 'github.com' && (
    url.pathname === '/Kyne0328/rel-ai-chatgpt-web-harness/releases.atom'
    || url.pathname === '/Kyne0328/rel-ai-chatgpt-web-harness/releases/latest/download/latest-mac.yml'
    || url.pathname.startsWith(RELEASE_DOWNLOAD_PREFIX)
  )) return;
  throw new Error(`Untrusted update URL: ${url.hostname}${url.pathname}`);
}

function assertTrustedDownloadUrl(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith(RELEASE_DOWNLOAD_PREFIX)) {
    throw new Error('GitHub release metadata contains an untrusted download URL.');
  }
}

async function boundedText(response, limit) {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > limit) throw new Error('Release metadata is unexpectedly large.');
  return text;
}

function checksumFor(source, fileName) {
  for (const rawLine of String(source || '').split(/\r?\n/)) {
    const match = rawLine.trim().match(/^([a-fA-F0-9]{64})\s+[* ]?(.+)$/);
    if (!match) continue;
    if (match[2].trim() === fileName) return match[1].toLowerCase();
  }
  return '';
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function writeAll(handle, value) {
  let offset = 0;
  while (offset < value.byteLength) {
    const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset, null);
    if (bytesWritten <= 0) throw new Error('The macOS update download stopped writing before completion.');
    offset += bytesWritten;
  }
}

function partialSize(file, expectedSize) {
  try {
    const size = fs.statSync(file).size;
    if (size <= 0 || (expectedSize > 0 && size >= expectedSize)) {
      fs.rmSync(file, { force: true });
      return 0;
    }
    return size;
  } catch {
    return 0;
  }
}

function contentRangeTotal(value) {
  const match = String(value || '').match(/^bytes\s+\d+-\d+\/(\d+)$/i);
  return match ? positiveInteger(match[1]) : 0;
}

function positiveInteger(value) {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function cleanVersion(value, allowPrerelease) {
  const version = yamlScalar(value).replace(/^v/i, '');
  return isUpdateVersion(version, { allowPrerelease }) ? version : '';
}

function yamlScalar(value) {
  const text = String(value || '').trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text); } catch {}
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  return text;
}

export {
  CHECKSUM_ASSET_NAME,
  LATEST_MAC_URL,
  RELEASES_FEED_URL,
  checksumFor,
  createMacManualUpdater,
  latestReleaseTagFromFeed,
  parseMacMetadata,
  parseRelease
};
