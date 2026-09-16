import { readConfig } from '../config.js';
import { extensionDashboard, installExtension, removeExtension } from '../extensions/registry.js';

export async function getExtensionsDashboard(refresh = false): Promise<Record<string, unknown>> {
  return await extensionDashboard(readConfig(), { refresh }) as Record<string, unknown>;
}

export async function installDashboardExtension(id: string): Promise<Record<string, unknown>> {
  return await installExtension(readConfig(), id) as Record<string, unknown>;
}

export function removeDashboardExtension(id: string): Record<string, unknown> {
  return removeExtension(readConfig(), id) as Record<string, unknown>;
}
