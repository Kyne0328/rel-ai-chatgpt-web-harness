// Consolidated mcp tools coverage.
// Pure and self-contained checks share one process; tests requiring process/global isolation remain standalone.
// Add related regression checks here instead of creating another one-off test file.

// Formerly approval-broker-unit.mjs
async function case_approval_broker_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/mcp/approval.js");
    const { approvalRequirement } = __m1;
  
    const __m2 = await import("../src/mcp/approvalBroker.js");
    const { APPROVAL_TTL_MS,
    approvalDigest,
    requestApproval,
    supportsNativeApproval } = __m2;
  
  const principal = { clientId: 'chatgpt-session-a', authMode: 'local_session' };
  const otherPrincipal = { clientId: 'chatgpt-session-b', authMode: 'local_session' };
  const baseArgs = {
    action: 'reset',
    workspace: 'repo',
    work_id: 'work-a',
    removeUntracked: true
  };
  const requirement = approvalRequirement('relai_changes', baseArgs);
  
  assert.ok(requirement, 'destructive reset must still require approval');
  assert.equal(approvalRequirement('relai_publish', {
    action: 'push', workspace: 'repo', work_id: 'work-a', remote: 'origin', branch: 'main', dryRun: false
  }), null, 'real push must rely on publish authorization instead of a second approval interaction');
  assert.equal(approvalRequirement('relai_publish', {
    action: 'push', workspace: 'repo', work_id: 'work-a', remote: 'origin', branch: 'main', dryRun: true
  }), null, 'dry-run push must not require approval');
  assert.equal(supportsNativeApproval({}), false);
  assert.equal(supportsNativeApproval({ elicitation: {} }), true);
  assert.equal(supportsNativeApproval({ elicitation: { form: {} } }), true);
  
  assert.notEqual(approvalDigest('relai_changes', baseArgs), approvalDigest('relai_changes', { ...baseArgs, work_id: 'work-b' }));
  assert.notEqual(approvalDigest('relai_changes', baseArgs), approvalDigest('relai_changes', { ...baseArgs, removeUntracked: false }));
  assert.notEqual(approvalDigest('relai_changes', baseArgs), approvalDigest('relai_changes', { ...baseArgs, workspace: 'other' }));
  
  const unsupportedCodec = fakeCodec();
  const unsupported = await startApproval({ codec: unsupportedCodec, capabilities: {} });
  assert.equal(unsupported.isError, true);
  assert.equal(unsupported.structuredContent?.errorCode, 'APPROVAL_INTERACTION_UNAVAILABLE');
  assert.equal(unsupported.structuredContent?.approvalRequired, true);
  assert.equal(unsupported.structuredContent?.operation, 'reset');
  assert.equal(unsupported.structuredContent?.workspace, 'repo');
  assert.equal(unsupported.structuredContent?.work_id, 'work-a');
  assert.equal(Object.hasOwn(unsupported.structuredContent || {}, 'approvalId'), false, 'unsupported clients must not create pending dashboard approvals');
  assert.equal(Object.hasOwn(unsupported.structuredContent || {}, 'recovery'), false, 'unsupported clients must not advertise the removed dashboard approval fallback');
  assert.match(unsupported.structuredContent?.nextAction || '', /client that supports MCP approval elicitation/i);
  
  const nativeCodec = fakeCodec();
  const native = await startApproval({ codec: nativeCodec, capabilities: { elicitation: {} } });
  assert.equal(native.resultType, 'input_required');
  assert.equal(nativeCodec.lastClaims.kind, 'relai_approval');
  assert.equal(nativeCodec.lastClaims.workId, 'work-a');
  assert.equal(nativeCodec.lastClaims.operation, 'reset');
  assert.equal(Object.hasOwn(nativeCodec.lastClaims, 'push'), false, 'generic approval state must not carry obsolete push-target claims');
  
  for (const [label, changedArgs, changedPrincipal] of [
    ['work_id', { work_id: 'work-b' }, principal],
    ['removeUntracked', { removeUntracked: false }, principal],
    ['workspace', { workspace: 'other' }, principal],
    ['principal', {}, otherPrincipal]
  ]) {
    const result = await requestApproval({
      name: 'relai_changes',
      args: { ...baseArgs, ...changedArgs },
      requirement,
      context: { principal: changedPrincipal, clientCapabilities: { elicitation: {} } },
      rawContext: rawContext({ inputResponses: accepted(true), state: nativeCodec.lastClaims }),
      codec: nativeCodec
    });
    assert.equal(result.structuredContent?.errorCode, label === 'principal' ? 'APPROVAL_PRINCIPAL_MISMATCH' : 'APPROVAL_TARGET_CHANGED', `${label} change must reject the approval`);
  }
  
  const expiryCodec = fakeCodec();
  await startApproval({ codec: expiryCodec, capabilities: { elicitation: {} } });
  const expiredState = { ...expiryCodec.lastClaims, expiresAt: Date.now() - 1 };
  const expired = await requestApproval({
    name: 'relai_changes', args: baseArgs, requirement,
    context: { principal, clientCapabilities: { elicitation: {} } },
    rawContext: rawContext({ inputResponses: accepted(true), state: expiredState }),
    codec: expiryCodec
  });
  assert.equal(expired.structuredContent?.errorCode, 'APPROVAL_GRANT_EXPIRED');
  
  const declineCodec = fakeCodec();
  await startApproval({ codec: declineCodec, capabilities: { elicitation: {} } });
  const declined = await requestApproval({
    name: 'relai_changes', args: baseArgs, requirement,
    context: { principal, clientCapabilities: { elicitation: {} } },
    rawContext: rawContext({ inputResponses: accepted(false), state: declineCodec.lastClaims }),
    codec: declineCodec
  });
  assert.equal(declined.structuredContent?.errorCode, 'APPROVAL_DECLINED');
  
  const reuseCodec = fakeCodec();
  await startApproval({ codec: reuseCodec, capabilities: { elicitation: {} } });
  const approvedNative = await requestApproval({
    name: 'relai_changes', args: baseArgs, requirement,
    context: { principal, clientCapabilities: { elicitation: {} } },
    rawContext: rawContext({ inputResponses: accepted(true), state: reuseCodec.lastClaims }),
    codec: reuseCodec
  });
  assert.equal(approvedNative, null, 'accepted native approval must allow the original operation to continue');
  const reusedNative = await requestApproval({
    name: 'relai_changes', args: baseArgs, requirement,
    context: { principal, clientCapabilities: { elicitation: {} } },
    rawContext: rawContext({ inputResponses: accepted(true), state: reuseCodec.lastClaims }),
    codec: reuseCodec
  });
  assert.equal(reusedNative.structuredContent?.errorCode, 'APPROVAL_GRANT_CONSUMED');
  
  const timeoutCodec = fakeCodec();
  await startApproval({ codec: timeoutCodec, capabilities: { elicitation: {} } });
  const originalNow = Date.now;
  Date.now = () => originalNow() + APPROVAL_TTL_MS + 1;
  try {
    const expiredByClock = await requestApproval({
      name: 'relai_changes', args: baseArgs, requirement,
      context: { principal, clientCapabilities: { elicitation: {} } },
      rawContext: rawContext({ inputResponses: accepted(true), state: timeoutCodec.lastClaims }),
      codec: timeoutCodec
    });
    assert.equal(expiredByClock.structuredContent?.errorCode, 'APPROVAL_GRANT_EXPIRED');
  } finally {
    Date.now = originalNow;
  }
  
  console.log('Approval broker destructive-operation elicitation, unsupported-client fail-closed behavior, expiry, replay, and principal isolation tests passed.');
  
  async function startApproval({ codec, capabilities }) {
    return requestApproval({
      name: 'relai_changes',
      args: baseArgs,
      requirement,
      context: { principal, clientCapabilities: capabilities },
      rawContext: rawContext(),
      codec
    });
  }
  
  function accepted(approved) {
    return { approval: { action: 'accept', content: { approved } } };
  }
  
  function rawContext({ inputResponses, state } = {}) {
    return {
      mcpReq: {
        method: 'tools/call',
        inputResponses,
        requestState: () => state
      }
    };
  }
  
  function fakeCodec() {
    const claimsByGrant = new Map();
    return {
      lastClaims: null,
      async mint(claims) {
        const token = `grant-${claimsByGrant.size + 1}`;
        this.lastClaims = structuredClone(claims);
        claimsByGrant.set(token, structuredClone(claims));
        return token;
      },
      async verify(token) {
        const claims = claimsByGrant.get(token);
        if (!claims) throw new Error('Unknown grant');
        return structuredClone(claims);
      }
    };
  }
}
await case_approval_broker_unit();

// Formerly authorization-policy-unit.mjs
async function case_authorization_policy_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/mcp/authorizationPolicy.js");
    const { CAPABILITIES,
    assertAuthorizedToolCall,
    createConsentPolicy,
    createLocalAdminPolicy,
    isTrustedLocalPrincipal,
    requiredCapability } = __m1;
  
    const __m2 = await import("../src/tools/operationIds.js");
    const { OPERATION_IDS: OP } = __m2;
  
    const __m3 = await import("../src/mcp/approval.js");
    const { approvalDigest } = __m3;
  
  const grant = createConsentPolicy({
    capabilities: [CAPABILITIES.REPOSITORY_READ, CAPABILITIES.REPOSITORY_WRITE],
    workspaces: ['repo-a'],
    availableWorkspaces: ['repo-a', 'repo-b']
  });
  const principal = { clientId: 'client-a', authMode: 'oauth', authorizationPolicy: grant };
  assert.equal(requiredCapability(OP.READ), CAPABILITIES.REPOSITORY_READ);
  assert.equal(requiredCapability(OP.EDIT), CAPABILITIES.REPOSITORY_WRITE);
  assert.equal(requiredCapability('relai_unknown_operation'), '');
  assert.equal(assertAuthorizedToolCall({ principal, operationName: OP.READ, workspace: 'repo-a' }).kind, 'client_grant');
  assert.throws(
    () => assertAuthorizedToolCall({ principal, operationName: OP.EXEC, workspace: 'repo-a' }),
    error => error.code === 'AUTHORIZATION_DENIED' && /command:execute/.test(error.message)
  );
  assert.throws(
    () => assertAuthorizedToolCall({ principal, operationName: OP.READ, workspace: 'repo-b' }),
    error => error.code === 'AUTHORIZATION_DENIED' && /repo-b/.test(error.message)
  );
  assert.equal(assertAuthorizedToolCall({ principal: { authorizationPolicy: createLocalAdminPolicy() }, operationName: OP.PUBLISH_PUSH, workspace: 'repo-b' }).kind, 'local_admin');
  assert.equal(assertAuthorizedToolCall({ principal: 'local:trusted', operationName: OP.EXEC, workspace: 'repo-b' }).kind, 'local_admin');
  const stdioPrincipal = { clientId: 'stdio:1234567890abcdef', authMode: 'local_session' };
  assert.equal(isTrustedLocalPrincipal(stdioPrincipal), true);
  assert.equal(assertAuthorizedToolCall({ principal: stdioPrincipal, operationName: OP.EXEC, workspace: 'repo-b' }).kind, 'local_admin');
  assert.equal(isTrustedLocalPrincipal({ clientId: 'remote-client', authMode: 'local_session' }), false);
  
  const destructiveApproval = {
    action: 'reset', workspace: 'repo-a', work_id: 'work-a', removeUntracked: true
  };
  assert.notEqual(
    approvalDigest('relai_changes', destructiveApproval),
    approvalDigest('relai_changes', { ...destructiveApproval, work_id: 'work-b' }),
    'approval state must not be reusable across logical tasks'
  );
  assert.notEqual(
    approvalDigest('relai_changes', destructiveApproval),
    approvalDigest('relai_changes', { ...destructiveApproval, removeUntracked: false }),
    'approval state must bind the destructive cleanup scope instead of relying on a model-supplied confirmation token'
  );
  assert.equal(
    approvalDigest('relai_changes', { ...destructiveApproval, _operationTaskId: 'transport-a' }),
    approvalDigest('relai_changes', { ...destructiveApproval, _operationTaskId: 'transport-b' }),
    'ephemeral transport task identifiers are not approval boundaries'
  );
  
  assert.throws(
    () => assertAuthorizedToolCall({ principal, operationName: 'relai_unknown_operation', workspace: 'repo-a' }),
    error => error.code === 'AUTHORIZATION_DENIED' && error.details?.reason === 'unclassified_operation'
  );
  console.log('Client capability and workspace authorization policy tests passed.');
}
await case_authorization_policy_unit();

