import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { resolveWorkspace } from './config.js';
import { runProcess } from './process.js';
import { gitStatusArgs, parseGitStatus } from './repo/gitStatus.js';
import { readJsonFile } from './durableState.ts';
import { getStateDir } from './statePaths.js';
import { setStateMeta, stateDatabasePath, stateMetaValue, withStateDatabase } from './stateDatabase.ts';
import { OPERATION_IDS as OP } from './tools/operationIds.js';

const STORE_VERSION = 1;
// Integrity writes share durable-state.sqlite with short analytics transactions.
// Allow brief writer handoff without restoring the multi-second synchronous stall.
const INTEGRITY_SQLITE_TIMEOUT_MS = 250;
const LEGACY_INTEGRITY_MIGRATION_KEY = 'task_integrity_legacy_migrated_v1';
const AMBIENT_OWNER = '@ambient';
const migratedIntegrityDatabases = new Set<string>();
const pendingBaselineCaptures = new Map<string, Promise<IntegrityAuthority | null>>();
const CODE_MUTATING_TOOLS = new Set<string>([
  OP.EDIT,
  OP.CHANGES_TIDY_RUN,
  OP.CHANGES_RESTORE,
  OP.CHANGES_RESET
]);
const REPOSITORY_RECONCILE_TOOLS = new Set<string>([
  OP.VALIDATE_CHECKS,
  OP.PUBLISH_COMMIT,
  OP.WORK_FINISH,
  OP.WORK_CANCEL
]);

type IntegrityConfig = Record<string, any>;
type IntegrityEvent = Record<string, any>;

interface RepositoryBaseline {
  pending?: boolean;
  branch: string;
  head: string;
  unborn: boolean;
  changedFiles: string[];
}

interface IntegrityAuthority extends Record<string, any> {
  version: number;
  taskId: string;
  workspace: string;
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  baseline: RepositoryBaseline;
  taskOwnedChangedFiles: string[];
  ambientChangedFiles: string[];
  externalChangedFiles: string[];
  mutationGeneration: number;
  latestValidatedMutationGeneration: number;
  validatedWorkspaceGeneration: number;
  validationResult: string;
  hasPassedValidation: boolean;
  latestPassedValidationAt: string;
  validationAt: string;
  validationLevel: string;
  validationFingerprint: string;
  validationScope: string[];
  validatedRepositoryFingerprint: string;
  conflictingExternalMutations: string[];
  finalCompletionGeneration: number | null;
  completedAt: string;
  cancelledAt: string;
  lastMutationAt: string;
  lastMutationTool: string;
}

interface WorkspaceIntegrityState extends Record<string, any> {
  version: number;
  workspace: string;
  generation: number;
  updatedAt: string;
  lastMutation: Record<string, any> | null;
  uncommittedOwners: Record<string, string[]>;
}

interface IntegrityProjection {
  taskMutationGeneration: number;
  taskValidatedMutationGeneration: number;
  taskWorkspaceGeneration: number;
  taskOwnedChangedFiles: string[];
  taskUncommittedChangedFiles: string[];
  taskConflictingChangedFiles: string[];
  externalChangedFiles: string[];
}

interface OwnershipProjection {
  ownedFiles: string[];
  conflictingFiles: string[];
}

interface RepositoryEventState {
  baseline: RepositoryBaseline | null;
  changedFiles: string[] | null;
}

class TaskIntegrityError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'TaskIntegrityError';
    this.code = code;
    this.retryable = code === 'TASK_INTEGRITY_PERSISTENCE_FAILED';
  }
}

