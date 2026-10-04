import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { electronPlatformSpec, normalizeElectronPlatform } from './electron-platform.mjs';
import { resolvePackagedDirectory } from './packaged-directory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const platform = normalizeElectronPlatform(valueAfter(argv, '--platform', process.platform));
const allowHeadless = argv.includes('--allow-headless');
assert.equal(platform, process.platform, 'Packaged computer runtime verification must run on the target platform.');
const spec = electronPlatformSpec(platform);
const packageDirectory = resolvePackagedDirectory(root, argv, { platform });
const resourcesRoot = path.join(packageDirectory, spec.resourcesDirectory || 'resources');
const electronBinary = testElectronBinary(root, platform);
const probe = path.join(os.tmpdir(), `relai-packaged-computer-probe-${process.pid}-${Date.now()}.cjs`);

const source = String.raw`
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app } = require('electron');

const resourcesRoot = process.env.RELAI_PACKAGED_RESOURCES_ROOT;
if (!resourcesRoot) throw new Error('RELAI_PACKAGED_RESOURCES_ROOT is required.');

app.whenReady().then(async () => {
  const moduleUrl = pathToFileURL(path.join(resourcesRoot, 'src', 'computerManager.js')).href;
  const { readComputerStatus } = await import(moduleUrl);
  const status = await readComputerStatus({ computerControl: { enabled: false } });
  if (!status.available) throw new Error(status.message || 'Packaged computer runtime is unavailable.');
  let semantic = null;
  if (process.platform === 'win32') {
    const semanticUrl = pathToFileURL(path.join(resourcesRoot, 'src', 'computer', 'windowsUiaAdapter.ts')).href;
    const { createWindowsUiaAdapter } = await import(semanticUrl);
    const semanticAdapter = createWindowsUiaAdapter({ timeoutMs: 10_000 });
    try {
      semantic = await semanticAdapter.warmup();
      if (!semantic.available) throw new Error('Packaged Windows UI Automation runtime did not warm successfully.');
    } finally {
      await semanticAdapter.shutdown();
    }
  }
  console.log(JSON.stringify({ available: status.available, platform: status.platform, engine: status.engine, displays: status.displays, semantic }));
  app.quit();
}).catch(error => {
  console.error(error && (error.stack || error.message) || error);
  app.exit(1);
});
`;

try {
  fs.writeFileSync(probe, source, 'utf8');
  const electronArgs = platform === 'linux' ? ['--no-sandbox', probe] : [probe];
  const result = spawnSync(electronBinary, electronArgs, {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      RELAI_PACKAGED_RESOURCES_ROOT: resourcesRoot
    },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000
  });
  if (result.error) throw new Error(`Packaged computer runtime probe could not start: ${result.error.message}`, { cause: result.error });
  if (result.signal) throw new Error(`Packaged computer runtime probe was terminated by ${result.signal}.`);
  if (result.status !== 0) {
    throw new Error(`Packaged computer runtime probe failed with exit code ${result.status ?? 1}.\n${String(result.stdout || '')}${String(result.stderr || '')}`);
  }
  const output = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
  const parsed = JSON.parse(output);
  assert.equal(parsed.available, true, 'Packaged computer runtime must report available.');
  assert.equal(parsed.platform, platform, 'Packaged computer runtime reported the wrong platform.');
  assert.equal(parsed.engine, '@midscene/computer', 'Packaged computer runtime must use the Midscene engine.');
  const displayCount = Number(parsed.displays);
  assert.ok(Number.isInteger(displayCount) && displayCount >= 0, 'Packaged computer runtime must report a valid display count.');
  if (!allowHeadless) {
    assert.ok(displayCount > 0, 'Packaged computer runtime must enumerate at least one display.');
  }
  if (platform === 'win32') {
    assert.equal(parsed.semantic?.available, true, 'Packaged Windows UI Automation helper must warm successfully.');
  }
  console.log(displayCount > 0
    ? `Packaged Midscene computer runtime verified on ${platform} with ${displayCount} display(s).`
    : `Packaged Midscene computer runtime verified on headless ${platform} runner.`);
} finally {
  fs.rmSync(probe, { force: true });
}

function testElectronBinary(repositoryRoot, targetPlatform) {
  const dist = path.join(repositoryRoot, 'electron', 'node_modules', 'electron', 'dist');
  if (targetPlatform === 'win32') return path.join(dist, 'electron.exe');
  if (targetPlatform === 'darwin') return path.join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return path.join(dist, 'electron');
}

function valueAfter(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}
