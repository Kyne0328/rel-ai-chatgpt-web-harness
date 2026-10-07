import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNpm } from './npm-cli.mjs';

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

function generateSbom() {
  const result = runNpm(['sbom', '--sbom-format', 'cyclonedx', '--omit', 'dev', '--package-lock-only'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || 'npm sbom failed.\n');
    process.exitCode = result.status || 1;
    return;
  }

  const document = JSON.parse(result.stdout);
  const tunnelManifest = JSON.parse(fs.readFileSync(path.join(root, 'vendor', 'tunnel-client', 'manifest.json'), 'utf8'));
  const zoektManifest = JSON.parse(fs.readFileSync(path.join(root, 'vendor', 'zoekt', 'manifest.json'), 'utf8'));
  const windowsProcessJobManifest = JSON.parse(fs.readFileSync(path.join(root, 'src', 'windows-process-job-host.manifest.json'), 'utf8'));
  const nativeComponents = nativeReleaseComponents(tunnelManifest, zoektManifest, windowsProcessJobManifest);
  appendNativeReleaseComponents(document, nativeComponents);

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`Generated ${path.relative(root, output)} with ${nativeComponents.length} pinned native release components.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) generateSbom();

export { appendNativeReleaseComponents, nativeReleaseComponents, normalizeManifestArch, platformArtifacts, zoektArtifacts };
