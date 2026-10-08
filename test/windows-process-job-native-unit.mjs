import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('windows-process-job-native: skipped (requires Windows)');
  process.exit(0);
}
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = path.join(repository, 'src', 'windows-process-job.ps1');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const root = await fs.mkdtemp(path.join(process.env.REL_AI_EPHEMERAL_DIR || os.tmpdir(), 'relai-owned-job-native-'));
const results = [];
const ownedHelpers = new Set();
const ownedPtys = new Set();
const safetyDeadline = setTimeout(() => {
  for (const child of ownedHelpers) { try { child.kill(); } catch {} }
}, 120000);
safetyDeadline.unref();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(30);
  }
  throw new Error('Timed out: ' + label);
}
async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}
async function prepare(name, executable, args, options = {}) {
  const directory = path.join(root, name);
  await fs.mkdir(directory);
  const request = { protocol: 1, nonce: crypto.randomBytes(24).toString('hex'), executable, args, cwd: directory, ...options };
  request.environmentTransportKey = 'REL_AI_JOB_ENV_' + request.nonce;
  const files = { request: path.join(directory, 'request.json'), receipt: path.join(directory, 'receipt.json'), control: path.join(directory, 'control.json') };
  await fs.writeFile(files.request, JSON.stringify(request));
  const argv = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper, '-RequestPath', files.request, '-ReceiptPath', files.receipt, '-ControlPath', files.control];
  return { name, directory, request, files, argv };
}
function environmentFor(fixture, sentinel = true, targetEnvironment) {
  const env = targetEnvironment ?? { ...process.env, ...(sentinel ? { REL_AI_NATIVE_SENTINEL: 'exact env \u2603' } : {}) };
  const controllerEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'SystemDrive']) {
    const source = Object.keys(process.env).find((name) => name.toLowerCase() === key.toLowerCase());
    if (source) controllerEnv[source] = process.env[source];
  }
  controllerEnv[fixture.request.environmentTransportKey] = JSON.stringify({ protocol: 1, nonce: fixture.request.nonce, entries: Object.entries(env).filter(([, value]) => typeof value === 'string') });
  return controllerEnv;
}
async function launch(fixture, options = {}) {
  const env = environmentFor(fixture, true, options.targetEnvironment);
  if (options.payload !== undefined) env[fixture.request.environmentTransportKey] = options.payload;
  const companion = options.companion ?? process.argv.includes('--companion');
  const child = spawn(companion ? path.join(repository, 'src', 'windows-process-job-host.exe') : powershell,
    companion ? fixture.argv.slice(fixture.argv.indexOf('-RequestPath')) : fixture.argv,
    { cwd: repository, env, windowsHide: true, stdio: 'pipe' });
  ownedHelpers.add(child);
  const stdout = [], stderr = [];
  child.stdout.on('data', (data) => stdout.push(data));
  child.stderr.on('data', (data) => stderr.push(data));
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { ownedHelpers.delete(child); resolve({ code, signal }); });
  });
  // Startup observers still receive this rejection; attach before a spawn error can fire.
  void exited.catch(() => {});
  if (options.input) child.stdin.end(options.input);
  else child.stdin.end();
  return { ...fixture, child, exited, stdout, stderr };
}
async function stop(fixture, reason = 'stop', nonce = fixture.request.nonce) {
  const temporary = fixture.files.control + '.tmp';
  await fs.writeFile(temporary, JSON.stringify({ protocol: 1, nonce, action: 'stop', reason }));
  await fs.rename(temporary, fixture.files.control);
}
async function finish(fixture) {
  const outcome = await fixture.exited;
  const receipt = await readJson(fixture.files.receipt);
  assert.equal(receipt?.nonce, fixture.request.nonce, fixture.name + ' nonce');
  assert.equal(receipt?.final, true, fixture.name + ' final: ' + JSON.stringify({ outcome, receipt, helperStderr: Buffer.concat(fixture.stderr).toString() }));
  return { outcome, receipt, stdout: Buffer.concat(fixture.stdout), stderr: Buffer.concat(fixture.stderr) };
}
async function record(name, body) {
  if (process.argv.includes('--receipt-only') && !name.startsWith('receipt-')) return;
  if (process.argv.includes('--pty-only') && !name.startsWith('pty-')) return;
  if (process.argv.includes('--companion') && (name.startsWith('verified-assembly-')
    || name === 'pre-start-cancel-with-compilation-fallback' || name === 'job-attribute-setup-fails-before-target-creation')) return;
  const started = Date.now();
  const evidence = await body();
  results.push({ name, status: 'passed', elapsedMs: Date.now() - started, ...evidence });
  console.log(JSON.stringify(results.at(-1)));
}