// Formerly connector-compaction-unit.mjs
async function case_connector_compaction_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/tools.js");
    const { compactForConnector, policySentence } = __m1;
  
  const idleStatus = compactForConnector('work.status', {
    ok: true,
    version: '0.17.1',
    toolSurface: {
      schemaVersion: 1,
      toolSurfaceVersion: 12,
      toolCount: 20,
      tools: [{ name: 'relai_read', state: 'active' }],
      deprecations: []
    },
    tools: ['relai_read', 'relai_edit'],
    toolGroups: { workspace: [], git: [], audit: [], cleanup: [], internal: ['relai_set_policy'] },
    scripts: ['start', 'test', 'build', 'lint'],
    ci: { ok: true, files: 2, missing: [] },
    workspace: {
      alias: 'app', root: '/repo', commandKeys: [], testCommandKeys: ['test'],
      policy: { trusted: true, sessionActive: false, baselineDirty: [], source: 'default' },
      repository: {
        ok: true, workspace: 'app', branch: 'main', status: ' M src/app.js\n?? generated.txt\n',
        statusEntries: [{ path: 'src/app.js', owner: 'unknown', raw: ' M src/app.js' }],
        changedFiles: ['src/app.js', 'generated.txt'], untrackedFiles: ['generated.txt'],
        sessionChangedFiles: [], baselineChangedFiles: []
      }
    },
    workspaceCount: 2,
    workspaceAliases: ['app', 'worker']
  }, {});
  assert.equal(idleStatus.toolGroups, undefined, 'toolGroups must be dropped');
  assert.equal(idleStatus.scripts, undefined, 'server scripts must be dropped');
  assert.equal(idleStatus.ci, undefined, 'server CI scan must be dropped');
  assert.equal(idleStatus.tools, undefined, 'tools list must be dropped');
  assert.equal(idleStatus.workspace.policy, undefined, 'raw policy object must be dropped');
  assert.equal(idleStatus.workspace.root, undefined, 'connector status must not expose the absolute workspace root');
  assert.equal(idleStatus.state, undefined, 'idle workspace must have no state line');
  assert.equal(idleStatus.workspace.commandKeys, undefined, 'empty arrays pruned');
  assert.equal(idleStatus.workspace.testCommandKeys, undefined, 'compact connector status must not expose workspace command metadata');
  assert.equal(idleStatus.workspace.alias, 'app', 'compact status must retain workspace identity');
  assert.equal(idleStatus.workspace.repository, undefined, 'default compact status must omit repository details; request detail:"full" when repository state is needed');
  assert.equal(idleStatus.version, '0.17.1');
  assert.equal(idleStatus.toolSurface.toolSurfaceVersion, 12); // rigidity-ok: synthetic fixture verifies arbitrary metadata survives compaction
  assert.equal(idleStatus.toolSurface.toolCount, 20); // rigidity-ok: synthetic fixture deliberately differs from the live tool count
  assert.deepEqual(idleStatus.toolSurface.deprecations, []);
  assert.equal(Object.hasOwn(idleStatus.toolSurface, 'compatibilityAliases'), false);
  assert.equal(idleStatus.toolSurface.tools, undefined, 'compact status must not duplicate the full per-tool manifest');
  assert.equal(idleStatus.workspaceCount, 2);
  assert.deepEqual(idleStatus.workspaceAliases, ['app', 'worker'], 'compact status must retain configured aliases');
  console.log('1. idle work.status compacted: OK');
  
  const activeStatus = compactForConnector('work.status', {
    ok: true, version: '0.17.1', workspaceCount: 2, workspaceAliases: ['app', 'worker'],
    workspace: {
      alias: 'app', root: '/repo',
      policy: { trusted: true, sessionActive: true, taskHint: 'add login', baselineDirty: ['a.txt'], source: 'session_file' }
    }
  }, {});
  assert.match(activeStatus.state, /Session active: add login/);
  assert.match(activeStatus.state, /1 pre-existing dirty file/);
  assert.deepEqual(activeStatus.workspaceAliases, ['app', 'worker']);
  console.log('2. active work.status compacted: OK');
  
  assert.equal(policySentence(null), null);
  assert.equal(policySentence({ sessionActive: false }), null);
  assert.equal(policySentence({ sessionActive: true }), 'Session active.');
  console.log('3. policy sentence: OK');
  
  const checksCompact = compactForConnector('validate.checks', {
    ok: true, workspace: 'app', level: 'standard',
    checks: ['npm run check'], commands: ['npm run check'],
    results: [{ command: 'npm run check', ok: true, exitCode: 0, durationMs: 50, stdout: 'success noise', stderr: '', stdoutBytes: 13, stderrBytes: 0 }],
    validationLevel: 'focused', validationLevelReason: 'single source file',
    changedFiles: ['x.js'], policy: { trusted: true, sessionActive: false, baselineDirty: [], source: 'default' }
  }, {});
  assert.equal(checksCompact.commands, undefined, 'duplicate commands array dropped');
  assert.equal(checksCompact.validationLevel, undefined, 'internal telemetry dropped');
  assert.equal(checksCompact.changedFiles, undefined, 'changedFiles telemetry dropped');
  assert.equal(checksCompact.policy, undefined, 'default policy dropped');
  assert.deepEqual(checksCompact.checks, ['npm run check']);
  assert.equal(checksCompact.results[0].stdout, undefined, 'successful check output must be omitted');
  assert.equal(checksCompact.results[0].durationMs, 50);
  const failedChecksCompact = compactForConnector('validate.checks', {
    ok: false,
    results: [{ command: 'npm test', ok: false, exitCode: 1, stderr: 'failure details', stderrBytes: 15 }]
  }, {});
  assert.equal(failedChecksCompact.results[0].stderr, 'failure details', 'failed check diagnostics must remain actionable');
  const completedChecksCompact = compactForConnector('validate.checks', {
    ok: true, workspace: 'app', level: 'standard', checks: ['npm test'], results: [{ command: 'npm test', ok: true }],
    validated: true, validationStatus: 'passed', completionKnown: true, endReason: 'explicit_completion',
    completionSource: 'relai_validate:checks', summary: 'Validated and completed.', validationAt: '2026-07-26T08:00:00.000Z',
    changedFiles: ['src/app.js'],
    message: 'Validation passed and task completion was accepted.', nextAction: 'No more calls.'
  }, {});
  assert.equal(completedChecksCompact.completionKnown, true);
  assert.equal(completedChecksCompact.completionSource, 'relai_validate:checks');
  assert.equal(completedChecksCompact.summary, 'Validated and completed.');
  assert.deepEqual(completedChecksCompact.changedFiles, ['src/app.js']);
  console.log('4. validate.checks compacted: OK');
  
  const execCompact = compactForConnector('exec', {
    ok: false,
    workspace: 'app',
    command: 'npm test',
    commandSummary: 'npm test',
    cwd: '.',
    shell: 'PowerShell 7',
    exitCode: 2,
    durationMs: 500,
    stdout: 'test output',
    stderr: 'test failed',
    stdoutBytes: 11,
    stderrBytes: 11,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    environmentKeys: ['CI'],
    changedFiles: ['package-lock.json'],
    changedFilesTruncated: false,
    mutationTracking: 'git'
  }, {});
  assert.equal(execCompact.commandSummary, undefined, 'audit-only command summary must stay internal');
  assert.equal(execCompact.exitCode, 2);
  assert.equal(execCompact.stderr, 'test failed');
  assert.deepEqual(execCompact.changedFiles, ['package-lock.json']);
  assert.deepEqual(execCompact.environmentKeys, ['CI']);
  const execSuccessCompact = compactForConnector('exec', {
    ok: true,
    workspace: 'app',
    command: 'node --check src/index.js',
    cwd: '.',
    shell: 'PowerShell 7',
    exitCode: 0,
    durationMs: 40,
    stdout: '',
    stderr: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    changedFiles: [],
    changedFilesTruncated: false,
    mutationTracking: 'git'
  }, {});
  assert.equal(execSuccessCompact.cwd, undefined);
  assert.equal(execSuccessCompact.shell, 'PowerShell 7');
  assert.equal(execSuccessCompact.stdout, undefined);
  assert.equal(execSuccessCompact.changedFiles, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(execSuccessCompact)) < 1000);
  console.log('5. relai_exec compacted: OK');
  
  const snapshotCompact = compactForConnector('snapshot', {
    ok: true, workspace: 'app', root: '/repo',
    flow: { mode: 'standard', prepared: {} },
    manifests: ['package.json'],
    manifestContents: { 'package.json': '{"a":1}'.repeat(500) },
    discoveredCommands: { test: 'npm test' },
    projectInstructions: { sources: ['AGENTS.md'], content: 'Follow the repository rules.', truncated: false },
    fileCount: 10, files: ['a.js'], hints: ['Node'],
    effectiveMaxEntries: 1000, budgetMultiplied: false,
    recommendedFlow: ['relai_read'],
    operationJournal: { path: '/state/journal', recent: [] },
    writeGuidance: { flow: {}, modes: {} },
    skipped: [{ path: 'x.bin', reason: 'binary-looking file' }],
    git: { branch: 'main', aheadBehind: { ahead: 0, behind: 0 }, dirtyFiles: 1, changedFiles: ['src/app.js'] },
  }, {});
  assert.equal(snapshotCompact.manifestContents, undefined, 'manifest full text dropped');
  assert.equal(snapshotCompact.root, undefined, 'connector snapshot must not expose the absolute workspace root');
  assert.equal(snapshotCompact.flow, undefined, 'prepared-workflow internals dropped');
  assert.equal(snapshotCompact.operationJournal, undefined, 'journal dropped');
  assert.equal(snapshotCompact.writeGuidance, undefined, 'static guidance blob dropped');
  assert.deepEqual(snapshotCompact.manifests, ['package.json'], 'manifest names kept');
  assert.deepEqual(snapshotCompact.hints, ['Node']);
  assert.deepEqual(snapshotCompact.projectInstructions, { sources: ['AGENTS.md'], content: 'Follow the repository rules.', truncated: false });
  assert.equal(snapshotCompact.skipped, undefined, 'skipped entry list dropped on connector');
  assert.equal(snapshotCompact.skippedCount, 1, 'skipped list replaced by a count');
  assert.deepEqual(snapshotCompact.git, { branch: 'main', aheadBehind: { ahead: 0, behind: 0 }, dirtyFiles: 1, changedFiles: ['src/app.js'] }, 'git summary passes through compaction');
  const largeSnapshot = compactForConnector('snapshot', {
    ok: true,
    workspace: 'app',
    fileCount: 2000,
    files: Array.from({ length: 2000 }, (_, index) => `src/generated/path-${String(index).padStart(4, '0')}.js`)
  }, {});
  assert.equal(largeSnapshot.truncated, true);
  assert.ok(largeSnapshot.omittedFiles > 0);
  assert.equal(typeof largeSnapshot.returnedFileCount, 'number');
  assert.ok(Buffer.byteLength(JSON.stringify(largeSnapshot)) < 16000);
  console.log('6. repo snapshot compacted: OK');
  
  const readCompact = compactForConnector('read', {
    ok: true, workspace: 'app',
    items: [
      { type: 'file', path: 'small.js', bytes: 40, content: 'export const x = 1;', cacheHit: false,
        writeGuidance: { recommendedMode: 'direct-write', reasons: ['normal-sized file'], localizedEdit: {}, multiFileChange: {} } },
      { type: 'file', path: 'big.dart', bytes: 90000, content: '...',
        writeGuidance: { recommendedMode: 'exact-replace', reasons: ['file is 90000 bytes'], wholeFileReplacement: {}, multiFileChange: {} } }
    ],
    skipped: []
  }, {});
  assert.equal(readCompact.items[0].writeGuidance, undefined, 'nested guidance dropped');
  assert.equal(readCompact.items[0].cacheHit, undefined, 'cacheHit debug field dropped');
  assert.equal(readCompact.items[0].writeHint, undefined, 'normal file gets no hint');
  assert.equal(readCompact.items[1].writeGuidance, undefined, 'nested guidance dropped on large file');
  assert.match(readCompact.items[1].writeHint, /oldText\/newText/, 'large file gets a compact hint');
  assert.equal(readCompact.items[1].content, '...', 'file content preserved');
  
  const fullRead = compactForConnector('read', {
    ok: true,
    items: [{ path: 'big.dart', cacheHit: true, writeGuidance: { recommendedMode: 'exact-replace' } }]
  }, { guidanceMode: 'full' });
  assert.equal(fullRead.items[0].cacheHit, undefined, 'cache metadata stays hidden in full guidance mode');
  assert.deepEqual(fullRead.items[0].writeGuidance, { recommendedMode: 'exact-replace' });
  console.log('7. relai_read compacted: OK');
  
  const processList = compactForConnector('process.list', {
    ok: true,
    count: 1,
    processes: [{
      ok: true,
      processId: 'proc_example',
      pid: 100,
      workspace: 'app',
      workspaceId: 'app',
      label: 'Development server',
      kind: 'service',
      purpose: 'Serve the frontend.',
      commandSummary: 'npm run dev',
      cwd: '.',
      status: 'running',
      lifecycle: 'persistent',
      metadataRevision: 'revision12345678',
      startedAt: '2026-08-02T00:00:00.000Z',
      stdoutBytes: 10,
      stderrBytes: 0,
      environmentKeys: []
    }]
  }, {});
  assert.equal(processList.processes[0].commandSummary, undefined);
  assert.equal(processList.processes[0].workspaceId, undefined);
  assert.equal(processList.processes[0].kind, 'service');
  const emptyProcessList = compactForConnector('process.list', {
    ok: true,
    count: 0,
    processes: []
  }, {});
  assert.deepEqual(emptyProcessList.processes, [], 'empty process lists must preserve the required processes array');
  assert.equal(emptyProcessList.count, 0);
  const processDelta = compactForConnector('process.read', {
    ok: true,
    processId: 'proc_example',
    status: 'running',
    metadataRevision: 'revision12345678',
    stdout: { text: '', nextOffset: 10 },
    stderr: { text: '', nextOffset: 0 }
  }, {});
  assert.ok(Buffer.byteLength(JSON.stringify(processDelta)) < 500);
  console.log('8. process results compacted: OK');
  
  console.log('connector compaction unit tests passed.');
}
await case_connector_compaction_unit();

// Formerly connector-refresh-modal-unit.mjs
async function case_connector_refresh_modal_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/ui/connector-refresh-modal.js");
    const { acknowledgeConnectorRefreshNotice,
    prepareConnectorRefreshNotice } = __m1;
  
    const __m2 = await import("../src/ui/features/settings/connection-guidance.js");
    const { CHATGPT_REFRESH_BUSINESS_NOTE, CHATGPT_REFRESH_STEPS } = __m2;
  
  function memoryStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
      getItem: key => values.get(key) || null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
      values
    };
  }
  
  const freshInstallStorage = memoryStorage();
  assert.equal(prepareConnectorRefreshNotice({
    currentVersion: '0.27.4',
    previousVersion: '',
    firstLaunch: true,
    updated: false,
    connectorRevision: 'surface-61',
    connectorRefreshRequired: false
  }, freshInstallStorage), null, 'fresh installs must not be told to refresh a connector that was not previously registered');
  
  const updateStorage = memoryStorage();
  const updateNotice = prepareConnectorRefreshNotice({
    currentVersion: '0.27.4',
    previousVersion: '0.27.3',
    firstLaunch: false,
    updated: true,
    connectorRevision: 'surface-61',
    connectorRefreshRequired: true
  }, updateStorage);
  assert.ok(updateNotice, '0.27.4 must require a connector refresh when its connector revision changed');
  assert.deepEqual(updateNotice.steps, CHATGPT_REFRESH_STEPS);
  assert.equal(updateNotice.businessNote, CHATGPT_REFRESH_BUSINESS_NOTE);
  assert.match(updateNotice.steps.join(' '), /Go\/Plus\/Pro.*Settings.*Plugins.*Rel\.AI MCP.*Information.*Refresh/i);
  assert.match(updateNotice.steps.join(' '), /Enterprise\/Edu.*Workspace settings.*Apps.*Action control.*Refresh/i);
  assert.match(updateNotice.businessNote, /Business.*recreate and republish/i);
  assert.equal('dismissDelayMs' in updateNotice, false, 'connector refresh notices must never impose a timed dismissal lockout');
  
  const nextLaunchNotice = prepareConnectorRefreshNotice({
    currentVersion: '0.27.4',
    previousVersion: '',
    firstLaunch: false,
    updated: false,
    connectorRevision: 'surface-61',
    connectorRefreshRequired: false
  }, updateStorage);
  assert.ok(nextLaunchNotice, 'an unacknowledged refresh notice must survive a restart after the update launch');
  
  acknowledgeConnectorRefreshNotice(nextLaunchNotice, updateStorage);
  assert.equal(prepareConnectorRefreshNotice({ currentVersion: '0.27.4', connectorRevision: 'surface-61', connectorRefreshRequired: true }, updateStorage), null, 'acknowledged notices must not reappear for the same connector revision');
  
  assert.equal(prepareConnectorRefreshNotice({
    currentVersion: '0.27.5',
    previousVersion: '0.27.4',
    updated: true,
    connectorRevision: 'surface-61',
    connectorRefreshRequired: false
  }, memoryStorage()), null, 'an app update with unchanged connector definitions must stay silent');
  
  const futureStorage = memoryStorage();
  const futureNotice = prepareConnectorRefreshNotice({
    currentVersion: '9.9.9',
    previousVersion: '9.9.8',
    updated: true,
    connectorRevision: 'future-surface',
    connectorRefreshRequired: true
  }, futureStorage);
  assert.ok(futureNotice, 'future connector changes must not depend on a hand-maintained version allowlist');
  assert.match(futureNotice.description, /9\.9\.9 changed its ChatGPT action definitions/i);
  
  const sameVersionNotice = prepareConnectorRefreshNotice({
    currentVersion: '9.9.9',
    previousVersion: '',
    updated: false,
    connectorRevision: 'future-surface-2',
    connectorRefreshRequired: true
  }, memoryStorage());
  assert.ok(sameVersionNotice, 'a changed connector revision can request refresh even when the app version is unchanged');
  
  console.log('Connector refresh modal behavior tests passed.');
}
await case_connector_refresh_modal_unit();