async function recordTaskIntegrityEvent(config: IntegrityConfig, event: IntegrityEvent = {}): Promise<IntegrityProjection | null> {
  const taskId = clean(event.taskId);
  const workspaceAlias = clean(event.workspace);
  if (!workspaceAlias) return null;
  if (taskId && Number(event.taskIdentityVersion || 0) < 2) return null;

  try {
    if (!integrityEventRequiresPersistence(event)) {
      return taskId ? readIntegrityProjection(config, taskId, workspaceAlias) : null;
    }
    const workspace = resolveWorkspace(config, workspaceAlias);
    const repository = await repositoryStateForEvent(workspace, config, event);
    return withIntegrityTransaction(config, db => {
      if (!taskId) {
        const workspaceState = normalizeWorkspaceState(readWorkspaceRow(db, workspace.alias) || createWorkspaceState(workspace.alias));
        applyWorkspaceIntegrityEvent(workspaceState, event, repository.changedFiles);
        writeWorkspaceRow(db, workspace.alias, workspaceState);
        return null;
      }
      let authority = readTaskRow(db, taskId);
      if (!authority) {
        const tool = clean(event.tool);
        if (tool === OP.WORK_FINISH || tool === OP.WORK_CANCEL) return null;
        if (tool !== OP.WORK_BEGIN) {
          throw new TaskIntegrityError(
            'TASK_INTEGRITY_STATE_MISSING',
            `Authoritative integrity state is missing for logical task '${taskId}'. Omit work_id to run at workspace scope, or start a new durable work session.`
          );
        }
        authority = createAuthority(taskId, workspace, event, repository.baseline);
      }
      const ownedWorkspace = resolveWorkspace(config, authority.workspace || workspaceAlias);
      const workspaceState = readWorkspaceRow(db, ownedWorkspace.alias) || createWorkspaceState(ownedWorkspace.alias);
      const projection = applyIntegrityEvent(authority, workspaceState, ownedWorkspace, event, repository.changedFiles);
      writeTaskRow(db, taskId, authority);
      writeWorkspaceRow(db, ownedWorkspace.alias, workspaceState);
      return projection;
    });
  } catch (error) {
    if (error instanceof TaskIntegrityError) throw error;
    throw new TaskIntegrityError(
      'TASK_INTEGRITY_PERSISTENCE_FAILED',
      `Workspace/task integrity state could not be persisted for '${workspaceAlias}'.`,
      { cause: error }
    );
  }
}

// Capture the ownership baseline before the first operation can change files,
// inside its workspace queue. Creating an identity must not wait on Git.
async function ensureTaskBaseline(
  config: IntegrityConfig,
  taskId: string,
  workspaceAlias: string,
  options: { signal?: AbortSignal } = {}
): Promise<IntegrityAuthority | null> {
  options.signal?.throwIfAborted?.();
  const initial = readTaskIntegrity(config, taskId, workspaceAlias);
  if (!initial?.baseline.pending) return initial;
  const key = `${stateDatabasePath(config)}\0${workspaceAlias}\0${taskId}`;
  const existing = pendingBaselineCaptures.get(key);
  if (existing) return existing;
  const capture = captureTaskBaseline(config, taskId, workspaceAlias, options);
  pendingBaselineCaptures.set(key, capture);
  try {
    return await capture;
  } finally {
    if (pendingBaselineCaptures.get(key) === capture) pendingBaselineCaptures.delete(key);
  }
}

async function captureTaskBaseline(
  config: IntegrityConfig,
  taskId: string,
  workspaceAlias: string,
  options: { signal?: AbortSignal } = {}
): Promise<IntegrityAuthority | null> {
  options.signal?.throwIfAborted?.();
  const workspace = resolveWorkspace(config, workspaceAlias);
  const repository = await repositoryStateForEvent(workspace, config, { tool: OP.WORK_BEGIN }, options);
  return withIntegrityTransaction(config, db => {
    const authority = readTaskRow(db, taskId);
    if (!authority?.baseline.pending || !repository.baseline) return authority;
    authority.baseline = repository.baseline;
    authority.ambientChangedFiles = repository.baseline.changedFiles;
    const state = normalizeWorkspaceState(readWorkspaceRow(db, workspaceAlias) || createWorkspaceState(workspaceAlias));
    reconcileWorkspaceOwners(state, repository.baseline.changedFiles);
    for (const file of repository.baseline.changedFiles) {
      if (!state.uncommittedOwners[file]?.length) addWorkspaceOwner(state, file, AMBIENT_OWNER);
    }
    writeTaskRow(db, taskId, authority);
    writeWorkspaceRow(db, workspaceAlias, state);
    return authority;
  });
}

