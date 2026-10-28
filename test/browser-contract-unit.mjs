import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { relaiHttpProbe } from "../src/bridge/httpProbe.js";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-browser-contract-'));
const workspaceRoot = path.join(temp, 'repo');
const stateDir = path.join(temp, 'state');
fs.mkdirSync(workspaceRoot, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(workspaceRoot, 'package.json'), `${JSON.stringify({
  name: 'browser-contract-fixture',
  private: true,
  scripts: {
    'ui:pass': 'node -e "process.stdout.write(\'ui-ok\')"'
  }
}, null, 2)}\n`);

const server = http.createServer((request, response) => {
  if (request.url === '/ok') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Route OK</title><p>ready</p>');
    return;
  }
  if (request.url === '/events') {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': connected\n\n');
    return;
  }
  if (request.url === '/large') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Large Route</title>${'x'.repeat(200000)}`);
    return;
  }
  if (request.url === '/redirect-local') {
    response.writeHead(302, { location: '/ok' });
    response.end();
    return;
  }
  if (request.url === '/redirect-external') {
    response.writeHead(302, { location: 'https://example.com/' });
    response.end();
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('missing');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP port');
fs.writeFileSync(path.join(stateDir, 'connection.json'), `${JSON.stringify({ host: '127.0.0.1', port: address.port })}\n`);

const previousStateDir = process.env.REL_AI_MCP_STATE_DIR;
process.env.REL_AI_MCP_STATE_DIR = stateDir;
const workspace = { alias: 'repo', path: workspaceRoot };

try {
  const probe = await relaiHttpProbe(workspace, {}, { route: '/ok' });
  assert.equal(probe.ok, true);
  assert.equal(probe.route, '/ok');
  assert.equal(probe.statusCode, 200);
  assert.equal(probe.title, 'Route OK');
  assert.equal(probe.reachable, true);

  const localRedirect = await relaiHttpProbe(workspace, {}, { route: '/redirect-local' });
  assert.equal(localRedirect.ok, true);
  assert.equal(localRedirect.title, 'Route OK');
  assert.match(localRedirect.finalUrl, /\/ok$/);

  const externalRedirect = await relaiHttpProbe(workspace, {}, { route: '/redirect-external' });
  assert.equal(externalRedirect.ok, false);
  assert.equal(externalRedirect.reachable, false);
  assert.match(externalRedirect.error, /redirect outside the configured local Rel\.AI origin/i);

  const large = await relaiHttpProbe(workspace, {}, { route: '/large' });
  assert.equal(large.ok, true);
  assert.equal(large.title, 'Large Route');
  assert.ok(large.responseBytes > 200000, 'the probe must count the full streamed response without buffering it all');

  const streaming = await relaiHttpProbe(workspace, {}, { route: '/events', timeoutMs: 1000 });
  assert.equal(streaming.ok, true, 'an established SSE connection is reachable without waiting for its body to end');
  assert.equal(streaming.reachable, true);
  assert.equal(streaming.statusCode, 200);

  await assert.rejects(
    () => relaiHttpProbe(workspace, {}, { route: 'https://example.com/' }),
    /local path beginning with one '\/'/,
    'the dedicated HTTP probe must reject arbitrary URLs'
  );
  await assert.rejects(
    () => relaiHttpProbe(workspace, {}, { route: '//example.com/' }),
    /protocol-relative URLs are not accepted/,
    'the dedicated HTTP probe must reject protocol-relative URLs'
  );
  await assert.rejects(
    () => relaiHttpProbe(workspace, {}, { route: '/\\\\example.com/' }),
    /configured local Rel\.AI origin/,
    'backslash-normalized routes must not escape the local origin'
  );
  console.log('HTTP probing contract passed. Named package scripts execute through relai_validate action checks.');
} finally {
  if (previousStateDir == null) delete process.env.REL_AI_MCP_STATE_DIR;
  else process.env.REL_AI_MCP_STATE_DIR = previousStateDir;
  server.close();
  await once(server, 'close');
  fs.rmSync(temp, { recursive: true, force: true });
}
