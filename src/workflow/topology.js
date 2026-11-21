import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MAX_DEPTH = 6;
const MAX_MANIFESTS = 2000;
const TOPOLOGY_RECHECK_MS = 250;
const MANIFEST_NAMES = new Set(['package.json', 'pubspec.yaml', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'Makefile']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt', '.turbo', '.cache', '.relai', '.rel-ai', 'state']);
const cache = new Map();

function discoverRepositoryTopology(rootPath, { fresh = false } = {}) {
  const root = path.resolve(String(rootPath || '.'));
  const now = Date.now();
  const cached = cache.get(root);
  if (!fresh && cached && now - cached.checkedAt < TOPOLOGY_RECHECK_MS) {
    return structuredClone(cached.value);
  }
  if (!fresh && cached && probeManifestSignature(cached.manifests) === cached.signature) {
    cached.checkedAt = now;
    return structuredClone(cached.value);
  }
  const collection = collectManifests(root);
  const manifests = collection.manifests;
  const signature = manifestSignature(manifests);
  if (!collection.truncated && cached?.signature === signature) {
    cached.checkedAt = now;
    return structuredClone(cached.value);
  }
  const packages = linkWorkspaceDependencies(manifests.map(item => packageFromManifest(root, item)).filter(Boolean));
  const value = {
    version: 2,
    root,
    manifests: manifests.map(item => item.relative),
    packages,
    manifestCount: manifests.length,
    manifestLimit: MAX_MANIFESTS,
    truncated: collection.truncated,
    fingerprint: crypto.createHash('sha256').update(signature).digest('hex')
  };
  if (collection.truncated) cache.delete(root);
  else {
    cache.set(root, { signature, manifests, value, checkedAt: now });
    if (cache.size > 32) cache.delete(cache.keys().next().value);
  }
  return structuredClone(value);
}

function collectManifests(root) {
  const found = [];
  const queue = [{ absolute: root, depth: 0 }];
  let truncated = false;
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try { entries = fs.readdirSync(current.absolute, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (current.depth >= MAX_DEPTH || SKIP_DIRS.has(entry.name) || looksSensitive(entry.name)) continue;
        queue.push({ absolute: path.join(current.absolute, entry.name), depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !MANIFEST_NAMES.has(entry.name)) continue;
      if (found.length >= MAX_MANIFESTS) { truncated = true; return { manifests: found.sort((a, b) => a.relative.localeCompare(b.relative)), truncated }; }
      const absolute = path.join(current.absolute, entry.name);
      let stat;
      try { stat = fs.statSync(absolute, { bigint: true }); } catch { continue; }
      if (!stat.isFile()) continue;
      found.push({ absolute, relative: normalize(path.relative(root, absolute)), stamp: manifestStamp(stat) });
    }
  }
  return { manifests: found.sort((a, b) => a.relative.localeCompare(b.relative)), truncated };
}

function packageFromManifest(root, manifest) {
  const packagePath = normalize(path.dirname(manifest.relative)) || '.';
  const name = path.basename(manifest.relative);
  if (name === 'package.json') return npmPackage(root, manifest, packagePath);
  const ecosystem = name === 'pubspec.yaml' ? 'flutter'
    : name === 'go.mod' ? 'go'
      : name === 'Cargo.toml' ? 'cargo'
        : ['pyproject.toml', 'requirements.txt'].includes(name) ? 'python'
          : name === 'Makefile' ? 'make' : '';
  if (!ecosystem) return null;
  return {
    id: packageId(ecosystem, packagePath), path: packagePath, ecosystem, manifest: manifest.relative,
    name: packagePath === '.' ? path.basename(root) : path.basename(packagePath), scripts: {},
    sourceRoots: existingRoots(root, packagePath, ['src', 'lib', 'app']),
    testRoots: existingRoots(root, packagePath, ['test', 'tests', '__tests__']), dependencies: [], workspaceDependencies: []
  };
}

function npmPackage(root, manifest, packagePath) {
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(manifest.absolute, 'utf8')); } catch {}
  const dependencies = Object.keys({
    ...(object(pkg.dependencies)), ...(object(pkg.devDependencies)),
    ...(object(pkg.peerDependencies)), ...(object(pkg.optionalDependencies))
  }).sort();
  return {
    id: packageId('npm', packagePath), path: packagePath, ecosystem: 'npm', manifest: manifest.relative,
    name: String(pkg.name || (packagePath === '.' ? path.basename(root) : path.basename(packagePath))),
    scripts: object(pkg.scripts),
    sourceRoots: existingRoots(root, packagePath, ['src', 'lib', 'app']),
    testRoots: existingRoots(root, packagePath, ['test', 'tests', '__tests__']), dependencies, workspaceDependencies: []
  };
}

