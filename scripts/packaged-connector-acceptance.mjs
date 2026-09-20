import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY
} from '@modelcontextprotocol/server';
import { resolveCurrentUnpacked } from './current-unpacked.mjs';
import { electronPlatformSpec, normalizeElectronArch, normalizeElectronPlatform } from './electron-platform.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseManifest = JSON.parse(fs.readFileSync(path.join(root, 'release-manifest.json'), 'utf8'));
const { applicationVersion, protocolVersion: mcpProtocolVersion, toolSurfaceVersion, toolCount } = releaseManifest;
const mcpToolCount = toolCount;
const platform = normalizeElectronPlatform(process.env.REL_AI_TARGET_PLATFORM || process.platform);
const targetArch = normalizeElectronArch(process.env.REL_AI_TARGET_ARCH || process.arch);
const platformSpec = electronPlatformSpec(platform, targetArch);
const directoryArgument = process.argv.indexOf('--dir');
const packageDirectory = directoryArgument >= 0
  ? path.resolve(root, String(process.argv[directoryArgument + 1] || ''))
  : resolveCurrentUnpacked(root, { allowBuildCheck: true, platform });
const resources = path.join(packageDirectory, platformSpec.resourcesDirectory || 'resources');
const packagedServer = path.join(resources, 'bin', 'rel-ai-mcp-http.js');
assert.equal(fs.existsSync(packagedServer), true, `Packaged backend is missing from ${packageDirectory}. Build the unpacked app before connector acceptance.`);

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-packaged-connector-'));
const workspace = path.join(sandbox, 'workspace');
const stateDir = path.join(sandbox, 'state');
const configPath = path.join(sandbox, 'config.json');
const localBearerToken = 'packaged-connector-local-bearer-token';
let port = 0;
let base = '';
let child;
let primarySession = null;
let reconnectSession = null;
let dashboardCookie = '';
let stderr = '';
let nativeTaskRequestId = 10000;

fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, 'acceptance.txt'), 'packaged connector acceptance\n');
fs.writeFileSync(path.join(workspace, 'acceptance.mjs'), "import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nassert.equal(fs.readFileSync(new URL('./acceptance.txt', import.meta.url), 'utf8'), 'packaged connector acceptance verified\\n');\n");
fs.writeFileSync(path.join(workspace, 'package.json'), `${JSON.stringify({
  name: 'relai-packaged-acceptance',
  private: true,
  type: 'module',
  scripts: { check: 'node acceptance.mjs' }
}, null, 2)}\n`);
runGit('init');
runGit('config', 'user.name', 'Rel.AI Acceptance');
runGit('config', 'user.email', 'relai-acceptance@example.invalid');
runGit('add', '.');
runGit('commit', '-m', 'Initialize packaged acceptance workspace');
fs.writeFileSync(configPath, JSON.stringify({
  version: 2,
  stateDir,
  auditLogPath: path.join(stateDir, 'audit.jsonl'),
  workspaces: {
    acceptance: {
      path: workspace,
      commands: {},
      testCommands: {},
      context: { snapshotMaxFiles: 100, includeRoots: [], excludePaths: ['.git', 'node_modules'] }
    }
  }
}, null, 2));

