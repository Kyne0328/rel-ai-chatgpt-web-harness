import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportAuditOutcome, runDependencyAudit } from './dependency-audit.mjs';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [label, prefix] of [['root dependencies', ''], ['Electron dependencies', 'electron']]) {
    const result = await runDependencyAudit({ label, prefix, production: true });
    reportAuditOutcome(result);
    if (result.outcome !== 'passed') break;
  }
}
