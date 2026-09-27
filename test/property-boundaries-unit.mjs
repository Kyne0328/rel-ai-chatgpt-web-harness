import assert from 'node:assert/strict';
import fc from 'fast-check';
import { sanitizeDisplayText } from '../src/taskObservability.js';
import { parseExtensionManifest } from '../src/extensions/registry.js';

const tokenChars = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-'];
const secretArbitrary = fc.array(fc.constantFrom(...tokenChars), { minLength: 8, maxLength: 48 }).map(parts => parts.join(''));
const segmentArbitrary = fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'), { minLength: 1, maxLength: 24 })
  .map(parts => parts.join(''))
  .filter(value => !value.startsWith('-') && !value.endsWith('-'));

fc.assert(fc.property(secretArbitrary, secret => {
  const sanitized = sanitizeDisplayText(
    `Authorization: Bearer ${secret}; password=${secret}; api_key=${secret}`,
    1000
  );
  assert.equal(sanitized.includes(secret), false, `secret survived display sanitization: ${sanitized}`);
}), { numRuns: 150 });

fc.assert(fc.property(segmentArbitrary, segment => {
  const unsafe = `../${segment}/SKILL.md`;
  assert.throws(() => parseExtensionManifest(manifestWithPath(unsafe)), /safe relative paths|entrypoints\.skill/i);
}), { numRuns: 100 });

fc.assert(fc.property(segmentArbitrary, segment => {
  const safe = `references/${segment}.md`;
  const manifest = parseExtensionManifest(manifestWithPath(safe));
  assert.equal(manifest.files[0].path, safe);
  assert.equal(manifest.entrypoints.skill, safe);
}), { numRuns: 100 });

console.log('Property-based boundary contracts passed.');

function manifestWithPath(filePath) {
  return {
    schemaVersion: 1,
    id: 'property-test-extension',
    name: 'Property test extension',
    version: '1.0.0',
    description: 'Property-based extension manifest boundary fixture.',
    kind: 'skill',
    compatibility: { relai: '>=1.0.0 <2.0.0' },
    publisher: { name: 'Rel.AI test' },
    repository: 'https://example.test/property-extension',
    permissions: ['workspace.read'],
    requires: { commands: [], platforms: [] },
    entrypoints: { skill: filePath },
    files: [{ path: filePath, sha256: '0'.repeat(64) }]
  };
}
