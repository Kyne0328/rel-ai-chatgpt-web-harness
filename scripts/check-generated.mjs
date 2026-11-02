import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  dashboardAssetHashes,
  dashboardGeneratedManifestPath,
  dashboardSourceHash,
  verifyDashboardGeneratedState
} from './dashboard-generated-integrity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = process.env.REL_AI_GENERATED_PUBLIC_ROOT
  ? path.resolve(process.env.REL_AI_GENERATED_PUBLIC_ROOT)
  : path.join(root, 'public');

try {
  verifyColorTokens();
  verifyUiContracts();
  verifyGenerator('generate-windows-process-job-native.mjs', 'Generated Windows process controller is stale. Run node scripts/generate-windows-process-job-native.mjs --write on Windows.');
  if (!verifyDashboardGeneratedState(root, publicRoot)) throw staleDashboardError();
  console.log('Generated dashboard assets are current.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function verifyColorTokens() {
  verifyGenerator('generate-color-tokens.mjs', 'Generated color tokens are stale. Run npm run generate:color-tokens.');
}

function verifyUiContracts() {
  verifyGenerator('generate-ui-contracts.mjs', 'Generated UI contracts are stale. Run node scripts/generate-ui-contracts.mjs.');
}

function verifyGenerator(name, message) {
  const script = path.join(root, 'scripts', name);
  const result = spawnSync(process.execPath, [script, '--check'], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${name} verification was terminated by ${result.signal}.`);
  if (result.status !== 0) throw new Error(message);
}

function staleDashboardError() {
  const explanation = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(dashboardGeneratedManifestPath(publicRoot), 'utf8'));
    const currentSource = dashboardSourceHash(root);
    if (manifest.sourceHash !== currentSource) {
      explanation.push(`source fingerprint: recorded ${manifest.sourceHash}, current ${currentSource}`);
    }
    const actualAssets = dashboardAssetHashes(publicRoot);
    const expectedAssets = manifest.assets || {};
    const changedAssets = [...new Set([...Object.keys(expectedAssets), ...Object.keys(actualAssets)])]
      .filter(name => actualAssets[name] !== expectedAssets[name]).sort();
    if (changedAssets.length) explanation.push(`asset mismatches: ${changedAssets.join(', ')}`);
  } catch (error) {
    explanation.push(`manifest unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return new Error(`Generated dashboard assets are stale. ${explanation.join('; ')}. Run npm run build:frontend and keep public/dashboard-app.js, public/dashboard-react.js, public/dashboard.css, generated dashboard chunks, and public/dashboard-generated-manifest.json with the source change.`);
}
