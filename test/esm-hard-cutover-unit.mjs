import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const productionRoots = ['bin', 'electron', 'scripts', 'src'];
const ignoredDirectories = new Set(['node_modules', 'dist', 'vendor']);
const allowedCjs = new Set(['electron/preload.cjs']);
const allowedInteropSyntax = new Map([
  ['scripts/verify-node-pty-runtime.mjs', new Set(['require() declaration', 'createRequire import', 'createRequire call'])],
  ['scripts/verify-packaged-computer-runtime.mjs', new Set(['require() declaration'])]
]);
const forbiddenSyntax = [
  { label: 'require() declaration', pattern: /^\s*(?:const|let|var)\s+[^=\n]+?=\s*require\s*\(/m },
  { label: 'require() statement', pattern: /^\s*require\s*\(/m },
  { label: 'module.exports', pattern: /^\s*module\.exports\b/m },
  { label: 'exports.*', pattern: /^\s*exports\s*\./m },
  { label: 'createRequire import', pattern: /^\s*import\s+\{[^}]*\bcreateRequire\b[^}]*\}\s+from\s+['"]node:module['"]/m },
  { label: 'createRequire call', pattern: /^\s*(?:const|let|var)\s+[^=\n]+?=\s*createRequire\s*\(/m },
  { label: 'require.resolve', pattern: /^\s*require\.resolve\s*\(/m },
  { label: 'require.cache', pattern: /^\s*require\.cache\b/m }
];

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronPackage = JSON.parse(fs.readFileSync(path.join(root, 'electron', 'package.json'), 'utf8'));
assert.equal(rootPackage.type, 'module');
assert.equal(electronPackage.type, 'module');

const productionFiles = productionRoots.flatMap(relative => walk(path.join(root, relative)));
const cjsFiles = productionFiles
  .filter(file => file.endsWith('.cjs'))
  .map(file => path.relative(root, file).replaceAll('\\', '/'))
  .sort();
assert.deepEqual(cjsFiles, [...allowedCjs], 'the sandboxed Electron preload is the only permitted first-party CommonJS boundary');

for (const file of productionFiles.filter(file => /\.(?:js|mjs|cjs)$/.test(file))) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  const source = fs.readFileSync(file, 'utf8');
  if (relative === 'electron/preload.cjs') {
    assert.match(source, /const \{ contextBridge, ipcRenderer, webUtils \} = require\('electron'\);/);
    assert.equal((source.match(/\brequire\s*\(/g) || []).length, 1, 'preload.cjs may require only Electron');
    assert.match(source, /--relai-preload-surface=/);
    continue;
  }
  for (const check of forbiddenSyntax) {
    if (allowedInteropSyntax.get(relative)?.has(check.label)) continue;
    assert.doesNotMatch(source, check.pattern, `${relative} contains forbidden first-party CommonJS syntax: ${check.label}`);
  }
}

for (const removed of [
  'electron/preload.js',
  'electron/dashboard-preload.js',
  'src/ui/colorTokens.js'
]) {
  assert.equal(fs.existsSync(path.join(root, removed)), false, `${removed} must remain removed`);
}

const testFiles = walk(path.join(root, 'test')).filter(file => file.endsWith('.mjs'));
for (const file of testFiles) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  const source = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /^import\s+\{\s*createRequire\s*\}\s+from\s+['"]node:module['"];?$/m, `${relative} must load first-party code through ESM`);
  assert.doesNotMatch(source, /^const\s+require\s*=\s*createRequire\(import\.meta\.url\);?$/m, `${relative} must not recreate a CommonJS loader`);
}

console.log('First-party ESM hard-cutover gate passed with one documented sandboxed preload boundary.');
