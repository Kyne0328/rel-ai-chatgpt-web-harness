// Consolidated config io coverage.
// Pure and self-contained checks share one process; tests requiring process/global isolation remain standalone.
// Add related regression checks here instead of creating another one-off test file.

// Formerly alias-consistency-unit.mjs
async function case_alias_consistency_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/config.js");
    const { normalizeConfig, publicConfigSummary } = __m4;
  
    const __m5 = await import("../src/diagnostics.js");
    const { buildDiagnosticReport } = __m5;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-command-discovery-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      scripts: {
        test: 'node test.js',
        lint: 'node lint.js'
      }
    }, null, 2));
  
    const config = normalizeConfig({
      workspaces: {
        app: {
          path: root,
          commands: { obsolete: 'npm run removed' },
          testCommands: { obsolete: 'npm run removed-test' }
        }
      }
    });
    assert.equal(Object.hasOwn(config.workspaces.app, 'commands'), false);
    assert.equal(Object.hasOwn(config.workspaces.app, 'testCommands'), false);
  
    const workspace = publicConfigSummary(config).workspaces.find(item => item.alias === 'app');
    assert.deepEqual(workspace.discoveredTestCommandKeys, ['npm:lint', 'npm:test']);
    assert.equal(Object.hasOwn(workspace, 'staleCommandKeys'), false);
    assert.equal(Object.hasOwn(workspace, 'staleTestCommandKeys'), false);
  
    const report = buildDiagnosticReport({
      workspace: 'app',
      health: { findings: [] },
      connection: { token: 'set', tunnelId: 'configured' },
      connectionState: { publicEndpoint: { status: 'available' } },
      cautionData: { workspaces: [] },
      runtimeLogs: { available: false, entries: [] },
      auditLogs: { entries: [] }
    });
    assert.equal(report.findings.some(item => item.code === 'stale_validation_commands'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  console.log('Manifest-backed command discovery hard-cutover tests passed.');
}
await case_alias_consistency_unit();

// Formerly artifact-resource-unit.mjs
async function case_artifact_resource_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:crypto");
    const crypto = __m1.default;
  
    const __m2 = await import("node:fs");
    const fs = __m2.default;
  
    const __m3 = await import("node:os");
    const os = __m3.default;
  
    const __m4 = await import("node:path");
    const path = __m4.default;
  
    const __m5 = await import("node:url");
    const { fileURLToPath } = __m5;
  
    const __m6 = await import("@modelcontextprotocol/core");
    const { CallToolResultSchema, ReadResourceResultSchema } = __m6;
  
    const __m7 = await import("./helpers/http-mcp.mjs");
    const { createHttpMcpSession } = __m7;
  
    const __m8 = await import("./helpers/http-test-server.mjs");
    const { startHttpTestServer, stopHttpTestServer } = __m8;
  
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-artifact-resource-'));
  const workspace = path.join(temp, 'workspace');
  const stateDir = path.join(temp, 'state');
  const configPath = path.join(temp, 'config.json');
  const token = 'artifact-resource-token';
  const bytes = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]),
    crypto.createHash('sha256').update('relai-artifact-resource').digest(),
    Buffer.from([0x00, 0xff, 0x01, 0x02, 0x03])
  ]);
  
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'round-trip.zip'), bytes);
  fs.writeFileSync(configPath, `${JSON.stringify({
    version: 7,
    stateDir,
    auditLogPath: path.join(stateDir, 'audit.jsonl'),
    telemetry: { enabled: false },
    processEnvironment: { allow: [] },
    workspaces: {
      artifact: {
        path: workspace,
        repoSlug: '',
        context: { snapshotMaxFiles: 100, includeRoots: [], excludePaths: [] },
        validationRules: {}
      }
    }
  }, null, 2)}\n`);
  
  const { child, base } = await startHttpTestServer({ root, configPath, token, stateDir });
  let client;
  try {
    client = await createHttpMcpSession(base, { token, clientName: 'relai-artifact-resource-test' });
    const linked = await client.request('tools/call', {
      name: 'relai_read',
      arguments: { workspace: 'artifact', paths: ['round-trip.zip'], asResource: true }
    });
    assert.equal(linked.response.status, 200, JSON.stringify(linked.body));
    assert.equal(linked.body.result?.isError, false, JSON.stringify(linked.body));
    assert.equal(CallToolResultSchema.safeParse(linked.body.result).success, true, JSON.stringify(linked.body.result));
    const resourceLink = linked.body.result?.content?.find(item => item?.type === 'resource_link');
    assert.ok(resourceLink, 'relai_read asResource must emit a standard MCP resource_link content block');
    assert.match(resourceLink.uri || '', /^relai:\/\/artifact\/[A-Za-z0-9_-]+$/);
    assert.equal(resourceLink.name, 'round-trip.zip');
    assert.equal(resourceLink.mimeType, 'application/zip');
    assert.equal(resourceLink.size, bytes.length);
    assert.equal(linked.body.result?.structuredContent?.items?.[0]?.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(linked.body.result?.structuredContent?.items?.[0]?.resourceUri, resourceLink.uri);
  
    const read = await client.request('resources/read', { uri: resourceLink.uri });
    assert.equal(read.response.status, 200, JSON.stringify(read.body));
    assert.equal(ReadResourceResultSchema.safeParse(read.body.result).success, true, JSON.stringify(read.body.result));
    const resource = read.body.result?.contents?.[0];
    assert.equal(resource?.mimeType, 'application/zip');
    assert.deepEqual(Buffer.from(resource?.blob || '', 'base64'), bytes, 'artifact resource bytes must round-trip exactly through MCP');
  
    const tamperedUri = `${resourceLink.uri.slice(0, -1)}${resourceLink.uri.endsWith('A') ? 'B' : 'A'}`;
    const tampered = await client.request('resources/read', { uri: tamperedUri });
    assert.ok(tampered.body.error, 'tampered artifact tokens must be rejected');
  
  } finally {
    if (client) await client.close().catch(() => {});
    await stopHttpTestServer(child);
    fs.rmSync(temp, { recursive: true, force: true });
  }
  
  console.log('Principal/workspace-bound taskless artifact resource_link and binary resources/read round-trip passed.');
}
await case_artifact_resource_unit();

