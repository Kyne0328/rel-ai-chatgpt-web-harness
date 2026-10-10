import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { WindowsProcessJob, prepareWindowsProcessJob, restoreWindowsProcessJob } from '../src/windowsProcessJob.ts';
import { normalizeExecutionInvocation, resolveCommandCwd } from '../src/executionInvocation.ts';
import { makeProcessEnvironment } from '../src/processEnvironment.js';
import { runProcess, runOwnedReadOnlyProcess } from '../src/process.ts';
import { hostResourceStats } from '../src/hostResourceScheduler.js';
import { startManagedProcess, readManagedProcess, stopManagedProcess, sampleManagedProcessMemory } from '../src/processManager.ts';
import { once } from 'node:events';
import { runTestProcess } from './helpers/run-test-process.mjs';
import { syncBuiltinESMExports } from 'node:module';
import { GIT_EXECUTABLE } from './helpers/git-executable.mjs';

import { executeToolCall } from '../src/tools/execution.js';
import { OPERATION_IDS as OP } from '../src/tools/operationIds.js';
import { relaiExec } from '../src/bridge/exec.js';
import { planEdit } from '../src/executionPlanner.ts';
import { readGitObservation } from '../src/repo/gitObservation.ts';
import { listMutationProcessRecords, recordCurrentMutationProcess, removeMutationProcessRecord, runWithMutationProcessOwnership } from '../src/mutationProcessOwnership.js';

