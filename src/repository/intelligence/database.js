import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { realRootOf } from '../../safety.js';
import { statePath } from '../../stateLayout.js';
import { createEcosystemResolver, supportsEcosystemResolution } from './ecosystemResolution.js';
import { relationshipKey } from './relationshipPolicy.js';

const INDEX_SCHEMA_VERSION = 3;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS index_meta(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS generations(
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  processed_files INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  language TEXT NOT NULL,
  is_test INTEGER NOT NULL CHECK(is_test IN (0,1)),
  size_bytes INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  ctime_ms REAL NOT NULL,
  content_hash TEXT NOT NULL,
  parser TEXT NOT NULL,
  parser_version INTEGER NOT NULL,
  generation_id INTEGER NOT NULL,
  parse_error INTEGER NOT NULL DEFAULT 0 CHECK(parse_error IN (0,1))
) STRICT;
CREATE TABLE IF NOT EXISTS symbols(
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  provider TEXT NOT NULL,
  confidence REAL NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS occurrences(
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  line INTEGER NOT NULL,
  column_no INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  enclosing_symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  confidence REAL NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS imports(
  source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  specifier TEXT NOT NULL,
  kind TEXT NOT NULL,
  target_path TEXT,
  target_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  confidence REAL NOT NULL,
  PRIMARY KEY(source_file_id, specifier, kind)
) WITHOUT ROWID, STRICT;
CREATE TABLE IF NOT EXISTS edges(
  id INTEGER PRIMARY KEY,
  source_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  target_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  target_file_id INTEGER REFERENCES files(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  target_name TEXT,
  provider TEXT NOT NULL,
  confidence REAL NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS relation_hints(
  id INTEGER PRIMARY KEY,
  source_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  source_qualified_name TEXT,
  source_name TEXT,
  target_qualified_name TEXT,
  target_name TEXT,
  module_specifier TEXT,
  provider TEXT NOT NULL,
  confidence REAL NOT NULL
) STRICT;
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  path UNINDEXED,
  symbols,
  terms,
  tokenize = "unicode61 tokenchars '_$'"
);
CREATE INDEX IF NOT EXISTS symbols_name_idx ON symbols(name);
CREATE INDEX IF NOT EXISTS symbols_qualified_idx ON symbols(qualified_name);
CREATE INDEX IF NOT EXISTS occurrences_name_idx ON occurrences(name);
CREATE INDEX IF NOT EXISTS occurrences_file_idx ON occurrences(file_id);
CREATE INDEX IF NOT EXISTS imports_target_idx ON imports(target_file_id);
CREATE INDEX IF NOT EXISTS edges_source_idx ON edges(source_symbol_id);
CREATE INDEX IF NOT EXISTS edges_target_idx ON edges(target_symbol_id);
CREATE INDEX IF NOT EXISTS edges_source_file_type_target_idx ON edges(source_file_id, type, target_file_id);
CREATE INDEX IF NOT EXISTS edges_target_file_type_source_idx ON edges(target_file_id, type, source_file_id);
CREATE INDEX IF NOT EXISTS relation_hints_file_idx ON relation_hints(source_file_id);
CREATE INDEX IF NOT EXISTS relation_hints_target_idx ON relation_hints(target_name);
CREATE INDEX IF NOT EXISTS files_generation_idx ON files(generation_id);
`;

function repositoryIndexRoot(config = {}) {
  return statePath(config, 'repository-intelligence');
}

function repositoryIndexPath(config, workspace) {
  const realRoot = realRootOf(workspace.path);
  const identity = crypto.createHash('sha256').update(realRoot).digest('hex').slice(0, 24);
  return path.join(repositoryIndexRoot(config), identity, 'graph.db');
}

function openIndexDatabase(file, { readonly = false } = {}) {
  if (!readonly) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(file), 0o700); } catch {}
  }
  const db = new DatabaseSync(file, { readOnly: readonly, timeout: 5000 });
  try {
    db.enableLoadExtension(false);
    db.exec('PRAGMA foreign_keys=ON');
    if (!readonly) {
      db.exec('PRAGMA journal_mode=WAL');
      db.exec('PRAGMA synchronous=NORMAL');
      db.exec('PRAGMA auto_vacuum=INCREMENTAL');
      try { fs.chmodSync(file, 0o600); } catch {}
    }
    return db;
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

function ensureIndexSchema(db) {
  const version = metaNumber(db, 'schema_version', 0);
  if (version > INDEX_SCHEMA_VERSION) {
    const error = new Error(`Repository Intelligence index schema ${version} is newer than supported schema ${INDEX_SCHEMA_VERSION}.`);
    error.code = 'INDEX_SCHEMA_FUTURE';
    throw error;
  }
  if (version > 0 && version !== INDEX_SCHEMA_VERSION) resetSchema(db);
  db.exec(SCHEMA_SQL);
  setMeta(db, 'schema_version', INDEX_SCHEMA_VERSION);
}

function resetSchema(db) {
  db.exec(`
    DROP TABLE IF EXISTS edges;
    DROP TABLE IF EXISTS relation_hints;
    DROP TABLE IF EXISTS imports;
    DROP TABLE IF EXISTS occurrences;
    DROP TABLE IF EXISTS symbols;
    DROP TABLE IF EXISTS files;
    DROP TABLE IF EXISTS generations;
    DROP TABLE IF EXISTS index_meta;
    DROP TABLE IF EXISTS search_fts;
  `);
}

function beginGeneration(db, kind) {
  const startedAt = new Date().toISOString();
  const row = db.prepare('INSERT INTO generations(kind, status, started_at) VALUES (?, ?, ?) RETURNING id').get(kind, 'building', startedAt);
  return Number(row.id);
}

function finishGeneration(db, generationId, status, processedFiles = 0, errorMessage = null) {
  db.prepare('UPDATE generations SET status=?, completed_at=?, processed_files=?, error_message=? WHERE id=?')
    .run(status, new Date().toISOString(), Number(processedFiles || 0), errorMessage == null ? null : String(errorMessage), generationId);
  if (status === 'committed') setMeta(db, 'current_generation', generationId);
}

function failBuildingGenerations(db, errorMessage) {
  return Number(db.prepare("UPDATE generations SET status='failed', completed_at=?, error_message=? WHERE status='building'")
    .run(new Date().toISOString(), String(errorMessage || 'Repository Intelligence worker terminated before generation finalization.')).changes || 0);
}

function currentGeneration(db) {
  const id = metaNumber(db, 'current_generation', 0);
  if (!id) return null;
  return db.prepare('SELECT * FROM generations WHERE id=? AND status=?').get(id, 'committed') || null;
}

function listManifest(db, relativePaths = null) {
  const paths = Array.isArray(relativePaths)
    ? [...new Set(relativePaths.map(value => String(value || '')).filter(Boolean))]
    : [];
  const query = paths.length
    ? `SELECT id, path, language, is_test, size_bytes, mtime_ms, ctime_ms, content_hash, parser, parser_version, generation_id, parse_error FROM files WHERE path IN (${sqlPlaceholders(paths.length)}) ORDER BY path`
    : 'SELECT id, path, language, is_test, size_bytes, mtime_ms, ctime_ms, content_hash, parser, parser_version, generation_id, parse_error FROM files ORDER BY path';
  return db.prepare(query).all(...(paths.length ? paths : []))
    .map(row => ({
      id: Number(row.id), path: String(row.path), language: String(row.language), test: Number(row.is_test) === 1,
      sizeBytes: Number(row.size_bytes), mtimeMs: Number(row.mtime_ms), ctimeMs: Number(row.ctime_ms), contentHash: String(row.content_hash),
      parser: String(row.parser), parserVersion: Number(row.parser_version), generationId: Number(row.generation_id), parseError: Number(row.parse_error) === 1
    }));
}

function replaceFileFacts(db, generationId, candidate, parsed, parserVersion) {
  db.prepare(`
    INSERT INTO files(path, language, is_test, size_bytes, mtime_ms, ctime_ms, content_hash, parser, parser_version, generation_id, parse_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      language=excluded.language, is_test=excluded.is_test, size_bytes=excluded.size_bytes,
      mtime_ms=excluded.mtime_ms, ctime_ms=excluded.ctime_ms, content_hash=excluded.content_hash, parser=excluded.parser,
      parser_version=excluded.parser_version, generation_id=excluded.generation_id, parse_error=excluded.parse_error
  `).run(candidate.path, parsed.language, candidate.test ? 1 : 0, candidate.size, candidate.mtimeMs, candidate.ctimeMs, candidate.contentHash,
    parsed.parser, parserVersion, generationId, parsed.parseError ? 1 : 0);
  const fileId = Number(db.prepare('SELECT id FROM files WHERE path=?').get(candidate.path).id);

  db.prepare('DELETE FROM edges WHERE source_file_id=? OR target_file_id=?').run(fileId, fileId);
  db.prepare('DELETE FROM relation_hints WHERE source_file_id=?').run(fileId);
  db.prepare('DELETE FROM occurrences WHERE file_id=?').run(fileId);
  db.prepare('DELETE FROM imports WHERE source_file_id=?').run(fileId);
  db.prepare('DELETE FROM symbols WHERE file_id=?').run(fileId);
  db.prepare('DELETE FROM search_fts WHERE rowid=?').run(fileId);

  const insertSymbol = db.prepare(`
    INSERT INTO symbols(file_id, name, qualified_name, kind, start_line, start_column, end_line, end_column, provider, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const symbolIdByQualified = new Map();
  for (const symbol of parsed.symbols || []) {
    const info = insertSymbol.run(fileId, symbol.name, symbol.qualifiedName, symbol.kind, symbol.startLine, symbol.startColumn,
      symbol.endLine, symbol.endColumn, symbol.provider || 'tree-sitter', Number(symbol.confidence || 0.8));
    symbolIdByQualified.set(symbol.qualifiedName, Number(info.lastInsertRowid));
  }

  const insertOccurrence = db.prepare(`
    INSERT INTO occurrences(file_id, name, role, line, column_no, end_line, end_column, enclosing_symbol_id, provider, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const occurrence of parsed.occurrences || []) {
    insertOccurrence.run(fileId, occurrence.name, occurrence.role, occurrence.line, occurrence.column, occurrence.endLine, occurrence.endColumn,
      occurrence.enclosingQualifiedName ? symbolIdByQualified.get(occurrence.enclosingQualifiedName) || null : null,
      occurrence.provider || 'tree-sitter', Number(occurrence.confidence || 0.82));
  }

  const insertImport = db.prepare(`
    INSERT INTO imports(source_file_id, specifier, kind, target_path, target_file_id, provider, confidence)
    VALUES (?, ?, ?, NULL, NULL, ?, ?)
  `);
  for (const item of parsed.imports || []) {
    insertImport.run(fileId, item.specifier, item.kind || 'import', item.provider || 'tree-sitter', Number(item.confidence || 0.82));
  }

  const insertHint = db.prepare(`
    INSERT INTO relation_hints(source_file_id, type, source_qualified_name, source_name, target_qualified_name, target_name, module_specifier, provider, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const relation of parsed.relations || []) {
    insertHint.run(fileId, relation.type, relation.sourceQualifiedName || null, relation.sourceName || null, relation.targetQualifiedName || null,
      relation.targetName || null, relation.moduleSpecifier || null, relation.provider || parsed.resolver?.id || 'tree-sitter', Number(relation.confidence || 0.9));
  }

  const symbolsText = (parsed.symbols || []).map(item => `${item.name} ${item.qualifiedName}`).join(' ');
  db.prepare('INSERT INTO search_fts(rowid, path, symbols, terms) VALUES (?, ?, ?, ?)')
    .run(fileId, candidate.path, symbolsText, parsed.searchText || '');
  return fileId;
}

function deleteIndexedPath(db, relativePath) {
  const row = db.prepare('SELECT id FROM files WHERE path=?').get(relativePath);
  if (!row) return false;
  db.prepare('DELETE FROM search_fts WHERE rowid=?').run(Number(row.id));
  db.prepare('DELETE FROM files WHERE id=?').run(Number(row.id));
  return true;
}

function relationshipImpactForPaths(db, relativePaths = []) {
  const paths = [...new Set(relativePaths.map(value => String(value || '')).filter(Boolean))];
  const fileIds = new Set();
  const sourceFileIds = new Set();
  const relationshipNames = new Set();
  forEachChunk(paths, 200, chunk => {
    const placeholders = sqlPlaceholders(chunk.length);
    for (const row of db.prepare(`SELECT id FROM files WHERE path IN (${placeholders})`).all(...chunk)) {
      fileIds.add(Number(row.id));
    }
  });
  const ids = [...fileIds];
  for (const id of ids) sourceFileIds.add(id);
  forEachChunk(ids, 200, chunk => {
    const placeholders = sqlPlaceholders(chunk.length);
    for (const row of db.prepare(`SELECT DISTINCT source_file_id FROM edges WHERE target_file_id IN (${placeholders})`).all(...chunk)) {
      sourceFileIds.add(Number(row.source_file_id));
    }
    for (const row of db.prepare(`SELECT DISTINCT source_file_id FROM imports WHERE target_file_id IN (${placeholders})`).all(...chunk)) {
      sourceFileIds.add(Number(row.source_file_id));
    }
    for (const row of db.prepare(`SELECT name, qualified_name FROM symbols WHERE file_id IN (${placeholders})`).all(...chunk)) {
      if (row.name) relationshipNames.add(String(row.name));
      if (row.qualified_name) relationshipNames.add(String(row.qualified_name));
    }
    for (const row of db.prepare(`SELECT target_name, target_qualified_name FROM relation_hints WHERE source_file_id IN (${placeholders})`).all(...chunk)) {
      if (row.target_name) relationshipNames.add(String(row.target_name));
      if (row.target_qualified_name) relationshipNames.add(String(row.target_qualified_name));
    }
  });
  return { sourceFileIds: [...sourceFileIds], relationshipNames: [...relationshipNames] };
}

function relationshipSourceIdsForNames(db, names = []) {
  const normalized = [...new Set(names.map(value => String(value || '')).filter(Boolean))];
  const sourceFileIds = new Set();
  forEachChunk(normalized, 200, chunk => {
    const placeholders = sqlPlaceholders(chunk.length);
    for (const row of db.prepare(`SELECT DISTINCT file_id FROM occurrences WHERE name IN (${placeholders})`).all(...chunk)) {
      sourceFileIds.add(Number(row.file_id));
    }
    for (const row of db.prepare(`SELECT DISTINCT source_file_id FROM relation_hints WHERE target_name IN (${placeholders})`).all(...chunk)) {
      sourceFileIds.add(Number(row.source_file_id));
    }
    for (const row of db.prepare(`SELECT DISTINCT source_file_id FROM relation_hints WHERE target_qualified_name IN (${placeholders})`).all(...chunk)) {
      sourceFileIds.add(Number(row.source_file_id));
    }
  });
  return [...sourceFileIds];
}

function refreshRelationshipResolutionCache(db, workspaceRoot, resolutionCache, { addedPaths = [], deletedPaths = [] } = {}) {
  if (!resolutionCache) return;
  if (!resolutionCache.context) {
    resolutionCache.context = loadResolutionContext(db, workspaceRoot);
    return;
  }
  const context = resolutionCache.context;
  if (!context.suffixMembers || !context.directoryMembers) {
    const suffixState = buildImportSuffixState(context.pathToId.keys());
    const directoryState = buildUniqueDirectoryState(context.pathToId.keys());
    context.suffixIndex = suffixState.index;
    context.suffixMembers = suffixState.members;
    context.directoryIndex = directoryState.index;
    context.directoryMembers = directoryState.members;
  }

  const deleted = new Set(deletedPaths.map(value => String(value || '')).filter(Boolean));
  let ecosystemDirty = false;
  for (const relativePath of deleted) {
    const id = context.pathToId.get(relativePath);
    const previous = id == null ? null : context.fileById.get(Number(id));
    if (previous && supportsEcosystemResolution(previous.language)) ecosystemDirty = true;
    updateImportSuffixMembership(context, relativePath, false);
    updateDirectoryMembership(context, relativePath, false);
    context.pathToId.delete(relativePath);
    if (id != null) context.fileById.delete(Number(id));
  }

  const additions = [...new Set(addedPaths.map(value => String(value || '')).filter(Boolean))];
  const addedFiles = [];
  forEachChunk(additions, 200, chunk => {
    const placeholders = sqlPlaceholders(chunk.length);
    for (const row of db.prepare(`SELECT id, path, language, is_test FROM files WHERE path IN (${placeholders})`).all(...chunk)) {
      const file = { id: Number(row.id), path: String(row.path), language: String(row.language), test: Number(row.is_test) === 1 };
      const previousId = context.pathToId.get(file.path);
      if (previousId != null && Number(previousId) !== file.id) context.fileById.delete(Number(previousId));
      context.pathToId.set(file.path, file.id);
      context.fileById.set(file.id, file);
      updateImportSuffixMembership(context, file.path, true);
      updateDirectoryMembership(context, file.path, true);
      if (supportsEcosystemResolution(file.language)) ecosystemDirty = true;
      addedFiles.push(file);
    }
  });

  if (deleted.size || addedFiles.length) {
    const addedSet = new Set(addedFiles.map(file => file.path));
    context.files = context.files.filter(file => !deleted.has(file.path) && !addedSet.has(file.path));
    context.files.push(...addedFiles);
  }
  if (ecosystemDirty) {
    context.ecosystem = workspaceRoot && [...context.fileById.values()].some(file => supportsEcosystemResolution(file.language))
      ? createEcosystemResolver(workspaceRoot, context.pathToId.keys())
      : null;
  }
}

function relationshipSourceIdsForImportResolutionChanges(db, workspaceRoot, resolutionCache) {
  const cachedContext = resolutionCache?.context;
  const context = cachedContext || loadResolutionContext(db, workspaceRoot);
  if (resolutionCache && !cachedContext) resolutionCache.context = context;
  const rows = db.prepare(`
    SELECT i.source_file_id, i.specifier, i.target_file_id, f.path, f.language, f.is_test
    FROM imports i
    JOIN files f ON f.id=i.source_file_id
  `).all();
  const sourceFileIds = new Set();
  for (const row of rows) {
    const source = { id: Number(row.source_file_id), path: String(row.path), language: String(row.language), test: Number(row.is_test) === 1 };
    const targetPath = resolveImportPath(source.path, String(row.specifier), context.pathToId, context.suffixIndex,
      context.directoryIndex, context.ecosystem, source.language);
    const nextTargetId = targetPath ? Number(context.pathToId.get(targetPath) || 0) : 0;
    const currentTargetId = Number(row.target_file_id || 0);
    if (nextTargetId !== currentTargetId) sourceFileIds.add(source.id);
  }
  return [...sourceFileIds];
}

function loadResolutionContext(db, workspaceRoot = null) {
  const files = db.prepare('SELECT id, path, language, is_test FROM files ORDER BY path').all().map(row => ({
    id: Number(row.id), path: String(row.path), language: String(row.language), test: Number(row.is_test) === 1
  }));
  const pathToId = new Map(files.map(file => [file.path, file.id]));
  const fileById = new Map(files.map(file => [file.id, file]));
  const suffixState = buildImportSuffixState(pathToId.keys());
  const directoryState = buildUniqueDirectoryState(pathToId.keys());
  const ecosystem = workspaceRoot && files.some(file => supportsEcosystemResolution(file.language))
    ? createEcosystemResolver(workspaceRoot, pathToId.keys())
    : null;
  return {
    files, pathToId, fileById,
    suffixIndex: suffixState.index,
    suffixMembers: suffixState.members,
    directoryIndex: directoryState.index,
    directoryMembers: directoryState.members,
    ecosystem
  };
}

function resolveRelationships(db, { workspaceRoot = null, sourceFileIds = null, resolutionCache = null } = {}) {
  const scopedSourceIds = Array.isArray(sourceFileIds)
    ? [...new Set(sourceFileIds.map(Number).filter(value => Number.isSafeInteger(value) && value > 0))]
    : null;
  if (scopedSourceIds && scopedSourceIds.length === 0) return;
  if (scopedSourceIds) return resolveScopedRelationships(db, { workspaceRoot, sourceFileIds: scopedSourceIds, resolutionCache });
  const sourceFilter = scopedSourceIds ? `source_file_id IN (${sqlPlaceholders(scopedSourceIds.length)})` : '';
  if (scopedSourceIds) {
    db.prepare(`UPDATE imports SET target_path=NULL, target_file_id=NULL WHERE ${sourceFilter}`).run(...scopedSourceIds);
    db.prepare(`DELETE FROM edges WHERE ${sourceFilter}`).run(...scopedSourceIds);
  } else {
    db.prepare('UPDATE imports SET target_path=NULL, target_file_id=NULL').run();
    db.prepare("DELETE FROM edges WHERE type IN ('IMPORTS','CALLS','INHERITS','IMPLEMENTS','USES_TYPE','TESTS','HANDLES','HTTP_CALLS','LISTENS_ON','EMITS')").run();
  }
  const cachedContext = resolutionCache?.context;
  const context = cachedContext || loadResolutionContext(db, workspaceRoot);
  const { files, pathToId, fileById, suffixIndex, directoryIndex, ecosystem } = context;
  if (resolutionCache && !cachedContext) resolutionCache.context = context;
  const imports = scopedSourceIds
    ? db.prepare(`SELECT source_file_id, specifier FROM imports WHERE ${sourceFilter}`).all(...scopedSourceIds)
    : db.prepare('SELECT source_file_id, specifier FROM imports').all();
  const updateImport = db.prepare('UPDATE imports SET target_path=?, target_file_id=? WHERE source_file_id=? AND specifier=?');
  const insertEdge = db.prepare(`
    INSERT INTO edges(source_symbol_id, target_symbol_id, source_file_id, target_file_id, type, target_name, provider, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const importedIdsBySource = new Map();
  const testEdges = new Set();
  for (const item of imports) {
    const sourceId = Number(item.source_file_id);
    const source = fileById.get(sourceId);
    if (!source) continue;
    const targetPath = resolveImportPath(source.path, String(item.specifier), pathToId, suffixIndex, directoryIndex, ecosystem, source.language);
    if (!targetPath) continue;
    const targetId = pathToId.get(targetPath);
    updateImport.run(targetPath, targetId, source.id, String(item.specifier));
    insertEdge.run(null, null, source.id, targetId, 'IMPORTS', null, 'tree-sitter', 0.82);
    const targetFile = fileById.get(targetId);
    const testEdgeKey = `${source.id}:${targetId}`;
    if (source.test && targetFile && !targetFile.test && !testEdges.has(testEdgeKey)) {
      insertEdge.run(null, null, source.id, targetId, 'TESTS', targetPath, 'graph-derived', 0.99);
      testEdges.add(testEdgeKey);
    }
    if (!importedIdsBySource.has(sourceId)) importedIdsBySource.set(sourceId, new Set());
    importedIdsBySource.get(sourceId).add(targetId);
  }

  const symbolsByName = new Map();
  for (const row of db.prepare('SELECT id, file_id, name FROM symbols ORDER BY name, file_id, id').all()) {
    const name = String(row.name);
    if (!symbolsByName.has(name)) symbolsByName.set(name, []);
    symbolsByName.get(name).push(row);
  }
  const callRows = scopedSourceIds
    ? db.prepare(`SELECT o.file_id, o.name, o.enclosing_symbol_id FROM occurrences o WHERE o.role='call' AND o.file_id IN (${sqlPlaceholders(scopedSourceIds.length)})`).all(...scopedSourceIds)
    : db.prepare(`SELECT o.file_id, o.name, o.enclosing_symbol_id FROM occurrences o WHERE o.role='call'`).all();
  for (const call of callRows) {
    const sourceFileId = Number(call.file_id);
    const targets = symbolsByName.get(String(call.name)) || [];
    const target = chooseCallTarget(sourceFileId, targets, importedIdsBySource.get(sourceFileId));
    if (!target) continue;
    const confidence = Number(target.file_id) === sourceFileId ? 0.88 : 0.84;
    insertEdge.run(call.enclosing_symbol_id == null ? null : Number(call.enclosing_symbol_id), Number(target.id), sourceFileId, Number(target.file_id),
      'CALLS', String(call.name), 'tree-sitter', confidence);
  }

  resolveHintRelationships(db, { files, fileById, pathToId, suffixIndex, directoryIndex, symbolsByName, insertEdge, ecosystem, sourceFileIds: scopedSourceIds });
}

// Incremental refreshes usually touch a handful of files. Keep all reads in this
// path keyed by those files (and by the names they reference) so a large index
// does not have to be materialized just to rebuild a few edges. A context from a
// preceding full generation supplies the expensive path indexes when available.
function resolveScopedRelationships(db, { workspaceRoot = null, sourceFileIds, resolutionCache = null }) {
  const ids = [...new Set(sourceFileIds.map(Number).filter(value => Number.isSafeInteger(value) && value > 0))];
  if (!ids.length) return;
  if (resolutionCache && !resolutionCache.context) resolutionCache.context = loadResolutionContext(db, workspaceRoot);
  const cachedContext = resolutionCache?.context;
  const sourceFilter = `source_file_id IN (${sqlPlaceholders(ids.length)})`;
  const fileFilter = `id IN (${sqlPlaceholders(ids.length)})`;
  const sourceFiles = db.prepare(`SELECT id, path, language, is_test FROM files WHERE ${fileFilter} ORDER BY path`).all(...ids)
    .map(row => ({ id: Number(row.id), path: String(row.path), language: String(row.language), test: Number(row.is_test) === 1 }));
  // Keep the scoped resolver's local map bounded. The cached full-generation
  // map is used only by the path resolver for O(1) target lookups.
  const fileById = new Map(sourceFiles.map(file => [file.id, file]));
  const imports = db.prepare(`SELECT source_file_id, specifier FROM imports WHERE ${sourceFilter}`).all(...ids);
  const pathResolver = createScopedImportResolver(db, workspaceRoot, resolutionCache);

  db.prepare(`UPDATE imports SET target_path=NULL, target_file_id=NULL WHERE ${sourceFilter}`).run(...ids);
  db.prepare(`DELETE FROM edges WHERE ${sourceFilter}`).run(...ids);
  const updateImport = db.prepare('UPDATE imports SET target_path=?, target_file_id=? WHERE source_file_id=? AND specifier=?');
  const insertEdge = db.prepare(`
    INSERT INTO edges(source_symbol_id, target_symbol_id, source_file_id, target_file_id, type, target_name, provider, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const importedIdsBySource = new Map();
  const testEdges = new Set();
  for (const item of imports) {
    const sourceId = Number(item.source_file_id);
    const source = fileById.get(sourceId);
    if (!source) continue;
    const target = pathResolver(source, String(item.specifier));
    if (!target) continue;
    updateImport.run(target.path, target.id, source.id, String(item.specifier));
    insertEdge.run(null, null, source.id, target.id, 'IMPORTS', null, 'tree-sitter', 0.82);
    const targetFile = target.file;
    const testEdgeKey = `${source.id}:${target.id}`;
    if (source.test && targetFile && !targetFile.test && !testEdges.has(testEdgeKey)) {
      insertEdge.run(null, null, source.id, target.id, 'TESTS', target.path, 'graph-derived', 0.99);
      testEdges.add(testEdgeKey);
    }
    if (!importedIdsBySource.has(sourceId)) importedIdsBySource.set(sourceId, new Set());
    importedIdsBySource.get(sourceId).add(target.id);
  }

  const callRows = db.prepare(`SELECT o.file_id, o.name, o.enclosing_symbol_id FROM occurrences o WHERE o.role='call' AND o.file_id IN (${sqlPlaceholders(ids.length)})`)
    .all(...ids);
  const callNames = [...new Set(callRows.map(row => String(row.name || '')).filter(Boolean))];
  const symbolsByName = loadSymbolsByNames(db, callNames);
  for (const call of callRows) {
    const sourceFileId = Number(call.file_id);
    const targets = symbolsByName.get(String(call.name)) || [];
    const target = chooseCallTarget(sourceFileId, targets, importedIdsBySource.get(sourceFileId));
    if (!target) continue;
    const confidence = Number(target.file_id) === sourceFileId ? 0.88 : 0.84;
    insertEdge.run(call.enclosing_symbol_id == null ? null : Number(call.enclosing_symbol_id), Number(target.id), sourceFileId,
      Number(target.file_id), 'CALLS', String(call.name), 'tree-sitter', confidence);
  }

  const hints = db.prepare(`SELECT * FROM relation_hints WHERE ${sourceFilter} ORDER BY id`).all(...ids);
  const hintNames = new Set();
  const hintQualifiedNames = new Set();
  for (const hint of hints) {
    if (hint.source_qualified_name) hintQualifiedNames.add(String(hint.source_qualified_name));
    if (hint.target_qualified_name) hintQualifiedNames.add(String(hint.target_qualified_name));
    if (hint.target_name) hintNames.add(String(hint.target_name));
  }
  const routeEventNames = [...hintNames].filter(name => hints.some(hint =>
    (hint.type === 'HTTP_CALLS' || hint.type === 'EMITS') && String(hint.target_name || '') === name));
  const routeEventHints = routeEventNames.length
    ? db.prepare(`SELECT * FROM relation_hints WHERE type IN ('HANDLES','LISTENS_ON') AND target_name IN (${sqlPlaceholders(routeEventNames.length)}) ORDER BY id`).all(...routeEventNames)
    : [];
  for (const hint of routeEventHints) {
    if (hint.source_qualified_name) hintQualifiedNames.add(String(hint.source_qualified_name));
  }
  const hintSymbolsByName = loadSymbolsByNames(db, [...hintNames]);
  for (const [name, rows] of hintSymbolsByName) symbolsByName.set(name, rows);
  const symbolsByQualified = loadSymbolsByQualifiedNames(db, [...hintQualifiedNames]);
  const targetFileIds = new Set([...routeEventHints].map(hint => Number(hint.source_file_id)).filter(Number.isInteger));
  const targetFiles = targetFileIds.size
    ? db.prepare(`SELECT id, path, language, is_test FROM files WHERE id IN (${sqlPlaceholders(targetFileIds.size)})`).all(...targetFileIds)
      .map(row => ({ id: Number(row.id), path: String(row.path), language: String(row.language), test: Number(row.is_test) === 1 }))
    : [];
  for (const file of targetFiles) fileById.set(file.id, file);

  resolveHintRelationships(db, {
    files: cachedContext?.files || [...fileById.values()], fileById,
    pathToId: cachedContext?.pathToId || new Map(), suffixIndex: cachedContext?.suffixIndex || new Map(),
    directoryIndex: cachedContext?.directoryIndex || new Map(), symbolsByName, symbolsByQualified, insertEdge,
    ecosystem: cachedContext?.ecosystem || null,
    sourceFileIds: ids, hints, routeTargets: uniqueHintTargets(routeEventHints, 'HANDLES'),
    eventTargets: uniqueHintTargets(routeEventHints, 'LISTENS_ON'), resolveImportPath: pathResolver
  });
}

function createScopedImportResolver(db, workspaceRoot, resolutionCache) {
  const cachedContext = resolutionCache?.context;
  const fallbackStatement = db.prepare('SELECT id, path, language, is_test FROM files WHERE path=?');
  const fallbackLookup = relativePath => fallbackStatement.get(relativePath);
  const byPath = new Map();
  const lookup = relativePath => {
    const normalized = String(relativePath || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');
    if (!normalized) return null;
    if (cachedContext?.pathToId?.has(normalized)) {
      const id = Number(cachedContext.pathToId.get(normalized));
      const file = cachedContext.fileById.get(id);
      return file ? { id, path: normalized, file } : null;
    }
    if (byPath.has(normalized)) return byPath.get(normalized);
    const row = fallbackLookup(normalized);
    const value = row ? { id: Number(row.id), path: String(row.path), file: { id: Number(row.id), path: String(row.path), language: String(row.language), test: Number(row.is_test) === 1 } } : null;
    byPath.set(normalized, value);
    return value;
  };
  return (source, specifier) => {
    if (cachedContext?.pathToId && cachedContext?.suffixIndex) {
      const targetPath = resolveImportPath(source.path, specifier, cachedContext.pathToId, cachedContext.suffixIndex,
        cachedContext.directoryIndex, cachedContext.ecosystem, source.language);
      if (!targetPath) return null;
      const id = Number(cachedContext.pathToId.get(targetPath));
      const file = cachedContext.fileById.get(id);
      return file ? { id, path: targetPath, file } : null;
    }
    const clean = String(specifier || '').replaceAll('\\', '/').replace(/[{}*]/g, '').trim();
    if (!clean) return null;
    const language = String(source.language || '').toLowerCase();
    if (['javascript', 'typescript', 'tsx'].includes(language) && !clean.startsWith('.')) return null;
    const bases = clean.startsWith('.')
      ? [path.posix.normalize(path.posix.join(path.posix.dirname(source.path), clean))]
      : [clean.replace(/^@/, '').replaceAll('.', '/').replace(/^crate\//, '').replace(/^self\//, '').replace(/^\/+/, '')];
    for (const base of bases) {
      for (const candidate of candidatePathVariants(base)) {
        const target = lookup(candidate);
        if (target) return target;
      }
    }
    return null;
  };
}

function candidatePathVariants(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');
  if (!normalized) return [];
  const extensions = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.kt', '.cs', '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh', '.rb', '.php', '.vue', '.json'];
  const base = stripKnownExtension(normalized);
  return [...new Set([normalized, base, ...extensions.map(ext => base + ext), ...extensions.map(ext => path.posix.join(base, `index${ext}`)), path.posix.join(base, '__init__.py')])];
}

function loadSymbolsByNames(db, names) {
  const result = new Map();
  forEachChunk([...new Set(names.map(value => String(value || '')).filter(Boolean))], 200, chunk => {
    const placeholders = sqlPlaceholders(chunk.length);
    for (const row of db.prepare(`SELECT id, file_id, name FROM symbols WHERE name IN (${placeholders}) ORDER BY name, file_id, id`).all(...chunk)) {
      const name = String(row.name);
      if (!result.has(name)) result.set(name, []);
      result.get(name).push(row);
    }
  });
  return result;
}

function loadSymbolsByQualifiedNames(db, names) {
  const result = new Map();
  const normalized = names == null ? null : [...new Set(names.map(value => String(value || '')).filter(Boolean))];
  const chunks = normalized == null ? [null] : chunkValues(normalized, 200);
  for (const chunk of chunks) {
    const rows = chunk == null
      ? db.prepare('SELECT id, file_id, name, qualified_name FROM symbols').all()
      : db.prepare(`SELECT id, file_id, name, qualified_name FROM symbols WHERE qualified_name IN (${sqlPlaceholders(chunk.length)})`).all(...chunk);
    for (const row of rows) {
      const name = String(row.qualified_name);
      if (!result.has(name)) result.set(name, []);
      result.get(name).push(row);
    }
  }
  return result;
}

function chunkValues(values, size) {
  const chunks = [];
  for (let offset = 0; offset < values.length; offset += size) chunks.push(values.slice(offset, offset + size));
  return chunks;
}

function resolveHintRelationships(db, context) {
  const { fileById, pathToId, suffixIndex, directoryIndex, symbolsByName, insertEdge, ecosystem } = context;
  const sourceFileIds = Array.isArray(context.sourceFileIds) ? new Set(context.sourceFileIds.map(Number)) : null;
  const symbolsByQualified = context.symbolsByQualified || loadSymbolsByQualifiedNames(db, null);
  const hints = context.hints || db.prepare('SELECT * FROM relation_hints ORDER BY id').all();
  const routeTargets = context.routeTargets || uniqueHintTargets(hints, 'HANDLES');
  const eventTargets = context.eventTargets || uniqueHintTargets(hints, 'LISTENS_ON');

  for (const hint of hints) {
    const sourceFileId = Number(hint.source_file_id);
    if (sourceFileIds && !sourceFileIds.has(sourceFileId)) continue;
    const sourceFile = fileById.get(sourceFileId);
    if (!sourceFile) continue;
    const sourceSymbol = hint.source_qualified_name == null
      ? null
      : chooseQualifiedSymbol(symbolsByQualified.get(String(hint.source_qualified_name)) || [], sourceFileId);
    const targetQualified = hint.target_qualified_name == null ? '' : String(hint.target_qualified_name);
    const targetName = hint.target_name == null ? '' : String(hint.target_name);
    const moduleSpecifier = hint.module_specifier == null ? '' : String(hint.module_specifier);
    const moduleResolution = moduleSpecifier
      ? (context.resolveImportPath
        ? context.resolveImportPath(sourceFile, moduleSpecifier)
        : resolveImportPath(sourceFile.path, moduleSpecifier, pathToId, suffixIndex, directoryIndex, ecosystem, sourceFile.language))
      : null;
    const moduleTargetPath = typeof moduleResolution === 'string' ? moduleResolution : moduleResolution?.path || null;
    let targetFileId = moduleResolution && typeof moduleResolution === 'object'
      ? Number(moduleResolution.id)
      : moduleTargetPath ? pathToId.get(moduleTargetPath) : null;
    let targetSymbol = null;

    const relationshipTargetKey = relationshipKey(String(hint.type), targetName);
    const linkedHint = hint.type === 'HTTP_CALLS'
      ? routeTargets.get(relationshipTargetKey)
      : hint.type === 'EMITS'
        ? eventTargets.get(relationshipTargetKey)
        : null;
    if (linkedHint) {
      targetFileId = Number(linkedHint.source_file_id);
      const linkedQualified = linkedHint.source_qualified_name == null ? '' : String(linkedHint.source_qualified_name);
      if (linkedQualified) targetSymbol = chooseQualifiedSymbol(symbolsByQualified.get(linkedQualified) || [], targetFileId);
    }

    if (!targetSymbol && targetQualified) {
      targetSymbol = chooseQualifiedSymbol(symbolsByQualified.get(targetQualified) || [], targetFileId);
    }
    if (!targetSymbol && targetName && !['HTTP_CALLS', 'EMITS', 'HANDLES', 'LISTENS_ON'].includes(String(hint.type))) {
      const candidates = symbolsByName.get(targetName) || [];
      const scoped = targetFileId ? candidates.filter(item => Number(item.file_id) === Number(targetFileId)) : candidates;
      if (scoped.length === 1) targetSymbol = scoped[0];
    }
    insertEdge.run(sourceSymbol ? Number(sourceSymbol.id) : null, targetSymbol ? Number(targetSymbol.id) : null, sourceFileId,
      targetSymbol ? Number(targetSymbol.file_id) : (targetFileId || null), String(hint.type), targetName || null, String(hint.provider), Number(hint.confidence));
  }
}

function sqlPlaceholders(count) {
  return Array.from({ length: count }, () => '?').join(',');
}

function forEachChunk(values, size, callback) {
  for (let offset = 0; offset < values.length; offset += size) callback(values.slice(offset, offset + size));
}

function uniqueHintTargets(hints, type) {
  const result = new Map();
  for (const hint of hints) {
    if (String(hint.type) !== type || hint.target_name == null) continue;
    const key = relationshipKey(type, String(hint.target_name));
    if (!key) continue;
    if (!result.has(key)) result.set(key, hint);
    else result.set(key, null);
  }
  return result;
}

function chooseQualifiedSymbol(candidates, preferredFileId = null) {
  if (!candidates.length) return null;
  if (preferredFileId != null) {
    const scoped = candidates.filter(item => Number(item.file_id) === Number(preferredFileId));
    if (scoped.length === 1) return scoped[0];
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function chooseCallTarget(sourceFileId, targets, importedIds = new Set()) {
  if (!targets.length) return null;
  const sameFile = targets.filter(target => Number(target.file_id) === sourceFileId);
  if (sameFile.length === 1) return sameFile[0];
  const imported = targets.filter(target => importedIds.has(Number(target.file_id)));
  return imported.length === 1 ? imported[0] : null;
}

function resolveImportPath(sourcePath, specifier, pathToId, suffixIndex, directoryIndex = new Map(), ecosystem = null, language = null) {
  const clean = String(specifier || '').replaceAll('\\', '/').replace(/[{}*]/g, '').trim();
  if (!clean) return null;
  const languageKey = String(language || '').toLowerCase();
  if (['javascript', 'typescript', 'tsx'].includes(languageKey) && !clean.startsWith('.')) return null;
  if (clean.startsWith('.')) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), clean));
    return resolveCandidateBase(base, pathToId, suffixIndex, directoryIndex);
  }
  const ecosystemCandidates = ecosystem?.candidates?.(language, sourcePath, clean) || [];
  for (const base of ecosystemCandidates) {
    const resolved = resolveCandidateBase(base, pathToId, suffixIndex, directoryIndex);
    if (resolved) return resolved;
  }
  const normalized = clean.replace(/^@/, '').replaceAll('.', '/').replace(/^crate\//, '').replace(/^self\//, '').replace(/^\/+/, '');
  const resolved = resolveCandidateBase(normalized, pathToId, suffixIndex, directoryIndex);
  if (resolved) return resolved;
  const leaf = stripKnownExtension(normalized).split('/').filter(Boolean).at(-1);
  if (leaf) {
    const leafMatch = suffixIndex.get(leaf);
    if (typeof leafMatch === 'string') return leafMatch;
  }
  return null;
}

function resolveCandidateBase(value, pathToId, suffixIndex, directoryIndex = new Map()) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');
  if (!normalized) return null;
  const extensions = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.go', '.rs', '.java', '.kt', '.cs', '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh', '.rb', '.php', '.vue', '.json'];
  const base = stripKnownExtension(normalized);
  const candidates = [normalized, base, ...extensions.map(ext => base + ext), ...extensions.map(ext => path.posix.join(base, `index${ext}`)), path.posix.join(base, '__init__.py')];
  for (const candidate of candidates) {
    if (pathToId.has(candidate)) return candidate;
    const match = suffixIndex.get(candidate);
    if (typeof match === 'string') return match;
  }
  const directoryMatch = directoryIndex.get(base);
  if (typeof directoryMatch === 'string') return directoryMatch;
  return null;
}

function buildUniqueDirectoryState(paths) {
  const index = new Map();
  const members = new Map();
  for (const filePath of paths) {
    const dir = path.posix.dirname(String(filePath));
    if (!dir || dir === '.') continue;
    updateUniqueIndexMember(index, members, dir, String(filePath), true);
  }
  return { index, members };
}

function buildImportSuffixState(paths) {
  const index = new Map();
  const members = new Map();
  for (const filePath of paths) {
    for (const key of importSuffixKeys(filePath)) updateUniqueIndexMember(index, members, key, String(filePath), true);
  }
  return { index, members };
}

function importSuffixKeys(filePath) {
  const value = String(filePath);
  const withoutExtension = stripKnownExtension(value);
  const parts = withoutExtension.split('/').filter(Boolean);
  const variants = new Set([value, withoutExtension]);
  if (parts.at(-1) === 'index' && parts.length > 1) variants.add(parts.slice(0, -1).join('/'));
  for (let offset = 0; offset < parts.length; offset += 1) variants.add(parts.slice(offset).join('/'));
  return [...variants].filter(Boolean);
}

function updateImportSuffixMembership(context, filePath, present) {
  for (const key of importSuffixKeys(filePath)) {
    updateUniqueIndexMember(context.suffixIndex, context.suffixMembers, key, String(filePath), present);
  }
}

function updateDirectoryMembership(context, filePath, present) {
  const dir = path.posix.dirname(String(filePath));
  if (!dir || dir === '.') return;
  updateUniqueIndexMember(context.directoryIndex, context.directoryMembers, dir, String(filePath), present);
}

function updateUniqueIndexMember(index, members, key, filePath, present) {
  if (!key) return;
  let values = members.get(key);
  if (!values && present) {
    values = new Set();
    members.set(key, values);
  }
  if (!values) return;
  if (present) values.add(filePath);
  else values.delete(filePath);
  if (values.size === 0) {
    members.delete(key);
    index.delete(key);
  } else if (values.size === 1) {
    index.set(key, values.values().next().value);
  } else {
    index.set(key, null);
  }
}

function stripKnownExtension(value) {
  return String(value || '').replace(/\.(?:jsx?|mjs|cjs|tsx?|py|go|rs|java|kt|cs|c|cpp|cc|cxx|h|hpp|hh|rb|php|vue|json)$/i, '');
}
function indexStats(db) {
  const counts = db.prepare(`
    SELECT count(*) AS files, coalesce(sum(size_bytes),0) AS bytes, coalesce(max(mtime_ms),0) AS newest,
           coalesce(sum(CASE WHEN parser='tree-sitter' THEN 1 ELSE 0 END),0) AS structural,
           coalesce(sum(parse_error),0) AS parse_errors
    FROM files
  `).get();
  const symbolCount = Number(db.prepare('SELECT count(*) AS count FROM symbols').get().count || 0);
  const occurrenceCount = Number(db.prepare('SELECT count(*) AS count FROM occurrences').get().count || 0);
  return {
    fileCount: Number(counts.files || 0), indexedBytes: Number(counts.bytes || 0), newestMtimeMs: Number(counts.newest || 0),
    structuralFileCount: Number(counts.structural || 0), structuralDegradedFileCount: Number(counts.parse_errors || 0), symbolCount, occurrenceCount
  };
}

function checkIndexIntegrity(db) {
  try {
    const row = db.prepare('PRAGMA integrity_check').get();
    const message = String(row?.integrity_check || 'unknown');
    return { ok: message.toLowerCase() === 'ok', message };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function setMeta(db, key, value) {
  db.prepare('INSERT INTO index_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(String(key), String(value));
}

function metaNumber(db, key, fallback = 0) {
  const value = Number(metaValue(db, key, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function metaValue(db, key, fallback = '') {
  try {
    const row = db.prepare('SELECT value FROM index_meta WHERE key=?').get(String(key));
    return row?.value == null ? fallback : String(row.value);
  } catch { return fallback; }
}

function indexProducerVersion(db) { return metaValue(db, 'producer_version', ''); }
function setIndexProducerVersion(db, value) { setMeta(db, 'producer_version', String(value || '')); }
function indexParserVersion(db) { return metaValue(db, 'parser_version', ''); }
function setIndexParserVersion(db, value) { setMeta(db, 'parser_version', String(value || '')); }

export {
  beginGeneration,
  checkIndexIntegrity,
  currentGeneration,
  deleteIndexedPath,
  ensureIndexSchema,
  failBuildingGenerations,
  finishGeneration,
  indexProducerVersion,
  indexParserVersion,
  indexStats,
  listManifest,
  openIndexDatabase,
  replaceFileFacts,
  relationshipImpactForPaths,
  relationshipSourceIdsForImportResolutionChanges,
  relationshipSourceIdsForNames,
  refreshRelationshipResolutionCache,
  repositoryIndexPath,
  resolveRelationships,
  setIndexProducerVersion,
  setIndexParserVersion
};
