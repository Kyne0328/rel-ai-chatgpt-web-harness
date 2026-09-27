import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tunnel = JSON.parse(fs.readFileSync(path.join(root, 'vendor', 'tunnel-client', 'manifest.json'), 'utf8'));
const zoekt = JSON.parse(fs.readFileSync(path.join(root, 'vendor', 'zoekt', 'manifest.json'), 'utf8'));
const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'Rel.AI-MCP-Vendor-Update-Check'
};
const token = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
if (token) headers.Authorization = `Bearer ${token}`;

const checks = [
  {
    label: 'OpenAI tunnel-client',
    pinned: String(tunnel.releaseTag || `v${tunnel.version}`),
    url: 'https://api.github.com/repos/openai/tunnel-client/releases/latest',
    read: payload => String(payload?.tag_name || '')
  },
  {
    label: 'Sourcegraph Zoekt',
    pinned: String(zoekt?.upstream?.commit || ''),
    url: 'https://api.github.com/repos/sourcegraph/zoekt/commits/main',
    read: payload => String(payload?.sha || '')
  }
];

await verifyPinnedTunnelReleaseEvidence(tunnel);

let stale = false;
for (const check of checks) {
  const response = await fetch(check.url, { headers });
  if (!response.ok) throw new Error(`${check.label} upstream check failed with HTTP ${response.status}.`);
  const payload = await response.json();
  const current = check.read(payload);
  if (!current) throw new Error(`${check.label} upstream check returned no version/commit.`);
  if (current === check.pinned) {
    console.log(`${check.label}: pinned dependency is current (${check.pinned}).`);
    continue;
  }
  stale = true;
  console.warn(`::warning title=${check.label} update available::Pinned ${check.pinned}; upstream ${current}`);
}
if (stale) {
  console.error('One or more vendored runtime dependencies have upstream changes to review.');
  process.exitCode = 1;
}

async function verifyPinnedTunnelReleaseEvidence(manifest) {
  const tag = String(manifest.releaseTag || `v${manifest.version || ''}`);
  const response = await fetch(`https://api.github.com/repos/openai/tunnel-client/releases/tags/${encodeURIComponent(tag)}`, { headers });
  if (!response.ok) throw new Error(`OpenAI tunnel-client pinned release evidence check failed with HTTP ${response.status}.`);
  const release = await response.json();
  if (String(release?.tag_name || '') !== tag) throw new Error(`OpenAI tunnel-client pinned release evidence returned unexpected tag ${release?.tag_name || '(empty)'}.`);
  const assets = new Map((release?.assets || []).map(asset => [String(asset?.name || ''), asset]));
  for (const [key, item] of Object.entries(manifest.releaseEvidence || {})) {
    const asset = assets.get(String(item?.file || ''));
    if (!asset) throw new Error(`OpenAI tunnel-client release evidence ${key} is missing asset ${item?.file || '(unnamed)'}.`);
    const digest = String(asset?.digest || '').replace(/^sha256:/i, '').toLowerCase();
    if (digest !== String(item?.sha256 || '').toLowerCase()) {
      throw new Error(`OpenAI tunnel-client release evidence digest mismatch for ${item.file}.`);
    }
  }
  console.log(`OpenAI tunnel-client: verified ${Object.keys(manifest.releaseEvidence || {}).length} pinned release-evidence digests.`);
}
