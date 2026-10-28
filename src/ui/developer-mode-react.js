import { useCallback, useSyncExternalStore } from 'react';
import { DEVELOPER_FEATURE_CHANGE_EVENT, DEVELOPER_FEATURES, readDeveloperFeatureEnabled } from './developer-mode.js';

export function useDeveloperFeatureEnabled(feature) {
  const definition = DEVELOPER_FEATURES[String(feature || '')];
  const subscribe = useCallback(listener => {
    if (!definition) return () => {};
    const onFeatureChange = event => {
      if (!event?.detail?.feature || event.detail.feature === definition.id) listener();
    };
    const onStorage = event => {
      if (event.key === definition.storageKey) listener();
    };
    window.addEventListener(DEVELOPER_FEATURE_CHANGE_EVENT, onFeatureChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(DEVELOPER_FEATURE_CHANGE_EVENT, onFeatureChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [definition]);
  const snapshot = useCallback(() => readDeveloperFeatureEnabled(feature), [feature]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