try {
  child = spawn(process.execPath, [packagedServer, '--host', '127.0.0.1', '--port', '0', '--no-profile-write'], {
    cwd: resources,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      REL_AI_MCP_CONFIG: configPath,
      REL_AI_MCP_STATE_DIR: stateDir,
      REL_AI_MCP_TOKEN: localBearerToken
    }
  });
  child.stderr.on('data', chunk => { stderr += String(chunk || ''); });
  await waitForHealth();

  const challenge = await freshFetch(`${base}/mcp`, {
    method: 'POST',
    headers: mcpHeaders(),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  });
  assert.equal(challenge.status, 401);
  assert.match(challenge.headers.get('www-authenticate') || '', /^Bearer\s+realm="rel-ai-local"$/i);
  assert.match(await challenge.text(), /private Rel\.AI bearer token/i);

  const dashboardBearerChallenge = await freshFetch(`${base}/api/dashboard/v10`, {
    headers: { authorization: `Bearer ${localBearerToken}` }
  });
  assert.equal(dashboardBearerChallenge.status, 401, 'dashboard APIs must not accept the MCP bearer token directly');

  primarySession = await initializeMcp(localBearerToken, '1.0.0');
  const discovered = primarySession.discovery;
  assert.ok(discovered.result?.supportedVersions?.includes(mcpProtocolVersion));
  assert.ok(discovered.result?.capabilities?.tools);
  assert.ok(discovered.result?.capabilities?.resources);
  assert.equal(discovered.result?.capabilities?.experimental?.relai?.toolSurfaceVersion, toolSurfaceVersion);
  assert.equal(discovered.result?.capabilities?.experimental?.relai?.toolCount, toolCount);
  assert.equal(Object.hasOwn(discovered.result?.capabilities?.experimental?.relai || {}, 'appToolCount'), false,
    'packaged native status presentation must not advertise app-only helpers');
  assert.equal(discovered.result?.capabilities?.experimental?.relai?.deploymentMode, 'local_developer');

  const tools = await mcp(primarySession, 11, 'tools/list', {});
  assert.equal(tools.result?.tools?.length, mcpToolCount);
  const toolNames = new Set(tools.result.tools.map(tool => tool.name));
  for (const requiredTool of ['relai_work', 'relai_read', 'relai_validate']) {
    assert.equal(toolNames.has(requiredTool), true, `Packaged tool surface is missing ${requiredTool}.`);
  }
  assert.equal(toolNames.has('relai_native_tasks_probe'), false);
  assert.deepEqual(tools.result.tools.filter(tool => tool.name.startsWith('relai_app_')).map(tool => tool.name), []);
  const toolByName = new Map(tools.result.tools.map(tool => [tool.name, tool]));
  for (const tool of tools.result.tools) {
    assert.equal(tool._meta?.ui, undefined, `${tool.name} must stay iframe-free in the packaged connector`);
    assert.equal(tool._meta?.['openai/outputTemplate'], undefined, `${tool.name} must not attach a ChatGPT output template`);
  }
  assert.deepEqual(toolByName.get('relai_publish')?.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  assert.equal(toolNames.has('relai_approval'), false);
  assert.equal(toolByName.get('relai_validate')?.execution, undefined);
  assert.equal(toolByName.get('relai_exec')?.execution, undefined);
  assert.equal(toolByName.get('relai_process')?.execution, undefined);
  const resourcesList = await mcp(primarySession, 12, 'resources/list', {});
  assert.ok(resourcesList.result?.resources?.some(item => item.uri === 'relai://server/tool-surface'));
  assert.ok(resourcesList.result?.resources?.some(item => item.uri === 'relai://server/workspaces'));
  assert.equal(resourcesList.result?.resources?.some(item => item.uri === 'ui://relai/approval/v1.html'), false);
  const surface = await readResource(primarySession, 13, 'relai://server/tool-surface');
  assert.equal(surface.toolSurfaceVersion, toolSurfaceVersion);
  assert.equal(surface.toolCount, toolCount);
  const surfaceByName = new Map(surface.tools.map(tool => [tool.name, tool]));
  assert.equal(surfaceByName.get('relai_exec').executionClass, 'native_task_eligible');
  assert.equal(surfaceByName.get('relai_exec').taskSupport, 'optional');
  assert.equal(surfaceByName.get('relai_process').executionClass, 'persistent_process');
  assert.equal(surfaceByName.get('relai_process').taskSupport, 'forbidden');
  assert.equal(Object.hasOwn(surface, 'compatibilityAliases'), false);
  const help = await readResourceText(primarySession, 14, 'relai://server/help');
  assert.ok(help.includes(`version: ${applicationVersion}`));

  const started = await callTool(primarySession, 15, 'relai_work', {
    action: 'begin',
    workspace: 'acceptance',
    title: 'Packaged connector acceptance',
    objective: 'Verify packaged ESM runtime, guarded mutation, validation, observability, completion, and reconnect behavior.'
  });
  const taskId = started.work_id;
  assert.ok(taskId);
  await callTool(primarySession, 16, 'relai_snapshot', { workspace: 'acceptance', work_id: taskId, maxEntries: 50 });
  const read = await callTool(primarySession, 17, 'relai_read', {
    workspace: 'acceptance', work_id: taskId, paths: ['acceptance.txt'], guidanceMode: 'none'
  });
  assert.equal(read.items?.[0]?.content, 'packaged connector acceptance\n');

  const edited = await callTool(primarySession, 18, 'relai_edit', {
    workspace: 'acceptance',
    work_id: taskId,
    path: 'acceptance.txt',
    oldText: 'packaged connector acceptance\n',
    newText: 'packaged connector acceptance verified\n',
    returnDiff: true
  }, { expectNativeTask: true });
  assert.equal(edited.changed, true);
  assert.ok(edited.changedFiles?.includes('acceptance.txt'));
  assert.equal(fs.readFileSync(path.join(workspace, 'acceptance.txt'), 'utf8'), 'packaged connector acceptance verified\n');

  const status = await callTool(primarySession, 19, 'relai_work', { action: 'status', workspace: 'acceptance', work_id: taskId, detail: 'full' });
  assert.equal(status.version, applicationVersion);
  assert.equal(status.toolSurface?.toolCount, toolCount);
  assert.equal(status.toolSurface?.toolSurfaceVersion, toolSurfaceVersion);
  assert.ok(status.workspace?.repository?.changedFiles?.includes('acceptance.txt'));

  const activeDashboard = await dashboard();
  assert.equal(activeDashboard.application?.version, applicationVersion);
  const activeTask = activeDashboard.tasks?.find(item => item.id === taskId || item.taskId === taskId);
  assert.ok(activeTask, 'dashboard task history must contain the active packaged acceptance task');
  assert.ok(activeDashboard.auditTail?.entries?.some(item => item.taskId === taskId && (item.publicTool || item.tool) === 'relai_edit' && item.ok !== false));

  const completed = await callTool(primarySession, 20, 'relai_validate', {
    action: 'checks',
    workspace: 'acceptance',
    work_id: taskId,
    check: 'npm run check',
    complete: true,
    summary: 'Packaged ESM connector accepted after guarded write, validation, activity inspection, and reconnect verification.'
  }, { expectNativeTask: true });
  assert.equal(completed.validationStatus, 'passed');
  assert.equal(completed.completionKnown, true);
  assert.equal(completed.completionSource, 'relai_validate:checks');
  assert.ok(completed.changedFiles?.includes('acceptance.txt'));

  const completedDashboard = await dashboard();
  const persistedTask = completedDashboard.tasks?.find(item => item.id === taskId || item.taskId === taskId);
  assert.ok(persistedTask, 'dashboard history must persist the completed packaged acceptance task');
  assert.equal(persistedTask.completionKnown, true);
  assert.equal(persistedTask.status, 'completed');
  assert.ok(persistedTask.changedFiles?.includes('acceptance.txt'));
  const packagedAuditTools = completedDashboard.auditTail?.entries
    ?.filter(item => item.taskId === taskId)
    .map(item => ({ tool: item.tool, publicTool: item.publicTool, action: item.action })) || [];
  for (const expectedTool of ['relai_snapshot', 'relai_read', 'relai_edit', 'relai_work', 'relai_validate']) {
    assert.ok(
      completedDashboard.auditTail?.entries?.some(item => item.taskId === taskId && (item.publicTool || item.tool) === expectedTool),
      `dashboard activity is missing ${expectedTool}: ${JSON.stringify(packagedAuditTools)}`
    );
  }

  reconnectSession = await initializeMcp(localBearerToken, '2.0.0');
  const reconnected = reconnectSession.discovery;
  assert.ok(reconnected.result?.supportedVersions?.includes(mcpProtocolVersion));
  assert.ok(reconnected.result?.capabilities?.tools);
  assert.ok(reconnected.result?.capabilities?.resources);
  const reconnectedDashboard = await dashboard();
  const reconnectedTask = reconnectedDashboard.tasks?.find(item => item.id === taskId || item.taskId === taskId);
  assert.equal(reconnectedTask?.completionKnown, true);
  assert.equal(reconnectedTask?.status, 'completed');

  const recoveredRead = await mcp(reconnectSession, 31, 'tools/call', {
    name: 'relai_read',
    arguments: { workspace: 'acceptance', paths: ['acceptance.txt'], guidanceMode: 'none' }
  });
  assert.equal(recoveredRead.result?.isError, false, JSON.stringify(recoveredRead));
  assert.equal(recoveredRead.result?.structuredContent?.items?.[0]?.content, 'packaged connector acceptance verified\n');

  const chatGptInitializeResponse = await freshFetch(`${base}/mcp`, {
    method: 'POST',
    headers: mcpHeaders('', primarySession),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 30,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'ChatGPT', version: '1.0.0' }
      }
    })
  });
  const chatGptInitialize = await readMcpResponse(chatGptInitializeResponse);
  assert.equal(chatGptInitializeResponse.status, 200, JSON.stringify(chatGptInitialize));
  assert.equal(chatGptInitialize.result?.protocolVersion, '2025-11-25');
  assert.equal(chatGptInitialize.result?.serverInfo?.name, 'rel-ai-mcp');
  assert.equal(chatGptInitializeResponse.headers.get('mcp-session-id'), null);

  const chatGptInitializedResponse = await freshFetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      ...mcpHeaders('', primarySession),
      'mcp-protocol-version': '2025-11-25'
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
  });
  assert.equal(chatGptInitializedResponse.status, 202);
  assert.equal(await chatGptInitializedResponse.text(), '');

  const chatGptToolsResponse = await freshFetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      ...mcpHeaders('', primarySession),
      'mcp-protocol-version': '2025-11-25'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 33, method: 'tools/list', params: {} })
  });
  const chatGptTools = await readMcpResponse(chatGptToolsResponse);
  assert.equal(chatGptToolsResponse.status, 400, JSON.stringify(chatGptTools));
  assert.equal(chatGptTools.error?.code, -32022);
  assert.deepEqual(chatGptTools.error?.data?.supported, [mcpProtocolVersion]);

  const chatGptStatusResponse = await freshFetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      ...mcpHeaders('', primarySession),
      'mcp-protocol-version': '2025-11-25'
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 34,
      method: 'tools/call',
      params: { name: 'relai_work', arguments: { action: 'status', workspace: 'acceptance' } }
    })
  });
  const chatGptStatus = await readMcpResponse(chatGptStatusResponse);
  assert.equal(chatGptStatusResponse.status, 400, JSON.stringify(chatGptStatus));
  assert.equal(chatGptStatus.error?.code, -32022);
  assert.deepEqual(chatGptStatus.error?.data?.supported, [mcpProtocolVersion]);

  const initializeInsideModernEnvelope = await freshFetch(`${base}/mcp`, {
    method: 'POST',
    headers: mcpHeaders('initialize', primarySession),
    body: JSON.stringify({ jsonrpc: '2.0', id: 32, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: primarySession.clientInfo
    } })
  });
  assert.equal(initializeInsideModernEnvelope.status, 400);
  assert.equal((await readMcpResponse(initializeInsideModernEnvelope)).error?.code, -32601);

  for (const removedPath of ['/register', '/authorize', '/token', '/.well-known/oauth-protected-resource/mcp', '/sse', '/messages']) {
    const response = await freshFetch(`${base}${removedPath}`);
    assert.equal(response.status, 404, `${removedPath} must remain removed`);
  }

  console.log('Packaged connector acceptance passed: bearer authentication, strict MCP 2026-07-28 discovery, stateless ChatGPT initialization, adaptive direct/native execution, release/tool versions, guarded write attribution, validation, dashboard history, reconnect persistence, and removed routes verified.');
} finally {
  if (reconnectSession) await closeMcpSession(reconnectSession).catch(() => {});
  if (primarySession && !primarySession.closed) await closeMcpSession(primarySession).catch(() => {});
  if (child && !child.killed) child.kill('SIGKILL');
  if (child) await Promise.race([once(child, 'close'), new Promise(resolve => setTimeout(resolve, 2000))]).catch(() => {});
  fs.rmSync(sandbox, { recursive: true, force: true });
}

