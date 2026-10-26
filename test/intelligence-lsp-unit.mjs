import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { relaiCodeInspect } from '../src/bridge/codeIntelligence.js';
import { planEdit } from '../src/executionPlanner.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-lsp-intelligence-'));
const secondary = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-lsp-secondary-'));
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-lsp-state-'));
const workspace = { alias: 'lsp-fixture', path: root, sourcePaths: [root, secondary], context: {} };
const config = { stateDir: stateRoot, workspaces: { 'lsp-fixture': workspace } };

try {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'lsp-fixture', private: true, type: 'module' }, null, 2));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true },
    include: ['src/**/*.ts']
  }, null, 2));
  fs.writeFileSync(path.join(root, 'src', 'math.ts'), 'export function add(left: number, right: number): number {\n  return left + right;\n}\n');
  fs.writeFileSync(path.join(root, 'src', 'use.ts'), "import { add } from './math.js';\nexport const total = add(1, 2);\n");
  fs.writeFileSync(path.join(root, 'src', 'bad.ts'), 'export const broken: string = 123;\n');

  const definition = await relaiCodeInspect(workspace, config, {
    action: 'definition', path: 'src/use.ts', line: 2, column: 22, maxResults: 20
  });
  assert.equal(definition.ok, true);
  assert.equal(definition.intelligence.primary, 'typescript-native');
  assert.equal(definition.intelligence.authority, 'language-server');
  assert.ok(definition.definitions.length > 0);

  const hover = await relaiCodeInspect(workspace, config, {
    action: 'hover', path: 'src/use.ts', line: 2, column: 22, maxResults: 20
  });
  assert.equal(hover.ok, true);
  assert.match(hover.hover?.text || '', /add/);
  assert.equal(hover.intelligence.primary, 'typescript-native');

  const references = await relaiCodeInspect(workspace, config, {
    action: 'references', path: 'src/math.ts', line: 1, column: 17, maxResults: 20
  });
  assert.equal(references.ok, true);
  assert.equal(references.intelligence.primary, 'typescript-native');
  assert.ok(references.items.some(item => item.path === 'src/use.ts'));

  const diagnostics = await relaiCodeInspect(workspace, config, {
    action: 'diagnostics', path: 'src/bad.ts', maxResults: 20
  });
  assert.equal(diagnostics.ok, true);
  assert.equal(diagnostics.diagnosticsExecuted, true);
  assert.equal(diagnostics.intelligence.primary, 'typescript-native');
  assert.ok(diagnostics.diagnosticCount > 0);
  assert.ok(diagnostics.diagnostics.some(item => item.path === 'src/bad.ts' && item.severity === 'error' && /not assignable/i.test(item.message)));

  const rename = await planEdit(workspace, config, {
    semantic: { action: 'rename', path: 'src/math.ts', line: 1, column: 17, newName: 'sum' }
  });
  assert.equal(rename.ok, true);
  assert.equal(rename.plannerPath, 'semantic:rename');
  assert.equal(rename.semantic.provider, 'typescript-native');
  assert.deepEqual(rename.changedFiles.sort(), ['src/math.ts', 'src/use.ts']);
  assert.match(fs.readFileSync(path.join(root, 'src', 'math.ts'), 'utf8'), /function sum\(/);
  assert.match(fs.readFileSync(path.join(root, 'src', 'use.ts'), 'utf8'), /import \{ sum \}/);
  assert.match(fs.readFileSync(path.join(root, 'src', 'use.ts'), 'utf8'), /sum\(1, 2\)/);

  fs.writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname = "lsp-fixture"\nversion = "0.0.0"\n');
  fs.writeFileSync(path.join(root, 'src', 'calc_mod.py'), 'def multiply(left: int, right: int) -> int:\n    return left * right\n');
  fs.writeFileSync(path.join(root, 'src', 'use_calc.py'), 'from calc_mod import multiply\nvalue = multiply(2, 3)\n');
  fs.writeFileSync(path.join(root, 'src', 'bad.py'), 'value: str = 123\n');

  const pythonDefinition = await relaiCodeInspect(workspace, config, {
    action: 'definition', path: 'src/use_calc.py', line: 2, column: 9, maxResults: 20
  });
  assert.equal(pythonDefinition.ok, true);
  assert.equal(pythonDefinition.intelligence.primary, 'pyright');
  assert.ok(pythonDefinition.definitions.some(item => item.path === 'src/calc_mod.py'));

  const pythonDiagnostics = await relaiCodeInspect(workspace, config, {
    action: 'diagnostics', path: 'src/bad.py', maxResults: 20
  });
  assert.equal(pythonDiagnostics.ok, true);
  assert.equal(pythonDiagnostics.diagnosticsExecuted, true);
  assert.equal(pythonDiagnostics.intelligence.primary, 'pyright');
  assert.ok(pythonDiagnostics.diagnostics.some(item => item.path === 'src/bad.py' && item.severity === 'error' && /not assignable/i.test(item.message)));

  fs.mkdirSync(path.join(secondary, 'src'), { recursive: true });
  fs.writeFileSync(path.join(secondary, 'package.json'), JSON.stringify({ name: 'lsp-secondary', private: true, type: 'module' }, null, 2));
  fs.writeFileSync(path.join(secondary, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true },
    include: ['src/**/*.ts']
  }, null, 2));
  fs.writeFileSync(path.join(secondary, 'src', 'math.ts'), 'export function subtract(left: number, right: number): number {\n  return left - right;\n}\n');
  fs.writeFileSync(path.join(secondary, 'src', 'use.ts'), "import { subtract } from './math.js';\nexport const difference = subtract(3, 1);\n");

  const secondaryDefinition = await relaiCodeInspect(workspace, config, {
    action: 'definition', path: 'source:2/src/use.ts', line: 2, column: 29, maxResults: 20
  });
  assert.equal(secondaryDefinition.ok, true);
  assert.equal(secondaryDefinition.intelligence.primary, 'typescript-native');
  assert.ok(secondaryDefinition.definitions.length > 0);
  assert.ok(secondaryDefinition.definitions.every(item => item.path.startsWith('source:2/')),
    'language-server locations from secondary roots must keep their virtual source identity');
  await assert.rejects(
    () => planEdit(workspace, config, {
      semantic: { action: 'rename', path: 'source:2/src/math.ts', line: 1, column: 17, newName: 'differenceOf' }
    }),
    /secondary source folders are read-only context/i,
    'semantic mutations must remain primary-repository-only'
  );

  const servers = new Map(repositoryIntelligence.languageServers(workspace).map(item => [`${item.source || 1}:${item.id}`, item]));
  assert.equal(servers.get('1:typescript-native')?.available, true);
  assert.equal(servers.get('1:pyright')?.available, true);
  assert.equal(servers.get('2:typescript-native')?.available, true);

  console.log('Hybrid LSP intelligence and Rel.AI-controlled semantic rename passed.');
} finally {
  await repositoryIntelligence.shutdown().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 20 : 5, retryDelay: 100 });
  fs.rmSync(secondary, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 20 : 5, retryDelay: 100 });
  fs.rmSync(stateRoot, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 20 : 5, retryDelay: 100 });
}
