#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { normalizeConfig, makeDefaultContextConfig } from "../src/config.js";
import { updateWorkspace } from "../src/configEditor.js";
import { collectTextFiles, createCollectionPathFilter } from "../src/safety.js";
import { repoSnapshot, relaiReadAsync } from "../src/localRepoBridge.js";
import { relaiSearch } from "../src/bridge/search.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-context-'));
const configPath = path.join(tmp, 'config.json');
process.env.REL_AI_MCP_CONFIG = configPath;
const repo = path.join(tmp, 'repo');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
fs.mkdirSync(path.join(repo, '.dart_tool'), { recursive: true });
fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src', 'app.js'), `export function app() {}\n`);
fs.writeFileSync(path.join(repo, 'docs', 'extra.txt'), `outside-context-marker\n`);
fs.writeFileSync(path.join(repo, '.dart_tool', 'noise.txt'), `noise\n`);
fs.writeFileSync(path.join(repo, 'node_modules', 'noise.js'), `noise\n`);
fs.writeFileSync(path.join(repo, '.relaiignore'), `tmp-cache/\n`);
fs.mkdirSync(path.join(repo, 'tmp-cache'), { recursive: true });
fs.writeFileSync(path.join(repo, 'tmp-cache', 'ignored.txt'), `ignored\n`);
const shouldCollect = createCollectionPathFilter(repo, { excludePaths: ['.dart_tool'] });
const defaultCollection = createCollectionPathFilter(repo);
for (const genericPath of ['src/tmp/parser.ts', 'src/temp/parser.ts', 'src/logs/parser.ts', 'out/main.c']) {
  assert.equal(defaultCollection(genericPath), true, `generic repository path must remain collectable by default: ${genericPath}`);
}
assert.equal(defaultCollection('.output/cache.json'), false, 'framework output directories must remain excluded by default');
assert.equal(defaultCollection('playwright-report/index.html'), false, 'known test-report output must remain excluded by default');
const explicitTmpInclude = createCollectionPathFilter(repo, { includeRoots: ['src/tmp'] });
assert.equal(explicitTmpInclude('src'), true, 'an explicit nested include must keep its parent traversable');
assert.equal(explicitTmpInclude('src/tmp'), true, 'an explicit include root must override default generic directory exclusions');
assert.equal(explicitTmpInclude('src/tmp/parser.ts'), true, 'files below an explicitly included generic directory must remain collectable');
assert.equal(shouldCollect('src/app.js'), true);
assert.equal(shouldCollect('node_modules/noise.js'), false);
assert.equal(shouldCollect('.dart_tool/noise.txt'), false);
assert.equal(shouldCollect('tmp-cache/ignored.txt'), false, 'watcher filtering must honor .relaiignore through the shared collection policy');
execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });

assert.equal(makeDefaultContextConfig().snapshotMaxFiles, 3000);

let config = normalizeConfig({
  maxIndexFiles: 2222,
  workspaces: {
    app: {
      path: repo,
      context: { snapshotMaxFiles: 1, includeRoots: ['src'] }
    }
  }
});
assert.equal(Object.hasOwn(config, 'maxIndexFiles'), false, 'legacy global index limit must not persist');
assert.equal(Object.hasOwn(config.workspaces.app, 'fastTask'), false, 'normalized workspace must use context only');
assert.equal(config.workspaces.app.context.snapshotMaxFiles, 1);
assert.ok(config.workspaces.app.context.excludePaths.includes('.dart_tool'));
assert.equal(Object.hasOwn(config.workspaces.app.context, 'skipIndexForSmallTasks'), false);
assert.equal(Object.hasOwn(config.workspaces.app.context, 'preferChangedFiles'), false);

const workspace = { alias: 'app', ...config.workspaces.app };
const snapshot = await repoSnapshot(workspace, config, { includeFiles: true });
assert.equal(snapshot.effectiveMaxEntries, 1, 'workspace snapshot limit must control the initial repository map');
assert.deepEqual(snapshot.files, ['src/app.js']);

const directRead = await relaiReadAsync(workspace, config, { paths: ['docs/extra.txt'] });
assert.match(directRead.items[0].content, /outside-context-marker/, 'direct reads must not be limited by snapshot include roots');
const search = await relaiSearch(workspace, config, { pattern: 'outside-context-marker', fixed: true });
assert.equal(search.matches[0].path, 'docs/extra.txt', 'search must cover files outside the initial snapshot include roots');

const currentOnly = normalizeConfig({
  maxIndexFiles: 2500,
  workspaces: {
    legacyInput: {
      path: repo,
      fastTask: {
        enabled: false,
        maxIndexFiles: 2,
        includeRoots: ['src']
      }
    },
    fallback: { path: repo }
  }
});
assert.equal(currentOnly.workspaces.legacyInput.context.snapshotMaxFiles, 3000, 'legacy fastTask limits must be ignored');
assert.deepEqual(currentOnly.workspaces.legacyInput.context.includeRoots, [], 'legacy fastTask roots must be ignored');
assert.equal(Object.hasOwn(currentOnly.workspaces.legacyInput, 'fastTask'), false);
assert.equal(currentOnly.workspaces.fallback.context.snapshotMaxFiles, 3000, 'legacy global limits must be ignored');

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
let updated = updateWorkspace(config, {
  action: 'upsert',
  alias: 'app',
  path: repo,
  context: { snapshotMaxFiles: 123, includeRoots: ['src'], excludePaths: ['custom-cache'] },
  confirmDangerous: true
});
assert.equal(updated.ok, true);
assert.equal(updated.config.workspaces.find((item) => item.alias === 'app').context.snapshotMaxFiles, 123);
const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
assert.equal(Object.hasOwn(saved.workspaces.app, 'fastTask'), false);
assert.equal(saved.workspaces.app.context.snapshotMaxFiles, 123);

const tree = collectTextFiles(repo);
assert.ok(tree.files.includes('src/app.js'));
assert.ok(!tree.files.includes('.dart_tool/noise.txt'));
assert.ok(!tree.files.includes('node_modules/noise.js'));
assert.ok(!tree.files.includes('tmp-cache/ignored.txt'));

updated = updateWorkspace(saved, { action: 'delete', alias: 'app', confirmDelete: true });
assert.equal(updated.ok, true);
assert.equal(updated.config.workspaces.some((item) => item.alias === 'app'), false);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('Workspace context smoke passed');
