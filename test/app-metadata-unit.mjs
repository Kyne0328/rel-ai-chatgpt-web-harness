import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { getApplicationMetadata } from "../src/appMetadata.js";
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronPackage = JSON.parse(fs.readFileSync(path.join(root, 'electron', 'package.json'), 'utf8'));
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

assert.deepEqual(getApplicationMetadata(), {
  name: 'Rel.AI MCP',
  version: rootPackage.version,
  developer: {
    name: 'Kyne',
    username: 'Kyne0328',
    profileUrl: 'https://github.com/Kyne0328'
  },
  repositoryUrl: 'https://github.com/Kyne0328/rel-ai-chatgpt-web-harness',
  license: rootPackage.license
});
assert.deepEqual(rootPackage.author, { name: 'Kyne', url: 'https://github.com/Kyne0328' });
assert.deepEqual(electronPackage.author, {
  name: 'Kyne',
  email: 'Kyne0328@users.noreply.github.com',
  url: 'https://github.com/Kyne0328'
});
assert.equal(electronPackage.homepage, 'https://github.com/Kyne0328/rel-ai-chatgpt-web-harness');
assert.equal(rootPackage.productName, 'Rel.AI MCP');
assert.match(readme, /Created and maintained by <a href="https:\/\/github\.com\/Kyne0328"><strong>Kyne<\/strong><\/a>\./);
assert.doesNotMatch(JSON.stringify(electronPackage), /Kyne Anthony/);

console.log('Application metadata unit tests passed.');
