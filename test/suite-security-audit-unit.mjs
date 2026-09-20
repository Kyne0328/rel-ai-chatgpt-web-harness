// Consolidated security audit coverage.
// Pure and self-contained checks share one process; tests requiring process/global isolation remain standalone.
// Add related regression checks here instead of creating another one-off test file.

// Formerly audit-production-unit.mjs
async function case_audit_production_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../scripts/audit-production.mjs");
    const { isTransientAuditFailure } = __m1;
  
  assert.equal(isTransientAuditFailure({ stderr: 'npm warn audit network timeout at: https://registry.npmjs.org/-/npm/v1/security/advisories/bulk' }), true);
  assert.equal(isTransientAuditFailure({ stderr: 'npm error code ETIMEDOUT' }), true);
  assert.equal(isTransientAuditFailure({ stderr: '503 Service Unavailable' }), true);
  assert.equal(isTransientAuditFailure({ stdout: '# npm audit report\n1 high severity vulnerability' }), false);
  assert.equal(isTransientAuditFailure({ stdout: '# npm audit report\nmoderate vulnerability found' }), false);
  
  console.log('Production audit distinguishes advisory-service outages from vulnerability findings.');
}
await case_audit_production_unit();

// Formerly audit-task-history-unit.mjs
async function case_audit_task_history_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/audit.js");
    const { readAudit } = __m4;
  
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-audit-task-'));
  const auditLogPath = path.join(dir, 'audit.jsonl');
  const taskId = 'long-task';
  const lines = [];
  for (let index = 0; index < 1500; index += 1) {
    lines.push(JSON.stringify({ ts: new Date().toISOString(), taskId, tool: `tool-${index}`, ok: true }));
  }
  fs.writeFileSync(auditLogPath, `${lines.join('\n')}\n`);
  const result = readAudit({ auditLogPath }, { limit: 10000, taskId });
  assert.equal(result.entries.length, 1500, 'task-scoped reads must not truncate at 1000 events');
  fs.rmSync(dir, { recursive: true, force: true });
  
  console.log('Task-scoped audit history tests passed.');
}
await case_audit_task_history_unit();

