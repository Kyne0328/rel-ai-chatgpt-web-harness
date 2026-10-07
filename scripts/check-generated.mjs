import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { verifyDashboardGeneratedState } from './dashboard-generated-integrity.mjs';

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
  return new Error('Generated dashboard assets are stale. Run npm run build:frontend and keep public/dashboard-app.js, public/dashboard-react.js, public/dashboard.css, generated dashboard chunks, and public/dashboard-generated-manifest.json with the source change.');
}
