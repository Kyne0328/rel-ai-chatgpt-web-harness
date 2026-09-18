import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXEMPTION = /rigidity-ok:\s*(.{10,})/i;

function auditSource(relativePath, source) {
  const violations = [];
  const lines = String(source).split(/\r?\n/);
  const report = (lineNumber, kind, message) => violations.push({ relativePath, lineNumber, kind, message });

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (EXEMPTION.test(line)) continue;
    const lineNumber = index + 1;

    if (/assert\.(?:equal|deepEqual)\([^\n]*(?:toolCount|toolSurfaceVersion)[^,]*,\s*\d+\b/.test(line)) {
      report(lineNumber, 'live-surface-number', 'Derive tool/schema/surface revisions from the canonical runtime instead of asserting today\'s number.');
    }
    if (/assert\.(?:equal|deepEqual)\([^\n]*(?:devDependencies|dependencies)[^,]*,\s*['"]\d+\.\d+\.\d+['"]/.test(line)) {
      report(lineNumber, 'dependency-version', 'Check manifest/lockfile parity or a supported range instead of asserting today\'s dependency version.');
    }
    if (/assert\.equal\([^\n]*(?:backgroundColor|foregroundColor|color)[^,]*,\s*['"]#[0-9a-f]{6}['"]/i.test(line)) {
      report(lineNumber, 'exact-ui-color', 'Assert a semantic color property or accessibility outcome instead of one exact theme hex value.');
    }
    if (/assert\.match\([^\n]*(?:Css|css)[^,]*,\s*\/(?:[^/\\]|\\.)*(?:#[0-9a-f]{6}|(?:min-|max-)?width:\\s\*?\d+(?:px|%|ch)|@media[^/]*(?:min|max)-width:\\s\*?\d+px|repeat\\\(\d+|--[a-z0-9-]*width:\\s\*?\d+px)/i.test(line)) {
      report(lineNumber, 'exact-ui-geometry', 'Assert responsive/accessibility behavior instead of an exact CSS pixel, percentage, breakpoint, or grid recipe.');
    }
    if (/assert\.equal\([^\n]*scripts\[[^\]]+\][^,]*,\s*['"](?:node|npm|npx|pwsh|powershell|bash)\s+/i.test(line)) {
      report(lineNumber, 'exact-script-command', 'Assert that the release capability exists/works instead of freezing the exact npm script command string.');
    }
  }

  if (/\bsourceLineBudgets\b|architecture budget is \$\{?maxLines/i.test(source)) {
    report(1, 'source-line-budget', 'Per-file line-count budgets block legitimate refactors and feature growth.');
  }
  return violations;
}

function auditPackageJson(packageJson) {
  const violations = [];
  const scripts = packageJson?.scripts || {};
  const testAll = String(scripts['test:all'] || '');
  const check = String(scripts.check || '');
  if (/release-check\.mjs|release:check/.test(testAll)) {
    violations.push({ relativePath: 'package.json', lineNumber: 1, kind: 'release-leak', message: 'Normal development tests must not require finalized release metadata.' });
  }
  if (!/audit:test-rigidity/.test(check)) {
    violations.push({ relativePath: 'package.json', lineNumber: 1, kind: 'missing-rigidity-audit', message: 'check must run audit:test-rigidity so brittle gates cannot silently return.' });
  }
  if (scripts['test:tool-budgets']) {
    violations.push({ relativePath: 'package.json', lineNumber: 1, kind: 'misleading-budget-alias', message: 'Tool-surface measurement must not be named like a blocking test budget.' });
  }
  if (/--enforce-thresholds\b/.test(String(scripts['benchmark:observability'] || ''))) {
    violations.push({ relativePath: 'package.json', lineNumber: 1, kind: 'default-performance-gate', message: 'The default observability benchmark must report thresholds; use the explicit strict benchmark only for deliberate SLO enforcement.' });
  }
  for (const [name, command] of Object.entries(scripts)) {
    if (/^electron:size(?::|$)/.test(name) && /--strict\b/.test(String(command))) {
      violations.push({ relativePath: 'package.json', lineNumber: 1, kind: 'strict-size-baseline', message: `${name} must report ordinary size drift instead of failing at the captured baseline tolerance.` });
    }
  }
  return violations;
}

function auditRepository(base = root) {
  const violations = [];
  for (const file of collectFiles(path.join(base, 'test'), '.mjs')) {
    const relativePath = path.relative(base, file).replaceAll('\\', '/');
    if (relativePath === 'test/test-rigidity-audit-unit.mjs') continue;
    violations.push(...auditSource(relativePath, fs.readFileSync(file, 'utf8')));
  }
  const packagePath = path.join(base, 'package.json');
  if (fs.existsSync(packagePath)) violations.push(...auditPackageJson(JSON.parse(fs.readFileSync(packagePath, 'utf8'))));
  const runnerPath = path.join(base, 'test', 'run-tests.mjs');
  if (fs.existsSync(runnerPath)) {
    const runner = fs.readFileSync(runnerPath, 'utf8');
    for (const releaseOnly of ['release-workflow-smoke.mjs', 'update-support-policy-integration-unit.mjs']) {
      if (runner.includes(`'${releaseOnly}'`) || runner.includes(`"${releaseOnly}"`)) {
        violations.push({ relativePath: 'test/run-tests.mjs', lineNumber: 1, kind: 'release-only-in-development', message: `${releaseOnly} must stay outside the everyday regression runner.` });
      }
    }
  }
  return violations;
}

function collectFiles(directory, extension) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(target, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) files.push(target);
  }
  return files;
}

function main() {
  const violations = auditRepository();
  if (!violations.length) {
    console.log('Test rigidity audit passed.');
    return;
  }
  console.error('Test rigidity audit failed:');
  for (const item of violations) console.error(`  - ${item.relativePath}:${item.lineNumber} [${item.kind}] ${item.message}`);
  console.error('Use a behavior/parity assertion instead. If an exact value is a genuine contract, add an inline `rigidity-ok: <reason>` comment.');
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { auditPackageJson, auditRepository, auditSource };
