import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNpm } from './npm-cli.mjs';
import { BUNDLE_INVENTORY_NAME, RENDERER_REFERENCE, verifyBundleInventory } from './dashboard-bundle-inventory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist', 'sbom.cdx.json');

function nativeReleaseComponents(tunnelManifest, zoektManifest, windowsProcessJobManifest) {
  return [
    ...platformArtifacts(tunnelManifest.platforms).map(({ platform, arch, artifact }) => ({
      type: 'application',
      'bom-ref': `pkg:generic/openai-tunnel-client@${tunnelManifest.version}?arch=${encodeURIComponent(arch)}&os=${encodeURIComponent(platform)}`,
      name: 'OpenAI tunnel-client',
      version: tunnelManifest.version,
      supplier: { name: 'OpenAI' },
      licenses: [{ license: { id: tunnelManifest.license } }],
      hashes: [{ alg: 'SHA-256', content: artifact.sha256 }],
      externalReferences: [
        { type: 'distribution', url: `${tunnelManifest.baseUrl}/${artifact.archive}` },
        { type: 'vcs', url: tunnelManifest.source }
      ],
      properties: [
        { name: 'rel.ai.platform', value: platform },
        { name: 'rel.ai.arch', value: arch },
        { name: 'rel.ai.file', value: artifact.file }
      ]
    })),
    ...zoektArtifacts(zoektManifest).map(({ platform, arch, role, artifact }) => ({
      type: 'application',
      'bom-ref': `pkg:generic/sourcegraph-zoekt@${zoektManifest.upstream.commit}?arch=${encodeURIComponent(arch)}&os=${encodeURIComponent(platform)}&role=${role}`,
      name: role === 'search' ? 'Zoekt search' : 'Zoekt index',
      version: zoektManifest.upstream.commit,
      licenses: [{ license: { id: zoektManifest.upstream.license } }],
      hashes: [{ alg: 'SHA-256', content: artifact.sha256 }],
      externalReferences: [{ type: 'vcs', url: zoektManifest.upstream.repository }],
      properties: [
        { name: 'rel.ai.platform', value: platform },
        { name: 'rel.ai.arch', value: arch },
        { name: 'rel.ai.file', value: artifact.file },
        { name: 'rel.ai.patchSet', value: zoektManifest.upstream.patchSet }
      ]
    })),
    ...windowsProcessJobComponents(windowsProcessJobManifest)
  ];
}

function windowsProcessJobComponents(manifest) {
  const companion = manifest?.provenance?.companion;
  if (manifest?.runtime !== 'nativeaot-win-x64' || companion?.runtimeIdentifier !== 'win-x64') {
    throw new Error('Windows process-job SBOM requires nativeaot-win-x64 companion provenance.');
  }
  for (const field of ['binarySha256', 'nativeSourceSha256', 'hostSourceSha256', 'projectSourceSha256']) {
    if (!/^[a-f0-9]{64}$/.test(manifest[field] || '')) {
      throw new Error(`Windows process-job SBOM requires a valid ${field}.`);
    }
  }
  for (const field of ['runtime', 'sdk']) {
    if (typeof companion[field] !== 'string' || !companion[field].trim()) {
      throw new Error(`Windows process-job SBOM requires companion ${field} provenance.`);
    }
  }

  const helperReference = `rel.ai:windows-process-job-host:sha256:${manifest.binarySha256}`;
  const runtimeReference = `pkg:generic/dotnet-nativeaot@${encodeURIComponent(companion.runtime)}?arch=x64&os=windows`;
  return [
    {
      type: 'application',
      'bom-ref': helperReference,
      name: 'Rel.AI Windows process-job host',
      hashes: [{ alg: 'SHA-256', content: manifest.binarySha256 }],
      properties: [
        { name: 'rel.ai.platform', value: 'win32' },
        { name: 'rel.ai.arch', value: 'x64' },
        { name: 'rel.ai.file', value: 'src/windows-process-job-host.exe' },
        { name: 'rel.ai.manifest', value: 'src/windows-process-job-host.manifest.json' },
        { name: 'rel.ai.runtime', value: manifest.runtime },
        { name: 'rel.ai.buildSdk', value: companion.sdk },
        ...['nativeSourceSha256', 'hostSourceSha256', 'projectSourceSha256']
          .map(field => ({ name: `rel.ai.${field}`, value: manifest[field] }))
      ]
    },
    {
      type: 'library',
      'bom-ref': runtimeReference,
      purl: runtimeReference,
      name: '.NET NativeAOT runtime',
      version: companion.runtime,
      licenses: [{ license: { id: 'MIT' } }],
      externalReferences: [{ type: 'vcs', url: 'https://github.com/dotnet/runtime' }],
      properties: [
        { name: 'rel.ai.runtimeIdentifier', value: companion.runtimeIdentifier },
        { name: 'rel.ai.bundledIn', value: helperReference },
        { name: 'rel.ai.licenseFile', value: 'src/windows-process-job-licenses/LICENSE.TXT' },
        { name: 'rel.ai.noticesFile', value: 'src/windows-process-job-licenses/THIRD-PARTY-NOTICES.TXT' }
      ]
    }
  ];
}

