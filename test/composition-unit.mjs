// Dedicated process: Worker capacity, cancellation and configuration/task globals
// must be isolated from suites that exercise the same execution authorities.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import { composeTools, COMPOSITION_LIMITS } from '../src/tools/composition.js';
import { callTool } from '../src/tools.js';
import { getToolSchemas } from '../src/tools/schema.js';
import { invokeRelaiTool } from '../src/mcp/toolInvocation.js';
import { validateToolOutput } from '../src/tools/outputValidation.js';
import { createConsentPolicy } from '../src/mcp/authorizationPolicy.ts';
import { resetTaskHistoryCaches } from '../src/taskHistoryStorage.ts';
import { fallbackExecutionStatus, resetFallbackExecutions, startFallbackExecution } from '../src/mcp/fallbackExecutions.js';
import { outputSpillOwner, readOutputSpill } from '../src/outputSpill.js';
import { principalFingerprint } from '../src/mcp/principal.ts';
import { flushAuditWrites } from '../src/audit.js';
import { repositoryIntelligence } from '../src/repository/intelligence/service.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-composition-'));
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, 'a.txt'), 'alpha\n');
fs.writeFileSync(path.join(workspace, 'b.txt'), 'beta\n');
const configPath = path.join(root, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({ version: 2, stateDir: path.join(root, 'state'),
  auditLogPath: path.join(root, 'audit.jsonl'), workspaces: {
    app: { path: workspace, commands: {}, testCommands: {} },
    other: { path: root, commands: {}, testCommands: {} }
  } }));
const previousConfig = process.env.REL_AI_MCP_CONFIG;
process.env.REL_AI_MCP_CONFIG = configPath;
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const context = { principal: 'local:trusted', publicHttpOnly: true };
const run = (code, extra = {}, request = context) => callTool('relai_compose', { workspace: 'app', code, ...extra }, request);
const isolated = (code, invokeTool = async () => ({ ok: true }), extra = {}) => composeTools(config, { code }, { principal: 'local:trusted', invokeTool, ...extra });

after(async () => {
  resetFallbackExecutions();
  await flushAuditWrites();
  await repositoryIntelligence.shutdown();
  if (previousConfig === undefined) delete process.env.REL_AI_MCP_CONFIG; else process.env.REL_AI_MCP_CONFIG = previousConfig;
  resetTaskHistoryCaches();
  assert.equal(path.dirname(root), os.tmpdir());
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('public discovery and isolated JavaScript expose schemas and explicit output only', async () => {
  const schema = getToolSchemas().find(tool => tool.name === 'relai_compose');
  assert.ok(schema?.inputSchema.properties.code);
  const result = await run(`
    const read = ALL_TOOLS.find(tool => tool.name === 'relai_read');
    text({ schema: Boolean(read.inputSchema.properties.paths),
      isolated: [typeof process, typeof require, typeof fetch, typeof setTimeout],
      protected: Object.isFrozen(tools) && Object.isFrozen(ALL_TOOLS), sum: 2 + 2 });
    return 'unemitted result';
  `);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.outputs[0].text), { schema: true, isolated: ['undefined', 'undefined', 'undefined', 'undefined'], protected: true, sum: 4 });
  assert.equal(JSON.stringify(result).includes('unemitted result'), false);
  await validateToolOutput(config, 'relai_compose', { code: 'text(1)' }, result);
  const silent = await run('42;');
  assert.deepEqual(silent.outputs, []);
  assert.deepEqual(silent.calls, []);
});

