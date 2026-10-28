const DEVELOPER_OPTIONS_STORAGE_KEY = 'relai_developer_options_unlocked';
export const DEVELOPER_FEATURE_CHANGE_EVENT = 'relai:developer-feature-change';

const LEGACY_DEVELOPER_MODE_STORAGE_KEY = 'relai_developer_mode_enabled';
const TECHNICAL_DETAILS_ROOT_ATTRIBUTE = 'data-relai-technical-details';

export const DEVELOPER_FEATURES = Object.freeze({
  extensions: Object.freeze({
    id: 'extensions',
    label: 'Enable Extensions',
    help: 'Show Extensions in the main menu and quick navigation. This feature is experimental.',
    storageKey: 'relai_developer_feature_extensions_enabled'
  }),
  technicalDetails: Object.freeze({
    id: 'technicalDetails',
    label: 'Show technical details',
    help: 'Expose runtime/build provenance, raw operation records, task traces, internal identifiers, and tool schemas throughout the app. Intended for development and support.',
    storageKey: 'relai_developer_feature_technical_details_enabled'
  })
});

function developerFeature(feature) {
  return DEVELOPER_FEATURES[String(feature || '')] || null;
}

export function readDeveloperOptionsUnlocked() {
  try { return window.localStorage.getItem(DEVELOPER_OPTIONS_STORAGE_KEY) === '1'; } catch { return false; }
}

export function unlockDeveloperOptions() {
  try { window.localStorage.setItem(DEVELOPER_OPTIONS_STORAGE_KEY, '1'); } catch {}
}

export function readDeveloperFeatureEnabled(feature) {
  const definition = developerFeature(feature);
  if (!definition) return false;
  try {
    const stored = window.localStorage.getItem(definition.storageKey);
    if (stored !== null) return stored === '1';
    if (definition.id === 'extensions') return window.localStorage.getItem(LEGACY_DEVELOPER_MODE_STORAGE_KEY) === '1';
  } catch {}
  return false;
}

export function writeDeveloperFeatureEnabled(feature, enabled) {
  const definition = developerFeature(feature);
  if (!definition) return false;
  const next = enabled === true;
  try {
    window.localStorage.setItem(definition.storageKey, next ? '1' : '0');
    if (definition.id === 'extensions') window.localStorage.removeItem(LEGACY_DEVELOPER_MODE_STORAGE_KEY);
  } catch {}
  if (definition.id === 'technicalDetails') syncTechnicalDetailsPresentation(next);
  try {
    window.dispatchEvent(new CustomEvent(DEVELOPER_FEATURE_CHANGE_EVENT, {
      detail: { feature: definition.id, enabled: next }
    }));
  } catch {}
  return next;
}

function syncTechnicalDetailsPresentation(enabled = readDeveloperFeatureEnabled('technicalDetails')) {
  if (typeof document === 'undefined') return;
  if (enabled) document.documentElement?.setAttribute?.(TECHNICAL_DETAILS_ROOT_ATTRIBUTE, '');
  else document.documentElement?.removeAttribute?.(TECHNICAL_DETAILS_ROOT_ATTRIBUTE);
}

syncTechnicalDetailsPresentation();
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', event => {
    if (event?.key === DEVELOPER_FEATURES.technicalDetails.storageKey) syncTechnicalDetailsPresentation();
  });
}