function appendNativeReleaseComponents(document, components) {
  const byReference = new Map((document.components || []).map(component => [component['bom-ref'], component]));
  for (const component of components) byReference.set(component['bom-ref'], component);
  document.components = [...byReference.values()];

  const dependencies = new Map((document.dependencies || []).map(dependency => [dependency.ref, {
    ...dependency,
    dependsOn: [...(dependency.dependsOn || [])]
  }]));
  for (const component of components) {
    const parent = component.properties?.find(property => property.name === 'rel.ai.bundledIn')?.value
      || document.metadata?.component?.['bom-ref'];
    if (!parent) continue;
    const dependency = dependencies.get(parent) || { ref: parent, dependsOn: [] };
    dependency.dependsOn = [...new Set([...dependency.dependsOn, component['bom-ref']])];
    dependencies.set(parent, dependency);
  }
  document.dependencies = [...dependencies.values()];
  return document;
}

function platformArtifacts(platforms) {
  const results = [];
  for (const [platform, platformSpec] of Object.entries(platforms || {})) {
    if (platformSpec.architectures) {
      for (const [arch, artifact] of Object.entries(platformSpec.architectures)) {
        results.push({ platform, arch, artifact });
      }
    } else {
      results.push({ platform, arch: normalizeManifestArch(platformSpec.architecture || 'x64'), artifact: platformSpec });
    }
  }
  return results;
}

function zoektArtifacts(manifest) {
  const results = [];
  for (const [platform, platformSpec] of Object.entries(manifest.platforms || {})) {
    const variants = platformSpec.architectures ? Object.entries(platformSpec.architectures) : [[normalizeManifestArch(platformSpec.architecture || 'x64'), platformSpec]];
    for (const [declaredArch, spec] of variants) {
      const arch = normalizeManifestArch(declaredArch || spec.architecture);
      for (const role of ['search', 'index']) {
        if (spec[role]) results.push({ platform, arch, role, artifact: spec[role] });
      }
    }
  }
  return results;
}

function normalizeManifestArch(value) {
  const arch = String(value || '').trim().toLowerCase();
  if (arch === 'amd64') return 'x64';
  if (arch === 'aarch64') return 'arm64';
  return arch || 'x64';
}

function mergeSbomGraph(document, addition, { rootReference } = {}) {
  const rootComponent = addition.metadata?.component;
  if (!rootComponent?.['bom-ref'] || !Array.isArray(addition.components) || !Array.isArray(addition.dependencies)) {
    throw new Error('SBOM input is missing component or dependency evidence.');
  }
  const references = new Map();
  const components = new Map((document.components || []).map(component => [component['bom-ref'], component]));
  const all = [rootComponent, ...addition.components];
  for (const component of all) {
    const reference = component === rootComponent && rootReference
      ? rootReference : component.purl || component['bom-ref'];
    if (!reference || (component.purl && !component.version)) throw new Error('SBOM component lacks version-qualified identity.');
    references.set(component['bom-ref'], reference);
    if (reference !== document.metadata?.component?.['bom-ref']) components.set(reference, { ...component, 'bom-ref': reference });
  }
  document.components = [...components.values()];
  const dependencies = new Map((document.dependencies || []).map(entry => [entry.ref, new Set(entry.dependsOn || [])]));
  for (const entry of addition.dependencies) {
    const ref = references.get(entry.ref);
    if (!ref) throw new Error(`SBOM dependency owner is absent: ${entry.ref}`);
    const targets = dependencies.get(ref) || new Set();
    for (const target of entry.dependsOn || []) {
      if (!references.has(target)) throw new Error(`SBOM dependency target is absent: ${target}`);
      targets.add(references.get(target));
    }
    dependencies.set(ref, targets);
  }
  const parent = document.metadata?.component?.['bom-ref'];
  const child = references.get(rootComponent['bom-ref']);
  if (parent !== child) {
    const targets = dependencies.get(parent) || new Set();
    targets.add(child);
    dependencies.set(parent, targets);
  }
  document.dependencies = [...dependencies].map(([ref, targets]) => ({ ref, dependsOn: [...targets].sort() }));
  return document;
}

