import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverRepositoryTopology } from './workflow/topology.js';

type DiscoveredCommands = Record<string, string>;

interface DiscoveryWarning {
  readonly source: string;
  readonly message: string;
}

interface TopologyPackage {
  readonly path?: string;
  readonly ecosystem?: string;
  readonly scripts?: Readonly<Record<string, unknown>>;
}

interface RepositoryTopology {
  readonly fingerprint?: unknown;
  readonly packages?: readonly TopologyPackage[];
}

interface CommandDiscoveryOptions {
  readonly topology?: RepositoryTopology;
}

interface DiscoveryCacheEntry {
  readonly signature: unknown;
  readonly value: DiscoveredCommands;
  readonly warnings: readonly DiscoveryWarning[];
}

function _discoverNpmScripts(discovered: DiscoveredCommands, root: string): void {
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: unknown };
  if (!pkg?.scripts || typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts)) return;
  for (const [name, cmd] of Object.entries(pkg.scripts as Record<string, unknown>)) {
    if (typeof cmd === 'string' && cmd.trim()) discovered[`npm:${name}`] = `npm run ${name}`;
  }
}

function _discoverMakefile(discovered: DiscoveredCommands, root: string): void {
  const makePath = path.join(root, 'Makefile');
  if (!fs.existsSync(makePath)) return;
  const lines = fs.readFileSync(makePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(?:#.*)?$/.exec(line);
    if (match?.[1]) discovered[`make:${match[1]}`] = `make ${match[1]}`;
  }
}

function _discoverFlutter(discovered: DiscoveredCommands, root: string): void {
  if (!fs.existsSync(path.join(root, 'pubspec.yaml'))) return;
  discovered['flutter:analyze'] = 'flutter analyze';
  discovered['flutter:test'] = 'flutter test';
  discovered['dart:analyze'] = 'dart analyze';
}

function _discoverGo(discovered: DiscoveredCommands, root: string): void {
  if (!fs.existsSync(path.join(root, 'go.mod'))) return;
  discovered['go:test'] = 'go test ./...';
  discovered['go:build'] = 'go build ./...';
  discovered['go:vet'] = 'go vet ./...';
}

function _discoverCargo(discovered: DiscoveredCommands, root: string): void {
  if (!fs.existsSync(path.join(root, 'Cargo.toml'))) return;
  discovered['cargo:test'] = 'cargo test';
  discovered['cargo:build'] = 'cargo build';
  discovered['cargo:clippy'] = 'cargo clippy';
}

function _discoverPython(discovered: DiscoveredCommands, root: string): void {
  const hasPyproject = fs.existsSync(path.join(root, 'pyproject.toml'));
  const hasRequirements = fs.existsSync(path.join(root, 'requirements.txt'));
  if (!hasPyproject && !hasRequirements) return;
  discovered.pytest = 'pytest';
  discovered['python:lint'] = 'python -m flake8';
}

const DISCOVERY_CACHE_LIMIT = 32;
const MAX_DISCOVERY_WARNINGS = 8;
const discoveryCache = new Map<string, DiscoveryCacheEntry>();

function resolveTopology(workspacePath: string, topology?: RepositoryTopology): RepositoryTopology {
  return topology ?? discoverRepositoryTopology(workspacePath) as RepositoryTopology;
}

function cacheDiscovery(root: string, signature: unknown, value: DiscoveredCommands, warnings: readonly DiscoveryWarning[]): void {
  if (discoveryCache.size >= DISCOVERY_CACHE_LIMIT && !discoveryCache.has(root)) {
    const oldestKey = discoveryCache.keys().next().value as string | undefined;
    if (oldestKey !== undefined) discoveryCache.delete(oldestKey);
  }
  discoveryCache.set(root, { signature, value, warnings });
}

function discoverCommands(workspacePath: unknown, options: CommandDiscoveryOptions = {}): DiscoveredCommands {
  const root = String(workspacePath || '');
  const topology = resolveTopology(root, options.topology);
  const signature = topology.fingerprint;
  const cached = discoveryCache.get(root);
  if (cached && cached.signature === signature) return { ...cached.value };

  const discovered: DiscoveredCommands = {};
  const warnings: DiscoveryWarning[] = [];
  attemptDiscovery('package.json', () => _discoverNpmScripts(discovered, root), warnings);
  attemptDiscovery('Makefile', () => _discoverMakefile(discovered, root), warnings);
  attemptDiscovery('Flutter/Dart', () => _discoverFlutter(discovered, root), warnings);
  attemptDiscovery('Go', () => _discoverGo(discovered, root), warnings);
  attemptDiscovery('Cargo', () => _discoverCargo(discovered, root), warnings);
  attemptDiscovery('Python', () => _discoverPython(discovered, root), warnings);
  attemptDiscovery('nested package manifests', () => projectNestedPackageCommands(discovered, topology), warnings);
  cacheDiscovery(root, signature, discovered, warnings);
  return { ...discovered };
}

function commandDiscoveryWarnings(workspacePath: unknown): DiscoveryWarning[] {
  const root = String(workspacePath || '');
  discoverCommands(root);
  return (discoveryCache.get(root)?.warnings || []).map(item => ({ ...item }));
}

function attemptDiscovery(source: string, operation: () => void, warnings: DiscoveryWarning[]): void {
  try {
    operation();
  } catch (error) {
    if (warnings.length >= MAX_DISCOVERY_WARNINGS) return;
    const message = error instanceof Error ? error.message : String(error);
    warnings.push({ source, message: message.slice(0, 500) });
  }
}

function projectNestedPackageCommands(discovered: DiscoveredCommands, topology: RepositoryTopology): void {
  for (const pkg of topology.packages || []) {
    if (pkg.path === '.' || pkg.ecosystem !== 'npm') continue;
    for (const [name, command] of Object.entries(pkg.scripts || {})) {
      if (typeof command !== 'string' || !command.trim()) continue;
      discovered[`npm:${pkg.path}:${name}`] = name === 'test' ? 'npm test' : `npm run ${name}`;
    }
  }
}

export { commandDiscoveryWarnings, discoverCommands };
