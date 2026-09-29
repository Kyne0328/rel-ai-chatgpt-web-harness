import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredDocuments = ['PRIVACY.md', 'TERMS.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md'];
for (const file of requiredDocuments) {
  assert.equal(fs.existsSync(path.join(root, file)), true, `${file} must be present in the repository`);
  assert.ok(fs.readFileSync(path.join(root, file), 'utf8').trim().length > 200, `${file} must contain substantive policy text`);
}

const privacy = fs.readFileSync(path.join(root, 'PRIVACY.md'), 'utf8');
assert.match(privacy, /bounded tool inputs and results/i);
assert.match(privacy, /180 days/i);
assert.match(privacy, /usage measurement is always enabled/i);
assert.match(privacy, /on by default/i);
assert.match(privacy, /safeStorage/);
assert.match(privacy, /Clear all local data/i);

const terms = fs.readFileSync(path.join(root, 'TERMS.md'), 'utf8');
assert.match(terms, /do not reduce, replace, or restrict rights granted.*Apache License/is);
assert.match(terms, /local development harness/i);
assert.match(terms, /Third-party services/i);

const settings = fs.readFileSync(path.join(root, 'src', 'ui', 'features', 'settings', 'react.js'), 'utf8');
for (const file of requiredDocuments) assert.match(settings, new RegExp(file.replaceAll('.', '\\.')));
assert.match(settings, /Legal & privacy/);
assert.doesNotMatch(settings, /bounded tool results/i, 'About must not restore the removed implementation-focused privacy summary');

const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const file of requiredDocuments) assert.ok(rootPackage.files.includes(file), `${file} must ship in the npm/package allowlist`);

const electronPackage = JSON.parse(fs.readFileSync(path.join(root, 'electron', 'package.json'), 'utf8'));
const extraResources = electronPackage.build?.extraResources || [];
for (const file of requiredDocuments) {
  assert.ok(extraResources.some(entry => entry?.from === `../${file}` && entry?.to === file), `${file} must ship with desktop releases`);
}

const thirdParty = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
assert.match(thirdParty, /openai\/tunnel-client/i);
assert.match(thirdParty, /Sourcegraph Zoekt/i);
assert.match(thirdParty, /Tree-sitter grammar WASM/i);
assert.match(thirdParty, /SBOM/i);

console.log('Legal, privacy, security, and third-party notice surfaces are packaged and discoverable.');
