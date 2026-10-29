import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPERIMENTAL_FEATURE_CHANGE_EVENT,
  EXPERIMENTAL_FEATURES,
  readExperimentalFeatureEnabled,
  writeExperimentalFeatureEnabled
} from '../src/ui/experimental-features.js';

const originalWindow = globalThis.window;
const originalCustomEvent = globalThis.CustomEvent;
const values = new Map();
const events = [];
const localStorage = {
  getItem(key) { return values.has(key) ? values.get(key) : null; },
  setItem(key, value) { values.set(key, String(value)); },
  removeItem(key) { values.delete(key); }
};

try {
  if (typeof globalThis.CustomEvent !== 'function') {
    globalThis.CustomEvent = class CustomEvent {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    };
  }
  globalThis.window = {
    localStorage,
    dispatchEvent(event) { events.push(event); return true; }
  };

  assert.equal(readExperimentalFeatureEnabled('extensions'), false, 'Extensions must remain off by default');
  assert.equal(readExperimentalFeatureEnabled('unknown-feature'), false, 'Unknown experimental features must stay disabled');

  values.set('relai_developer_mode_enabled', '1');
  assert.equal(readExperimentalFeatureEnabled('extensions'), true, 'The legacy global developer flag must migrate Extensions visibility');
  values.delete('relai_developer_mode_enabled');
  values.set('relai_developer_feature_extensions_enabled', '1');
  assert.equal(readExperimentalFeatureEnabled('extensions'), true, 'The legacy Extensions flag must migrate to Experimental features');

  assert.equal(writeExperimentalFeatureEnabled('extensions', false), false);
  assert.equal(values.get(EXPERIMENTAL_FEATURES.extensions.storageKey), '0');
  assert.equal(values.has('relai_developer_mode_enabled'), false);
  assert.equal(values.has('relai_developer_feature_extensions_enabled'), false);
  assert.equal(events.at(-1)?.type, EXPERIMENTAL_FEATURE_CHANGE_EVENT);
  assert.deepEqual(events.at(-1)?.detail, { feature: 'extensions', enabled: false });

  assert.equal(writeExperimentalFeatureEnabled('extensions', true), true);
  assert.equal(readExperimentalFeatureEnabled('extensions'), true);
} finally {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  if (originalCustomEvent === undefined) delete globalThis.CustomEvent;
  else globalThis.CustomEvent = originalCustomEvent;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const presentationFiles = [
  'src/ui/features/settings/react.js',
  'src/ui/features/settings/diagnostics-react.js',
  'src/ui/features/activity/react.js',
  'src/ui/features/sessions/react.js',
  'src/ui/features/tools/react.js',
  'src/ui/features/processes/react.js',
  'src/ui/features/workspaces/react.js'
];
const presentation = presentationFiles.map(readSource).join('\n');

for (const label of [
  'Show technical details',
  'Runtime details',
  'Source/build parity',
  'Copy event JSON',
  'Export trace (.jsonl)',
  'Raw target',
  'Raw result',
  'Safe metadata',
  'Raw error',
  'Archived recovery records',
  'Accept risk and unlock',
  'Technical output',
  'App log'
]) {
  assert.equal(presentation.includes(label), false, `Production UI must not render internal label: ${label}`);
}

const settings = readSource('src/ui/features/settings/react.js');
assert.match(settings, /developerOptionsUnlocked \? h\(DeveloperOptions/, 'Developer options are available only after the build unlock');
assert.match(settings, /href: '#extensions'/, 'Hidden Extensions manager remains reachable from developer options');
const diagnostics = readSource('src/ui/features/settings/diagnostics-react.js');
const activity = readSource('src/ui/features/activity/react.js');
const sessions = readSource('src/ui/features/sessions/react.js');
const tools = readSource('src/ui/features/tools/react.js');
const processes = readSource('src/ui/features/processes/react.js');
const workspaces = readSource('src/ui/features/workspaces/react.js');

assert.match(settings, /title: 'Developer options'/, 'Extensions must remain under unlocked developer options');
assert.match(diagnostics, /Export support information/, 'Troubleshooting must keep the support export');
assert.match(diagnostics, /Failed activity/, 'Troubleshooting must keep readable failed activity');
assert.doesNotMatch(diagnostics, /JSON\.stringify\(finding\.details/, 'Troubleshooting must not render raw finding JSON');
assert.doesNotMatch(activity, /safeEventProjection|RawDetail|activity-json-tree/, 'Activity must not keep raw event inspectors');
assert.doesNotMatch(sessions, /TechnicalDetails|data-export-task-trace|taskTraceJsonl|OperationDiagnostics/, 'Tasks must not keep technical records or trace export UI');
assert.doesNotMatch(tools, /tool\.parameters|tool-parameter-list/, 'Tools must not expose raw schemas');
assert.doesNotMatch(processes, /data-archive-recovery|Archive record|Restore record|useDeveloperFeatureEnabled/, 'Running Commands must not expose recovery bookkeeping');
assert.doesNotMatch(workspaces, /action: 'override'|Accept risk and unlock|Developer recovery details/, 'Projects must not expose the unsafe recovery override');

console.log('Extensions remain behind developer options; unrelated internal implementation details stay out of production surfaces.');