test('parallel children actually overlap and dependent calls consume prior results', async () => {
  const waiting = new Map();
  let maximum = 0;
  const result = await isolated(`
    const results = await Promise.all(['a', 'b'].map(pattern => tools.relai_search({pattern})));
    const next = await tools.relai_read({paths: [results[0].path]});
    text(next.content);
  `, async (name, args) => {
    if (name === 'relai_read') return { ok: true, content: args.paths[0] };
    return await new Promise(resolve => {
      waiting.set(args.pattern, resolve); maximum = Math.max(maximum, waiting.size);
      if (waiting.size === 2) {
        for (const [key, complete] of waiting) complete({ ok: true, path: `${key}.txt` });
        waiting.clear();
      }
    });
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(maximum, 2);
  assert.equal(result.outputs[0].text, 'a.txt');
  assert.equal(result.calls.length, 3);
});

test('canonical reads and dependent edits keep one task and do not deadlock', async () => {
  const task = await callTool('relai_work', { mode: 'normal', action: 'begin', workspace: 'app', title: 'Composition fixture', bootstrap: 'none' }, context);
  const result = await run(`
    const read = await tools.relai_read({paths:['a.txt']});
    text({readOk: read.ok});
    const edited = await tools.relai_edit({path:'new.txt',content:'created through composition\\n'});
    text({editOk: edited.ok});
    const check = await tools.relai_read({paths:['new.txt']}); text(check);
  `, { work_id: task.work_id, timeoutMs: 10000 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(workspace, 'new.txt'), 'utf8'), 'created through composition\n');
  const status = await callTool('relai_work', { action: 'status', work_id: task.work_id }, context);
  assert.ok(JSON.stringify(status).includes('new.txt'));
  const switched = await run(`await tools.relai_read({work_id:'foreign',paths:['a.txt']});`, { work_id: task.work_id });
  assert.equal(switched.ok, false);
  assert.equal(switched.calls[0].dispatched, undefined);
  const lifecycle = await run(`await tools.relai_work({action:'finish'});`, { work_id: task.work_id });
  assert.equal(lifecycle.ok, false);
  const autoClose = await run(`await tools.relai_validate({complete:true});`, { work_id: task.work_id });
  assert.equal(autoClose.ok, false);
  await callTool('relai_work', { action: 'finish', work_id: task.work_id, summary: 'Fixture complete' }, context);
});

test('nested authorization, schema validation, containment and workspace scope cannot be bypassed', async () => {
  const readOnly = { ...context, principal: { clientId: 'composition-reader', authorizationPolicy: createConsentPolicy({
    capabilities: ['repository:read'], workspaces: ['app']
  }) } };
  const denied = await run(`text(await tools.relai_edit({path:'denied.txt',content:'denied'}));`, {}, readOnly);
  assert.equal(denied.ok, false);
  assert.equal(denied.calls[0].errorCode, 'AUTHORIZATION_DENIED');
  assert.equal(fs.existsSync(path.join(workspace, 'denied.txt')), false);
  const invalid = await run(`await tools.relai_read({paths:42});`);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.calls[0].errorCode, 'INVALID_TOOL_ARGUMENTS');
  const escaped = await run(`await tools.relai_read({paths:['../config.json']});`);
  assert.equal(escaped.ok, false);
  const switched = await run(`await tools.relai_read({workspace:'other',paths:['config.json']});`);
  assert.equal(switched.ok, false);
  assert.equal(switched.calls[0].dispatched, undefined);
  const recursive = await run(`await tools.relai_compose({code:'text(1)'});`);
  assert.equal(recursive.ok, false);
});

test('partial effects survive script failure and transport text retains emitted output', async () => {
  const result = await run(`await tools.relai_edit({path:'partial.txt',content:'kept'}); text('before failure'); throw new Error('fixture stop');`);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'COMPOSITION_SCRIPT_ERROR');
  assert.equal(fs.readFileSync(path.join(workspace, 'partial.txt'), 'utf8'), 'kept');
  assert.equal(result.calls[0].ok, true);
  assert.equal(result.outputs[0].text, 'before failure');
  const transported = await invokeRelaiTool({ name: 'relai_compose', args: { workspace: 'app', code: `text('visible composition output')` }, context, config,
    validateOutput: output => validateToolOutput(config, 'relai_compose', { code: `text('visible composition output')` }, output) });
  assert.match(transported.content[0].text, /visible composition output/);
  assert.equal(transported.isError, false);
});