// Formerly content-aware-sensitive-policy-unit.mjs
async function case_content_aware_sensitive_policy_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/safety.js");
    const { resolveSafePath, writeTextFileSafe, evaluateSensitiveContent } = __m4;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-content-policy-'));
  try {
    fs.writeFileSync(path.join(root, '.npmrc'), 'registry=https://registry.npmjs.org/\nengine-strict=true\n');
    assert.doesNotThrow(() => resolveSafePath(root, '.npmrc', { operation: 'read' }));
    writeTextFileSafe(root, '.npmrc', 'registry=https://registry.npmjs.org/\nfund=false\n');
    assert.equal(evaluateSensitiveContent('.npmrc', null, '//registry.npmjs.org/:_authToken=top-secret\n').allowed, false);
    assert.throws(
      () => writeTextFileSafe(root, '.npmrc', '//registry.npmjs.org/:_authToken=top-secret\n'),
      /blocked sensitive path/
    );
  
    fs.writeFileSync(path.join(root, '.pypirc'), '[distutils]\nindex-servers = pypi\n[pypi]\nrepository = https://upload.pypi.org/legacy/\n');
    assert.doesNotThrow(() => resolveSafePath(root, '.pypirc', { operation: 'read' }));
    assert.throws(
      () => writeTextFileSafe(root, '.pypirc', '[pypi]\nusername=user\npassword=secret\n'),
      /blocked sensitive path/
    );
  
    const certificate = '-----BEGIN CERTIFICATE-----\nPUBLICDATA\n-----END CERTIFICATE-----\n';
    fs.writeFileSync(path.join(root, 'server.pem'), certificate);
    assert.doesNotThrow(() => resolveSafePath(root, 'server.pem', { operation: 'read' }));
    writeTextFileSafe(root, 'server.pem', certificate);
    assert.throws(
      () => writeTextFileSafe(root, 'server.pem', '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----\n'),
      /blocked sensitive path/
    );
  
    fs.mkdirSync(path.join(root, 'secrets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'secrets', 'README.md'), '# Secret management guidance\nUse the deployment portal.\n');
    assert.doesNotThrow(() => resolveSafePath(root, 'secrets/README.md', { operation: 'read' }));
    assert.throws(
      () => writeTextFileSafe(root, 'secrets/config.txt', 'API_KEY=actual-secret\n'),
      /blocked sensitive path/
    );
  
    assert.equal(evaluateSensitiveContent('.netrc', null, 'machine example.com login user password pass').allowed, false);
    assert.equal(evaluateSensitiveContent('public.pem', null, certificate).allowed, true);
    console.log('Content-aware sensitive policy permits public forms and blocks credential material.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
await case_content_aware_sensitive_policy_unit();

// Formerly ipc-security-unit.mjs
async function case_ipc_security_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../electron/ipc-handlers.js");
    const { MAX_CLIPBOARD_TEXT_BYTES, registerIpcHandlers } = __m1;
  
    const __m2 = await import("../electron/ipc-security.js");
    const { createContractIpcRegistrar, createWindowGuards } = __m2;
  
  const handles = new Map();
  const listeners = new Map();
  const wizard = { id: 'wizard' };
  const fallback = { id: 'fallback' };
  const dashboard = { id: 'dashboard' };
  const pulse = { id: 'pulse' };
  const other = { id: 'other' };
  const calls = [];
  let clipboardText = '';
  let stopCalls = 0;
  let restartCalls = 0;
  let relaunchCalls = 0;
  let quitCalls = 0;
  
  const deps = {
    ipcMain: { handle: (channel, handler) => handles.set(channel, handler), on: (channel, handler) => listeners.set(channel, handler) },
    BrowserWindow: { fromWebContents: sender => sender?.window || null },
    clipboard: { writeText: value => { clipboardText = value; } },
    getWizardWindow: () => wizard,
    closeWizard: options => calls.push(['closeWizard', options]),
    getFallbackWindow: () => fallback,
    getDashboardWindow: () => dashboard,
    getPulseWindow: () => pulse,
    setPulseExpanded: expanded => { calls.push(['pulseExpanded', expanded]); return expanded; },
    getRecoveryConfig: () => ({ ok: true }),
    openRecoverySetup: () => ({ ok: true }),
    startServer: () => ({ ok: true, started: true }),
    stopServer: () => { stopCalls += 1; return { ok: true }; },
    launchConfiguredDesktop: async options => { calls.push(['launch', options]); return { serverRunning: true }; },
    restartConnection: async () => { restartCalls += 1; return { serverRunning: true, tunnelStatus: 'running' }; },
    relaunchApplication: async () => { relaunchCalls += 1; return { ok: true }; },
    quitApplication: async () => { quitCalls += 1; return { ok: true }; },
    openSettingsWindow: () => ({ ok: true }),
    openDashboardWindow: routeHash => { calls.push(['openDashboard', routeHash || '']); return { ok: true }; },
    getDesktopSettings: () => ({ ok: true }),
    saveDesktopSettings: settings => ({ ok: true, settings }),
    getLocalUsage: month => ({ ok: true, month }),
    getUpdateStatus: () => ({ state: 'idle' }), checkForUpdates: () => ({ ok: true }), downloadUpdate: () => ({ ok: true }), installUpdate: () => ({ ok: true }),
    getLifecycleStatus: () => ({ ok: true }), acknowledgeConnectorRefresh: () => ({ ok: true }), setLaunchAtLogin: enabled => enabled,
    getCurrentStatus: () => ({ serverRunning: true }),
    getDashboardWindowState: () => ({ platform: 'win32', customTitleBar: true }),
    minimizeDashboardWindow: () => ({ minimized: true }), toggleDashboardMaximize: () => ({ maximized: true }), requestDashboardClose: () => ({ ok: true }),
    getNotificationsEnabled: () => true, setNotificationsEnabled: enabled => enabled,
    getNotificationPreferences: () => ({}), updateNotificationPreferences: patch => patch,
    exportDiagnosticState: report => ({ ok: true, report }), openDiagnosticsFolder: () => ({ ok: true }),
    getTaskCodeWorkspace: payload => ({ ok: true, payload }),
    readTaskCodeDiff: payload => ({ ok: true, payload }),
    listCodeEditors: () => ({ ok: true, editors: [] }),
    openTaskCodeIde: payload => ({ ok: true, payload }),
    fitWindowToContent: (window, options) => calls.push(['fit', window.id, options]),
    saveLauncherConfig: config => calls.push(['save', config]),
    setTunnelApiKey: key => calls.push(['tunnelKey', key])
  };
  registerIpcHandlers(deps);
  const eventFor = window => ({ sender: { window } });
  
  assert.ok(Number.isSafeInteger(MAX_CLIPBOARD_TEXT_BYTES) && MAX_CLIPBOARD_TEXT_BYTES > 0, 'clipboard input must remain bounded');
  const guards = createWindowGuards(deps.BrowserWindow);
  assert.equal(guards.windowOnly(eventFor(dashboard), () => dashboard, 'Dashboard', () => 'allowed'), 'allowed');
  assert.throws(() => guards.windowOnly(eventFor(other), () => dashboard, 'Dashboard', () => 'denied'), /not available/);
  const registrar = createContractIpcRegistrar({
    ipcMain: { handle() {}, on() {} },
    BrowserWindow: deps.BrowserWindow,
    contract: {
      'test:handle': { mode: 'handle', windows: ['dashboard'], failure: 'reject' },
      'test:on': { mode: 'on', windows: ['dashboard'], failure: 'ignore' }
    },
    windowGetters: { dashboard: () => dashboard }
  });
  assert.throws(() => registrar.on('test:handle', 'Test', () => {}), /must register with ipcMain\.handle/);
  assert.throws(() => registrar.handle('missing:channel', 'Test', () => {}), /missing from the input contract/);
  assert.equal([...handles.keys()].some(channel => channel.startsWith('desktop:cloud:')), false);
  assert.equal([...handles.keys()].some(channel => /ngrok|gateway|approval/i.test(channel)), false);
  assert.throws(() => handles.get('desktop:settings:get')(eventFor(other)), /not available/);
  assert.throws(() => handles.get('url:open-dashboard')(eventFor(other), '#tasks'), /not available/);
  assert.deepEqual(handles.get('url:open-dashboard')(eventFor(pulse), '#tasks?workspace=repo&task=task-1'), { ok: true });
  assert.ok(calls.some(entry => entry[0] === 'openDashboard' && entry[1] === '#tasks?workspace=repo&task=task-1'), 'Pulse may deep-link only through the existing dashboard opener');
  assert.deepEqual(handles.get('pulse:set-expanded')(eventFor(pulse), true), { ok: true, expanded: true });
  assert.ok(calls.some(entry => entry[0] === 'pulseExpanded' && entry[1] === true), 'Pulse may request only its own display geometry');
  assert.throws(() => handles.get('pulse:set-expanded')(eventFor(dashboard), true), /not available/);
  assert.throws(() => handles.get('pulse:set-expanded')(eventFor(pulse), 'yes'), /must be a boolean/);
  assert.throws(() => handles.get('desktop:code:get')(eventFor(other), { taskId: 'task-1' }), /not available/);
  assert.deepEqual(handles.get('desktop:code:get')(eventFor(dashboard), { taskId: 'task-1' }), { ok: true, payload: { taskId: 'task-1' } });
  assert.equal(handles.has('desktop:code:write'), false, 'the Changes surface must not expose a renderer file-write channel');
  assert.equal(handles.has('desktop:code:read'), false, 'the Changes surface must use diff-only file access');
  assert.throws(() => handles.get('desktop:code:open-ide')(eventFor(dashboard), { taskId: 'task-1', editorId: 'x'.repeat(41) }), /editorId is too long/);
  assert.throws(() => handles.get('url:copy')(eventFor(dashboard), 'x'.repeat(MAX_CLIPBOARD_TEXT_BYTES + 1)));
  assert.deepEqual(handles.get('url:copy')(eventFor(wizard), 'safe\u0000text'), { ok: true });
  assert.equal(clipboardText, 'safetext');
  await handles.get('wizard:done')(eventFor(wizard), { port: 3333, tunnelId: 'tunnel_example123456', tunnelApiKey: 'sk-runtime-example-123456', restart: false });
  assert.ok(calls.some(entry => entry[0] === 'tunnelKey'));
  assert.ok(calls.some(entry => entry[0] === 'save'));
  assert.ok(calls.some(entry => entry[0] === 'launch' && entry[1].firstRun === true));
  assert.throws(() => handles.get('desktop:restart-connection')(eventFor(other)), /not available/);
  assert.throws(() => handles.get('recovery:restart-connection')(eventFor(other)), /not available/);
  assert.throws(() => handles.get('desktop:relaunch')(eventFor(other)), /not available/);
  assert.throws(() => handles.get('desktop:quit')(eventFor(other)), /not available/);
  assert.equal(restartCalls, 0, 'wizard startup must stay separate from the tunnel-only retry operation');
  assert.equal(relaunchCalls, 0);
  assert.equal(quitCalls, 0);
  await handles.get('desktop:restart-connection')(eventFor(dashboard));
  await handles.get('recovery:restart-connection')(eventFor(fallback));
  await handles.get('desktop:relaunch')(eventFor(dashboard));
  await handles.get('desktop:quit')(eventFor(dashboard));
  assert.equal(restartCalls, 2);
  assert.equal(relaunchCalls, 1);
  assert.equal(quitCalls, 1);
  listeners.get('desktop:stop-service')(eventFor(other));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopCalls, 0);
  listeners.get('desktop:stop-service')(eventFor(dashboard));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopCalls, 1);
  console.log('IPC secure tunnel boundary tests passed.');
}
await case_ipc_security_unit();

// Formerly operation-aware-sensitive-policy-unit.mjs
async function case_operation_aware_sensitive_policy_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/safety.js");
    const { resolveSafePath, assertPathOperationAllowed } = __m4;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-operation-policy-'));
  try {
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=hidden\n');
  
    for (const operation of ['read', 'write', 'replace', 'review', 'delete']) {
      assert.throws(
        () => resolveSafePath(root, '.env', { operation }),
        (error) => error?.code === 'SENSITIVE_PATH_RESTRICTED' && error?.operation === operation,
        `${operation} must remain denied for secret-bearing files`
      );
    }
  
    assert.throws(
      () => resolveSafePath(root, '.env', { operation: 'commit' }),
      (error) => error?.operation === 'commit',
      'commit must remain denied without explicit authorization'
    );
  
    const authorized = resolveSafePath(root, '.env', {
      operation: 'commit',
      allowSensitive: true
    });
    assert.equal(authorized.relativePath, '.env');
    assert.equal(fs.readFileSync(authorized.absolutePath, 'utf8'), 'TOKEN=hidden\n');
  
    assert.throws(
      () => assertPathOperationAllowed('.env', 'write', { allowSensitive: true }),
      /blocked sensitive path/,
      'authorization must be operation-specific rather than a generic bypass'
    );
  
    assert.doesNotThrow(() => resolveSafePath(root, '.env.example', { operation: 'write' }));
    console.log('Operation-aware sensitive-path policy passed.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
await case_operation_aware_sensitive_policy_unit();

// Formerly redacted-sensitive-review-unit.mjs
async function case_redacted_sensitive_review_unit() {
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
  
    const __m5 = await import("../src/bridge/review.js");
    const { relaiDiff } = __m5;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-redacted-review-'));
  const git = (args) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const workspace = { alias: 'repo', path: root };
  const config = { stateDir: path.join(root, '.state') };
  const removeRoot = () => {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) {
      if (process.platform !== 'win32' || !['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) throw error;
    }
  };
  try {
    git(['init']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Rel AI Test']);
    fs.writeFileSync(path.join(root, '.env'), 'API_KEY=old-secret\nPORT=3000\nREMOVE_ME=gone\n');
    fs.writeFileSync(path.join(root, 'app.js'), 'console.log("old");\n');
    git(['add', '-f', '.env', 'app.js']);
    git(['commit', '-m', 'base']);
  
    fs.writeFileSync(path.join(root, '.env'), 'API_KEY=new-secret\nPORT=3000\nADDED=value\ninvalid line\n');
    fs.writeFileSync(path.join(root, 'app.js'), 'console.log("new");\n');
  
    await assert.rejects(() => relaiDiff(workspace, config, { path: '.env' }), /redactSensitive:true|blocked sensitive path/);
  
    const review = await relaiDiff(workspace, config, { redactSensitive: true });
    assert.match(review.diff, /console\.log\("new"\)/);
    assert.doesNotMatch(review.diff, /old-secret|new-secret|API_KEY|REMOVE_ME|ADDED/);
    assert.equal(review.sensitiveValuesReturned, false);
    const env = review.sensitiveReview.find((item) => item.path === '.env');
    assert.deepEqual(env.addedKeys, ['ADDED']);
    assert.deepEqual(env.removedKeys, ['REMOVE_ME']);
    assert.deepEqual(env.changedKeys, ['API_KEY']);
    assert.deepEqual(env.malformedLinesAfter, [4]);
    assert.doesNotMatch(JSON.stringify(review), /old-secret|new-secret|=value|=3000/);
  
    git(['add', '-f', '.env']);
    const staged = await relaiDiff(workspace, config, { staged: true, path: '.env', redactSensitive: true });
    assert.equal(staged.diff, '');
    assert.deepEqual(staged.sensitiveReview[0].changedKeys, ['API_KEY']);
    assert.doesNotMatch(JSON.stringify(staged), /old-secret|new-secret/);
  
    console.log('Redacted sensitive review passed without value disclosure.');
  } finally {
    removeRoot();
  }
}
await case_redacted_sensitive_review_unit();

// Formerly sensitive-classification-unit.mjs
async function case_sensitive_classification_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/safety.js");
    const { classifySensitivePath, isSecretPath } = __m1;
  
  assert.deepEqual(classifySensitivePath('known_hosts'), {
    sensitive: false,
    classification: 'ordinary_repository_file',
    reason: 'no sensitive path rule matched'
  });
  assert.equal(isSecretPath('known_hosts'), false);
  
  assert.equal(classifySensitivePath('.env').classification, 'environment_secret');
  assert.equal(classifySensitivePath('.npmrc').classification, 'authentication_config');
  assert.equal(classifySensitivePath('.ssh/id_ed25519').classification, 'private_key');
  assert.equal(classifySensitivePath('service-account-prod.json').classification, 'service_account_credentials');
  assert.equal(classifySensitivePath('bundle.p12').classification, 'key_or_certificate_bundle');
  assert.equal(classifySensitivePath('.aws/credentials').classification, 'credential_store');
  assert.equal(classifySensitivePath('credentials/example.json').classification, 'secret_named_location');
  assert.equal(classifySensitivePath('secret.notes').classification, 'secret_named_file');
  
  console.log('Sensitive path classifications are explicit and known_hosts remains accessible.');
}
await case_sensitive_classification_unit();
