import assert from 'node:assert/strict';

import {
  DEVELOPER_FEATURE_CHANGE_EVENT,
  DEVELOPER_FEATURES,
  readDeveloperFeatureEnabled,
  writeDeveloperFeatureEnabled
} from '../src/ui/developer-mode.js';

const originalWindow = globalThis.window;
const originalCustomEvent = globalThis.CustomEvent;
const values = new Map();
const events = [];

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
  globalThis.window = {
    localStorage,
    dispatchEvent(event) {
      events.push(event);
      return true;
    }
  };

  assert.equal(readDeveloperFeatureEnabled('extensions'), false, 'Extensions must be disabled by default');
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
} finally {
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  if (originalCustomEvent === undefined) delete globalThis.CustomEvent;
  else globalThis.CustomEvent = originalCustomEvent;
}

console.log('Developer feature flags persist independently and migrate the legacy Extensions setting.');
