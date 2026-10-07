import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'win32');
const helper = process.argv[2] || fileURLToPath(new URL('../src/windows-process-job-host.exe', import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relai-job-profile-'));
const samples = [];
try {
  for (let i = 0; i < 9; i++) {
    const nonce = crypto.randomBytes(32).toString('hex');
    const request = path.join(root, 'request.json'), receipt = path.join(root, 'receipt.json');
    const environmentTransportKey = 'REL_AI_JOB_ENV_' + nonce;
    await fs.writeFile(request, JSON.stringify({ protocol: 1, nonce, executable: path.join(process.env.SystemRoot, 'System32/cmd.exe'),
      args: ['/d', '/c', 'exit', '0'], cwd: root, environmentTransportKey }));
    const started = Date.now();
    const child = spawn(helper, ['-RequestPath', request, '-ReceiptPath', receipt, '-ControlPath', path.join(root, 'control.json')], {
      windowsHide: true, stdio: 'pipe', env: { SystemRoot: process.env.SystemRoot, REL_AI_JOB_PROFILE: '1',
        [environmentTransportKey]: JSON.stringify({ protocol: 1, nonce, entries: Object.entries(process.env) }) }
    });
    child.stdin.end(); child.stdout.resume(); child.stderr.resume();
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    const result = JSON.parse(await fs.readFile(receipt, 'utf8'));
    assert.equal(code, 0); assert.equal(result.nonce, nonce); assert.equal(result.cleanupConfirmed, true);
    samples.push({ wallMs: Date.now() - started, beforeMainMs: Number(BigInt(result.profile_mainEntered) / 10000n - 62135596800000n) - started,
      ...Object.fromEntries(Object.entries(result).filter(([key]) => key.startsWith('profile_') && key !== 'profile_mainEntered')
        .map(([key, value]) => [key.slice(8) + 'Ms', Number(value) / 10000])) });
  }
  console.log(JSON.stringify({ samples }, null, 2));
} finally { await fs.rm(root, { recursive: true, force: true }); }