function readTaskIntegrity(config: IntegrityConfig, taskId: unknown, workspaceAlias = ''): IntegrityAuthority | null {
  try {
    const authority = withIntegrityDatabase(config, db => readTaskRow(db, taskId));
    if (!authority) return null;
    if (workspaceAlias && authority.workspace !== workspaceAlias) return null;
    return authority;
  } catch (error) {
    if (error instanceof TaskIntegrityError) throw error;
    throw new TaskIntegrityError('TASK_INTEGRITY_STATE_INVALID', `Authoritative integrity state is unreadable for logical task '${String(taskId || '')}'.`, { cause: error });
  }
}

function taskOwnedChangedFiles(config: IntegrityConfig, taskId: unknown, workspaceAlias = ''): string[] {
  const authority = readTaskIntegrity(config, taskId, workspaceAlias);
  return Array.isArray(authority?.taskOwnedChangedFiles) ? [...authority.taskOwnedChangedFiles] : [];
}

function taskCommitOwnership(config: IntegrityConfig, taskId: unknown, workspaceAlias = ''): OwnershipProjection {
  return withIntegrityDatabase(config, db => {
    const authority = readTaskRow(db, taskId);
    if (!authority || (workspaceAlias && authority.workspace !== workspaceAlias)) return { ownedFiles: [], conflictingFiles: [] };
    const workspace = normalizeWorkspaceState(readWorkspaceRow(db, authority.workspace) || createWorkspaceState(authority.workspace));
    return taskCommitOwnershipFromState(workspace, String(taskId || ''));
  }, { transaction: true });
}

function claimTaskChangedFiles(config: IntegrityConfig, taskId: unknown, workspaceAlias: unknown, changedFiles: unknown[] = []): OwnershipProjection {
  const owner = clean(taskId);
  const workspace = clean(workspaceAlias);
  const files = exactPaths(changedFiles);
  if (!owner || !workspace || !files.length) return { ownedFiles: [], conflictingFiles: [] };
  return withIntegrityTransaction(config, db => {
    const authority = readTaskRow(db, owner);
    if (!authority || authority.workspace !== workspace) return { ownedFiles: [], conflictingFiles: [] };
    const workspaceState = normalizeWorkspaceState(readWorkspaceRow(db, workspace) || createWorkspaceState(workspace));
    for (const file of files) addWorkspaceOwner(workspaceState, file, owner);
    writeWorkspaceRow(db, workspace, workspaceState);
    return taskCommitOwnershipFromState(workspaceState, owner);
  });
}

function releaseTaskChangedFiles(config: IntegrityConfig, taskId: unknown, workspaceAlias: unknown, changedFiles: unknown[] = []): OwnershipProjection {
  const owner = clean(taskId);
  const workspace = clean(workspaceAlias);
  const files = exactPaths(changedFiles);
  if (!owner || !workspace || !files.length) return { ownedFiles: [], conflictingFiles: [] };
  return withIntegrityTransaction(config, db => {
    const workspaceState = normalizeWorkspaceState(readWorkspaceRow(db, workspace) || createWorkspaceState(workspace));
    for (const file of files) removeWorkspaceOwner(workspaceState, file, owner);
    writeWorkspaceRow(db, workspace, workspaceState);
    return taskCommitOwnershipFromState(workspaceState, owner);
  });
}

function readWorkspaceIntegrity(config: IntegrityConfig, workspaceAlias: unknown): WorkspaceIntegrityState {
  try {
    return withIntegrityDatabase(config, db => normalizeWorkspaceState(readWorkspaceRow(db, workspaceAlias) || createWorkspaceState(workspaceAlias)));
  } catch (error) {
    if (error instanceof TaskIntegrityError) throw error;
    throw new TaskIntegrityError('TASK_INTEGRITY_STATE_INVALID', `Workspace integrity state is unreadable for '${String(workspaceAlias || '')}'.`, { cause: error });
  }
}

