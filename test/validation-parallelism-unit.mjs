import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { relaiVerify } from '../src/bridge/validation.js';
import { relaiDiagnosticsRun } from '../src/bridge/diagnosticsRunner.js';
import { serializeConnectorResult } from '../src/tools/connector.js';
import { toolResult } from '../src/mcp/results.js';
import { outputSchemaFor } from '../src/tools/outputSchemas.js';
import { OPERATION_IDS as OP } from '../src/tools/operationIds.js';
import { fromJsonSchema } from '@modelcontextprotocol/server';
import { buildCheckCatalog } from '../src/workflow/checkCatalog.js';
import { discoverRepositoryTopology } from '../src/workflow/topology.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-validation-parallel-'));
try {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'parallel-validation-fixture',
    private: true,
    scripts: {
      lint: 'node -e "setTimeout(() => process.exit(0), 120)"',
      typecheck: 'node -e "setTimeout(() => process.exit(0), 120)"',
      security: 'node -e "setTimeout(() => process.exit(0), 120)"',
      'dead-code': 'node -e "setTimeout(() => process.exit(0), 120)"',
      build: 'node -e "setTimeout(() => process.exit(0), 40)"'
    }
  }, null, 2));

  const topology = discoverRepositoryTopology(root);
  const catalog = buildCheckCatalog(topology);
  const lint = catalog.find(item => item.kind === 'lint');
  const typecheck = catalog.find(item => item.kind === 'typecheck');
  const security = catalog.find(item => item.kind === 'security');
  const deadCode = catalog.find(item => item.kind === 'dead_code');
  const build = catalog.find(item => item.kind === 'build');
  assert.ok(lint && typecheck && security && deadCode && build, 'fixture should expose four parallel-safe checks plus a build barrier');

  const result = await relaiVerify(
    { alias: 'repo', path: root, commands: {}, testCommands: {} },
    { stateDir: path.join(root, '.state') },
    { checks: [lint.id, typecheck.id, security.id, deadCode.id, build.id], timeoutMs: 30000, stopOnFailure: true }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map(item => item.command), [lint.command, typecheck.command, security.command, deadCode.command, build.command]);
  assert.equal(result.execution.maxConcurrentSteps, 4, 'all policy-safe checks in the stage should overlap without a fixed concurrency ceiling');
  assert.equal(result.execution.stepCount, 5);
  assert.ok(result.execution.overlapTimeMs > 0, 'parallel validation should report measured step overlap');
  const diagnosticWorkspace = { alias: 'repo', path: root, commands: {}, testCommands: {} };
  const diagnosticConfig = { stateDir: path.join(root, '.state') };
  const marker = path.join(root, 'diagnostic-must-not-spawn');
  for (const reason of [new DOMException('Deadline expired.', 'TimeoutError'), new DOMException('User cancelled after reading timeout guidance.', 'AbortError')]) {
    const diagnostic = await relaiDiagnosticsRun(diagnosticWorkspace, diagnosticConfig, {
      command: `node -e "require('node:fs').writeFileSync('diagnostic-must-not-spawn','started')"`
    }, { signal: AbortSignal.abort(reason) });
    assert.equal(diagnostic.ok, false);
    assert.equal(diagnostic.timedOut, reason.name === 'TimeoutError');
    assert.equal(diagnostic.cancelled, reason.name !== 'TimeoutError');
    assert.equal(diagnostic.results.length, 0);
    assert.equal(fs.existsSync(marker), false, 'pre-aborted diagnostics must not execute');
    const publicDiagnostic = toolResult(serializeConnectorResult({
      publicName: 'relai_validate', action: 'diagnostics', operationName: OP.VALIDATE_DIAGNOSTICS,
      value: diagnostic, args: { workspace: 'repo', action: 'diagnostics' }
    }), true).structuredContent;
    assert.equal(publicDiagnostic.timedOut, reason.name === 'TimeoutError');
    assert.equal(publicDiagnostic.cancelled, reason.name !== 'TimeoutError');
    const validation = await fromJsonSchema(outputSchemaFor(OP.VALIDATE_DIAGNOSTICS))['~standard'].validate(publicDiagnostic);
    assert.equal(validation.issues, undefined, 'typed diagnostic timeout must satisfy its advertised public schema');
  }
  const timedOutDiagnostic = await relaiDiagnosticsRun(diagnosticWorkspace, diagnosticConfig, {
    command: 'node -e "setInterval(() => {}, 1000)"', timeoutMs: 1000
  });
  assert.equal(timedOutDiagnostic.results[0].timedOut, true);
  assert.equal(timedOutDiagnostic.timedOut, true);
  assert.equal(timedOutDiagnostic.cancelled, false);

} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Validation parallelism unit tests passed.');