const receiptLockScript = path.join(root, 'hold-receipt.ps1');
await fs.writeFile(receiptLockScript, [
  'param([string]$Receipt, [string]$Ready)',
  '$ErrorActionPreference = "Stop"',
  '$handle = [IO.File]::Open($Receipt, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)',
  'try {',
  '  [IO.File]::WriteAllText($Ready, "locked")',
  '  [void][Console]::In.ReadLine()',
  '} finally { $handle.Dispose() }'
].join('\n'));
async function lockReceipt(fixture) {
  const ready = path.join(fixture.directory, 'lock-ready');
  // The parent owns this lease through stdin. Cold controller startup cannot
  // expire it, and parent exit releases it through EOF. The caller's existing
  // bounded observation plus the suite safety deadline still bound the fixture.
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', receiptLockScript,
    '-Receipt', fixture.files.receipt, '-Ready', ready],
  { cwd: repository, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  ownedHelpers.add(child);
  let errorText = '';
  child.stderr.on('data', data => { errorText += data; });
  child.stdin.on('error', error => { errorText += error.message; });
  let outcome;
  const exited = new Promise(resolve => {
    child.once('error', error => { ownedHelpers.delete(child); outcome ??= { error }; resolve(outcome); });
    child.once('close', code => { ownedHelpers.delete(child); outcome ??= { code }; resolve(outcome); });
  });
  await poll(async () => {
    if (outcome) throw new Error('Receipt lock fixture exited: ' + (outcome.error?.message || errorText));
    try { await fs.access(ready); return true; } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return false;
    }
  }, 'receipt delete-sharing lock');
  return async () => {
    child.stdin.end();
    const result = await exited;
    assert.equal(result.code, 0, result.error?.message || errorText);
  };
}
async function withReceiptLock(fixture, body) {
  const unlock = await lockReceipt(fixture);
  let value, primaryError, cleanupError;
  try { value = await body(); } catch (error) { primaryError = error; }
  try { await unlock(); } catch (error) { cleanupError = error; }
  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError],
    'Receipt fixture failed: ' + primaryError.message + '; cleanup failed: ' + cleanupError.message);
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return value;
}
async function waitForBlockedReceipt(fixture, final, timeout = 20000) {
  const staged = fixture.files.receipt + '.' + fixture.child.pid + '.tmp';
  let terminal;
  void fixture.exited.then(outcome => { terminal = { outcome }; }, error => { terminal = { error }; });
  await poll(async () => {
    if (terminal) throw new Error('Controller exited before staged receipt: ' + JSON.stringify({
      outcome: terminal.outcome, error: terminal.error?.message,
      receipt: await readJson(fixture.files.receipt),
      stagedReceipt: await readJson(staged), stderr: Buffer.concat(fixture.stderr).toString()
    }));
    const value = await readJson(staged);
    return value && (final === undefined || value.final === final);
  }, 'staged atomic receipt', timeout);
  // Hold the already-acquired OS lock across publication, then release it well
  // inside the bounded production budget. The old one-shot publisher exits here.
  const remainedAlive = await Promise.race([
    fixture.exited.then(() => false), sleep(80).then(() => true)
  ]);
  assert.equal(remainedAlive, true, 'a brief delete-sharing lock must not terminate the owned job: ' + JSON.stringify({
    outcome: terminal?.outcome, stderr: Buffer.concat(fixture.stderr).toString()
  }));
}

