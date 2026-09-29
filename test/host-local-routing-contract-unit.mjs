import assert from 'node:assert/strict';

import { STATIC_CONTEXT } from '../src/context/static-context.js';
import { getPublicToolSchemas } from '../src/tools/schema.js';

const publicTools = new Map(getPublicToolSchemas().map(tool => [tool.name, tool]));
const descriptions = new Map([...publicTools].map(([name, tool]) => [name, String(tool.description || '')]));

const orderedRouting = [
  'AI-host native capability',
  'AI-host plugin/connector',
  'Rel.AI structured local',
  'Rel.AI browser',
  'Rel.AI computer control'
];
let previousIndex = -1;
for (const step of orderedRouting) {
  const index = STATIC_CONTEXT.indexOf(step);
  assert.ok(index > previousIndex, `${step} must appear in canonical routing order`);
  previousIndex = index;
}

for (const hostOwned of ['Public-web research', 'host files/apps']) {
  assert.match(STATIC_CONTEXT, new RegExp(escapeRegExp(hostOwned), 'i'), `${hostOwned} must remain host-owned`);
}

for (const localOwned of ['files/repos', 'Git', 'CLI/processes', 'LAN/intranet', 'apps', 'browser sessions', 'uploads/downloads']) {
  assert.match(STATIC_CONTEXT, new RegExp(escapeRegExp(localOwned), 'i'), `${localOwned} must remain inside the Rel.AI local boundary`);
}

const read = descriptions.get('relai_read');
assert.match(read, /local workspace files/i);
assert.match(read, /Host-uploaded files stay host-owned/i);
assert.match(read, /asResource:true.*resource_link.*transfer or download/i);

const edit = descriptions.get('relai_edit');
assert.match(edit, /Mutates authorized workspace files or environment/i);
assert.match(edit, /host file import/i);

const ui = descriptions.get('relai_ui');
assert.match(ui, /Bounded QA.*allowed localhost app/i);
assert.match(ui, /machine-local browsing belongs in relai_browser/i);
assert.match(ui, /public web stays host-owned/i);

const browser = descriptions.get('relai_browser');
assert.match(browser, /Local browser/i);
assert.match(browser, /localhost\/LAN\/intranet\/VPN/i);
assert.match(browser, /machine-authenticated sessions/i);
assert.match(browser, /workspace file transfer/i);
assert.match(browser, /public web stays host-owned/i);
const browserTool = publicTools.get('relai_browser');
const browserActions = browserTool?.inputSchema?.properties?.action?.enum || [];
assert.deepEqual(browserTool?.inputSchema?.properties?.detail?.enum, ['semantic', 'layout'], 'relai_browser must expose semantic and layout snapshot detail modes');
for (const action of ['status', 'start', 'tabs', 'navigate', 'snapshot', 'upload', 'download', 'handoff', 'resume', 'clear_profile', 'stop']) {
  assert.ok(browserActions.includes(action), `relai_browser must expose ${action}`);
}

const desktop = descriptions.get('relai_desktop');
assert.match(desktop, /Structured local OS actions/i);
assert.match(desktop, /relai_computer is the UI fallback/i);

const computer = descriptions.get('relai_computer');
assert.match(computer, /final fallback for local desktop input/i);
assert.match(computer, /structured local and browser capabilities/i);
assert.match(computer, /per-app approval/i);

const decisions = [
  ['Research today\'s AI news', /Public-web research/i, null],
  ['Check Gmail', /AI-host plugin\/connector/i, null],
  ['Run tests in C:\\repo', /CLI\/processes/i, null],
  ['Read D:\\contract.pdf', /files\/repos/i, null],
  ['Open our internal 192.168.x.x dashboard', /LAN\/intranet/i, /Local browser.*localhost\/LAN\/intranet\/VPN/i],
  ['Save a host-generated artifact into the local workspace', /Rel\.AI structured local/i, /host file import/i],
  ['Change a setting in a native desktop application', /\bapps\b/i, /Structured local OS actions/i]
];
for (const [scenario, contextPattern, toolPattern] of decisions) {
  assert.match(STATIC_CONTEXT, contextPattern, `${scenario} must be decidable from the canonical host/local contract`);
  if (toolPattern) {
    const combinedToolDescriptions = `${ui}\n${browser}\n${edit}\n${desktop}\n${computer}`;
    assert.match(combinedToolDescriptions, toolPattern, `${scenario} must be supported by public tool descriptions`);
  }
}

console.log('Host/local routing contract keeps host-native work out of Rel.AI and orders local structured/browser/computer fallbacks.');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