test('image forwarding requires child provenance and survives native MCP serialization', async () => {
  const image = { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==' };
  const result = await isolated(`const result = await tools.relai_ui({action:'screenshot',sessionId:'fixture'}); image(result.image);`, async () => ({ ok: true, image }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.outputs[0].image, image);
  const { toolResult } = await import('../src/mcp/results.js');
  const wire = toolResult(result, false);
  assert.equal(wire.content.filter(item => item.type === 'image').length, 1);
  assert.equal(JSON.stringify(wire.structuredContent).includes(image.data), false);
  const forged = await isolated(`image(${JSON.stringify(image)});`);
  assert.equal(forged.errorCode, 'COMPOSITION_IMAGE_INVALID');
});

test('timeouts and CPU/memory/output/call bounds terminate scripts without blocking the host', async () => {
  const timeout = await composeTools(config, { code: 'await new Promise(() => {});', timeoutMs: 500 }, { ...context, invokeTool: async () => ({ ok: true }) });
  assert.equal(timeout.errorCode, 'COMPOSITION_UNRESOLVED_PROMISE');
  const cpu = await isolated('while(true) {}');
  assert.equal(cpu.ok, false);
  assert.equal(cpu.errorCode, 'COMPOSITION_CPU_LIMIT');
  const memory = await isolated(`const allocations=[]; while(true) allocations.push(new Array(1000000).fill(1));`);
  assert.equal(memory.ok, false);
  const output = await isolated(`text('x'.repeat(LIMITS.textBytes + 1));`);
  assert.equal(output.errorCode, 'COMPOSITION_OUTPUT_LIMIT');
  const calls = await isolated(`for(let i=0;i<LIMITS.calls+1;i++) await tools.relai_read({paths:['a']});`);
  assert.equal(calls.errorCode, 'COMPOSITION_CALL_LIMIT');
  assert.equal(calls.calls.length, COMPOSITION_LIMITS.calls);
  const concurrency = await isolated(`await Promise.all(Array.from({length:LIMITS.concurrentCalls+1},()=>tools.relai_read({paths:['a']})));`,
    async (_name, _args, request) => await new Promise(resolve => request.signal.addEventListener('abort', () => resolve({ ok: false, errorCode: 'CANCELLED' }), { once: true })));
  assert.equal(concurrency.errorCode, 'COMPOSITION_CALL_LIMIT');
  const alive = await isolated('text(7);');
  assert.equal(alive.ok, true);
});

test('cancellation and unawaited calls signal children and preserve their results', async () => {
  const abort = new AbortController();
  const cancelled = await isolated(`await tools.relai_read({paths:['a']});`, async (_name, _args, request) => {
    const result = new Promise(resolve => request.signal.addEventListener('abort', () => resolve({ ok: false, errorCode: 'CANCELLED', executed: true, terminationConfirmed: true }), { once: true }));
    abort.abort(); return await result;
  }, { signal: abort.signal });
  assert.equal(cancelled.errorCode, 'COMPOSITION_CANCELLED');
  assert.equal(cancelled.calls[0].terminationConfirmed, true);
  const unawaited = await isolated(`tools.relai_read({paths:['a']});`, async (_name, _args, request) => {
    if (request.signal.aborted) return { ok: false, errorCode: 'CANCELLED' };
    return await new Promise(resolve => request.signal.addEventListener('abort', () => resolve({ ok: false, errorCode: 'CANCELLED' }), { once: true }));
  });
  assert.equal(unawaited.errorCode, 'COMPOSITION_UNAWAITED_CALLS');
  assert.equal(unawaited.unsettledCalls, 0);
});

test('wall deadline cancels pending tool work and active capacity is bounded', async () => {
  const deadline = await composeTools(config, { code: `await tools.relai_read({paths:['a']});`, timeoutMs: 1000 }, { ...context,
    invokeTool: async (_name, _args, request) => await new Promise(resolve => {
      if (request.signal.aborted) resolve({ ok: false });
      else request.signal.addEventListener('abort', () => resolve({ ok: false, errorCode: 'CANCELLED' }), { once: true });
    }) });
  assert.equal(deadline.errorCode, 'COMPOSITION_TIME_LIMIT');
  assert.equal(deadline.unsettledCalls, 0);
  const releases = [];
  let ready;
  const bothStarted = new Promise(resolve => { ready = resolve; });
  const invokeTool = async () => await new Promise(resolve => { releases.push(resolve); if (releases.length === COMPOSITION_LIMITS.principalRuns) ready(); });
  const runs = Array.from({ length: COMPOSITION_LIMITS.principalRuns }, () => isolated(`text(await tools.relai_read({paths:['a']}));`, invokeTool));
  await bothStarted;
  const refused = await isolated('text(1);');
  assert.equal(refused.errorCode, 'COMPOSITION_BUSY');
  releases.forEach(resolve => resolve({ ok: true }));
  assert.ok((await Promise.all(runs)).every(result => result.ok));
});

test('canonical command failures retain execution facts without retrying the command', async () => {
  const code = `const result = await tools.relai_exec({executable:${JSON.stringify(process.execPath)},argv:['-e', "process.stdout.write('command fixture');process.exit(7)"]}); text(result);`;
  const result = await run(code);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.errorCode, 'COMPOSITION_CHILD_FAILED');
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].executed, true);
  const output = JSON.parse(result.outputs[0].text);
  assert.equal(output.exitCode, 7);
  assert.equal(output.commandSucceeded, false);
});