function applyIntegrityEvent(
  authority: IntegrityAuthority,
  workspaceState: WorkspaceIntegrityState,
  workspace: Record<string, any>,
  event: IntegrityEvent,
  repositoryChanged: string[] | null = null
): IntegrityProjection {
  const tool = clean(event.tool);
  const timestamp = clean(event.ts) || new Date().toISOString();
  const changedFiles = exactChangedFiles(event);
  const mutation = eventMutatedCode(event) && (event.ok !== false || changedFiles.length > 0);
  normalizeWorkspaceState(workspaceState);
  if (Array.isArray(repositoryChanged)) reconcileWorkspaceOwners(workspaceState, repositoryChanged);
  if (tool === OP.WORK_BEGIN && Array.isArray(repositoryChanged)) {
    for (const file of exactPaths(repositoryChanged)) {
      if (!workspaceState.uncommittedOwners[file]?.length) addWorkspaceOwner(workspaceState, file, AMBIENT_OWNER);
    }
  }

  authority.updatedAt = timestamp;
  authority.workspace = String(workspace.alias || '');
  authority.workspacePath = String(workspace.path || '');

  if (mutation) {
    authority.mutationGeneration += 1;
    authority.taskOwnedChangedFiles = unique([...authority.taskOwnedChangedFiles, ...changedFiles]);
    for (const file of changedFiles) addWorkspaceOwner(workspaceState, file, authority.taskId);
    authority.lastMutationAt = timestamp;
    authority.lastMutationTool = tool;
    authority.validationResult = authority.validationResult === 'passed' ? 'stale' : authority.validationResult;
    authority.validatedRepositoryFingerprint = '';
    workspaceState.generation += 1;
    workspaceState.updatedAt = timestamp;
    workspaceState.lastMutation = {
      taskId: authority.taskId,
      generation: workspaceState.generation,
      changedFiles,
      tool,
      at: timestamp
    };
  }

  if (tool === OP.VALIDATE_CHECKS || (tool === OP.EDIT && clean(event.validationStatus))) {
    applyValidationState(authority, workspaceState, event, timestamp);
  }

  if (event.completionKnown === true || tool === OP.WORK_FINISH && event.ok !== false) {
    authority.finalCompletionGeneration = authority.mutationGeneration;
    authority.completedAt = timestamp;
  }
  if (tool === OP.WORK_CANCEL && event.ok !== false && clean(event.taskCancellationStatus).toLowerCase() !== 'cancelling') {
    authority.cancelledAt = timestamp;
  }
  if (tool === OP.PUBLISH_COMMIT && event.ok !== false) {
    for (const file of exactCommittedFiles(event)) removeWorkspaceOwner(workspaceState, file, authority.taskId);
  }

  if (mutation || REPOSITORY_RECONCILE_TOOLS.has(tool)) {
    authority.ambientChangedFiles = Array.isArray(repositoryChanged) ? repositoryChanged : authority.ambientChangedFiles;
    authority.externalChangedFiles = authority.ambientChangedFiles.filter(file =>
      !authority.baseline.changedFiles.includes(file) && !authority.taskOwnedChangedFiles.includes(file)
    );
  }

  return integrityProjection(authority, workspaceState);
}

function applyWorkspaceIntegrityEvent(workspaceState: WorkspaceIntegrityState, event: IntegrityEvent, repositoryChanged: string[] | null = null): void {
  const tool = clean(event.tool);
  const timestamp = clean(event.ts) || new Date().toISOString();
  const changedFiles = exactChangedFiles(event);
  const mutation = eventMutatedCode(event) && (event.ok !== false || changedFiles.length > 0);
  normalizeWorkspaceState(workspaceState);
  if (Array.isArray(repositoryChanged)) reconcileWorkspaceOwners(workspaceState, repositoryChanged);
  if (!mutation) return;
  for (const file of changedFiles) addWorkspaceOwner(workspaceState, file, AMBIENT_OWNER);
  workspaceState.generation += 1;
  workspaceState.updatedAt = timestamp;
  workspaceState.lastMutation = {
    taskId: '',
    generation: workspaceState.generation,
    changedFiles,
    tool,
    at: timestamp
  };
}