const detachedScript = path.join(root, 'detached-root.cjs');
const heartbeatScript = path.join(root, 'heartbeat.cjs');
await fs.writeFile(heartbeatScript, "const fs=require('fs'); const file=process.argv[2]; const until=Date.now()+Number(process.argv[3]); const timer=setInterval(()=>{fs.appendFileSync(file,'x');if(Date.now()>until||fs.existsSync(file+'.release')){clearInterval(timer);process.exit(0)}},40);");
await fs.writeFile(detachedScript, "const {spawn}=require('child_process'); const fs=require('fs'); const child=spawn(process.execPath,[process.argv[2],process.argv[3],process.argv[4]],{detached:true,stdio:'ignore'}); fs.writeFileSync(process.argv[3]+'.pid',String(child.pid)); child.unref(); console.log('root-exit');process.exitCode=7;");
async function detached(name, milliseconds = 12000) {
  const f = await prepare(name, process.execPath, []);
  f.request.args = [detachedScript, heartbeatScript, path.join(f.directory, 'heartbeat'), String(milliseconds)];
  await fs.writeFile(f.files.request, JSON.stringify(f.request));
  return launch(f);
}
async function heartbeatSize(f) {
  try { return (await fs.stat(path.join(f.directory, 'heartbeat'))).size; } catch { return 0; }
}
try {

  for (const companion of [false, true]) {
    const mode = companion ? 'companion' : 'powershell';
    await record('receipt-observation-reports-early-exit-' + mode, async () => {
      const f = await prepare('receipt-early-exit-' + mode, process.execPath,
        ['-e', 'require("fs").writeFileSync("must-not-run", "bad")']);
      await fs.writeFile(f.files.receipt, JSON.stringify({ sentinel: 'original receipt' }));
      await fs.writeFile(f.files.request, JSON.stringify({ ...f.request, nonce: 'invalid' }));
      await assert.rejects(() => withReceiptLock(f, async () => {
        const launched = await launch(f, { companion });
        // Fresh hosted Windows runners can take longer than the normal receipt
        // polling budget to initialize the first Windows PowerShell process.
        await waitForBlockedReceipt(launched, undefined, companion ? 20000 : 90000);
      }), error => /Controller exited before staged receipt:/.test(error.message)
        && /"code":125/.test(error.message));
      await assert.rejects(fs.access(path.join(f.directory, 'must-not-run')), { code: 'ENOENT' });
      return { earlyExitReported: true, parentLeaseReleased: true };
    });
    await record('receipt-transient-startup-lock-' + mode, async () => {
      const f = await prepare('receipt-startup-lock-' + mode, process.execPath,
        ['-e', 'require("fs").appendFileSync("executions", "once")']);
      const previous = { sentinel: 'previous complete receipt' };
      await fs.writeFile(f.files.receipt, JSON.stringify(previous));
      let launched;
      await withReceiptLock(f, async () => {
        launched = await launch(f, { companion });
        await waitForBlockedReceipt(launched);
        assert.deepEqual(await readJson(f.files.receipt), previous, 'replacement stays atomic while locked');
        await assert.rejects(fs.access(path.join(f.directory, 'executions')), { code: 'ENOENT' });
      });
      const done = await finish(launched);
      assert.equal(done.outcome.code, 0, JSON.stringify(done.receipt));
      assert.equal(done.receipt.error, null);
      assert.equal(done.receipt.cleanupConfirmed, true);
      assert.equal(await fs.readFile(path.join(f.directory, 'executions'), 'utf8'), 'once');
      return { transientLockRecovered: true, targetStartedOnce: true };
    });
    await record('receipt-transient-final-lock-' + mode, async () => {
      const f = await launch(await prepare('receipt-final-lock-' + mode, process.execPath,
        ['-e', 'const fs=require("fs");setInterval(()=>{if(fs.existsSync("finish-target"))process.exit(0)},10)']), { companion });
      await poll(async () => (await readJson(f.files.receipt))?.commandStarted, 'receipt before final-publication lock');
      await withReceiptLock(f, async () => {
        await fs.writeFile(path.join(f.directory, 'finish-target'), 'finish');
        await waitForBlockedReceipt(f, true);
        assert.equal((await readJson(f.files.receipt)).final, false, 'old complete receipt survives blocked final publication');
      });
      const done = await finish(f);
      assert.equal(done.outcome.code, 0, JSON.stringify(done.receipt));
      assert.equal(done.receipt.error, null);
      assert.equal(done.receipt.activeProcesses, 0);
      assert.equal(done.receipt.cleanupConfirmed, true);
      return { transientLockRecovered: true, nativeZero: true };
    });
    await record('receipt-persistent-startup-lock-' + mode, async () => {
      const f = await prepare('receipt-permanent-lock-' + mode, process.execPath,
        ['-e', 'require("fs").writeFileSync("must-not-run", "bad")']);
      const previous = { sentinel: 'unchanged on permanent failure' };
      await fs.writeFile(f.files.receipt, JSON.stringify(previous));
      await withReceiptLock(f, async () => {
        const launched = await launch(f, { companion });
        let outcome;
        void launched.exited.then(value => { outcome = value; }, error => { outcome = { error }; });
        // The failure bound starts when the controller reaches atomic publication,
        // not while Windows PowerShell is still initializing on a cold runner.
        const staged = f.files.receipt + '.' + launched.child.pid + '.tmp';
        await poll(async () => outcome || await readJson(staged),
          'persistent receipt-lock publication attempt', companion ? 20000 : 90000);
        await poll(() => outcome, 'bounded persistent receipt-lock failure', 5000);
        assert.ifError(outcome.error);
        assert.equal(outcome.code, 125);
        assert.deepEqual(await readJson(f.files.receipt), previous);
        await assert.rejects(fs.access(path.join(f.directory, 'must-not-run')), { code: 'ENOENT' });
      });
      return { persistentFailureBounded: true, refusedBeforeTarget: true };
    });
  }


  for (const companion of [false, true]) {
    await record('opaque-json-strings-' + (companion ? 'companion' : 'powershell'), async () => {
      const values = ['2026-10-06T14:03:00Z', '/Date(1720000000000)/', '1e10', '', 'quotes " and slash \\', '\ud800', '\udfff', '\ud800x\udfff', '\ud83d\ude00'];
      const script = 'process.stdout.write(JSON.stringify({args:process.argv.slice(1),env:process.env.REL_AI_OPAQUE}))';
      const environment = { SystemRoot: process.env.SystemRoot, REL_AI_OPAQUE: values.join('|') };
      const f = await prepare('opaque-' + companion, process.execPath, ['-e', script, ...values]);
      const done = await finish(await launch(f, { companion, targetEnvironment: environment }));
      assert.equal(done.receipt.error, null, JSON.stringify(done.receipt));
      assert.deepEqual(JSON.parse(done.stdout), { args: values.map(value => value.toWellFormed()), env: environment.REL_AI_OPAQUE.toWellFormed() });
      assert.equal(done.receipt.cleanupConfirmed, true);
      return { stringsPreserved: true, nativeZero: true };
    });
    for (const malformed of ['{"protocol":1,"protocol":1}', '{"args":["\\uZZZZ"]}', '{"protocol":01}', '{} {}']) {
      await record('invalid-json-' + (companion ? 'companion' : 'powershell') + '-' + malformed, async () => {
        const f = await prepare('invalid-json-' + crypto.randomBytes(6).toString('hex'), process.execPath, ['-e', 'require("fs").writeFileSync("must-not-run","bad")']);
        await fs.writeFile(f.files.request, malformed);
        const launched = await launch(f, { companion });
        const outcome = await launched.exited;
        assert.notEqual(outcome.code, 0);
        await assert.rejects(fs.stat(path.join(f.directory, 'must-not-run')), { code: 'ENOENT' });
        return { refusedBeforeStart: true };
      });
    }
  }

  await record('verified-assembly-fast-path', async () => {
    const done = await finish(await launch(await prepare('assembly-fast', process.execPath, ['-e', 'process.stdout.write("verified")'])));
    assert.equal(done.receipt.nativeImplementation, 'precompiled');
    assert.equal(done.stdout.toString(), 'verified');
    assert.equal(done.stderr.length, 0);
    assert.equal(done.receipt.activeProcesses, 0);
    assert.equal(done.receipt.cleanupConfirmed, true);
    return { nativeImplementation: done.receipt.nativeImplementation, nativeZero: true };
  });
  const helperSource = await fs.readFile(helper, 'utf8');
  const assemblyPattern = /(\$nativeAssemblyBase64 = @'\r?\n)([\s\S]*?)(\r?\n'@)/;
  assert.ok(assemblyPattern.test(helperSource));
  for (const kind of ['missing', 'malformed', 'wrong-hash', 'stale-source', 'crlf']) {
    await record('verified-assembly-' + kind, async () => {
      let source = helperSource;
      if (kind === 'missing') source = source.replace(assemblyPattern, '$1$3');
      if (kind === 'malformed') source = source.replace(assemblyPattern, '$1%%%INVALID-BASE64%%%$3');
      if (kind === 'wrong-hash') source = source.replace(/\$nativeAssemblySha256 = '[a-f0-9]{64}'/, "$nativeAssemblySha256 = '" + '0'.repeat(64) + "'");
      if (kind === 'stale-source') source = source.replace("$native = @'\n", "$native = @'\n// Fixture-owned source change must invalidate the embedded assembly.\n");
      if (kind === 'crlf') source = source.replace(/\r?\n/g, '\r\n');
      const copiedHelper = path.join(root, 'assembly-' + kind + '.ps1');
      await fs.writeFile(copiedHelper, source);
      const f = await prepare('assembly-' + kind, process.execPath, ['-e', 'process.stdout.write("trusted-source")']);
      f.argv[f.argv.indexOf('-File') + 1] = copiedHelper;
      const done = await finish(await launch(f));
      assert.equal(done.receipt.nativeImplementation, kind === 'crlf' ? 'precompiled' : 'compiled');
      assert.equal(done.stdout.toString(), 'trusted-source');
      assert.equal(done.stderr.length, 0);
      assert.equal(done.receipt.activeProcesses, 0);
      assert.equal(done.receipt.cleanupConfirmed, true);
      return { nativeImplementation: done.receipt.nativeImplementation, nativeZero: true };
    });
  }
  await record('verified-assembly-concurrent-startup', async () => {
    const completed = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const done = await finish(await launch(await prepare('assembly-parallel-' + index,
        process.execPath, ['-e', 'process.stdout.write(' + JSON.stringify(String(index)) + ')'])));
      assert.equal(done.receipt.nativeImplementation, 'precompiled');
      assert.equal(done.stdout.toString(), String(index));
      assert.equal(done.stderr.length, 0);
      assert.equal(done.receipt.cleanupConfirmed, true);
      assert.equal(done.receipt.activeProcesses, 0);
      return { nonce: done.receipt.nonce, helperPid: done.receipt.helperPid, nativeZero: true };
    }));
    assert.equal(new Set(completed.map(item => item.nonce)).size, 4);
    assert.equal(new Set(completed.map(item => item.helperPid)).size, 4);
    return { independentJobs: completed };
  });
  await record('pre-start-cancel-with-compilation-fallback', async () => {
    const copiedHelper = path.join(root, 'cancel-fallback.ps1');
    await fs.writeFile(copiedHelper, helperSource.replace(assemblyPattern, '$1%%%INVALID-BASE64%%%$3'));
    const f = await prepare('cancel-fallback', process.execPath, ['-e', 'require("fs").writeFileSync("must-not-run","bad")']);
    f.argv[f.argv.indexOf('-File') + 1] = copiedHelper;
    await stop(f, 'cancel');
    const done = await finish(await launch(f));
    assert.equal(done.receipt.nativeImplementation, 'compiled');
    assert.equal(done.receipt.commandStarted, false);
    assert.equal(done.receipt.startupFailedBeforeCommand, true);
    assert.equal(done.receipt.cleanupConfirmed, true);
    await assert.rejects(fs.stat(path.join(f.directory, 'must-not-run')), { code: 'ENOENT' });
    return { receipt: done.receipt };
  });
  await record('literal-argv-cwd-env-binary-streams', async () => {
    const args = ['', 'two words', 'a"b', 'back\\slash', 'trailing\\', 'quote\\"tail\\', '\u65e5\u672c\u8a9e', 'line\nbreak'];
    const script = "const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{process.stdout.write(Buffer.concat(chunks));process.stderr.write(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),env:process.env.REL_AI_NATIVE_SENTINEL}));process.exitCode=23});";
    const bytes = Buffer.from([0, 255, 13, 10, 128, 65, 0]);
    const f = await launch(await prepare('literal', process.execPath, ['-e', script, ...args]), { input: bytes });
    const done = await finish(f);
    assert.deepEqual(done.stdout, bytes);
    assert.deepEqual(JSON.parse(done.stderr), { args, cwd: f.directory, env: 'exact env \u2603' });
    assert.equal(done.receipt.rootExitCode, 23);
    assert.match(done.receipt.rootCreationIdentity, /^win32:\d+$/);
    assert.equal(done.receipt.activeProcesses, 0);
    assert.equal(done.receipt.jobComplete, true);
    assert.equal(done.receipt.cleanupConfirmed, true);
    return { receipt: done.receipt, binaryBytes: done.stdout.length };
  });
  await record('native-uint32-exit-code', async () => {
    const f = await launch(await prepare('uint32-exit', process.execPath, ['-e', 'process.exit(-1)']));
    const done = await finish(f);
    assert.equal(done.receipt.rootExitCode, 4294967295);
    assert.equal(done.receipt.cleanupConfirmed, true);
    return { exactRootExitCode: done.receipt.rootExitCode, helperExitCode: done.outcome.code };
  });
  await record('prepared-verbatim-argv0', async () => {
    const script = 'console.log(JSON.stringify([process.argv0,...process.argv.slice(1)]))';
    const f = await launch(await prepare('verbatim', process.execPath, ['-e', script, '"two words"'], { argv0: 'custom root argv0', windowsVerbatimArguments: true }));
    const done = await finish(f);
    assert.deepEqual(JSON.parse(done.stdout), ['custom root argv0', 'two words']);
    return { exactArgv0AndVerbatimArgs: true };
  });
  await record('whole-environment-preserved', async () => {
    const expected = Object.fromEntries(Object.entries({ ...process.env, REL_AI_NATIVE_SENTINEL: 'exact env \u2603' }).filter(([, value]) => typeof value === 'string'));
    const canonical = (entries) => JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b, 'en')));
    const expectedHash = crypto.createHash('sha256').update(canonical(Object.entries(expected))).digest('hex');
    const script = "const crypto=require('crypto');const entries=Object.entries(process.env).sort(([a],[b])=>a.localeCompare(b,'en'));console.log(JSON.stringify({keys:entries.map(([key])=>key),hash:crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex')}))";
    const f = await launch(await prepare('environment', process.execPath, ['-e', script]));
    const done = await finish(f);
    const actual = JSON.parse(done.stdout);
    assert.equal(actual.hash, expectedHash, 'Environment differs; expected keys=' + JSON.stringify(Object.keys(expected).sort()) + '; actual keys=' + JSON.stringify(actual.keys));
    return { equal: true, variableCount: actual.keys.length };
  });
  await record('detached-child-natural-completion', async () => {
    const f = await detached('natural', 1200);
    const pending = await poll(async () => {
      const r = await readJson(f.files.receipt);
      return r?.rootExited && r.activeProcesses > 0 && r;
    }, 'root exited while child alive');
    assert.equal(pending.jobComplete, false);
    const done = await finish(f);
    assert.equal(done.receipt.rootExitCode, 7);
    assert.equal(done.receipt.activeProcesses, 0);
    assert.equal(done.receipt.jobComplete, true);
    return { pending, final: done.receipt, heartbeatBytes: await heartbeatSize(f) };
  });
  for (const reason of ['cancel', 'timeout', 'stop']) {
    await record('detached-child-' + reason, async () => {
      const f = await detached(reason);
      const pending = await poll(async () => {
        const r = await readJson(f.files.receipt);
        return r?.rootExited && r.activeProcesses > 0 && (await heartbeatSize(f)) > 0 && r;
      }, 'owned detached heartbeat before ' + reason);
      await stop(f, reason);
      const done = await finish(f);
      assert.equal(done.receipt.cleanupConfirmed, true);
      assert.equal(done.receipt.activeProcesses, 0);
      assert.equal(done.receipt.stopReason, reason);
      const size = await heartbeatSize(f);
      await sleep(200);
      assert.equal(await heartbeatSize(f), size);
      return { pending, final: done.receipt, stableHeartbeatBytes: size };
    });
  }
  await record('pre-existing-shared-fixture-remains-outside-job', async () => {
    const sharedHeartbeat = path.join(root, 'outside-job-heartbeat');
    const shared = spawn(process.execPath, [heartbeatScript, sharedHeartbeat, '12000'], { stdio: 'ignore' });
    ownedHelpers.add(shared);
    const sharedExited = new Promise((resolve) => shared.once('exit', (code) => { ownedHelpers.delete(shared); resolve(code); }));
    await poll(async () => { try { return (await fs.stat(sharedHeartbeat)).size > 0; } catch { return false; } }, 'shared fixture heartbeat');
    const f = await detached('shared-boundary');
    await poll(async () => { const r = await readJson(f.files.receipt); return r?.rootExited && r.activeProcesses > 0; }, 'separate owned child');
    await stop(f);
    const done = await finish(f);
    assert.equal(done.receipt.cleanupConfirmed, true);
    const before = (await fs.stat(sharedHeartbeat)).size;
    await sleep(200);
    const after = (await fs.stat(sharedHeartbeat)).size;
    assert.ok(after > before, 'Pre-existing fixture must still write after unrelated owned-job stop');
    await fs.writeFile(sharedHeartbeat + '.release', '');
    assert.equal(await sharedExited, 0);
    return { survivedUnrelatedJobStop: true, heartbeatBefore: before, heartbeatAfter: after };
  });
  await record('helper-crash-closes-exclusive-job-handle', async () => {
    const f = await detached('crash');
    await poll(async () => {
      const r = await readJson(f.files.receipt);
      return r?.rootExited && r.activeProcesses > 0 && (await heartbeatSize(f)) > 1 && r;
    }, 'owned detached child before helper crash');
    assert.equal(f.child.kill(), true); // This exact fixture-owned helper handle only.
    await f.exited;
    await sleep(200);
    const size = await heartbeatSize(f);
    await sleep(250);
    assert.equal(await heartbeatSize(f), size);
    const lastReceipt = await readJson(f.files.receipt);
    assert.equal(lastReceipt.final, false);
    assert.equal(lastReceipt.jobComplete, false);
    return { lastReceipt, stableHeartbeatBytes: size, interpretation: 'Observed cleanup; missing final receipt must remain uncertain in caller' };
  });
  await record('startup-failure-before-user-code', async () => {
    const f = await launch(await prepare('invalid-exe', path.join(root, 'does-not-exist.exe'), []));
    const done = await finish(f);
    assert.equal(done.receipt.commandStarted, false);
    assert.equal(done.receipt.startupFailedBeforeCommand, true);
    assert.equal(done.receipt.cleanupConfirmed, true);
    assert.ok(done.receipt.error);
    return { receipt: done.receipt };
  });
  await record('native-create-failure-before-user-code', async () => {
    const image = path.join(root, 'invalid-owned-image.exe');
    await fs.writeFile(image, 'This fixture is deliberately not a PE image.');
    const done = await finish(await launch(await prepare('invalid-native-image', image, [])));
    assert.equal(done.receipt.commandStarted, false);
    assert.equal(done.receipt.startupFailedBeforeCommand, true);
    assert.equal(done.receipt.cleanupConfirmed, true);
    assert.match(done.receipt.error, /CreateProcessW/);
    return { receipt: done.receipt };
  });
  await record('job-attribute-setup-fails-before-target-creation', async () => {
    const copiedHelper = path.join(root, 'unsupported-job-attribute.ps1');
    const source = await fs.readFile(helper, 'utf8');
    assert.equal(source.split('new IntPtr(0x0002000D)').length, 2);
    await fs.writeFile(copiedHelper, source.replace('new IntPtr(0x0002000D)', 'new IntPtr(0x7fffffff)'));
    const f = await prepare('unsupported-job-attribute', process.execPath, ['-e', 'require("fs").writeFileSync("must-not-run","bad")']);
    f.argv[f.argv.indexOf('-File') + 1] = copiedHelper;
    const done = await finish(await launch(f));
    assert.equal(done.receipt.commandStarted, false);
    assert.equal(done.receipt.rootPid, 0);
    assert.equal(done.receipt.nativeImplementation, 'compiled');
    assert.equal(done.receipt.startupFailedBeforeCommand, true);
    assert.equal(done.receipt.cleanupConfirmed, true);
    assert.match(done.receipt.error, /UpdateProcThreadAttribute\(job list\)/);
    await assert.rejects(fs.stat(path.join(f.directory, 'must-not-run')), { code: 'ENOENT' });
    return { receipt: done.receipt, faultInjection: 'Private helper copy with unsupported attribute; production source unchanged' };
  });
  await record('receipt-publication-fails-before-target', async () => {
    const f = await prepare('receipt-publication-failure', process.execPath,
      ['-e', "require('fs').writeFileSync('must-not-run', 'executed')"]);
    await fs.mkdir(f.files.receipt);
    const started = await launch(f);
    const outcome = await started.exited;
    assert.equal(outcome.code, 125);
    await assert.rejects(fs.access(path.join(f.directory, 'must-not-run')), { code: 'ENOENT' });
    return { refusedBeforeTarget: true, completionReceiptUnavailable: true };
  });
  await record('pre-start-cancel', async () => {
    const f = await prepare('pre-cancel', process.execPath, ['-e', 'require("fs").writeFileSync("must-not-run","bad")']);
    await stop(f, 'cancel');
    const done = await finish(await launch(f));
    assert.equal(done.receipt.commandStarted, false);
    assert.equal(done.receipt.startupFailedBeforeCommand, true);
    assert.equal(done.receipt.cleanupConfirmed, true);
    await assert.rejects(fs.stat(path.join(f.directory, 'must-not-run')), { code: 'ENOENT' });
    return { receipt: done.receipt };
  });
  for (const kind of ['oversized', 'wrong-nonce']) {
    await record('environment-payload-' + kind + '-fails-before-start', async () => {
      const f = await prepare('invalid-env-' + kind, process.execPath, ['-e', 'require("fs").writeFileSync("must-not-run","bad")']);
      const payload = kind === 'oversized' ? JSON.stringify({ protocol: 1, nonce: f.request.nonce, entries: [['LARGE', 'x'.repeat(24000)]] }) : JSON.stringify({ protocol: 1, nonce: '0'.repeat(48), entries: [] });
      const done = await finish(await launch(f, { payload }));
      assert.equal(done.receipt.commandStarted, false);
      assert.equal(done.receipt.startupFailedBeforeCommand, true);
      assert.equal(done.receipt.cleanupConfirmed, true);
      await assert.rejects(fs.stat(path.join(f.directory, 'must-not-run')), { code: 'ENOENT' });
      return { receipt: done.receipt };
    });
  }
  await record('stdout-cannot-spoof-completion', async () => {
    const script = 'process.stdout.write(JSON.stringify({protocol:1,jobComplete:true,final:true,nonce:"fake"}));setTimeout(()=>{},150);';
    const f = await launch(await prepare('spoof-stdout', process.execPath, ['-e', script]));
    const done = await finish(f);
    assert.match(done.stdout.toString(), /"nonce":"fake"/);
    assert.equal(done.receipt.nonce, f.request.nonce);
    return { receipt: done.receipt };
  });
  for (const control of ['stop', 'ctrl-c']) {
  await record('pty-input-resize-' + control, async () => {
    const { default: pty } = await import('node-pty');
    const script = "const readline=require('readline');console.log('PTY_READY');readline.createInterface({input:process.stdin}).on('line',line=>console.log('PTY_ECHO:'+line+':'+process.stdout.columns+':'+process.stdout.rows));process.on('SIGINT',()=>{console.log('TARGET_SIGINT');process.exit(31)});setTimeout(()=>process.exit(0),12000);";
    const f = await prepare('pty-' + control, process.execPath, ['-e', script]);
    const companion = process.argv.includes('--companion');
    const child = pty.spawn(companion ? path.join(repository, 'src', 'windows-process-job-host.exe') : powershell,
      companion ? f.argv.slice(f.argv.indexOf('-RequestPath')) : f.argv,
      { cwd: repository, env: environmentFor(f, false), cols: 80, rows: 24, useConpty: false });
    ownedHelpers.add(child);
    ownedPtys.add(child);
    let output = '';
    child.onData((data) => { output += data; });
    const exited = new Promise((resolve) => child.onExit((value) => { ownedHelpers.delete(child); resolve(value); }));
    await poll(() => output.includes('PTY_READY'), 'PTY ready', 4000).catch(async (error) => {
      throw new Error(error.message + ': ' + JSON.stringify({ output, receipt: await readJson(f.files.receipt) }));
    });
    child.resize(103, 33);
    await sleep(150);
    child.write('native-pty-fixture\r');
    await poll(() => output.includes('PTY_ECHO:native-pty-fixture:103:33'), 'PTY input and resize', 4000).catch(async (error) => {
      throw new Error(error.message + ': ' + JSON.stringify({ output, receipt: await readJson(f.files.receipt) }));
    });
    if (control === 'ctrl-c') {
      child.write('\x03');
      await poll(() => output.includes('TARGET_SIGINT'), 'target received Ctrl+C');
    } else await stop(f);
    await exited;
    const receipt = await readJson(f.files.receipt);
    assert.equal(receipt.final, true);
    assert.equal(receipt.cleanupConfirmed, true);
    assert.equal(receipt.activeProcesses, 0);
    if (control === 'ctrl-c') assert.equal(receipt.rootExitCode, 31);
    return { receipt, inputEchoAndResize: true };
  });
  }
  for (const [name, targetEnvironment] of [
    ['empty', {}],
    ['minimal', { SystemRoot: process.env.SystemRoot || process.env.windir }],
    ['synthetic', { SystemRoot: process.env.SystemRoot || process.env.windir, REL_AI_NATIVE_EMPTY: '', MiXeD_CASE_KEY: 'snowman \u2603 \u65e5\u672c', PSModulePath: '' }],
  ]) {
    await record('explicit-environment-' + name, async () => {
      const f = await launch(await prepare('env-' + name, process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))']), { targetEnvironment });
      const done = await finish(f);
      assert.equal(done.receipt.error, null, JSON.stringify(done.receipt));
      if (name === 'empty' && done.stdout.length === 0) {
        // Raw CreateProcess receives the requested empty environment. Unlike Node's
        // spawn normalizer, this native layer does not reinsert required OS values.
        assert.notEqual(done.receipt.rootExitCode, 0);
        assert.equal(done.receipt.commandStarted, true);
        assert.equal(done.receipt.cleanupConfirmed, true);
        return { targetDependencyFailureExit: done.receipt.rootExitCode, nativeCleanupConfirmed: true };
      }
      assert.ok(done.stdout.length > 0, JSON.stringify({ receipt: done.receipt, stderr: done.stderr.toString() }));
      assert.deepEqual(JSON.parse(done.stdout), targetEnvironment);
      assert.equal(done.receipt.cleanupConfirmed, true);
      return { equal: true, keys: Object.keys(targetEnvironment) };
    });
  }
  console.log(JSON.stringify({ suite: 'windows-process-job-native', status: 'passed', scratch: root, results }));
} catch (error) {
  console.error(JSON.stringify({ suite: 'windows-process-job-native', status: 'failed', scratch: root, results, error: error.stack,
    ...(error instanceof AggregateError ? { causes: error.errors.map(cause => cause.stack) } : {}) }));
  process.exitCode = 1;
} finally {
  clearTimeout(safetyDeadline);
  // Winpty owns additional session handles even after its root exits. These are
  // dedicated fixture consoles and must be disposed as well as their helper roots.
  for (const child of ownedPtys) {
    try { child.kill(); } catch {} finally { ownedHelpers.delete(child); }
    // Same pinned-node-pty workaround as processManager's production cleanup:
    // Winpty kill() leaves its dedicated conout worker alive in node-pty 1.1.0.
    const worker = child._agent?._conoutSocketWorker;
    if (typeof worker?._destroySocket === 'function') await worker._destroySocket();
    else worker?.dispose?.();
  }
  for (const child of ownedHelpers) {
    try { child.kill(); } catch { /* Verified own fixture helper; child self-expires as a second bound. */ }
  }
}
