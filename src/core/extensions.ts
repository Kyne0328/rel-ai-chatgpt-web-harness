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

export async function addDashboardExtensionSource(input: string): Promise<Record<string, unknown>> {
  const current = readConfig();
  const source = await validateExtensionSource(current, input);
  const next = structuredClone(current);
  next.extensions = next.extensions || { sources: [] };
  next.extensions.sources = Array.isArray(next.extensions.sources) ? next.extensions.sources : [];
  next.extensions.sources.push({ repositoryUrl: source.repositoryUrl, catalogUrl: source.catalogUrl });
  writeConfig(next);
  return { ok: true, source };
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
