import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getStateDir } from '../stateLayout.js';

const BROWSER_PROFILE_MODES = Object.freeze(['ephemeral', 'persistent'] as const);
const BROWSER_SITE_REGISTRY_FILE = '.relai-sites.json';
const registryWrites = new Map<string, Promise<void>>();
type BrowserProfileMode = typeof BROWSER_PROFILE_MODES[number];

function normalizeBrowserProfileMode(value: unknown): BrowserProfileMode {
  const mode = String(value || 'persistent').trim().toLowerCase();
  if (mode !== 'ephemeral' && mode !== 'persistent') {
    throw new Error('Browser profile must be ephemeral or persistent.');
  }
  return mode;
}

function persistentBrowserProfileRoot(config: Record<string, unknown> = {}): string {
  return path.join(path.resolve(getStateDir(config)), 'browser', 'profiles');
}

function browserProfileDirectory(config: Record<string, unknown>, principalFingerprint: string): string {
  const fingerprint = String(principalFingerprint || '').trim();
  if (!fingerprint) throw new Error('Persistent browser profile requires a principal fingerprint.');
  const principalKey = crypto.createHash('sha256').update(fingerprint, 'utf8').digest('hex');
  return path.join(persistentBrowserProfileRoot(config), principalKey, 'default');
}

function preparePersistentBrowserProfile(config: Record<string, unknown>, principalFingerprint: string): string {
  const directory = browserProfileDirectory(config, principalFingerprint);
  const root = persistentBrowserProfileRoot(config);
  const rootExisting = safeLstat(root);
  if (rootExisting?.isSymbolicLink()) throw new Error('Persistent browser profile root must not be a symbolic link.');
  if (rootExisting && !rootExisting.isDirectory()) throw new Error('Persistent browser profile root is not a directory.');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  const principalDirectory = path.dirname(directory);
  const principalExisting = safeLstat(principalDirectory);
  if (principalExisting?.isSymbolicLink()) throw new Error('Persistent browser profile principal path must not be a symbolic link.');
  if (principalExisting && !principalExisting.isDirectory()) throw new Error('Persistent browser profile principal path is not a directory.');
  fs.mkdirSync(principalDirectory, { recursive: true, mode: 0o700 });

  const existing = safeLstat(directory);
  if (existing?.isSymbolicLink()) throw new Error('Persistent browser profile path must not be a symbolic link.');
  if (existing && !existing.isDirectory()) throw new Error('Persistent browser profile path is not a directory.');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
  return directory;
}

async function waitPersistentBrowserSiteWrites(profileDirectory: string): Promise<void> {
  await registryWrites.get(path.resolve(profileDirectory))?.catch(() => {});
}

function assertPersistentBrowserProfileSafe(config: Record<string, unknown>, principalFingerprint: string): string {
  const root = persistentBrowserProfileRoot(config);
  const directory = browserProfileDirectory(config, principalFingerprint);
  const principalDirectory = path.dirname(directory);
  for (const [target, label] of [[root, 'root'], [principalDirectory, 'principal path'], [directory, 'path']] as const) {
    const existing = safeLstat(target);
    if (!existing) continue;
    if (existing.isSymbolicLink()) throw new Error(`Refusing to clear a symbolic-link browser profile ${label}.`);
    if (!existing.isDirectory()) throw new Error(`Browser profile ${label} is not a directory.`);
  }
  return directory;
}

async function clearPersistentBrowserProfile(config: Record<string, unknown>, principalFingerprint: string): Promise<{ cleared: boolean }> {
  const directory = assertPersistentBrowserProfileSafe(config, principalFingerprint);
  const principalDirectory = path.dirname(directory);
  if (!safeLstat(directory)) return { cleared: false };
  await waitPersistentBrowserSiteWrites(directory);
  await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  try {
    if ((await fs.promises.readdir(principalDirectory)).length === 0) await fs.promises.rmdir(principalDirectory);
  } catch {}
  return { cleared: true };
}

async function clearPersistentBrowserProfiles(config: Record<string, unknown> = {}): Promise<{ cleared: boolean }> {
  const root = persistentBrowserProfileRoot(config);
  const existing = safeLstat(root);
  if (!existing) return { cleared: false };
  if (existing.isSymbolicLink()) throw new Error('Refusing to clear a symbolic-link browser profile root.');
  if (!existing.isDirectory()) throw new Error('Browser profile root is not a directory.');
  await Promise.allSettled([...registryWrites.values()]);
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  return { cleared: true };
}

function persistentBrowserProfileDirectories(config: Record<string, unknown> = {}): string[] {
  const root = persistentBrowserProfileRoot(config);
  const rootExisting = safeLstat(root);
  if (!rootExisting) return [];
  if (rootExisting.isSymbolicLink()) throw new Error('Persistent browser profile root must not be a symbolic link.');
  if (!rootExisting.isDirectory()) throw new Error('Persistent browser profile root is not a directory.');
  const directories: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = path.join(root, entry.name, 'default');
    const existing = safeLstat(candidate);
    if (existing?.isDirectory() && !existing.isSymbolicLink()) directories.push(candidate);
  }
  return directories.sort((left, right) => left.localeCompare(right));
}

function normalizePersistentBrowserSiteOrigin(value: unknown): string {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : '';
  } catch { return ''; }
}

async function readPersistentBrowserSites(profileDirectory: string): Promise<string[]> {
  const registryPath = path.join(path.resolve(profileDirectory), BROWSER_SITE_REGISTRY_FILE);
  try {
    const parsed = JSON.parse(await fs.promises.readFile(registryPath, 'utf8'));
    const values = Array.isArray(parsed) ? parsed : [];
    return [...new Set(values.map(normalizePersistentBrowserSiteOrigin).filter(Boolean))].sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || error instanceof SyntaxError) return [];
    throw error;
  }
}

async function recordPersistentBrowserSite(profileDirectory: string, value: unknown): Promise<void> {
  const origin = normalizePersistentBrowserSiteOrigin(value);
  if (!origin) return;
  await updatePersistentBrowserSites(profileDirectory, sites => sites.add(origin));
}

async function forgetPersistentBrowserSite(profileDirectory: string, value: unknown): Promise<void> {
  const origin = normalizePersistentBrowserSiteOrigin(value);
  if (!origin) return;
  await updatePersistentBrowserSites(profileDirectory, sites => sites.delete(origin));
}

async function updatePersistentBrowserSites(profileDirectory: string, mutate: (sites: Set<string>) => void): Promise<void> {
  const directory = path.resolve(profileDirectory);
  const previous = registryWrites.get(directory) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const sites = new Set(await readPersistentBrowserSites(directory));
    mutate(sites);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const registryPath = path.join(directory, BROWSER_SITE_REGISTRY_FILE);
    const temporaryPath = `${registryPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify([...sites].sort(), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.promises.rename(temporaryPath, registryPath);
  });
  registryWrites.set(directory, current);
  try { await current; } finally { if (registryWrites.get(directory) === current) registryWrites.delete(directory); }
}

function safeLstat(file: string): fs.Stats | null {
  try { return fs.lstatSync(file); } catch { return null; }
}

export {
  assertPersistentBrowserProfileSafe, browserProfileDirectory, clearPersistentBrowserProfile, clearPersistentBrowserProfiles,
  forgetPersistentBrowserSite, normalizeBrowserProfileMode, persistentBrowserProfileDirectories,
  persistentBrowserProfileRoot, preparePersistentBrowserProfile, readPersistentBrowserSites, recordPersistentBrowserSite, waitPersistentBrowserSiteWrites
};
export type { BrowserProfileMode };