function assertShippedInventory(document, { rootLock, electronLock, bundleInventory, nativeComponents }) {
  const components = document.components || [];
  const byReference = new Map(components.map(component => [component['bom-ref'], component]));
  const rootReference = document.metadata?.component?.['bom-ref'];
  if (!rootReference || byReference.size !== components.length) throw new Error('SBOM references are absent or duplicated.');
  byReference.set(rootReference, document.metadata.component);
  for (const dependency of document.dependencies || []) {
    if (!byReference.has(dependency.ref) || (dependency.dependsOn || []).some(ref => !byReference.has(ref))) {
      throw new Error(`SBOM has a dangling dependency reference: ${dependency.ref}`);
    }
  }
  for (const [name, lock] of [['electron', electronLock], ['electron-updater', electronLock], ['react', rootLock], ['react-dom', rootLock]]) {
    const version = lock.packages?.[`node_modules/${name}`]?.version;
    if (!version || !components.some(component => component.name === name && component.version === version)) {
      throw new Error(`SBOM is missing shipped ${name}@${version || 'unresolved'}.`);
    }
  }
  for (const component of [...bundleInventory.components, ...nativeComponents]) {
    if (!byReference.has(component['bom-ref'])) throw new Error(`SBOM is missing shipped component: ${component['bom-ref']}`);
  }
  return { components: components.length, dependencies: document.dependencies.length };
}

function npmRuntimeGraph(cwd) {
  const result = runNpm(['sbom', '--sbom-format', 'cyclonedx', '--omit', 'dev', '--package-lock-only', '--offline'], {
    cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(`npm sbom failed: ${result.error?.message || result.stderr || result.signal || result.status}`);
  }
  return JSON.parse(result.stdout);
}

function assembleShippedSbom() {
  const declaredVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).packageManager.split('@').at(-1);
  const version = runNpm(['--version'], { cwd: root, encoding: 'utf8' });
  if (version.status !== 0 || version.stdout.trim() !== declaredVersion) {
    throw new Error(`Generate the shipped SBOM through declared npm ${declaredVersion}; resolved ${version.stdout?.trim() || 'unavailable'}.`);
  }
  const readJson = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
  const rootLock = readJson('package-lock.json');
  const electronLock = readJson('electron/package-lock.json');
  const publicRoot = path.join(root, 'public');
  const bundleInventory = verifyBundleInventory(publicRoot, readJson(`public/${BUNDLE_INVENTORY_NAME}`));
  const rootGraph = npmRuntimeGraph(root);
  const document = { ...rootGraph, components: [], dependencies: [] };
  const rootReference = rootGraph.metadata.component.purl || rootGraph.metadata.component['bom-ref'];
  document.metadata = { ...rootGraph.metadata, component: { ...rootGraph.metadata.component, 'bom-ref': rootReference } };
  mergeSbomGraph(document, rootGraph);
  mergeSbomGraph(document, npmRuntimeGraph(path.join(root, 'electron')), { rootReference: 'rel.ai:desktop-package' });
  mergeSbomGraph(document, {
    metadata: { component: { type: 'application', name: 'Rel.AI dashboard renderer', 'bom-ref': RENDERER_REFERENCE } },
    components: bundleInventory.components, dependencies: bundleInventory.dependencies
  });
  const electronVersion = electronLock.packages?.['node_modules/electron']?.version;
  if (!electronVersion) throw new Error('Electron distribution version is unresolved.');
  const electronReference = `pkg:generic/electron@${electronVersion}`;
  const electronComponent = {
    type: 'application', name: 'electron', version: electronVersion, purl: electronReference, 'bom-ref': electronReference,
    licenses: [{ license: { id: 'MIT' } }],
    externalReferences: [{ type: 'vcs', url: 'https://github.com/electron/electron' }],
    properties: [{ name: 'rel.ai.shippedAs', value: 'Electron desktop runtime distribution' }]
  };
  const nativeComponents = nativeReleaseComponents(
    readJson('vendor/tunnel-client/manifest.json'), readJson('vendor/zoekt/manifest.json'),
    readJson('src/windows-process-job-host.manifest.json')
  );
  appendNativeReleaseComponents(document, [...nativeComponents, electronComponent]);
  assertShippedInventory(document, { rootLock, electronLock, bundleInventory, nativeComponents });
  return document;
}

function generateSbom() {
  const document = assembleShippedSbom();
  if (process.argv.includes('--check')) {
    console.log(`Verified shipped SBOM: ${document.components.length} components with desktop runtime, updater, renderer, and native inventory.`);
    return;
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`Generated ${path.relative(root, output)} with ${document.components.length} shipped components.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { generateSbom(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export { appendNativeReleaseComponents, assembleShippedSbom, assertShippedInventory, mergeSbomGraph, nativeReleaseComponents, normalizeManifestArch, platformArtifacts, zoektArtifacts };