function runGit(...args) {
  const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
}

async function dashboard() {
  if (!dashboardCookie) {
    const launch = await freshFetch(`${base}/dashboard?token=${encodeURIComponent(localBearerToken)}`);
    assert.equal(launch.status, 200);
    dashboardCookie = dashboardSessionCookie(launch.headers.get('set-cookie'));
    assert.match(dashboardCookie, /^relai_dashboard_session=/, 'dashboard launch must exchange the local launch token for an HttpOnly session');
  }
  const response = await freshFetch(`${base}/api/dashboard/v10`, {
    headers: { cookie: dashboardCookie }
  });
  assert.equal(response.status, 200);
  const renewedCookie = dashboardSessionCookie(response.headers.get('set-cookie'));
  if (renewedCookie) dashboardCookie = renewedCookie;
  const payload = await response.json();
  assert.equal(payload.ok, true);
  return payload;
}

function dashboardSessionCookie(value) {
  return String(value || '').split(';', 1)[0].trim();
}

async function readResource(session, id, uri) {
  return JSON.parse(await readResourceText(session, id, uri));
}

async function readResourceText(session, id, uri) {
  const response = await mcp(session, id, 'resources/read', { uri });
  const text = response.result?.contents?.[0]?.text;
  assert.equal(typeof text, 'string', `resource ${uri} did not return text`);
  return text;
}

