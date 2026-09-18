import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedVersion = fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim().replace(/^v/, '');
const currentVersion = String(process.versions.node || '').trim().replace(/^v/, '');

if (!expectedVersion) {
  throw new Error('.node-version must declare an exact Node.js version.');
}

if (currentVersion !== expectedVersion) {
  console.error(`Rel.AI MCP requires Node.js ${expectedVersion}; current runtime is ${currentVersion || 'unknown'}. Use the version declared in .node-version.`);
  process.exitCode = 1;
} else {
  console.log(`Using declared Node.js ${expectedVersion}.`);
}
