import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pRetry from 'p-retry';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ATTEMPTS = 2;
const AUDIT_NETWORK_ARGS = ['--fetch-retries=0', '--fetch-timeout=15000'];
const TRANSIENT_AUDIT_FAILURE = /(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|E50[0234]|E429|429 Too Many Requests|50[0234] Service|Service Unavailable|socket hang up|network timeout)/i;

function isTransientAuditFailure(result = {}) {
  return TRANSIENT_AUDIT_FAILURE.test(`${result.stdout || ''}\n${result.stderr || ''}`);
}

function runAudit(npmCli, prefix) {
  const args = [npmCli, 'audit', '--omit=dev', ...(prefix ? [] : ['--omit=peer']), '--audit-level=high', ...AUDIT_NETWORK_ARGS];
  if (prefix) args.push('--prefix', prefix);
  const env = { ...process.env, npm_config_userconfig: os.devNull };
  delete env.npm_config_allow_scripts;
  delete env.NPM_CONFIG_ALLOW_SCRIPTS;
  return spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    windowsHide: true
  });
}

async function auditTarget(npmCli, label, prefix = '') {
  try {
    await pRetry(() => {
    const result = runAudit(npmCli, prefix);
    if (result.error) throw new Error(`Could not execute npm audit for ${label}: ${result.error.message}`, { cause: result.error });
    if (result.status === 0) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      return result;
    }
      throw new AuditFailure(result, isTransientAuditFailure(result));
    }, {
      retries: MAX_ATTEMPTS - 1,
      minTimeout: 1000,
      factor: 1,
      randomize: false,
      unref: true,
      shouldRetry: ({ error }) => error instanceof AuditFailure && error.transient,
      onFailedAttempt: ({ error, attemptNumber, retriesLeft }) => {
        if (!(error instanceof AuditFailure) || !error.transient || retriesLeft === 0) return;
        console.warn(`npm audit for ${label} hit a transient registry error; retrying (${attemptNumber + 1}/${MAX_ATTEMPTS}).`);
      }
    });
  } catch (error) {
    if (error instanceof AuditFailure && error.transient) {
      console.warn(`npm audit advisory service is unavailable for ${label}; continuing without a live advisory check.`);
      return { available: false };
    }
    if (error instanceof AuditFailure) {
      if (error.result.stdout) process.stdout.write(error.result.stdout);
      if (error.result.stderr) process.stderr.write(error.result.stderr);
      process.exitCode = Number.isInteger(error.result.status) ? error.result.status : 1;
      throw new Error(`npm audit failed for ${label}.`, { cause: error });
    }
    throw error;
  }
}

class AuditFailure extends Error {
  constructor(result, transient) {
    super('npm audit returned a non-zero status.');
    this.result = result;
    this.transient = transient;
  }
}

async function main() {
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !fs.existsSync(npmCli)) {
    throw new Error('npm_execpath is unavailable; run this gate through npm run audit:production.');
  }
  await auditTarget(npmCli, 'root dependencies');
  await auditTarget(npmCli, 'Electron dependencies', 'electron');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    if (!process.exitCode) process.exitCode = 1;
    console.error(error instanceof Error ? error.message : String(error));
  }
}

export { isTransientAuditFailure };
