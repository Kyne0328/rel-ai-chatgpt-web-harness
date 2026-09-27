import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { relaiVerify } from '../src/bridge/validation.js';
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
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('Validation parallelism unit tests passed.');