function integrityEventRequiresPersistence(event: IntegrityEvent): boolean {
  const tool = clean(event?.tool);
  const changedFiles = exactChangedFiles(event);
  const mutation = eventMutatedCode(event) && (event?.ok !== false || changedFiles.length > 0);
  return tool === OP.WORK_BEGIN
    || mutation
    || Boolean(clean(event?.validationStatus))
    || REPOSITORY_RECONCILE_TOOLS.has(tool)
    || event?.completionKnown === true;
}

function readIntegrityProjection(config: IntegrityConfig, taskId: string, workspaceAlias: string): IntegrityProjection {
  return withIntegrityDatabase(config, db => {
    const authority = readTaskRow(db, taskId);
    if (!authority) {
      throw new TaskIntegrityError(
        'TASK_INTEGRITY_STATE_MISSING',
        `Authoritative integrity state is missing for logical task '${taskId}'. Start a new logical task rather than reconstructing safety state from audit history.`
      );
    }
    const workspace = clean(authority.workspace || workspaceAlias);
    const workspaceState = readWorkspaceRow(db, workspace) || createWorkspaceState(workspace);
    return integrityProjection(authority, workspaceState);
  }, { transaction: true });
}

function integrityProjection(authority: IntegrityAuthority, workspaceState: WorkspaceIntegrityState): IntegrityProjection {
  const ownership = taskCommitOwnershipFromState(normalizeWorkspaceState(workspaceState), authority.taskId);
  return {
    taskMutationGeneration: authority.mutationGeneration,
    taskValidatedMutationGeneration: authority.latestValidatedMutationGeneration,
    taskWorkspaceGeneration: workspaceState.generation,
    taskOwnedChangedFiles: authority.taskOwnedChangedFiles,
    taskUncommittedChangedFiles: ownership.ownedFiles,
    taskConflictingChangedFiles: ownership.conflictingFiles,
    externalChangedFiles: authority.externalChangedFiles
  };
}

function applyValidationState(authority: IntegrityAuthority, workspaceState: WorkspaceIntegrityState, event: IntegrityEvent, timestamp: string): void {
  const validationStatus = clean(event.validationStatus);
  authority.validationResult = validationStatus || (event.ok === false ? 'failed' : 'not_run');
  authority.validationAt = timestamp;
  authority.validationLevel = clean(event.validationLevel);
  authority.validationFingerprint = clean(event.validationFingerprint);
  authority.validationScope = Array.isArray(event.validationScope)
    ? unique(event.validationScope.map(normalizePath).filter(Boolean)).slice(0, 1000)
    : authority.validationScope || [];
  if (authority.validationResult !== 'passed') return;
  authority.hasPassedValidation = true;
  authority.latestPassedValidationAt = timestamp;
  authority.latestValidatedMutationGeneration = authority.mutationGeneration;
  authority.validatedWorkspaceGeneration = workspaceState.generation;
  authority.validatedRepositoryFingerprint = authority.validationFingerprint;
  authority.conflictingExternalMutations = [];
}

function createAuthority(taskId: string, workspace: Record<string, any>, event: IntegrityEvent, baseline: RepositoryBaseline | null): IntegrityAuthority {
  if (!baseline) throw new TaskIntegrityError('TASK_INTEGRITY_STATE_INVALID', 'Repository baseline was not captured for task creation.');
  const timestamp = clean(event.ts) || new Date().toISOString();
  return {
    version: STORE_VERSION,
    taskId,
    workspace: String(workspace.alias || ''),
    workspacePath: String(workspace.path || ''),
    createdAt: timestamp,
    updatedAt: timestamp,
    baseline,
    taskOwnedChangedFiles: [],
    ambientChangedFiles: baseline.changedFiles,
    externalChangedFiles: [],
    mutationGeneration: 0,
    latestValidatedMutationGeneration: 0,
    validatedWorkspaceGeneration: 0,
    validationResult: 'not_run',
    hasPassedValidation: false,
    latestPassedValidationAt: '',
    validationAt: '',
    validationLevel: '',
    validationFingerprint: '',
    validationScope: [],
    validatedRepositoryFingerprint: '',
    conflictingExternalMutations: [],
    finalCompletionGeneration: null,
    completedAt: '',
    cancelledAt: '',
    lastMutationAt: '',
    lastMutationTool: ''
  };
}

