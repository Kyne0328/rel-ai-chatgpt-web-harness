import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openIndexDatabase, repositoryIndexPath } from '../src/repository/intelligence/database.js';
import { enhancedResolverLanguages, languageCapabilities, languageForPath } from '../src/repository/intelligence/languages.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';

const expectedStructuralLanguageCount = Object.keys(JSON.parse(
  fs.readFileSync(new URL('../vendor/tree-sitter/manifest.json', import.meta.url), 'utf8')
).grammars).length;
const EXPECTED_ENHANCED = ['c', 'cpp', 'csharp', 'go', 'java', 'javascript', 'kotlin', 'php', 'python', 'ruby', 'rust', 'tsx', 'typescript'];
assert.deepEqual(enhancedResolverLanguages().sort(), EXPECTED_ENHANCED);
assert.equal(languageForPath('src/app.ts'), 'typescript');
assert.equal(languageForPath('src/module.py'), 'python');
assert.equal(languageForPath('infra/main.hcl'), 'hcl');
assert.equal(languageForPath('infra/main.tf'), 'terraform');
assert.equal(languageForPath('infra/vars.tfvars'), 'terraform');
assert.equal(languageForPath('src/tool.zig'), 'zig');
assert.equal(languageForPath('Gemfile'), 'ruby');
assert.equal(languageCapabilities('scala').resolution, 'structural');
assert.equal(languageCapabilities('typescript').resolution, 'enhanced');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-language-intelligence-'));
const stateDir = path.join(root, '.state');
const workspaceRoot = path.join(root, 'workspace');
fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(workspaceRoot, 'src', 'contracts.ts'), 'export interface Persistable { save(): void; }\nexport class BaseService {}\n');
fs.writeFileSync(path.join(workspaceRoot, 'src', 'service.ts'), `
import { BaseService, Persistable } from './contracts';
export class AccountService extends BaseService implements Persistable {
  save() { return true; }
}
`);
fs.writeFileSync(path.join(workspaceRoot, 'src', 'consumer.ts'), `
import { AccountService } from './service';
export function persist() {
  const service: AccountService = new AccountService();
  return service.save();
}
`);
fs.writeFileSync(path.join(workspaceRoot, 'src', 'script.lua'), 'local function hello() return 1 end\n');
fs.mkdirSync(path.join(workspaceRoot, 'infra'), { recursive: true });
fs.writeFileSync(path.join(workspaceRoot, 'infra', 'config.hcl'), 'service = { name = "relai" }\n');
fs.writeFileSync(path.join(workspaceRoot, 'infra', 'main.tf'), 'resource "null_resource" "example" {}\n');

const workspace = { alias: 'language-test', path: workspaceRoot, context: {}, testCommands: {}, commands: {} };
const config = { stateDir };

try {
  const index = await repositoryIntelligence.ensure(workspace, config);
  assert.equal(index.languageIntelligence.structuralLanguages, expectedStructuralLanguageCount);
  assert.deepEqual(index.languageIntelligence.enhancedLanguages.sort(), EXPECTED_ENHANCED);
  const db = openIndexDatabase(repositoryIndexPath(config, workspace), { readonly: true });
  try {
    const files = new Map(db.prepare('SELECT path, language, parser FROM files').all().map(row => [String(row.path), { language: String(row.language), parser: String(row.parser) }]));
    assert.equal(files.get('src/script.lua').language, 'lua');
    assert.deepEqual(files.get('infra/config.hcl'), { language: 'hcl', parser: 'tree-sitter' });
    assert.deepEqual(files.get('infra/main.tf'), { language: 'terraform', parser: 'tree-sitter' });
    const edges = db.prepare("SELECT type, provider, target_name FROM edges WHERE provider='resolver-js-ts-v2' ORDER BY type, target_name").all();
    assert.ok(edges.some(edge => edge.type === 'INHERITS' && edge.target_name === 'BaseService'));
    assert.ok(edges.some(edge => edge.type === 'IMPLEMENTS' && edge.target_name === 'Persistable'));
    assert.ok(edges.some(edge => edge.type === 'USES_TYPE' && edge.target_name === 'AccountService'));
    assert.ok(edges.some(edge => edge.type === 'CALLS' && edge.target_name === 'save'));
  } finally {
    db.close();
  }
} finally {
  await repositoryIntelligence.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Universal language registry and JS/TS resolver graph tests passed.');
