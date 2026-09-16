import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helperPath = path.join(root, 'scripts', 'electron-updater-config.mjs');
assert.equal(fs.existsSync(helperPath), true,
  'Windows release packaging must provide a dedicated updater-config helper');

const { createWindowsUpdaterConfig, writeWindowsUpdaterConfig } = await import(pathToFileURL(helperPath));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'electron', 'package.json'), 'utf8'));
const config = createWindowsUpdaterConfig(manifest);
assert.deepEqual(config, {
  provider: 'github',
  owner: 'Kyne0328',
  repo: 'rel-ai-chatgpt-web-harness',
  releaseType: 'prerelease',
  updaterCacheDirName: 'rel-ai-mcp-launcher-updater'
});

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-updater-config-'));
try {
  const appDirectory = path.join(temporaryRoot, 'win-unpacked');
  const portableDirectory = path.join(temporaryRoot, 'portable-win-unpacked');
  fs.mkdirSync(path.join(appDirectory, 'resources'), { recursive: true });
  fs.cpSync(appDirectory, portableDirectory, { recursive: true });
  const result = writeWindowsUpdaterConfig({ appDirectory, manifest });
  assert.equal(result, path.join(appDirectory, 'resources', 'app-update.yml'));
  assert.equal(fs.existsSync(path.join(portableDirectory, 'resources', 'app-update.yml')), false);
  assert.equal(fs.readFileSync(result, 'utf8'), [
    'provider: github',
    'owner: Kyne0328',
    'repo: rel-ai-chatgpt-web-harness',
    'releaseType: prerelease',
    'updaterCacheDirName: rel-ai-mcp-launcher-updater',
    ''
  ].join('\n'));
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

const packageScript = fs.readFileSync(path.join(root, 'scripts', 'electron-package.mjs'), 'utf8');
const portableClone = packageScript.indexOf('fs.cpSync(prepackaged, portablePrepackaged');
const updaterWrite = packageScript.indexOf('writeWindowsUpdaterConfig({ appDirectory: prepackaged');
const artifactBuild = packageScript.indexOf("runNodeAsync('NSIS artifact packaging'");
assert.ok(portableClone >= 0 && updaterWrite > portableClone,
  'the portable working copy must be cloned before app-update.yml is added');
assert.ok(artifactBuild > updaterWrite,
  'app-update.yml must be written before the NSIS artifact is built');

console.log('Windows updater configuration packaging tests passed.');