function createWorkspaceState(workspace: unknown): WorkspaceIntegrityState {
  return {
    version: STORE_VERSION,
    workspace: clean(workspace),
    generation: 0,
    updatedAt: '',
    lastMutation: null,
    uncommittedOwners: {}
  };
}

async function repositoryStateForEvent(
  workspace: Record<string, any>,
  config: IntegrityConfig,
  event: IntegrityEvent,
  options: { signal?: AbortSignal } = {}
): Promise<RepositoryEventState> {
  const tool = clean(event?.tool);
  if (tool === OP.WORK_BEGIN && event.deferBaseline === true) {
    return { baseline: { pending: true, branch: '', head: '', unborn: false, changedFiles: [] }, changedFiles: null };
  }
  const needsChangedFiles = tool === OP.WORK_BEGIN
    || REPOSITORY_RECONCILE_TOOLS.has(tool)
    || Boolean(clean(event?.validationStatus));
  if (!needsChangedFiles) return { baseline: null, changedFiles: null };
  options.signal?.throwIfAborted?.();
  const statusResult = await runProcess('git', gitStatusArgs(), {
    cwd: workspace.path,
    timeout: 30_000,
    maxOutputBytes: 8 * 1024 * 1024,
    ...(options.signal ? { signal: options.signal } : {})
  }, config);
  options.signal?.throwIfAborted?.();
  const parsed = statusResult.exitCode === 0 && !statusResult.stdoutTruncated
    ? parseGitStatus(statusResult.stdout || '')
    : { branch: null, unborn: false, entries: [] };
  const entries = (Array.isArray(parsed.entries) ? parsed.entries : []) as Array<Record<string, any>>;
  const changedFiles: string[] = unique(entries.map(entry => normalizePath(entry.path)).filter(Boolean)).sort();
  if (tool !== OP.WORK_BEGIN) return { baseline: null, changedFiles };
  const headResult = await runProcess('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: workspace.path,
    timeout: 30_000,
    maxOutputBytes: 1024 * 1024,
    ...(options.signal ? { signal: options.signal } : {})
  }, config);
  options.signal?.throwIfAborted?.();
  const head = headResult.exitCode === 0 && !headResult.stdoutTruncated ? String(headResult.stdout || '').trim() : '';
  return {
    changedFiles,
    baseline: {
      branch: parsed.branch || '',
      head,
      unborn: parsed.unborn === true || Boolean(parsed.branch && !head),
      changedFiles
    }
  };
}

function eventMutatedCode(event: IntegrityEvent): boolean {
  const tool = clean(event.tool);
  if (tool === OP.EXEC) return exactChangedFiles(event).length > 0 || event.mutationUnknown === true;
  return CODE_MUTATING_TOOLS.has(tool);
}

function exactChangedFiles(event: IntegrityEvent): string[] {
  return exactPaths(event.changedFiles);
}

function exactCommittedFiles(event: IntegrityEvent): string[] {
  return exactPaths(event.committedFiles);
}

function exactPaths(values: unknown): string[] {
  return unique((Array.isArray(values) ? values : []).map(normalizePath).filter(Boolean));
}

function normalizeWorkspaceState(workspaceState: WorkspaceIntegrityState): WorkspaceIntegrityState {
  if (!workspaceState.uncommittedOwners || typeof workspaceState.uncommittedOwners !== 'object' || Array.isArray(workspaceState.uncommittedOwners)) {
    workspaceState.uncommittedOwners = {};
  }
  for (const [file, owners] of Object.entries(workspaceState.uncommittedOwners)) {
    const normalizedFile = normalizePath(file);
    const normalizedOwners = unique((Array.isArray(owners) ? owners : []).map(clean).filter(Boolean));
    if (!normalizedFile || !normalizedOwners.length) {
      delete workspaceState.uncommittedOwners[file];
      continue;
    }
    if (normalizedFile !== file) delete workspaceState.uncommittedOwners[file];
    workspaceState.uncommittedOwners[normalizedFile] = normalizedOwners;
  }
  return workspaceState;
}

