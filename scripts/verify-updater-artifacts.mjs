import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseAssetList,
  parseChecksumManifest,
  parseLatestMetadata,
  releaseArtifactNames
} from './release-artifacts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function currentReleaseVersion() {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

function parseArguments(argv) {
  const valueAfter = (name, fallback) => {
    const index = argv.indexOf(name);
    if (index < 0) return fallback;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    return value;
  };
  return {
    directory: path.resolve(root, valueAfter('--dir', 'dist')),
    assetList: path.resolve(root, valueAfter('--asset-list', 'dist/release-assets.txt')),
    metadata: valueAfter('--metadata', 'latest.yml'),
    checksums: valueAfter('--checksums', 'SHA256SUMS.txt'),
    requireBlockmaps: !argv.includes('--no-blockmaps'),
    platform: valueAfter('--platform', '')
  };
}

function verifyPlatformUpdaterArtifacts(options) {
  const platform = String(options.platform || '').trim().toLowerCase();
  if (!['win32', 'linux'].includes(platform)) {
    throw new Error('--platform must be win32 or linux.');
  }
  const version = currentReleaseVersion();
  const names = releaseArtifactNames(version);
  const expectedArtifact = platform === 'win32' ? names.installer : names.linuxAppImage;
  const metadata = platform === 'win32' ? names.metadata : names.linuxMetadata;
  const metadataPath = path.join(options.directory, metadata);
  requireFile(metadataPath, 'Updater metadata');
  const references = parseLatestMetadata(fs.readFileSync(metadataPath, 'utf8'), version);
  if (references.length !== 1 || references[0].basename !== expectedArtifact) {
    throw new Error(`Updater metadata must reference only the canonical ${platform} artifact: ${expectedArtifact}.`);
  }
  const reference = references[0];
  const artifactPath = path.join(options.directory, reference.basename);
  requireFile(artifactPath, 'Updater artifact');
  const actualSha512 = hashFile(artifactPath, 'sha512', 'base64');
  if (!constantTimeEqual(actualSha512, reference.sha512)) {
    throw new Error(`SHA-512 mismatch for ${reference.basename}.`);
  }
  if (platform === 'win32') requireFile(path.join(options.directory, names.blockmap), 'Updater blockmap');
  return { platform, referencedArtifacts: [reference.basename] };
}

function verifyUpdaterArtifacts(options) {
  requireFile(options.assetList, 'Release asset list');
  const assets = parseAssetList(fs.readFileSync(options.assetList, 'utf8'));
  const metadataPath = path.join(options.directory, options.metadata);
  const checksumPath = path.join(options.directory, options.checksums);
  requireFile(metadataPath, 'Updater metadata');
  requireFile(checksumPath, 'SHA-256 manifest');
  const references = parseLatestMetadata(fs.readFileSync(metadataPath, 'utf8'), currentReleaseVersion());
  const checksums = parseChecksumManifest(fs.readFileSync(checksumPath, 'utf8'));

  for (const reference of references) {
    assertListed(assets, reference.basename, 'Updater artifact');
    const artifactPath = path.join(options.directory, reference.basename);
    requireFile(artifactPath, 'Updater artifact');
    const actualSha512 = hashFile(artifactPath, 'sha512', 'base64');
    if (!constantTimeEqual(actualSha512, reference.sha512)) {
      throw new Error(`SHA-512 mismatch for ${reference.basename}.`);
    }
    if (options.requireBlockmaps !== false) {
      const blockmap = `${reference.basename}.blockmap`;
      assertListed(assets, blockmap, 'Updater blockmap');
      requireFile(path.join(options.directory, blockmap), 'Updater blockmap');
    }
    const expectedSha256 = checksums.get(reference.basename);
    if (!expectedSha256) throw new Error(`SHA256SUMS.txt does not include ${reference.basename}.`);
    const actualSha256 = hashFile(artifactPath, 'sha256', 'hex');
    if (!constantTimeEqual(actualSha256, expectedSha256)) {
      throw new Error(`SHA-256 mismatch for ${reference.basename}.`);
    }
  }

  for (const required of [options.metadata, options.checksums]) assertListed(assets, required, 'Release metadata');
  return {
    referencedArtifacts: references.map(reference => reference.basename),
    listedAssets: [...assets].sort()
  };
}

function assertListed(assets, basename, label) {
  if (!assets.has(basename)) throw new Error(`${label} is not present under its exact basename in the release asset list: ${basename}.`);
}

function requireFile(file, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${label} is missing: ${file}.`);
}

function hashFile(file, algorithm, encoding) {
  return crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || '').trim());
  const rightBuffer = Buffer.from(String(right || '').trim());
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = options.platform ? verifyPlatformUpdaterArtifacts(options) : verifyUpdaterArtifacts(options);
    console.log(`Updater artifact contract verified for ${report.referencedArtifacts.join(', ')}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export { parseArguments, verifyPlatformUpdaterArtifacts, verifyUpdaterArtifacts };
