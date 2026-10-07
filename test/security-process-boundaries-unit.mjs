import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runProcess } from '../src/process.js';
import { makeProcessEnvironment, makeServiceProcessEnvironment, makeTunnelProcessEnvironment } from '../src/processEnvironment.js';

const inheritedSecret = 'relai-inherited-secret';
const source = {
  PATH: process.env.PATH || '',
  HOME: '/safe/home',
  SSH_AUTH_SOCK: inheritedSecret,
  SSH_AGENT_PID: '4242',
  GIT_ASKPASS: inheritedSecret,
  GIT_SSH: inheritedSecret,
  GIT_SSH_COMMAND: inheritedSecret,
  OPENAI_API_KEY: inheritedSecret,
  HTTPS_PROXY: 'http://127.0.0.1:8080'
};

const defaultEnvironment = makeProcessEnvironment({}, { source });
assert.equal(defaultEnvironment.HOME, '/safe/home');
assert.equal(defaultEnvironment.SSH_AUTH_SOCK, undefined);
assert.equal(defaultEnvironment.SSH_AGENT_PID, undefined);
assert.equal(defaultEnvironment.GIT_ASKPASS, undefined);
assert.equal(defaultEnvironment.GIT_SSH, undefined);
assert.equal(defaultEnvironment.GIT_SSH_COMMAND, undefined);
assert.equal(defaultEnvironment.OPENAI_API_KEY, undefined);

const publishEnvironment = makeProcessEnvironment({}, { source, inheritCredentials: true });
assert.equal(publishEnvironment.SSH_AUTH_SOCK, inheritedSecret);
assert.equal(publishEnvironment.GIT_ASKPASS, inheritedSecret);
assert.equal(publishEnvironment.OPENAI_API_KEY, undefined);

const explicitlyAllowed = makeProcessEnvironment({}, { source, allow: ['OPENAI_API_KEY'] });
assert.equal(explicitlyAllowed.OPENAI_API_KEY, inheritedSecret);

const serviceEnvironment = makeServiceProcessEnvironment({}, {
  source: {
    ...source,
    REL_AI_MCP_CONFIG: '/safe/config.json',
    REL_AI_MCP_GIT: '/safe/git',
    REL_AI_MCP_MAX_BODY_BYTES: '1048576',
    REL_AI_MCP_TASK_IDLE_MS: '900000',
    REL_AI_REQUEST_STATE_KEY: 'request-state-secret',
    REL_AI_UI_CHROMIUM_PATH: '/safe/chromium'
  }
});
assert.equal(serviceEnvironment.REL_AI_MCP_CONFIG, '/safe/config.json');
assert.equal(serviceEnvironment.REL_AI_MCP_GIT, '/safe/git');
assert.equal(serviceEnvironment.REL_AI_MCP_MAX_BODY_BYTES, '1048576');
assert.equal(serviceEnvironment.REL_AI_MCP_TASK_IDLE_MS, '900000');
assert.equal(serviceEnvironment.REL_AI_REQUEST_STATE_KEY, 'request-state-secret');
assert.equal(serviceEnvironment.REL_AI_UI_CHROMIUM_PATH, '/safe/chromium');
assert.equal(serviceEnvironment.SSH_AUTH_SOCK, undefined);
assert.equal(serviceEnvironment.OPENAI_API_KEY, undefined);

// Local timing is opt-in in the app launcher and must reach its service.
// It does not belong in arbitrary workspace commands or the tunnel client.
const diagnosticSource = { ...source, REL_AI_MCP_TRANSPORT_TIMING: '1' };
assert.equal(makeServiceProcessEnvironment({}, { source: diagnosticSource }).REL_AI_MCP_TRANSPORT_TIMING, '1');
assert.equal(makeServiceProcessEnvironment({}, { source }).REL_AI_MCP_TRANSPORT_TIMING, undefined);
assert.equal(makeProcessEnvironment({}, { source: diagnosticSource }).REL_AI_MCP_TRANSPORT_TIMING, undefined);
assert.equal(makeTunnelProcessEnvironment({}, { source: diagnosticSource }).REL_AI_MCP_TRANSPORT_TIMING, undefined);