// Formerly budget-multiplier-unit.mjs
async function case_budget_multiplier_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/budgetResolver.ts");
    const { resolveBudget } = __m1;
  
    const __m2 = await import("../src/config.js");
    const { normalizeConfig } = __m2;
  
  assert.equal(resolveBudget(100, null, { trustedBudgetMultiplier: 5 }), 100);
  console.log('1. null policy: OK');
  
  assert.equal(resolveBudget(100, { sessionActive: false }, { trustedBudgetMultiplier: 5 }), 100);
  console.log('2. session inactive: OK');
  
  assert.equal(resolveBudget(100, { sessionActive: true }, {}), 200);
  console.log('3. default multiplier: OK');
  
  assert.equal(resolveBudget(100, { sessionActive: true }, { trustedBudgetMultiplier: 3 }), 300);
  console.log('4. explicit multiplier: OK');
  
  assert.equal(resolveBudget(100, { sessionActive: true }, { trustedBudgetMultiplier: 'oops' }), 200);
  console.log('5. NaN falls back to 2: OK');
  
  assert.equal(resolveBudget(100, { sessionActive: true }, { trustedBudgetMultiplier: 50 }), 200);
  console.log('6. >10 falls back to 2: OK');
  
  assert.equal(resolveBudget(100, { sessionActive: true }, { trustedBudgetMultiplier: 0.5 }), 200);
  console.log('7. <1 falls back to 2: OK');
  
  assert.equal(resolveBudget(100, { sessionActive: true }, { trustedBudgetMultiplier: 2.7 }), 270);
  console.log('8. fractional 2.7: OK');
  
  assert.equal(normalizeConfig({}).trustedBudgetMultiplier, 2);
  console.log('9. config default: OK');
  
  assert.equal(normalizeConfig({ trustedBudgetMultiplier: 99 }).trustedBudgetMultiplier, 2);
  console.log('10. normalize clamps: OK');
  
  console.log('budget-multiplier unit tests passed.');
}
await case_budget_multiplier_unit();

