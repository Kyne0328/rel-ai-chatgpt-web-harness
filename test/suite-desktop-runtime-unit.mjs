// Consolidated desktop runtime coverage.
// Pure and self-contained checks share one process; tests requiring process/global isolation remain standalone.
// Add related regression checks here instead of creating another one-off test file.

// Formerly desktop-lifecycle-unit.mjs
async function case_desktop_lifecycle_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../electron/desktop-lifecycle.js");
    const { createDesktopLifecycleManager, detectStartupSupport } = __m4;
  
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-lifecycle-'));
  let loginEnabled = false;
  let loginSettings = null;
  let loginReadSettings = null;
  let clock = 0;
  const logs = [];
  const app = {
    isPackaged: true,
    getVersion: () => '0.21.0',
    getPath: () => stateDir,
    getLoginItemSettings: settings => {
      loginReadSettings = settings ? { ...settings, args: [...(settings.args || [])] } : settings;
      return { openAtLogin: loginEnabled };
    },
    setLoginItemSettings: settings => {
      loginSettings = { ...settings };
      loginEnabled = settings.openAtLogin === true;
    }
  };
  const now = () => new Date(Date.parse('2026-07-25T06:00:00.000Z') + (clock++ * 1000)).toISOString();
  
  assert.equal(detectStartupSupport({ app, platform: 'win32', env: {} }).supported, true);
  assert.match(detectStartupSupport({ app: { ...app, isPackaged: false }, platform: 'win32', env: {} }).reason, /installed Windows app/);
  assert.match(detectStartupSupport({ app, platform: 'win32', env: { PORTABLE_EXECUTABLE_DIR: 'C:\\RelAI' } }).reason, /Portable builds/);
  
  const first = createDesktopLifecycleManager({ app, platform: 'win32', env: {}, now, connectorRevision: 'surface-a', onLog: (message, options) => logs.push({ message, options }) });
  const firstStatus = await first.start();
  assert.equal(firstStatus.firstLaunch, true);
  assert.equal(firstStatus.updated, false);
  assert.equal(firstStatus.connectorRefreshRequired, false);
  assert.equal(firstStatus.connectorRevision, 'surface-a');
  assert.equal(firstStatus.recoveredAfterUncleanShutdown, false);
  assert.equal(firstStatus.launchCount, 1);
  assert.equal(firstStatus.launchAtLogin.supported, true);
  assert.equal(firstStatus.launchAtLogin.enabled, false);
  assert.equal(firstStatus.keepAwake, false);
  assert.equal(firstStatus.keepRunningOnClose, true, 'closing the dashboard must keep tray mode by default');
  assert.equal(firstStatus.pulseEnabled, true, 'ambient Pulse status must be enabled by default');
  assert.equal(firstStatus.themePreference, 'system', 'Pulse follows system appearance until the dashboard theme is explicitly selected');
  assert.equal(firstStatus.autoDownloadUpdates, true, 'verified update downloads must be automatic by default');
  assert.equal(firstStatus.updateChannel, 'stable', 'stable releases must remain the default update channel');
  assert.equal(firstStatus.reducedBackgroundWork, false, 'normal background preparation must remain the default');
  assert.equal(first.setLaunchAtLogin(true).ok, true);
  assert.equal(first.getStatus().launchAtLogin.enabled, true);
  assert.deepEqual(loginReadSettings, { path: process.execPath, args: ['--background'] }, 'login-item readback must identify the same executable and background args used during registration');
  assert.deepEqual(loginSettings, {
    openAtLogin: true,
    openAsHidden: true,
    path: process.execPath,
    args: ['--background']
  });
  assert.equal((await first.setKeepAwake(true)).status.keepAwake, true);
  const preferenceUpdate = await first.setPreferences({
    keepRunningOnClose: false,
    pulseEnabled: false,
    themePreference: 'dark',
    autoDownloadUpdates: false,
    updateChannel: 'beta',
    reducedBackgroundWork: true
  });
  assert.equal(preferenceUpdate.ok, true);
  assert.equal(preferenceUpdate.status.keepRunningOnClose, false);
  assert.equal(preferenceUpdate.status.pulseEnabled, false);
  assert.equal(preferenceUpdate.status.themePreference, 'dark');
  assert.equal(preferenceUpdate.status.autoDownloadUpdates, false);
  assert.equal(preferenceUpdate.status.updateChannel, 'beta');
  assert.equal(preferenceUpdate.status.reducedBackgroundWork, true);
  assert.equal((await first.setPreferences({ autoDownloadUpdates: 'yes' })).ok, false, 'app preferences must reject non-boolean values');
  assert.equal((await first.setPreferences({ themePreference: 'sepia' })).ok, false, 'app preferences must reject unknown themes');
  assert.equal((await first.setPreferences({ updateChannel: 'nightly' })).ok, false, 'app preferences must reject unknown update channels');
  const cleanStatus = await first.markCleanShutdown();
  assert.equal((await first.markCleanShutdown()).lastCleanExitAt, cleanStatus.lastCleanExitAt);
  
  const second = createDesktopLifecycleManager({ app, platform: 'win32', env: {}, now, connectorRevision: 'surface-a', onLog: (message, options) => logs.push({ message, options }) });
  const secondStatus = await second.start();
  assert.equal(secondStatus.firstLaunch, false);
  assert.equal(secondStatus.updated, false);
  assert.equal(secondStatus.connectorRefreshRequired, false);
  assert.equal(secondStatus.recoveredAfterUncleanShutdown, false);
  assert.equal(secondStatus.launchCount, 2);
  assert.equal(secondStatus.keepAwake, true, 'keep-awake preference must persist across desktop restarts');
  assert.equal(secondStatus.keepRunningOnClose, false, 'close behavior must persist across desktop restarts');
  assert.equal(secondStatus.pulseEnabled, false, 'Pulse preference must persist across desktop restarts');
  assert.equal(secondStatus.themePreference, 'dark', 'Pulse theme preference must persist across desktop restarts');
  assert.equal(secondStatus.autoDownloadUpdates, false, 'automatic download preference must persist across desktop restarts');
  assert.equal(secondStatus.updateChannel, 'beta', 'update channel preference must persist across desktop restarts');
  assert.equal(secondStatus.reducedBackgroundWork, true, 'reduced background work must persist across desktop restarts');
  assert.equal((await second.setKeepAwake(false)).status.keepAwake, false);
  await second.markCleanShutdown();
  
  const statePath = path.join(stateDir, 'desktop-lifecycle.json');
  const preDurableState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  delete preDurableState.pendingConnectorRefreshRevision;
  fs.writeFileSync(statePath, `${JSON.stringify(preDurableState, null, 2)}\n`);
  const migrated = createDesktopLifecycleManager({ app, platform: 'win32', env: {}, now, connectorRevision: 'surface-a', onLog: (message, options) => logs.push({ message, options }) });
  assert.equal((await migrated.start()).connectorRefreshRequired, true, 'existing lifecycle state from before durable refresh tracking must recover a potentially missed notice');
  assert.equal((await migrated.acknowledgeConnectorRefresh()).ok, true);
  await migrated.markCleanShutdown();
  
  const previousState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const { connectorRevision: _legacyConnectorRevision, ...legacyState } = previousState;
  fs.writeFileSync(statePath, `${JSON.stringify({ ...legacyState, version: '0.20.7', running: true }, null, 2)}\n`);
  const updated = createDesktopLifecycleManager({ app, platform: 'win32', env: {}, now, connectorRevision: 'surface-b', onLog: (message, options) => logs.push({ message, options }) });
  const updatedStatus = await updated.start();
  assert.equal(updatedStatus.updated, true);
  assert.equal(updatedStatus.previousVersion, '0.20.7');
  assert.equal(updatedStatus.connectorRefreshRequired, true, 'the first upgrade from lifecycle state without a connector revision must request a refresh');
  assert.equal(updatedStatus.recoveredAfterUncleanShutdown, false, 'a version-changing updater restart must not be reported as an unexpected crash');
  await updated.markCleanShutdown();
  
  const changedSurface = createDesktopLifecycleManager({ app, platform: 'win32', env: {}, now, connectorRevision: 'surface-c', onLog: (message, options) => logs.push({ message, options }) });
  const changedSurfaceStatus = await changedSurface.start();
  assert.equal(changedSurfaceStatus.updated, false);
  assert.equal(changedSurfaceStatus.connectorRefreshRequired, true, 'a changed connector revision must request refresh even without an app-version change');
  assert.equal(changedSurfaceStatus.pendingConnectorRefreshRevision, 'surface-c');
  await changedSurface.markCleanShutdown();
  
  const interruptedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  fs.writeFileSync(statePath, `${JSON.stringify({ ...interruptedState, running: true }, null, 2)}\n`);
  const recovered = createDesktopLifecycleManager({ app, platform: 'win32', env: {}, now, connectorRevision: 'surface-c', onLog: (message, options) => logs.push({ message, options }) });
  assert.equal((await recovered.start()).recoveredAfterUncleanShutdown, true);
  assert.equal(recovered.getStatus().connectorRefreshRequired, true, 'an unacknowledged connector refresh must survive a restart');
  assert.equal((await recovered.acknowledgeConnectorRefresh()).ok, true);
  assert.equal(recovered.getStatus().connectorRefreshRequired, false, 'acknowledging the notice must clear the durable refresh requirement');
  assert.ok(logs.some(entry => entry.options.code === 'unclean_shutdown_detected'));
  await recovered.markCleanShutdown();
  
  const acknowledgedRestart = createDesktopLifecycleManager({ app, platform: 'win32', env: {}, now, connectorRevision: 'surface-c', onLog: (message, options) => logs.push({ message, options }) });
  assert.equal((await acknowledgedRestart.start()).connectorRefreshRequired, false, 'an acknowledged connector revision must stay cleared on the next launch');
  await acknowledgedRestart.markCleanShutdown();
  
  const background = createDesktopLifecycleManager({ app, platform: 'win32', env: {}, argv: ['RelAI.exe', '--background'], now, connectorRevision: 'surface-d' });
  const backgroundStatus = await background.start();
  assert.equal(backgroundStatus.openedAtLogin, true);
  assert.equal(backgroundStatus.connectorRefreshRequired, true, 'a connector change detected during a background launch must remain pending');
  await background.markCleanShutdown();
  
  const afterBackground = createDesktopLifecycleManager({ app, platform: 'win32', env: {}, now, connectorRevision: 'surface-d' });
  assert.equal((await afterBackground.start()).connectorRefreshRequired, true, 'background startup must not consume the connector refresh notice');
  assert.equal((await afterBackground.acknowledgeConnectorRefresh()).ok, true);
  await afterBackground.markCleanShutdown();
  
  const portable = createDesktopLifecycleManager({ app, platform: 'win32', env: { PORTABLE_EXECUTABLE_FILE: 'RelAI.exe' }, now, connectorRevision: 'surface-b' });
  assert.equal((await portable.start()).launchAtLogin.supported, false);
  assert.equal(portable.setLaunchAtLogin(true).errorCode, 'startup_setting_not_supported');
  
  fs.rmSync(stateDir, { recursive: true, force: true });
  console.log('Desktop lifecycle unit tests passed.');
}
await case_desktop_lifecycle_unit();