async function freshFetch(input, init = {}) {
  const target = new URL(input);
  const method = String(init.method || 'GET').toUpperCase();
  const headers = new Headers(init.headers || {});
  headers.set('connection', 'close');
  headers.set('accept-encoding', 'identity');
  const body = init.body == null ? null : Buffer.from(String(init.body), 'utf8');
  if (body && !headers.has('content-length')) headers.set('content-length', String(body.length));

  // ECONNREFUSED means the TCP connection was never established, so the server
  // cannot have observed the request. Retrying that one connect failure is safe
  // even for POST tool calls; ambiguous failures such as ECONNRESET are never
  // retried because the request may already have reached the server.
  const retryDelaysMs = [0, 40, 120, 240];
  let lastError = null;
  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    if (retryDelaysMs[attempt] > 0) await new Promise(resolve => setTimeout(resolve, retryDelaysMs[attempt]));
    try {
      return await localHttpRequest(target, method, headers, body);
    } catch (error) {
      lastError = error;
      const code = String(error?.code || '').trim();
      if (code !== 'ECONNREFUSED' || packagedServerExited() || attempt === retryDelaysMs.length - 1) {
        throw localHttpFailure(target, method, error, attempt + 1);
      }
    }
  }
  throw localHttpFailure(target, method, lastError, retryDelaysMs.length);
}

