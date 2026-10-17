import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { relaiApplyPatch } from "../src/localRepoBridge.js";
import { GIT_EXECUTABLE } from './helpers/git-executable.mjs';

function git(args, options = {}) {
  return execFileSync(GIT_EXECUTABLE, args, options);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rel-ai-patch-smoke-'));
const workspacePath = path.join(temp, 'workspace');
const stateDir = path.join(temp, 'state');
fs.mkdirSync(workspacePath, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });

git(['init'], { cwd: workspacePath, stdio: 'ignore' });
git(['config', 'user.email', 'relai@example.test'], { cwd: workspacePath });
git(['config', 'user.name', 'RelAI Patch Smoke'], { cwd: workspacePath });
fs.writeFileSync(path.join(workspacePath, 'hello.txt'), 'Hello, world!\n');
fs.writeFileSync(path.join(workspacePath, '.npmrc'), 'registry=https://registry.npmjs.org/\nengine-strict=true\n');
git(['add', 'hello.txt', '.npmrc'], { cwd: workspacePath });
git(['commit', '-m', 'init'], { cwd: workspacePath, stdio: 'ignore' });

const config = { stateDir };
const workspace = { alias: 'smoke', path: workspacePath };

try {
  fs.writeFileSync(path.join(workspacePath, 'hello.txt'), 'Hello, updated world!\n');
  const diff = git(['diff', 'hello.txt'], { cwd: workspacePath }).toString('utf8');
  git(['checkout', '--', 'hello.txt'], { cwd: workspacePath });
  const applied = await relaiApplyPatch(workspace, { ...config, patch: { backup: false, requireCleanGit: true, maxUpdateBytes: 10 } }, { patch: diff, returnDiff: false });
  assert.equal(applied.ok, true);
  assert.match(fs.readFileSync(path.join(workspacePath, 'hello.txt'), 'utf8'), /updated world/);
  git(['checkout', '--', 'hello.txt'], { cwd: workspacePath });

  const credentialUnifiedDiff = `--- a/.npmrc
+++ b/.npmrc
@@ -1,2 +1 @@
-registry=https://registry.npmjs.org/
-engine-strict=true
+//registry.npmjs.org/:_authToken=top-secret
`;
  await assert.rejects(
    () => relaiApplyPatch(workspace, config, { patch: credentialUnifiedDiff, returnDiff: false }),
    (error) => error?.code === 'SENSITIVE_PATCH_REQUIRES_CONTENT_VALIDATION' && /proposed final content/.test(error.message)
  );
  assert.equal(
    fs.readFileSync(path.join(workspacePath, '.npmrc'), 'utf8'),
    'registry=https://registry.npmjs.org/\nengine-strict=true\n',
    'a refused unified diff must not alter the sensitive-classified file'
  );

  const timestampHeaderPatch = `--- /dev/null
+++ b/.env\t2024-01-01
@@ -0,0 +1 @@
+API_KEY=demo
`;
  await assert.rejects(
    () => relaiApplyPatch(workspace, config, { patch: timestampHeaderPatch, returnDiff: false }),
    (error) => error?.code === 'SENSITIVE_PATCH_REQUIRES_CONTENT_VALIDATION' && error.path === '.env'
  );
  assert.equal(fs.existsSync(path.join(workspacePath, '.env')), false, 'Git-canonical .env path must be rejected before apply');

  const sensitiveRenamePatch = `diff --git a/.npmrc b/public-config.txt
similarity index 100%
rename from .npmrc
rename to public-config.txt
`;
  await assert.rejects(
    () => relaiApplyPatch(workspace, config, { patch: sensitiveRenamePatch, returnDiff: false }),
    (error) => error?.code === 'SENSITIVE_PATCH_REQUIRES_CONTENT_VALIDATION' && error.path === '.npmrc'
  );
  assert.equal(fs.existsSync(path.join(workspacePath, '.npmrc')), true, 'sensitive rename source must remain unchanged');
  assert.equal(fs.existsSync(path.join(workspacePath, 'public-config.txt')), false, 'rejected rename must not create its destination');

  const credentialStructuredPatch = `*** Begin Patch
*** Update File: .npmrc
@@
-registry=https://registry.npmjs.org/
-engine-strict=true
+//registry.npmjs.org/:_authToken=top-secret
*** End Patch
`;
  const blockedStructured = await relaiApplyPatch(workspace, config, { patch: credentialStructuredPatch, returnDiff: false });
  assert.equal(blockedStructured.ok, false);
  assert.match(blockedStructured.error, /blocked sensitive path/);
  assert.equal(
    fs.readFileSync(path.join(workspacePath, '.npmrc'), 'utf8'),
    'registry=https://registry.npmjs.org/\nengine-strict=true\n',
    'a rejected structured patch must roll back the original public content'
  );

  const safeStructuredPatch = `*** Begin Patch
*** Update File: .npmrc
@@
 registry=https://registry.npmjs.org/
-engine-strict=true
+fund=false
*** End Patch
`;
  const safeStructured = await relaiApplyPatch(workspace, config, { patch: safeStructuredPatch, returnDiff: false });
  assert.equal(safeStructured.ok, true);
  assert.equal(fs.readFileSync(path.join(workspacePath, '.npmrc'), 'utf8'), 'registry=https://registry.npmjs.org/\nfund=false\n');

  await assert.rejects(
    () => relaiApplyPatch(workspace, config, { patch: '   ' }),
    /relai_edit requires non-empty updateText/
  );
  assert.equal(applied.ok, true, 'legacy patch tuning must not throttle or reject a valid edit after the hard cutover');

  const openAiPatch = `*** Begin Patch
*** Update File: hello.txt
@@
-Hello, world!
+Hello from OpenAI patch!
*** End Patch
`;
  const structured = await relaiApplyPatch(workspace, config, { patch: openAiPatch, returnDiff: false });
  assert.equal(structured.ok, true);
  assert.equal(structured.sourceFormat, 'openai-patch');
  assert.match(fs.readFileSync(path.join(workspacePath, 'hello.txt'), 'utf8'), /OpenAI patch/);
  git(['checkout', '--', 'hello.txt'], { cwd: workspacePath });

  fs.writeFileSync(path.join(workspacePath, 'obsolete.txt'), 'remove me\n');
  git(['add', 'obsolete.txt'], { cwd: workspacePath });
  git(['commit', '-m', 'add obsolete'], { cwd: workspacePath, stdio: 'ignore' });
  const deletePatch = `*** Begin Patch
*** Delete File: obsolete.txt
*** End Patch
`;
  const deleted = await relaiApplyPatch(workspace, config, { patch: deletePatch, returnDiff: false });
  assert.equal(deleted.ok, true);
  assert.equal(fs.existsSync(path.join(workspacePath, 'obsolete.txt')), false);

  const repeatPath = path.join(workspacePath, 'repeated.js');
  const repeated = 'function first() {\n  return 1;\n}\nfunction second() {\n  return 1;\n}\n';
  const updateRepeated = body => relaiApplyPatch(workspace, config, {
    patch: `*** Begin Patch\n*** Update File: repeated.js\n${body}\n*** End Patch\n`, returnDiff: false
  });
  fs.writeFileSync(repeatPath, repeated);
  assert.equal((await updateRepeated('@@ function second() {\n-  return 1;\n+  return 2;')).ok, true);
  assert.equal(fs.readFileSync(repeatPath, 'utf8'), repeated.replace('function second() {\n  return 1;', 'function second() {\n  return 2;'));
  for (const body of [
    '@@\n-  return 1;\n+  return 2;',
    '@@ function missing() {\n-  return 1;\n+  return 2;',
    '@@\n+// ambiguous insertion'
  ]) {
    fs.writeFileSync(repeatPath, repeated);
    await assert.rejects(() => updateRepeated(body), /ambiguous|does not match/);
    assert.equal(fs.readFileSync(repeatPath, 'utf8'), repeated, 'rejected placement must not mutate any bytes');
  }
  fs.writeFileSync(repeatPath, 'repeat\nmiddle\nrepeat\n');
  assert.equal((await updateRepeated('@@\n-repeat\n+last\n*** End of File')).ok, true);
  assert.equal(fs.readFileSync(repeatPath, 'utf8'), 'repeat\nmiddle\nlast\n');
  assert.equal((await updateRepeated('@@\n+appended\n*** End of File')).ok, true);
  assert.equal(fs.readFileSync(repeatPath, 'utf8'), 'repeat\nmiddle\nlast\nappended\n');
  fs.writeFileSync(repeatPath, repeated);
  assert.equal((await updateRepeated('@@ function second() {\n+  // second body')).ok, true);
  assert.equal(fs.readFileSync(repeatPath, 'utf8'), repeated.replace('function second() {\n', 'function second() {\n  // second body\n'));
  fs.writeFileSync(repeatPath, 'class First {\n  value = 1;\n}\nclass Second {\n  value = 1;\n}\n');
  assert.equal((await updateRepeated('@@ class Second {\n-  value = 1;\n+  value = 2;')).ok, true);
  assert.equal(fs.readFileSync(repeatPath, 'utf8'), 'class First {\n  value = 1;\n}\nclass Second {\n  value = 2;\n}\n');
  fs.writeFileSync(repeatPath, 'section\nvalue\nsection\nvalue\n');
  await assert.rejects(() => updateRepeated('@@ section\n-value\n+new'), /anchor is ambiguous/);
  assert.equal(fs.readFileSync(repeatPath, 'utf8'), 'section\nvalue\nsection\nvalue\n');

  console.log('Patch update smoke test passed.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