// Formerly desktop-local-data-unit.mjs
async function case_desktop_local_data_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../electron/desktop-local-data.js");
    const { createDesktopLocalDataManager } = __m4;
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-local-data-'));
  const stateDir = path.join(root, 'state');
  const connectionStateDir = path.join(root, 'connection-state');
  const userDataDir = path.join(root, 'electron-user-data');
  const projectDir = path.join(root, 'project');
  const logPath = path.join(root, 'service.log');
  const auditPath = path.join(stateDir, 'audit.jsonl');
  let activeTaskCount = 0;
  let openedPath = '';
  
  function write(relative, bytes) {
    const target = path.join(stateDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'x'.repeat(bytes));
  }
  
  try {
    write('sessions/task.json', 11);
    write('audit.jsonl', 13);
    write('audit.jsonl.1', 17);
    write('output-spills/task/output.log', 19);
    write('repository-intelligence/repo/graph.db', 23);
    write('browser/profiles/principal/default/profile-state.bin', 7);
    const persistentBrowserProfileFile = path.join(stateDir, 'browser', 'profiles', 'principal', 'default', 'profile-state.bin');
    fs.writeFileSync(logPath, 'x'.repeat(29));
    fs.mkdirSync(connectionStateDir, { recursive: true });
    fs.writeFileSync(path.join(connectionStateDir, 'connection.json'), '{}');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'desktop-lifecycle.json'), '{}');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'keep.txt'), 'project data');
  
    const manager = createDesktopLocalDataManager({
      getAdditionalDataRoots: () => [connectionStateDir],
      getConfig: () => ({ stateDir, auditLogPath: auditPath, workspaces: { app: { path: projectDir } } }),
      getServiceLogPath: () => logPath,
      getTaskActivity: () => ({ activeTaskCount }),
      getUserDataPath: () => userDataDir,
      openPath: async target => { openedPath = target; return ''; }
    });
  
    const usage = await manager.getUsage();
    assert.equal(usage.ok, true);
    assert.equal(usage.categories.history.bytes, 41);
    assert.equal(usage.categories.logs.bytes, 29);
    assert.equal(usage.categories.temporary.bytes, 19);
    assert.equal(usage.categories.indexes.bytes, 23);
    assert.equal(usage.categories.other.bytes, 11, 'uncategorized Rel.AI-owned state must still be included in local storage usage');
    assert.equal(usage.totalBytes, 123, 'local storage total must include every Rel.AI-owned data root, not only managed history and caches');
  
    activeTaskCount = 1;
    const blocked = await manager.clearTemporary();
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /task is still active/i);
    assert.equal(fs.existsSync(path.join(stateDir, 'output-spills')), true);
  
    activeTaskCount = 0;
    const cleared = await manager.clearTemporary();
    assert.equal(cleared.ok, true);
    assert.equal(cleared.categories.temporary.bytes, 0);
    assert.equal(fs.existsSync(path.join(stateDir, 'output-spills')), false);
  
    assert.equal((await manager.openDataFolder()).ok, true);
    assert.equal(openedPath, path.resolve(stateDir));
  
    const plan = manager.prepareClearAll();
    assert.equal(plan.ok, true);
    assert.deepEqual(new Set(plan.roots), new Set([path.resolve(stateDir), path.resolve(connectionStateDir), path.resolve(userDataDir), path.resolve(logPath)]));
    const allCleared = await manager.clearAll(plan);
    assert.equal(allCleared.ok, true);
    assert.equal(fs.existsSync(stateDir), false);
    assert.equal(fs.existsSync(connectionStateDir), false);
    assert.equal(fs.existsSync(userDataDir), false);
    assert.equal(fs.existsSync(logPath), false, 'clear all data must remove an external Rel.AI service log included in the reported total');
    assert.equal(fs.existsSync(persistentBrowserProfileFile), false, 'clear all data must remove persistent local browser profile state');
    assert.equal(fs.readFileSync(path.join(projectDir, 'keep.txt'), 'utf8'), 'project data');
  
    const unsafe = createDesktopLocalDataManager({
      getConfig: () => ({ stateDir: root, workspaces: { app: { path: projectDir } } }),
      getTaskActivity: () => ({ activeTaskCount: 0 }),
      getUserDataPath: () => path.join(root, 'other-user-data')
    });
    assert.throws(() => unsafe.prepareClearAll(), /contains project files/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  
  console.log('Desktop local data controls unit tests passed.');
}
await case_desktop_local_data_unit();

// Formerly desktop-manager-unit.mjs
async function case_desktop_manager_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../src/desktopManager.ts");
    const { configureDesktopNativeBridge,
    runDesktopAction } = __m4;
    const { MAX_DESKTOP_CLIPBOARD_BYTES } = await import("../src/contracts/desktopValidation.js");
  
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-desktop-manager-'));
  const outside = path.join(path.dirname(root), `outside-${path.basename(root)}.txt`);
  const proposal = path.join(root, 'proposal.docx');
  const secret = path.join(root, '.env');
  fs.writeFileSync(proposal, 'proposal');
  fs.writeFileSync(secret, 'API_KEY=secret-value');
  fs.writeFileSync(outside, 'outside');
  
  const workspace = { alias: 'fixture', path: root };
  const enabledConfig = { computerControl: { enabled: true } };
  const calls = [];
  let clipboardReadText = 'clipboard value';
  configureDesktopNativeBridge(async payload => {
    calls.push(payload);
    if (payload.action === 'clipboard_read') return { ok: true, platform: 'win32', text: clipboardReadText };
    if (payload.action === 'launch_application' && payload.application === 'missing-app') {
      throw new Error("Application 'missing-app' could not be launched.");
    }
    return { ok: true, platform: 'win32' };
  });
  
  try {
    const callsBeforeDisabled = calls.length;
    await assert.rejects(
      () => runDesktopAction(workspace, {}, { action: 'clipboard_read' }),
      error => error?.code === 'COMPUTER_CONTROL_DISABLED'
    );
    assert.equal(calls.length, callsBeforeDisabled, 'disabled Computer Control must block structured desktop access before the native bridge');
  
    const opened = await runDesktopAction(workspace, enabledConfig, { action: 'open_path', path: 'proposal.docx' });
    assert.deepEqual(opened, {
      ok: true,
      workspace: 'fixture',
      action: 'open_path',
      platform: 'win32',
      path: 'proposal.docx',
      kind: 'file'
    });
    assert.equal(calls.at(-1).path, proposal);
  
    const revealed = await runDesktopAction(workspace, enabledConfig, { action: 'reveal_path', path: 'proposal.docx' });
    assert.equal(revealed.path, 'proposal.docx');
    assert.equal(calls.at(-1).action, 'reveal_path');
  
    await assert.rejects(
      () => runDesktopAction(workspace, enabledConfig, { action: 'open_path', path: `../${path.basename(outside)}` }),
      /traversal|escapes workspace/i
    );
    await assert.rejects(
      () => runDesktopAction(workspace, enabledConfig, { action: 'open_path', path: '.env' }),
      /blocked sensitive path/i
    );
    await assert.rejects(
      () => runDesktopAction(workspace, enabledConfig, { action: 'open_path', path: 'missing.docx' }),
      /does not exist/i
    );
  
    const uri = await runDesktopAction(workspace, enabledConfig, { action: 'open_uri', uri: 'https://example.com/docs' });
    assert.equal(uri.uri, 'https://example.com/docs');
    assert.deepEqual(calls.at(-1), { action: 'open_uri', uri: 'https://example.com/docs' });
    await assert.rejects(
      () => runDesktopAction(workspace, enabledConfig, { action: 'open_uri', uri: 'not a uri' }),
      /absolute valid URI/i
    );
    await assert.rejects(
      () => runDesktopAction(workspace, enabledConfig, { action: 'open_uri', uri: 'file:///tmp/secret.txt' }),
      /protocol is not allowed/i
    );
  
    const launched = await runDesktopAction(workspace, enabledConfig, { action: 'launch_application', application: 'notepad.exe' });
    assert.equal(launched.application, 'notepad.exe');
    assert.deepEqual(calls.at(-1), { action: 'launch_application', application: 'notepad.exe' });
    await assert.rejects(
      () => runDesktopAction(workspace, enabledConfig, { action: 'launch_application', application: '../notepad.exe' }),
      /not a path or command/i
    );
    await assert.rejects(
      () => runDesktopAction(workspace, enabledConfig, { action: 'launch_application', application: 'missing-app' }),
      /could not be launched/i
    );
  
    const read = await runDesktopAction(workspace, enabledConfig, { action: 'clipboard_read' });
    assert.equal(read.text, 'clipboard value');
    assert.equal(read.textLength, 'clipboard value'.length);
  
    const written = await runDesktopAction(workspace, enabledConfig, { action: 'clipboard_write', text: 'a\u0000b' });
    assert.equal(written.textLength, 2);
    assert.deepEqual(calls.at(-1), { action: 'clipboard_write', text: 'ab' });
    await assert.rejects(
      () => runDesktopAction(workspace, enabledConfig, { action: 'clipboard_write', text: 'x'.repeat(MAX_DESKTOP_CLIPBOARD_BYTES + 1) }),
      /64 KiB/i
    );
    clipboardReadText = 'x'.repeat(MAX_DESKTOP_CLIPBOARD_BYTES + 1);
    await assert.rejects(() => runDesktopAction(workspace, enabledConfig, { action: 'clipboard_read' }), /64 KiB/i);
    clipboardReadText = 'clipboard value';
  
    const controller = new AbortController();
    controller.abort();
    const callsBeforeCancellation = calls.length;
    await assert.rejects(
      () => runDesktopAction(workspace, enabledConfig, { action: 'clipboard_read' }, { signal: controller.signal }),
      error => error?.name === 'AbortError'
    );
    assert.equal(calls.length, callsBeforeCancellation, 'pre-cancelled structured actions must not reach the native bridge');
  
    let markBridgeStarted;
    let releaseBridge;
    const bridgeStarted = new Promise(resolve => { markBridgeStarted = resolve; });
    const bridgeRelease = new Promise(resolve => { releaseBridge = resolve; });
    configureDesktopNativeBridge(async payload => {
      calls.push(payload);
      markBridgeStarted();
      await bridgeRelease;
      return { ok: true, platform: 'win32' };
    });
    const midflightController = new AbortController();
    const dispatched = runDesktopAction(
      workspace,
      enabledConfig,
      { action: 'open_uri', uri: 'https://example.com/dispatched' },
      { signal: midflightController.signal }
    );
    await bridgeStarted;
    midflightController.abort();
    releaseBridge();
    const dispatchedResult = await dispatched;
    assert.equal(dispatchedResult.uri, 'https://example.com/dispatched');
    assert.deepEqual(calls.at(-1), { action: 'open_uri', uri: 'https://example.com/dispatched' },
      'a native side effect already dispatched before cancellation must report its completed result');
  
    configureDesktopNativeBridge(null);
    await assert.rejects(
      () => runDesktopAction(workspace, enabledConfig, { action: 'clipboard_read' }),
      /desktop launcher/i
    );
  } finally {
    configureDesktopNativeBridge(null);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
  
  console.log('Structured desktop manager preserves Computer Control permission and enforces workspace paths, bounded clipboard data, URI/app validation, native routing, and cancellation.');
}
await case_desktop_manager_unit();

