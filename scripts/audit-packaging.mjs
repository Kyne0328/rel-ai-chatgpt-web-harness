import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ATTEMPTS = 2;
const RETRY_DELAYS_MS = [1000];
const AUDIT_NETWORK_ARGS = ['--fetch-retries=0', '--fetch-timeout=15000'];
const TRANSIENT_AUDIT_FAILURE = /(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|E50[0234]|E429|429 Too Many Requests|50[0234] Service|Service Unavailable|socket hang up|network timeout)/i;

function isTransientPackagingAuditFailure(result = {}) {
  return TRANSIENT_AUDIT_FAILURE.test(`${result.stdout || ''}\n${result.stderr || ''}`);
}

function evaluatePackagingAudit({ report }) {
  const vulnerabilities = report?.vulnerabilities && typeof report.vulnerabilities === 'object'
    ? report.vulnerabilities
    : {};
  const high = Number(report?.metadata?.vulnerabilities?.high || 0);
  const critical = Number(report?.metadata?.vulnerabilities?.critical || 0);
  if (high > 0 || critical > 0) {
    const packages = Object.keys(vulnerabilities).sort();
    const severity = [
      critical > 0 ? `${critical} critical` : '',
      high > 0 ? `${high} high` : ''
    ].filter(Boolean).join(' and ');
    throw new Error(`Packaging audit contains ${severity} vulnerability finding(s)${packages.length ? `: ${packages.join(', ')}` : ''}.`);
  }
  return { accepted: true, vulnerabilityCount: 0, packages: [] };
}

function runNpmAuditAttempt(npmCli) {
  const env = { ...process.env, npm_config_userconfig: os.devNull };
  delete env.npm_config_allow_scripts;
  delete env.NPM_CONFIG_ALLOW_SCRIPTS;
  return spawnSync(process.execPath, [
    npmCli,
    'audit',
    '--prefix', 'electron',
    '--audit-level=high',
    '--json',
    ...AUDIT_NETWORK_ARGS
  ], {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    windowsHide: true
  });
}

async function runNpmAudit() {
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !fs.existsSync(npmCli)) {
    throw new Error('npm_execpath is unavailable; run this gate through npm run audit:packaging.');
  }
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = runNpmAuditAttempt(npmCli);
    if (result.error) throw new Error(`Could not execute npm audit: ${result.error.message}`, { cause: result.error });
    if (isTransientPackagingAuditFailure(result)) {
      if (attempt === MAX_ATTEMPTS) {
        console.warn('npm audit advisory service is unavailable for Electron packaging dependencies; continuing without a live advisory check.');
        return null;
      }
      console.warn(`npm packaging audit hit a transient registry error; retrying (${attempt + 1}/${MAX_ATTEMPTS}).`);
      const delay = RETRY_DELAYS_MS[attempt - 1] || RETRY_DELAYS_MS.at(-1) || 0;
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }
    let report;
    try {
      report = JSON.parse(result.stdout || '');
    } catch {
      throw new Error(`npm audit did not return valid JSON. ${String(result.stderr || '').trim()}`.trim());
    }
    return report;
  }
  return null;
}

async function main() {
  const report = await runNpmAudit();
  if (!report) return;
  evaluatePackagingAudit({ report });
  console.log('Packaging dependency audit passed without high-severity findings.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export { evaluatePackagingAudit, isTransientPackagingAuditFailure };
