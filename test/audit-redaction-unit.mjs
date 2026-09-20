import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { flushAuditWrites, readAudit, safeLogAudit } from '../src/audit.js';

async function runAuditRedactionRegression(existingRoot = '') {
  const ownsRoot = !existingRoot;
  const root = existingRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'relai-audit-redaction-'));
  const config = { stateDir: root, auditLogPath: path.join(root, 'audit.jsonl') };
  const secret = 'audit-message-secret-987654';

  try {
    await safeLogAudit(config, {
      tool: 'security-regression',
      ok: false,
      error: `Authorization: Bearer ${secret}`,
      warnings: [`password=${secret}`],
      nested: { message: `api_key=${secret}` },
      authorization: `Bearer ${secret}`
    });
    void safeLogAudit(config, { tool: 'fire-and-forget-regression', ok: true });
    await flushAuditWrites(config.auditLogPath);

    const persisted = fs.readFileSync(config.auditLogPath, 'utf8');
    assert.equal(persisted.includes(secret), false, persisted);
    assert.match(persisted, /redacted/i);
    assert.match(persisted, /security-regression/);
    assert.match(persisted, /fire-and-forget-regression/, 'flushAuditWrites must wait for safeLogAudit calls that have not enqueued their write yet');
  } finally {
    if (ownsRoot) fs.rmSync(root, { recursive: true, force: true });
  }
}

async function runAuditPersistenceRegression() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-audit-persistence-'));
  const blockedParent = path.join(root, 'blocked-parent');
  const auditLogPath = path.join(blockedParent, 'audit.jsonl');
  const config = { stateDir: root, auditLogPath };
  fs.writeFileSync(blockedParent, 'not a directory');
  try {
    await safeLogAudit(config, { tool: 'persistence-regression', ok: false, error: 'write should retry' });
    await new Promise(resolve => setTimeout(resolve, 100));
    const failed = readAudit(config, { limit: 10 });
    assert.equal(failed.persistence.healthy, false);
    assert.equal(failed.persistence.pending, 1, 'failed audit writes must remain available in the bounded in-memory queue');
    assert.ok(failed.persistence.retryCount >= 1);
    assert.ok(failed.persistence.lastError, 'audit persistence failures must retain technical evidence for diagnostics');

    fs.rmSync(blockedParent, { force: true });
    fs.mkdirSync(blockedParent);
    await flushAuditWrites(auditLogPath);
    const recovered = readAudit(config, { limit: 10 });
    assert.equal(recovered.persistence.healthy, true, 'successful retry must clear the active persistence failure');
    assert.equal(recovered.persistence.pending, 0);
    assert.equal(recovered.persistence.retryCount, 0);
    assert.ok(recovered.entries.some(entry => entry.tool === 'persistence-regression'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runAuditRedactionRegression();
  await runAuditPersistenceRegression();
  console.log('Audit logging redacts secrets and reports recoverable persistence failures without unbounded retry churn.');
}

export { runAuditPersistenceRegression, runAuditRedactionRegression };