// Formerly desktop-updates-policy-unit.mjs
async function case_desktop_updates_policy_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/ui/features/settings/desktop-update-policy.js");
    const { supportPolicyView } = __m1;
  
    const __m2 = await import("../src/ui/features/settings/react.js");
    const { normalizeReleaseNoteText, updateView } = __m2;
  
  assert.equal(supportPolicyView({ state: 'current', currentVersion: '0.25.0', minimumSupportedVersion: '0.25.0' }).label, 'Supported');
  assert.equal(supportPolicyView({ state: 'required', currentVersion: '0.24.9', minimumSupportedVersion: '0.25.0' }).tone, 'bad');
  assert.match(supportPolicyView({ state: 'required', currentVersion: '0.24.9', minimumSupportedVersion: '0.25.0' }).description, /v0\.25\.0/);
  assert.match(supportPolicyView({ state: 'deprecated', currentVersion: '0.24.9', minimumSupportedVersion: '0.25.0', enforceAfter: '2026-09-01T00:00:00.000Z' }).description, /2026|September|Sep/);
  assert.match(supportPolicyView({ state: 'unavailable' }).description, /keep using the app/i);
  
  const available = updateView({ state: 'available', availableVersion: '0.25.3', currentVersion: '0.25.2' }, false);
  assert.equal(available.label, 'Update available');
  assert.equal(available.action.id, 'download');
  assert.match(available.action.label, /0\.25\.3/);
  
  const autoDownload = updateView({ state: 'available', availableVersion: '0.25.3' }, true);
  assert.match(autoDownload.description, /download it automatically/i);
  
  const downloaded = updateView({ state: 'downloaded', availableVersion: '0.25.3', installMode: 'open_dmg' }, false);
  assert.equal(downloaded.action.id, 'install');
  assert.equal(downloaded.action.label, 'Open DMG and close Rel.AI');
  const deferred = updateView({ state: 'downloaded', availableVersion: '0.25.3', canDeferInstall: true }, false);
  assert.equal(deferred.action.id, 'defer');
  assert.match(deferred.action.label, /task finishes/i);
  
  const htmlNote = normalizeReleaseNoteText('<h3>Linux desktop and update reliability</h3><ul><li><strong>Restore close-to-tray behavior</strong></li><li>Fix &amp; verify updates</li></ul>');
  assert.match(htmlNote, /Linux desktop and update reliability/);
  assert.match(htmlNote, /Restore close-to-tray behavior/);
  assert.match(htmlNote, /Fix & verify updates/);
  assert.doesNotMatch(htmlNote, /<\/?(?:h3|ul|li|strong)>/i, 'updater HTML must not be injected into the dashboard');
  
  console.log('Desktop update support policy and React update-view tests passed.');
}
await case_desktop_updates_policy_unit();

// Formerly electron-dynamic-resource-contract-unit.mjs
async function case_electron_dynamic_resource_contract_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
  const contracts = [
    ['../src/connectionProfile.js', {
      generateToken: 'function', readLaunchEnv: 'function', writeLaunchEnv: 'function',
      readConnectionProfile: 'function', writeConnectionProfile: 'function'
    }],
    ['../src/config.js', { ensureConfig: 'function', getConfigPath: 'function', readConfig: 'function' }],
    ['../src/toolActivity.js', { onToolActivity: 'function', getToolActivity: 'function', resetToolActivity: 'function' }],
    ['../src/http/dashboardSessions.ts', { clearDashboardSessions: 'function', createDashboardBootstrap: 'function' }],
    ['../src/durableState.ts', { readJsonFile: 'function', writeJsonAtomic: 'function' }],
    ['../src/desktopUxContracts.js', { deriveConnectionState: 'function', ERROR_CODES: 'object' }],
    ['../src/desktopManager.ts', { configureDesktopNativeBridge: 'function', runDesktopAction: 'function' }],
    ['../src/diagnostics.js', { sanitizeDiagnosticValue: 'function' }],
    ['../src/httpServer.ts', { startHttpServer: 'function' }],
    ['../src/process.js', { terminateProcessTree: 'function' }],
    ['../src/processManager.js', { stopAllManagedProcesses: 'function' }],
    ['../src/telemetry.js', { shutdownTelemetry: 'function' }]
  ];
  
  for (const [specifier, expected] of contracts) {
    const module = await import(specifier);
    for (const [name, type] of Object.entries(expected)) {
      assert.equal(typeof module[name], type, `${specifier} must export ${name} for Electron importResourceModule consumers`);
    }
  }
  
  console.log('Electron dynamic resource-module export contracts passed.');
}
await case_electron_dynamic_resource_contract_unit();

// Formerly electron-product-path-unit.mjs
async function case_electron_product_path_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:path");
    const path = __m2.default;
  
    const __m3 = await import("node:url");
    const { fileURLToPath } = __m3;
  
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
  
  const publicDocuments = [
    'README.md',
    'docs/ONE_CLICK_SETUP.md',
    'docs/CONNECTING_TO_CHATGPT.md'
  ];
  const documentOnlyPatterns = [
    /\bterminal\b/i,
    /\bPowerShell\b/i,
    /command prompt/i,
    /\bNode\.js\b/i,
    /\bnpm\b/i,
    /`?\.env`?/i,
    /\blocalhost\b/i,
    /127\.0\.0\.1/,
    /\bloopback\b/i,
    /\/health\b/i,
    /\bconfig\.json\b/i,
    /JSON configuration/i,
    /manual(?:ly)? (?:start|server|setup|install)/i,
    /install (?:the )?ngrok/i,
    /separate ngrok download/i
  ];
  const sharedPublicPatterns = [
    /\bpublic endpoint\b/i,
    /\bbrowser dashboard\b/i
  ];
  
  for (const relative of publicDocuments) {
    const source = read(relative);
    const setupFacingSource = relative === 'README.md'
      ? (source.match(/^## (?:Start using Rel\.AI|Quick start)[\s\S]*?(?=^## )/m)?.[0] || source)
      : source;
    for (const pattern of [...documentOnlyPatterns, ...sharedPublicPatterns]) {
      assert.doesNotMatch(setupFacingSource, pattern, `${relative} exposes developer-only setup language: ${pattern}`);
    }
  }
  for (const relative of publicDocuments) {
    const directory = path.dirname(path.join(root, relative));
    for (const match of read(relative).matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = String(match[1] || '').trim().replace(/^<|>$/g, '');
      if (!target || /^(?:https?:|mailto:|#)/i.test(target)) continue;
      const localPath = decodeURIComponent(target.split('#')[0].split('?')[0]);
      assert.equal(fs.existsSync(path.resolve(directory, localPath)), true, `${relative} contains a missing local link: ${target}`);
    }
  }
  assert.match(read('README.md'), /docs\/DEVELOPMENT\.md/, 'README must route source development into the developer guide');
  assert.equal(fs.existsSync(path.join(root, 'docs/DEVELOPMENT.md')), true, 'technical development instructions need a dedicated document');
  const publicJourney = publicDocuments.map(read).join('\n');
  for (const outcome of [
    /(?:Download|Install) Rel\.AI MCP/i,
    /create an OpenAI Secure MCP Tunnel/i,
    /Tunnel[\s\S]{0,40}connection option/i,
    /add (?:a|your first) workspace/i,
    /OpenAI Secure MCP Tunnel/i,
    /runtime API key/i,
    /(?:troubleshoot|diagnostics).*(?:in Rel\.AI|Connection|Diagnostics)/is
  ]) {
    assert.match(publicJourney, outcome, `public documentation must cover the Electron user outcome: ${outcome}`);
  }
  
  const publicCopyFiles = [
    'electron/renderer/wizard.html',
    'electron/renderer/wizard.js',
    'src/ui/features/settings/react.js',
    'src/ui/features/settings/connection-guidance.js',
    'src/ui/features/settings/diagnostics-react.js',
    'src/ui/api.js',
    'src/desktopUxContracts.js'
  ];
  for (const relative of publicCopyFiles) {
    const source = read(relative);
    for (const pattern of sharedPublicPatterns) {
      assert.doesNotMatch(source, pattern, `${relative} exposes internal connection terminology: ${pattern}`);
    }
  }
  
  console.log('Electron-first product path scanner passed.');
}
await case_electron_product_path_unit();

// Formerly electron-service-activity-bridge-unit.mjs
async function case_electron_service_activity_bridge_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:events");
    const { EventEmitter } = __m1;
  
    const __m2 = await import("../electron/service-process-client.js");
    const { createServiceProcessClient } = __m2;
  
  class FakeUtilityProcess extends EventEmitter {
    constructor() {
      super();
      this.pid = 4321;
      this.sent = [];
      queueMicrotask(() => this.emit('spawn'));
    }
  
    postMessage(message) {
      this.sent.push(message);
      if (message.type !== 'request' || message.method !== 'start') return;
      queueMicrotask(() => this.emit('message', {
        type: 'response',
        id: message.id,
        ok: true,
        result: { ok: true, port: 3333 }
      }));
    }
  
    kill() {}
  }
  
  let child = null;
  const client = createServiceProcessClient({
    utilityProcess: {
      fork() {
        child = new FakeUtilityProcess();
        return child;
      }
    },
    modulePath: '/app/electron/service-process.js'
  });
  
  await client.start({ host: '127.0.0.1', port: 3333 });
  const phases = [];
  const unsubscribe = client.activitySource.onToolActivity(event => phases.push(event.phase));
  const task = {
    id: 'task-1',
    taskId: 'task-1',
    workspace: 'repo',
    state: 'working',
    status: 'running',
    activeCalls: 1,
    startedAt: 1,
    lastTool: 'relai_edit',
    operation: 'Editing files'
  };
  
  child.emit('message', {
    type: 'activity',
    event: { phase: 'snapshot', snapshot: { state: 'idle', activeConnectorCalls: 0, activeCalls: 0, activeTaskCount: 0, tasks: [] } }
  });
  child.emit('message', {
    type: 'activity',
    event: { phase: 'started', activeConnectorCalls: 1, activeCalls: 1, activeTaskCount: 1, taskId: 'task-1', task }
  });
  for (let index = 0; index < 500; index += 1) {
    child.emit('message', {
      type: 'activity',
      event: {
        phase: 'progress',
        activeConnectorCalls: 1,
        activeCalls: 1,
        activeTaskCount: 1,
        taskId: 'task-1',
        task: { ...task, operation: `Editing file ${index + 1}` }
      }
    });
  }
  child.emit('message', {
    type: 'activity',
    event: {
      phase: 'finished',
      activeConnectorCalls: 0,
      activeCalls: 0,
      activeTaskCount: 1,
      taskId: 'task-1',
      ok: true,
      task: { ...task, state: 'waiting', status: 'waiting', activeCalls: 0 }
    }
  });
  
  assert.deepEqual(phases, ['snapshot', 'started', 'finished'], 'high-frequency tool progress must not churn Electron main-process activity subscribers');
  assert.equal(client.isListening(), true, 'dropping progress delivery must not affect service liveness');
  unsubscribe();
  await client.dispose({ stop: false });
  
  console.log('Electron service activity bridge keeps main-process updates lifecycle-driven.');
}
await case_electron_service_activity_bridge_unit();

// Formerly electron-updater-config-unit.mjs
async function case_electron_updater_config_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("node:url");
    const { fileURLToPath, pathToFileURL } = __m4;
  
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const helperPath = path.join(root, 'scripts', 'electron-updater-config.mjs');
  assert.equal(fs.existsSync(helperPath), true,
    'Windows release packaging must provide a dedicated updater-config helper');
  
  const { createWindowsUpdaterConfig, writeWindowsUpdaterConfig } = await import(pathToFileURL(helperPath));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'electron', 'package.json'), 'utf8'));
  const config = createWindowsUpdaterConfig(manifest);
  assert.deepEqual(config, {
    provider: 'github',
    owner: 'Kyne0328',
    repo: 'rel-ai-chatgpt-web-harness',
    releaseType: 'prerelease',
    updaterCacheDirName: 'rel-ai-mcp-launcher-updater'
  });
  
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-updater-config-'));
  try {
    const appDirectory = path.join(temporaryRoot, 'win-unpacked');
    const portableDirectory = path.join(temporaryRoot, 'portable-win-unpacked');
    fs.mkdirSync(path.join(appDirectory, 'resources'), { recursive: true });
    fs.cpSync(appDirectory, portableDirectory, { recursive: true });
    const result = writeWindowsUpdaterConfig({ appDirectory, manifest });
    assert.equal(result, path.join(appDirectory, 'resources', 'app-update.yml'));
    assert.equal(fs.existsSync(path.join(portableDirectory, 'resources', 'app-update.yml')), false);
    assert.equal(fs.readFileSync(result, 'utf8'), [
      'provider: github',
      'owner: Kyne0328',
      'repo: rel-ai-chatgpt-web-harness',
      'releaseType: prerelease',
      'updaterCacheDirName: rel-ai-mcp-launcher-updater',
      ''
    ].join('\n'));
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  
  const packageScript = fs.readFileSync(path.join(root, 'scripts', 'electron-package.mjs'), 'utf8');
  const portableClone = packageScript.indexOf('fs.cpSync(prepackaged, portablePrepackaged');
  const updaterWrite = packageScript.indexOf('writeWindowsUpdaterConfig({ appDirectory: prepackaged');
  const artifactBuild = packageScript.indexOf("runNodeAsync('NSIS artifact packaging'");
  assert.ok(portableClone >= 0 && updaterWrite > portableClone,
    'the portable working copy must be cloned before app-update.yml is added');
  assert.ok(artifactBuild > updaterWrite,
    'app-update.yml must be written before the NSIS artifact is built');
  
  console.log('Windows updater configuration packaging tests passed.');
}
await case_electron_updater_config_unit();