function addWorkspaceOwner(workspaceState: WorkspaceIntegrityState, file: unknown, owner: unknown): void {
  const normalizedFile = normalizePath(file);
  const normalizedOwner = clean(owner);
  if (!normalizedFile || !normalizedOwner) return;
  workspaceState.uncommittedOwners[normalizedFile] = unique([
    ...(workspaceState.uncommittedOwners[normalizedFile] || []),
    normalizedOwner
  ]);
}

function removeWorkspaceOwner(workspaceState: WorkspaceIntegrityState, file: unknown, owner: unknown): void {
  const normalizedFile = normalizePath(file);
  const normalizedOwner = clean(owner);
  if (!normalizedFile || !normalizedOwner) return;
  const owners = (workspaceState.uncommittedOwners[normalizedFile] || []).filter(value => value !== normalizedOwner);
  if (owners.length) workspaceState.uncommittedOwners[normalizedFile] = owners;
  else delete workspaceState.uncommittedOwners[normalizedFile];
}

function reconcileWorkspaceOwners(workspaceState: WorkspaceIntegrityState, repositoryChanged: unknown): void {
  const dirty = new Set(exactPaths(repositoryChanged));
  for (const file of Object.keys(workspaceState.uncommittedOwners)) {
    if (!dirty.has(file)) delete workspaceState.uncommittedOwners[file];
  }
  for (const file of dirty) {
    if (!workspaceState.uncommittedOwners[file]?.length) addWorkspaceOwner(workspaceState, file, AMBIENT_OWNER);
  }
}

function taskCommitOwnershipFromState(workspaceState: WorkspaceIntegrityState, taskId: unknown): OwnershipProjection {
  const owner = clean(taskId);
  const ownedFiles: string[] = [];
  const conflictingFiles: string[] = [];
  for (const [file, owners] of Object.entries(workspaceState?.uncommittedOwners || {})) {
    if (!owners.includes(owner)) continue;
    ownedFiles.push(file);
    if (owners.some(value => value !== owner)) conflictingFiles.push(file);
  }
  return { ownedFiles: unique(ownedFiles).sort(), conflictingFiles: unique(conflictingFiles).sort() };
}

function integrityDir(config: IntegrityConfig): string {
  return path.join(getStateDir(config), 'task-integrity');
}

function withIntegrityDatabase<TResult>(
  config: IntegrityConfig,
  operation: (db: DatabaseSync) => TResult,
  options: { transaction?: boolean } = {}
): TResult {
  migrateLegacyIntegrity(config);
  return withStateDatabase(config, operation, { ...options, timeoutMs: INTEGRITY_SQLITE_TIMEOUT_MS }) as TResult;
}

function withIntegrityTransaction<TResult>(config: IntegrityConfig, operation: (db: DatabaseSync) => TResult): TResult {
  return withIntegrityDatabase(config, operation, { transaction: true });
}

function migrateLegacyIntegrity(config: IntegrityConfig): void {
  const databaseKey = stateDatabasePath(config);
  if (migratedIntegrityDatabases.has(databaseKey)) return;
  const directory = integrityDir(config);
  withStateDatabase(config, (db: DatabaseSync) => {
    if (stateMetaValue(db, LEGACY_INTEGRITY_MIGRATION_KEY, '') === '1') return;
    importLegacyIntegrityDirectory(db, path.join(directory, 'tasks'), 'task');
    importLegacyIntegrityDirectory(db, path.join(directory, 'workspaces'), 'workspace');
    setStateMeta(db, LEGACY_INTEGRITY_MIGRATION_KEY, '1');
  }, { transaction: true, timeoutMs: INTEGRITY_SQLITE_TIMEOUT_MS });
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
  migratedIntegrityDatabases.add(databaseKey);
}