// Formerly connector-result-contract-unit.mjs
async function case_connector_result_contract_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("@modelcontextprotocol/server");
    const { fromJsonSchema } = __m1;
  
    const __m2 = await import("../src/tools/connector.js");
    const { serializeConnectorResult } = __m2;
  
    const __m3 = await import("../src/tools/operationIds.js");
    const { OPERATION_IDS: OP } = __m3;
  
    const __m4 = await import("../src/tools/schema.js");
    const { getPublicToolSchemas } = __m4;
  
    const __m5 = await import("../src/tools/task.js");
    const { taskBootstrapFromSnapshot } = __m5;
  
  const compactBootstrap = taskBootstrapFromSnapshot({
    manifests: ['package.json'], discoveredCommands: { test: 'npm test' }, projectInstructions: { summary: 'Use project rules.' },
    fileCount: 64, files: Array.from({ length: 64 }, (_, index) => `src/file-${index}.js`), truncated: true,
    hints: ['node'], git: { branch: 'main' }, recommendedFlow: ['Search first.']
  }, 'compact');
  assert.equal(compactBootstrap.files, undefined, 'compact task bootstrap must not return a repository file listing');
  assert.equal(compactBootstrap.fileCount, undefined, 'a truncated compact scan must not present its scan cap as the repository file count');
  assert.equal(compactBootstrap.manifests[0], 'package.json');
  
  const fullBootstrap = taskBootstrapFromSnapshot({
    manifests: ['package.json'], discoveredCommands: {}, projectInstructions: {}, fileCount: 2,
    files: ['src/a.js', 'src/b.js'], truncated: false, hints: [], git: {}, recommendedFlow: [],
    manifestContents: { 'package.json': '{}' }, skipped: [], writeGuidance: {}, operationJournal: []
  }, 'full');
  assert.deepEqual(fullBootstrap.files, ['src/a.js', 'src/b.js'], 'full task bootstrap must retain the explicit file listing');
  assert.equal(fullBootstrap.fileCount, 2);
  
  const cases = [
    fixture('relai_work:begin', 'relai_work', 'begin', OP.WORK_BEGIN, 'work_begin', {
      ok: true, workspace: 'repo', work_id: 'work_begin', status: 'planning', identity: 'work_session',
      workspaceBinding: { alias: 'repo' }, title: 'Contract work', objective: 'Characterize results.', intent: 'investigation',
      activeRelatedWork: [{ goal: 'Sibling task', status: 'running' }], nextAction: 'Use bootstrap.'
    }, {
      ok: true, workspace: 'repo', work_id: 'work_begin', status: 'planning', identity: 'work_session',
      title: 'Contract work', objective: 'Characterize results.', intent: 'investigation', activeRelatedWork: [{ goal: 'Sibling task', status: 'running' }], nextAction: 'Use bootstrap.'
    }),
    fixture('relai_work:plan', 'relai_work', 'plan', OP.WORK_PLAN, 'work_plan', {
      ok: true, workspace: 'repo', work_id: 'work_plan',
      plan: { revision: 3, steps: [
        { id: 'inspect', title: 'Inspect implementation', status: 'completed' },
        { id: 'validate', title: 'Run focused validation', status: 'in_progress' }
      ] },
      message: 'Task plan updated with 2 steps.'
    }, {
      ok: true, workspace: 'repo', work_id: 'work_plan',
      plan: { revision: 3, steps: [
        { id: 'inspect', title: 'Inspect implementation', status: 'completed' },
        { id: 'validate', title: 'Run focused validation', status: 'in_progress' }
      ] },
      message: 'Task plan updated with 2 steps.'
    }),
    fixture('relai_work:status', 'relai_work', 'status', OP.WORK_STATUS, 'work_status', {
      ok: true, version: '0.24.0', runtime: 'node', tools: ['relai_read'],
      toolSurface: { schemaVersion: 5, toolSurfaceVersion: 32, toolCount: 12, tools: [{ name: 'relai_read' }], deprecations: [] },
      activeRelatedWork: [{ goal: 'Sibling task', status: 'running' }], workspaceCount: 1, workspaceAliases: ['repo']
    }, {
      ok: true, version: '0.24.0', runtime: 'node', toolSurface: { schemaVersion: 5, toolSurfaceVersion: 32, toolCount: 12 },
      activeRelatedWork: [{ goal: 'Sibling task', status: 'running' }], workspaceCount: 1, workspaceAliases: ['repo'], work_id: 'work_status'
    }),
    fixture('relai_read', 'relai_read', '', OP.READ, 'work_read', {
      ok: true, workspace: 'repo', items: [{ type: 'file', path: 'README.md', bytes: 12, content: '# Project\n', cacheHit: false, writeGuidance: { recommendedMode: 'direct-write' } }], skipped: []
    }, {
      ok: true, workspace: 'repo', items: [{ type: 'file', path: 'README.md', bytes: 12, content: '# Project\n' }], work_id: 'work_read'
    }, { guidanceMode: 'none' }),
    fixture('relai_snapshot', 'relai_snapshot', '', OP.SNAPSHOT, 'work_snapshot', {
      ok: true, workspace: 'repo', fileCount: 700, files: ['src/index.js', 'src/other.js'], skipped: [], truncated: false,
      manifests: ['package.json'], discoveredCommands: {}, projectInstructions: {}, hints: [], git: {}, recommendedFlow: []
    }, {
      ok: true, workspace: 'repo', manifests: ['package.json'], discoveredCommands: {}, projectInstructions: {},
      fileCount: 700, files: ['src/index.js', 'src/other.js'], returnedFileCount: 2, omittedFiles: 0, skippedCount: 0, truncated: false,
      git: {}, work_id: 'work_snapshot'
    }),  fixture('relai_exec', 'relai_exec', '', OP.EXEC, 'work_exec', {
      ok: false, workspace: 'repo', command: 'npm test', commandSummary: 'npm test', cwd: '.', shell: 'PowerShell 7', exitCode: 1,
      durationMs: 120, stdout: 'running', stderr: 'failed', stdoutBytes: 7, stderrBytes: 6, stdoutTruncated: false,
      stderrTruncated: false, timedOut: false, environmentKeys: ['CI'], changedFiles: ['package-lock.json'], changedFilesTruncated: false, mutationTracking: 'git'
    }, {
      ok: false, workspace: 'repo', command: 'npm test', shell: 'PowerShell 7', exitCode: 1, durationMs: 120, stdout: 'running', stderr: 'failed', stdoutBytes: 7,
      stderrBytes: 6, environmentKeys: ['CI'], changedFiles: ['package-lock.json'], mutationTracking: 'git', work_id: 'work_exec'
    }),
    fixture('relai_process:read', 'relai_process', 'read', OP.PROCESS_READ, 'work_process', {
      ok: true, processId: 'proc_1', pid: 123, workspace: 'repo', workspaceId: 'repo', label: 'Server', kind: 'service', purpose: 'Serve.',
      commandSummary: 'npm run dev', cwd: '.', status: 'running', metadataRevision: 'rev_1', startedAt: '2026-08-05T00:00:00.000Z',
      stdoutBytes: 10, stderrBytes: 0, stdout: { text: 'ready\n', nextOffset: 10 }, stderr: { text: '', nextOffset: 0 }
    }, {
      ok: true, processId: 'proc_1', pid: 123, workspace: 'repo', label: 'Server', kind: 'service', purpose: 'Serve.', status: 'running',
      metadataRevision: 'rev_1', startedAt: '2026-08-05T00:00:00.000Z', stdoutBytes: 10,
      stdout: { text: 'ready\n', nextOffset: 10 }, stderr: { text: '', nextOffset: 0 }, work_id: 'work_process'
    }),
    fixture('relai_process:list-empty', 'relai_process', 'list', OP.PROCESS_LIST, 'work_process_list', {
      ok: true, processes: [], count: 0
    }, {
      ok: true, processes: [], count: 0, work_id: 'work_process_list'
    }),
    fixture('relai_search:semantic-max-bytes', 'relai_search', 'semantic', OP.SEARCH_SEMANTIC, 'work_semantic', {
      ok: true, workspace: 'repo', query: 'needle', maxBytes: 4096, resultCount: 0, matchCount: 0, returnedBytes: 0, truncated: false
    }, {
      ok: true, workspace: 'repo', query: 'needle', maxBytes: 4096, resultCount: 0, matchCount: 0, returnedBytes: 0, truncated: false, work_id: 'work_semantic'
    }),
    fixture('relai_validate:diagnostics-empty', 'relai_validate', 'diagnostics', OP.VALIDATE_DIAGNOSTICS, 'work_diagnostics', {
      ok: true, workspace: 'repo', commands: ['node --check src/index.js'], results: [], diagnostics: [], diagnosticCount: 0, completedUnits: 1, totalUnits: 1, cancelled: false, truncated: false
    }, {
      ok: true, workspace: 'repo', commands: ['node --check src/index.js'], diagnostics: [], diagnosticCount: 0, completedUnits: 1, totalUnits: 1, cancelled: false, truncated: false, work_id: 'work_diagnostics'
    }),
    fixture('relai_validate:checks', 'relai_validate', 'checks', OP.VALIDATE_CHECKS, 'work_checks', {
      ok: true, workspace: 'repo', level: 'standard', checks: ['npm test'], commands: ['npm test'],
      results: [{ command: 'npm test', ok: true, exitCode: 0, durationMs: 40, stdout: 'noise', stderr: '', stdoutBytes: 5, stderrBytes: 0 }],
      validated: true, validationStatus: 'passed', completionKnown: true, endReason: 'explicit_completion', completionSource: 'relai_validate:checks',
      summary: 'Validated.', validationAt: '2026-08-05T00:00:00.000Z', changedFiles: ['src/index.js'], message: 'Validation passed.'
    }, {
      ok: true, workspace: 'repo', level: 'standard', checks: ['npm test'],
      results: [{ command: 'npm test', ok: true, exitCode: 0, durationMs: 40, stdoutBytes: 5 }],
      validated: true, validationStatus: 'passed', completionKnown: true, endReason: 'explicit_completion', completionSource: 'relai_validate:checks',
      summary: 'Validated.', validationAt: '2026-08-05T00:00:00.000Z', changedFiles: ['src/index.js'], message: 'Validation passed.', work_id: 'work_checks'
    }),
    fixture('relai_changes:diff', 'relai_changes', 'diff', OP.CHANGES_DIFF, 'work_diff', {
      ok: true, workspace: 'repo', branch: 'main', status: ' M src/index.js\n M baseline.js\n', changedFiles: ['src/index.js', 'baseline.js'], untrackedFiles: [],
      statusEntries: [{ path: 'src/index.js' }, { path: 'baseline.js' }], staged: false, path: 'src/index.js',
      sessionChangedFiles: ['src/index.js'], baselineChangedFiles: ['baseline.js'], untrackedSessionFiles: ['new.js'], untrackedBaselineFiles: ['old.tmp'], baselineSource: 'session',
      diff: 'diff --git a/src/index.js b/src/index.js'
    }, {
      ok: true, workspace: 'repo', branch: 'main', status: ' M src/index.js\n M baseline.js\n', changedFiles: ['src/index.js', 'baseline.js'], staged: false,
      path: 'src/index.js', sessionChangedFiles: ['src/index.js'], baselineChangedFiles: ['baseline.js'], untrackedSessionFiles: ['new.js'], untrackedBaselineFiles: ['old.tmp'], baselineSource: 'session',
      diff: 'diff --git a/src/index.js b/src/index.js', work_id: 'work_diff'
    }),
    fixture('relai_publish:commit', 'relai_publish', 'commit', OP.PUBLISH_COMMIT, 'work_commit', {
      ok: true, workspace: 'repo', commit: 'abc123', message: 'Committed.', changedFiles: []
    }, { ok: true, workspace: 'repo', commit: 'abc123', message: 'Committed.', work_id: 'work_commit' }),
    fixture('relai_publish:push', 'relai_publish', 'push', OP.PUBLISH_PUSH, 'work_push', {
      ok: true, workspace: 'repo', remote: 'origin', branch: 'main', dryRun: false, setUpstream: false, push: { exitCode: 0 }
    }, { ok: true, workspace: 'repo', remote: 'origin', branch: 'main', dryRun: false, setUpstream: false, push: { exitCode: 0 }, work_id: 'work_push' })
  ];
  
  const publicOutputValidators = new Map(getPublicToolSchemas().map(tool => [
    tool.name,
    fromJsonSchema(tool.outputSchema)['~standard']
  ]));
  
  for (const item of cases) {
    const before = structuredClone(item.internal);
    const external = serializeConnectorResult({
      publicName: item.publicTool,
      action: item.action,
      operationName: item.operation,
      value: item.internal,
      args: item.args,
      workId: item.workId
    });
    assert.deepEqual(item.internal, before, `${item.name} serialization mutated the internal result`);
    assert.deepEqual(external, item.expected, `${item.name} connector contract changed`);
    const validation = await publicOutputValidators.get(item.publicTool).validate(external);
    assert.equal(validation.issues, undefined, `${item.name} serialized result must satisfy its advertised public output schema`);
  }
  console.log(`${cases.length} internal-to-connector result contracts passed.`);
  
  function fixture(name, publicTool, action, operation, workId, internal, expected, args = {}) {
    return { name, publicTool, action, operation, workId, internal, expected, args };
  }
}
await case_connector_result_contract_unit();

// Formerly mcp-2026-header-unit.mjs
async function case_mcp_2026_header_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("@modelcontextprotocol/server");
    const { CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY } = __m1;
  
    const __m2 = await import("../src/http/mcpTransport.ts");
    const { MCP_PROTOCOL_VERSION,
    expectedMcpName,
    validateMcpRequestHeaders } = __m2;
  
  function message(method = 'server/discover', params = {}) {
    return {
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
          [CLIENT_INFO_META_KEY]: { name: 'header-unit', version: '1.0.0' },
          [CLIENT_CAPABILITIES_META_KEY]: {},
          ...(params._meta || {})
        }
      }
    };
  }
  
  function headers(method = 'server/discover', name = '') {
    return {
      'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      'mcp-method': method,
      ...(name ? { 'mcp-name': name } : {})
    };
  }
  
  assert.deepEqual(validateMcpRequestHeaders(headers(), message()), { ok: true });
  assert.deepEqual(validateMcpRequestHeaders(headers(), {
    jsonrpc: '2.0', id: 1, method: 'server/discover', params: {
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
        [CLIENT_CAPABILITIES_META_KEY]: {}
      }
    }
  }), { ok: true }, 'clientInfo is optional in MCP 2026-07-28');
  assert.equal(validateMcpRequestHeaders({}, message()).code, -32022);
  assert.deepEqual(
    validateMcpRequestHeaders({
      'mcp-protocol-version': '2025-11-25',
      'mcp-method': 'server/discover'
    }, message()).data,
    { supported: [MCP_PROTOCOL_VERSION], requested: '2025-11-25' }
  );
  assert.equal(
    validateMcpRequestHeaders(headers('tools/list'), message('server/discover')).code,
    -32020
  );
  assert.equal(
    validateMcpRequestHeaders(headers('server/discover'), {
      jsonrpc: '2.0', id: 1, method: 'server/discover', params: {}
    }).code,
    -32602
  );
  assert.equal(
    validateMcpRequestHeaders(headers(), message('server/discover', {
      _meta: { [PROTOCOL_VERSION_META_KEY]: '2025-11-25' }
    })).code,
    -32020
  );
  assert.equal(
    validateMcpRequestHeaders(headers(), message('server/discover', {
      _meta: { [CLIENT_INFO_META_KEY]: { name: '', version: '' } }
    })).code,
    -32602
  );
  assert.equal(
    validateMcpRequestHeaders(headers(), message('server/discover', {
      _meta: { [CLIENT_CAPABILITIES_META_KEY]: [] }
    })).code,
    -32602
  );
  assert.equal(
    validateMcpRequestHeaders(headers('tools/call'), message('tools/call', {
      name: 'relai_work', arguments: { action: 'status' }
    })).code,
    -32020
  );
  assert.equal(
    validateMcpRequestHeaders(
      headers('tools/call', 'wrong-name'),
      message('tools/call', { name: 'relai_work', arguments: { action: 'status' } })
    ).code,
    -32020
  );
  assert.equal(
    validateMcpRequestHeaders({
      ...headers('tasks/get', 'task_wrong'),
      'mcp-session-id': 'legacy-session'
    }, message('tasks/get', { taskId: 'task_wrong' })).code,
    -32600
  );
  assert.equal(
    validateMcpRequestHeaders({
      ...headers('tools/list'),
      'mcp-param-extra': 'undeclared'
    }, message('tools/list')).code,
    -32020
  );
  assert.equal(
    validateMcpRequestHeaders({
      'mcp-protocol-version': '2025-11-25',
      'mcp-method': 'initialize'
    }, message('initialize')).code,
    -32601
  );
  assert.equal(validateMcpRequestHeaders(headers(), []).code, -32600);
  assert.equal(expectedMcpName('tools/call', { name: 'relai_work' }), 'relai_work');
  assert.equal(expectedMcpName('resources/read', { uri: 'relai://server/help' }), 'relai://server/help');
  assert.equal(expectedMcpName('tasks/get', { taskId: 'task_abc' }), 'task_abc');
  
  console.log('Strict MCP 2026-07-28 protocol headers, metadata, names, and session rejection matrix passed.');
}
await case_mcp_2026_header_unit();

// Formerly mcp-app-ui-unit.mjs
async function case_mcp_app_ui_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("@modelcontextprotocol/core");
    const { ToolSchema } = __m1;
  
    const __m2 = await import("../src/mcp/appUi.js");
    const { toolUiMetadata } = __m2;
  
    const __m3 = await import("../src/mcp/context.js");
    const { openAiConversationId, toolContext } = __m3;
  
    const __m4 = await import("../src/mcp/localDeveloperMode.js");
    const { LOCAL_DEVELOPER_SECURITY_SCHEMES } = __m4;
  
    const __m5 = await import("../src/mcp/serverInstructions.js");
    const { PUBLIC_MCP_SERVER_INSTRUCTIONS } = __m5;
  
    const __m6 = await import("../src/tools/schema.js");
    const { getMcpToolSchemas, getPublicToolSchemas, getToolSchemas } = __m6;
  
  const publicSchemas = getPublicToolSchemas();
  const mcpSchemas = getMcpToolSchemas();
  const canonicalByName = new Map(getToolSchemas().map(schema => [schema.name, schema]));
  const mcpByName = new Map(mcpSchemas.map(schema => [schema.name, schema]));
  
  assert.equal(publicSchemas.length, mcpSchemas.length, 'public and MCP discovery must expose the same canonical surface');
  assert.equal(mcpSchemas.length, canonicalByName.size, 'MCP discovery must not add app-only helper tools');
  assert.deepEqual(mcpSchemas.filter(schema => schema.name.startsWith('relai_app_')).map(schema => schema.name), []);
  for (const schema of mcpSchemas) assert.equal(ToolSchema.safeParse(schema).success, true, `${schema.name} must remain a valid MCP tool descriptor`);
  
  const invocationLabels = new Map([
    ['relai_work', ['Updating Rel.AI task…', 'Rel.AI task updated']],
    ['relai_snapshot', ['Scanning repository…', 'Repository scanned']],
    ['relai_read', ['Reading repository…', 'Repository read']],
    ['relai_search', ['Searching repository…', 'Repository searched']],
    ['relai_inspect', ['Inspecting code…', 'Code inspected']],
    ['relai_edit', ['Applying changes…', 'Changes applied']],
    ['relai_exec', ['Running command…', 'Command finished']],
    ['relai_process', ['Managing process…', 'Process updated']],
    ['relai_ui', ['Testing local UI…', 'Local UI tested']],
    ['relai_browser', ['Using local browser…', 'Local browser updated']],
    ['relai_desktop', ['Using local desktop…', 'Desktop action finished']],
    ['relai_computer', ['Controlling computer… Press Esc to stop.', 'Computer action finished']],
    ['relai_validate', ['Validating changes…', 'Validation finished']],
    ['relai_changes', ['Reviewing changes…', 'Changes reviewed']],
    ['relai_publish', ['Publishing changes…', 'Changes published']]
  ]);
  
  for (const schema of publicSchemas) {
    assert.deepEqual(schema.annotations, canonicalByName.get(schema.name)?.annotations, `${schema.name} must preserve truthful canonical annotations`);
    assert.deepEqual(schema._meta?.securitySchemes, LOCAL_DEVELOPER_SECURITY_SCHEMES, `${schema.name} must advertise noauth compatibility metadata`);
    const expected = invocationLabels.get(schema.name);
    assert.deepEqual([
      schema._meta?.['openai/toolInvocation/invoking'],
      schema._meta?.['openai/toolInvocation/invoked']
    ], expected, `${schema.name} must retain concise native invocation labels`);
    assert.deepEqual(toolUiMetadata(schema.name), {
      'openai/toolInvocation/invoking': expected[0],
      'openai/toolInvocation/invoked': expected[1]
    });
    assert.equal(schema._meta?.ui, undefined, `${schema.name} must stay iframe-free`);
    assert.equal(schema._meta?.['openai/outputTemplate'], undefined, `${schema.name} must not attach a ChatGPT output template`);
    assert.ok(expected.every(label => label.length <= 64));
  }
  
  assert.deepEqual(mcpByName.get('relai_publish')?.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  
  assert.match(PUBLIC_MCP_SERVER_INSTRUCTIONS, /work_id omission never selects another task/i, 'server instructions must preserve explicit task-attribution isolation');
  assert.doesNotMatch(PUBLIC_MCP_SERVER_INSTRUCTIONS, /brief normal assistant progress|Native tool invocation labels|private chain-of-thought/i,
    'host-owned presentation and reasoning policy must not be duplicated into MCP instructions');
  
  const openAiEnvelope = { 'openai/session': 'chat-session-regression' };
  assert.equal(openAiConversationId(openAiEnvelope), 'chat-session-regression');
  assert.equal(toolContext({ mcpReq: { id: 42, _meta: openAiEnvelope, envelope: {} } }).conversationId, 'chat-session-regression');
  
  console.log('Canonical tools keep native status labels without mounting an MCP approval card.');
}
await case_mcp_app_ui_unit();

// Formerly mcp-authentication-status-unit.mjs
async function case_mcp_authentication_status_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/mcp/authenticationStatus.js");
    const { readMcpAuthenticationStatus } = __m1;
  
  const now = Date.now();
  
  const awaiting = readMcpAuthenticationStatus({}, { staticBearerConfigured: true });
  assert.equal(awaiting.status, 'awaiting_authentication');
  assert.equal(awaiting.staticBearerConfigured, true);
  
  const bearer = readMcpAuthenticationStatus({
    lastAuthenticatedAt: new Date(now + 1).toISOString(),
    lastAuthMode: 'static_bearer'
  }, { staticBearerConfigured: true });
  assert.equal(bearer.status, 'bearer_authorized');
  assert.equal(bearer.authMode, 'static_bearer');
  assert.equal(bearer.staticBearerConfigured, true);
  
  const local = readMcpAuthenticationStatus({
    lastAuthenticatedAt: new Date(now + 2).toISOString(),
    lastAuthMode: 'local_no_auth'
  });
  assert.equal(local.status, 'local_authorized');
  assert.equal(local.authMode, 'local_no_auth');
  
  const failed = readMcpAuthenticationStatus({
    lastAuthenticationFailureAt: new Date(now + 3).toISOString()
  });
  assert.equal(failed.status, 'authentication_failed');
  
  console.log('MCP authentication status reflects local bearer evidence only.');
}
await case_mcp_authentication_status_unit();

