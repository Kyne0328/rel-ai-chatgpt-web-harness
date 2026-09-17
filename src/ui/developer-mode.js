export const DEVELOPER_OPTIONS_STORAGE_KEY = 'relai_developer_options_unlocked';
export const DEVELOPER_MODE_STORAGE_KEY = 'relai_developer_mode_enabled';
export const DEVELOPER_MODE_CHANGE_EVENT = 'relai:developer-mode-change';

export function readDeveloperOptionsUnlocked() {
  try { return window.localStorage.getItem(DEVELOPER_OPTIONS_STORAGE_KEY) === '1'; } catch { return false; }
}

export function unlockDeveloperOptions() {
  try { window.localStorage.setItem(DEVELOPER_OPTIONS_STORAGE_KEY, '1'); } catch {}
}

export function readDeveloperModeEnabled() {
  try { return window.localStorage.getItem(DEVELOPER_MODE_STORAGE_KEY) === '1'; } catch { return false; }
}

export function writeDeveloperModeEnabled(enabled) {
  const next = enabled === true;
  try { window.localStorage.setItem(DEVELOPER_MODE_STORAGE_KEY, next ? '1' : '0'); } catch {}
  try { window.dispatchEvent(new CustomEvent(DEVELOPER_MODE_CHANGE_EVENT, { detail: { enabled: next } })); } catch {}
  return next;
}
