import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// These package roots are authoring/type surfaces, not Electron runtime trees.
const NON_ELECTRON_ROOTS = new Set(['examples', 'types']);
const PLATFORM_KEYS = { win32: 'win', linux: 'linux', darwin: 'mac' };

function relativeRoot(value) {
  assert.equal(typeof value, 'string', 'Package file roots must be strings.');
  const relative = value.replace(/\/$/, '');
  assert.ok(relative && !relative.includes('\\') && !path.posix.isAbsolute(relative)
    && !/[:*?![\]{}]/.test(relative) && relative.split('/').every(part => part && part !== '.' && part !== '..'),
  `Package file root must be a literal contained path: ${value}`);
  return relative;
}

function declaredDirectories(sourceRoot, rootPackage) {
  assert.ok(Array.isArray(rootPackage.files), 'Root package must declare its runtime file roots.');
  return rootPackage.files.map(value => ({ value, relative: relativeRoot(value) }))
    .filter(({ value, relative }) => value.endsWith('/') || fs.statSync(path.join(sourceRoot, relative), { throwIfNoEntry: false })?.isDirectory())
    .map(({ relative }) => relative);
}

function assertRuntimeResourceMappings({ sourceRoot, rootPackage, electronPackage, platform }) {
  const platformKey = PLATFORM_KEYS[platform];
  assert.ok(platformKey, `Unsupported runtime parity platform: ${platform}`);
  const common = electronPackage.build?.extraResources || [];
  const platformResources = electronPackage.build?.[platformKey]?.extraResources || [];
  const resources = [...common, ...platformResources];
  for (const resource of resources) relativeRoot(resource.to);
  const declared = declaredDirectories(sourceRoot, rootPackage);
  assert.equal(new Set(declared).size, declared.length, 'Root package must not declare duplicate runtime roots.');
  const mappings = [];
  for (const relative of declared) {
    const matches = common.filter(item => item.from === `../${relative}` && item.to === relative);
    if (NON_ELECTRON_ROOTS.has(relative)) {
      assert.equal(resources.some(item => item.from === `../${relative}` || item.to === relative
        || String(item.to || '').startsWith(`${relative}/`)), false,
      `Non-Electron package root must stay explicitly excluded: ${relative}`);
      continue;
    }
    assert.equal(matches.length, 1, `Declared runtime root needs exactly one Electron mapping: ${relative}`);
    const resource = matches[0];
    // Vendored grammar assets retain their existing manifest-driven selection and validation.
    const filter = relative === 'vendor/tree-sitter' ? ['manifest.json', '**/*.wasm'] : ['**/*'];
    assert.deepEqual(resource.filter, filter, `Electron runtime root must use its complete-tree contract: ${relative}`);
    mappings.push({ relative, resource, filter, additions: [] });
  }

  const bin = mappings.find(mapping => mapping.relative === 'bin');
  if (bin) {
    for (const [name, filter] of [
      ['tunnel-client', ['manifest.json', `${platform}/**`]],
      ['zoekt', ['manifest.json', 'LICENSE', `${platform}/**`]]
    ]) {
      const matches = platformResources.filter(item => item.from === `../vendor/${name}` && item.to === `bin/${name}`);
      assert.equal(matches.length, 1, `Packaged bin requires exactly one declared vendor mapping: ${name}`);
      assert.deepEqual(matches[0].filter, filter, `Unexpected vendor packaging filter: ${name}`);
      bin.additions.push({ relative: `vendor/${name}`, resource: matches[0], filter });
    }
  }

  // No other resource may inject files into a verified tree.
  for (const mapping of mappings) {
    const allowed = new Set([mapping.resource, ...mapping.additions.map(addition => addition.resource)]);
    for (const resource of resources) {
      if (resource.to === mapping.relative || resource.to.startsWith(`${mapping.relative}/`)
        || mapping.relative.startsWith(`${resource.to}/`)) {
        assert.ok(allowed.has(resource), `Unreviewed resource overlaps runtime root ${mapping.relative}: ${resource.to}`);
      }
    }
  }
  return mappings;
}

function collectTree(directory, prefix = '') {
  assert.ok(fs.lstatSync(directory).isDirectory(), `Runtime tree is not a directory: ${directory}`);
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const target = path.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Runtime tree must not contain symbolic links: ${target}`);
    if (entry.isDirectory()) files.push(...collectTree(target, relative));
    else {
      assert.ok(entry.isFile(), `Runtime tree entry must be a regular file: ${target}`);
      files.push(relative);
    }
  }
  return files.sort();
}

function selectedFiles(directory, filter) {
  if (filter.length === 1 && filter[0] === '**/*') return collectTree(directory);
  return collectTree(directory).filter(file => filter.some(pattern => path.matchesGlob(file, pattern)));
}

function containedDirectory(root, relative) {
  let directory = path.resolve(root);
  const rootEntry = fs.lstatSync(directory);
  assert.ok(!rootEntry.isSymbolicLink() && rootEntry.isDirectory(),
    `Runtime root must be a real directory: ${directory}`);
  for (const part of relativeRoot(relative).split('/')) {
    directory = path.join(directory, part);
    const entry = fs.lstatSync(directory);
    assert.ok(!entry.isSymbolicLink() && entry.isDirectory(),
      `Runtime root must contain only real directories: ${directory}`);
  }
  return directory;
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assertPackagedRuntimeParity(options) {
  const { sourceRoot, resourcesRoot } = options;
  const mappings = assertRuntimeResourceMappings(options);
  const results = [];
  for (const mapping of mappings) {
    const expected = new Map();
    const addTree = (relative, destination, filter) => {
      const directory = containedDirectory(sourceRoot, relative);
      for (const file of selectedFiles(directory, filter)) {
        const target = destination ? `${destination}/${file}` : file;
        assert.ok(!expected.has(target), `Packaged runtime resource collision: ${mapping.relative}/${target}`);
        expected.set(target, path.join(directory, file));
      }
    };
    addTree(mapping.relative, '', mapping.filter);
    for (const addition of mapping.additions) {
      addTree(addition.relative, addition.resource.to.slice(`${mapping.relative}/`.length), addition.filter);
    }
    const packagedRoot = containedDirectory(resourcesRoot, mapping.relative);
    const actual = collectTree(packagedRoot);
    const actualSet = new Set(actual);
    const missing = [...expected.keys()].filter(file => !actualSet.has(file));
    const unexpected = actual.filter(file => !expected.has(file));
    assert.deepEqual({ missing, unexpected }, { missing: [], unexpected: [] },
      `Packaged runtime file set differs: ${mapping.relative}`);
    for (const [file, source] of expected) {
      assert.equal(digest(path.join(packagedRoot, file)), digest(source),
        `Packaged runtime SHA-256 differs: ${mapping.relative}/${file}`);
    }
    results.push({ root: mapping.relative, files: actual.length });
  }
  return results;
}

export { assertRuntimeResourceMappings, assertPackagedRuntimeParity };
