import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx']);
const IMPORT_PATTERN = /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const TYPED_BOUNDARY_PREFIXES = ['src/contracts/', 'src/core/', 'src/http/'];
const UI_SHARED_PURE_MODULES = new Set([
  'src/analyticsFailureCategory.js',
  'src/taskActivityPresentation.js',
  'src/taskEvents.js',
  'src/taskSemanticProgress.js',
  'src/taskState.js'
]);
const REPOSITORY_INTELLIGENCE_INFRASTRUCTURE_MODULES = new Set([
  'src/bridge/checkDetection.js',
  'src/bridge/limits.js',
  'src/codeIntelligence/lspManager.js',
  'src/commandDiscovery.js',
  'src/hostResourceScheduler.js',
  'src/knowledgeStore.js',
  'src/performanceObservability.js',
  'src/process.js',
  'src/safety.js',
  'src/stateLayout.js',
  'src/watchPath.js',
  'src/workspaceSources.js'
]);
const violations = [];

for (const file of [...sourceFiles('src'), ...sourceFiles('electron')]) {
  const normalizedFile = normalize(file);
  const text = fs.readFileSync(file, 'utf8');
  checkTypedBoundaryAny(normalizedFile, text);
  checkTypescriptFacade(normalizedFile);
  for (const match of text.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] || match[2] || '';
    checkImport(normalizedFile, specifier);
  }
}

if (violations.length) {
  console.error('Module boundary violations:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log('Module boundaries are valid.');
}

function checkImport(file, specifier) {
  const target = resolveTarget(file, specifier);
  const desktopPackage = /^(?:@rel-ai\/desktop|rel-ai-mcp-launcher)(?:\/|$)/.test(specifier);
  const uiPackage = /^@rel-ai\/ui(?:\/|$)/.test(specifier);
  const higherPackage = /^(?:@rel-ai\/(?:core|ui|desktop|repository-intelligence)|rel-ai-mcp-launcher)(?:\/|$)/.test(specifier);

  if (file.startsWith('src/contracts/')) {
    if ((target && !target.startsWith('src/contracts/')) || higherPackage) {
      add(file, specifier, 'contracts may not depend on higher-level implementation modules');
    }
    return;
  }

  if (file.startsWith('src/ui/')) {
    const allowedRelative = target && (
      target.startsWith('src/ui/')
      || target.startsWith('src/contracts/')
      || UI_SHARED_PURE_MODULES.has(target)
    );
    if ((target && !allowedRelative) || desktopPackage || /^@rel-ai\/core(?:\/|$)/.test(specifier)) {
      add(file, specifier, 'UI may depend on UI-local code, contracts, approved pure projection helpers, and external libraries only');
    }
    return;
  }

  if (file.startsWith('src/repository/intelligence/')) {
    const allowedRelative = target && (
      target.startsWith('src/repository/intelligence/')
      || target.startsWith('src/contracts/')
      || REPOSITORY_INTELLIGENCE_INFRASTRUCTURE_MODULES.has(target)
    );
    if ((target && !allowedRelative) || higherPackage) {
      add(file, specifier, 'Repository Intelligence may depend only on its package, contracts, and approved runtime infrastructure');
    }
    return;
  }

  if (file.startsWith('src/http/')) {
    const allowedInfrastructure = target === 'src/packageMetadata.js';
    const allowedBoundary = target && (
      target.startsWith('src/http/')
      || target.startsWith('src/core/')
      || target.startsWith('src/contracts/')
    );
    if (target && !allowedBoundary && !allowedInfrastructure) {
      add(file, specifier, 'HTTP adapters may depend only on HTTP-local code, typed contracts, Core operations, or approved static-serving infrastructure');
    }
    return;
  }

  if (file.startsWith('src/core/')) {
    if (target && target.startsWith('src/http/')) {
      add(file, specifier, 'Core may not depend on HTTP adapters');
    }
    if ((target && (target.startsWith('electron/') || target.startsWith('src/ui/'))) || desktopPackage || uiPackage) {
      add(file, specifier, 'Core may not depend on Electron or UI internals');
    }
    return;
  }

  if (file.startsWith('electron/')) {
    if ((target && target.startsWith('src/ui/')) || uiPackage) {
      add(file, specifier, 'desktop integration may not depend on dashboard UI internals');
    }
    return;
  }

  if (file.startsWith('src/')) {
    if ((target && (target.startsWith('electron/') || target.startsWith('src/ui/'))) || desktopPackage || uiPackage) {
      add(file, specifier, 'core/runtime modules may not depend on Electron or UI internals');
    }
  }
}

function checkTypedBoundaryAny(file, text) {
  if (!TYPED_BOUNDARY_PREFIXES.some(prefix => file.startsWith(prefix))) return;
  if (!file.endsWith('.ts') && !file.endsWith('.tsx')) return;
  const tree = parse(text, { sourceType: 'module', plugins: file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'] });
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'TSAnyKeyword') {
      add(file, '<type:any>', 'typed contracts/Core/HTTP boundaries may not use explicit any');
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent' || !value || typeof value !== 'object') continue;
      if (Array.isArray(value)) pending.push(...value);
      else pending.push(value);
    }
  }
}

function checkTypescriptFacade(file) {
  if (!file.endsWith('.ts') || file.endsWith('.d.ts')) return;
  const jsFile = `${file.slice(0, -3)}.js`;
  if (!fs.existsSync(jsFile)) return;
  const expected = `export * from './${path.basename(file)}';`;
  const actual = fs.readFileSync(jsFile, 'utf8').trim();
  if (actual !== expected) {
    add(jsFile, path.basename(file), 'JS sibling of a migrated TypeScript module must be a pure re-export facade');
  }
}

function add(file, specifier, reason) {
  violations.push(`${file}: ${specifier} (${reason})`);
}

function resolveTarget(file, specifier) {
  if (!specifier.startsWith('.')) return '';
  return normalize(path.join(path.dirname(file), specifier));
}

function sourceFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(fullPath);
    }
  }
  return files;
}

function normalize(value) {
  return path.normalize(value).split(path.sep).join('/');
}