// Formerly local-protocol-unit.mjs
async function case_local_protocol_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("node:fs");
    const fs = __m1.default;
  
    const __m2 = await import("node:os");
    const os = __m2.default;
  
    const __m3 = await import("node:path");
    const path = __m3.default;
  
    const __m4 = await import("../electron/local-protocol.js");
    const { installLocalProtocol, localRendererUrl, resolveLocalRendererPath } = __m4;
  
  const root = path.resolve('electron/renderer');
  
  assert.equal(localRendererUrl('status.html'), 'relai-app://renderer/status.html');
  assert.equal(localRendererUrl('wizard.html', { recovery: 1 }), 'relai-app://renderer/wizard.html?recovery=1');
  assert.throws(() => localRendererUrl('../status.html'), /file name/);
  assert.equal(resolveLocalRendererPath('relai-app://renderer/status.html?ignored=1', root), path.join(root, 'status.html'));
  for (const target of [
    'file:///tmp/status.html',
    'relai-app://other/status.html',
    'relai-app://renderer/../main.js',
    'relai-app://renderer/%2e%2e/main.js',
    'relai-app://renderer/unknown.json',
    'https://renderer/status.html'
  ]) assert.equal(resolveLocalRendererPath(target, root), '');
  
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-local-protocol-'));
  try {
    fs.writeFileSync(path.join(temp, 'status.html'), '<main>ready</main>');
    let handler = null;
    const protocol = {
      handle(scheme, callback) {
        assert.equal(scheme, 'relai-app');
        handler = callback;
      }
    };
    assert.equal(installLocalProtocol(protocol, temp), true);
    assert.equal(installLocalProtocol(protocol, temp), false, 'the same protocol object must not register twice');
  
    const existing = await handler({ url: 'relai-app://renderer/status.html' });
    assert.equal(existing.status, 200);
    assert.equal(existing.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await existing.text(), '<main>ready</main>');
  
    const missing = await handler({ url: 'relai-app://renderer/missing.html' });
    assert.equal(missing.status, 404, 'missing allow-listed renderer files must fail through the async read path');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  
  console.log('Local Electron protocol tests passed.');
}
await case_local_protocol_unit();

// Formerly notification-wording-unit.mjs
async function case_notification_wording_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../electron/tool-sleep-blocker.js");
    const { buildCompletionNotification, buildFailureNotification, cleanNotificationText, truncateNotificationText } = __m1;
  
  assert.equal(cleanNotificationText('  line one\n  line two  '), 'line one line two');
  assert.equal(truncateNotificationText('abcdef', 4), 'abc…');
  
  const failure = buildFailureNotification({
    operation: 'Running release checks',
    workspace: 'rel-ai-mcp',
    error: 'Lint failed\nOpen the dashboard for details.'
  });
  assert.ok(String(failure.title || '').trim(), 'failure notification must have a title');
  assert.match(failure.body, /Running release checks/);
  assert.match(failure.body, /rel-ai-mcp/);
  assert.doesNotMatch(failure.body, /Lint failed|Open the dashboard for details/, 'native alerts should not expose raw technical failure text');
  assert.match(failure.body, /Open Rel\.AI for details and recovery options/);
  assert.doesNotMatch(failure.title, /Rel\.AI MCP|Electron/i, 'the OS already supplies the application identity');
  
  const completion = buildCompletionNotification({
    workspace: 'rel-ai-mcp',
    summary: 'Improved desktop notifications and application identity.',
    validationLevel: 'release'
  });
  assert.ok(String(completion.title || '').trim(), 'completion notification must have a title');
  assert.match(completion.body, /Improved desktop notifications and application identity\./);
  assert.match(completion.body, /rel-ai-mcp/);
  assert.match(completion.body, /release/i);
  assert.doesNotMatch(completion.body, /completion reported|ChatGPT explicitly/i);
  
  const longSummary = 'x'.repeat(1000);
  const longCompletion = buildCompletionNotification({
    workspace: 'workspace',
    summary: longSummary,
    validationLevel: 'standard'
  });
  assert.ok(longCompletion.body.length < longSummary.length, 'notification truncation must reduce an oversized summary');
  assert.match(longCompletion.body, /Final standard checks passed\.$/, 'validation result must remain visible');
  
  console.log('Notification wording tests passed.');
}
await case_notification_wording_unit();

// Formerly tunnel-log-parser-unit.mjs
async function case_tunnel_log_parser_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../electron/tunnel-log-parser.js");
    const { createTunnelLogParser, normalizeTunnelLogRecord } = __m1;
  
  const entries = [];
  const parser = createTunnelLogParser({
    onEntry: entry => entries.push(entry),
    now: () => '2026-08-16T05:00:00.000Z'
  });
  
  parser.write('{"time":"2026-08-16T12:39:08+08:00","level":"WARN","msg":"poll failed; back');
  parser.write('ing off","component":"controlplane","error":"unexpected EOF","retry_in_ms":10000}');
  parser.write('{"level":"INFO","msg":"provided","component":"mcpclient"}\nplain fallback line\n');
  parser.flush();
  
  assert.equal(entries.length, 3, 'fragmented, concatenated, and plain records must each produce one event');
  assert.equal(entries[0].code, 'tunnel_connection_interrupted');
  assert.equal(entries[0].level, 'warning');
  assert.equal(entries[0].component, 'controlplane');
  assert.equal(entries[0].details.retryInMs, 10000);
  assert.equal(entries[0].details.lastError, 'unexpected EOF');
  assert.equal(entries[1].level, 'debug', 'dependency-injection startup noise must be demoted');
  assert.equal(entries[2].message, 'plain fallback line');
  
  const rejected = normalizeTunnelLogRecord(JSON.stringify({
    time: '2026-08-16T13:17:00.255+08:00',
    level: 'ERROR',
    msg: 'request failed',
    component: 'controlplane',
    status_code: 401,
    error: 'Authorization: Bearer secret-token sk-runtime-secret-123456'
  }));
  assert.equal(rejected.code, 'tunnel_authentication_failed');
  assert.equal(rejected.message, 'OpenAI rejected the tunnel runtime API key.');
  assert.equal(rejected.details.httpStatus, 401);
  assert.doesNotMatch(JSON.stringify(rejected), /secret-token|sk-runtime-secret/);
  
  const denied = normalizeTunnelLogRecord('{"level":"ERROR","msg":"forbidden","component":"controlplane","status_code":403}');
  assert.equal(denied.code, 'tunnel_access_denied');
  const missing = normalizeTunnelLogRecord('{"level":"ERROR","msg":"tunnel lookup failed","component":"controlplane","status_code":404}');
  assert.equal(missing.code, 'tunnel_not_found');
  const deadline = normalizeTunnelLogRecord('{"level":"WARN","msg":"command response deadline reached; dropping without posting a response","component":"dispatcher"}');
  assert.equal(deadline.code, 'tunnel_response_deadline');
  const upstream = normalizeTunnelLogRecord('{"level":"ERROR","msg":"dispatcher received MCP upstream error; posted error response to control plane","component":"dispatcher","status_code":502}');
  assert.equal(upstream.code, 'tunnel_upstream_5xx');
  assert.equal(upstream.details.httpStatus, 502);
  
  console.log('Tunnel log parser normalizes fragmented structured output safely.');
}
await case_tunnel_log_parser_unit();

