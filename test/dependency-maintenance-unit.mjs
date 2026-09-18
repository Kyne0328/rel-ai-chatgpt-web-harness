import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const rootPackage = JSON.parse(read('package.json'));
const electronPackage = JSON.parse(read('electron/package.json'));
const nodeVersion = read('.node-version').trim();

assert.equal(nodeVersion, '26.8.2', 'the repository must keep an exact tested Node runtime');
assert.match(rootPackage.scripts?.check || '', /ensure-node-version\.mjs/, 'the normal local check gate must reject an unsupported executing Node runtime before validation');
assert.equal(rootPackage.packageManager, 'npm@12.0.2', 'the repository must keep an exact npm runtime');
assert.equal(electronPackage.overrides?.['js-yaml'], '4.3.2', 'Electron must independently pin the patched js-yaml release');

for (const workflowPath of [
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  '.github/workflows/manual-electron-dist.yml',
  '.github/workflows/dependency-health.yml'
]) {
  const workflow = read(workflowPath);
  assert.match(workflow, /node-version-file:\s*\.node-version/, `${workflowPath} must consume the repository Node pin`);
  assert.doesNotMatch(workflow, /node-version:\s*26\b/, `${workflowPath} must not float on the Node 26 major`);
}

const dependabot = read('.github/dependabot.yml');
assert.match(dependabot, /directory:\s*\/\s*(?:\r?\n)/, 'Dependabot must maintain the root dependency tree');
assert.match(dependabot, /directory:\s*\/electron\b/, 'Dependabot must maintain the Electron dependency tree');
assert.match(dependabot, /interval:\s*weekly/g, 'Dependabot updates must run on a recurring schedule');

const health = read('.github/workflows/dependency-health.yml');
assert.match(health, /schedule:[\s\S]*cron:/, 'dependency health must run on a schedule');
assert.match(health, /workflow_dispatch:/, 'dependency health must also support manual runs');
assert.match(health, /working-directory:\s*electron/, 'dependency health must install the Electron dependency tree independently');
assert.match(health, /npm run audit:production/, 'dependency health must run the production advisory gate');
assert.match(health, /npm run audit:packaging/, 'dependency health must run the packaging advisory gate');
assert.match(health, /npm outdated --long/, 'dependency health must report root updates');
assert.match(health, /npm outdated --prefix electron --long/, 'dependency health must report Electron updates');

console.log('Dependency maintenance policy is wired to both npm trees and the pinned toolchain.');
