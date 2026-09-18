import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { relaiCodeInspect, isTestPath } from "../src/bridge/codeIntelligence.js";
import { planEdit } from '../src/executionPlanner.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-code-intel-'));
const workspace = {
  alias: 'fixture',
  path: root,
  testCommands: { test: 'npm test', typecheck: 'npm run typecheck' },
  context: {}
};

function write(relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

try {
  write('package.json', JSON.stringify({
    scripts: {
      test: 'node test/math.test.js',
      typecheck: 'tsc --noEmit',
      lint: 'eslint src test'
    }
  }, null, 2));
  write('src/math.js', "export function add(left, right) {\n  return left + right;\n}\n");
  write('src/service.js', "const { add } = require('./math');\nfunction total(values) {\n  return values.reduce((sum, value) => add(sum, value), 0);\n}\nmodule.exports = { total };\n");
  write('src/index.js', "const { total } = require('./service');\nconsole.log(total([1, 2]));\n");
  write('test/math.test.js', "const { add } = require('../src/math');\nif (add(1, 2) !== 3) process.exit(1);\n");
  write('test/check.mjs', "import { add } from '../src/math.js';\nif (add(2, 3) !== 5) process.exit(1);\n");
  write('src/unrelated.js', 'export const label = \'unrelated\';\n');
  write('src/structural.js', "export function greet(name) {\n  return `hello ${name}`;\n}\n");

  assert.equal(isTestPath('test/math.test.js'), true);
  assert.equal(isTestPath('test/check.mjs'), true);
  assert.equal(isTestPath('src/math.js'), false);

  const symbol = await relaiCodeInspect(workspace, {}, { action: 'symbol', symbol: 'add' });
  assert.equal(symbol.ok, true);
  assert.equal(symbol.intelligence.primary, 'relai-native');
  assert.equal(symbol.index.mode, 'persistent-tree-sitter-sqlite');
  assert.equal(symbol.index.freshness, 'current');
  assert.equal(symbol.index.cacheHit, false);
  assert.equal(symbol.definitionCount, 1);
  assert.equal(symbol.definitions[0].path, 'src/math.js');
  assert.ok(symbol.referenceCount >= 2);
  assert.ok(symbol.callCount >= 2);
  assert.match(symbol.definitions[0].sourceSha256 || '', /^[a-f0-9]{64}$/);

  const structuralSymbol = await relaiCodeInspect(workspace, {}, { action: 'symbol', symbol: 'greet' });
  assert.equal(structuralSymbol.definitionCount, 1);
  assert.equal(structuralSymbol.definitions[0].provider, 'tree-sitter');
  const structuralEdit = await planEdit(workspace, {}, {
    symbolEdit: {
      action: 'replace',
      symbol: 'greet',
      path: 'src/structural.js',
      content: "function greet(name) {\n  return `hi ${name}`;\n}"
    }
  });
  assert.equal(structuralEdit.ok, true);
  assert.equal(structuralEdit.plannerPath, 'symbol');
  assert.equal(structuralEdit.semanticTarget.action, 'replace');
  assert.equal(structuralEdit.semanticTarget.path, 'src/structural.js');
  assert.match(fs.readFileSync(path.join(root, 'src', 'structural.js'), 'utf8'), /return `hi \$\{name\}`/);

  const references = await relaiCodeInspect(workspace, {}, { action: 'references', symbol: 'add' });
  assert.equal(references.index.cacheHit, false, 'structural edits must invalidate the repository index before the next query');
  assert.equal(references.intelligence.primary, 'relai-native', 'symbol references are graph-owned and must not start an overlapping LSP resolution');
  assert.ok(references.items.some(item => item.path === 'src/service.js' && item.classification === 'call'));
  assert.ok(references.items.some(item => item.path === 'test/math.test.js' && item.test === true));
  assert.ok(references.items.some(item => item.path === 'test/check.mjs' && item.test === true));

  const impact = await relaiCodeInspect(workspace, {}, { action: 'impact', symbol: 'add', maxDepth: 3 });
  assert.deepEqual(impact.seeds, ['src/math.js']);
  assert.equal(impact.intelligence.primary, 'relai-native', 'impact analysis is graph-owned');
  assert.ok(impact.impactedPaths.some(item => item.path === 'src/service.js' && item.reason === 'imports:src/math.js'));
  assert.ok(impact.impactedPaths.some(item => item.path === 'src/index.js' && item.depth === 2));
  assert.ok(impact.affectedTests.includes('test/math.test.js'));
  assert.ok(impact.affectedTests.includes('test/check.mjs'));
  assert.ok(impact.calls.some(item => item.path === 'src/service.js'));

  const pathImpact = await relaiCodeInspect(workspace, {}, { action: 'impact', paths: ['src/service.js'], maxDepth: 2 });
  assert.deepEqual(pathImpact.seeds, ['src/service.js']);
  assert.ok(pathImpact.impactedPaths.some(item => item.path === 'src/index.js' && item.depth === 1));
  assert.equal(Object.hasOwn(pathImpact, 'symbol'), false);

  const related = await relaiCodeInspect(workspace, {}, { action: 'related', query: 'math add' });
  assert.equal(related.strategy, 'fts5-tree-sitter-graph');
  assert.equal(related.semanticEmbeddings, false);
  assert.equal(related.files[0].path, 'src/math.js');

  const diagnostics = await relaiCodeInspect(workspace, {}, { action: 'diagnostics' });
  assert.equal(diagnostics.diagnosticsExecuted, false);
  assert.ok(diagnostics.languages.javascript >= 4);
  assert.ok(diagnostics.diagnosticCommands.some(item => item.key === 'npm:typecheck'));
  assert.ok(diagnostics.diagnosticCommands.some(item => item.key === 'npm:lint'));
  assert.ok(diagnostics.validationCommands.standard.length > 0);

  const previousFingerprint = diagnostics.index.fingerprint;
  write('src/math.js', "export function add(left, right) {\n  return Number(left) + Number(right);\n}\n");
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(path.join(root, 'src/math.js'), future, future);
  const refreshed = await relaiCodeInspect(workspace, {}, { action: 'symbol', symbol: 'add' });
  assert.equal(refreshed.index.cacheHit, false);
  assert.notEqual(refreshed.index.fingerprint, previousFingerprint);

  console.log('Code intelligence symbol, relationship, diagnostics, and freshness tests passed.');
} finally {
  await repositoryIntelligence.shutdown().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
