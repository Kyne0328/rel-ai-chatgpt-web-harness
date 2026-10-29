export const EXPERIMENTAL_FEATURE_CHANGE_EVENT = 'relai:experimental-feature-change';

const LEGACY_DEVELOPER_MODE_STORAGE_KEY = 'relai_developer_mode_enabled';
const LEGACY_EXTENSIONS_STORAGE_KEY = 'relai_developer_feature_extensions_enabled';

export const EXPERIMENTAL_FEATURES = Object.freeze({
  extensions: Object.freeze({
    id: 'extensions',
    label: 'Extensions',
    help: 'Show the experimental Extensions catalog in the main menu and quick navigation.',
    storageKey: 'relai_experimental_feature_extensions_enabled'
  })
});

function experimentalFeature(feature) {
  return EXPERIMENTAL_FEATURES[String(feature || '')] || null;
}

export function readExperimentalFeatureEnabled(feature) {
  const definition = experimentalFeature(feature);
  if (!definition) return false;
  try {
    const stored = window.localStorage.getItem(definition.storageKey);
    if (stored !== null) return stored === '1';
    if (definition.id === 'extensions') {
      const previous = window.localStorage.getItem(LEGACY_EXTENSIONS_STORAGE_KEY);
      if (previous !== null) return previous === '1';
      return window.localStorage.getItem(LEGACY_DEVELOPER_MODE_STORAGE_KEY) === '1';
    }
  } catch {}
  return false;
}

export function writeExperimentalFeatureEnabled(feature, enabled) {
  const definition = experimentalFeature(feature);
  if (!definition) return false;
  const next = enabled === true;
  try {
    window.localStorage.setItem(definition.storageKey, next ? '1' : '0');
    if (definition.id === 'extensions') {
      window.localStorage.removeItem(LEGACY_EXTENSIONS_STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_DEVELOPER_MODE_STORAGE_KEY);
    }
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent(EXPERIMENTAL_FEATURE_CHANGE_EVENT, {
      detail: { feature: definition.id, enabled: next }
    }));
  } catch {}
  return next;
}
