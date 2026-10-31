export const DEVELOPER_OPTIONS_UNLOCK_KEY = 'relai_developer_options_unlocked';
export const DEVELOPER_OPTIONS_CHANGE_EVENT = 'relai:developer-options-change';

export function readDeveloperOptionsUnlocked() {
  try { return window.localStorage.getItem(DEVELOPER_OPTIONS_UNLOCK_KEY) === '1'; }
  catch { return false; }
}

export function unlockDeveloperOptions() {
  try { window.localStorage.setItem(DEVELOPER_OPTIONS_UNLOCK_KEY, '1'); }
  catch {}
  window.dispatchEvent(new Event(DEVELOPER_OPTIONS_CHANGE_EVENT));
}
