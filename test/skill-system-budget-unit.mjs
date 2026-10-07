import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildTaskBootstrap } from '../src/context/context-builder.js';
import { extensionSkillRecords, extensionsRoot } from '../src/extensions/registry.js';
import { discoverSkillInventory, discoverSkills, readDiscoveredSkill, readDiscoveredSkillAsync, selectRelevantSkills } from '../src/skillDiscovery.js';
import { syncBuiltinESMExports } from 'node:module';
import { compactForConnector } from '../src/tools/connector.js';
import { OPERATION_IDS as OP } from '../src/tools/operationIds.js';
import { callTool } from '../src/tools.js';
import { repoSnapshot, relaiReadAsync } from '../src/localRepoBridge.js';
import { flushAuditWrites } from '../src/audit.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';
import { runTestProcess } from './helpers/run-test-process.mjs';
import { fileURLToPath } from 'node:url';

const workerIndex = process.argv.indexOf('--worker-root');
if (workerIndex < 0) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-skill-budget-'));
  try {
    const result = await runTestProcess(process.execPath, [fileURLToPath(import.meta.url), '--worker-root', fixture], {
      cwd: process.cwd(), timeoutMs: 120000
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    assert.equal(result.terminationUncertain, false);
    assert.equal(result.exitCode, 0, 'skill-budget worker failed');
  } finally { await fs.promises.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  process.exit(0);
}
const root = path.resolve(process.argv[workerIndex + 1]);
assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
assert.match(path.basename(root), /^relai-skill-budget-/);
assert.deepEqual(fs.readdirSync(root), []);
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
  const unusableLowerRoot = path.join(root, 'user-root-is-a-file');
  fs.writeFileSync(unusableLowerRoot, 'Not a skills directory.');
  assert.deepEqual(discoverSkills(workspace, { config, userRoot: unusableLowerRoot }), cold,
    'an unused lower-priority source must not hide the complete project inventory');

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

  {
    const duplicateRepo = path.join(root, 'duplicate-repo');
    const duplicateRoot = path.join(duplicateRepo, '.agents', 'skills');
    const duplicateUserRoot = path.join(root, 'duplicate-user-skills');
    for (let index = 0; index < 300; index += 1) {
      const directory = path.join(duplicateRoot, `candidate-${String(index).padStart(3, '0')}`);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'SKILL.md'), skillSource(
        index % 2 ? 'invalid name' : 'shared-fixture',
        `Duplicate/invalid cache fixture ${index}.`
      ));
    }
    const projectDirectory = path.join(duplicateRoot, 'zz-project-winner');
    fs.mkdirSync(projectDirectory, { recursive: true });
    fs.writeFileSync(path.join(projectDirectory, 'SKILL.md'), skillSource('office-fixture', 'Late project winner.'));
    const userDirectory = path.join(duplicateUserRoot, 'office-fixture');
    fs.mkdirSync(userDirectory, { recursive: true });
    fs.writeFileSync(path.join(userDirectory, 'SKILL.md'), skillSource('office-fixture', 'Lower-priority user copy.'));

    const duplicateMetrics = {};
    const duplicates = finishInventory({ path: duplicateRepo }, { config, userRoot: duplicateUserRoot, metrics: duplicateMetrics }).skills;
    assert.deepEqual(duplicates.map(item => item.name), ['office-fixture', 'shared-fixture']);
    assert.equal(duplicateMetrics.skillMetadataReads, 302, 'invalid and duplicate candidates must not hide a late valid skill');
    assert.equal(duplicates.find(item => item.name === 'office-fixture')?.source, 'project');
    assert.equal(duplicates.find(item => item.name === 'office-fixture')?.description, 'Late project winner.', 'the late project skill retains precedence over extension and user copies');

    const evictedMetrics = {};
    const reread = discoverSkills(workspace, { config, userRoot, metrics: evictedMetrics });
    assert.deepEqual(reread, changed, 'cache eviction across roots must preserve the complete public inventory');
    assert.equal(evictedMetrics.skillMetadataReads, 100, 'the larger candidate inventory must evict old metadata rather than retain every root indefinitely');
    const rereadWarmMetrics = {};
    assert.deepEqual(discoverSkills(workspace, { config, userRoot, metrics: rereadWarmMetrics }), changed);
    assert.equal(rereadWarmMetrics.skillMetadataReads || 0, 0, 'the normal 100-skill inventory remains cacheable after eviction');
    assert.equal(rereadWarmMetrics.skillMetadataCacheHits, 100);
  }

  {
    const metadataRepo = path.join(root, 'metadata-repo');
    const metadataRoot = path.join(metadataRepo, '.agents', 'skills');
    const descriptions = [
      `  ${'x'.repeat(498)}  ${'tail'.repeat(1024)}  `,
      `  ${'x'.repeat(499)}🙂${'tail'.repeat(1024)}  `
    ];
    const fixtures = [
      ['missing-name', '---\ndescription: Missing name falls back.\n---\n'],
      ['empty-name', skillSource('""', 'Empty name falls back.')],
      ['invalid-name', skillSource('invalid name', 'Must remain rejected.')],
      ['oversized-name', skillSource('x'.repeat(10000), 'Must remain rejected.')],
      ['normalized-folder', skillSource('"  MiXeD-Name  "', 'Normalized name.')],
      ...descriptions.map((description, index) => [`description-${index}`, skillSource(`description-${index}`, JSON.stringify(description))])
    ];
    for (const [name, source] of fixtures) {
      const directory = path.join(metadataRoot, name);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'SKILL.md'), source);
    }
    const options = { userRoot: path.join(root, 'absent-metadata-user') };
    const metadata = discoverSkills({ path: metadataRepo }, options);
    assert.deepEqual(metadata.map(item => item.name), ['description-0', 'description-1', 'empty-name', 'missing-name', 'mixed-name']);
    for (const [index, description] of descriptions.entries()) {
      assert.equal(metadata.find(item => item.name === `description-${index}`)?.description, description.trim().slice(0, 500), 'cached descriptions retain the exact existing 500-code-unit result, including boundary spaces and split surrogate pairs');
    }
    const metadataWarmMetrics = {};
    assert.deepEqual(discoverSkills({ path: metadataRepo }, { ...options, metrics: metadataWarmMetrics }), metadata);
    assert.equal(metadataWarmMetrics.skillMetadataReads || 0, 0);
    assert.equal(metadataWarmMetrics.skillMetadataCacheHits, fixtures.length, 'invalid entries stay rejected on cache hits too');
  }

  {
    const hugeRepo = path.join(root, 'bounded-work');
    const candidates = path.join(hugeRepo, '.agents', 'skills');
    for (let index = 0; index < 1200; index++) {
      const directory = path.join(candidates, `folder-${String(index).padStart(4, '0')}`);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'SKILL.md'), skillSource(index % 2 ? 'invalid name' : 'same-skill', 'Scan budget fixture.'));
    }
    const originalReadDir = fs.readdirSync;
    const originalOpenDir = fs.opendirSync;
    let directoryReads = 0, directoryCloses = 0;
    fs.readdirSync = function(file, ...args) {
      assert.notEqual(path.resolve(file), candidates, 'discovery must not materialize the entire huge directory');
      return originalReadDir.call(this, file, ...args);
    };
    fs.opendirSync = function(file, ...args) {
      const directory = originalOpenDir.call(this, file, ...args);
      if (path.resolve(file) !== candidates) return directory;
      const read = directory.readSync.bind(directory), close = directory.closeSync.bind(directory);
      directory.readSync = () => { directoryReads++; return read(); };
      directory.closeSync = () => { directoryCloses++; return close(); };
      return directory;
    };
    syncBuiltinESMExports();
    let partial;
    try {
      partial = discoverSkillInventory({ path: hugeRepo }, { config, userRoot, scanLimits: { maxEntries: 32 } });
      assert.ok(partial.discovery.work.units <= 32);
      assert.ok(directoryReads <= 32, 'enumeration is paid from the shared page budget');
      assert.equal(partial.discovery.resumable, true);
      assert.equal(partial.discovery.reason, 'work-budget');
      assert.equal(partial.discovery.complete, false);
      assert.ok(partial.skills.every(skill => skill.source === 'project'), 'an incomplete project source must not fall through to extension/user sources');
      assert.throws(() => readDiscoveredSkill({ path: hugeRepo }, 'office-fixture', { config, userRoot, scanLimits: { maxEntries: 32 } }), /incomplete/i);
    } finally { fs.readdirSync = originalReadDir; fs.opendirSync = originalOpenDir; syncBuiltinESMExports(); }
    const boot = buildTaskBootstrap({ skills: partial.skills, skillDiscovery: partial.discovery }, 'compact');
    assert.equal(boot.skillDiscovery.truncated, true, 'compact context must preserve incomplete-discovery evidence');
    assert.deepEqual(compactForConnector(OP.SNAPSHOT, { ok: true, skills: partial.skills, skillDiscovery: partial.discovery }).skillDiscovery,
      partial.discovery, 'the public connector must deliver incomplete-discovery evidence');
    assert.equal(boot.skills, undefined);
    assert.equal(buildTaskBootstrap({ skills: partial.skills, skillDiscovery: partial.discovery }, 'full').skillDiscovery.truncated, true);
    const late = path.join(candidates, 'zz-late-valid');
    fs.mkdirSync(late);
    fs.writeFileSync(path.join(late, 'SKILL.md'), skillSource('late-valid', 'Late valid project winner.'));
    const lateInventory = finishInventory({ path: hugeRepo }, { config, userRoot, scanLimits: { units: 128 } });
    assert.ok(lateInventory.skills.some(skill => skill.name === 'late-valid' && skill.source === 'project'), 'resumption must eventually reach a late valid project skill');
    const loaded = await readDiscoveredSkillAsync({ path: hugeRepo }, 'late-valid', { config, userRoot, scanLimits: { units: 64 } });
    assert.match(loaded.content, /Late valid project winner/);
    const previousConfig = process.env.REL_AI_MCP_CONFIG, previousBackground = process.env.REL_AI_REDUCED_BACKGROUND_WORK;
    const configFile = path.join(root, 'public-skill-config.json');
    fs.writeFileSync(configFile, JSON.stringify({ version: 3, stateDir: path.join(root, 'public-state'),
      workspaces: { skills: { path: hugeRepo, commands: {}, testCommands: {} } } }));
    process.env.REL_AI_MCP_CONFIG = configFile;
    process.env.REL_AI_REDUCED_BACKGROUND_WORK = '1';
    const publicContext = { principal: 'local:trusted', publicHttpOnly: true, transportType: 'benchmark' };
    let workId;
    try {
      const task = await callTool('relai_work', { action: 'begin', workspace: 'skills', bootstrap: 'none' }, publicContext);
      workId = task.work_id;
      let complete, pageCount = 0;
      for (; pageCount < 200; pageCount++) {
        const response = await callTool('relai_snapshot', { workspace: 'skills', work_id: workId }, publicContext);
        assert.equal(response.ok, true);
        assert.ok(response.skillDiscovery, 'actual public wrapper must deliver discovery progress');
        if (response.skillDiscovery.resumable || response.skillDiscovery.resumed)
          assert.doesNotMatch(response.warning || '', /Reuse the prior result/);
        if (response.skillDiscovery.complete) { complete = response; break; }
      }
      assert.ok(pageCount > 1, 'large invalid/duplicate-heavy collection must use multiple public calls');
      assert.ok(complete?.skills.some(skill => skill.name === 'late-valid' && skill.source === 'project'));
      const read = await callTool('relai_read', { workspace: 'skills', work_id: workId, skill: 'late-valid' }, publicContext);
      assert.match(read.items[0].content, /Late valid project winner/);
    } finally {
      if (workId) await callTool('relai_work', { action: 'cancel', work_id: workId }, publicContext);
      await flushAuditWrites();
      await repositoryIntelligence.shutdown();
      if (previousConfig === undefined) delete process.env.REL_AI_MCP_CONFIG; else process.env.REL_AI_MCP_CONFIG = previousConfig;
      if (previousBackground === undefined) delete process.env.REL_AI_REDUCED_BACKGROUND_WORK; else process.env.REL_AI_REDUCED_BACKGROUND_WORK = previousBackground;
    }
    const cancelledLookup = new AbortController();
    const timer = setImmediate(() => cancelledLookup.abort(new Error('cancel exhaustive named lookup')));
    await assert.rejects(readDiscoveredSkillAsync({ path: hugeRepo }, 'absent-skill', { config, userRoot, signal: cancelledLookup.signal, scanLimits: { units: 4 } }), /cancel exhaustive named lookup/);
    clearImmediate(timer);
    assert.ok(directoryCloses > 0, 'completed and cancelled scans close their directory handles');
    const byteRepo = path.join(root, 'byte-limited-project');
    const byteDirectory = path.join(byteRepo, '.agents', 'skills', 'large-metadata');
    fs.mkdirSync(byteDirectory, { recursive: true });
    fs.writeFileSync(path.join(byteDirectory, 'SKILL.md'), skillSource('large-metadata', 'x'.repeat(150000)));
    const priorOpen = fs.openSync, priorRead = fs.readSync, priorClose = fs.closeSync;
    const watched = new Set();
    let actualBytes = 0, byteComplete;
    const watchedFile = path.join(byteDirectory, 'SKILL.md');
    fs.openSync = function(file, ...args) {
      const fd = priorOpen.call(this, file, ...args);
      if (typeof file === 'string' && path.resolve(file) === watchedFile) watched.add(fd);
      return fd;
    };
    fs.readSync = function(fd, ...args) {
      const count = priorRead.call(this, fd, ...args);
      if (watched.has(fd)) actualBytes += count;
      return count;
    };
    fs.closeSync = function(fd, ...args) { watched.delete(fd); return priorClose.call(this, fd, ...args); };
    syncBuiltinESMExports();
    try {
      for (let page = 0; page < 30; page++) {
        actualBytes = 0;
        const value = discoverSkillInventory({ path: byteRepo }, { userRoot, scanLimits: { bytes: 65536 } });
        assert.ok(actualBytes <= 65536, 'actual file reads must stay within each page allowance');
        assert.ok(value.discovery.work.bytes <= 65536);
        if (value.discovery.complete) { byteComplete = value; break; }
      }
      assert.ok(byteComplete?.skills.some(skill => skill.name === 'large-metadata'));
      assert.equal(watched.size, 0, 'completed chunked reads close the owned file handle');
    } finally {
      fs.openSync = priorOpen; fs.readSync = priorRead; fs.closeSync = priorClose; syncBuiltinESMExports();
    }
    const clockDescriptor = Object.getOwnPropertyDescriptor(Date, 'now');
    const performanceDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
    let clock = 0;
    try {
      Object.defineProperty(Date, 'now', { configurable: true, value: () => (clock += 2) });
      const timed = discoverSkillInventory({ path: hugeRepo }, { scanLimits: { maxDurationMs: 1 } });
      assert.equal(timed.discovery.reason, 'time-budget');
      assert.equal(timed.discovery.work.units, 0);
    } finally {
      if (clockDescriptor) Object.defineProperty(Date, 'now', clockDescriptor);
      else delete Date.now;
    }
    assert.deepEqual(Object.getOwnPropertyDescriptor(Date, 'now'), clockDescriptor,
      'the time-budget fixture must restore the original wall clock');
    assert.deepEqual(Object.getOwnPropertyDescriptor(performance, 'now'), performanceDescriptor,
      'the time-budget fixture must not replace the monotonic clock');
  }
  {
    const deadlineRepo = path.join(root, 'bridge-deadline-repo');
    const deadlineRoot = path.join(deadlineRepo, '.agents', 'skills');
    const deadlineHome = path.join(root, 'bridge-deadline-home');
    const deadlineDirectory = path.join(deadlineRoot, 'deadline-fixture');
    fs.mkdirSync(deadlineDirectory, { recursive: true });
    fs.mkdirSync(path.join(deadlineHome, '.agents', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(deadlineDirectory, 'SKILL.md'),
      skillSource('deadline-fixture', 'Bridge deadline fixture.'));
    const deadlineWorkspace = { alias: 'bridge-deadline', path: deadlineRepo, commands: {}, testCommands: {} };
    const deadlineConfig = { stateDir: path.join(root, 'bridge-deadline-state') };
    const homeDescriptor = Object.getOwnPropertyDescriptor(os, 'homedir');
    const active = new AbortController();
    const isDeadline = error => error?.code === 'SKILL_DISCOVERY_INCOMPLETE' && error.reason === 'deadline';
    try {
      Object.defineProperty(os, 'homedir', { configurable: true, value: () => deadlineHome });
      syncBuiltinESMExports();
      const expiredContext = { deadlineAtMs: Date.now() - 1, signal: active.signal };
      await assert.rejects(repoSnapshot(deadlineWorkspace, deadlineConfig, {}, expiredContext), isDeadline,
        'snapshot skill discovery must receive an expired handler deadline even before its signal aborts');
      await assert.rejects(relaiReadAsync(deadlineWorkspace, deadlineConfig,
        { skill: 'deadline-fixture' }, expiredContext), isDeadline,
      'named skill reads must receive an expired handler deadline even before its signal aborts');

      const clockDescriptor = Object.getOwnPropertyDescriptor(Date, 'now');
      const performanceDescriptor = Object.getOwnPropertyDescriptor(performance, 'now');
      const priorOpenDir = fs.opendirSync;
      let clock = Date.now();
      const deadlineAtMs = clock + 5;
      let directoryOpens = 0, directoryCloses = 0;
      try {
        Object.defineProperty(Date, 'now', { configurable: true, value: () => clock });
        fs.opendirSync = function(file, ...args) {
          const directory = priorOpenDir.call(this, file, ...args);
          if (path.resolve(file) !== deadlineRoot) return directory;
          directoryOpens++;
          const close = directory.closeSync.bind(directory);
          directory.closeSync = () => { directoryCloses++; return close(); };
          // Synchronous discovery can cross a parent deadline before a timer
          // delivers an abort. Advance only while opening this isolated source.
          clock = deadlineAtMs;
          return directory;
        };
        syncBuiltinESMExports();
        await assert.rejects(relaiReadAsync(deadlineWorkspace, deadlineConfig,
          { skill: 'deadline-fixture' }, { deadlineAtMs, signal: active.signal }), isDeadline,
        'named skill reads must stop at the parent deadline during a synchronous scan');
        assert.equal(directoryOpens, 1, 'the fixture must reach the synchronous source-open boundary');
        assert.equal(directoryCloses, directoryOpens, 'deadline failure must release its source directory');
        assert.equal(active.signal.aborted, false, 'the deadline check must not rely on timer delivery');
      } finally {
        fs.opendirSync = priorOpenDir;
        if (clockDescriptor) Object.defineProperty(Date, 'now', clockDescriptor);
        else delete Date.now;
        syncBuiltinESMExports();
      }
      assert.deepEqual(Object.getOwnPropertyDescriptor(Date, 'now'), clockDescriptor);
      assert.deepEqual(Object.getOwnPropertyDescriptor(performance, 'now'), performanceDescriptor);
    } finally {
      if (homeDescriptor) Object.defineProperty(os, 'homedir', homeDescriptor);
      else delete os.homedir;
      syncBuiltinESMExports();
    }
  }
  {
    const sharedRepo = path.join(root, 'shared-deadline-repo');
    const sharedRoot = path.join(sharedRepo, '.agents', 'skills');
    for (let index = 0; index < 4; index++) {
      const directory = path.join(sharedRoot, 'shared-' + index);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'SKILL.md'),
        skillSource('shared-' + index, 'Shared listing deadline fixture.'));
    }
    const sharedWorkspace = { path: sharedRepo };
    const sharedOptions = { userRoot: path.join(root, 'shared-deadline-user'), scanLimits: { units: 1 } };
    const clockDescriptor = Object.getOwnPropertyDescriptor(Date, 'now');
    const priorOpenDir = fs.opendirSync;
    let clock = Date.now();
    const deadlineAt = clock + 5;
    let expireOnRead = false, expiredRead = false;
    let directoryOpens = 0, directoryCloses = 0;
    try {
      Object.defineProperty(Date, 'now', { configurable: true, value: () => clock });
      fs.opendirSync = function(file, ...args) {
        const directory = priorOpenDir.call(this, file, ...args);
        if (path.resolve(file) !== sharedRoot) return directory;
        directoryOpens++;
        const read = directory.readSync.bind(directory), close = directory.closeSync.bind(directory);
        directory.readSync = () => {
          const entry = read();
          if (expireOnRead) {
            expireOnRead = false;
            expiredRead = true;
            clock = deadlineAt;
          }
          return entry;
        };
        directory.closeSync = () => { directoryCloses++; return close(); };
        return directory;
      };
      syncBuiltinESMExports();
      const first = discoverSkillInventory(sharedWorkspace, sharedOptions);
      assert.equal(first.discovery.resumable, true);
      assert.ok(first.discovery.scanId, 'the first observer must own resumable listing progress');
      assert.equal(directoryOpens, 1);
      assert.equal(directoryCloses, 0, 'the first page must retain its incomplete source');

      expireOnRead = true;
      const expired = discoverSkillInventory(sharedWorkspace, {
        ...sharedOptions, deadlineAt, scanLimits: { units: 8 }
      });
      assert.equal(expiredRead, true, 'the second observer must expire during a credited synchronous read');
      assert.equal(expired.discovery.reason, 'deadline');
      assert.equal(directoryCloses, 0, 'a caller deadline must not close another observer\'s shared listing');

      const resumed = discoverSkillInventory(sharedWorkspace, sharedOptions);
      assert.equal(resumed.discovery.resumed, true);
      assert.equal(resumed.discovery.scanId, first.discovery.scanId,
        'a valid observer must continue the original scan after another observer expires');
      assert.ok(resumed.discovery.work.totalUnits > first.discovery.work.totalUnits,
        'work credited before the caller deadline must remain part of the shared progress');
      assert.equal(directoryOpens, 1, 'resumption must keep the original directory handle');
      const completed = finishInventory(sharedWorkspace, { userRoot: sharedOptions.userRoot });
      assert.deepEqual(completed.skills.map(skill => skill.name), ['shared-0', 'shared-1', 'shared-2', 'shared-3']);
      assert.equal(directoryCloses, directoryOpens, 'completing the shared scan must release every source handle');
    } finally {
      fs.opendirSync = priorOpenDir;
      if (clockDescriptor) Object.defineProperty(Date, 'now', clockDescriptor);
      else delete Date.now;
      syncBuiltinESMExports();
    }
    assert.deepEqual(Object.getOwnPropertyDescriptor(Date, 'now'), clockDescriptor);
  }
  {
    const cancelled = new AbortController();
    const cancellation = new Error('Cancelled skill discovery fixture');
    cancelled.abort(cancellation);
    assert.throws(() => discoverSkillInventory(workspace, { config, signal: cancelled.signal }), error => error === cancellation);
    assert.throws(() => readDiscoveredSkill(workspace, 'skill-042', { config, signal: cancelled.signal }), error => error === cancellation);
    const recoveryConfig = { stateDir: path.join(root, 'unreconciled-extension-state') };
    const recoveryRoot = extensionsRoot(recoveryConfig);
    fs.mkdirSync(recoveryRoot, { recursive: true });
    const marker = path.join(recoveryRoot, '.install-transaction-pending.json');
    fs.writeFileSync(marker, 'invalid transaction fixture');
    const inventory = discoverSkillInventory({ path: path.join(root, 'empty-repo') }, { config: recoveryConfig, userRoot });
    assert.equal(inventory.discovery.truncated, true);
    assert.ok(inventory.discovery.reason === 'extension-recovery-unverified');
    assert.equal(fs.readFileSync(marker, 'utf8'), 'invalid transaction fixture', 'bounded discovery must defer recovery instead of mutating its records');
    assert.deepEqual(inventory.skills, []);
    fs.unlinkSync(marker);
    const ticket = path.join(recoveryRoot, '.operation-123-aaaaaaaa.lock');
    fs.writeFileSync(ticket, '');
    const activeOperation = discoverSkillInventory({ path: path.join(root, 'empty-repo') }, { config: recoveryConfig, userRoot });
    assert.ok(activeOperation.discovery.reason === 'extension-recovery-unverified');
    assert.equal(fs.existsSync(ticket), true, 'discovery must not reconcile an active operation ticket');
    fs.unlinkSync(ticket);
    fs.writeFileSync(path.join(recoveryRoot, '.operation-not-a-ticket.txt'), 'Unrelated file.');
    fs.writeFileSync(path.join(recoveryRoot, '.install-transaction-not-a-marker.log'), 'Unrelated file.');
    assert.equal(finishInventory({ path: path.join(root, 'empty-repo') }, { config: recoveryConfig, userRoot }).discovery.complete, true,
      'unrelated filenames must not be mistaken for recovery protocol records');
    fs.appendFileSync(path.join(extensionDirectory, 'relai-extension.json'), '\n');
    const extensionBytes = discoverSkillInventory({ path: path.join(root, 'empty-repo') }, {
      config, userRoot, scanLimits: { units: 1 }
    });
    assert.equal(extensionBytes.discovery.complete, false);
    assert.equal(extensionBytes.discovery.work.bytes, 0, 'extension verification is suspended before exceeding its page budget');
    finishInventory({ path: path.join(root, 'empty-repo') }, { config, userRoot });
    const oldPath = process.env.PATH;
    try {
      const manifestFile = path.join(extensionDirectory, 'relai-extension.json');
      const probeManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      probeManifest.requires.commands = ['missing-command-budget-fixture'];
      fs.writeFileSync(manifestFile, JSON.stringify(probeManifest));
      process.env.PATH = Array.from({ length: 100 }, (_, index) => path.join(root, 'missing-command-dir-' + index)).join(path.delimiter);
      const probes = discoverSkillInventory({ path: path.join(root, 'empty-repo') }, { config, userRoot, scanLimits: { maxWorkUnits: 16 } });
      assert.ok(probes.discovery.reason === 'work-budget', 'command-readiness probes must be charged to the shared work budget');
      assert.equal(probes.discovery.work.units, 16);
      assert.deepEqual(probes.skills, []);
      probeManifest.requires.commands = [];
      fs.writeFileSync(manifestFile, JSON.stringify(probeManifest));
    } finally { process.env.PATH = oldPath; }
  }
  fs.writeFileSync(path.join(extensionDirectory, 'SKILL.md'), `${extensionSkill}\nTampered\n`);
  const extensionChangedMetrics = {};
  assert.equal(extensionSkillRecords(config, { metrics: extensionChangedMetrics }).length, 0, 'changed extension bytes must fail cached integrity verification');
  assert.equal(extensionChangedMetrics.extensionFileHashReads, 1, 'changed extension file is rehashed before it can be trusted');

  {
    const beyond = path.join(repo, '.agents', 'skills', 'zz-beyond-inventory');
    fs.mkdirSync(beyond);
    fs.writeFileSync(path.join(beyond, 'SKILL.md'), skillSource('outside-inventory', 'Named lookup beyond the display limit.'));
    assert.equal(finishInventory(workspace, { userRoot }).skills.length, 100);
    const outside = await readDiscoveredSkillAsync(workspace, 'outside-inventory', { userRoot });
    assert.match(outside.content, /beyond the display limit/);
  }
  {
    const restartRepo = path.join(root, 'restart-source'), restartRoot = path.join(restartRepo, '.agents', 'skills');
    fs.mkdirSync(path.join(restartRoot, 'one'), { recursive: true });
    fs.writeFileSync(path.join(restartRoot, 'one', 'SKILL.md'), skillSource('one', 'Initial source.'));
    const partial = discoverSkillInventory({ path: restartRepo }, { userRoot, scanLimits: { units: 1 } });
    assert.equal(partial.discovery.complete, false);
    fs.mkdirSync(path.join(restartRoot, 'two'));
    fs.writeFileSync(path.join(restartRoot, 'two', 'SKILL.md'), skillSource('two', 'New source entry.'));
    const restarted = discoverSkillInventory({ path: restartRepo }, { userRoot });
    assert.equal(restarted.discovery.restartReason, 'source-changed');
    assert.ok(finishInventory({ path: restartRepo }, { userRoot }).skills.some(skill => skill.name === 'two'));
    const expiring = discoverSkillInventory({ path: restartRepo }, { userRoot, scanLimits: { units: 1, ttlMs: 1 } });
    assert.equal(expiring.discovery.complete, false);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(discoverSkillInventory({ path: restartRepo }, { userRoot }).discovery.restartReason, 'expired');
  }
  {
    const collationRepo = path.join(root, 'collation-source'), collationRoot = path.join(collationRepo, '.agents', 'skills');
    for (let index = 0; index < 127; index++) {
      const directory = path.join(collationRoot, 'a-' + String(index).padStart(3, '0'));
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'SKILL.md'), skillSource('duplicate-collation', 'Prefix duplicate.'));
    }
    // Distinct filesystem names can compare equal under locale collation. They
    // must remain individually reachable across the 128-candidate window.
    for (const [directoryName, name] of [['\u00e9', 'composed-name'], ['e\u0301', 'decomposed-name']]) {
      const directory = path.join(collationRoot, directoryName);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'SKILL.md'), skillSource(name, 'Unicode collation fixture.'));
    }
    const names = finishInventory({ path: collationRepo }, { userRoot }).skills.map(skill => skill.name);
    if (fs.readdirSync(collationRoot).length === 129)
      assert.ok(names.includes('composed-name') && names.includes('decomposed-name'));
    else assert.ok(names.includes('decomposed-name'), 'normalizing filesystems expose one physical Unicode directory');
  }

  console.log('Skill discovery cache, compact-context budget, relevance bound, and extension integrity cache contracts passed.');
} finally {
  // Parent removes this exact fixture after all process/SQLite handles close.
}

function skillSource(name, description) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nUse the smallest relevant workflow.\n`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function finishInventory(workspace, options = {}) {
  for (let pages = 0; pages < 2000; pages++) {
    const value = discoverSkillInventory(workspace, options);
    assert.ok(!value.discovery.work || value.discovery.work.units <= 2048);
    assert.ok(!value.discovery.work || value.discovery.work.bytes <= 16 * 1024 * 1024);
    if (value.discovery.complete) return value;
    assert.equal(value.discovery.resumable, true, JSON.stringify(value.discovery));
  }
  throw new Error('Skill fixture failed to complete its bounded pages.');
}
