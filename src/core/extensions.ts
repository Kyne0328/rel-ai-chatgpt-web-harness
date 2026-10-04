import { readConfig, writeConfig } from '../config.js';
import {
  configuredExtensionSources,
  extensionDashboard,
  extensionSourceId,
  installExtension,
  listInstalledExtensions,
  removeExtension,
  validateExtensionSource
} from '../extensions/registry.js';

export async function getExtensionsDashboard(refresh = false): Promise<Record<string, unknown>> {
  return await extensionDashboard(readConfig(), { refresh }) as Record<string, unknown>;
}

export async function installDashboardExtension(id: string, sourceId = ''): Promise<Record<string, unknown>> {
  return await installExtension(readConfig(), id, sourceId ? { sourceId } : {}) as Record<string, unknown>;
}

export function removeDashboardExtension(id: string): Record<string, unknown> {
  return removeExtension(readConfig(), id) as Record<string, unknown>;
}

let sourceAdditionQueue: Promise<unknown> = Promise.resolve();

export function addDashboardExtensionSource(input: string): Promise<Record<string, unknown>> {
  const operation = sourceAdditionQueue.then(async () => {
    const current = readConfig();
    if ((current.extensions?.sources?.length || 0) >= 20) {
      throw new Error('A maximum of 20 extension sources can be configured. Remove one before adding another.');
    }
    const source = await validateExtensionSource(current, input);
    // Validation performs network I/O. Preserve unrelated settings saved while
    // it was in flight, and serialize source additions so conflicts see the last save.
    const next = structuredClone(readConfig());
    next.extensions = next.extensions || { sources: [] };
    next.extensions.sources = Array.isArray(next.extensions.sources) ? next.extensions.sources : [];
    if (next.extensions.sources.some((item: { catalogUrl?: string }) => item.catalogUrl === source.catalogUrl)) {
      throw new Error('This extension source is already added.');
    }
    if (next.extensions.sources.length >= 20) {
      throw new Error('A maximum of 20 extension sources can be configured. Remove one before adding another.');
    }
    next.extensions.sources.push({ repositoryUrl: source.repositoryUrl, catalogUrl: source.catalogUrl });
    writeConfig(next);
    return { ok: true, source };
  });
  sourceAdditionQueue = operation.catch(() => {});
  return operation;
}

export function removeDashboardExtensionSource(sourceId: string): Record<string, unknown> {
  type SourceRecord = { id: string; catalogUrl: string };
  type InstalledRecord = { id: string; sourceId?: string; sourceCatalogUrl?: string };
  type ConfiguredRecord = { catalogUrl?: string };

  const id = String(sourceId || '').trim();
  if (!id || id === 'official') throw new Error('The official Rel.AI extension source cannot be removed.');
  const current = readConfig();
  const sources = configuredExtensionSources(current) as SourceRecord[];
  const source = sources.find(item => item.id === id);
  if (!source) throw new Error('Extension source is not configured.');
  const installed = (listInstalledExtensions(current) as InstalledRecord[]).filter(extension => (
    extension.sourceId === id || extension.sourceCatalogUrl === source.catalogUrl
  ));
  const next = structuredClone(current);
  next.extensions = next.extensions || { sources: [] };
  next.extensions.sources = (Array.isArray(next.extensions.sources) ? next.extensions.sources : [])
    .filter((item: ConfiguredRecord) => extensionSourceId(String(item?.catalogUrl || '')) !== id);
  writeConfig(next);
  return {
    ok: true,
    removed: true,
    sourceId: id,
    installedExtensions: installed.map(extension => extension.id)
  };
}
