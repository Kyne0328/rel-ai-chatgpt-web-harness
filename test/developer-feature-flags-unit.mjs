import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEVELOPER_FEATURE_CHANGE_EVENT,
  DEVELOPER_FEATURES,
  readDeveloperFeatureEnabled,
  writeDeveloperFeatureEnabled
} from '../src/ui/developer-mode.js';

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalCustomEvent = globalThis.CustomEvent;
const values = new Map();
const events = [];
const rootAttributes = new Set();

const localStorage = {
  getItem(key) {
    return values.has(key) ? values.get(key) : null;
  },
  setItem(key, value) {
    values.set(key, String(value));
  },
  removeItem(key) {
    values.delete(key);
  }
};

try {
  if (typeof globalThis.CustomEvent !== 'function') {
    globalThis.CustomEvent = class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    };
  }
  globalThis.document = {
    documentElement: {
      setAttribute(name) { rootAttributes.add(name); },
      removeAttribute(name) { rootAttributes.delete(name); }
    }
  };
  globalThis.window = {
    localStorage,
    dispatchEvent(event) {
      events.push(event);
      return true;
    }
  };

  assert.equal(readDeveloperFeatureEnabled('extensions'), false, 'Extensions must be disabled by default');
  assert.equal(readDeveloperFeatureEnabled('technicalDetails'), false, 'Technical details must be hidden in every build by default');
  assert.equal(readDeveloperFeatureEnabled('unknown-feature'), false, 'Unknown developer features must stay disabled');

  values.set('relai_developer_mode_enabled', '1');
  assert.equal(
    readDeveloperFeatureEnabled('extensions'),
    true,
    'The old Developer mode setting must preserve Extensions visibility until the new flag is changed'
  );

  assert.equal(writeDeveloperFeatureEnabled('extensions', false), false);
  assert.equal(values.get(DEVELOPER_FEATURES.extensions.storageKey), '0');
  assert.equal(values.has('relai_developer_mode_enabled'), false, 'Writing the Extensions flag must remove the legacy global setting');
  assert.equal(readDeveloperFeatureEnabled('extensions'), false);
  assert.equal(events.at(-1)?.type, DEVELOPER_FEATURE_CHANGE_EVENT);
  assert.deepEqual(events.at(-1)?.detail, { feature: 'extensions', enabled: false });

  assert.equal(writeDeveloperFeatureEnabled('extensions', true), true);
  assert.equal(values.get(DEVELOPER_FEATURES.extensions.storageKey), '1');
  assert.equal(readDeveloperFeatureEnabled('extensions'), true);

  assert.equal(writeDeveloperFeatureEnabled('technicalDetails', true), true);
  assert.equal(values.get(DEVELOPER_FEATURES.technicalDetails.storageKey), '1');
  assert.equal(readDeveloperFeatureEnabled('technicalDetails'), true);
  assert.equal(rootAttributes.has('data-relai-technical-details'), true, 'technical details must set the root presentation attribute');
  assert.equal(events.at(-1)?.type, DEVELOPER_FEATURE_CHANGE_EVENT);
  assert.deepEqual(events.at(-1)?.detail, { feature: 'technicalDetails', enabled: true });
  assert.equal(writeDeveloperFeatureEnabled('technicalDetails', false), false);
  assert.equal(readDeveloperFeatureEnabled('technicalDetails'), false);
  assert.equal(rootAttributes.has('data-relai-technical-details'), false, 'disabling technical details must remove the root presentation attribute');
} finally {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalCustomEvent === undefined) delete globalThis.CustomEvent;
  else globalThis.CustomEvent = originalCustomEvent;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const settings = readSource('src/ui/features/settings/react.js');
const diagnostics = readSource('src/ui/features/settings/diagnostics-react.js');
const activity = readSource('src/ui/features/activity/react.js');
const operationDiagnostics = readSource('src/ui/components/operation-diagnostics.js');
const appCss = readSource('src/ui/styles/app.css');
const tools = readSource('src/ui/features/tools/react.js');
const processes = readSource('src/ui/features/processes/react.js');
const workspaces = readSource('src/ui/features/workspaces/react.js');

assert.match(settings, /technicalDetailsEnabled \? buildIdOf\(buildStatus\) : ''/, 'About must hide build provenance unless technical details are enabled');
assert.match(diagnostics, /technicalDetailsEnabled && runtime\?\.buildIdentity\?\.buildId/, 'Troubleshooting must hide runtime build identity by default');
assert.match(diagnostics, /technicalDetailsEnabled \? h\('div', \{ className: 'diagnostic-section diagnostic-section-logs' \}/, 'Troubleshooting logs must require technical details');
assert.match(activity, /technicalDetailsEnabled \? h\('details', \{ className: 'activity-detail-technical'/, 'raw Activity records must require technical details');
assert.match(operationDiagnostics, /if \(!technicalDetailsEnabled\) return null;/, 'operation and runtime diagnostics must self-gate behind technical details');
assert.match(appCss, /:root:not\(\[data-relai-technical-details\]\) \.task-detail-technical/, 'task identifiers and trace export must be hidden outside technical details');
assert.match(tools, /technicalDetailsEnabled \? h\('details', \{ className: 'tool-parameters'/, 'raw tool names and parameters must require technical details');
assert.match(processes, /technicalDetailsEnabled && archivedRows\.length/, 'archived cleanup records must require technical details');
assert.match(workspaces, /technicalDetailsEnabled \? h\('details', \{ className: 'workspace-recovery-override'/, 'manual risk override must require technical details');

console.log('Developer feature flags keep internal UI hidden by default and expose it only through explicit technical details.');
