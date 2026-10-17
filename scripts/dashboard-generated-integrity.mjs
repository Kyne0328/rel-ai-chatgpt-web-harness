import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MANIFEST_NAME = 'dashboard-generated-manifest.json';
const GENERATED_FILES = Object.freeze(['dashboard-app.js', 'dashboard-react.js', 'dashboard.css', 'dashboard-bundle-dependencies.json']);
const GENERATED_DIRECTORIES = Object.freeze(['dashboard-chunks', 'dashboard-assets']);
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.css', '.json']);

function dashboardGeneratedManifestPath(publicRoot) {
  return path.join(publicRoot, MANIFEST_NAME);
}

function collectDashboardSourceFiles(root) {
  const sourceRoot = path.join(root, 'src');
  const uiRoot = path.join(sourceRoot, 'ui');
  const absoluteFiles = new Set([
    path.join(root, 'vite.config.mjs'),
    path.join(root, 'scripts', 'dashboard-bundle-inventory.mjs'),
    path.join(root, 'package-lock.json'),
    path.join(root, 'public', 'dashboard.js'),
    ...listFiles(uiRoot).filter(isSourceFile)
  ].filter(fs.existsSync));
  const queue = [...absoluteFiles].filter(file => isSourceFile(file));

  while (queue.length) {
    const file = queue.pop();
    const text = fs.readFileSync(file, 'utf8');
    for (const specifier of relativeImportSpecifiers(text)) {
      const resolved = resolveLocalImport(file, specifier);
      if (!resolved || !isInside(sourceRoot, resolved) || absoluteFiles.has(resolved)) continue;
      absoluteFiles.add(resolved);
      if (isSourceFile(resolved)) queue.push(resolved);
    }
  }

  return [...absoluteFiles]
    .map(file => path.relative(root, file).replaceAll('\\', '/'))
    .sort();
}

function dashboardSourceHash(root) {
  const hash = crypto.createHash('sha256');
  for (const relative of collectDashboardSourceFiles(root)) {
    const file = path.join(root, ...relative.split('/'));
    const contents = normalizeSourceText(fs.readFileSync(file, 'utf8'));
    hash.update(relative, 'utf8');
    hash.update('\0');
    hash.update(contents, 'utf8');
    hash.update('\0');
  }
  return hash.digest('hex');
}

function dashboardAssetHashes(publicRoot) {
  const files = [];
  for (const name of GENERATED_FILES) {
    const file = path.join(publicRoot, name);
    if (fs.existsSync(file)) files.push(file);
  }
  for (const directory of GENERATED_DIRECTORIES) {
    files.push(...listFiles(path.join(publicRoot, directory)));
  }
  return Object.fromEntries(files
    .map(file => {
      const relative = path.relative(publicRoot, file).replaceAll('\\', '/');
      return [relative, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
    })
    .sort(([left], [right]) => left.localeCompare(right)));
}

function createDashboardGeneratedManifest(root, publicRoot) {
  return {
    schemaVersion: 1,
    sourceHash: dashboardSourceHash(root),
    assets: dashboardAssetHashes(publicRoot)
  };
}

function writeDashboardGeneratedManifest(root, publicRoot) {
  const manifest = createDashboardGeneratedManifest(root, publicRoot);
  fs.writeFileSync(dashboardGeneratedManifestPath(publicRoot), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

function verifyDashboardGeneratedState(root, publicRoot) {
  const manifestPath = dashboardGeneratedManifestPath(publicRoot);
  if (!fs.existsSync(manifestPath)) return false;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return false;
  }
  if (Number(manifest?.schemaVersion) !== 1) return false;
  if (manifest.sourceHash !== dashboardSourceHash(root)) return false;
  const expected = manifest.assets && typeof manifest.assets === 'object' ? manifest.assets : {};
  const actual = dashboardAssetHashes(publicRoot);
  const expectedNames = Object.keys(expected).sort();
  const actualNames = Object.keys(actual).sort();
  if (expectedNames.length !== actualNames.length) return false;
  for (let index = 0; index < expectedNames.length; index += 1) {
    const name = expectedNames[index];
    if (name !== actualNames[index] || expected[name] !== actual[name]) return false;
  }
  return true;
}

function relativeImportSpecifiers(text) {
  const results = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g;
  let match;
  while ((match = pattern.exec(text))) {
    const specifier = String(match[1] || '').split(/[?#]/, 1)[0];
    if (specifier.startsWith('.')) results.push(specifier);
  }
  return results;
}

function resolveLocalImport(importer, specifier) {
  const target = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    target,
    ...['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.css', '.json'].map(extension => `${target}${extension}`),
    ...['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.css', '.json'].map(extension => path.join(target, `index${extension}`))
  ];
  return candidates.find(candidate => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  }) || null;
}

function isInside(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isSourceFile(file) {
  return SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function normalizeSourceText(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

export {
  MANIFEST_NAME,
  collectDashboardSourceFiles,
  createDashboardGeneratedManifest,
  dashboardAssetHashes,
  dashboardGeneratedManifestPath,
  dashboardSourceHash,
  verifyDashboardGeneratedState,
  writeDashboardGeneratedManifest
};
