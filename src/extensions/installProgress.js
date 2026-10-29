// Short-lived, process-local progress for authenticated Extensions dashboard polling.
const operations = new Map();
function reportExtensionProgress(id, patch) {
  const key = String(id || '');
  if (!key) return;
  const previous = operations.get(key) || { id: key, status: 'installing', phase: 'Preparing', downloadedBytes: 0, totalBytes: null };
  const next = { ...previous, ...patch, id: key, updatedAt: Date.now() };
  operations.delete(key);
  operations.set(key, next);
  while (operations.size > 24) operations.delete(operations.keys().next().value);
}
function extensionProgress() {
  const now = Date.now();
  for (const [id, progress] of operations) {
    if (progress.status !== 'installing' && now - progress.updatedAt > 10 * 60_000) operations.delete(id);
  }
  return [...operations.values()];
}
export { reportExtensionProgress, extensionProgress };
