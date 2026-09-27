import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertTunnelClientManifest, normalizeTunnelClientArch, resolveTunnelClientPlatformSpec } from './tunnel-client-utils.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'vendor', 'tunnel-client', 'manifest.json'), 'utf8'));
assertTunnelClientManifest(manifest);
const requested = (process.env.TUNNEL_CLIENT_PLATFORMS || process.platform).split(',').map(value => value.trim()).filter(Boolean);
const targetArch = normalizeTunnelClientArch(process.env.REL_AI_TARGET_ARCH || process.arch);

for (const platform of requested) {
  const spec = resolveTunnelClientPlatformSpec(manifest, platform, targetArch);
  if (!spec) throw new Error(`Unsupported tunnel-client platform/architecture: ${platform}/${targetArch}`);
  const file = path.join(root, 'vendor', 'tunnel-client', platform, spec.file);
  if (!fs.existsSync(file)) throw new Error(`OpenAI tunnel-client is missing for ${platform}/${targetArch}. Run npm run fetch:tunnel-client.`);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size !== spec.size) throw new Error(`OpenAI tunnel-client size mismatch for ${platform}/${targetArch}. Run npm run fetch:tunnel-client.`);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (hash !== spec.sha256) throw new Error(`OpenAI tunnel-client SHA-256 mismatch for ${platform}/${targetArch}.`);
  if (platform === process.platform && targetArch === normalizeTunnelClientArch(process.arch)) verifyNativeCli(file);
  console.log(`Verified OpenAI tunnel-client ${manifest.version} for ${platform}/${targetArch}: ${hash}`);
}

function verifyNativeCli(file) {
  const versionOutput = runCli(file, ['--version'], 'version');
  if (!new RegExp(`(?:^|\\D)${escapeRegExp(manifest.version)}(?:\\D|$)`).test(versionOutput)) {
    throw new Error(`OpenAI tunnel-client reported an unexpected version: ${versionOutput.trim() || '(empty)'}`);
  }

  const runHelp = runCli(file, ['run', '--help'], 'run help');
  for (const flag of [
    '--control-plane.tunnel-id',
    '--control-plane.api-key',
    '--mcp.server-url',
    '--mcp.extra-headers',
    '--mcp.discovery-extra-headers',
    '--health.listen-addr',
    '--health.url-file',
    '--health.show-details',
    '--log.format',
    '--log.level'
  ]) {
    if (!runHelp.includes(flag)) throw new Error(`OpenAI tunnel-client ${manifest.version} is missing required run flag ${flag}.`);
  }

  const fullDistributionChecks = [
    { args: ['doctor', '--help'], pattern: /Validate tunnel-client configuration/i, label: 'doctor' },
    { args: ['profiles', '--help'], pattern: /Manage tunnel-client YAML profiles/i, label: 'profiles' },
    { args: ['admin', 'tunnels', '--help'], pattern: /tunnel inspection and CRUD|List tunnels|Create a tunnel/i, label: 'admin tunnels' },
    { args: ['codex', '--help'], pattern: /Codex assistant surface|Codex/i, label: 'codex' }
  ];
  for (const check of fullDistributionChecks) {
    const output = runCli(file, check.args, `${check.label} help`);
    if (!check.pattern.test(output)) throw new Error(`OpenAI tunnel-client ${manifest.version} full distribution check failed for ${check.label}.`);
  }
}

function runCli(file, args, label) {
  const env = { ...process.env };
  delete env.CONTROL_PLANE_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_ADMIN_KEY;
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000, env });
  if (result.error) throw new Error(`OpenAI tunnel-client ${label} could not start: ${result.error.message}`, { cause: result.error });
  if (result.signal) throw new Error(`OpenAI tunnel-client ${label} was terminated by ${result.signal}.`);
  if (result.status !== 0) throw new Error(`OpenAI tunnel-client ${label} failed with exit code ${result.status ?? 1}: ${(result.stderr || result.stdout || '').trim()}`);
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