function localHttpRequest(target, method, headers, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(target, {
      method,
      headers: Object.fromEntries(headers.entries()),
      agent: false
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const responseBody = Buffer.concat(chunks);
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(name, item);
          } else if (value != null) {
            responseHeaders.set(name, String(value));
          }
        }
        const status = Number(response.statusCode || 0);
        resolve({
          status,
          ok: status >= 200 && status < 300,
          headers: responseHeaders,
          text: async () => responseBody.toString('utf8'),
          json: async () => JSON.parse(responseBody.toString('utf8'))
        });
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function packagedServerExited() {
  return Boolean(child && (child.exitCode != null || child.signalCode != null));
}

function localHttpFailure(target, method, error, attempts) {
  const code = String(error?.code || '').trim();
  const lifecycle = child
    ? `server pid=${child.pid || 'unknown'} exitCode=${child.exitCode ?? 'running'} signal=${child.signalCode || 'none'} killed=${child.killed === true}`
    : 'server child unavailable';
  const stderrTail = stderr.trim().slice(-4000);
  return new Error(
    `Local HTTP request ${method} ${target.pathname} failed after ${attempts} attempt${attempts === 1 ? '' : 's'}${code ? ` (${code})` : ''}: ${error instanceof Error ? error.message : String(error)}; ${lifecycle}${stderrTail ? `\nPackaged server stderr:\n${stderrTail}` : ''}`,
    { cause: error }
  );
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child?.exitCode != null) {
      throw new Error(`Packaged server exited before becoming healthy (code ${child.exitCode}). stderr:\n${stderr}`);
    }
    if (!base) {
      const listening = stderr.match(/HTTP server listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (listening) {
        port = Number(listening[1]);
        assert.ok(Number.isInteger(port) && port > 0, `Packaged server reported an invalid listening port: ${listening[1]}`);
        base = `http://127.0.0.1:${port}`;
      }
    }
    if (base) {
      try {
        const response = await freshFetch(`${base}/health`);
        if (response.ok) return;
      } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Packaged server did not become healthy within 30 seconds. stderr:\n${stderr}`);
}

function mcpHeaders(method, session = null, name = '') {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(method ? { 'mcp-protocol-version': mcpProtocolVersion, 'mcp-method': method } : {}),
    ...(name ? { 'mcp-name': name } : {}),
    ...(session?.bearerToken ? { authorization: `Bearer ${session.bearerToken}` } : {})
  };
}

async function initializeMcp(bearerToken, clientVersion) {
  const session = {
    bearerToken,
    clientInfo: { name: 'packaged-chatgpt-acceptance', version: clientVersion },
    clientCapabilities: { extensions: { 'io.modelcontextprotocol/tasks': { revision: mcpProtocolVersion } } },
    discovery: null,
    closed: false
  };
  const response = await freshFetch(`${base}/mcp`, {
    method: 'POST',
    headers: mcpHeaders('server/discover', session),
    body: mcpBody(session, 10, 'server/discover', {})
  });
  if (response.status !== 200) {
    const body = await response.text();
    assert.equal(response.status, 200, `server/discover returned HTTP ${response.status}: ${body}`);
  }
  assert.equal(response.headers.get('mcp-session-id'), null);
  session.discovery = await readMcpResponse(response);
  return session;
}

async function closeMcpSession(session) {
  if (!session || session.closed) return;
  session.closed = true;
}

async function mcp(session, id, method, params) {
  const name = method === 'tools/call'
    ? String(params?.name || '')
    : method === 'resources/read'
      ? String(params?.uri || '')
      : ['tasks/get', 'tasks/update', 'tasks/cancel'].includes(method)
        ? String(params?.taskId || '')
      : '';
  const response = await freshFetch(`${base}/mcp`, {
    method: 'POST',
    headers: mcpHeaders(method, session, name),
    body: mcpBody(session, id, method, params)
  });
  if (response.status !== 200) {
    const body = await response.text();
    assert.equal(response.status, 200, `${method} returned HTTP ${response.status}: ${body}`);
  }
  return readMcpResponse(response);
}

function mcpBody(session, id, method, params = {}) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      _meta: {
        ...(params?._meta || {}),
        [PROTOCOL_VERSION_META_KEY]: mcpProtocolVersion,
        [CLIENT_INFO_META_KEY]: session.clientInfo,
        [CLIENT_CAPABILITIES_META_KEY]: session.clientCapabilities
      }
    }
  });
}

async function callTool(session, id, name, args, options = {}) {
  const response = await mcp(session, id, 'tools/call', { name, arguments: args });
  if (response.result?.resultType === 'task') {
    assert.equal(options.expectNativeTask, true, `${name} unexpectedly returned a native task.`);
    const taskId = response.result.taskId;
    assert.match(taskId || '', /^task_[A-Za-z0-9_-]{32,160}$/);
    const task = await waitForNativeToolResult(session, taskId);
    assert.equal(task.status, 'completed', `${name} native task ended as ${task.status}: ${JSON.stringify(task.error)}`);
    assert.equal(task.result?.isError, false, `${name} native task failed: ${JSON.stringify(task.result?.structuredContent || task.error)}`);
    return task.result?.structuredContent;
  }
  assert.notEqual(options.expectNativeTask, true, `${name} did not return the negotiated native task handle.`);
  assert.equal(response.result?.isError, false, `${name} failed: ${JSON.stringify(response.result?.structuredContent || response.error)}`);
  return response.result?.structuredContent;
}

async function waitForNativeToolResult(session, taskId) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const response = await mcp(session, nativeTaskRequestId++, 'tasks/get', { taskId });
    assert.equal(response.error, undefined, JSON.stringify(response));
    const task = response.result;
    if (['completed', 'failed', 'cancelled'].includes(task?.status)) return task;
    await new Promise(resolve => setTimeout(resolve, Math.max(25, Number(task?.pollIntervalMs) || 25)));
  }
  throw new Error(`Native task ${taskId} did not reach a terminal state.`);
}

async function readMcpResponse(response) {
  const text = await response.text();
  if (!(response.headers.get('content-type') || '').includes('text/event-stream')) return JSON.parse(text);
  const frames = text.split(/\n\n+/).map(frame => frame.trim()).filter(Boolean);
  const data = frames.flatMap(frame => frame.split(/\r?\n/))
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(Boolean);
  assert.ok(data.length, `MCP event stream contained no data frame: ${text}`);
  return JSON.parse(data.at(-1));
}
