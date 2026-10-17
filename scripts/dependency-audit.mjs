import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRANSIENT_AUDIT_FAILURE = /(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|E50[0234]|E429|429 Too Many Requests|50[0234] Service|Service Unavailable|socket hang up|network timeout)/i;

function isTransientAuditFailure(result = {}) {
  return TRANSIENT_AUDIT_FAILURE.test(`${result.stdout || ''}\n${result.stderr || ''}`);
}

function auditError(message, outcome = 'unavailable') {
  return Object.assign(new Error(message), { outcome });
}

function evaluateAuditReport(report) {
  const counts = report?.metadata?.vulnerabilities;
  const vulnerabilities = report?.vulnerabilities;
  if (!report || report.error || !counts || typeof counts !== 'object'
      || !vulnerabilities || typeof vulnerabilities !== 'object' || Array.isArray(vulnerabilities)) {
    throw auditError('npm audit returned no usable vulnerability report.');
  }
  const severities = ['info', 'low', 'moderate', 'high', 'critical'];
  for (const severity of [...severities.filter(value => value !== 'info' || counts.info !== undefined), 'total']) {
    if (!Number.isSafeInteger(counts[severity]) || counts[severity] < 0) {
      throw auditError(`npm audit returned an invalid ${severity} vulnerability count.`);
    }
  }
  const observed = Object.fromEntries(severities.map(severity => [severity, 0]));
  for (const vulnerability of Object.values(vulnerabilities)) {
    if (!vulnerability || !severities.includes(vulnerability.severity)) {
      throw auditError('npm audit returned an invalid vulnerability entry.');
    }
    observed[vulnerability.severity] += 1;
  }
  if (severities.some(severity => observed[severity] !== (counts[severity] ?? 0))
      || Object.values(observed).reduce((sum, count) => sum + count, 0) !== counts.total) {
    throw auditError('npm audit vulnerability counts do not match its findings.');
  }
  if (counts.high > 0 || counts.critical > 0) {
    const packages = Object.keys(vulnerabilities).sort();
    const severity = [counts.critical > 0 ? `${counts.critical} critical` : '', counts.high > 0 ? `${counts.high} high` : ''].filter(Boolean).join(' and ');
    throw auditError(`Dependency audit contains ${severity} vulnerability finding(s): ${packages.join(', ')}.`, 'failed');
  }
  return { accepted: true, vulnerabilityCount: 0, packages: [] };
}

async function runDependencyAudit({ label, prefix = '', production = false }) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !fs.existsSync(npmCli)) {
    return { outcome: 'unavailable', label, reason: 'npm_execpath is unavailable; run this gate through npm run.' };
  }
  const env = { ...process.env, npm_config_userconfig: os.devNull };
  delete env.npm_config_allow_scripts;
  delete env.NPM_CONFIG_ALLOW_SCRIPTS;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = spawnSync(process.execPath, [
      npmCli, 'audit', '--json', '--audit-level=high',
      '--fetch-retries=0', '--fetch-timeout=15000',
      ...(production ? ['--omit=dev', ...(prefix ? [] : ['--omit=peer'])] : []),
      ...(prefix ? ['--prefix', prefix] : [])
    ], { cwd: root, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, shell: false, windowsHide: true });
    if (result.error || result.signal || !Number.isInteger(result.status)) {
      return { outcome: 'unavailable', label, reason: `Could not complete npm audit: ${result.error?.message || result.signal || 'missing exit status'}` };
    }
    let outcome;
    try {
      const report = JSON.parse(result.stdout || '');
      if (![0, 1].includes(result.status)) throw auditError(`npm audit exited unexpectedly with status ${result.status}.`);
      evaluateAuditReport(report);
      if (result.status !== 0) throw auditError(`npm audit exited unexpectedly with status ${result.status}.`);
      outcome = { outcome: 'passed', label };
    } catch (error) {
      // A valid advisory can itself mention a network error. Classify its
      // evidence before deciding whether an unavailable result is retryable.
      outcome = { outcome: error?.outcome || 'unavailable', label, reason: error instanceof Error ? error.message : String(error) };
    }
    if (outcome.outcome !== 'unavailable' || !isTransientAuditFailure(result)) return outcome;
    if (attempt === 2) return { outcome: 'unavailable', label, reason: 'Advisory service unavailable after retries.' };
    console.warn(`npm audit for ${label} hit a transient registry error; retrying (2/2).`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return { outcome: 'unavailable', label, reason: 'No advisory result.' };
}

function reportAuditOutcome(result) {
  console.log(JSON.stringify(result));
  if (result.outcome !== 'passed') process.exitCode = result.outcome === 'failed' ? 1 : 2;
}

export { evaluateAuditReport, isTransientAuditFailure, reportAuditOutcome, runDependencyAudit };
