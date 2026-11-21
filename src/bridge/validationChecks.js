import { discoverCommands } from '../commandDiscovery.js';
import { normalizeCommandAlias } from '../commandNormalizer.js';
import { buildCheckCatalog } from '../workflow/checkCatalog.js';
import { discoverRepositoryTopology } from '../workflow/topology.js';
import { detectVerifyCheckUnits } from './checkDetection.js';

function hasRequestedChecks(args = {}) {
  return Boolean(args.verify || args.check || args.checks || args.checksText || args.command || args.commands || args.commandsText);
}

function normalizeVerifyChecks(args, root, level) {
  const topology = discoverRepositoryTopology(root, { fresh: true });
  const discovered = discoverCommands(root, { topology });
  const catalog = buildCheckCatalog(topology);
  const aliasNormalizations = { count: 0 };
  const explicit = collectExplicitChecks(args);
  const candidates = explicit.length
    ? explicit.map((raw, index) => resolveExplicitUnit(raw, index, discovered, catalog, aliasNormalizations))
    : detectVerifyCheckUnits(root, level, topology);
  const checkUnits = [];
  const skippedChecks = [];
  const seen = new Set();
  for (const item of candidates) {
    if (!item) continue;
    const command = String(item.command || '').trim();
    const cwd = normalizeCwd(item.cwd);
    if (!command) {
      skippedChecks.push({ command: '', reason: 'empty' });
      continue;
    }
    const identity = `${command}\u0000${cwd}`;
    if (seen.has(identity)) {
      skippedChecks.push({ command, cwd, reason: 'duplicate' });
      continue;
    }
    seen.add(identity);
    checkUnits.push({ ...item, cwd, command });
  }
  return { checks: checkUnits.map(item => item.command), checkUnits, skippedChecks, aliasNormalizations: aliasNormalizations.count };
}

function resolveExplicitUnit(raw, index, discovered, catalog, aliasNormalizations) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const exact = catalog.find(unit => unit.id === trimmed);
  if (exact) {
    aliasNormalizations.count += 1;
    return exact;
  }
  const { command, normalized } = normalizeCommandAlias(trimmed, trimmed, discovered);
  if (normalized) aliasNormalizations.count += 1;
  const matching = catalog.filter(unit => unit.command === command);
  if (matching.length === 1) return matching[0];
  return { id: `explicit:${index}`, packageId: '', cwd: '.', command, kind: 'other', level: 'focused', estimatedCost: 'small', source: 'explicit', scopeKey: 'repository' };
}

function collectExplicitChecks(args) {
  const explicit = [];
  pushExplicit(explicit, args.check ?? args.command);
  pushCommands(explicit, args.checks ?? args.commands);
  pushCommandText(explicit, args.checksText ?? args.commandsText);
  return explicit;
}
function pushExplicit(target, value) { if (typeof value === 'string' && value.trim()) target.push(value.trim()); }
function pushCommands(target, values) { if (Array.isArray(values)) for (const item of values) pushExplicit(target, item); }
function pushCommandText(target, value) {
  if (typeof value !== 'string' || !value.trim()) return;
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) target.push(trimmed);
  }
}
function normalizeCwd(value) { const text = String(value || '.').trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, ''); return text || '.'; }

export { hasRequestedChecks, normalizeVerifyChecks };