// Formerly env-operations-unit.mjs
async function case_env_operations_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/envOperations.js");
    const { runEnvOperation } = __m4;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-env-operations-'));
  const workspace = { alias: 'repo', path: root };
  const config = { stateDir: path.join(root, '.state') };
  const envPath = path.join(root, '.env');
  try {
    fs.writeFileSync(envPath, '# local\nAPI_KEY=top-secret\nPORT=3000\nAPI_KEY=duplicate\ninvalid line\n', { mode: 0o600 });
    fs.writeFileSync(path.join(root, '.env.example'), 'API_KEY=\nPORT=\nDATABASE_URL=\n');
  
    const listed = runEnvOperation(workspace, config, { envAction: 'list', path: '.env' });
    assert.deepEqual(listed.keys, ['API_KEY', 'PORT']);
    assert.deepEqual(listed.malformedLines, [5]);
    assert.equal(listed.valuesReturned, false);
    assert.match(listed.sha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(listed), /top-secret|3000|duplicate/);
  
    const compared = runEnvOperation(workspace, config, { envAction: 'compare', path: '.env', templatePath: '.env.example' });
    assert.deepEqual(compared.missingKeys, ['DATABASE_URL']);
    assert.deepEqual(compared.extraKeys, []);
    assert.doesNotMatch(JSON.stringify(compared), /top-secret/);
  
    const setResult = runEnvOperation(workspace, config, { envAction: 'set', path: '.env', key: 'API_KEY', value: 'replacement', expectedSha256: listed.sha256 });
    assert.equal(setResult.changed, true);
    assert.equal(setResult.valuesReturned, false);
    const afterSet = fs.readFileSync(envPath, 'utf8');
    assert.equal((afterSet.match(/^API_KEY=/gm) || []).length, 1);
    assert.match(afterSet, /^API_KEY=replacement$/m);
    assert.doesNotMatch(JSON.stringify(setResult), /replacement|top-secret/);
  
    assert.throws(
      () => runEnvOperation(workspace, config, { envAction: 'set', path: '.env', key: 'STALE', value: 'hidden', expectedSha256: listed.sha256 }),
      /stale expectedSha256/
    );
  
    const removed = runEnvOperation(workspace, config, { envAction: 'remove', path: '.env', key: 'PORT' });
    assert.equal(removed.presentBefore, true);
    assert.equal(removed.presentAfter, false);
    assert.doesNotMatch(fs.readFileSync(envPath, 'utf8'), /^PORT=/m);
  
    const dryRun = runEnvOperation(workspace, config, { envAction: 'set', path: '.env', key: 'DRY_RUN', value: 'hidden', dryRun: true });
    assert.equal(dryRun.changed, true);
    assert.equal(dryRun.changedFiles.length, 0);
    assert.doesNotMatch(fs.readFileSync(envPath, 'utf8'), /^DRY_RUN=/m);
    assert.doesNotMatch(JSON.stringify(dryRun), /hidden/);
  
    assert.throws(() => runEnvOperation(workspace, config, { envAction: 'set', path: '.env', key: 'BAD-KEY', value: 'x' }), /must match/);
    assert.throws(() => runEnvOperation(workspace, config, { envAction: 'set', path: '.env', key: 'GOOD', value: 'a\nb' }), /single-line/);
    assert.throws(() => runEnvOperation(workspace, config, { envAction: 'list', path: 'credentials/token.txt' }), /blocked sensitive path/);
  
    console.log('Targeted environment operations passed without value disclosure.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
await case_env_operations_unit();

// Formerly openai-patch-format-unit.mjs
async function case_openai_patch_format_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
  // Access the non-exported helper via re-require with internal eval trick: re-export via test require.
  // Easier: re-load module text and detect helper presence by reading the module source. Instead, we
  // invoke through relaiApplyPatch's exported path by simulating a converted patch on a fake patch
  // rather than calling git. Since normalizeOpenAIPatchFormat is internal, expose via test surface.
    const __m1 = await import("../src/localRepoBridge.js");
    const { normalizeOpenAIPatchFormat } = __m1;
  
  assert.ok(typeof normalizeOpenAIPatchFormat === 'function', 'normalizeOpenAIPatchFormat must be exported');
  
  // 1. Plain unified diff passes through unchanged
  {
    const input = `--- a/foo.txt\n+++ b/foo.txt\n@@ -1 +1 @@\n-old\n+new\n`;
    const { patch, converted, sourceFormat } = normalizeOpenAIPatchFormat(input);
    assert.equal(patch, input, 'unified diff must pass through unchanged');
    assert.equal(converted, false, 'unified diff must not be marked converted');
    assert.equal(sourceFormat, 'unified-diff');
  }
  
  // 2. OpenAI Update File converts to unified diff with --- a/ and +++ b/ headers
  {
    const input = `*** Begin Patch\n*** Update File: lib/foo.dart\n@@ context\n-old\n+new\n*** End Patch\n`;
    const { patch, converted, sourceFormat } = normalizeOpenAIPatchFormat(input);
    assert.equal(converted, true, 'openai patch must be marked converted');
    assert.equal(sourceFormat, 'openai-patch');
    assert.ok(patch.includes('--- a/lib/foo.dart'), 'must emit --- a/ header');
    assert.ok(patch.includes('+++ b/lib/foo.dart'), 'must emit +++ b/ header');
    assert.ok(patch.includes('@@ context'), 'must preserve hunk header');
    assert.ok(patch.includes('-old'), 'must preserve removed line');
    assert.ok(patch.includes('+new'), 'must preserve added line');
  }
  
  // 3. OpenAI Add File emits /dev/null source and synthesizes hunk header
  {
    const input = `*** Begin Patch\n*** Add File: lib/new.dart\n+line1\n+line2\n*** End Patch\n`;
    const { patch, converted } = normalizeOpenAIPatchFormat(input);
    assert.equal(converted, true);
    assert.ok(patch.includes('--- /dev/null'), 'add file must use /dev/null source');
    assert.ok(patch.includes('+++ b/lib/new.dart'), 'add file must emit destination');
    assert.ok(/@@ -0,0 \+1,2 @@/.test(patch), 'add file must synthesize hunk header with line count');
    assert.ok(patch.includes('+line1'), 'add file content preserved');
    assert.ok(patch.includes('+line2'), 'add file content preserved');
  }
  
  // 4. Delete File cannot be converted to a unified diff helper; callers should pass
  // the structured patch directly to relai_edit, which handles deletion natively.
  {
    const input = `*** Begin Patch\n*** Delete File: lib/old.dart\n*** End Patch\n`;
    assert.throws(
      () => normalizeOpenAIPatchFormat(input),
      /structured OpenAI patch directly to relai_edit updateText/,
      'Delete File must direct callers to the active relai_edit path'
    );
  }
  
  // 5. Multiple Update File blocks are concatenated
  {
    const input = `*** Begin Patch\n*** Update File: a.txt\n@@\n-1\n+2\n*** Update File: b.txt\n@@\n-3\n+4\n*** End Patch\n`;
    const { patch, converted } = normalizeOpenAIPatchFormat(input);
    assert.equal(converted, true);
    assert.ok(patch.includes('--- a/a.txt'));
    assert.ok(patch.includes('--- a/b.txt'));
    assert.ok(patch.includes('+++ b/a.txt'));
    assert.ok(patch.includes('+++ b/b.txt'));
  }
  
  // 6. Empty / null input → returns empty patch, not converted, no throw
  {
    const { patch, converted } = normalizeOpenAIPatchFormat('');
    assert.equal(patch, '');
    assert.equal(converted, false);
  }
  
  console.log('openai-patch-format unit tests passed.');
}
await case_openai_patch_format_unit();

// Formerly output-spill-unit.mjs
async function case_output_spill_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/outputSpill.js");
    const { createOutputSpillWriter, outputSpillOwner, readOutputSpill } = __m4;
  
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-output-spill-'));
  const config = { stateDir };
  const spillRoot = path.join(stateDir, 'output-spills');
  
  try {
    const tasklessOwner = outputSpillOwner({ workspace: 'app', principal: 'principal-a' });
    assert.ok(tasklessOwner, 'authorized workspace execution must derive a taskless output owner');
    assert.equal(tasklessOwner, outputSpillOwner({ workspace: 'app', principal: 'principal-a' }));
    assert.notEqual(tasklessOwner, outputSpillOwner({ workspace: 'app', principal: 'principal-b' }), 'different principals must not share taskless output refs');
    const tasklessWriter = createOutputSpillWriter(config, tasklessOwner);
    tasklessWriter.start('taskless output');
    const tasklessResult = await tasklessWriter.finish();
    const tasklessSpill = readOutputSpill(config, tasklessOwner, tasklessResult.outputRef);
    assert.equal(fs.readFileSync(tasklessSpill.file, 'utf8'), 'taskless output');
    assert.throws(
      () => readOutputSpill(config, outputSpillOwner({ workspace: 'app', principal: 'principal-b' }), tasklessResult.outputRef),
      /not found for this authorized execution scope/i
    );
  
    const boundedWriter = createOutputSpillWriter(config, 'bounded-queue');
    boundedWriter.start(Buffer.alloc(8 * 1024 * 1024, 0x62));
    assert.ok(boundedWriter.pendingBytes <= 4 * 1024 * 1024, 'spill queue must remain bounded before asynchronous writes drain');
    const boundedResult = await boundedWriter.finish();
    assert.equal(boundedResult?.spillTruncated, true, 'spill queue overflow must be reported as truncation');
    const boundedSpill = readOutputSpill(config, 'bounded-queue', boundedResult.outputRef);
    assert.ok(fs.statSync(boundedSpill.file).size <= 4 * 1024 * 1024, 'bounded spill queue must cap queued output');
  
    fs.mkdirSync(path.join(spillRoot, 'legacy-empty-task'), { recursive: true });
  
    for (let index = 0; index < 120; index += 1) {
      const writer = createOutputSpillWriter(config, `task-${index}`);
      writer.start(`spill-${index}`);
      const result = await writer.finish();
      assert.ok(result?.outputRef, `spill ${index} must produce an outputRef`);
    }
  
    const directories = fs.readdirSync(spillRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
    const logFiles = directories.flatMap(directory => fs.readdirSync(path.join(spillRoot, directory))
      .filter(name => name.endsWith('.log')));
  
    assert.equal(logFiles.length, 100, 'spill pruning must enforce the 100-file retention bound');
    assert.equal(directories.length, logFiles.length, 'spill pruning must remove empty per-task directories');
    assert.equal(directories.includes('legacy-empty-task'), false, 'spill pruning must remove legacy empty task directories');
  
    const activeWriters = Array.from({ length: 101 }, (_, index) => createOutputSpillWriter(config, `active-${index}`));
    for (const [index, writer] of activeWriters.entries()) writer.start(`active-spill-${index}`);
    const activeResults = await Promise.all(activeWriters.map(writer => writer.finish()));
    assert.equal(activeResults.filter(Boolean).length, 100, 'the file cap must refuse a new spill rather than unlink an active writer');
    const firstActive = activeResults[0];
    assert.ok(firstActive?.outputRef);
    const firstActiveSpill = readOutputSpill(config, 'active-0', firstActive.outputRef);
    assert.equal(fs.readFileSync(firstActiveSpill.file, 'utf8'), 'active-spill-0', 'an active spill must survive pruning by later writers');
    const activeLogCount = fs.readdirSync(spillRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap(entry => fs.readdirSync(path.join(spillRoot, entry.name)).filter(name => name.endsWith('.log')))
      .length;
    assert.equal(activeLogCount, 100, 'active spill protection must preserve the global file-count bound');
  
    const concurrentWriters = Array.from({ length: 9 }, (_, index) => createOutputSpillWriter(config, `concurrent-${index}`));
    for (const writer of concurrentWriters) writer.start();
    const block = Buffer.alloc(32 * 1024 * 1024, 0x61);
    const concurrentResults = concurrentWriters.map(writer => {
      writer.append(block);
      return writer.finish();
    });
    const finishedConcurrentResults = await Promise.all(concurrentResults);
    const totalSpillBytes = fs.readdirSync(spillRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap(entry => fs.readdirSync(path.join(spillRoot, entry.name))
        .filter(name => name.endsWith('.log'))
        .map(name => fs.statSync(path.join(spillRoot, entry.name, name)).size))
      .reduce((sum, size) => sum + size, 0);
    assert.ok(totalSpillBytes <= 256 * 1024 * 1024, 'concurrent spill writers must enforce the 256 MiB global retention bound');
    assert.ok(finishedConcurrentResults.some(result => result?.spillTruncated), 'a writer must truncate when concurrent spills exhaust the global bound');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  
  console.log('Output spill retention removes empty task directories while preserving bounded logs.');
}
await case_output_spill_unit();

// Formerly read-connector-default-unit.mjs
async function case_read_connector_default_unit() {
  const __m0 = await import("node:fs");
    const fs = __m0.default;
  
    const __m1 = await import("node:os");
    const os = __m1.default;
  
    const __m2 = await import("node:path");
    const path = __m2.default;
  
    const __m3 = await import("node:assert/strict");
    const assert = __m3.default;
  
    const __m4 = await import("../src/localRepoBridge.js");
    const { relaiRead } = __m4;
  
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-read-default-'));
  const wsRoot = path.join(tmp, 'repo');
  fs.mkdirSync(wsRoot, { recursive: true });
  // ~300 KB text file (well over the 128 KB connector default, under the 1 MB local default)
  const bigLine = 'x'.repeat(99) + '\n';
  fs.writeFileSync(path.join(wsRoot, 'big.txt'), bigLine.repeat(3000));
  
  const config = { stateDir: path.join(tmp, 'state') };
  const workspace = { alias: 'repo', path: wsRoot };
  
  try {
    // Connector transport: default capped at 128 KB, truncated flag + range hint present.
    const connector = relaiRead(workspace, config, { paths: ['big.txt'] }, { connector: true });
    const connectorItem = connector.items[0];
    assert.equal(connectorItem.truncated, true, 'connector default must truncate a 300 KB file');
    assert.ok(connectorItem.returnedBytes <= 128 * 1024, `expected <=131072 bytes, got ${connectorItem.returnedBytes}`);
    assert.match(connectorItem.hint, /startLine/, 'truncated read must hint at line-range re-reads');
  
    // Local transport: 1 MB default returns the whole file.
    const local = relaiRead(workspace, config, { paths: ['big.txt'] }, {});
    assert.equal(local.items[0].truncated, false, 'local default must return the full 300 KB file');
    assert.equal(local.items[0].hint, undefined, 'untruncated reads carry no hint');
  
    // Explicit maxBytes always wins over the connector default.
    const explicit = relaiRead(workspace, config, { paths: ['big.txt'], maxBytes: 200000 }, { connector: true });
    assert.equal(explicit.items[0].truncated, true);
    assert.ok(explicit.items[0].returnedBytes > 128 * 1024, 'explicit maxBytes must override the connector default');
    assert.ok(explicit.items[0].returnedBytes <= 200000);
  
    console.log('Connector read default unit test passed.');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
await case_read_connector_default_unit();

// Formerly read-range-unit.mjs
async function case_read_range_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:crypto");
    const crypto = __m1.default;
  
    const __m2 = await import("node:fs");
    const fs = __m2.default;
  
    const __m3 = await import("node:os");
    const os = __m3.default;
  
    const __m4 = await import("node:path");
    const path = __m4.default;
  
    const __m5 = await import("../src/localRepoBridge.js");
    const { relaiRead } = __m5;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-read-range-'));
  const stateDir = path.join(root, 'state');
  const target = path.join(root, 'sample.txt');
  const content = 'alpha\r\nbeta\r\ngamma\r\ndelta';
  fs.writeFileSync(target, content, 'utf8');
  
  const workspace = { alias: 'sample', path: root };
  const config = { stateDir };
  const originalReadFileSync = fs.readFileSync;
  let targetReads = 0;
  
  try {
    fs.readFileSync = function patchedReadFileSync(file, ...args) {
      if (path.resolve(String(file)) === path.resolve(target)) targetReads += 1;
      return originalReadFileSync.call(this, file, ...args);
    };
  
    const ranged = relaiRead(workspace, config, {
      paths: ['sample.txt'],
      startLine: 2,
      endLine: 3,
      guidanceMode: 'none'
    }, { connector: true });
  
    assert.equal(targetReads, 1, 'relai_read must hash the already-read buffer instead of rereading the file');
    assert.equal(ranged.items.length, 1);
    assert.equal(ranged.items[0].content, 'beta\r\ngamma\r\n');
    assert.equal(ranged.items[0].bytes, Buffer.byteLength(content, 'utf8'));
    assert.equal(ranged.items[0].returnedBytes, Buffer.byteLength('beta\r\ngamma\r\n', 'utf8'));
    assert.equal(ranged.items[0].lineCount, 4);
    assert.deepEqual(ranged.items[0].lineRange, { startLine: 2, endLine: 3, totalLines: 4 });
    assert.equal(ranged.items[0].sha256, crypto.createHash('sha256').update(content, 'utf8').digest('hex'));
    assert.equal(ranged.items[0].writeGuidance, undefined);
    assert.equal(ranged.items[0].writeHint, undefined);
  
    assert.throws(() => relaiRead(workspace, config, {
      paths: ['sample.txt'],
      startLine: 4,
      endLine: 2
    }), /endLine must be greater than or equal to startLine/);
  
    const unicodePath = path.join(root, 'unicode.txt');
    const unicode = 'é'.repeat(700);
    fs.writeFileSync(unicodePath, unicode, 'utf8');
    const truncated = relaiRead(workspace, config, {
      paths: ['unicode.txt'],
      maxBytes: 1001,
      guidanceMode: 'none'
    }, { connector: true });
    assert.equal(truncated.items[0].truncated, true);
    assert.ok(truncated.items[0].returnedBytes <= 1001);
    assert.doesNotMatch(truncated.items[0].content, /�/u, 'UTF-8 truncation must not return a partial code point');
  
    // Per-path ranges: two files with different windows must resolve in one call.
    const second = path.join(root, 'second.txt');
    fs.writeFileSync(second, 'one\ntwo\nthree\nfour\nfive\n', 'utf8');
    const perPath = relaiRead(workspace, config, {
      paths: ['sample.txt', 'second.txt'],
      ranges: [
        { path: 'sample.txt', startLine: 1, endLine: 1 },
        { path: 'second.txt', startLine: 3, endLine: 4 }
      ],
      guidanceMode: 'none'
    }, { connector: true });
    assert.equal(perPath.items.length, 2);
    assert.equal(perPath.items[0].content, 'alpha\r\n');
    assert.deepEqual(perPath.items[0].lineRange, { startLine: 1, endLine: 1, totalLines: 4 });
    assert.equal(perPath.items[1].content, 'three\nfour\n');
    assert.deepEqual(perPath.items[1].lineRange, { startLine: 3, endLine: 4, totalLines: 6 });
  
    // A path without its own entry falls back to the batch-wide window.
    const mixed = relaiRead(workspace, config, {
      paths: ['sample.txt', 'second.txt'],
      startLine: 2,
      endLine: 2,
      ranges: [{ path: 'second.txt', startLine: 5 }],
      guidanceMode: 'none'
    }, { connector: true });
    assert.equal(mixed.items[0].content, 'beta\r\n', 'unlisted paths keep the batch range');
    assert.equal(mixed.items[1].content, 'five\n', 'a listed path uses its own range to end of file');
  
    // Path spelling is normalized so './x' and 'x' name the same entry.
    const normalized = relaiRead(workspace, config, {
      paths: ['./second.txt'],
      ranges: [{ path: 'second.txt', startLine: 2, endLine: 2 }],
      guidanceMode: 'none'
    }, { connector: true });
    assert.equal(normalized.items[0].content, 'two\n');
  
    // Repeated ranges for the same file preserve request order instead of collapsing
    // to the last path-keyed range.
    const repeated = relaiRead(workspace, config, {
      ranges: [
        { path: 'sample.txt', startLine: 1, endLine: 1 },
        { path: 'sample.txt', startLine: 3, endLine: 3 }
      ],
      guidanceMode: 'none'
    }, { connector: true });
    assert.equal(repeated.items.length, 2);
    assert.equal(repeated.items[0].content, 'alpha\r\n');
    assert.equal(repeated.items[1].content, 'gamma\r\n');
  
    assert.throws(() => relaiRead(workspace, config, {
      paths: ['sample.txt'],
      ranges: [{ path: 'sample.txt' }]
    }), /requires startLine or endLine/);
    assert.throws(() => relaiRead(workspace, config, {
      paths: ['sample.txt'],
      ranges: [{ path: 'sample.txt', startLine: 4, endLine: 2 }]
    }), /endLine must be greater than or equal to startLine/);
    assert.throws(() => relaiRead(workspace, config, {
      paths: ['sample.txt'],
      ranges: [{ startLine: 1 }]
    }), /require a non-empty path/);
    assert.throws(() => relaiRead(workspace, config, {
      paths: ['sample.txt'],
      ranges: 'sample.txt'
    }), /ranges must be an array/);
  } finally {
    fs.readFileSync = originalReadFileSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  console.log('relai_read range and single-read tests passed.');
}
await case_read_range_unit();

// Formerly restore-contract-unit.mjs
async function case_restore_contract_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("node:child_process");
    const { execFileSync } = __m4;
  
    const __m5 = await import("../src/bridge/restore.js");
    const { relaiResetWorkspace, relaiRestorePaths } = __m5;
  
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-restore-contract-'));
  const repo = path.join(temp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  
  function git(...args) {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  }
  
  function write(relativePath, content) {
    const file = path.join(repo, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  
  function read(relativePath) {
    return fs.readFileSync(path.join(repo, relativePath), 'utf8').replaceAll('\r\n', '\n');
  }
  
  const workspace = { alias: 'repo', path: repo };
  
  try {
    git('init', '-q');
    git('config', 'user.email', 'restore-test@example.com');
    git('config', 'user.name', 'Restore Contract Test');
    write('tracked.txt', 'saved\n');
    git('add', 'tracked.txt');
    git('commit', '-qm', 'initial');
  
    write('tracked.txt', 'changed\n');
    write('untracked.txt', 'keep\n');
    const scoped = await relaiRestorePaths(workspace, {}, { paths: ['tracked.txt'] });
    assert.equal(scoped.ok, true);
    assert.equal(read('tracked.txt'), 'saved\n');
    assert.equal(fs.existsSync(path.join(repo, 'untracked.txt')), true, 'scoped restore must not remove untracked files');
  
    write('tracked.txt', 'changed again\n');
    const trackedReset = await relaiResetWorkspace(workspace, {}, {});
    assert.equal(trackedReset.ok, true);
    assert.equal(trackedReset.removeUntracked, false);
    assert.equal(read('tracked.txt'), 'saved\n');
    assert.equal(fs.existsSync(path.join(repo, 'untracked.txt')), true, 'tracked-only reset must leave untracked files intact');
  
    write('tracked.txt', 'changed for clean\n');
    write('nested/generated.txt', 'remove\n');
    const cleanReset = await relaiResetWorkspace(workspace, {}, { removeUntracked: true });
    assert.equal(cleanReset.ok, true);
    assert.equal(cleanReset.removeUntracked, true);
    assert.equal(read('tracked.txt'), 'saved\n');
    assert.equal(fs.existsSync(path.join(repo, 'untracked.txt')), false);
    assert.equal(fs.existsSync(path.join(repo, 'nested')), false);
  
    console.log('Restore contract passed for scoped restore and approval-owned workspace reset semantics.');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
await case_restore_contract_unit();

// Formerly review-checkpoints-unit.mjs
async function case_review_checkpoints_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/reviewCheckpoints.js");
    const { createReviewCheckpoint, replayReviewCheckpoint } = __m4;
  
    const __m5 = await import("../src/tools/actionCatalog.js");
    const { getCatalogAction } = __m5;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-review-checkpoint-'));
  const config = { stateDir: path.join(root, 'state') };
  const workspace = { alias: 'app', path: path.join(root, 'repo') };
  const otherWorkspace = { alias: 'other', path: path.join(root, 'other') };
  fs.mkdirSync(workspace.path, { recursive: true });
  fs.mkdirSync(otherWorkspace.path, { recursive: true });
  
  try {
    const publicCheckpoint = getCatalogAction('relai_changes', { action: 'checkpoint' });
    assert.equal(publicCheckpoint.behavior.taskScope, 'optional', 'workspace review checkpoints must not require a synthetic task');
    assert.equal(publicCheckpoint.fields.includes('work_id'), true, 'task-scoped checkpoints must still accept an explicit work_id');
    assert.equal(publicCheckpoint.required.includes('work_id'), false);
  
    const review = {
      ok: true,
      workspace: 'app',
      reviewScope: 'task',
      reviewHash: 'review-hash-a',
      reviewedFiles: ['src/app.js'],
      diff: 'diff --git a/src/app.js b/src/app.js\n+const value = 1;\n'
    };
    const checkpoint = createReviewCheckpoint(workspace, config, review);
    assert.match(checkpoint.checkpointId, /^review_[A-Za-z0-9_-]{24,160}$/);
    assert.match(checkpoint.payloadSha256, /^[a-f0-9]{64}$/);
    assert.equal(checkpoint.replayed, false);
  
    review.diff = 'mutated caller object';
    const replay = replayReviewCheckpoint(workspace, config, checkpoint.checkpointId);
    assert.equal(replay.replayed, true);
    assert.match(replay.diff, /const value = 1/);
    assert.equal(replay.reviewHash, 'review-hash-a');
  
    assert.throws(
      () => replayReviewCheckpoint(otherWorkspace, config, checkpoint.checkpointId),
      /different workspace|Unknown review checkpoint/i,
      'review checkpoints must not cross workspace boundaries'
    );
  
    const files = [];
    for (const directory of fs.readdirSync(path.join(config.stateDir, 'review-checkpoints'))) {
      const dir = path.join(config.stateDir, 'review-checkpoints', directory);
      for (const file of fs.readdirSync(dir)) files.push(path.join(dir, file));
    }
    assert.equal(files.length, 1);
    const stored = JSON.parse(fs.readFileSync(files[0], 'utf8'));
    stored.payload.diff = 'tampered';
    fs.writeFileSync(files[0], JSON.stringify(stored));
    assert.throws(
      () => replayReviewCheckpoint(workspace, config, checkpoint.checkpointId),
      /integrity check/i,
      'replay must reject a modified stored payload'
    );
  
    console.log('Immutable review checkpoint replay, workspace isolation, and integrity tests passed.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
await case_review_checkpoints_unit();

// Formerly route-policy-unit.mjs
async function case_route_policy_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/ui/route-policy.js");
    const { canonicalPathFor, normalizeRouteKey, routeAllowsParam } = __m1;
  
  assert.equal(canonicalPathFor('settings/connection'), 'settings/connection');
  assert.equal(canonicalPathFor('connection'), 'home');
  assert.equal(canonicalPathFor('settings/diagnostics'), 'home');
  assert.equal(canonicalPathFor('settings/general'), 'home');
  assert.equal(canonicalPathFor('settings/dashboard'), 'home');
  assert.equal(canonicalPathFor('settings/desktop'), 'home');
  assert.equal(canonicalPathFor('missing'), 'home');
  assert.equal(canonicalPathFor('tools'), 'tools');
  assert.equal(canonicalPathFor('extensions'), 'extensions');
  assert.equal(canonicalPathFor('settings/advanced'), 'home');
  assert.equal(canonicalPathFor('settings/learning'), 'home');
  assert.equal(canonicalPathFor('settings/memory'), 'home');
  assert.equal(canonicalPathFor('settings/about'), 'settings/about');
  assert.equal(canonicalPathFor('processes'), 'processes');
  assert.equal(canonicalPathFor('usage'), 'usage');
  assert.equal(canonicalPathFor('reference'), 'home');
  assert.equal(canonicalPathFor('unknown/page'), 'home');
  
  assert.equal(normalizeRouteKey('#activity?workspace=app&search=read&status=failed&time=24h'), 'activity?workspace=app&search=read&status=failed&time=24h');
  assert.equal(normalizeRouteKey('activity?status=ok'), 'activity?status=ok');
  assert.equal(normalizeRouteKey('activity?status=succeeded'), 'activity?status=succeeded');
  assert.equal(normalizeRouteKey('activity?status=active'), 'activity?status=active');
  assert.equal(normalizeRouteKey('activity?status=other'), 'activity?status=other');
  assert.equal(normalizeRouteKey('tasks?workspace=app&task=task-123'), 'tasks?workspace=app&task=task-123', 'task deep links must preserve the selected task');
  assert.equal(normalizeRouteKey('code?task=task-123&file=src/app.js'), 'code?task=task-123&file=src%2Fapp.js', 'Changes deep links must preserve the selected changed file');
  const longFilePath = `src/${'nested/'.repeat(20)}${'a'.repeat(30)}.js`;
  const normalizedLongFileRoute = normalizeRouteKey(`code?task=task-123&file=${encodeURIComponent(longFilePath)}`);
  assert.equal(new URLSearchParams(normalizedLongFileRoute.split('?')[1]).get('file'), longFilePath, 'Changes deep links must preserve valid file paths longer than 160 characters');
  assert.equal(normalizeRouteKey('activity?token=secret&search=hello'), 'activity?search=hello');
  assert.equal(normalizeRouteKey('workspaces?focus=1'), 'workspaces');
  assert.equal(normalizeRouteKey('workspaces?workspace=myapp&focus=1'), 'workspaces?workspace=myapp&focus=1');
  assert.equal(normalizeRouteKey('workspaces?create=1'), 'workspaces?create=1', 'Add project deep links must preserve the create request');
  assert.equal(normalizeRouteKey('workspaces?create=true'), 'workspaces', 'Add project deep links must reject non-canonical create values');
  assert.equal(normalizeRouteKey('settings/connection?workspace=app'), 'settings/connection');
  assert.equal(normalizeRouteKey('extensions?token=secret'), 'extensions');
  
  assert.equal(routeAllowsParam('activity', 'search'), true);
  assert.equal(routeAllowsParam('code', 'file'), true);
  assert.equal(routeAllowsParam('workspaces', 'create'), true);
  assert.equal(routeAllowsParam('activity', 'token'), false);
  assert.equal(routeAllowsParam('settings', 'workspace'), false);
  
  console.log('Route policy contracts passed.');
}
await case_route_policy_unit();

// Formerly snapshot-git-summary-unit.mjs
async function case_snapshot_git_summary_unit() {
  const __m0 = await import("node:fs");
    const fs = __m0.default;
  
    const __m1 = await import("node:os");
    const os = __m1.default;
  
    const __m2 = await import("node:path");
    const path = __m2.default;
  
    const __m3 = await import("node:assert/strict");
    const assert = __m3.default;
  
    const __m4 = await import("node:child_process");
    const { spawnSync } = __m4;
  
    const __m5 = await import("../src/localRepoBridge.js");
    const { repoSnapshot } = __m5;
  
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-snap-git-'));
  const wsRoot = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(wsRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, 'src', 'app.js'), 'export const app = 1;\n');
  
  function git(...args) {
    const res = spawnSync('git', args, { cwd: wsRoot, encoding: 'utf8' });
    assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  }
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '.');
  git('commit', '-m', 'init');
  fs.writeFileSync(path.join(wsRoot, 'src', 'app.js'), 'export const app = 2;\n');
  fs.writeFileSync(path.join(wsRoot, 'src', 'new.js'), 'export const fresh = 1;\n');
  
  const config = { stateDir: path.join(tmp, 'state') };
  const workspace = { alias: 'repo', path: wsRoot };
  
  try {
    const snapshot = await repoSnapshot(workspace, config);
    assert.equal(snapshot.ok, true);
    assert.ok(snapshot.git, 'snapshot must include a git summary in a git workspace');
    assert.equal(typeof snapshot.git.branch, 'string');
    assert.equal(snapshot.git.dirtyFiles, 2, 'one modified + one untracked file');
    assert.ok(snapshot.git.changedFiles.includes('src/app.js'));
    assert.ok(snapshot.git.changedFiles.includes('src/new.js'));
  
    // Non-git workspace: snapshot still works, git field absent.
    const plainDir = path.join(tmp, 'plain');
    fs.mkdirSync(plainDir, { recursive: true });
    fs.writeFileSync(path.join(plainDir, 'a.txt'), 'a\n');
    const plain = await repoSnapshot({ alias: 'plain', path: plainDir }, config);
    assert.equal(plain.ok, true);
    assert.equal(plain.git, undefined, 'non-git workspace must omit the git summary');
  
    console.log('Snapshot git summary unit test passed.');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
await case_snapshot_git_summary_unit();
