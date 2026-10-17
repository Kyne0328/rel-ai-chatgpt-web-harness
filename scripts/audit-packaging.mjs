import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAuditReport, isTransientAuditFailure, reportAuditOutcome, runDependencyAudit } from './dependency-audit.mjs';

function evaluatePackagingAudit({ report } = {}) {
  return evaluateAuditReport(report);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  reportAuditOutcome(await runDependencyAudit({ label: 'Electron packaging dependencies', prefix: 'electron' }));
}

export { evaluatePackagingAudit, isTransientAuditFailure as isTransientPackagingAuditFailure };