// Formerly window-chrome-unit.mjs
async function case_window_chrome_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../electron/window-chrome.js");
    const { dashboardWindowChrome, dashboardWindowChromeState } = __m1;
  
  const windows = dashboardWindowChrome('win32');
  assert.equal(windows.platform, 'win32');
  assert.equal(windows.customTitleBar, true);
  assert.equal(windows.controls, 'native');
  assert.equal(windows.windowOptions.frame, false);
  assert.equal(windows.windowOptions.thickFrame, true);
  assert.equal(windows.windowOptions.titleBarStyle, 'hidden');
  assert.deepEqual(windows.windowOptions.titleBarOverlay, { color: '#111613', symbolColor: '#f2f6f2', height: 40 });
  assert.equal(windows.windowOptions.hasShadow, true);
  assert.equal(windows.windowOptions.roundedCorners, true);
  
  const macos = dashboardWindowChrome('darwin');
  assert.equal(macos.platform, 'darwin');
  assert.equal(macos.customTitleBar, true);
  assert.equal(macos.controls, 'native');
  assert.equal(macos.windowOptions.titleBarStyle, 'hiddenInset');
  assert.deepEqual(macos.windowOptions.trafficLightPosition, { x: 14, y: 13 });
  assert.equal(Object.hasOwn(macos.windowOptions, 'frame'), false);
  
  const linux = dashboardWindowChrome('linux');
  assert.equal(linux.platform, 'linux');
  assert.equal(linux.customTitleBar, false);
  assert.equal(linux.controls, 'native');
  assert.deepEqual(linux.windowOptions, {});
  
  const state = dashboardWindowChromeState({
    isMaximized: () => true,
    isMinimized: () => false,
    isFullScreen: () => true
  }, 'win32');
  assert.deepEqual(state, {
    platform: 'win32',
    customTitleBar: true,
    controls: 'native',
    maximized: true,
    minimized: false,
    fullScreen: true
  });
  
  assert.deepEqual(dashboardWindowChromeState(null, 'linux'), {
    platform: 'linux',
    customTitleBar: false,
    controls: 'native',
    maximized: false,
    minimized: false,
    fullScreen: false
  });
  
  console.log('Window chrome platform policy tests passed.');
}
await case_window_chrome_unit();

// Formerly window-security-unit.mjs
async function case_window_security_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../electron/window-security.js");
    const { localWindowWebPreferences, secureLocalWindow, isAllowedLocalTarget } = __m1;
  
  const allowedUrl = 'relai-app://renderer/wizard.html?recovery=1';
  const preferences = localWindowWebPreferences('preload.cjs', 'relai-test', 'dashboard');assert.deepEqual(preferences, {
    preload: 'preload.cjs',
    additionalArguments: ['--relai-preload-surface=dashboard'],
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    spellcheck: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    partition: 'relai-test'
  });
  
  const webHandlers = new Map();
  const sessionHandlers = new Map();
  let downloadListenerRegistrations = 0;
  let permissionRequest = null;
  let permissionCheck = null;
  let openHandler = null;
  const errors = [];
  const sharedSession = {
    setPermissionRequestHandler: handler => { permissionRequest = handler; },
    setPermissionCheckHandler: handler => { permissionCheck = handler; },
    on: (name, handler) => {
      if (name === 'will-download') downloadListenerRegistrations += 1;
      sessionHandlers.set(name, handler);
    }
  };
  const window = {
    webContents: {
      session: sharedSession,
      on: (name, handler) => webHandlers.set(name, handler),
      setWindowOpenHandler: handler => { openHandler = handler; }
    }
  };
  
  assert.equal(secureLocalWindow(window, { allowedUrl, onError: error => errors.push(error.message) }), window);
  const recreatedWindow = {
    webContents: {
      session: sharedSession,
      on() {},
      setWindowOpenHandler() {}
    }
  };
  secureLocalWindow(recreatedWindow, { allowedUrl });
  assert.equal(downloadListenerRegistrations, 1, 'recreating a window on the same Electron session must not accumulate will-download listeners');
  let permissionGranted = true;
  permissionRequest(null, 'camera', granted => { permissionGranted = granted; });
  assert.equal(permissionGranted, false);
  assert.equal(permissionCheck(), false);
  
  for (const [name, handlers] of [['will-download', sessionHandlers], ['will-attach-webview', webHandlers]]) {
    let prevented = false;
    handlers.get(name)({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true, `${name} must be blocked`);
  }
  
  assert.equal(isAllowedLocalTarget(`${allowedUrl}#step2`, allowedUrl), true);
  let prevented = false;
  webHandlers.get('will-navigate')({ preventDefault: () => { prevented = true; } }, `${allowedUrl}#step2`);
  assert.equal(prevented, false);
  
  for (const target of ['https://example.com/', 'relai-app://renderer/status.html', 'file:///tmp/wizard.html']) {
    prevented = false;
    webHandlers.get('will-redirect')({ preventDefault: () => { prevented = true; } }, target);
    assert.equal(prevented, true);
  }
  assert.equal(errors.length, 3);
  assert.deepEqual(openHandler({ url: 'https://example.com/' }), { action: 'deny' });
  assert.throws(() => secureLocalWindow(null, { allowedUrl }), /BrowserWindow/);
  
  console.log('Window security unit tests passed.');
}
await case_window_security_unit();

// Formerly windows-uia-adapter-unit.mjs
async function case_windows_uia_adapter_unit() {
  const __m0 = await import("node:assert/strict");
    const assert = __m0.default;
  
    const __m1 = await import("../src/computer/windowsUiaAdapter.ts");
    const { createWindowsUiaAdapter } = __m1;
  
  const target = {
    targetId: 'e1', source: 'uia', role: 'Button', name: 'Save', automationId: 'save', className: 'Button', enabled: true,
    displayId: '\\\\.\\DISPLAY1', x: 100, y: 200, width: 80, height: 30, centerX: 140, centerY: 215, patterns: ['invoke']
  };
  let requests = [];
  const adapter = createWindowsUiaAdapter({
    platform: 'win32',
    request: async payload => {
      requests.push(payload);
      if (payload.action === 'warmup') return { supported: true, available: true, ocrAvailable: true };
      if (payload.action === 'activate') {
        return { supported: true, available: true, handled: true, method: 'uia-invoke', target };
      }
      if (payload.action === 'set_value') {
        return { supported: true, available: true, handled: true, method: 'uia-set-value', target: { ...target, role: 'Edit', patterns: ['value'] } };
      }
      return {
        supported: true,
        available: true,
        perception: payload.perception,
        ocrAvailable: true,
        window: {
          title: 'Notes',
          processName: 'notes',
          processId: 123,
          className: 'NotesWindow',
          displayId: '\\\\.\\DISPLAY1'
        },
        elements: [
          target,
          {
            targetId: 'e2', source: 'ocr', role: 'Text', name: 'Export report', automationId: '', className: 'Windows.Media.Ocr', enabled: true,
            displayId: '\\\\.\\DISPLAY1', x: 200, y: 300, width: 120, height: 30, centerX: 260, centerY: 315
          },
          { targetId: '', role: 'Button', displayId: '', width: 0, height: 0 }
        ],
        count: 3,
        truncated: false
      };
    }
  });
  
  assert.equal(adapter.supported(), true);
  const warm = await adapter.warmup();
  assert.equal(warm.available, true);
  assert.equal(warm.ocrAvailable, true);
  await adapter.warmup();
  assert.deepEqual(requests, [{ action: 'warmup' }], 'warmup must be shared instead of spawning duplicate initialization work');
  
  const observation = await adapter.observe('Notes', 50, 'hybrid');
  assert.deepEqual(requests.at(-1), { action: 'observe', app: 'Notes', maxElements: 50, perception: 'hybrid' });
  assert.equal(observation.available, true);
  assert.equal(observation.perception, 'hybrid');
  assert.equal(observation.ocrAvailable, true);
  assert.equal(observation.count, 2, 'malformed semantic targets must be filtered at the adapter boundary');
  assert.equal(observation.elements[0].targetId, 'e1');
  assert.equal(observation.elements[0].source, 'uia');
  assert.deepEqual(observation.elements[0].patterns, ['invoke']);
  assert.equal(observation.elements[0].centerX, 140);
  assert.equal(observation.elements[1].source, 'ocr');
  assert.equal(observation.window.processName, 'notes');
  
  const activation = await adapter.activate('Notes', observation.elements[0], 50, 'hybrid');
  assert.equal(activation.available, true);
  assert.equal(activation.handled, true);
  assert.equal(activation.method, 'uia-invoke');
  assert.equal(activation.target.source, 'uia');
  assert.equal(requests.at(-1).action, 'activate');
  assert.equal(requests.at(-1).perception, 'hybrid');
  assert.equal(requests.at(-1).target.targetId, 'e1');
  
  const setValue = await adapter.setValue('Notes', observation.elements[0], '', 50);
  assert.equal(setValue.handled, true);
  assert.equal(setValue.method, 'uia-set-value');
  assert.equal(requests.at(-1).action, 'set_value');
  assert.equal(requests.at(-1).text, '', 'native value setting must preserve an intentional empty value');
  
  const unavailable = createWindowsUiaAdapter({ platform: 'linux' });
  assert.equal(unavailable.supported(), false);
  assert.deepEqual(await unavailable.warmup(), { supported: false, available: false, ocrAvailable: false });
  assert.deepEqual(await unavailable.observe('Notes'), {
    supported: false,
    available: false,
    reason: 'Windows UI Automation is available only on Windows.'
  });
  
  const missing = createWindowsUiaAdapter({
    platform: 'win32',
    request: async payload => payload.action === 'warmup'
      ? { supported: true, available: true, ocrAvailable: false }
      : { supported: true, available: false, reason: 'missing' }
  });
  assert.equal((await missing.observe('Notes')).available, false);
  assert.equal((await missing.observe('Notes')).reason, 'missing');
  
  await assert.rejects(() => adapter.observe('Notes', 50, 'invalid'), /auto, semantic, or hybrid/i);
  
  console.log('Windows UI Automation adapter warms once, normalizes hybrid targets, and exposes native semantic actions.');
}
await case_windows_uia_adapter_unit();

