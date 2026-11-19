import { spawnSync } from 'node:child_process';
import { assertPromotableCandidate } from './release-artifacts.mjs';

const version = String(process.argv[2] || '').trim().replace(/^v/i, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: npm run release:promote -- <major.minor.patch>');
  process.exit(2);
}

const repository = String(process.env.GITHUB_REPOSITORY || 'Kyne0328/rel-ai-chatgpt-web-harness').trim();
const executable = process.platform === 'win32' ? 'gh.exe' : 'gh';
const inspection = spawnSync(executable, [
  'release', 'view', version,
  '--repo', repository,
  '--json', 'tagName,isDraft,isPrerelease,assets'
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
if (inspection.error || inspection.status !== 0) {
  console.error(`Could not inspect release candidate: ${inspection.error?.message || inspection.stderr?.trim() || 'GitHub CLI failed.'}`);
  process.exit(inspection.status || 1);
}
let candidate;
try {
  candidate = JSON.parse(inspection.stdout);
} catch {
  console.error('GitHub CLI returned invalid release candidate metadata.');
  process.exit(1);
}
try {
  assertPromotableCandidate(version, candidate);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const result = spawnSync(executable, [
  'release', 'edit', version,
  '--repo', repository,
  '--prerelease=false',
  '--latest'
], { stdio: 'inherit' });

if (result.error) {
  console.error(`Could not run GitHub CLI: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Promoted Rel.AI MCP ${version} to the stable/latest release channel.`);
