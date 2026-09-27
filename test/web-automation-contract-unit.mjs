import assert from 'node:assert/strict';
import { getToolActionCatalog } from '../src/tools/actionCatalog.js';
import { serializeConnectorResult } from '../src/tools/connector.js';
import { validateToolOutput } from '../src/tools/outputValidation.js';
import { toolResult } from '../src/mcp/results.js';
import {
  isAllowedResourceUrl,
  normalizeUiRoute,
  resolveUiRoute,
  sanitizeUiUrl
} from '../src/webAutomationManager.js';

assert.equal(normalizeUiRoute('/dashboard#settings'), '/dashboard#settings');
assert.throws(() => normalizeUiRoute('https://example.com'), /local path/);
assert.throws(() => normalizeUiRoute('//example.com/path'), /Protocol-relative/);
assert.throws(() => normalizeUiRoute('/safe\\..\\escape'), /Backslashes/);
assert.equal(resolveUiRoute('http://127.0.0.1:3333', '/dashboard#usage'), 'http://127.0.0.1:3333/dashboard#usage');

const ports = new Set([3000, 3333]);
assert.equal(isAllowedResourceUrl('http://127.0.0.1:3000/app.js', ports), true);
assert.equal(isAllowedResourceUrl('https://localhost:3333/api', ports), true);
assert.equal(isAllowedResourceUrl('http://127.0.0.1:4444/api', ports), false);
assert.equal(isAllowedResourceUrl('https://example.com/', ports), false);
assert.equal(isAllowedResourceUrl('file:///etc/passwd', ports), false);
assert.equal(isAllowedResourceUrl('data:text/plain,ok', ports), true);

const redacted = sanitizeUiUrl('http://user:secret@localhost:3333/path?token=super-secret#section');
assert.equal(redacted.includes('super-secret'), false);
assert.equal(redacted.includes('user'), false);
assert.equal(redacted.includes('secret@'), false);
assert.match(redacted, /^http:\/\/localhost:3333\/path\?/);
assert.match(redacted, /#section$/);

const png = Buffer.from('not-a-real-png-for-contract-only').toString('base64');
const screenshotArgs = {
  workspace: 'repo',
  action: 'screenshot',
  work_id: 'work_contract',
  sessionId: 'ui_contract_contract_contract'
};
const connectorScreenshot = serializeConnectorResult({
  publicName: 'relai_ui',
  action: 'screenshot',
  operationName: 'relai_ui',
  value: {
    ok: true,
    workspace: 'repo',
    action: 'screenshot',
    sessionId: screenshotArgs.sessionId,
    image: { mimeType: 'image/png', data: png, bytes: 32, width: 800, height: 600 }
  },
  args: screenshotArgs,
  workId: 'work_contract'
});
await validateToolOutput({}, 'relai_ui', screenshotArgs, connectorScreenshot);
assert.equal(connectorScreenshot.image.data, png);
const result = toolResult(connectorScreenshot, false);
assert.equal(result.content.length, 2);
assert.deepEqual(result.content[1], { type: 'image', data: png, mimeType: 'image/png' });
assert.equal(result.structuredContent.image.data, undefined);
assert.equal(result.structuredContent.image.mimeType, 'image/png');
assert.equal(result.structuredContent.image.bytes, 32);
assert.equal(result.structuredContent.work_id, undefined, 'routine screenshot success must not echo caller-owned task identity');
assert.equal(result.structuredContent.workspace, 'repo', 'routine screenshot success must retain required workspace identity');
assert.equal(result.structuredContent.action, 'screenshot', 'routine success must retain action identity');
assert.equal(result.structuredContent.sessionId, screenshotArgs.sessionId, 'routine success must retain resource identity');

const nestedPng = Buffer.from('nested-image-contract').toString('base64');
const batchResult = toolResult({
  ok: true,
  action: 'batch',
  results: [
    { ok: true, action: 'click', executed: true },
    { ok: true, action: 'screenshot', image: { mimeType: 'image/png', data: png, bytes: 32, width: 800, height: 600 } },
    { ok: true, action: 'screenshot', image: { mimeType: 'image/png', data: nestedPng, bytes: 21, width: 400, height: 300 } }
  ]
}, false);
assert.equal(batchResult.content.length, 3, 'nested batch screenshots must become independent MCP image content items');
assert.deepEqual(batchResult.content[1], { type: 'image', data: png, mimeType: 'image/png' });
assert.deepEqual(batchResult.content[2], { type: 'image', data: nestedPng, mimeType: 'image/png' });
assert.equal(batchResult.structuredContent.results[1].image.data, undefined, 'nested screenshot base64 must not remain in structured content');
assert.equal(batchResult.structuredContent.results[2].image.data, undefined, 'every nested screenshot must be sanitized');

const uiActions = getToolActionCatalog().filter(entry => entry.publicTool === 'relai_ui');
assert.deepEqual(uiActions.map(entry => entry.action), [
  'start', 'navigate', 'snapshot', 'interact', 'screenshot',
  'console', 'network', 'viewport', 'reload', 'stop'
]);
assert.ok(uiActions.every(entry => entry.operationName === 'ui'));
const uiByAction = new Map(uiActions.map(entry => [entry.action, entry]));
for (const action of ['start', 'navigate', 'snapshot', 'interact', 'screenshot', 'console', 'network', 'viewport', 'reload', 'stop']) {
  assert.equal(uiByAction.get(action)?.behavior.taskScope, 'optional', `${action} must use principal/workspace/session authority without requiring a synthetic task`);
}

console.log('Web automation contracts are bounded, local-only, and image-capable.');
