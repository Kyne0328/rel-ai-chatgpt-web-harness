import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const scripts = packageJson.scripts || {};
const ciDir = path.join(root, '.github', 'workflows');
const failures = [];

const nodeEngine = String(packageJson.engines?.node || '');
const npmEngine = String(packageJson.engines?.npm || '');
const packageManagerMatch = /^npm@(\d+)\.\d+\.\d+$/.exec(String(packageJson.packageManager || ''));
const minimumNodeMajor = Number(/>=\s*(\d+)/.exec(nodeEngine)?.[1]);
const minimumNpmMajor = Number(/>=\s*(\d+)/.exec(npmEngine)?.[1]);
if (!Number.isSafeInteger(minimumNodeMajor) || minimumNodeMajor <= 0) {
  failures.push(`package.json must declare a minimum supported Node.js major; got ${nodeEngine || 'none'}`);
}
if (!Number.isSafeInteger(minimumNpmMajor) || minimumNpmMajor <= 0) {
  failures.push(`package.json must declare a minimum supported npm major; got ${npmEngine || 'none'}`);
}
if (!packageManagerMatch) {
  failures.push(`package.json packageManager must pin an exact npm version; got ${packageJson.packageManager || 'none'}`);
} else if (Number(packageManagerMatch[1]) < minimumNpmMajor) {
  failures.push(`packageManager ${packageJson.packageManager} must satisfy the declared npm minimum ${npmEngine}`);
}

const ciWorkflowPath = path.join(ciDir, 'ci.yml');
if (fs.existsSync(ciWorkflowPath) && Number.isSafeInteger(minimumNodeMajor)) {
  const ciWorkflow = fs.readFileSync(ciWorkflowPath, 'utf8');
  const configuredNodeMajors = [...ciWorkflow.matchAll(/node-version:\s*['"]?(\d+)/g)].map(match => Number(match[1]));
  for (const match of ciWorkflow.matchAll(/node-version-file:\s*['"]?([^\s'"]+)/g)) {
    try {
      const configuredVersion = fs.readFileSync(path.join(root, match[1]), 'utf8').trim();
      const configuredMajor = Number(/^v?(\d+)/.exec(configuredVersion)?.[1]);
      if (Number.isSafeInteger(configuredMajor)) configuredNodeMajors.push(configuredMajor);
    } catch {}
  }
  if (!configuredNodeMajors.some(major => major >= minimumNodeMajor)) {
    failures.push(`CI must test a Node.js major that satisfies the declared minimum ${nodeEngine}.`);
  }
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.ya?ml$/i.test(entry.name)) out.push(full);
  }
  return out;
}

for (const file of walk(ciDir)) {
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(/uses:\s*actions\/(checkout|setup-node|upload-artifact|attest-build-provenance|attest-sbom)@([^\s#]+)/g)) {
    const [, action, reference] = match;
    if (!/^[a-f0-9]{40}$/.test(reference)) {
      failures.push(`${path.relative(root, file)} must pin actions/${action} to an immutable commit SHA.`);
    }
  }
  for (const match of text.matchAll(/npm\s+run\s+([A-Za-z0-9:_-]+)/g)) {
    const script = match[1];
    if (!scripts[script]) {
      failures.push(`${path.relative(root, file)} references missing npm script: ${script}`);
    }
  }
}

const allowedSynchronousProcessDiscovery = new Set([
  'src/browser/playwrightPrimitives.ts',
  'src/executionInvocation.ts',
  'src/process.ts',
  'src/release.js',
]);
for (const file of collectRuntimeSource(path.join(root, 'src'))) {
  const relativePath = path.relative(root, file).replaceAll('\\', '/');
  const source = fs.readFileSync(file, 'utf8');
  if (/Atomics\.wait\s*\(/.test(source)) failures.push(`${relativePath} blocks the Node event loop with Atomics.wait.`);
  if (/execFileSync\s*\(/.test(source)) failures.push(`${relativePath} blocks the Node event loop with execFileSync.`);
  if (/spawnSync\s*\(/.test(source) && !allowedSynchronousProcessDiscovery.has(relativePath)) {
    failures.push(`${relativePath} uses spawnSync outside the bounded executable-discovery allowlist.`);
  }
}

function collectRuntimeSource(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectRuntimeSource(target));
    else if (/\.(?:[cm]?[jt]s)$/i.test(entry.name)) files.push(target);
  }
  return files;
}

if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log('Repo health checks passed.');