// Native multi-tunnel connection storage and runtime pooling.
async function case_multi_tunnel_connection_unit() {
  const assert = (await import('node:assert/strict')).default;
  const fs = (await import('node:fs')).default;
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const { createTunnelConnectionStore } = await import('../electron/tunnel-connections.js');
  const { createTunnelRuntimePool } = await import('../electron/tunnel-runtime-pool.js');

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-multi-tunnel-'));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: value => Buffer.from(value).toString('utf8').replace(/^encrypted:/, '')
  };

  try {
    const store = createTunnelConnectionStore({ stateDir, safeStorage });
    assert.deepEqual(store.list(), []);

    const stored = store.upsert({
      label: 'School',
      tunnelId: 'tunnel_school123456',
      apiKey: 'sk-runtime-school-123456'
    });
    assert.deepEqual(stored, {
      tunnelId: 'tunnel_school123456',
      label: 'School',
      enabled: true,
      apiKeyConfigured: true
    });
    assert.doesNotMatch(fs.readFileSync(store.statePath(), 'utf8'), /sk-runtime-school-123456/);
    assert.equal(store.runtimeConnections()[0].apiKey, 'sk-runtime-school-123456');

    store.upsert({ label: 'School account', tunnelId: 'tunnel_school123456' });
    assert.equal(store.list()[0].label, 'School account');
    assert.equal(store.runtimeConnections()[0].apiKey, 'sk-runtime-school-123456', 'updating metadata must preserve the encrypted runtime key');

    const starts = [];
    const stops = [];
    const createRuntime = options => {
      let state = { state: 'stopped', tunnelId: '' };
      return {
        async start(config) {
          starts.push({ ...config, instanceId: options.instanceId });
          state = { state: 'running', tunnelId: config.tunnelId, healthUrl: `http://127.0.0.1/${config.tunnelId}` };
          options.onStatus(state);
          return { ok: true, ...state };
        },
        async stop() {
          stops.push(state.tunnelId);
          state = { ...state, state: 'stopped' };
          options.onStatus(state);
          return { stopped: true, exited: true };
        },
        snapshot() { return { ...state }; }
      };
    };

    const pool = createTunnelRuntimePool({ createRuntime });
    const first = await pool.sync({
      connections: [
        { tunnelId: 'tunnel_accountA123', label: 'Account A', enabled: true, apiKey: 'sk-account-a-123456' },
        { tunnelId: 'tunnel_accountB123', label: 'Account B', enabled: true, apiKey: 'sk-account-b-123456' }
      ],
      port: 3333,
      localToken: 'shared-local-token'
    });
    assert.equal(first.connections.length, 2);
    assert.equal(starts.length, 2);
    assert.deepEqual(new Set(starts.map(start => start.localToken)), new Set(['shared-local-token']));
    assert.deepEqual(new Set(starts.map(start => start.port)), new Set([3333]));
    assert.deepEqual(new Set(starts.map(start => start.apiKey)), new Set(['sk-account-a-123456', 'sk-account-b-123456']));
    assert.deepEqual(new Set(starts.map(start => start.instanceId)), new Set(['tunnel_accountA123', 'tunnel_accountB123']));

    const startsBeforeSecond = starts.length;
    const stopsBeforeSecond = stops.length;
    const second = await pool.sync({
      connections: [
        { tunnelId: 'tunnel_accountB123', label: 'Account B', enabled: true, apiKey: 'sk-account-b-123456' }
      ],
      port: 3333,
      localToken: 'shared-local-token'
    });
    assert.deepEqual(second.connections.map(connection => connection.tunnelId), ['tunnel_accountB123'], 'removed tunnels must disappear from the pool status');
    assert.equal(starts.length, startsBeforeSecond, 'removing one tunnel must not restart an unchanged healthy peer');
    assert.deepEqual(stops.slice(stopsBeforeSecond), ['tunnel_accountA123'], 'removing one tunnel must stop only that tunnel');

    const startsBeforeAdd = starts.length;
    const stopsBeforeAdd = stops.length;
    const added = await pool.sync({
      connections: [
        { tunnelId: 'tunnel_accountB123', label: 'Account B', enabled: true, apiKey: 'sk-account-b-123456' },
        { tunnelId: 'tunnel_accountC123', label: 'Account C', enabled: true, apiKey: 'sk-account-c-123456' }
      ],
      port: 3333,
      localToken: 'shared-local-token'
    });
    assert.deepEqual(new Set(added.connections.map(connection => connection.tunnelId)), new Set(['tunnel_accountB123', 'tunnel_accountC123']));
    assert.equal(starts.length, startsBeforeAdd + 1, 'adding one tunnel must start only the new tunnel');
    assert.equal(starts.at(-1).tunnelId, 'tunnel_accountC123');
    assert.equal(stops.length, stopsBeforeAdd, 'adding one tunnel must not stop an unchanged healthy peer');

    const startsBeforeDisable = starts.length;
    const stopsBeforeDisable = stops.length;
    const disabled = await pool.sync({
      connections: [
        { tunnelId: 'tunnel_accountB123', label: 'Account B', enabled: true, apiKey: 'sk-account-b-123456' },
        { tunnelId: 'tunnel_accountC123', label: 'Account C', enabled: false, apiKey: 'sk-account-c-123456' }
      ],
      port: 3333,
      localToken: 'shared-local-token'
    });
    assert.deepEqual(disabled.connections.map(connection => connection.tunnelId), ['tunnel_accountB123']);
    assert.equal(starts.length, startsBeforeDisable, 'disabling one tunnel must not restart an unchanged healthy peer');
    assert.deepEqual(stops.slice(stopsBeforeDisable), ['tunnel_accountC123'], 'disabling one tunnel must stop only that tunnel');

    const startsBeforeRename = starts.length;
    const stopsBeforeRename = stops.length;
    const renamed = await pool.sync({
      connections: [
        { tunnelId: 'tunnel_accountB123', label: 'Renamed account', enabled: true, apiKey: 'sk-account-b-123456' }
      ],
      port: 3333,
      localToken: 'shared-local-token'
    });
    assert.equal(renamed.connections[0].label, 'Renamed account');
    assert.equal(starts.length, startsBeforeRename, 'metadata-only edits must not restart the tunnel');
    assert.equal(stops.length, stopsBeforeRename, 'metadata-only edits must not stop the tunnel');

    const startsBeforeCredentialChange = starts.length;
    const stopsBeforeCredentialChange = stops.length;
    await pool.sync({
      connections: [
        { tunnelId: 'tunnel_accountB123', label: 'Renamed account', enabled: true, apiKey: 'sk-account-b-rotated123456' }
      ],
      port: 3333,
      localToken: 'shared-local-token'
    });
    assert.equal(starts.length, startsBeforeCredentialChange + 1, 'credential changes must restart only the changed tunnel');
    assert.equal(stops.length, stopsBeforeCredentialChange + 1, 'credential changes must stop only the changed tunnel');
    assert.equal(starts.at(-1).tunnelId, 'tunnel_accountB123');
    assert.equal(starts.at(-1).apiKey, 'sk-account-b-rotated123456');

    await pool.stop();
    assert.equal(pool.snapshot().connections[0].state, 'stopped');

    assert.equal(store.remove('tunnel_school123456').removed, true);
    assert.deepEqual(store.list(), []);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }

  console.log('Additional Secure MCP Tunnel storage and shared-local-service pooling passed.');
}
await case_multi_tunnel_connection_unit();