assert.equal(process.platform, 'win32', 'This is a Windows-only acceptance executable; run it in the native Windows gate.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-windows-bookkeeping-wrapper-'));
const workspace = { alias: 'native-bookkeeping', path: path.join(root, 'repo') };
fs.mkdirSync(workspace.path);
// Git observations canonicalize cwd; Windows CI TEMP can use an 8.3 alias.
const canonicalWorkspacePath = fs.realpathSync.native(workspace.path);
assert.deepEqual(resolveCommandCwd(workspace, '.'), { absolutePath: canonicalWorkspacePath, relativePath: '.' });
assert.throws(() => resolveCommandCwd(workspace, '..'), /cwd escapes the workspace/);
childProcess.execFileSync(GIT_EXECUTABLE, ['init', '-q'], { cwd: workspace.path, stdio: 'ignore' });
const config = { stateDir: path.join(root, 'state'), workspaces: { [workspace.alias]: { path: workspace.path, commands: {}, testCommands: {} } } };
const run = handler => executeToolCall({
  config, name: OP.EDIT, executionName: OP.EDIT,
  effectiveArgs: { workspace: workspace.alias, returnDiff: false }, context: {},
  definition: { behavior: { concurrencyScope: 'mutation' }, handler }, started: Date.now()
});
const originalSpawn = childProcess.spawn;
try {
  await assert.rejects(runOwnedReadOnlyProcess(process.execPath, ['-e', 'process.exit(0)'],
    { resourceClass: 'heavy' }, config), /caller-managed resource admission/);
  const beforeProbes = hostResourceStats().gitObservation.active;
  for (const phase of ['before-caller', 'root-exit-race']) {
    const controller = new AbortController();
    let probePid = 0;
    let intercepted = false;
    childProcess.spawn = function(command, args, options) {
      const requestFlag = args?.indexOf('-RequestPath') ?? -1;
      let targetProbe = false;
      if (!intercepted && requestFlag >= 0) {
        const requestPath = args[requestFlag + 1];
        const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
        targetProbe = request.cwd === canonicalWorkspacePath && request.args.includes('status');
        if (targetProbe) {
          intercepted = true;
          if (phase === 'before-caller') fs.writeFileSync(path.join(path.dirname(requestPath), 'control.json'),
            JSON.stringify({ protocol: request.protocol, nonce: request.nonce, action: 'stop', reason: 'timeout' }));
        }
      }
      const child = originalSpawn.call(this, command, args, options);
      if (targetProbe) {
        probePid = child.pid;
        const abort = () => controller.abort(new DOMException('Fixture probe cancellation ordering.', 'TimeoutError'));
        if (phase === 'before-caller') queueMicrotask(abort);
        else child.once('exit', abort);
      }
      return child;
    };
    syncBuiltinESMExports();
    try {
      const wrapped = await run(async () => {
        const probe = await readGitObservation(workspace.path, config, { signal: controller.signal, timeoutMs: 3000 });
        assert.equal(intercepted, true);
        assert.equal(probe.executed, phase === 'root-exit-race');
        assert.equal(probe.rootExitConfirmed, phase === 'root-exit-race');
        assert.equal(probe.terminationConfirmed, true, 'independent native job proves probe cleanup');
        assert.equal(probe.timedOut, true);
        assert.notEqual(probe.exitCode, 0, 'cancelled old status is never reused as successful evidence');
        assert.deepEqual(listMutationProcessRecords(config, workspace.alias), []);
        // Native read-only scope restores genuine mutation authority afterwards.
        recordCurrentMutationProcess(probePid);
        const marker = listMutationProcessRecords(config, workspace.alias);
        assert.equal(marker.length, 1);
        removeMutationProcessRecord(marker[0]); // Exact fixture job already has native-zero proof.
        return { ok: true, probe };
      });
      assert.equal(wrapped.value.ok, true);
    } finally { childProcess.spawn = originalSpawn; syncBuiltinESMExports(); }
    assert.equal(hostResourceStats().gitObservation.active, beforeProbes);
    const nextProbe = await readGitObservation(workspace.path, config, { timeoutMs: 3000 });
    assert.equal(nextProbe.exitCode, 0, 'confirmed cancelled probe does not permanently suspend accounting');
  }

  // Withhold only this fixture probe's final receipt. Real missing proof holds
  // capacity; later access to its unchanged native proof permits a fresh probe.
  const receiptMethod = WindowsProcessJob.prototype.receipt;
  let uncertainProbeJob;
  WindowsProcessJob.prototype.receipt = function(...args) {
    try {
      const request = JSON.parse(fs.readFileSync(path.join(this.directory, 'request.json'), 'utf8'));
      const receipt = JSON.parse(fs.readFileSync(path.join(this.directory, 'receipt.json'), 'utf8').replace(/^\uFEFF/, ''));
      if (request.cwd === canonicalWorkspacePath && request.args.includes('status') && receipt.final && receipt.commandStarted) {
        uncertainProbeJob ||= this;
        if (this === uncertainProbeJob) return null;
      }
    } catch {}
    return receiptMethod.apply(this, args);
  };
  let uncertainProbe;
  try {
    const wrapped = await run(async () => {
      uncertainProbe = await readGitObservation(workspace.path, config, { timeoutMs: 3000 });
      assert.equal(uncertainProbe.executed, true);
      assert.equal(uncertainProbe.terminationConfirmed, false);
      assert.notEqual(uncertainProbe.exitCode, 0);
      assert.equal(uncertainProbe.observedExitCode, 0);
      assert.deepEqual(listMutationProcessRecords(config, workspace.alias), []);
      return { ok: true, probe: uncertainProbe };
    });
    assert.equal(wrapped.value.ok, true);
    assert.equal(hostResourceStats().gitObservation.active, beforeProbes + 1);
    const suspended = await readGitObservation(workspace.path, config);
    assert.equal(suspended.executed, false);
    assert.match(suspended.error, /suspended/);
    const degradedAccounting = await run((_config, _args, context) => relaiExec(workspace, config, {
      executable: process.execPath,
      argv: ['-e', 'require("node:fs").writeFileSync("while-proof-missing.txt", "owned success")']
    }, context));
    assert.equal(degradedAccounting.value.commandSucceeded, true);
    assert.equal(degradedAccounting.value.terminationConfirmed, true);
    assert.equal(fs.readFileSync(path.join(workspace.path, 'while-proof-missing.txt'), 'utf8'), 'owned success');
    assert.equal(degradedAccounting.value.mutationUnknown, true);
    assert.equal(degradedAccounting.value.mutationTracking, 'unavailable');
    assert.deepEqual(degradedAccounting.value.changedFiles, []);
    assert.equal(hostResourceStats().gitObservation.active, beforeProbes + 1);
  } finally { WindowsProcessJob.prototype.receipt = receiptMethod; }
  assert.equal(uncertainProbeJob.outcome().exited, true, 'late evidence is actual unchanged native-zero proof');
  const recoveredProbe = await readGitObservation(workspace.path, config, { timeoutMs: 3000 });
  assert.equal(recoveredProbe.exitCode, 0);
  assert.equal(hostResourceStats().gitObservation.active, beforeProbes);
  assert.equal(fs.existsSync(uncertainProbeJob.directory), false);
  assert.equal(uncertainProbe.terminationConfirmed, false, 'reconciliation does not rewrite the old failed observation');
  assert.notEqual(uncertainProbe.exitCode, 0);
  const restoredAccounting = await run((_config, _args, context) => relaiExec(workspace, config, {
    executable: process.execPath,
    argv: ['-e', 'require("node:fs").writeFileSync("after-late-proof.txt", "accounted success")']
  }, context));
  assert.equal(restoredAccounting.value.commandSucceeded, true);
  assert.equal(restoredAccounting.value.mutationTracking, 'git');
  assert.notEqual(restoredAccounting.value.mutationUnknown, true);
  assert.deepEqual(restoredAccounting.value.changedFiles, ['after-late-proof.txt']);
  const reloaded = await import('../src/mutationProcessOwnership.js?native-reload=' + Date.now());
  assert.deepEqual(reloaded.listMutationProcessRecords(config, workspace.alias), []);
  const next = await run((_config, _args, context) => planEdit(workspace, config,
    { path: 'next.txt', content: 'next operation\n', returnDiff: false }, context));
  assert.equal(next.value.ok, true);
  assert.equal(fs.readFileSync(path.join(workspace.path, 'next.txt'), 'utf8'), 'next operation\n');
  console.log('Independent native probes: prestart/root-exit cancellation, missing-proof capacity retention, late exact-proof reconciliation, and fresh same-workspace mutation accounting passed.');

  // No native child is launched by these normalization/recovery controls.
  {
    const root=fs.mkdtempSync(path.join(process.env.REL_AI_EPHEMERAL_DIR||os.tmpdir(),'relai-job-adapter-'));
    const env=makeProcessEnvironment({REL_AI_FIXTURE:'target-only',PSModulePath:'fixture-target-only',PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH});
    const config={stateDir:path.join(root,'state')};
    let count=0;
    async function prepare(executable,args,extra={}){const j=await prepareWindowsProcessJob(config,{executable,args,cwd:root,env,...extra});const r=JSON.parse(fs.readFileSync(path.join(j.directory,'request.json'),'utf8'));assert.equal(r.environment,undefined);assert.equal(r.environmentTransportKey,'REL_AI_JOB_ENV_'+r.nonce);assert.equal(j.environment.REL_AI_FIXTURE,undefined);const payload=JSON.parse(j.environment[r.environmentTransportKey]);assert.equal(payload.nonce,r.nonce);assert.equal(new Map(payload.entries).get('REL_AI_FIXTURE'),'target-only');count++;return{j,r};}
    try{
    const direct=await prepare(process.execPath,['-e','process.exit(0)','spaces and quote "','unicode ā','']);
    assert.equal(direct.r.executable.toLowerCase(),process.execPath.toLowerCase());assert.deepEqual(direct.r.args,['-e','process.exit(0)','spaces and quote "','unicode ā','']);
    const cmd=path.join(root,'literal.cmd');fs.writeFileSync(cmd,'@echo off\r\nexit /b 0\r\n');const batch=await prepare(cmd,['spaces and quote "']);assert.match(batch.r.executable,/cmd.exe$/i);assert.equal(batch.r.windowsVerbatimArguments,true);
    const shebang=path.join(root,'literal-script.js');fs.writeFileSync(shebang,'#!/usr/bin/env node\nprocess.exit(0)');const script=await prepare(shebang,[]);assert.match(script.r.executable,/node.exe$/i);assert.equal(script.r.args[0],shebang);
    const npm=normalizeExecutionInvocation({executable:'npm',argv:['--version']});const npmJob=await prepare(npm.processExecutable,npm.processArgv);assert.match(npmJob.r.executable,/node.exe$/i);
    const shell=await prepare('cmd.exe',[],{shellCommand:'echo fixture'});assert.match(shell.r.rawCommandLine,/\/d \/s \/c "echo fixture"$/);
    const long=await prepare(process.execPath,['ā'.repeat(17000)]);long.j.bind(12345);assert.ok(fs.statSync(path.join(long.j.directory,'request.json')).size>16384);const restored=restoreWindowsProcessJob(long.j.directory,12345);assert.ok(restored);assert.equal(restored.outcome().exited,false);
    const receipt={protocol:1,nonce:long.r.nonce,helperPid:12345,final:true,activeProcesses:0,jobComplete:true,cleanupConfirmed:true,rootExited:true,rootExitCode:4294967295,commandStarted:true};fs.writeFileSync(path.join(long.j.directory,'receipt.json'),JSON.stringify({...receipt,nonce:'wrong'}));assert.equal(restored.outcome().exited,false);fs.writeFileSync(path.join(long.j.directory,'receipt.json'),JSON.stringify({...receipt,helperPid:54321}));assert.equal(restored.outcome().exited,false);fs.writeFileSync(path.join(long.j.directory,'receipt.json'),JSON.stringify({...receipt,final:false}));assert.equal(restored.outcome().exited,false,'intermediate evidence is never cached as completion');fs.writeFileSync(path.join(long.j.directory,'receipt.json'),JSON.stringify(receipt));assert.equal(restored.receipt().rootExitCode,4294967295);assert.equal(restored.outcome().exited,true);assert.equal(Object.isFrozen(restored.receipt()),true);assert.throws(()=>{restored.receipt().activeProcesses=1;},TypeError);assert.equal(restored.outcome().exited,true);assert.equal(restored.cleanup(),true);assert.equal(fs.existsSync(long.j.directory),false);assert.equal(restored.outcome().exited,true,'verified terminal proof survives our own receipt cleanup');assert.equal((await restored.stop('stop',1000)).exited,true,'repeated stop preserves verified completion');restored.bind(54321);assert.equal(restored.outcome().exited,false,'a changed controller identity cannot reuse cached completion');
    await assert.rejects(prepareWindowsProcessJob(config,{executable:process.execPath,args:[],cwd:root,env:{BIG:'x'.repeat(24001)}}),/transport limit/);
    console.log(JSON.stringify({normalizationCases:count,longRecovery:true,missingStaleReceipt:true,cleanup:true,oversizeRefusedBeforeExecution:true,environmentSeparation:true,nativeCommandsExecuted:0}));
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  }


  // Cancellation before caller resume is a normal outcome. Write control before
  // launching the real controller so these cases do not depend on a sleep race.
  for (const reason of ['cancel', 'timeout', 'setup-failure']) {
    const startupAbort = new AbortController();
    let injected = false;
    childProcess.spawn = function(command, args, options) {
      const requestFlag = args?.indexOf('-RequestPath') ?? -1;
      if (!injected && requestFlag >= 0) {
        const requestPath = args[requestFlag + 1];
        const relative = path.relative(config.stateDir, requestPath);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
        assert.equal(request.cwd, workspace.path);
        if (reason === 'setup-failure') {
          fs.writeFileSync(requestPath, JSON.stringify({ ...request, executable: path.join(root, 'missing-fixture.exe') }));
        } else {
          fs.writeFileSync(path.join(path.dirname(requestPath), 'control.json'),
            JSON.stringify({ protocol: request.protocol, nonce: request.nonce, action: 'stop', reason }));
        }
        injected = true;
      }
      return originalSpawn.call(this, command, args, options);
    };
    syncBuiltinESMExports();
    let result;
    try {
      result = await run(async () => ({ ok: true, ...await runProcess(process.execPath,
        ['-e', 'process.stdout.write("caller-started")'], {
          cwd: workspace.path, timeout: 10000, signal: startupAbort.signal,
          onPhase(event) {
            if (event.phase === 'spawned' && reason !== 'setup-failure') {
              startupAbort.abort(new DOMException('Fixture pre-start ' + reason, reason === 'timeout' ? 'TimeoutError' : 'AbortError'));
            }
          }
        }, config) }));
    } finally {
      childProcess.spawn = originalSpawn;
      syncBuiltinESMExports();
    }
    assert.equal(injected, true);
    assert.equal(result.value.executed, false, 'final native refusal proves caller code never started');
    assert.equal(result.value.stdout, '');
    assert.equal(result.value.terminationConfirmed, true);
    assert.deepEqual(listMutationProcessRecords(config, workspace.alias), []);
    assert.deepEqual(fs.readdirSync(path.join(config.stateDir, 'process-jobs')), []);
    if (reason === 'setup-failure') {
      assert.equal(result.value.spawnError, true, 'genuine startup failure remains a spawn error');
      assert.notEqual(result.value.cancelled, true);
      assert.equal(result.value.timedOut, false);
    } else {
      assert.notEqual(result.value.spawnError, true);
      assert.equal(result.value.cancelled === true, reason === 'cancel');
      assert.equal(result.value.timedOut, reason === 'timeout');
    }
  }

  // Withhold an actual completed receipt from runProcess only. Missing evidence
  // must not assert that the caller never ran or release durable uncertainty.
  {
    const receiptMethod = WindowsProcessJob.prototype.receipt;
    let completedJob;
    WindowsProcessJob.prototype.receipt = function(...args) {
      const receipt = receiptMethod.apply(this, args);
      if (receipt?.final && receipt.commandStarted) { completedJob = this; return null; }
      return receipt;
    };
    let result;
    try {
      result = await runWithMutationProcessOwnership(config, workspace.alias, () =>
        runProcess(process.execPath, ['-e', 'process.stdout.write("caller-ran")'],
          { cwd: workspace.path, timeout: 10000 }, config));
    } finally { WindowsProcessJob.prototype.receipt = receiptMethod; }
    assert.equal(result.executed, true, 'missing final evidence cannot mean caller never executed');
    assert.equal(result.stdout, 'caller-ran');
    assert.equal(result.terminationConfirmed, false);
    const retained = listMutationProcessRecords(config, workspace.alias);
    assert.equal(retained.length, 1);
    assert.equal(retained[0].terminationUncertain, true);
    // Restoration exposes the real native-zero receipt. This is fixture-only
    // cleanup after positive proof; no recovery reset or real record is touched.
    assert.equal(completedJob.outcome().exited, true);
    assert.equal(completedJob.cleanup(), true);
    removeMutationProcessRecord(retained[0]);
    assert.deepEqual(listMutationProcessRecords(config, workspace.alias), []);
  }

  const echoArgs = path.join(workspace.path, 'literal-args.js');
  fs.writeFileSync(echoArgs, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  const batchCommand = path.join(workspace.path, 'literal-args.cmd');
  fs.writeFileSync(batchCommand, '@echo off\r\n@"' + process.execPath + '" "' + echoArgs + '" %*\r\n');
  const shebangCommand = path.join(workspace.path, 'literal-shebang.js');
  fs.writeFileSync(shebangCommand, '#!/usr/bin/env node\nprocess.stdout.write("shebang-ok")');
  const literalArgs = ['alpha beta', 'quote"q', 'ā', ''];
  const invocation = normalizeExecutionInvocation({ executable: 'npm', argv: ['--version'] });
  const compatEnv = { PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH };
  const compatibilityCases = [
    [process.execPath, [echoArgs, ...literalArgs], {}, JSON.stringify(literalArgs)],
    [batchCommand, literalArgs, {}, JSON.stringify(literalArgs)],
    [shebangCommand, [], {}, 'shebang-ok'],
    [process.env.ComSpec, ['/d', '/s', '/c', 'echo direct-cmd-ok'], {}, 'direct-cmd-ok'],
    ['cmd.exe', [], { shell: true, commandString: 'echo shell-ok' }, 'shell-ok'],
    [invocation.processExecutable, invocation.processArgv, {}, /^\d+\.\d+\.\d+/]
  ];
  const compatibilityStarted = performance.now();
  for (const [executable, args, options, expected] of compatibilityCases) {
    const result = await run(async () => ({ ok: true, ...await runProcess(executable, args,
      { cwd: workspace.path, env: compatEnv, timeout: 15000, ...options }, config) }));
    assert.equal(result.value.exitCode, 0, JSON.stringify(result.value));
    assert.equal(result.value.terminationConfirmed, true);
    if (expected instanceof RegExp) assert.match(result.value.stdout, expected);
    else assert.equal(result.value.stdout, expected);
  }
  console.log(JSON.stringify({ nativeCompatibilityCases: compatibilityCases.length, totalStartupAndExecutionMs: performance.now() - compatibilityStarted }));

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const until = async predicate => {
    const deadline = Date.now() + 12000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('Owned job fixture observation timed out.');
      await sleep(20);
    }
  };
  const launcher = path.join(workspace.path, 'job-launcher.cjs');
  const descendant = path.join(workspace.path, 'job-descendant.cjs');
  fs.writeFileSync(descendant, `const fs=require('node:fs');const [dir]=process.argv.slice(2);let beat=0;
fs.writeFileSync(dir+'/child.json',JSON.stringify({pid:process.pid}));
setInterval(()=>{fs.writeFileSync(dir+'/heartbeat',String(++beat));if(fs.existsSync(dir+'/release-child'))process.exit(0);},20);
setTimeout(()=>process.exit(0),10000);`);
  fs.writeFileSync(launcher, `const fs=require('node:fs');const {spawn}=require('node:child_process');const [child,dir]=process.argv.slice(2);
spawn(process.execPath,[child,dir],{detached:true,stdio:'ignore',windowsHide:true}).unref();
setInterval(()=>{if(fs.existsSync(dir+'/release-root'))process.exit(0);},20);setTimeout(()=>process.exit(0),12000);`);
  const onceDir = path.join(workspace.path, 'once-case'); fs.mkdirSync(onceDir);
  let onceSettled = false;
  const beforeHeavy = hostResourceStats().heavy.active;
  const owned = run(async () => ({ ok: true, ...await runProcess(process.execPath, [launcher, descendant, onceDir],
    { cwd: workspace.path, resourceClass: 'heavy', timeout: 15000 }, config) }));
  const observed = owned.then(value => { onceSettled = true; return { value }; }, error => { onceSettled = true; return { error }; });
  let childPid = 0;
  try {
    await until(() => fs.existsSync(path.join(onceDir, 'child.json')));
    childPid = JSON.parse(fs.readFileSync(path.join(onceDir, 'child.json'), 'utf8')).pid;
    fs.writeFileSync(path.join(onceDir, 'release-root'), '');
    await sleep(200);
    assert.equal(alive(childPid), true);
    assert.equal(onceSettled, false, 'one-shot completion waits for its owned detached child');
    assert.equal(listMutationProcessRecords(config, workspace.alias).length, 1);
    assert.equal(hostResourceStats().heavy.active, beforeHeavy + 1);
    fs.writeFileSync(path.join(onceDir, 'release-child'), '');
    const outcome = await observed;
    if (outcome.error) throw outcome.error;
    assert.equal(outcome.value.value.exitCode, 0);
    assert.equal(outcome.value.value.terminationConfirmed, true);
    assert.equal(listMutationProcessRecords(config, workspace.alias).length, 0);
    assert.equal(hostResourceStats().heavy.active, beforeHeavy);
    assert.deepEqual(fs.readdirSync(path.join(config.stateDir, 'process-jobs')), [], 'normal job request/receipt directories are removed');
  } finally {
    fs.writeFileSync(path.join(onceDir, 'release-root'), '');
    fs.writeFileSync(path.join(onceDir, 'release-child'), '');
    await observed;
    if (childPid) await until(() => !alive(childPid));
  }
  const managedDir = path.join(workspace.path, 'managed-case'); fs.mkdirSync(managedDir);
  const owner = { principal: { clientId: 'native-job-fixture', authMode: 'oauth' }, workspace: workspace.alias };
  const beforePersistent = hostResourceStats().persistent.active;
  const managed = await startManagedProcess(workspace, config, {
    executable: process.execPath, argv: [launcher, descendant, managedDir], startupWaitMs: 0, reuseExisting: false,
    kind: 'service', purpose: 'Verify owned native job lifetime after launcher root exit.'
  }, owner);
  let managedChildPid = 0;
  try {
    // Reproduce a bounded diagnostic timeout deterministically. Ownership and
    // descendant cleanup must still work when memory measurement is unknown;
    // process-root-memory-unit.mjs separately verifies the real native probe.
    const originalExecFile = childProcess.execFile;
    let memoryProbes = 0;
    childProcess.execFile = function(executable, args, options, callback) {
      if (!args?.some(value => String(value).includes('RelAiManagedRootMemoryV1'))) {
        return originalExecFile.call(this, executable, args, options, callback);
      }
      memoryProbes += 1;
      queueMicrotask(() => callback(Object.assign(new Error('Fixture memory probe timeout'), { code: 'ETIMEDOUT' }), '', ''));
      return { kill() { return true; } };
    };
    syncBuiltinESMExports();
    let memory;
    try { memory = await sampleManagedProcessMemory(config, {}, owner); }
    finally { childProcess.execFile = originalExecFile; syncBuiltinESMExports(); }
    assert.equal(memoryProbes, 1);
    const measured = memory.roots.find(item => item.processId === managed.processId);
    assert.equal(measured.pid, managed.pid, 'memory sampling uses caller root rather than private controller PID');
    assert.equal(measured.identityVerified, false);
    assert.equal(measured.reason, 'probe_failed_or_timed_out', JSON.stringify(measured));
    assert.equal(measured.measurementStatus, 'unknown');
    assert.equal(measured.privateBytes, null);
    assert.equal(measured.workingSetBytes, null);
    assert.equal(measured.sampledAt, null);
    await until(() => fs.existsSync(path.join(managedDir, 'child.json')));
    managedChildPid = JSON.parse(fs.readFileSync(path.join(managedDir, 'child.json'), 'utf8')).pid;
    fs.writeFileSync(path.join(managedDir, 'release-root'), '');
    await until(() => readManagedProcess(config, { processId: managed.processId }, owner).rootExitConfirmed === true);
    const running = readManagedProcess(config, { processId: managed.processId }, owner);
    assert.equal(running.status, 'running');
    assert.equal(alive(managedChildPid), true);
    assert.equal(hostResourceStats().persistent.active, beforePersistent + 1);
    const stopped = await stopManagedProcess(config, { processId: managed.processId }, owner);
    assert.equal(stopped.duplicate, false, 'stable managed ID still owns its descendants after root exit');
    assert.equal(stopped.terminationConfirmed, true);
    await until(() => !alive(managedChildPid));
    assert.equal(hostResourceStats().persistent.active, beforePersistent);
  } finally {
    fs.writeFileSync(path.join(managedDir, 'release-root'), '');
    fs.writeFileSync(path.join(managedDir, 'release-child'), '');
    await stopManagedProcess(config, { processId: managed.processId }, owner);
    if (managedChildPid) await until(() => !alive(managedChildPid));
  }

  // This assertion belongs to the Windows gate even though byte-tail controls
  // also run in the everyday platform-neutral suite.
  {
    const runnerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-windows-test-job-'));
    const marker = path.join(runnerRoot, 'completed.txt');
    const childCode = 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "owned-complete"), 700);';
    const parentCode = 'const child = require("node:child_process").spawn(process.execPath, ["-e", ' + JSON.stringify(childCode) + ', ' + JSON.stringify(marker) + '], {detached:true,stdio:"ignore"}); child.unref();';
    try {
      const finite = await runTestProcess(process.execPath, ['-e', parentCode], { timeoutMs: 10000 });
      assert.equal(finite.exitCode, 0, finite.error?.message);
      assert.equal(finite.terminationUncertain, false);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'owned-complete');
      const timeout = await runTestProcess(process.execPath, ['-e', 'setInterval(() => {}, 100)'], { timeoutMs: 1000 });
      assert.equal(timeout.timedOut, true);
      assert.equal(timeout.exitCode, 1);
      assert.equal(timeout.terminationUncertain, false);
      let ownedJob;
      const uncertain = await runTestProcess(process.execPath, ['-e', 'setInterval(() => {}, 100)'], {
        timeoutMs: 1000,
        terminate: async (child, options) => {
          ownedJob = options.ownerJob;
          assert.ok(ownedJob);
          const actual = await ownedJob.stop('timeout', 3000);
          if (child.exitCode === null && child.signalCode === null) await once(child, 'close');
          assert.equal(actual.exited, true);
          return { ...actual, exited: false };
        }
      });
      assert.equal(uncertain.terminationUncertain, true);
      assert.equal(ownedJob.outcome().exited, true, 'synthetic uncertainty leaves no actual child alive');
      assert.equal(ownedJob.cleanup(), true);
      fs.rmdirSync(path.dirname(ownedJob.directory));
    } finally { fs.rmSync(runnerRoot, { recursive: true, force: true }); }
  }

  console.log('Windows native job integration retains mutation/managed ownership after root exit, confirms final job cleanup, and preserves normalization/recovery contracts.');

  console.log('Windows full wrapper: uncertain read-only probe, persisted-state reload, and next same-workspace mutation passed.');
} finally {
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
  fs.rmSync(root, { recursive: true, force: true });
}
