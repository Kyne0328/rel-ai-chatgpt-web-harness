import { spawnSync } from 'node:child_process';

const version = String(process.argv[2] || '').trim().replace(/^v/i, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: npm run release:promote -- <major.minor.patch>');
  process.exit(2);
}

const repository = String(process.env.GITHUB_REPOSITORY || 'Kyne0328/rel-ai-chatgpt-web-harness').trim();
const executable = process.platform === 'win32' ? 'gh.exe' : 'gh';
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