// Formerly mcp-execution-mode-unit.mjs
async function case_mcp_execution_mode_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("@modelcontextprotocol/server");
    const { MissingRequiredClientCapabilityError,
    ProtocolErrorCode } = __m1;
  
    const __m2 = await import("../src/mcp/protocol.js");
    const { INVALID_TASKS_CAPABILITY_CODE,
    MISSING_TASKS_CAPABILITY_CODE,
    TASK_EXECUTION_MODE,
    TASKS_EXTENSION_ID,
    TASKS_EXTENSION_REVISION,
    clientSupportsNativeTasks,
    createMissingTasksCapabilityError,
    negotiateTasksCapability } = __m2;
  
    const __m3 = await import("../src/mcp/executionMode.js");
    const { BOUNDED_SYNCHRONOUS_CLEANUP,
    DEFAULT_SYNCHRONOUS_EXECUTION_BOUNDS,
    EXECUTION_ABORTED_CODE,
    SYNCHRONOUS_EXECUTION_LIMIT_CODE,
    TASK_ELIGIBILITY,
    UNSUPPORTED_EXECUTION_MODE,
    assessSynchronousExecution,
    selectExecutionMode } = __m3;
  
  const tasksCapability = { extensions: { [TASKS_EXTENSION_ID]: { revision: TASKS_EXTENSION_REVISION } } };
  
  assert.equal(MISSING_TASKS_CAPABILITY_CODE, ProtocolErrorCode.MissingRequiredClientCapability);
  assert.equal(MISSING_TASKS_CAPABILITY_CODE, -32021);
  const missingCapabilityError = createMissingTasksCapabilityError();
  assert.ok(missingCapabilityError instanceof MissingRequiredClientCapabilityError);
  assert.equal(missingCapabilityError.code, -32021);
  assert.deepEqual(missingCapabilityError.data, {
    requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: { revision: TASKS_EXTENSION_REVISION } } }
  });
  
  assert.deepEqual(negotiateTasksCapability(tasksCapability), {
    mode: TASK_EXECUTION_MODE.NATIVE_TASKS,
    supported: true,
    valid: true,
    reason: 'capability_present'
  });
  assert.equal(clientSupportsNativeTasks(tasksCapability), true);
  assert.deepEqual(negotiateTasksCapability({}), {
    mode: TASK_EXECUTION_MODE.BOUNDED_SYNCHRONOUS,
    supported: false,
    valid: true,
    reason: 'capability_absent'
  });
  assert.deepEqual(negotiateTasksCapability([]), {
    mode: TASK_EXECUTION_MODE.BOUNDED_SYNCHRONOUS,
    supported: false,
    valid: false,
    reason: 'malformed_capabilities'
  });
  assert.equal(negotiateTasksCapability({ extensions: [] }).valid, false);
  assert.equal(negotiateTasksCapability({ extensions: { [TASKS_EXTENSION_ID]: true } }).valid, false);
  
  const heuristicOnly = negotiateTasksCapability({
    clientName: 'ChatGPT',
    transport: 'http',
    protocolVersion: '2026-07-28'
  });
  assert.equal(heuristicOnly.mode, TASK_EXECUTION_MODE.BOUNDED_SYNCHRONOUS);
  assert.equal(heuristicOnly.supported, false);
  
  const native = selectExecutionMode({
    clientCapabilities: tasksCapability,
    taskEligibility: TASK_ELIGIBILITY.ELIGIBLE,
    canCompleteSynchronously: false
  });
  assert.equal(native.ok, true);
  assert.equal(native.mode, TASK_EXECUTION_MODE.NATIVE_TASKS);
  
  const fast = selectExecutionMode({
    clientCapabilities: tasksCapability,
    taskEligibility: TASK_ELIGIBILITY.FAST,
    canCompleteSynchronously: true,
    estimatedDurationMs: 25
  });
  assert.equal(fast.ok, true);
  assert.equal(fast.mode, TASK_EXECUTION_MODE.BOUNDED_SYNCHRONOUS);
  assert.deepEqual(fast.cleanup, BOUNDED_SYNCHRONOUS_CLEANUP);
  
  const immediate = selectExecutionMode({
    clientCapabilities: tasksCapability,
    taskEligibility: TASK_ELIGIBILITY.IMMEDIATE,
    canCompleteSynchronously: true
  });
  assert.equal(immediate.mode, TASK_EXECUTION_MODE.BOUNDED_SYNCHRONOUS);
  
  const supportedButSafe = selectExecutionMode({
    clientCapabilities: tasksCapability,
    taskEligibility: TASK_ELIGIBILITY.ELIGIBLE,
    canCompleteSynchronously: true
  });
  assert.equal(supportedButSafe.mode, TASK_EXECUTION_MODE.BOUNDED_SYNCHRONOUS);
  
  const unsupportedButSafe = selectExecutionMode({
    clientCapabilities: {},
    taskEligibility: TASK_ELIGIBILITY.ELIGIBLE,
    canCompleteSynchronously: true,
    estimatedDurationMs: DEFAULT_SYNCHRONOUS_EXECUTION_BOUNDS.maxDurationMs
  });
  assert.equal(unsupportedButSafe.ok, true);
  assert.equal(unsupportedButSafe.mode, TASK_EXECUTION_MODE.BOUNDED_SYNCHRONOUS);
  
  const malformedButOtherwiseSafe = selectExecutionMode({
    clientCapabilities: { extensions: [] },
    taskEligibility: TASK_ELIGIBILITY.ELIGIBLE,
    canCompleteSynchronously: true,
    estimatedDurationMs: 1
  });
  assert.equal(malformedButOtherwiseSafe.ok, false);
  assert.equal(malformedButOtherwiseSafe.mode, UNSUPPORTED_EXECUTION_MODE);
  assert.equal(malformedButOtherwiseSafe.error.code, INVALID_TASKS_CAPABILITY_CODE);
  assert.equal(malformedButOtherwiseSafe.error.reason, 'invalid_client_capabilities');
  assert.equal(malformedButOtherwiseSafe.error.data.capabilityReason, 'malformed_extensions');
  
  const tasksRequired = selectExecutionMode({
    clientCapabilities: {},
    taskEligibility: TASK_ELIGIBILITY.ELIGIBLE,
    canCompleteSynchronously: false
  });
  assert.equal(tasksRequired.ok, false);
  assert.equal(tasksRequired.mode, UNSUPPORTED_EXECUTION_MODE);
  assert.equal(tasksRequired.error.code, MISSING_TASKS_CAPABILITY_CODE);
  assert.equal(tasksRequired.error.reason, 'native_tasks_required');
  
  const overLimit = selectExecutionMode({
    clientCapabilities: {},
    taskEligibility: TASK_ELIGIBILITY.INELIGIBLE,
    canCompleteSynchronously: true,
    estimatedDurationMs: DEFAULT_SYNCHRONOUS_EXECUTION_BOUNDS.maxDurationMs + 1
  });
  assert.equal(overLimit.ok, false);
  assert.equal(overLimit.mode, UNSUPPORTED_EXECUTION_MODE);
  assert.equal(overLimit.error.code, SYNCHRONOUS_EXECUTION_LIMIT_CODE);
  assert.deepEqual(overLimit.synchronous.violations, ['maximum_duration_exceeded']);
  assert.deepEqual(overLimit.error.data.cleanup, BOUNDED_SYNCHRONOUS_CLEANUP);
  
  assert.deepEqual(assessSynchronousExecution({
    canCompleteSynchronously: false,
    bounds: DEFAULT_SYNCHRONOUS_EXECUTION_BOUNDS
  }).violations, ['operation_not_synchronously_safe']);
  
  const alreadyAborted = new AbortController();
  alreadyAborted.abort('request closed');
  const aborted = selectExecutionMode({
    clientCapabilities: tasksCapability,
    taskEligibility: TASK_ELIGIBILITY.ELIGIBLE,
    canCompleteSynchronously: false,
    abortSignals: [alreadyAborted.signal]
  });
  assert.equal(aborted.ok, false);
  assert.equal(aborted.error.code, EXECUTION_ABORTED_CODE);
  assert.equal(aborted.error.reason, 'execution_aborted');
  
  const requestController = new AbortController();
  const connectionController = new AbortController();
  const cancellable = selectExecutionMode({
    clientCapabilities: {},
    taskEligibility: TASK_ELIGIBILITY.FAST,
    canCompleteSynchronously: true,
    abortSignals: [requestController.signal, connectionController.signal]
  });
  assert.equal(cancellable.signal.aborted, false);
  connectionController.abort('connection closed');
  assert.equal(cancellable.signal.aborted, true);
  assert.equal(BOUNDED_SYNCHRONOUS_CLEANUP.abortOnRequestClose, true);
  assert.equal(BOUNDED_SYNCHRONOUS_CLEANUP.abortOnConnectionClose, false, 'accepted HTTP work must not advertise connection-close cancellation after transport loss is detached from execution');
  assert.equal(BOUNDED_SYNCHRONOUS_CLEANUP.terminateSubprocessTree, true);
  assert.equal(BOUNDED_SYNCHRONOUS_CLEANUP.awaitSubprocessExit, true);
  
  assert.throws(
    () => selectExecutionMode({ taskEligibility: 'client_name_based', canCompleteSynchronously: true }),
    /taskEligibility must be one of/
  );
  assert.throws(
    () => selectExecutionMode({
      taskEligibility: TASK_ELIGIBILITY.FAST,
      canCompleteSynchronously: true,
      synchronousBounds: { maxDurationMs: 0 }
    }),
    /maxDurationMs must be a positive finite number/
  );
  
  console.log('Canonical MCP Tasks capability negotiation and execution-mode policy passed.');
}
await case_mcp_execution_mode_unit();