function linkWorkspaceDependencies(packages) {
  const packageIdByName = new Map(packages.filter(item => item.name).map(item => [item.name, item.id]));
  return packages.map(item => ({
    ...item,
    workspaceDependencies: [...new Set((item.dependencies || []).map(name => packageIdByName.get(name)).filter(Boolean))].sort()
  }));
}

function invalidateRepositoryTopology(rootPath, changedFiles = []) {
  const root = path.resolve(String(rootPath || '.'));
  const cached = cache.get(root);
  if (!cached) return false;
  const normalized = [...new Set((changedFiles || []).map(normalize).filter(Boolean))];
  if (!normalized.length || normalized.some(isManifestPath) || normalized.some(file => changesPackageRootShape(root, cached.value, file))) {
    cache.delete(root);
    return true;
  }
  return false;
}

function manifestSignature(manifests) {
  return JSON.stringify(manifests.map(item => [item.relative, item.stamp]));
}

function manifestStamp(stat) {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function probeManifestSignature(manifests = []) {
  const current = [];
  for (const manifest of manifests) {
    let stat;
    try { stat = fs.statSync(manifest.absolute, { bigint: true }); } catch { return null; }
    if (!stat.isFile()) return null;
    current.push({ ...manifest, stamp: manifestStamp(stat) });
  }
  return manifestSignature(current);
}

function isManifestPath(filePath) {
  return MANIFEST_NAMES.has(path.basename(normalize(filePath)));
}

function changesPackageRootShape(root, topology, filePath) {
  for (const pkg of topology?.packages || []) {
    for (const name of ['src', 'lib', 'app', 'test', 'tests', '__tests__']) {
      const candidate = normalize(pkg.path === '.' ? name : `${pkg.path}/${name}`);
      if (filePath !== candidate && !filePath.startsWith(`${candidate}/`)) continue;
      const known = (pkg.sourceRoots || []).includes(candidate) || (pkg.testRoots || []).includes(candidate);
      let exists = false;
      try { exists = fs.statSync(path.join(root, candidate)).isDirectory(); } catch {}
      if (known !== exists) return true;
    }
  }
  return false;
}

function packageForPath(topology, filePath) {
  const target = normalize(filePath);
  return [...(topology?.packages || [])]
    .filter(item => item.path === '.' || target === item.path || target.startsWith(`${item.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0] || null;
}

function packageId(ecosystem, packagePath) { return packagePath === '.' ? `${ecosystem}:root` : `${ecosystem}:${packagePath}`; }
function existingRoots(root, packagePath, names) {
  return names.map(name => normalize(packagePath === '.' ? name : `${packagePath}/${name}`))
    .filter(relative => { try { return fs.statSync(path.join(root, relative)).isDirectory(); } catch { return false; } });
}
function looksSensitive(name) { return /secret|credential|token|private|keychain/i.test(name); }
function normalize(value) { return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, ''); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function clearTopologyCache() { cache.clear(); }

export { TOPOLOGY_RECHECK_MS, clearTopologyCache, discoverRepositoryTopology, invalidateRepositoryTopology, packageForPath };
