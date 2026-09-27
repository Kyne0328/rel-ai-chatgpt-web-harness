import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseArtifactNames } from './release-artifacts.mjs';
import { verifyUpdaterArtifacts } from './verify-updater-artifacts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function prepareReleaseAssets(directory = path.join(root, 'dist')) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const names = releaseArtifactNames(version);
  const builtAssets = [
    names.installer,
    names.portable,
    names.blockmap,
    names.metadata,
    names.linuxAppImage,
    names.linuxDeb,
    names.linuxMetadata,
    names.macDmgX64,
    names.macDmgArm64,
    names.sbom
  ];
  for (const name of builtAssets) requireFile(path.join(directory, name), `Required release output ${name}`);

  writeMacUpdaterMetadata(directory, names, version);
  const publicAssets = [...builtAssets, names.macMetadata];
  const checksums = publicAssets.slice().sort().map(name => {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex');
    return `${digest}  ${name}`;
  });
  fs.writeFileSync(path.join(directory, names.checksums), `${checksums.join('\n')}\n`, 'ascii');
  const listed = [...publicAssets, names.checksums];
  const assetList = path.join(directory, 'release-assets.txt');
  fs.writeFileSync(assetList, `${listed.join('\n')}\n`, 'utf8');

  const windowsVerification = verifyUpdaterArtifacts({
    directory,
    assetList,
    metadata: names.metadata,
    checksums: names.checksums,
    requireBlockmaps: true
  });
  const linuxVerification = verifyUpdaterArtifacts({
    directory,
    assetList,
    metadata: names.linuxMetadata,
    checksums: names.checksums,
    requireBlockmaps: false
  });
  const macVerification = verifyUpdaterArtifacts({
    directory,
    assetList,
    metadata: names.macMetadata,
    checksums: names.checksums,
    requireBlockmaps: false
  });
  return {
    version,
    assets: listed,
    verification: { windows: windowsVerification, linux: linuxVerification, mac: macVerification }
  };
}

function writeMacUpdaterMetadata(directory, names, version) {
  const records = [names.macDmgX64, names.macDmgArm64].map(name => {
    const file = path.join(directory, name);
    return {
      name,
      size: fs.statSync(file).size,
      sha512: crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')
    };
  });
  const primary = records[0];
  const lines = [
    `version: ${version}`,
    'files:',
    ...records.flatMap(record => [
      `  - url: ${record.name}`,
      `    sha512: ${record.sha512}`,
      `    size: ${record.size}`
    ]),
    `path: ${primary.name}`,
    `sha512: ${primary.sha512}`,
    ''
  ];
  fs.writeFileSync(path.join(directory, names.macMetadata), lines.join('\n'), 'utf8');
}

function requireFile(file, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`${label} is missing: ${file}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const directoryIndex = process.argv.indexOf('--dir');
    const directory = directoryIndex >= 0 ? path.resolve(root, String(process.argv[directoryIndex + 1] || '')) : path.join(root, 'dist');
    const result = prepareReleaseAssets(directory);
    console.log(`Prepared and verified ${result.assets.length} Windows, Linux, and macOS release assets for ${result.version}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export { prepareReleaseAssets, writeMacUpdaterMetadata };