// Formerly mcp-legacy-adapter-unit.mjs
async function case_mcp_legacy_adapter_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
  const transportSource = fs.readFileSync(new URL('../src/http/mcpTransport.ts', import.meta.url), 'utf8');
  const coreSource = fs.readFileSync(new URL('../src/core/mcp-runtime.ts', import.meta.url), 'utf8');
  const policy = fs.readFileSync(new URL('../docs/MCP_PROTOCOL_POLICY.md', import.meta.url), 'utf8');
  
  assert.match(transportSource, /async function handleLegacyMcpRequest\s*\(/, 'legacy HTTP compatibility must have one named adapter');
  assert.match(
    transportSource,
    /if \(legacy\) \{[\s\S]*?LEGACY_LIFECYCLE_METHODS\.includes\(method\)[\s\S]*?await handleLegacyMcpRequest\([\s\S]*?\);\s*return;\s*\}/,
    'the main HTTP dispatcher must admit only startup lifecycle methods before delegating to the legacy adapter'
  );
  assert.match(transportSource, /observeMcpRequestManifest/, 'HTTP must delegate manifest observation to Core');
  assert.match(coreSource, /function observeMcpRequestManifest\s*\(/, 'manifest observation must remain shared in Core');
  assert.match(coreSource, /function runMcpRequestSpan(?:<[^>]+>)?\s*\(/, 'request telemetry must remain shared in Core');
  assert.equal((transportSource.match(/getCoreNodeHandler\(\)\(ctx\.req[^\n]*ctx\.res, message\)/g) || []).length, 2, 'modern and startup-legacy SDK dispatch must each remain explicit');
  
  assert.match(policy, /Modern MCP protocol for ordinary requests:\s*`2026-07-28`/);
  assert.match(policy, /Stateless ChatGPT HTTP startup compatibility:\s*`2025-11-25`/);
  assert.match(policy, /stdio tests verify that stdio remains modern-only/i);
  assert.match(policy, /Removal condition:/);
  assert.match(policy, /startup lifecycle/i);
  assert.match(transportSource, /LEGACY_LIFECYCLE_METHODS\.includes\(method\)/, 'legacy HTTP compatibility must reject ordinary MCP methods before SDK dispatch');
  assert.match(transportSource, /compatibility is limited to initialize lifecycle requests/, 'legacy ordinary-method rejection must explain the modern cutover');
  
  console.log('Legacy MCP compatibility is isolated to the stateless ChatGPT startup lifecycle.');
}
await case_mcp_legacy_adapter_unit();

// Formerly mcp-transport-tasks-unit.mjs
async function case_mcp_transport_tasks_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:events");
    const { EventEmitter } = __m1;
  
    const __m2 = await import("node:fs");
    const fs = __m2.default;
  
    const __m3 = await import("node:os");
    const os = __m3.default;
  
    const __m4 = await import("node:path");
    const path = __m4.default;
  
    const __m5 = await import("node:stream");
    const { Readable } = __m5;
  
    const __m6 = await import("@modelcontextprotocol/server");
    const { CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY } = __m6;
  
    const __m7 = await import("../src/http/io.ts");
    const { DEFAULT_MAX_BODY_BYTES, normalizeMaxBodyBytes, readRawBody, sendJson } = __m7;
  
    const __m8 = await import("../src/http/mcpTransport.ts");
    const { createHttpRequestAbortScope, expectedMcpName } = __m8;
  
    const __m9 = await import("../src/httpServer.ts");
    const { resolveHttpRequestTimeoutMs } = __m9;
  
    const __m10 = await import("../src/mcp/nativeTaskService.js");
    const { createNativeTask,
    getNativeTask,
    requestNativeTaskInput } = __m10;
  
    const __m11 = await import("../src/mcp/protocol.js");
    const { MCP_PROTOCOL_VERSION,
    TASKS_EXTENSION_ID,
    TASKS_EXTENSION_REVISION } = __m11;
  
    const __m12 = await import("../src/mcp/transportTasks.js");
    const { createTaskAwareStdioTransport,
    handleTransportTaskRequest,
    isTransportTaskRequestCandidate,
    runBoundedExecution } = __m12;
  
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-transport-tasks-'));
  const config = { stateDir: sandbox };
  const owner = { clientId: 'client-a', authMode: 'oauth' };
  const otherOwner = { clientId: 'client-b', authMode: 'oauth' };
  const localOwner = { clientId: 'stdio:session-a', authMode: 'local_session' };
  const localOtherOwner = { clientId: 'stdio:session-b', authMode: 'local_session' };
  const tasksCapabilities = { extensions: { [TASKS_EXTENSION_ID]: { revision: TASKS_EXTENSION_REVISION } } };
  
  function request(id, method, params = {}, capabilities = tasksCapabilities) {
    return {
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
          [CLIENT_INFO_META_KEY]: { name: 'transport-test', version: '1.0.0' },
          [CLIENT_CAPABILITIES_META_KEY]: capabilities
        }
      }
    };
  }
  
  class FakeTransport {
    constructor() {
      this.sent = [];
      this.closed = false;
    }
  
    async start() {}
  
    async close() {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.();
    }
  
    async send(message) {
      this.sent.push(message);
    }
  
    receive(message) {
      this.onmessage?.(message);
    }
  }
  
  async function waitForSent(transport, count) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (transport.sent.length >= count) return transport.sent[count - 1];
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for stdio response ${count}.`);
  }
  
  try {
    const editTaskCandidate = request(99, 'tools/call', {
      name: 'relai_edit',
      arguments: { work_id: 'work-session', path: 'README.md', oldText: 'before', newText: 'after' }
    }, tasksCapabilities);
    assert.equal(isTransportTaskRequestCandidate(config, editTaskCandidate), true, 'ordinary relai_edit must use recoverable long-call execution');
    const editChecksTaskCandidate = request(98, 'tools/call', {
      name: 'relai_edit',
      arguments: { work_id: 'work-session', path: 'README.md', oldText: 'before', newText: 'after', runChecks: true }
    }, tasksCapabilities);
    assert.equal(isTransportTaskRequestCandidate(config, editChecksTaskCandidate), true, 'relai_edit with post-checks must use recoverable long-call execution');
    const editWithoutTasks = await handleTransportTaskRequest(config, request(94, 'tools/call', {
      name: 'relai_edit',
      arguments: { workspace: 'app', work_id: 'edit-no-tasks', path: 'README.md', oldText: 'before', newText: 'after' }
    }, {}), {
      principal: owner,
      transportType: 'streamable-http',
      synchronousFallbackGraceMs: 0,
      executeToolResult: async () => ({ isError: false, structuredContent: { ok: true, changed: true } })
    });
    assert.equal(editWithoutTasks.body.result?.structuredContent?.status, 'running', 'ordinary edits must detach safely when the client does not advertise Tasks');
    for (const candidate of [
      request(97, 'tools/call', { name: 'relai_search', arguments: { action: 'semantic', work_id: 'work-session', query: 'target' } }, tasksCapabilities),
      request(96, 'tools/call', { name: 'relai_inspect', arguments: { action: 'architecture', work_id: 'work-session' } }, tasksCapabilities),
      request(95, 'tools/call', { name: 'relai_validate', arguments: { action: 'http', work_id: 'work-session', route: '/health' } }, tasksCapabilities)
    ]) {
      assert.equal(isTransportTaskRequestCandidate(config, candidate), true, `${candidate.params.name} long operation must reach capability negotiation`);
    }
    for (const [id, name, args] of [
      [93, 'relai_search', { action: 'semantic', workspace: 'app', query: 'target' }],
      [92, 'relai_inspect', { action: 'architecture', workspace: 'app' }],
      [91, 'relai_validate', { action: 'http', workspace: 'app', route: '/health' }]
    ]) {
      const taskless = await handleTransportTaskRequest(config, request(id, 'tools/call', {
        name,
        arguments: args
      }, {}), {
        principal: owner,
        transportType: 'streamable-http',
        synchronousFallbackGraceMs: 100,
        executeToolResult: async (_config, calledName, calledArgs) => ({
          isError: false,
          structuredContent: { ok: true, tool: calledName, workspace: calledArgs.workspace }
        })
      });
      assert.equal(taskless.body.result?.structuredContent?.ok, true, `${name} must execute without a logical work_id when its action is task-optional`);
      assert.equal(taskless.body.result?.structuredContent?.tool, name);
    }
    const timeout = await runBoundedExecution(
      signal => signal.aborted
        ? Promise.resolve({ stopped: true })
        : new Promise(resolve => signal.addEventListener('abort', () => resolve({ stopped: true }), { once: true })),
      { bounds: { maxDurationMs: 20 } }
    );
    assert.equal(timeout.ok, false);
    assert.equal(timeout.error.code, -32024);
    assert.equal(timeout.error.reason, 'synchronous_timeout');
  
    const largeOutput = await runBoundedExecution(
      async () => ({ value: 'x'.repeat(3 * 1024 * 1024) }),
      { bounds: { maxDurationMs: 1000 } }
    );
    assert.equal(largeOutput.ok, true, 'transport execution must not impose a second output-size policy after the tool has shaped its result');
    assert.equal(largeOutput.value.value.length, 3 * 1024 * 1024);
  
    const splitUtf8 = Readable.from([
      Buffer.from([0xf0, 0x9f]),
      Buffer.from([0x98, 0x80])
    ]);
    splitUtf8.headers = { 'content-length': '4' };
    assert.equal(await readRawBody(splitUtf8, 4), '😀', 'request decoding must preserve UTF-8 split across chunks');
  
    let preflightResumed = false;
    let preflightDestroyed = false;
    const oversizedDeclaredBody = new EventEmitter();
    oversizedDeclaredBody.headers = { 'content-length': '128' };
    oversizedDeclaredBody.resume = () => { preflightResumed = true; };
    oversizedDeclaredBody.destroy = () => { preflightDestroyed = true; };
    await assert.rejects(readRawBody(oversizedDeclaredBody, 64), error => error?.status === 413);
    assert.equal(preflightResumed, true, 'oversized request bodies should be drained so the connection can return a structured 413');
    assert.equal(preflightDestroyed, false, 'oversized request bodies must not be force-destroyed before the HTTP response is sent');
    assert.equal(normalizeMaxBodyBytes(undefined), DEFAULT_MAX_BODY_BYTES);
    assert.equal(normalizeMaxBodyBytes('not-a-number'), DEFAULT_MAX_BODY_BYTES, 'invalid body limits must fail closed to the bounded default instead of becoming unbounded');
    assert.equal(normalizeMaxBodyBytes(-1), DEFAULT_MAX_BODY_BYTES);
    assert.equal(normalizeMaxBodyBytes(12 * 1024 * 1024), 12 * 1024 * 1024, 'valid configured limits must not be arbitrarily clamped');
    assert.equal(resolveHttpRequestTimeoutMs(DEFAULT_MAX_BODY_BYTES), 300_000, 'default payloads should retain Node\'s normal finite request-receive window');
    assert.equal(resolveHttpRequestTimeoutMs(DEFAULT_MAX_BODY_BYTES * 2), 600_000, 'larger configured request bodies must receive a proportionally larger transport window');
    assert.equal(resolveHttpRequestTimeoutMs(Math.floor(DEFAULT_MAX_BODY_BYTES / 2)), 300_000, 'smaller body limits must not reduce the baseline request-receive protection window');
  
    let streamedOversizeResumed = false;
    const streamedOversize = new EventEmitter();
    streamedOversize.headers = {};
    streamedOversize.complete = false;
    streamedOversize.resume = () => { streamedOversizeResumed = true; };
    const streamedOversizeRead = readRawBody(streamedOversize, 64);
    streamedOversize.emit('data', Buffer.alloc(40));
    streamedOversize.emit('data', Buffer.alloc(40));
    await assert.rejects(streamedOversizeRead, error => error?.status === 413);
    assert.equal(streamedOversizeResumed, true, 'streaming bodies that cross the limit must continue draining for a structured 413 response');
    assert.equal(streamedOversize.listenerCount('data'), 0, 'rejected bodies must release buffered data listeners immediately');
    streamedOversize.emit('end');
    assert.equal(streamedOversize.listenerCount('end'), 0);
    assert.equal(streamedOversize.listenerCount('error'), 0);
    assert.equal(streamedOversize.listenerCount('close'), 0);
  
    const abortedBody = new EventEmitter();
    abortedBody.headers = {};
    abortedBody.complete = false;
    abortedBody.aborted = false;
    const abortedBodyRead = readRawBody(abortedBody, 64);
    abortedBody.emit('data', Buffer.alloc(32));
    abortedBody.aborted = true;
    abortedBody.emit('aborted');
    await assert.rejects(abortedBodyRead, /aborted before completion/i);
    abortedBody.emit('close');
    assert.equal(abortedBody.listenerCount('data'), 0);
    assert.equal(abortedBody.listenerCount('end'), 0);
    assert.equal(abortedBody.listenerCount('error'), 0);
    assert.equal(abortedBody.listenerCount('aborted'), 0);
    assert.equal(abortedBody.listenerCount('close'), 0, 'aborted request bodies must not leave transport listeners behind');
  
    let jsonStatus = 0;
    let jsonHeaders = null;
    let jsonBody = null;
    const jsonResponse = {
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      writeHead(status, headers) { jsonStatus = status; jsonHeaders = headers; },
      end(body) { jsonBody = body; this.writableEnded = true; }
    };
    sendJson(jsonResponse, 200, { ok: true, value: '😀' });
    assert.equal(jsonStatus, 200);
    assert.equal(typeof jsonBody, 'string', 'JSON responses should avoid a second full payload Buffer allocation');
    assert.equal(jsonHeaders['Content-Length'], Buffer.byteLength(jsonBody, 'utf8'));
    assert.doesNotThrow(() => sendJson({
      headersSent: false,
      writableEnded: true,
      destroyed: false,
      writeHead() { throw new Error('closed response must not be written'); },
      end() { throw new Error('closed response must not be ended'); }
    }, 200, { ok: true }), 'late transport errors must not try to write a second response');
  
    const externalAbort = new AbortController();
    const aborted = runBoundedExecution(
      signal => signal.aborted
        ? Promise.resolve({ stopped: true })
        : new Promise(resolve => signal.addEventListener('abort', () => resolve({ stopped: true }), { once: true })),
      { bounds: { maxDurationMs: 1000 }, signal: externalAbort.signal }
    );
    externalAbort.abort(new Error('client disconnected'));
    const abortedResult = await aborted;
    assert.equal(abortedResult.ok, false);
    assert.equal(abortedResult.error.code, -32800);
    assert.equal(abortedResult.error.reason, 'execution_aborted');
  
    const execTaskCandidate = request(100, 'tools/call', {
      name: 'relai_exec',
      arguments: {
        work_id: 'work-session',
        command: 'echo ordinary execution',
        timeoutMs: 90_000,
        maxOutputBytes: 60_000
      }
    }, tasksCapabilities);
    assert.equal(isTransportTaskRequestCandidate(config, execTaskCandidate), true, 'task-eligible relai_exec calls must reach capability negotiation');
    const synchronousFallback = await handleTransportTaskRequest(config, request(100, 'tools/call', {
      name: 'relai_exec',
      arguments: {
        work_id: 'work-session',
        command: 'echo ordinary execution',
        timeoutMs: 90_000,
        maxOutputBytes: 60_000
      }
    }, {}), {
      principal: owner,
      transportType: 'streamable-http',
      executeToolResult: async () => ({ isError: false, structuredContent: { ok: true, exitCode: 0 } })
    });
    assert.equal(synchronousFallback.body.result?.resultType, undefined, 'clients without Tasks capability must keep the synchronous result path');
    assert.equal(synchronousFallback.body.result?.structuredContent?.exitCode, 0);
  
    const safeWithoutTasks = await handleTransportTaskRequest(config, request(101, 'tools/call', {
      name: 'relai_exec',
      arguments: {
        work_id: 'short-no-tasks',
        command: 'echo bounded execution',
        timeoutMs: 7_500,
        maxOutputBytes: 64 * 1024
      }
    }, {}), {
      principal: owner,
      transportType: 'streamable-http',
      synchronousFallbackGraceMs: 0,
      executeToolResult: async () => ({ isError: false, structuredContent: { ok: true, exitCode: 7 } })
    });
    assert.equal(safeWithoutTasks.body.result?.structuredContent?.exitCode, 7, 'short bounded calls must stay synchronous even when the client does not advertise Tasks');
    assert.equal(safeWithoutTasks.body.result?.structuredContent?.status, undefined, 'safe calls must not force a follow-up status request');
  
    const longWithoutTasks = await handleTransportTaskRequest(config, request(102, 'tools/call', {
      name: 'relai_exec',
      arguments: {
        work_id: 'long-no-tasks',
        command: 'echo detached execution',
        timeoutMs: 15_000,
        maxOutputBytes: 64 * 1024
      }
    }, {}), {
      principal: owner,
      transportType: 'streamable-http',
      synchronousFallbackGraceMs: 0,
      executeToolResult: async () => ({ isError: false, structuredContent: { ok: true, exitCode: 0 } })
    });
    assert.equal(longWithoutTasks.body.result?.structuredContent?.status, 'running', 'calls outside the safe synchronous envelope must remain detachable for clients without Tasks');
  
    let directArguments = null;
    const directResult = await handleTransportTaskRequest(config, request(102, 'tools/call', {
      name: 'relai_exec',
      arguments: {
        work_id: 'work-session',
        command: 'echo bounded execution',
        timeoutMs: 5_000,
        maxOutputBytes: 8 * 1024 * 1024
      }
    }, tasksCapabilities), {
      principal: owner,
      transportType: 'streamable-http',
      executeToolResult: async (_config, _name, args) => {
        directArguments = args;
        return { isError: false, structuredContent: { ok: true, exitCode: 0 } };
      }
    });
    assert.equal(directResult.body.result?.structuredContent?.exitCode, 0);
    assert.equal(directArguments.timeoutMs, 5_000, 'transport must preserve the tool timeout selected by the caller');
    assert.equal(directArguments.maxOutputBytes, 8 * 1024 * 1024, 'transport must preserve tool-owned output limits instead of silently clamping them');
    const req = new EventEmitter();
    const socket = new EventEmitter();
    req.socket = socket;
    req.aborted = false;
    const res = new EventEmitter();
    res.writableEnded = false;
    res.destroyed = false;
    const httpAbort = createHttpRequestAbortScope(req, res);
    req.emit('aborted');
    assert.equal(httpAbort.signal.aborted, true);
    assert.match(String(httpAbort.signal.reason?.message || ''), /aborted by the client/i);
    httpAbort.dispose();
    assert.equal(req.listenerCount('aborted'), 0);
    assert.equal(res.listenerCount('close'), 0);
    assert.equal(socket.listenerCount('close'), 0);
  
    const disconnectedReq = new EventEmitter();
    disconnectedReq.aborted = false;
    const disconnectedRes = new EventEmitter();
    disconnectedRes.writableEnded = false;
    disconnectedRes.destroyed = false;
    const disconnectedScope = createHttpRequestAbortScope(disconnectedReq, disconnectedRes);
    disconnectedRes.emit('close');
    assert.equal(disconnectedScope.signal.aborted, false, 'losing the response connection must not be treated as client cancellation after Rel.AI accepted the request');
    disconnectedScope.dispose();
  
    assert.equal(expectedMcpName('tasks/get', { taskId: 'task-1' }), 'task-1');
    assert.equal(expectedMcpName('tasks/update', { taskId: 'task-2' }), 'task-2');
    assert.equal(expectedMcpName('tasks/cancel', { taskId: 'task-3' }), 'task-3');
  
    const missingCapability = await handleTransportTaskRequest(
      config,
      request(1, 'tasks/get', { taskId: 'task-missing' }, {}),
      { principal: owner, transportType: 'streamable-http' }
    );
    assert.equal(missingCapability.body.error.code, -32021);
    assert.deepEqual(missingCapability.body.error.data.requiredCapabilities, tasksCapabilities);
  
    const malformedCapability = await handleTransportTaskRequest(
      config,
      request(101, 'tasks/get', { taskId: 'task-missing' }, { extensions: [] }),
      { principal: owner, transportType: 'streamable-http' }
    );
    assert.equal(malformedCapability.body.error.code, -32602);
    assert.deepEqual(malformedCapability.body.error.data, {
      reason: 'invalid_client_capabilities',
      capabilityReason: 'malformed_extensions',
      expectedCapabilities: tasksCapabilities
    });
  
    const unsupportedRevision = await handleTransportTaskRequest(
      config,
      request(102, 'tasks/get', { taskId: 'task-missing' }, {
        extensions: { [TASKS_EXTENSION_ID]: { revision: '1900-01-01' } }
      }),
      { principal: owner, transportType: 'streamable-http' }
    );
    assert.equal(unsupportedRevision.body.error.code, -32602);
    assert.equal(unsupportedRevision.body.error.data.capabilityReason, 'unsupported_tasks_revision');
  
    const invalidId = await handleTransportTaskRequest(
      config,
      { ...request(103, 'tasks/get', { taskId: 'task-missing' }), id: { invalid: true } },
      { principal: owner, transportType: 'streamable-http' }
    );
    assert.equal(invalidId.body.id, null);
    assert.equal(invalidId.body.error.code, -32600);
  
    const taskController = new AbortController();
    const task = createNativeTask(config, {
      principal: owner,
      method: 'tools/call',
      name: 'input-test',
      executor: { controller: taskController, resume() {} }
    });
    requestNativeTaskInput(config, task.taskId, {
      approval: {
        responseSchema: {
          type: 'object',
          required: ['approved'],
          additionalProperties: false,
          properties: { approved: { type: 'boolean' } }
        }
      }
    }, { principal: owner });
  
    const updated = await handleTransportTaskRequest(
      config,
      request(2, 'tasks/update', {
        taskId: task.taskId,
        inputResponses: { approval: { approved: true } }
      }),
      { principal: owner, transportType: 'streamable-http' }
    );
    assert.equal(updated.body.error, undefined);
    assert.equal(getNativeTask(config, task.taskId, { principal: owner }).status, 'working');
  
    const replayedUpdate = await handleTransportTaskRequest(
      config,
      request(3, 'tasks/update', {
        taskId: task.taskId,
        inputResponses: { approval: { approved: true } }
      }),
      { principal: owner, transportType: 'streamable-http' }
    );
    assert.equal(replayedUpdate.body.error, undefined);
    assert.equal(replayedUpdate.body.result.resultType, 'complete');
  
    const denied = await handleTransportTaskRequest(
      config,
      request(4, 'tasks/get', { taskId: task.taskId }),
      { principal: otherOwner, transportType: 'streamable-http' }
    );
    assert.equal(denied.body.error.code, -32602);
    assert.match(denied.body.error.message, /not available to this client/i);
  
    const cancelled = await handleTransportTaskRequest(
      config,
      request(5, 'tasks/cancel', { taskId: task.taskId }),
      { principal: owner, transportType: 'streamable-http' }
    );
    assert.equal(cancelled.body.error, undefined);
    const cancellationRequested = getNativeTask(config, task.taskId, { principal: owner });
    assert.equal(cancellationRequested.status, 'working');
    assert.equal(taskController.signal.aborted, true);
  
    const malformed = await handleTransportTaskRequest(
      config,
      request(6, 'tasks/get'),
      { principal: owner, transportType: 'streamable-http' }
    );
    assert.equal(malformed.body.error.code, -32602);
  
    const stdioTask = createNativeTask(config, {
      principal: localOwner,
      method: 'tools/call',
      name: 'stdio-isolation-test',
      executor: { controller: new AbortController() }
    });
    const stdioWire = new FakeTransport();
    const stdio = createTaskAwareStdioTransport({ config, principal: localOwner, transport: stdioWire });
    await stdio.start();
    stdioWire.receive(request(7, 'tasks/get', { taskId: stdioTask.taskId }, {}));
    const stdioMissing = await waitForSent(stdioWire, 1);
    assert.deepEqual(stdioMissing.error, missingCapability.body.error);
  
    stdioWire.receive(request(8, 'tasks/get', { taskId: stdioTask.taskId }));
    const stdioOwned = await waitForSent(stdioWire, 2);
    assert.equal(stdioOwned.result.taskId, stdioTask.taskId);
    assert.equal(stdioOwned.result.status, 'working');
  
    let delegatedInvalid = null;
    stdio.onmessage = message => { delegatedInvalid = message; };
    const invalidEligibleCall = request(81, 'tools/call', {
      name: 'relai_exec',
      arguments: { work_id: 'work-session', command: 'echo invalid', defer: true }
    });
    stdioWire.receive(invalidEligibleCall);
    const invalidEligibleResponse = await waitForSent(stdioWire, 3);
    assert.equal(delegatedInvalid, null, 'invalid long-running tool arguments must stay inside the task-aware tool-result boundary');
    assert.equal(invalidEligibleResponse.id, 81);
    assert.equal(invalidEligibleResponse.result?.isError, true);
    assert.equal(invalidEligibleResponse.result?.structuredContent?.errorCode, 'INVALID_TOOL_ARGUMENTS');
    assert.match(invalidEligibleResponse.result?.structuredContent?.error || '', /invalid arguments|defer/i);
  
    const otherWire = new FakeTransport();
    const otherStdio = createTaskAwareStdioTransport({ config, principal: localOtherOwner, transport: otherWire });
    await otherStdio.start();
    otherWire.receive(request(9, 'tasks/get', { taskId: stdioTask.taskId }));
    const stdioDenied = await waitForSent(otherWire, 1);
    assert.equal(stdioDenied.error.code, denied.body.error.code);
    assert.equal(stdioDenied.error.message, denied.body.error.message);
  
    await stdio.close();
    await otherStdio.close();
  
    console.log('HTTP and stdio Tasks routing, identity isolation, cancellation, abort, timeout, and output-limit tests passed.');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}
await case_mcp_transport_tasks_unit();

// Formerly tool-action-catalog-parity-unit.mjs
async function case_tool_action_catalog_parity_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/mcp/approval.js");
    const { approvalRequirement } = __m1;
  
    const __m2 = await import("../src/mcp/authorizationPolicy.js");
    const { requiredCapability } = __m2;
  
    const __m3 = await import("../src/tools/actionCatalog.js");
    const { ACTION_REGISTRY,
    catalogApprovalRequirement,
    getCatalogAction,
    getCatalogToolDefinitions,
    getCatalogTools,
    getOperationDefinition,
    getOperationDefinitions,
    getToolActionCatalog,
    resolveToolOperation } = __m3;
  
    const __m4 = await import("../src/tools/runtimeRegistry.js");
    const { resolveExecutableToolCall } = __m4;
  
    const __m5 = await import("../src/tools/schema.js");
    const { getToolDefinitions, getToolMetadata, getToolSchemas } = __m5;
  
  const catalog = getToolActionCatalog();
  const catalogTools = getCatalogTools();
  const currentDefinitions = getToolDefinitions();
  const currentSchemas = new Map(getToolSchemas().map(item => [item.name, item]));
  const currentMetadata = new Map(getToolMetadata().map(item => [item.name, item]));
  
  assert.ok(catalogTools.length > 0, 'the canonical tool catalog must not be empty');
  assert.equal(catalogTools.length, currentDefinitions.length, 'catalog tools and public definitions must stay in parity');
  assert.equal(new Set(catalog.map(entry => `${entry.publicTool}:${entry.action}`)).size, catalog.length, 'tool/action keys must stay unique');
  assert.deepEqual(
    [...new Set(catalog.map(entry => entry.operationName))].sort(),
    getOperationDefinitions().map(operation => operation.name).sort(),
    'every canonical internal operation must be reachable from the public catalog'
  );
  assert.deepEqual(getCatalogToolDefinitions(), currentDefinitions);
  assert.deepEqual(
    getCatalogToolDefinitions().map(definition => ({
      name: definition.name,
      title: definition.title,
      description: definition.description,
      annotations: definition.annotations
    })),
    getToolSchemas().map(schema => ({
      name: schema.name,
      title: schema.title,
      description: schema.description,
      annotations: schema.annotations
    }))
  );
  assert.deepEqual(
    catalogTools.map(tool => ({ name: tool.definition.name, actions: tool.actions.map(action => action.action) })),
    currentDefinitions.map(definition => ({
      name: definition.name,
      actions: currentMetadata.get(definition.name)?.actions?.map(action => action.action) || ['default']
    }))
  );
  
  for (const entry of catalog) {
    assert.equal(ACTION_REGISTRY[entry.publicTool][entry.action].operationName, entry.operationName);
  
    const operation = getOperationDefinition(entry.operationName);
    assert.ok(operation, `${entry.operationName} must exist in the current internal registry`);
    assert.equal(entry.title, operation.title);
    assert.equal(entry.description, operation.description);
    assert.deepEqual(entry.inputSchema, operation.inputSchema);
    assert.deepEqual(entry.outputSchema, operation.outputSchema);
    assert.deepEqual(entry.annotations, operation.annotations);
    assert.deepEqual(entry.behavior, { ...operation.behavior, ...(ACTION_REGISTRY[entry.publicTool][entry.action].behavior || {}) });
    assert.deepEqual(entry.execution, operation.execution);
    assert.deepEqual(entry.dashboard, operation.dashboard);
    assert.deepEqual(entry.groups, operation.groups);
    assert.equal(entry.handlerName, operation.handlerName);
    assert.equal(entry.capability, requiredCapability(entry.operationName));
  
    const args = sampleArgs(entry);
    assert.equal(getCatalogAction(entry.publicTool, args), entry);
    const resolution = resolveToolOperation(entry.publicTool, args);
    assert.equal(resolution.operationName, entry.operationName);
    const executable = resolveExecutableToolCall(entry.publicTool, args, {});
    assert.equal(entry.handlerName, executable.executionDefinition.handlerName);
    assert.equal(typeof executable.executionDefinition.handler, 'function');
    assert.equal(entry.operationName, executable.operationName);
    assert.deepEqual(entry.annotations, executable.executionDefinition.annotations);
    assert.deepEqual(entry.behavior, executable.executionDefinition.behavior);
    assert.deepEqual(entry.execution, executable.executionDefinition.execution);
  
    const toolMetadata = currentMetadata.get(entry.publicTool);
    if (entry.action === 'default') {
      const schema = currentSchemas.get(entry.publicTool).inputSchema;
      assert.deepEqual(entry.fields, Object.keys(schema.properties || {}).filter(field => field !== 'action').sort());
      assert.deepEqual(entry.required, [...(schema.required || [])].filter(field => field !== 'action').sort());
    } else {
      const actionMetadata = toolMetadata.actions.find(action => action.action === entry.action);
      assert.deepEqual(entry.fields, actionMetadata.fields);
      assert.deepEqual(entry.required, actionMetadata.required);
    }
  
    assert.deepEqual(catalogApprovalRequirement(entry.publicTool, args), approvalRequirement(entry.publicTool, args));
    if (entry.publicTool === 'relai_publish' && entry.action === 'commit') {
      const approvalArgs = { ...args, addAll: true };
      assert.deepEqual(catalogApprovalRequirement(entry.publicTool, approvalArgs), approvalRequirement(entry.publicTool, approvalArgs));
    }
  }
  
  assert.equal(getCatalogAction('unknown', {}), null);
  assert.throws(() => getCatalogAction('relai_work', { action: 'unknown' }), /Unsupported action/);
  console.log(`Canonical ${catalogTools.length}-tool, ${catalog.length}-action catalog execution and policy parity passed.`);
  
  function sampleArgs(entry) {
    const key = `${entry.publicTool}:${entry.action}`;
    const args = entry.action === 'default' ? {} : { action: entry.action };
    if (entry.behavior.taskScope === 'required') args.work_id = 'work_catalog';
    switch (key) {
      case 'relai_work:begin': args.workspace = 'repo'; break;
      case 'relai_work:plan': args.steps = [{ title: 'Catalog plan step', status: 'pending' }]; break;
      case 'relai_work:finish': args.summary = 'Completed.'; break;
      case 'relai_search:text': args.pattern = 'needle'; break;
      case 'relai_search:semantic': args.query = 'needle'; break;
      case 'relai_inspect:symbol':
      case 'relai_inspect:references':
      case 'relai_inspect:trace': args.symbol = 'target'; break;
      case 'relai_inspect:related': args.query = 'target'; break;
      case 'relai_inspect:impact': args.paths = ['src/index.js']; break;
      case 'relai_exec:default': args.command = 'node --version'; break;
      case 'relai_process:start': Object.assign(args, { command: 'node server.js', kind: 'service', purpose: 'Catalog parity.' }); break;
      case 'relai_process:read':
      case 'relai_process:stop': args.processId = 'proc_catalog'; break;
      case 'relai_process:write': Object.assign(args, { processId: 'proc_catalog', input: 'status\n' }); break;
      case 'relai_ui:start': args.port = 3000; break;
      case 'relai_ui:navigate': Object.assign(args, { sessionId: 'ui_abcdefghijklmnopqrst', route: '/' }); break;
      case 'relai_ui:snapshot':
      case 'relai_ui:screenshot':
      case 'relai_ui:console':
      case 'relai_ui:network':
      case 'relai_ui:reload':
      case 'relai_ui:stop': args.sessionId = 'ui_abcdefghijklmnopqrst'; break;
      case 'relai_ui:interact': Object.assign(args, { sessionId: 'ui_abcdefghijklmnopqrst', interaction: 'click', target: { by: 'text', value: 'Save' } }); break;
      case 'relai_ui:viewport': Object.assign(args, { sessionId: 'ui_abcdefghijklmnopqrst', width: 1280, height: 720 }); break;
      case 'relai_browser:start': args.url = 'http://192.168.1.20/app'; break;
      case 'relai_browser:status': break;
      case 'relai_browser:tabs':
      case 'relai_browser:open_tab':
      case 'relai_browser:snapshot':
      case 'relai_browser:screenshot':
      case 'relai_browser:stop': args.sessionId = 'browser_abcdefghijklmnopqrst'; break;
      case 'relai_browser:close_tab': Object.assign(args, { sessionId: 'browser_abcdefghijklmnopqrst', tabId: 'tab_abcdefghijklmnopqrst' }); break;
      case 'relai_browser:navigate': Object.assign(args, { sessionId: 'browser_abcdefghijklmnopqrst', url: 'https://intranet.example.test/page' }); break;
      case 'relai_browser:interact': Object.assign(args, { sessionId: 'browser_abcdefghijklmnopqrst', interaction: 'click', target: { by: 'text', value: 'Save' } }); break;
      case 'relai_browser:upload': Object.assign(args, { sessionId: 'browser_abcdefghijklmnopqrst', path: 'artifact.pdf', target: { by: 'label', value: 'Upload' } }); break;
      case 'relai_browser:download': Object.assign(args, { sessionId: 'browser_abcdefghijklmnopqrst', path: 'downloads/report.pdf', interaction: 'click', target: { by: 'text', value: 'Download' } }); break;
      case 'relai_desktop:open_path':
      case 'relai_desktop:reveal_path': Object.assign(args, { workspace: 'repo', path: 'README.md' }); break;
      case 'relai_desktop:open_uri': Object.assign(args, { workspace: 'repo', uri: 'https://example.com' }); break;
      case 'relai_desktop:launch_application': Object.assign(args, { workspace: 'repo', application: 'notepad.exe' }); break;
      case 'relai_desktop:clipboard_read': args.workspace = 'repo'; break;
      case 'relai_desktop:clipboard_write': Object.assign(args, { workspace: 'repo', text: 'hello' }); break;
      case 'relai_computer:move':
      case 'relai_computer:click':
      case 'relai_computer:double_click':
      case 'relai_computer:right_click': Object.assign(args, { x: 10, y: 20 }); break;
      case 'relai_computer:drag': Object.assign(args, { x: 10, y: 20, toX: 30, toY: 40 }); break;
      case 'relai_computer:scroll': Object.assign(args, { direction: 'down', distance: 500 }); break;
      case 'relai_computer:type': args.text = 'hello'; break;
      case 'relai_computer:key': args.key = 'enter'; break;
      case 'relai_computer:hotkey': args.keys = ['ctrl', 's']; break;
      case 'relai_computer:activate': Object.assign(args, { semanticObservationId: 'uia_fixture', targetId: 'e1' }); break;
      case 'relai_computer:set_value': Object.assign(args, { semanticObservationId: 'uia_fixture', targetId: 'e1', value: '' }); break;
      case 'relai_computer:batch': args.actions = [{ action: 'move', x: 10, y: 20 }]; break;
      case 'relai_computer:stop': break;
      case 'relai_computer:approve_app':
      case 'relai_computer:revoke_app': args.app = 'example-app'; break;
      case 'relai_validate:http': args.route = '/health'; break;
      case 'relai_changes:restore': args.paths = ['README.md']; break;
      case 'relai_changes:reset': break;
      case 'relai_changes:replay': args.checkpointId = 'review_abcdefghijklmnopqrstuvwx'; break;
      case 'relai_changes:tidy_run': args.planId = 'tidy_abcdefghijklmnopqrst'; break;
      case 'relai_publish:commit': args.message = 'Catalog commit'; break;
    }
    if (entry.publicTool === 'relai_computer' && entry.required?.includes('app') && !args.app) args.app = 'example-app';
    return args;
  }
}
await case_tool_action_catalog_parity_unit();

// Formerly tool-action-contract-unit.mjs
async function case_tool_action_contract_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:crypto");
    const crypto = __m1.default;
  
    const __m2 = await import("@modelcontextprotocol/server");
    const { fromJsonSchema } = __m2;
  
    const __m3 = await import("../src/mcp/approval.js");
    const { approvalRequirement } = __m3;
  
    const __m4 = await import("../src/mcp/authorizationPolicy.js");
    const { requiredCapability } = __m4;
  
    const __m5 = await import("../src/mcp/toolManifest.js");
    const { buildToolManifest, stableJson } = __m5;
  
    const __m6 = await import("../src/tools/actionCatalog.js");
    const { catalogApprovalRequirement, getToolActionCatalog } = __m6;
  
    const __m7 = await import("../src/tools/actionRegistry.js");
    const { OPERATION_REGISTRY, isToolSurfaceSourcePath } = __m7;
  
    const __m8 = await import("../src/tools/runtimeRegistry.js");
    const { resolveExecutableToolCall } = __m8;
  
    const __m9 = await import("../src/tools/schema.js");
    const { getToolDefinitions, getToolMetadata, getToolSurfaceManifest } = __m9;
  
  const gatewayManifest = buildToolManifest({});
  const gatewayCanonical = {
    schemaVersion: gatewayManifest.schemaVersion,
    toolSurfaceVersion: gatewayManifest.toolSurfaceVersion,
    instructions: gatewayManifest.instructions,
    tools: gatewayManifest.tools
  };
  const gatewayHash = value => crypto.createHash('sha256').update(stableJson(value)).digest('base64url');
  assert.equal(gatewayManifest.hash, gatewayHash(gatewayCanonical), 'gateway manifest hash must cover the full canonical public contract');
  assert.notEqual(
    gatewayHash({ ...gatewayCanonical, instructions: `${gatewayCanonical.instructions} changed` }),
    gatewayManifest.hash,
    'server instruction changes must change the gateway manifest hash'
  );
  const firstTool = gatewayCanonical.tools[0];
  const outputChanged = {
    ...gatewayCanonical,
    tools: [{ ...firstTool, outputSchema: { ...firstTool.outputSchema, description: 'changed output contract' } }, ...gatewayCanonical.tools.slice(1)]
  };
  assert.notEqual(gatewayHash(outputChanged), gatewayManifest.hash, 'output schema changes must change the gateway manifest hash');
  
  const definitions = getToolDefinitions();
  const metadata = getToolMetadata();
  const metadataByName = new Map(metadata.map(item => [item.name, item]));
  const manifestByName = new Map(getToolSurfaceManifest().tools.map(item => [item.name, item]));
  const catalog = getToolActionCatalog();
  
  assert.ok(definitions.length > 0, 'the public tool contract must not be empty');
  assert.ok(catalog.length >= definitions.length, 'every public tool must resolve to at least one operation');
  assert.equal(new Set(definitions.map(item => item.name)).size, definitions.length, 'public tool names must remain unique');
  assert.equal(new Set(catalog.map(item => `${item.publicTool}:${item.action}`)).size, catalog.length, 'public tool/action keys must remain unique');
  assert.deepEqual(
    OPERATION_REGISTRY.map(record => record.definition.name).sort(),
    [...new Set(catalog.map(entry => entry.operationName))].sort(),
    'the canonical operation registry must own every executable operation exposed by the public catalog'
  );
  assert.ok(OPERATION_REGISTRY.every(record => record.publicActions.length > 0), 'stale unexposed operations must fail canonical registry construction');
  
  const editDefinition = definitions.find(definition => definition.name === 'relai_edit');
  assert.ok(editDefinition, 'relai_edit definition must exist');
  
  const semanticWithMaxBytes = resolveExecutableToolCall('relai_search', {
    workspace: 'fixture', work_id: 'work_contract', action: 'semantic', query: 'needle', maxBytes: 4096
  }, {});
  assert.equal(semanticWithMaxBytes.operationArgs.maxBytes, 4096, 'semantic search must accept maxBytes advertised by the public tool schema');
  const processReadWithWorkspace = resolveExecutableToolCall('relai_process', {
    workspace: 'fixture', work_id: 'work_contract', action: 'read', processId: 'proc_test'
  }, {});
  assert.equal(processReadWithWorkspace.operationArgs.workspace, 'fixture', 'process read must accept workspace advertised by the public action schema');
  const processWriteWithWorkspace = resolveExecutableToolCall('relai_process', {
    workspace: 'fixture', work_id: 'work_contract', action: 'write', processId: 'proc_test', input: 'x'
  }, {});
  assert.equal(processWriteWithWorkspace.operationArgs.workspace, 'fixture', 'process write must accept workspace advertised by the public action schema');
  const processStopWithWorkspace = resolveExecutableToolCall('relai_process', {
    workspace: 'fixture', work_id: 'work_contract', action: 'stop', processId: 'proc_test'
  }, {});
  assert.equal(processStopWithWorkspace.operationArgs.workspace, 'fixture', 'process stop must accept workspace advertised by the public action schema');
  const scopedDiff = resolveExecutableToolCall('relai_changes', {
    workspace: 'fixture', work_id: 'work_contract', action: 'diff', scope: 'task'
  }, {});
  assert.equal(scopedDiff.operationArgs.scope, 'task', 'diff scope must be exposed by the public action contract');
  assert.throws(() => resolveExecutableToolCall('relai_changes', {
    workspace: 'fixture', work_id: 'work_contract', action: 'restore', paths: ['README.md'], scope: 'task'
  }, {}), /Unsupported field 'scope'/, 'fields owned by another action must be rejected instead of silently discarded');
  
  assert.equal(isToolSurfaceSourcePath('src/tools/publicSchema.js'), true, 'public discovery schema changes are tool-surface changes');
  assert.equal(isToolSurfaceSourcePath('src/tools/publicOperationSchemas.js'), true, 'public operation schema changes are tool-surface changes');
  assert.equal(isToolSurfaceSourcePath('src/tools/outputValidation.js'), true, 'output validation changes are tool-surface changes');
  assert.equal(isToolSurfaceSourcePath('src/tools/handlers.js'), true, 'handler registration changes are tool-surface changes');
  assert.equal(isToolSurfaceSourcePath('src/tools/compactResult.js'), true, 'connector output compaction changes are tool-surface changes');
  assert.equal(isToolSurfaceSourcePath('src/tools/execution.js'), true, 'tool execution changes are tool-surface changes');
  assert.equal(isToolSurfaceSourcePath('src/tools/status.js'), true, 'tool status serialization changes are tool-surface changes');
  assert.equal(isToolSurfaceSourcePath('src/tools/task.js'), true, 'tool task handlers are tool-surface changes');
  assert.equal(isToolSurfaceSourcePath('src/tools/cancellation.js'), true, 'tool cancellation behavior is a tool-surface change');
  assert.equal(isToolSurfaceSourcePath('src/tools/new-contract-module.js'), true, 'new tool-system files must inherit tool-surface risk without allowlist maintenance');
  assert.equal(isToolSurfaceSourcePath('src/http/mcpTransport.ts'), false, 'non-tool-system paths keep their own risk classification');
  
  const publicSchemaByName = new Map(gatewayManifest.tools.map(tool => [tool.name, tool.inputSchema]));
  const resolvedKeys = [];
  for (const entry of catalog) {
    const args = sampleArgs(entry);
    const resolved = resolveExecutableToolCall(entry.publicTool, args, {});
    assert.ok(resolved, `${entry.publicTool}:${entry.action} must resolve`);
    const advertisedSchema = publicSchemaByName.get(entry.publicTool);
    for (const field of entry.fields) {
      const internalEditTransportField = entry.publicTool === 'relai_edit' && ['stage', 'writeId'].includes(field);
      if (internalEditTransportField) {
        assert.equal(advertisedSchema?.properties?.[field], undefined, `${entry.publicTool}:${entry.action} internal transport field ${field} must stay out of public discovery`);
        continue;
      }
      assert.ok(advertisedSchema?.properties?.[field], `${entry.publicTool}:${entry.action} executable field ${field} must remain discoverable`);
    }
    if (entry.action !== 'default') {
      const publicValidation = await fromJsonSchema(advertisedSchema)['~standard'].validate(args);
      assert.equal(publicValidation.issues, undefined, `${entry.publicTool}:${entry.action} sample must satisfy advertised discovery schema`);
    }
    resolvedKeys.push(`${entry.publicTool}:${entry.action}`);
    assert.equal(resolved.operationName, entry.operationName);
    assert.equal(resolved.executionDefinition.handlerName, entry.handlerName);
    assert.equal(typeof resolved.executionDefinition.handler, 'function');
    assert.equal(requiredCapability(resolved.operationName), entry.capability);
    assert.deepEqual(resolved.executionDefinition.behavior, entry.behavior);
    assert.deepEqual(resolved.executionDefinition.execution, entry.execution);
  
    const publicMetadata = metadataByName.get(entry.publicTool);
    assert.ok(publicMetadata, `${entry.publicTool} must have public metadata`);
    const actionMetadata = entry.action === 'default'
      ? publicMetadata
      : publicMetadata.actions.find(item => item.action === entry.action);
    assert.ok(actionMetadata, `${entry.publicTool}:${entry.action} must have public action metadata`);
    assert.equal(actionMetadata.executionClass, entry.behavior.executionClass);
    assert.equal(actionMetadata.taskSupport, entry.execution?.taskSupport || 'forbidden');
    if (entry.action !== 'default') {
      assert.deepEqual(actionMetadata.annotations, resolved.executionDefinition.annotations);
      assert.equal(actionMetadata.taskScope, entry.behavior.taskScope);
      assert.equal(actionMetadata.concurrencyScope, entry.behavior.concurrencyScope);
    }
  
    const manifestTool = manifestByName.get(entry.publicTool);
    assert.ok(manifestTool, `${entry.publicTool} must be present in the tool-surface manifest`);
    const manifestAction = entry.action === 'default'
      ? manifestTool
      : manifestTool.actions.find(item => item.action === entry.action);
    assert.ok(manifestAction, `${entry.publicTool}:${entry.action} must be present in the tool-surface manifest`);
    assert.equal(manifestAction.executionClass, entry.behavior.executionClass);
    assert.equal(manifestAction.taskSupport, entry.execution?.taskSupport || 'forbidden');
  
    assert.deepEqual(
      catalogApprovalRequirement(entry.publicTool, args),
      approvalRequirement(entry.publicTool, args),
      `${entry.publicTool}:${entry.action} approval policy must have one meaning across the catalog and runtime`
    );
    if (entry.publicTool === 'relai_publish' && entry.action === 'commit') {
      const addAllArgs = { ...args, addAll: true };
      assert.deepEqual(catalogApprovalRequirement(entry.publicTool, addAllArgs), approvalRequirement(entry.publicTool, addAllArgs));
    }
  }
  
  for (const entry of catalog.filter(item => item.action !== 'default')) {
    const baseArgs = sampleArgs(entry);
    const siblings = catalog.filter(item => item.publicTool === entry.publicTool && item.action !== entry.action);
    const siblingSamples = siblings.map(sampleArgs);
    const foreignFields = siblingSamples.flatMap(sample => Object.entries(sample))
      .filter(([field]) => field !== 'action' && !entry.fields.includes(field));
    if (!foreignFields.length) continue;
    const [field, value] = foreignFields[0];
    const invalidArgs = { ...baseArgs, [field]: value };
    const publicValidation = await fromJsonSchema(publicSchemaByName.get(entry.publicTool))['~standard'].validate(invalidArgs);
    assert.equal(publicValidation.issues, undefined, `${entry.publicTool}:${entry.action} discovery keeps sibling field ${field} visible; runtime owns action-specific rejection`);
    assert.throws(
      () => resolveExecutableToolCall(entry.publicTool, invalidArgs, {}),
      new RegExp(`Unsupported field '${field}'`),
      `${entry.publicTool}:${entry.action} runtime resolver must reject sibling-only field ${field}`
    );
  }
  
  const discoveredKeys = definitions.flatMap(definition => {
    const actions = metadataByName.get(definition.name)?.actions || [];
    return actions.length ? actions.map(action => `${definition.name}:${action.action}`) : [`${definition.name}:default`];
  });
  assert.deepEqual(resolvedKeys.sort(), discoveredKeys.sort(), 'every discovered public action must be executable through the canonical resolver');
  
  assert.ok(approvalRequirement('relai_changes', { action: 'reset', work_id: 'work_contract' }), 'workspace reset must remain approval-gated without a duplicate confirmation token');
  const resetAction = catalog.find(entry => entry.publicTool === 'relai_changes' && entry.action === 'reset');
  assert.equal(resetAction.fields.includes('confirmation'), false, 'reset must use native approval instead of a model-supplied magic confirmation field');
  assert.equal(approvalRequirement('relai_publish', { action: 'push', work_id: 'work_contract' }), null, 'Git push must rely on publish capability authorization without a second approval interaction');
  assert.equal(approvalRequirement('relai_publish', { action: 'push', work_id: 'work_contract', dryRun: true }), null, 'Git push dry-run must not request approval');
  assert.equal(approvalRequirement('relai_publish', { action: 'commit', work_id: 'work_contract', message: 'Contract commit' }), null, 'implicit task-owned commit should not require extra approval');
  assert.equal(approvalRequirement('relai_publish', { action: 'commit', work_id: 'work_contract', message: 'Contract commit', paths: ['src/selected.js'] }), null, 'explicit local commit scope must not require a second approval prompt');
  assert.equal(approvalRequirement('relai_publish', { action: 'commit', message: 'Taskless explicit commit', paths: ['src/selected.js'] }), null, 'taskless explicit local commits must execute without dashboard approval');
  assert.equal(approvalRequirement('relai_publish', { action: 'commit', work_id: 'work_contract', message: 'Contract commit', addAll: true }), null, 'explicit addAll local commits must not require dashboard approval');
  assert.equal(approvalRequirement('relai_publish', { action: 'commit', message: 'Sensitive commit', paths: ['secret.txt'], sensitiveAuthorization: { operation: 'commit', paths: ['secret.txt'], reason: 'User explicitly requested this local commit.' } }), null, 'sensitiveAuthorization is the explicit local commit authorization and must not trigger a second approval layer');
  for (const entry of catalog.filter(item => item.publicTool === 'relai_browser')) {
    assert.equal(entry.capability, 'process:manage', `relai_browser:${entry.action} must use structured process/browser authorization rather than raw computer control`);
    assert.equal(entry.behavior.taskScope, 'optional', `relai_browser:${entry.action} must allow principal/workspace/session authority without synthetic durable work`);
    assert.equal(approvalRequirement('relai_browser', sampleArgs(entry)), null, `relai_browser:${entry.action} must use principal authorization without a duplicate MCP approval flow`);
  }
  for (const entry of catalog.filter(item => item.publicTool === 'relai_desktop')) {
    assert.equal(approvalRequirement('relai_desktop', sampleArgs(entry)), null, `relai_desktop:${entry.action} must use principal authorization without a duplicate MCP approval flow`);
  }
  for (const entry of catalog.filter(item => item.publicTool === 'relai_computer')) {
    assert.equal(approvalRequirement('relai_computer', sampleArgs(entry)), null, `relai_computer:${entry.action} must never enter the MCP approval flow`);
  }
  
  console.log(`Dynamic public contract parity passed for ${definitions.length} tools and ${catalog.length} actions.`);
  
  function sampleArgs(entry) {
    const key = `${entry.publicTool}:${entry.action}`;
    const args = entry.action === 'default' ? {} : { action: entry.action };
    if (entry.behavior?.taskScope === 'required') args.work_id = 'work_contract';
    switch (key) {
      case 'relai_work:begin': args.workspace = 'repo'; break;
      case 'relai_work:plan': args.steps = [{ title: 'Contract plan step', status: 'pending' }]; break;
      case 'relai_work:finish': args.summary = 'Completed.'; break;
      case 'relai_search:text': args.pattern = 'needle'; break;
      case 'relai_search:semantic': args.query = 'needle'; break;
      case 'relai_inspect:symbol':
      case 'relai_inspect:references':
      case 'relai_inspect:trace': args.symbol = 'target'; break;
      case 'relai_inspect:related': args.query = 'target'; break;
      case 'relai_inspect:impact': args.paths = ['src/index.js']; break;
      case 'relai_exec:default': args.command = 'node --version'; break;
      case 'relai_process:start': Object.assign(args, { command: 'node server.js', kind: 'service', purpose: 'Contract parity.' }); break;
      case 'relai_process:read':
      case 'relai_process:stop': args.processId = 'proc_contract'; break;
      case 'relai_process:write': Object.assign(args, { processId: 'proc_contract', input: 'status\n' }); break;
      case 'relai_ui:start': args.port = 3000; break;
      case 'relai_ui:navigate': Object.assign(args, { sessionId: 'ui_abcdefghijklmnopqrst', route: '/' }); break;
      case 'relai_ui:snapshot':
      case 'relai_ui:screenshot':
      case 'relai_ui:console':
      case 'relai_ui:network':
      case 'relai_ui:reload':
      case 'relai_ui:stop': args.sessionId = 'ui_abcdefghijklmnopqrst'; break;
      case 'relai_ui:interact': Object.assign(args, { sessionId: 'ui_abcdefghijklmnopqrst', interaction: 'click', target: { by: 'text', value: 'Save' } }); break;
      case 'relai_ui:viewport': Object.assign(args, { sessionId: 'ui_abcdefghijklmnopqrst', width: 1280, height: 720 }); break;
      case 'relai_browser:start': args.url = 'http://192.168.1.20/app'; break;
      case 'relai_browser:status': break;
      case 'relai_browser:tabs':
      case 'relai_browser:open_tab':
      case 'relai_browser:snapshot':
      case 'relai_browser:screenshot':
      case 'relai_browser:stop': args.sessionId = 'browser_abcdefghijklmnopqrst'; break;
      case 'relai_browser:close_tab': Object.assign(args, { sessionId: 'browser_abcdefghijklmnopqrst', tabId: 'tab_abcdefghijklmnopqrst' }); break;
      case 'relai_browser:navigate': Object.assign(args, { sessionId: 'browser_abcdefghijklmnopqrst', url: 'https://intranet.example.test/page' }); break;
      case 'relai_browser:interact': Object.assign(args, { sessionId: 'browser_abcdefghijklmnopqrst', interaction: 'click', target: { by: 'text', value: 'Save' } }); break;
      case 'relai_browser:upload': Object.assign(args, { sessionId: 'browser_abcdefghijklmnopqrst', path: 'artifact.pdf', target: { by: 'label', value: 'Upload' } }); break;
      case 'relai_browser:download': Object.assign(args, { sessionId: 'browser_abcdefghijklmnopqrst', path: 'downloads/report.pdf', interaction: 'click', target: { by: 'text', value: 'Download' } }); break;
      case 'relai_desktop:open_path':
      case 'relai_desktop:reveal_path': Object.assign(args, { workspace: 'fixture', path: 'README.md' }); break;
      case 'relai_desktop:open_uri': Object.assign(args, { workspace: 'fixture', uri: 'https://example.com' }); break;
      case 'relai_desktop:launch_application': Object.assign(args, { workspace: 'fixture', application: 'notepad.exe' }); break;
      case 'relai_desktop:clipboard_read': args.workspace = 'fixture'; break;
      case 'relai_desktop:clipboard_write': Object.assign(args, { workspace: 'fixture', text: 'hello' }); break;
      case 'relai_computer:move':
      case 'relai_computer:click':
      case 'relai_computer:double_click':
      case 'relai_computer:right_click': Object.assign(args, { x: 10, y: 20 }); break;
      case 'relai_computer:drag': Object.assign(args, { x: 10, y: 20, toX: 30, toY: 40 }); break;
      case 'relai_computer:scroll': Object.assign(args, { direction: 'down', distance: 500 }); break;
      case 'relai_computer:type': args.text = 'hello'; break;
      case 'relai_computer:key': args.key = 'enter'; break;
      case 'relai_computer:hotkey': args.keys = ['ctrl', 's']; break;
      case 'relai_computer:activate': Object.assign(args, { semanticObservationId: 'uia_fixture', targetId: 'e1' }); break;
      case 'relai_computer:set_value': Object.assign(args, { semanticObservationId: 'uia_fixture', targetId: 'e1', value: '' }); break;
      case 'relai_computer:batch': args.actions = [{ action: 'move', x: 10, y: 20 }]; break;
      case 'relai_computer:stop': break;
      case 'relai_computer:approve_app':
      case 'relai_computer:revoke_app': args.app = 'example-app'; break;
      case 'relai_validate:http': args.route = '/health'; break;
      case 'relai_changes:restore': args.paths = ['README.md']; break;
      case 'relai_changes:reset': break;
      case 'relai_changes:replay': args.checkpointId = 'review_abcdefghijklmnopqrstuvwx'; break;
      case 'relai_changes:tidy_run': args.planId = 'tidy_abcdefghijklmnopqrst'; break;
      case 'relai_publish:commit': args.message = 'Contract commit'; break;
    }
    if (entry.publicTool === 'relai_computer' && entry.required?.includes('app') && !args.app) args.app = 'example-app';
    return args;
  }
}
await case_tool_action_contract_unit();

// Formerly tool-dashboard-category-unit.mjs
async function case_tool_dashboard_category_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/tools/schema.js");
    const { getToolMetadata, getToolNames } = __m1;
  
  const byName = new Map(getToolMetadata().map(tool => [tool.name, tool]));
  const expected = new Map([
    ['relai_snapshot', ['inspect']],
    ['relai_read', ['inspect']],
    ['relai_search', ['inspect']],
    ['relai_inspect', ['inspect']],
    ['relai_edit', ['edit']],
    ['relai_exec', ['execute']],
    ['relai_process', ['execute']],
    ['relai_work', ['workflow']],
    ['relai_changes', ['review', 'recover']],
    ['relai_validate', ['validate']],
    ['relai_publish', ['git']]
  ]);
  for (const [name, capabilities] of expected) {
    assert.deepEqual(byName.get(name)?.capabilities, capabilities, `${name} dashboard category is wrong`);
  }
  assert.equal(byName.size, getToolNames().length, 'dashboard metadata must cover the complete canonical tool surface');
  console.log('Tool dashboard categories match the canonical public tool surface.');
}
await case_tool_dashboard_category_unit();

// Formerly tool-output-validation-unit.mjs
async function case_tool_output_validation_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/tools/actionCatalog.js");
    const { getToolActionCatalog } = __m1;
  
    const __m2 = await import("../src/tools/outputValidation.js");
    const { validateToolOutput } = __m2;
  
  const actionCatalog = getToolActionCatalog();
  
  for (const entry of actionCatalog) {
    const args = entry.action === 'default' ? {} : { action: entry.action };
    if (entry.behavior.taskScope === 'required') args.work_id = 'work_output';
    Object.assign(args, requiredArgs(entry));
    if (entry.publicTool === 'relai_computer' && entry.required?.includes('app') && !args.app) args.app = 'example-app';
    await assert.doesNotReject(() => validateToolOutput({}, entry.publicTool, args, {
      ok: false,
      error: 'Expected failure.'
    }));
  }
  
  await assert.doesNotReject(() => validateToolOutput({}, 'relai_search', {
    action: 'text',
    work_id: 'work_output',
    pattern: 'needle'
  }, {
    ok: true,
    workspace: 'repo',
    work_id: 'work_output',
    pattern: 'needle',
    mode: 'auto',
    effectiveMode: 'context',
    autoTier: 'focused',
    selectionStrategy: 'path-and-match-density',
    matchCount: 1,
    files: []
  }));
  
  await assert.doesNotReject(() => validateToolOutput({}, 'relai_search', {
    action: 'semantic',
    work_id: 'work_output',
    query: 'needle'
  }, {
    ok: true,
    workspace: 'repo',
    work_id: 'work_output',
    query: 'needle',
    strategy: 'hybrid',
    neuralEmbeddings: true,
    results: [],
    resultCount: 0,
    truncated: false
  }));
  
  await assert.doesNotReject(() => validateToolOutput({}, 'relai_snapshot', {
    work_id: 'work_output'
  }, {
    ok: true,
    workspace: 'repo',
    work_id: 'work_output',
    fileCount: 700,
    files: ['src/index.js'],
    returnedFileCount: 1,
    omittedFiles: 699,
    truncated: true,
    next: 'Use relai_search or targeted relai_read calls for omitted repository paths.'
  }));
  
  await assert.doesNotReject(() => validateToolOutput({}, 'relai_process', {
    action: 'list',
    workspace: 'repo'
  }, {
    ok: true,
    processes: [],
    count: 0
  }));
  await assert.doesNotReject(() => validateToolOutput({}, 'relai_process', {
    action: 'read',
    workspace: 'repo',
    processId: 'proc_abcdefghijklmnopqrst'
  }, {
    ok: true,
    processId: 'proc_abcdefghijklmnopqrst',
    status: 'running',
    stdout: { text: '', nextOffset: 0 },
    stderr: { text: '', nextOffset: 0 }
  }));
  await assert.doesNotReject(() => validateToolOutput({}, 'relai_process', {
    action: 'stop',
    workspace: 'repo',
    processId: 'proc_abcdefghijklmnopqrst'
  }, {
    ok: true,
    processId: 'proc_abcdefghijklmnopqrst',
    status: 'stopped',
    duplicate: false
  }));
  
  await assert.doesNotReject(() => validateToolOutput({}, 'relai_inspect', {
    action: 'diagnostics',
    work_id: 'work_output'
  }, {
    ok: true,
    workspace: 'repo',
    work_id: 'work_output',
    action: 'diagnostics',
    index: {},
    languages: { javascript: 12 },
    diagnosticCommands: [],
    discoveryWarnings: [{ source: 'package.json', message: 'Invalid JSON.' }],
    validationCommands: { quick: [], standard: [], release: [] },
    configuredTestCommands: []
  }));
  await assert.doesNotReject(() => validateToolOutput({}, 'relai_inspect', {
    action: 'architecture',
    work_id: 'work_output'
  }, {
    ok: true,
    workspace: 'repo',
    work_id: 'work_output',
    action: 'architecture',
    modules: [],
    entryPoints: [],
    hotspots: [],
    layers: [],
    cycles: [{ modules: ['src/a.js', 'src/b.js'], size: 2 }],
    communities: [],
    summary: { files: 2, analyzedFiles: 2, edges: 2, modules: 2, cycles: 1, communities: 0, entryPoints: 0, hotspots: 0 },
    truncated: false,
    next: 'Use cycles to review dependency boundaries.'
  }));
  await assert.doesNotReject(() => validateToolOutput({}, 'relai_work', {
    action: 'begin',
    workspace: 'repo'
  }, {
    ok: true,
    workspace: 'repo',
    work_id: 'work_output',
    status: 'planning',
    identity: 'work_session',
    title: 'Investigate output contract',
    objective: 'Preserve first-class workflow intent.',
    intent: 'investigation'
  }));
  await assert.doesNotReject(() => validateToolOutput({}, 'relai_work', {
    action: 'cancel',
    work_id: 'work_output'
  }, {
    ok: true,
    work_id: 'work_output',
    status: 'cancelled',
    duplicate: true,
    endReason: 'explicit_cancellation',
    terminalReason: 'Work session cancelled.',
    endedAt: '2026-08-08T00:00:00.000Z',
    cancelledAt: '2026-08-08T00:00:00.000Z',
    progress: { mode: 'indeterminate', label: 'Cancelled' }
  }));
  await assert.doesNotReject(() => validateToolOutput({}, 'relai_exec', {
    work_id: 'work_output',
    command: 'npm test'
  }, {
    ok: true,
    workspace: 'repo',
    work_id: 'work_output',
    executed: true,
    commandSucceeded: true,
    exitCode: 0,
    durationMs: 1,
    queueWaitMs: 0,
    queueTimedOut: false
  }));
  
  await assert.doesNotReject(() => validateToolOutput({}, 'relai_process', {
    action: 'start',
    workspace: 'repo',
    work_id: 'work_output',
    kind: 'service',
    purpose: 'Serve test fixture',
    command: 'node server.js'
  }, {
    ok: true,
    work_id: 'work_output',
    processId: 'proc_abcdefghijklmnopqrst',
    status: 'running',
    lifecycle: 'persistent',
    queueWaitMs: 12
  }));
  
  await assert.doesNotReject(() => validateToolOutput({}, 'relai_exec', {
    workspace: 'repo',
    command: 'npm test'
  }, {
    ok: true,
    workspace: 'repo',
    executed: true,
    commandSucceeded: true,
    exitCode: 0,
    durationMs: 1
  }));
  
  for (const [action, args, result] of [
    ['status', {}, { ok: true, workspace: 'repo', action: 'status', platform: 'win32', enabled: true, available: true, engine: '@midscene/computer', displays: 2 }],
    ['displays', {}, { ok: true, workspace: 'repo', action: 'displays', platform: 'win32', engine: '@midscene/computer', displays: [{ id: 'display-1', width: 1920, height: 1080 }], count: 1 }],
    ['observe', { app: 'example-app' }, { ok: true, workspace: 'repo', action: 'observe', platform: 'win32', engine: 'windows-uia', app: 'example-app', semanticAvailable: true, semanticObservationId: 'uia_fixture', elements: [{ targetId: 'e1', role: 'Button', name: 'Save' }], count: 1, truncated: false }],
    ['activate', { app: 'example-app', semanticObservationId: 'uia_fixture', targetId: 'e1' }, { ok: true, workspace: 'repo', action: 'activate', platform: 'win32', app: 'example-app', semanticObservationId: 'uia_fixture', targetId: 'e1', displayId: 'display-1', x: 10, y: 20, method: 'semantic-center-click', executed: true }],
    ['set_value', { app: 'example-app', semanticObservationId: 'uia_fixture', targetId: 'e1', value: '' }, { ok: true, workspace: 'repo', action: 'set_value', platform: 'win32', app: 'example-app', semanticObservationId: 'uia_fixture', targetId: 'e1', displayId: 'display-1', x: 10, y: 20, method: 'uia-set-value', textLength: 0, executed: true }],
    ['screenshot', { app: 'example-app', displayId: 'display-1' }, { ok: true, workspace: 'repo', action: 'screenshot', platform: 'win32', engine: '@midscene/computer', displayId: 'display-1', image: { mimeType: 'image/png', data: 'fixture' } }],
    ['wait_for_stable', { app: 'example-app' }, { ok: true, workspace: 'repo', action: 'wait_for_stable', platform: 'win32', app: 'example-app', stable: true, stableMs: 350, durationMs: 400 }],
    ['click', { app: 'example-app', x: 10, y: 20, displayId: 'display-1' }, { ok: true, workspace: 'repo', action: 'click', platform: 'win32', displayId: 'display-1', x: 10, y: 20, executed: true }]
  ]) {
    await assert.doesNotReject(() => validateToolOutput({}, 'relai_computer', { action, workspace: 'repo', ...args }, result));
  }
  
  await assert.doesNotReject(() => validateToolOutput({}, 'relai_changes', {
    action: 'restore',
    workspace: 'repo',
    paths: ['README.md']
  }, {
    ok: true,
    workspace: 'repo',
    mode: 'paths',
    paths: ['README.md'],
    exitCode: 0,
    durationMs: 8,
    queueWaitMs: 3,
    queueTimedOut: false
  }));
  
  await assert.doesNotReject(() => validateToolOutput({}, 'relai_publish', {
    action: 'commit',
    work_id: 'work_output',
    message: 'Validate output',
    dryRun: true
  }, {
    ok: true,
    workspace: 'repo',
    work_id: 'work_output',
    dryRun: true,
    message: 'Validate output',
    addAll: false,
    paths: ['CHANGELOG.md'],
    statusBefore: { branch: 'main' }
  }));
  
  await assert.doesNotReject(() => validateToolOutput({}, 'relai_publish', {
    action: 'commit',
    work_id: 'work_output',
    message: 'Validate output'
  }, {
    ok: true,
    workspace: 'repo',
    work_id: 'work_output',
    message: 'Validate output',
    addAll: false,
    paths: ['CHANGELOG.md'],
    commit: { exitCode: 0 },
    head: 'cc626cb78a2ea761cd5ca736c5dbabebda1831dd',
    statusBefore: { branch: 'release/1.0.0' },
    statusAfter: { branch: 'release/1.0.0' }
  }));
  
  await assert.doesNotReject(() => validateToolOutput({}, 'relai_publish', {
    action: 'push',
    work_id: 'work_output',
    dryRun: true
  }, {
    ok: true,
    workspace: 'repo',
    work_id: 'work_output',
    remote: 'origin',
    branch: 'main',
    dryRun: true,
    setUpstream: false,
    push: { exitCode: 0 }
  }));
  
  await assert.rejects(() => validateToolOutput({}, 'relai_publish', {
    action: 'push',
    work_id: 'work_output'
  }, {
    ok: true,
    workspace: 'repo',
    work_id: 'work_output',
    unexpected: true
  }), /Unexpected fields: unexpected/);
  
  console.log(`Catalog-backed output validation passed for all ${actionCatalog.length} actions.`);
  
  function requiredArgs(entry) {
    const key = `${entry.publicTool}:${entry.action}`;
    switch (key) {
      case 'relai_work:begin': return { workspace: 'repo' };
      case 'relai_work:plan': return { steps: [{ title: 'Output validation plan step', status: 'pending' }] };
      case 'relai_work:finish': return { summary: 'Done.' };
      case 'relai_search:text': return { pattern: 'needle' };
      case 'relai_search:semantic': return { query: 'needle' };
      case 'relai_inspect:symbol':
      case 'relai_inspect:references':
      case 'relai_inspect:trace': return { symbol: 'target' };
      case 'relai_inspect:related': return { query: 'target' };
      case 'relai_inspect:impact': return { paths: ['src/index.js'] };
      case 'relai_exec:default': return { command: 'npm test' };
      case 'relai_process:start': return { command: 'npm run dev', kind: 'service', purpose: 'Validate.' };
      case 'relai_ui:start': return { port: 3000 };
      case 'relai_ui:navigate': return { sessionId: 'ui_abcdefghijklmnopqrst', route: '/' };
      case 'relai_ui:interact': return { sessionId: 'ui_abcdefghijklmnopqrst', interaction: 'click', target: { by: 'text', value: 'Save' } };
      case 'relai_ui:viewport': return { sessionId: 'ui_abcdefghijklmnopqrst', width: 1280, height: 720 };
      case 'relai_ui:snapshot':
      case 'relai_ui:screenshot':
      case 'relai_ui:console':
      case 'relai_ui:network':
      case 'relai_ui:reload':
      case 'relai_ui:stop': return { sessionId: 'ui_abcdefghijklmnopqrst' };
      case 'relai_browser:start': return { url: 'http://192.168.1.20/app' };
      case 'relai_browser:status': return {};
      case 'relai_browser:tabs':
      case 'relai_browser:open_tab':
      case 'relai_browser:snapshot':
      case 'relai_browser:screenshot':
      case 'relai_browser:stop': return { sessionId: 'browser_abcdefghijklmnopqrst' };
      case 'relai_browser:close_tab': return { sessionId: 'browser_abcdefghijklmnopqrst', tabId: 'tab_abcdefghijklmnopqrst' };
      case 'relai_browser:navigate': return { sessionId: 'browser_abcdefghijklmnopqrst', url: 'https://intranet.example.test/page' };
      case 'relai_browser:interact': return { sessionId: 'browser_abcdefghijklmnopqrst', interaction: 'click', target: { by: 'text', value: 'Save' } };
      case 'relai_browser:upload': return { sessionId: 'browser_abcdefghijklmnopqrst', path: 'artifact.pdf', target: { by: 'label', value: 'Upload' } };
      case 'relai_browser:download': return { sessionId: 'browser_abcdefghijklmnopqrst', path: 'downloads/report.pdf', interaction: 'click', target: { by: 'text', value: 'Download' } };
      case 'relai_desktop:open_path':
      case 'relai_desktop:reveal_path': return { workspace: 'repo', path: 'README.md' };
      case 'relai_desktop:open_uri': return { workspace: 'repo', uri: 'https://example.com' };
      case 'relai_desktop:launch_application': return { workspace: 'repo', application: 'notepad.exe' };
      case 'relai_desktop:clipboard_read': return { workspace: 'repo' };
      case 'relai_desktop:clipboard_write': return { workspace: 'repo', text: 'hello' };
      case 'relai_computer:move':
      case 'relai_computer:click':
      case 'relai_computer:double_click':
      case 'relai_computer:right_click': return { x: 10, y: 20 };
      case 'relai_computer:drag': return { x: 10, y: 20, toX: 30, toY: 40 };
      case 'relai_computer:scroll': return { direction: 'down' };
      case 'relai_computer:type': return { text: 'hello' };
      case 'relai_computer:key': return { key: 'enter' };
      case 'relai_computer:hotkey': return { keys: ['ctrl', 's'] };
      case 'relai_computer:activate': return { semanticObservationId: 'uia_fixture', targetId: 'e1' };
      case 'relai_computer:set_value': return { semanticObservationId: 'uia_fixture', targetId: 'e1', value: '' };
      case 'relai_computer:batch': return { actions: [{ action: 'move', x: 10, y: 20 }] };
      case 'relai_computer:stop': return {};
      case 'relai_computer:approve_app':
      case 'relai_computer:revoke_app': return { app: 'example-app' };
      case 'relai_process:read':
      case 'relai_process:stop': return { processId: 'proc_output' };
      case 'relai_process:write': return { processId: 'proc_output', input: 'status\n' };
      case 'relai_validate:http': return { route: '/health' };
      case 'relai_changes:restore': return { paths: ['README.md'] };
      case 'relai_changes:reset': return {};
      case 'relai_changes:replay': return { checkpointId: 'review_abcdefghijklmnopqrstuvwx' };
      case 'relai_changes:tidy_run': return { planId: 'tidy_abcdefghijklmnopqrst' };
      case 'relai_publish:commit': return { message: 'Validate output' };
      default: return {};
    }
  }
}
await case_tool_output_validation_unit();

// Formerly tool-session-unit.mjs
async function case_tool_session_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/tools/session.js");
    const { buildExtraAudit } = __m1;
  
    const __m2 = await import("../src/tools/operationIds.js");
    const { OPERATION_IDS: OP } = __m2;
  
  assert.deepEqual(
    buildExtraAudit(OP.EDIT, { plannerPath: 'replace', plannerReason: 'exact text supplied' }, { path: 'src/example.js' }),
    { plannerPath: 'replace', plannerReason: 'exact text supplied', filePath: 'src/example.js' }
  );
  
  assert.deepEqual(
    buildExtraAudit(OP.VALIDATE_CHECKS, {
      validationLevel: 'release',
      validationLevelReason: 'requested',
      aliasNormalizations: 0,
      policy: { sessionActive: false }
    }, {}),
    {
      validationLevel: 'release',
      validationLevelReason: 'requested',
      aliasNormalizations: 0,
      policySessionActive: false
    }
  );
  
  assert.deepEqual(
    buildExtraAudit(OP.READ, { items: [{ cacheHit: false }, { cacheHit: true }] }, {}),
    { cacheHit: true }
  );
  
  assert.deepEqual(
    buildExtraAudit(OP.EXEC, {
      commandSummary: 'npm test --token [REDACTED]',
      cwd: '.',
      exitCode: 1,
      durationMs: 42,
      stdoutBytes: 100,
      stderrBytes: 20,
      stdoutTruncated: false,
      stderrTruncated: true,
      timedOut: false,
      mutationTracking: 'git',
      environmentKeys: ['CI'],
      changedFiles: ['package-lock.json']
    }, {}),
    {
      commandSummary: 'npm test --token [REDACTED]',
      cwd: '.',
      exitCode: 1,
      durationMs: 42,
      stdoutBytes: 100,
      stderrBytes: 20,
      stdoutTruncated: false,
      stderrTruncated: true,
      timedOut: false,
      mutationTracking: 'git',
      mutationUnknown: false,
      environmentKeys: ['CI'],
      changedFiles: ['package-lock.json']
    }
  );
  
  assert.deepEqual(
    buildExtraAudit(OP.SNAPSHOT, { effectiveMaxEntries: 0, budgetMultiplied: false }, {}),
    { effectiveSnapshotMaxFiles: 0, budgetMultiplied: false }
  );
  
  assert.deepEqual(
    buildExtraAudit(OP.EDIT, { changedFiles: ['src/example.js'] }, { path: 'src/example.js', dryRun: true }),
    { filePath: 'src/example.js' },
    'dry-run edits must not be recorded as actual changed files'
  );
  assert.deepEqual(buildExtraAudit(OP.PUBLISH_COMMIT, { ok: true, paths: ['src/example.js'] }, { dryRun: true }), {}, 'dry-run commits must not be recorded as created commits');
  assert.deepEqual(buildExtraAudit(OP.PUBLISH_PUSH, { ok: true }, { dryRun: true }), {}, 'dry-run pushes must not be recorded as published pushes');
  assert.deepEqual(buildExtraAudit(OP.PUBLISH_PUSH, { ok: true }, {}), { pushPublished: true }, 'real successful pushes remain publish events');
  
  assert.deepEqual(buildExtraAudit(OP.WORK_STATUS, {}, {}), {});
  assert.deepEqual(buildExtraAudit(OP.EDIT, { plannerPath: '', plannerReason: '' }, {}), {});
  assert.deepEqual(buildExtraAudit('removed_tool', {}, {}), {});
  
  console.log('Tool session audit enrichment tests passed for active tools.');
}
await case_tool_session_unit();

// Formerly tool-surface-discovery-unit.mjs
async function case_tool_surface_discovery_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("node:url");
    const { fileURLToPath } = __m4;
  
    const __m5 = await import("./helpers/mcp-client.mjs");
    const { startMcpClient, structuredContentOf } = __m5;
  
    const __m6 = await import("./helpers/tool-surface.mjs");
    const { activeMcpToolNames, activeToolCount, activeToolNames } = __m6;
  
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const variants = [
    { name: 'canonical', extra: {} },
    { name: 'stale-profile-field', extra: { toolProfile: 'core' } }
  ];
  
  for (const variant of variants) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), `relai-${variant.name}-discovery-`));
    const configPath = path.join(temp, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      version: 3,
      ...variant.extra,
      stateDir: path.join(temp, 'state'),
      workspaces: { repo: { path: root } }
    }, null, 2));
  
    const client = startMcpClient({ root, configPath });
    try {
      client.initialize(1);
      const discovery = await client.waitFor(1);
      assert.equal(discovery.result?.capabilities?.experimental?.relai?.toolCount, activeToolCount);
      client.send(2, 'tools/list', {});
      const response = await client.waitFor(2);
      const tools = response.result?.tools || [];
      const names = tools.map(tool => tool.name);
      const byName = new Map(tools.map(tool => [tool.name, tool]));
      assert.deepEqual(names, activeMcpToolNames);
      assert.deepEqual(tools.filter(tool => activeToolNames.includes(tool.name)).map(tool => tool.name), activeToolNames);
      assert.equal(byName.has('relai_approval'), false);
      assert.deepEqual(tools.filter(tool => tool.name.startsWith('relai_app_')).map(tool => tool.name), []);
      const readSchema = byName.get('relai_read')?.inputSchema;
      assert.ok(readSchema?.properties?.paths, 'raw MCP discovery must expose relai_read paths');
      assert.ok(readSchema?.properties?.ranges, 'raw MCP discovery must expose relai_read ranges');
      const searchSchema = byName.get('relai_search')?.inputSchema;
      assert.ok(searchSchema?.properties?.queries, 'raw MCP discovery must expose batched relai_search queries');
      for (const [toolName, schema] of [['relai_read', readSchema], ['relai_search', searchSchema]]) {
        for (const keyword of ['oneOf', 'anyOf', 'allOf', 'if', 'then', 'else', 'not', 'propertyNames']) {
          assert.equal(schema?.[keyword], undefined, `${toolName} raw discovery must stay import-safe at the root (${keyword})`);
        }
      }
  
      client.call(3, 'relai_work', { action: 'begin', workspace: 'repo', bootstrap: 'none' });
      const work = structuredContentOf(await client.waitFor(3));
      assert.ok(work.work_id, 'raw MCP dispatch must create a repository work session');
  
      client.call(4, 'relai_read', { work_id: work.work_id, paths: ['release-manifest.json'] });
      const read = structuredContentOf(await client.waitFor(4));
      assert.equal(read.items?.[0]?.path, 'release-manifest.json', 'advertised relai_read paths must dispatch successfully');
  
      client.call(5, 'relai_search', {
        action: 'text', work_id: work.work_id,
        queries: ['TOOL_SURFACE_VERSION', 'manifestHash'], glob: 'src/**/*.js', maxFiles: 20
      });
      const search = structuredContentOf(await client.waitFor(5));
      assert.equal(search.ok, true, 'advertised batched relai_search queries must dispatch successfully');
  
      client.call(6, 'relai_search', { action: 'text', work_id: work.work_id, pattern: 'surface', query: 'sibling-field' });
      const malformed = await client.waitFor(6);
      assert.equal(malformed.result?.isError, true, 'runtime validation must surface malformed cross-action input as a tool error');
      assert.equal(malformed.result?.structuredContent?.ok, false);
      assert.match(malformed.result?.structuredContent?.error || '', /Invalid arguments for tool relai_search/);
      assert.match(malformed.result?.structuredContent?.error || '', /additional properties|oneOf/i);
  
      client.call(7, 'relai_search', { action: 'text', work_id: work.work_id, pattern: 'surface', maxFiles: 201 });
      const boundedFailure = await client.waitFor(7);
      assert.equal(boundedFailure.result?.isError, true, 'action-specific canonical validation must surface as a tool error');
      assert.match(boundedFailure.result?.structuredContent?.error || '', /relai_search action 'text'/, 'public errors must identify the callable public tool/action');
      assert.doesNotMatch(boundedFailure.result?.structuredContent?.error || '', /search\.text/, 'public errors must not leak internal operation IDs');
    } finally {
      await client.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
  
  console.log(`The unified ${activeToolCount}-tool MCP surface is always discovered; stale profile fields have no effect.`);
}
await case_tool_surface_discovery_unit();