function importLegacyIntegrityDirectory(db: DatabaseSync, directory: string, kind: 'task' | 'workspace'): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(directory, entry.name);
    const value = readJsonFile<Record<string, any>>(file, {
      backup: true,
      validate: item => Boolean(item && typeof item === 'object' && !Array.isArray(item))
    });
    if (!value) throw new Error(`Legacy task integrity record is unreadable: ${file}`);
    if (kind === 'task') {
      const taskId = clean(value.taskId);
      if (!taskId) throw new Error(`Legacy task integrity record has no taskId: ${file}`);
      writeTaskRow(db, taskId, value as IntegrityAuthority);
    } else {
      const workspace = clean(value.workspace);
      if (!workspace) throw new Error(`Legacy workspace integrity record has no workspace: ${file}`);
      writeWorkspaceRow(db, workspace, value as WorkspaceIntegrityState);
    }
  }
}

function readTaskRow(db: DatabaseSync, taskId: unknown): IntegrityAuthority | null {
  const row = db.prepare('SELECT payload FROM task_integrity_tasks WHERE task_id=?').get(clean(taskId)) as { payload?: unknown } | undefined;
  return parseIntegrityPayload(row?.payload, 'task') as IntegrityAuthority | null;
}

function readWorkspaceRow(db: DatabaseSync, workspaceAlias: unknown): WorkspaceIntegrityState | null {
  const row = db.prepare('SELECT payload FROM workspace_integrity WHERE workspace=?').get(clean(workspaceAlias)) as { payload?: unknown } | undefined;
  return parseIntegrityPayload(row?.payload, 'workspace') as WorkspaceIntegrityState | null;
}

function writeTaskRow(db: DatabaseSync, taskId: unknown, value: IntegrityAuthority): void {
  const id = clean(taskId);
  if (!id) throw new Error('Task integrity writes require a taskId.');
  db.prepare(`INSERT INTO task_integrity_tasks(task_id,updated_at_ms,payload) VALUES(?,?,?)
    ON CONFLICT(task_id) DO UPDATE SET updated_at_ms=excluded.updated_at_ms,payload=excluded.payload`)
    .run(id, integrityUpdatedAtMs(value), JSON.stringify(value));
}

function writeWorkspaceRow(db: DatabaseSync, workspaceAlias: unknown, value: WorkspaceIntegrityState): void {
  const workspace = clean(workspaceAlias);
  if (!workspace) throw new Error('Workspace integrity writes require a workspace.');
  db.prepare(`INSERT INTO workspace_integrity(workspace,updated_at_ms,payload) VALUES(?,?,?)
    ON CONFLICT(workspace) DO UPDATE SET updated_at_ms=excluded.updated_at_ms,payload=excluded.payload`)
    .run(workspace, integrityUpdatedAtMs(value), JSON.stringify(value));
}

function parseIntegrityPayload(payload: unknown, kind: 'task' | 'workspace'): Record<string, any> | null {
  if (payload == null) return null;
  let value: unknown;
  try { value = JSON.parse(String(payload)) as unknown; }
  catch (error) { throw new TaskIntegrityError('TASK_INTEGRITY_STATE_INVALID', `Stored ${kind} integrity state is not valid JSON.`, { cause: error }); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Number((value as Record<string, any>).version || 0) !== STORE_VERSION) {
    throw new TaskIntegrityError('TASK_INTEGRITY_STATE_INVALID', `Stored ${kind} integrity state has an unsupported schema.`);
  }
  return value as Record<string, any>;
}

function integrityUpdatedAtMs(value: Record<string, any>): number {
  const timestamp = Date.parse(String(value?.updatedAt || ''));
  return Number.isFinite(timestamp) ? Math.floor(timestamp) : Date.now();
}

function normalizePath(value: unknown): string {
  return clean(value).replaceAll('\\', '/').replace(/^\.\//, '');
}

function clean(value: unknown): string {
  return String(value || '').trim();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code || '') : '';
}

export {
  TaskIntegrityError,
  claimTaskChangedFiles,
  readTaskIntegrity,
  readWorkspaceIntegrity,
  recordTaskIntegrityEvent,
  ensureTaskBaseline,
  releaseTaskChangedFiles,
  taskCommitOwnership,
  taskOwnedChangedFiles
};

export type { IntegrityAuthority, IntegrityConfig, IntegrityEvent, IntegrityProjection, OwnershipProjection, WorkspaceIntegrityState };
