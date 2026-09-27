import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildTaskBootstrap } from '../src/context/context-builder.js';
import { extensionSkillRecords, extensionsRoot } from '../src/extensions/registry.js';
import { discoverSkills, selectRelevantSkills } from '../src/skillDiscovery.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-skill-budget-'));
const repo = path.join(root, 'repo');
const userRoot = path.join(root, 'user-skills');
const stateDir = path.join(root, 'state');
const workspace = { alias: 'app', path: repo, commands: {}, testCommands: {} };
const config = { stateDir, workspaces: { app: workspace } };

try {
  fs.mkdirSync(path.join(repo, '.agents', 'skills'), { recursive: true });
  fs.mkdirSync(userRoot, { recursive: true });

  for (let index = 0; index < 100; index += 1) {
    const directory = path.join(repo, '.agents', 'skills', `skill-${String(index).padStart(3, '0')}`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'SKILL.md'), skillSource(
      `skill-${String(index).padStart(3, '0')}`,
      `Handles repository migration topic${index} with focused implementation guidance.`
    ));
  }

  const coldMetrics = {};
  const cold = discoverSkills(workspace, { config, userRoot, metrics: coldMetrics });
  assert.equal(cold.length, 100, 'skill discovery keeps the documented 100-skill bound');
  assert.equal(coldMetrics.skillMetadataReads, 100, 'cold discovery parses each skill metadata file once');

  const warmMetrics = {};
  const warm = discoverSkills(workspace, { config, userRoot, metrics: warmMetrics });
  assert.deepEqual(warm, cold, 'warm discovery preserves the same public skill inventory');
  assert.equal(warmMetrics.skillMetadataReads || 0, 0, 'unchanged warm discovery must not reread skill frontmatter');
  assert.equal(warmMetrics.skillMetadataCacheHits, 100, 'unchanged warm discovery reuses all parsed skill metadata');

  const changedFile = path.join(repo, '.agents', 'skills', 'skill-042', 'SKILL.md');
  fs.writeFileSync(changedFile, skillSource('skill-042', 'Handles repository migration topic42 with updated database rollout guidance.'));
  const changedMetrics = {};
  const changed = discoverSkills(workspace, { config, userRoot, metrics: changedMetrics });
  assert.equal(changedMetrics.skillMetadataReads, 1, 'one changed SKILL.md reparses only that metadata record');
  assert.equal(changedMetrics.skillMetadataCacheHits, 99, 'unchanged skill metadata remains cached after one-file mutation');
  assert.match(changed.find(item => item.name === 'skill-042')?.description || '', /updated database/i);

  const compact = buildTaskBootstrap({
    manifests: ['package.json'],
    projectInstructions: {},
    skills: changed,
    hints: [],
    git: {},
    truncated: false,
    fileCount: 100
  }, 'compact');
  assert.equal(compact.skills, undefined, 'compact task bootstrap must not inject the full discovered-skill inventory');

  const suggested = selectRelevantSkills(changed, 'Use the updated database rollout guidance for migration topic42.', { limit: 3 });
  assert.equal(suggested[0]?.name, 'skill-042', 'relevance selection still surfaces the matching skill');
  assert.ok(suggested.length <= 3, 'relevance selection stays bounded to the requested compact limit');
  const suggestionBytes = Buffer.byteLength(JSON.stringify(suggested), 'utf8');
  assert.ok(suggestionBytes <= 1500, `suggested skill metadata exceeded 1500-byte budget: ${suggestionBytes}`);

  const extensionRoot = extensionsRoot(config);
  const extensionDirectory = path.join(extensionRoot, 'office-fixture');
  fs.mkdirSync(extensionDirectory, { recursive: true });
  const extensionSkill = skillSource(
    'office-fixture',
    'Creates and edits DOCX Word documents, XLSX Excel spreadsheets, and PPTX PowerPoint presentations.'
  );
  fs.writeFileSync(path.join(extensionDirectory, 'SKILL.md'), extensionSkill);
  const manifest = {
    schemaVersion: 1,
    id: 'office-fixture',
    name: 'Office fixture',
    version: '1.0.0',
    description: 'Creates and edits DOCX Word documents, XLSX Excel spreadsheets, and PPTX PowerPoint presentations.',
    kind: 'skill',
    compatibility: { relai: '>=1.0.0 <2.0.0' },
    publisher: { name: 'Rel.AI tests' },
    repository: 'https://github.com/example/office-fixture',
    permissions: [],
    requires: { commands: [], platforms: [] },
    entrypoints: { skill: 'SKILL.md' },
    files: [{ path: 'SKILL.md', sha256: sha256(extensionSkill) }]
  };
  fs.writeFileSync(path.join(extensionDirectory, 'relai-extension.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const extensionColdMetrics = {};
  assert.equal(extensionSkillRecords(config, { metrics: extensionColdMetrics }).length, 1);
  assert.equal(extensionColdMetrics.extensionManifestReads, 1, 'cold extension discovery reads the manifest once');
  assert.equal(extensionColdMetrics.extensionFileHashReads, 1, 'cold extension discovery verifies packaged skill bytes once');

  const extensionWarmMetrics = {};
  assert.equal(extensionSkillRecords(config, { metrics: extensionWarmMetrics }).length, 1);
  assert.equal(extensionWarmMetrics.extensionManifestReads || 0, 0, 'warm extension discovery reuses the parsed manifest');
  assert.equal(extensionWarmMetrics.extensionManifestCacheHits, 1);
  assert.equal(extensionWarmMetrics.extensionFileHashReads || 0, 0, 'warm extension discovery must not rehash unchanged package files');
  assert.equal(extensionWarmMetrics.extensionFileVerificationCacheHits, 1);

  fs.writeFileSync(path.join(extensionDirectory, 'SKILL.md'), `${extensionSkill}\nTampered\n`);
  const extensionChangedMetrics = {};
  assert.equal(extensionSkillRecords(config, { metrics: extensionChangedMetrics }).length, 0, 'changed extension bytes must fail cached integrity verification');
  assert.equal(extensionChangedMetrics.extensionFileHashReads, 1, 'changed extension file is rehashed before it can be trusted');

  console.log('Skill discovery cache, compact-context budget, relevance bound, and extension integrity cache contracts passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function skillSource(name, description) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nUse the smallest relevant workflow.\n`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