test('complete private output survives background compaction/restart and exact replay', async () => {
  const noticeScope = principalFingerprint(context.principal);
  const code = `await tools.relai_edit({path:'background.txt',content:'once'});text('private emitted result');`;
  let executions = 0;
  const options = { config, scopeId: 'composition-recovery-fixture', noticeScope, tool: 'relai_compose', workspace: 'app', signature: 'composition-once',
    run: async (signal, operationId) => {
      executions++;
      return await invokeRelaiTool({ config, name: 'relai_compose', args: { workspace: 'app', code },
        context: { ...context, signal, fallbackOperationId: operationId, backgroundFallbackExecution: true } });
    } };
  const execution = startFallbackExecution(options);
  await execution.record.promise;
  const replay = startFallbackExecution(options);
  assert.equal(replay.reused, true);
  assert.equal(executions, 1);
  resetFallbackExecutions();
  const recovered = fallbackExecutionStatus(execution.record.operationId, { config, noticeScope, workspace: 'app' });
  assert.equal(recovered.result.calls[0].tool, 'relai_edit');
  assert.ok(recovered.result.compositionOutputRef);
  assert.equal(recovered.result.outputs, undefined, 'raw output must stay outside durable task history');
  const owner = outputSpillOwner({ workspace: 'app', principal: context.principal });
  const stored = readOutputSpill(config, owner, recovered.result.compositionOutputRef);
  const complete = JSON.parse(fs.readFileSync(stored.file, 'utf8'));
  assert.equal(complete.outputs[0].text, 'private emitted result');
  assert.equal(complete.calls[0].tool, 'relai_edit');
  assert.throws(() => readOutputSpill(config, outputSpillOwner({ workspace: 'app', principal: { clientId: 'foreign' } }), recovered.result.compositionOutputRef), /not found/);
  const replayAfterRestart = startFallbackExecution(options);
  assert.equal(replayAfterRestart.reused, true);
  assert.equal(executions, 1);
  const publicRead = await callTool('relai_read', { workspace: 'app', outputRef: recovered.result.compositionOutputRef }, context);
  assert.equal(publicRead.ok, true);
});

test('source/argument/result bounds refuse excess data and the runtime remains usable', async () => {
  const source = await isolated(' '.repeat(COMPOSITION_LIMITS.sourceBytes + 1));
  assert.equal(source.errorCode, 'COMPOSITION_SOURCE_LIMIT');
  const args = await isolated(`await tools.relai_read({paths:['a'],padding:'x'.repeat(LIMITS.argumentBytes+1)});`);
  assert.equal(args.ok, false);
  assert.equal(args.calls.length, 0);
  const result = await isolated(`await tools.relai_read({paths:['a']});`, async () => ({ ok: true, value: 'x'.repeat(COMPOSITION_LIMITS.resultBytes + 1) }));
  assert.equal(result.errorCode, 'COMPOSITION_RESULT_LIMIT');
  assert.equal(result.calls[0].ok, true, 'the child already ran; a result limit must not erase its receipt');
  const syntax = await isolated('const = ;');
  assert.equal(syntax.errorCode, 'COMPOSITION_SCRIPT_ERROR');
  const imports = await isolated(`await import('node:fs');`);
  assert.equal(imports.ok, false);
  const fresh = await isolated(`text(typeof previousRunSecret);globalThis.previousRunSecret='private';`);
  assert.equal(fresh.outputs[0].text, 'undefined');
  const another = await isolated('text(typeof previousRunSecret);');
  assert.equal(another.outputs[0].text, 'undefined');
});

test('global capacity spans principals and unsettled calls retain their lease after return', async () => {
  let allReady;
  const ready = new Promise(resolve => { allReady = resolve; });
  const releases = [];
  const principals = [{ clientId: 'capacity-a' }, { clientId: 'capacity-b' }];
  const runs = Array.from({ length: COMPOSITION_LIMITS.activeRuns }, (_, index) => isolated(
    `await tools.relai_read({paths:['a']});`,
    async () => await new Promise(resolve => { releases.push(resolve); if (releases.length === COMPOSITION_LIMITS.activeRuns) allReady(); }),
    { principal: principals[Math.floor(index / COMPOSITION_LIMITS.principalRuns)] }));
  await ready;
  const busy = await isolated('text(1);', undefined, { principal: { clientId: 'capacity-c' } });
  assert.equal(busy.errorCode, 'COMPOSITION_BUSY');
  releases.forEach(resolve => resolve({ ok: true }));
  assert.ok((await Promise.all(runs)).every(result => result.ok));

  let releasePending;
  const unsettled = await isolated(`tools.relai_read({paths:['a']});`, async () => await new Promise(resolve => { releasePending = resolve; }));
  assert.equal(unsettled.errorCode, 'COMPOSITION_UNAWAITED_CALLS');
  assert.equal(unsettled.unsettledCalls, 1);
  assert.equal(unsettled.calls[0].status, 'pending');
  let releaseSecond, secondReady;
  const secondStarted = new Promise(resolve => { secondReady = resolve; });
  const second = isolated(`await tools.relai_read({paths:['a']});`, async () => await new Promise(resolve => { releaseSecond = resolve; secondReady(); }));
  await secondStarted;
  const stillBusy = await isolated('text(1);');
  assert.equal(stillBusy.errorCode, 'COMPOSITION_BUSY');
  releasePending({ ok: true }); releaseSecond({ ok: true });
  assert.equal((await second).ok, true);
  assert.equal((await isolated('text(1);')).ok, true);
});