const serviceWithExplicitPassThrough = makeServiceProcessEnvironment({}, { source, allow: ['OPENAI_API_KEY'] });
assert.equal(serviceWithExplicitPassThrough.OPENAI_API_KEY, inheritedSecret);

const tunnelEnvironment = makeTunnelProcessEnvironment({
  CONTROL_PLANE_API_KEY: 'tunnel-api-key',
  REL_AI_LOCAL_AUTH_HEADER: 'Bearer local-token'
}, { source });
assert.equal(tunnelEnvironment.CONTROL_PLANE_API_KEY, 'tunnel-api-key');
assert.equal(tunnelEnvironment.REL_AI_LOCAL_AUTH_HEADER, 'Bearer local-token');
assert.equal(tunnelEnvironment.HTTPS_PROXY, 'http://127.0.0.1:8080');
assert.equal(tunnelEnvironment.HOME, undefined);
assert.equal(tunnelEnvironment.SSH_AUTH_SOCK, undefined);
assert.equal(tunnelEnvironment.OPENAI_API_KEY, undefined);

assert.throws(
  () => makeProcessEnvironment({ NODE_OPTIONS: '--require attacker.js' }, { source }),
  /cannot be passed to child processes/
);
assert.throws(
  () => makeProcessEnvironment({ ELECTRON_RUN_AS_NODE: '1' }, { source }),
  /cannot be passed to child processes/
);
if (process.platform === 'win32') {
  assert.throws(
    () => makeProcessEnvironment({ node_options: '--require attacker.js' }, { source }),
    /cannot be passed to child processes/,
    'Windows environment-variable blocking must be case-insensitive'
  );
}

const inheritedKeys = ['SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GIT_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND'];
const previousValues = new Map(inheritedKeys.map(key => [key, process.env[key]]));
try {
  for (const key of inheritedKeys) process.env[key] = inheritedSecret;
  const probe = await runProcess(process.execPath, [
    '-e',
    'console.log(JSON.stringify({ssh:process.env.SSH_AUTH_SOCK,askpass:process.env.GIT_ASKPASS,gitSsh:process.env.GIT_SSH_COMMAND}))'
  ]);
  assert.equal(probe.exitCode, 0);
  assert.deepEqual(JSON.parse(probe.stdout), {});
} finally {
  for (const [key, value] of previousValues) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-git-boundary-'));
try {
  for (const args of [
    ['init'],
    ['config', 'user.email', 'security-test@example.invalid'],
    ['config', 'user.name', 'Rel.AI Security Test']
  ]) {
    const result = await runProcess('git', args, { cwd: repository });
    assert.equal(result.exitCode, 0, result.stderr || result.error || `git ${args.join(' ')} failed`);
  }
  fs.writeFileSync(path.join(repository, 'tracked.txt'), 'safe\n');
  const add = await runProcess('git', ['add', 'tracked.txt'], { cwd: repository });
  assert.equal(add.exitCode, 0, add.stderr || add.error || 'git add failed');

  const hook = path.join(repository, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\nexit 91\n');
  try { fs.chmodSync(hook, 0o755); } catch {}

  const commit = await runProcess('git', ['commit', '-m', 'security boundary regression'], { cwd: repository });
  assert.equal(commit.exitCode, 0, commit.stderr || commit.error || 'Rel.AI-owned Git must not execute repository hooks');
  await assert.rejects(
    runProcess('git', ['status'], { cwd: repository, shell: true }),
    /must run without shell parsing/,
    'future internal Git callers must not bypass the hardened argument boundary through shell mode'
  );
} finally {
  fs.rmSync(repository, { recursive: true, force: true });
}

console.log('Process credential isolation and Git execution boundary tests passed.');
