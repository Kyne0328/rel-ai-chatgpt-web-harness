import assert from 'node:assert/strict';
import fs from 'node:fs';

const electronPackage = JSON.parse(fs.readFileSync(new URL('../electron/package.json', import.meta.url), 'utf8'));
const main = fs.readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
const rootPackage = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const electronPackager = fs.readFileSync(new URL('../scripts/electron-package.mjs', import.meta.url), 'utf8');
const tunnelManifest = JSON.parse(fs.readFileSync(new URL('../vendor/tunnel-client/manifest.json', import.meta.url), 'utf8'));

assert.equal(tunnelManifest.version, '0.0.15');
assert.equal(tunnelManifest.releaseTag, 'v0.0.15');
assert.equal(tunnelManifest.distribution, 'full');
assert.equal(tunnelManifest.baseUrl.endsWith('/v0.0.15'), true);
for (const item of Object.values(tunnelManifest.releaseEvidence || {})) {
  assert.match(item.file, /v0\.0\.15/);
  assert.match(item.sha256, /^[a-f0-9]{64}$/);
}
assert.equal(Object.keys(tunnelManifest.releaseEvidence || {}).length, 4);
for (const spec of tunnelSpecs(tunnelManifest)) {
  assert.match(spec.archive, /^tunnel-client-v0\.0\.15-/);
  assert.doesNotMatch(spec.archive, /runtime|cloudflared/i);
  assert.equal(spec.archiveEntry, spec.file, 'v0.0.15 full artifacts must use the reviewed root-level executable entry');
  assert.equal(Number.isInteger(spec.archiveSize) && spec.archiveSize > 0, true);
  assert.match(spec.archiveSha256, /^[a-f0-9]{64}$/);
  assert.equal(Number.isInteger(spec.size) && spec.size > 0, true);
  assert.match(spec.sha256, /^[a-f0-9]{64}$/);
}

assert.ok(electronPackage.build.files.includes('desktop-host.js'));
assert.ok(electronPackage.build.files.includes('secure-tunnel-runtime.js'));
assert.ok(electronPackage.build.files.includes('tunnel-log-parser.js'));
assert.ok(electronPackage.build.files.includes('tunnel-recovery-supervisor.js'));
assert.ok(electronPackage.build.files.includes('tunnel-credentials.js'));
assert.equal(electronPackage.build.files.some(file => /ngrok|gateway-client|public-connection-runtime/i.test(file)), false);
for (const platform of ['win', 'linux', 'mac']) {
  const resource = electronPackage.build[platform].extraResources.find(item => item.to === 'bin/tunnel-client');
  assert.ok(resource, `${platform} must package OpenAI tunnel-client`);
  assert.equal(resource.from, '../vendor/tunnel-client');
}
assert.doesNotMatch(main, /createGatewayClient|managedNgrok|createPublicConnectionRuntime|createApprovalTokenManager/);
assert.equal(rootPackage.scripts['fetch:ngrok'], undefined);
assert.equal(rootPackage.scripts['verify:ngrok'], undefined);
assert.equal(rootPackage.scripts['gateway:acceptance'], undefined);
assert.match(String(rootPackage.scripts['fetch:tunnel-client'] || ''), /scripts\/fetch-tunnel-client\.mjs/, 'tunnel-client fetching must stay available without freezing the command spelling');
assert.match(electronPackager, /ensureTunnelClient\(platform, targetArch\)/);
assert.match(electronPackager, /OpenAI tunnel-client is missing.*fetching the pinned/);
assert.match(electronPackager, /OpenAI tunnel-client verification/);
console.log('secure-tunnel-packaging-contract-unit: ok');

function tunnelSpecs(manifest) {
  const specs = [];
  for (const platformSpec of Object.values(manifest.platforms || {})) {
    if (platformSpec?.architectures) specs.push(...Object.values(platformSpec.architectures));
    else specs.push(platformSpec);
  }
  return specs.filter(Boolean);
}