// Credential preparation must isolate failures without exposing credential material.
async function case_additional_tunnel_failure_isolation() {
  const assert = (await import('node:assert/strict')).default;
  const fs = (await import('node:fs')).default;
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const { createTunnelConnectionStore } = await import('../electron/tunnel-connections.js');
  const { createTunnelRuntimePool } = await import('../electron/tunnel-runtime-pool.js');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-tunnel-isolation-'));
  const healthyId = 'tunnel_healthy123456';
  const brokenId = 'tunnel_broken123456';
  const disabledId = 'tunnel_disabled123456';
  const keys = ['sk-healthy-fixture-123456', 'sk-broken-fixture-123456', 'sk-disabled-fixture-123456'];
  const rejected = new Set();
  const decrypted = [];
  const created = [];
  const started = [];
  const stopped = [];
  const observed = [];
  let available = true;
  const store = createTunnelConnectionStore({
    stateDir,
    safeStorage: {
      isEncryptionAvailable: () => available,
      encryptString: value => Buffer.from('encrypted:' + value),
      decryptString: value => {
        const plaintext = Buffer.from(value).toString().replace(/^encrypted:/, '');
        decrypted.push(plaintext);
        if (rejected.has(plaintext)) throw new Error('private decrypt cause ' + plaintext);
        return plaintext;
      }
    }
  });
  const pool = createTunnelRuntimePool({
    onLog: entry => observed.push(entry),
    onStatus: status => observed.push(status),
    createRuntime: options => {
      created.push(options.instanceId);
      let state = { state: 'stopped', tunnelId: options.instanceId };
      return {
        async start(config) {
          started.push(config.tunnelId);
          state = { state: 'running', tunnelId: config.tunnelId };
          options.onStatus(state);
          return state;
        },
        async stop() {
          stopped.push(options.instanceId);
          state = { ...state, state: 'stopped' };
          options.onStatus(state);
        },
        snapshot: () => state
      };
    }
  });
  const synchronize = () => pool.sync({ connections: store.runtimeConnections(), port: 3333, localToken: 'isolated-fixture-token' });
  try {
    store.upsert({ tunnelId: healthyId, label: 'Healthy', apiKey: keys[0] });
    store.upsert({ tunnelId: brokenId, label: 'Broken', apiKey: keys[1] });
    await synchronize();
    assert.deepEqual(new Set(started), new Set([healthyId, brokenId]));
    store.upsert({ tunnelId: disabledId, label: 'Disabled', enabled: false, apiKey: keys[2] });
    rejected.add(keys[1]);
    rejected.add(keys[2]);
    decrypted.length = 0;
    created.length = 0;
    started.length = 0;
    const persisted = fs.readFileSync(store.statePath());
    const prepared = store.runtimeConnections();
    assert.deepEqual(decrypted, [keys[0], keys[1]], 'disabled credentials must never be decrypted');
    assert.equal(Object.hasOwn(prepared.find(item => item.tunnelId === disabledId), 'apiKey'), false);
    assert.equal(Object.hasOwn(prepared.find(item => item.tunnelId === brokenId), 'apiKey'), false);
    const result = await pool.sync({ connections: prepared, port: 3333, localToken: 'isolated-fixture-token' });
    assert.deepEqual(created, [], 'credential failure in one tunnel must not recreate a healthy peer');
    assert.deepEqual(started, [], 'credential failure in one tunnel must not restart a healthy peer');
    assert.ok(stopped.includes(brokenId), 'a previously running failed connection must be stopped');
    assert.equal(result.connections.find(item => item.tunnelId === healthyId).state, 'running');
    const failure = result.connections.find(item => item.tunnelId === brokenId);
    assert.equal(failure.state, 'failed');
    assert.equal(failure.errorCode, 'additional_tunnel_credentials_unavailable');
    assert.equal(result.results.find(item => item.tunnelId === brokenId).ok, false);
    assert.equal(result.connections.some(item => item.tunnelId === disabledId), false);
    assert.deepEqual(fs.readFileSync(store.statePath()), persisted, 'preparation and sync must not rewrite credentials');
    const publicOutput = JSON.stringify([result, observed]);
    for (const key of keys) {
      assert.equal(publicOutput.includes(key), false);
      assert.equal(publicOutput.includes(Buffer.from('encrypted:' + key).toString('base64')), false);
    }
    assert.equal(publicOutput.includes('private decrypt cause'), false);
    assert.equal(publicOutput.includes('isolated-fixture-token'), false);

    available = false;
    decrypted.length = 0;
    created.length = 0;
    const unavailable = await synchronize();
    assert.deepEqual(decrypted, [], 'unavailable storage must not attempt decryption');
    assert.deepEqual(created, [], 'unavailable credentials must not create runtimes');
    assert.equal(unavailable.connections.length, 2);
    assert.ok(unavailable.connections.every(item => item.state === 'failed'));
    assert.deepEqual(fs.readFileSync(store.statePath()), persisted);
    store.upsert({ tunnelId: healthyId, enabled: false });
    store.upsert({ tunnelId: brokenId, enabled: false });
    assert.equal((await synchronize()).connections.length, 0, 'disabled-only configuration needs no secure storage');

    const valid = fs.readFileSync(store.statePath(), 'utf8');
    const invalid = JSON.parse(valid);
    invalid.connections.push(invalid.connections[0]);
    fs.writeFileSync(store.statePath(), JSON.stringify(invalid));
    assert.throws(() => store.runtimeConnections(), /settings are corrupted/, 'document validation must remain fail-closed');
    fs.writeFileSync(store.statePath(), valid);
  } finally {
    await pool.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  console.log('Additional tunnel credential failures are isolated, fail closed, and remain secret-safe.');
}

async function case_additional_tunnel_save_failure() {
  const assert = (await import('node:assert/strict')).default;
  const fs = (await import('node:fs')).default;
  const { runInNewContext } = await import('node:vm');
  const source = fs.readFileSync(new URL('../electron/desktop-host.js', import.meta.url), 'utf8');
  const start = source.indexOf('  async function saveAdditionalTunnel(input = {}) {');
  const end = source.indexOf('  async function removeAdditionalTunnel(tunnelId) {', start);
  assert.ok(start >= 0 && end > start, 'desktop save handler must be available for behavioral testing');
  const tunnelId = 'tunnel_saved123456';
  const cases = [
    { enabled: true, connections: [], error: 'private-sync-cause', ok: false },
    { enabled: true, connections: [{ tunnelId, state: 'running' }], error: 'private-sync-cause', ok: false },
    { enabled: true, connections: [], ok: false },
    { enabled: true, connections: [{ tunnelId, state: 'failed' }], ok: false },
    { enabled: true, connections: [{ tunnelId, state: 'running' }], ok: true },
    { enabled: true, connections: [{ tunnelId, state: 'degraded' }], ok: true },
    { enabled: false, connections: [], ok: true },
    { enabled: false, connections: [], error: 'private-sync-cause', ok: false }
  ];
  for (const scenario of cases) {
    const connection = { tunnelId, enabled: scenario.enabled };
    const save = runInNewContext(source.slice(start, end) + '\nsaveAdditionalTunnel', {
      currentDesktopSettings: () => ({ tunnelId: 'tunnel_primary123456' }),
      tunnelConnections: { upsert: () => connection, list: () => [connection] },
      serviceRuntime: { restartAdditionalTunnels: async () => scenario }
    });
    const result = await save({ tunnelId });
    assert.equal(result.ok, scenario.ok, 'save success must reflect synchronization and the requested enabled status');
    assert.equal(result.saved, true);
    if (!scenario.ok) assert.ok(result.error, 'failed synchronization must have an observable error');
    assert.equal(JSON.stringify(result).includes('private-sync-cause'), false);
  }
  console.log('Additional tunnel saves report global, missing-status, and per-connection failures accurately.');
}

const additionalTunnelRegressionResults = await Promise.allSettled([
  case_additional_tunnel_failure_isolation(),
  case_additional_tunnel_save_failure()
]);
const additionalTunnelRegressionFailures = additionalTunnelRegressionResults.filter(result => result.status === 'rejected');
if (additionalTunnelRegressionFailures.length) {
  throw new AggregateError(additionalTunnelRegressionFailures.map(result => result.reason), 'Additional tunnel failure-isolation regressions failed.');
}



async function case_additional_tunnel_stop_failure() {
  const assert = (await import('node:assert/strict')).default;
  const { createTunnelRuntimePool } = await import('../electron/tunnel-runtime-pool.js');
  for (const failure of ['result', 'throw']) {
    let allowStop = false;
    let starts = 0;
    let stops = 0;
    const pool = createTunnelRuntimePool({
      createRuntime: options => {
        let state = { state: 'stopped', tunnelId: options.instanceId };
        return {
          async start() { starts += 1; state = { ...state, state: 'running' }; options.onStatus(state); return state; },
          async stop() {
            stops += 1;
            if (!allowStop) {
              if (failure === 'throw') throw new Error('fixture termination failed');
              return { stopped: false, exited: false, error: 'fixture termination failed' };
            }
            state = { ...state, state: 'stopped' }; options.onStatus(state);
            return { stopped: true, exited: true };
          },
          snapshot: () => state
        };
      }
    });
    const config = { connections: [{ tunnelId: 'tunnel_stopfixture123', apiKey: 'fixture-key', label: 'Fixture' }], port: 3333, localToken: 'fixture-token' };
    await pool.sync(config);
    try {
      const failed = await pool.stop();
      assert.equal(failed.stopped, false, `${failure}: aggregate cleanup must not claim a failed stop succeeded`);
      assert.equal(failed.connections[0].state, 'failed');
      await pool.sync({ ...config, connections: [] });
      assert.equal(pool.snapshot().connections[0].state, 'failed', 'removed but still live tunnel must remain visible');
      assert.equal(starts, 1, 'failed termination must never create a duplicate tunnel');
      allowStop = true;
      const retried = await pool.stop();
      assert.equal(retried.stopped, true);
      assert.ok(stops >= 3, 'repeat stop must retain and retry failed runtime ownership');
      assert.equal(retried.connections[0].state, 'stopped');
    } finally { allowStop = true; await pool.stop(); }
  }
}
await case_additional_tunnel_stop_failure();

async function case_additional_tunnel_remove_failure() {
  const assert = (await import('node:assert/strict')).default;
  const fs = (await import('node:fs')).default;
  const { runInNewContext } = await import('node:vm');
  const source = fs.readFileSync(new URL('../electron/desktop-host.js', import.meta.url), 'utf8');
  const begin = source.indexOf('  async function removeAdditionalTunnel(tunnelId) {');
  const end = source.indexOf('  async function setKeepAwake(', begin);
  const remove = runInNewContext(source.slice(begin, end) + '\nremoveAdditionalTunnel', {
    currentDesktopSettings: () => ({ tunnelId: 'tunnel_other123456' }),
    tunnelConnections: { remove: () => ({ ok: true, removed: true }), list: () => [] },
    serviceRuntime: { isListening: () => true, restartAdditionalTunnels: async () => ({ error: 'fixture stop failed', connections: [{ tunnelId: 'fixture', state: 'failed' }] }) }
  });
  const result = await remove('fixture');
  assert.equal(result.removed, true, 'completed configuration mutation must remain explicit');
  assert.equal(result.ok, false, 'failed live process termination must not be reported as a successful removal');
  assert.match(result.error, /could not be stopped/i);
}
await case_additional_tunnel_remove_failure();



async function case_mac_manual_update_shutdown_failure() {
  const assert = (await import('node:assert/strict')).default;
  const fs = (await import('node:fs')).default;
  const { runInNewContext } = await import('node:vm');
  const source = fs.readFileSync(new URL('../electron/desktop-host.js', import.meta.url), 'utf8');
  const begin = source.indexOf('  async function closeForManualMacUpdate() {');
  const end = source.indexOf('  async function prepareApplicationUpdate()', begin);
  for (const clean of [false, true]) {
    let exits = 0;
    let recovered = 0;
    const context = {
      isQuitting: false,
      shutdownCoordinator: { prepare: async () => ({ clean, serviceResult: { cleanup: { clean } } }) },
      recoverApplicationUpdate: async () => { recovered += 1; context.isQuitting = false; },
      app: { exit: () => { exits += 1; } }
    };
    const close = runInNewContext(source.slice(begin, end) + '\ncloseForManualMacUpdate', context);
    if (clean) await close();
    else await assert.rejects(close, /could not shut down safely/);
    assert.equal(exits, clean ? 1 : 0, 'manual macOS update must not exit on unconfirmed shutdown');
    assert.equal(recovered, clean ? 0 : 1, 'unclean shutdown must reopen the existing recovery path for retry');
    assert.equal(context.isQuitting, clean, 'failed shutdown must not leave the desktop permanently quitting');
  }
}
await case_mac_manual_update_shutdown_failure();


async function case_logout_connection_clear_failure() {
  const assert = (await import('node:assert/strict')).default;
  const fs = (await import('node:fs')).default;
  const { runInNewContext } = await import('node:vm');
  const profileSource = fs.readFileSync(new URL('../src/connectionProfile.js', import.meta.url), 'utf8');
  const clearBegin = profileSource.indexOf('function clearConnectionState(');
  const clearEnd = profileSource.indexOf('function localBaseUrl(', clearBegin);
  for (const mode of ['remove', 'truncate', 'partial-failure', 'double-failure']) {
    const removals = [];
    const writes = [];
    const clear = runInNewContext(profileSource.slice(clearBegin, clearEnd) + '\nclearConnectionState', {
      getEnvPath: () => 'fixture.env',
      getConnectionProfilePath: () => 'fixture.json',
      fs: {
        rmSync: target => { removals.push(target); if (mode !== 'remove') throw new Error('fixture locked'); },
        writeFileSync: (target, value) => { writes.push({ target, value }); if (mode === 'double-failure' || (mode === 'partial-failure' && target === 'fixture.env.bak')) throw new Error('fixture denied'); }
      }
    });
    const result = clear();
    assert.equal(result.ok, mode === 'remove' || mode === 'truncate', 'failure to remove and empty any saved state must not report success');
    assert.deepEqual(removals, ['fixture.env', 'fixture.env.bak', 'fixture.json', 'fixture.json.bak'], 'clearing must target only the canonical active files and their backups');
    assert.equal(writes.length, mode === 'remove' ? 0 : 4);
    assert.ok(writes.every(entry => entry.value === ''), 'locked-file fallback must erase content');
    if (!result.ok) assert.match(result.error, /could not be cleared/);
  }
  const hostSource = fs.readFileSync(new URL('../electron/desktop-host.js', import.meta.url), 'utf8');
  const begin = hostSource.indexOf('  async function logoutApplication(');
  const end = hostSource.indexOf('  async function quitApplication()', begin);
  for (const cleared of [false, true]) {
    const calls = { exits: 0, relaunches: 0, resets: 0, tray: 0, recovery: 0, networkStarts: 0 };
    const status = { serverRunning: false, tunnelStatus: 'stopped' };
    const context = {
      isQuitting: false,
      desktopPower: { getStatus: () => ({}) },
      taskActivityBlockReason: () => '',
      shutdownCoordinator: { prepare: async () => ({ clean: true }), reset: () => { calls.resets += 1; } },
      tunnelCredentials: { clear() {} },
      tunnelConnections: { clear() {} },
      connection: { clearConnectionState: () => ({ ok: cleared, error: cleared ? '' : 'Some saved connection data could not be cleared.' }) },
      desktopTray: { setup: () => { calls.tray += 1; } },
      recoveryWindowManager: { show: () => { calls.recovery += 1; } },
      setStatus: update => Object.assign(status, update),
      startServer: () => { calls.networkStarts += 1; },
      process: { argv: ['fixture-node', 'fixture-app'] },
      app: { relaunch: () => { calls.relaunches += 1; }, exit: () => { calls.exits += 1; } }
    };
    const logout = runInNewContext(hostSource.slice(begin, end) + '\nlogoutApplication', context);
    if (cleared) assert.equal((await logout()).ok, true);
    else await assert.rejects(() => logout(), /Logout did not finish.*could not be cleared/);
    assert.equal(calls.relaunches, cleared ? 1 : 0);
    assert.equal(calls.exits, cleared ? 1 : 0, 'failed logout must not exit while saved state remains');
    assert.equal(calls.networkStarts, 0, 'failed logout recovery must not reconnect the service');
    assert.equal(context.isQuitting, cleared);
    assert.equal(calls.resets, cleared ? 0 : 1);
    assert.equal(calls.tray, cleared ? 0 : 1);
    assert.equal(calls.recovery, cleared ? 0 : 1);
    if (!cleared) assert.equal(status.errorCode, 'connection_state_clear_failed');
  }
}
await case_logout_connection_clear_failure();

async function case_uniform_tunnel_management() {
  const assert = (await import('node:assert/strict')).default;
  const fs = (await import('node:fs')).default;
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const { runInNewContext } = await import('node:vm');
  const { createTunnelConnectionStore } = await import('../electron/tunnel-connections.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-uniform-tunnels-'));
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
  const store = createTunnelConnectionStore({ stateDir: directory, safeStorage });
  const original = 'tunnel_first123456';
  const second = 'tunnel_second123456';
  const renamed = 'tunnel_renamed123456';
  let config = { port: 3333, token: 'local-token', tunnelId: original };
  let key = 'runtime-first-123456';
  let reconnects = 0;
  let failReconnect = false;
  const settingsUpdates = [];
  const source = fs.readFileSync(new URL('../electron/desktop-host.js', import.meta.url), 'utf8');
  const begin = source.indexOf('  async function saveAdditionalTunnel(input = {}) {');
  const end = source.indexOf('  async function setKeepAwake(', begin);
  const handlers = runInNewContext(source.slice(begin, end) + '\n({ saveAdditionalTunnel, removeAdditionalTunnel })', {
    currentDesktopSettings: () => ({ ...config }),
    readGuiConfig: () => ({ ...config }),
    tunnelConnections: store,
    tunnelCredentials: { getApiKey: () => key, setApiKey: value => { key = value; }, clear: () => { key = ''; } },
    updateDesktopSettings: async (settings, options = {}) => {
      if (!options.allowExistingTunnel && store.list().some(item => item.tunnelId === settings.tunnelId)) throw new Error('Already configured');
      settingsUpdates.push(settings);
      config.tunnelId = settings.tunnelId;
      if (settings.tunnelApiKey) key = settings.tunnelApiKey;
      return { ok: true, status: { serverRunning: true } };
    },
    serviceRuntime: { isListening: () => true, restartAdditionalTunnels: async () => ({
      connections: store.list().filter(item => item.tunnelId !== config.tunnelId).map(item => ({ ...item, state: 'running' }))
    }) },
    additionalTunnelRuntime: { snapshot: () => ({ connections: [] }) },
    connection: {
      writeLaunchEnv: value => { config = { port: Number(value.REL_AI_MCP_PORT), token: value.REL_AI_MCP_TOKEN, tunnelId: value.REL_AI_MCP_TUNNEL_ID }; },
      writeConnectionProfile: () => {}
    },
    configModule: { getConfigPath: () => 'fixture' },
    options: { saveLauncherConfig: value => { config = { ...value }; } },
    restartConnection: async () => { reconnects++; if (failReconnect) { failReconnect = false; throw new Error('fixture reconnect failure'); } return { serverRunning: true, tunnelStatus: config.tunnelId ? 'running' : 'disabled' }; }
  });
  try {
    await handlers.saveAdditionalTunnel({ originalTunnelId: original, tunnelId: original, label: 'Personal', apiKey: '' });
    assert.equal(store.launcherLabel(original), 'Personal');
    assert.equal(key, 'runtime-first-123456', 'editing the first connection retains its encrypted key');
    await handlers.saveAdditionalTunnel({ tunnelId: second, label: 'School', apiKey: 'runtime-school-123456' });
    const changed = await handlers.saveAdditionalTunnel({ originalTunnelId: second, tunnelId: renamed, label: 'Work', apiKey: '' });
    assert.equal(changed.ok, true);
    assert.equal(store.runtimeConnections()[0].apiKey, 'runtime-school-123456', 'renaming an existing ID retains its stored key');
    assert.equal(store.list()[0].tunnelId, renamed);
    assert.equal(JSON.stringify(changed).includes('runtime-school-123456'), false);
    await assert.rejects(() => handlers.saveAdditionalTunnel({ originalTunnelId: original, tunnelId: renamed, label: 'Duplicate' }), /Already configured/);
    await handlers.removeAdditionalTunnel(original);
    assert.equal(config.tunnelId, renamed, 'removing the first row retains the other connection');
    assert.equal(settingsUpdates.at(-1).tunnelApiKey, 'runtime-school-123456');
    assert.equal(store.launcherLabel(renamed), 'Work');
    assert.equal(store.list().length, 0, 'promoted connection is not started twice');
    failReconnect = true;
    await assert.rejects(() => handlers.removeAdditionalTunnel(renamed), /fixture reconnect failure/);
    assert.equal(config.tunnelId, renamed, 'failed removal restores the previous connection');
    assert.equal(key, 'runtime-school-123456');
    await handlers.removeAdditionalTunnel(renamed);
    assert.equal(config.tunnelId, '', 'the final tunnel can be removed');
    assert.equal(config.port, 3333);
    assert.equal(config.token, 'local-token', 'removal retains local authentication');
    assert.equal(key, '', 'removal clears the final runtime key');
    assert.equal(reconnects, 3);
    await assert.rejects(() => handlers.saveAdditionalTunnel({ originalTunnelId: renamed, tunnelId: renamed, apiKey: 'runtime-old-123456' }), /no longer exists/);
    store.upsert({ tunnelId: renamed, label: 'Remaining connection', apiKey: 'runtime-remaining-123456' });
    const remaining = await handlers.saveAdditionalTunnel({ originalTunnelId: renamed, tunnelId: renamed, label: 'Edited without a launcher tunnel' });
    assert.equal(remaining.ok, true, 'remaining rows stay editable after removing the launcher connection');
    assert.equal(config.tunnelId, '');
    await handlers.removeAdditionalTunnel(renamed);
    const added = await handlers.saveAdditionalTunnel({ tunnelId: second, label: 'New connection', apiKey: 'runtime-new-123456' });
    assert.equal(added.ok, true, 'a tunnel can be added again after the final removal');
    assert.equal(config.tunnelId, second);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
await case_uniform_tunnel_management();

{
  const { deriveConnectionState } = await import('../src/contracts/connection.ts');
  const assert = (await import('node:assert/strict')).default;
  for (const tunnelStatus of ['failed', 'stopped']) {
    const connected = deriveConnectionState({ serverRunning: true, tunnelStatus,
      error: 'One tunnel is offline', errorCode: 'tunnel_authentication_failed',
      additionalTunnelStatuses: [{ tunnelId: 'tunnel_peer123456', state: 'running' }] });
    assert.equal(connected.publicEndpoint.status, 'available', 'any healthy tunnel establishes overall connectivity');
    assert.equal(connected.chatgptReadiness.status, 'ready');
    assert.equal(connected.error, null, 'individual tunnel errors belong in their connection rows');
  }
  assert.equal(deriveConnectionState({ serverRunning: true, tunnelStatus: 'failed',
    additionalTunnelStatuses: [{ state: 'running', enabled: false }] }).publicEndpoint.status, 'unavailable');
}
