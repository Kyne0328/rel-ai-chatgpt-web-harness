import { isDeepStrictEqual } from 'node:util';

import { fallbackOperationReceipt } from '../mcp/fallbackExecutions.js';
import { slimCompactPublicResult } from './compactResult.js';
import { OPERATION_IDS as OP } from './operationIds.js';
import { withTaskIdentity } from './task.js';
import {
  boundedStringArray,
  compactCommandResult,
  compactProcessMetadata,
  compactRepositoryState,
  policySentence,
  pruneEmpty
} from './connectorHelpers.js';

const RESULT_IDENTITY_FIELDS = new Set(['workspace', 'action', 'sessionId', 'tabId', 'processId', 'observationId', 'semanticObservationId', 'targetId']);

function serializeConnectorResult({ publicName, action, operationName, value, args = {}, workId = '' }) {
  const compacted = compactForConnector(operationName, value, args);
  const operationResult = value?.timeline && compacted && typeof compacted === 'object' ? { ...compacted, timeline: value.timeline } : compacted;
  const publicResult = slimCompactPublicResult(publicName, action, operationResult);
  const identified = withTaskIdentity(publicResult, workId);
  let result = identified;
  if (!shouldReturnTaskIdentity(publicName, value, args) && identified && typeof identified === 'object' && !Array.isArray(identified)) {
    const { work_id: _workId, ...withoutTaskEcho } = identified;
    result = withoutTaskEcho;
  }
  return shouldPruneArgumentEchoes(publicName, value)
    ? pruneArgumentEchoes(result, args)
    : result;
}

function shouldReturnTaskIdentity(publicName, value, args) {
  if (!String(args?.work_id || '').trim()) return true;
  if (publicName === 'relai_work' || value?.ok === false) return true;
  if (String(value?.status || '') === 'running' || value?.operationId) return true;
  return Array.isArray(value?.completedOperations) && value.completedOperations.length > 0;
}

function shouldPruneArgumentEchoes(publicName, value) {
  if (publicName === 'relai_work' || value?.ok === false) return false;
  if (String(value?.status || '') === 'running' || value?.operationId) return false;
  return !(Array.isArray(value?.completedOperations) && value.completedOperations.length > 0);
}

function pruneArgumentEchoes(value, args) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result = { ...value };
  for (const [key, argument] of Object.entries(args || {})) {
    if (key === 'work_id' || RESULT_IDENTITY_FIELDS.has(key) || !Object.hasOwn(result, key)) continue;
    if (isDeepStrictEqual(result[key], argument)) delete result[key];
  }
  return result;
}


function compactForConnector(name, value, args = {}) {
  if (!value || typeof value !== 'object') return value;
  switch (name) {
    case OP.READ: {
      if (!Array.isArray(value.items)) return value;
      const items = value.items.map(item => {
        if (!item || typeof item !== 'object') return item;
        const guidance = item.writeGuidance;
        const next = { ...item };
        delete next.cacheHit;
        if (String(args.guidanceMode || '').toLowerCase() !== 'full') {
          delete next.writeGuidance;
          if (guidance?.recommendedMode === 'exact-replace') {
            next.writeHint = 'Large or interpolation-heavy file - prefer relai_edit with oldText/newText over a full rewrite.';
          }
        }
        return next;
      });
      return { ...value, items };
    }
    case OP.WORK_STATUS:
    case OP.WORK_RESULT: {
      const full = String(args.detail || '').toLowerCase() === 'full';
      const workspace = value.workspace && typeof value.workspace === 'object'
        ? pruneEmpty(full ? {
            alias: value.workspace.alias,
            discoveredCommandKeys: value.workspace.discoveredCommandKeys,
            repository: compactRepositoryState(value.workspace.repository, { includeWorkspace: false }),
            error: value.workspace.error
          } : {
            alias: value.workspace.alias,
            error: value.workspace.error
          })
        : value.workspace;
      const targeted = Boolean(args.workspace || args.work_id || args.operationId);
      if (!full && targeted) {
        const compatibility = value.runtimeCompatibility
          ? pruneEmpty({
              status: value.runtimeCompatibility.status,
              sourceParity: value.runtimeCompatibility.sourceParity,
              compatible: value.runtimeCompatibility.compatible,
              restartRequired: value.runtimeCompatibility.restartRequired,
              activeTasksPreventRestart: value.runtimeCompatibility.activeTasksPreventRestart,
              message: value.runtimeCompatibility.message
            })
          : undefined;
        return pruneEmpty({
          ok: value.ok,
          workspace,
          work_id: value.work_id,
          task: value.task,
          activeRelatedWork: value.activeRelatedWork,
          backgroundOperation: args.operationId && args.includeResult !== false ? value.backgroundOperation : fallbackOperationReceipt(value.backgroundOperation),
          backgroundOperations: value.backgroundOperations,
          operationCursor: value.operationCursor,
          operationsHasMore: value.operationsHasMore,
          truncated: value.truncated,
          originalBytes: value.originalBytes,
          nextAction: value.nextAction,
          error: value.error,
          errorCode: value.errorCode,
          operationId: value.operationId,
          runtime: value.runtime?.buildIdentity ? { buildIdentity: value.runtime.buildIdentity } : undefined,
          runtimeCompatibility: compatibility
        });
      }
      return pruneEmpty({
        ok: value.ok,
        version: value.version,
        runtime: value.runtime,
        repositoryRuntime: value.repositoryRuntime,
        runtimeCompatibility: value.runtimeCompatibility,
        toolSurface: value.toolSurface ? {
          schemaVersion: value.toolSurface.schemaVersion,
          toolSurfaceVersion: value.toolSurface.toolSurfaceVersion,
          toolCount: value.toolSurface.toolCount,
          deprecations: value.toolSurface.deprecations
        } : undefined,
        workspace,
        work_id: value.work_id,
        task: value.task,
        activeRelatedWork: value.activeRelatedWork,
        backgroundOperation: value.backgroundOperation,
        backgroundOperations: value.backgroundOperations,
        operationCursor: value.operationCursor,
        operationsHasMore: value.operationsHasMore,
        truncated: value.truncated,
        originalBytes: value.originalBytes,
        nextAction: value.nextAction,
        error: value.error,
        errorCode: value.errorCode,
        operationId: value.operationId,
        state: workspace && value.workspace ? policySentence(value.workspace.policy) : null,
        workspaceCount: value.workspaceCount,
        workspaceAliases: value.workspaceAliases
      });
    }
    case OP.CHANGES_DIFF:
      return pruneEmpty({ ...compactRepositoryState(value), staged: value.staged, path: value.path, reviewScope: value.reviewScope || value.reviewedScope, reviewedScope: value.reviewedScope, reviewHash: value.reviewHash, reviewedFiles: value.reviewedFiles, excludedWorkspaceFiles: value.excludedWorkspaceFiles, diff: value.diff });
    case OP.CHANGES_CHECKPOINT:
    case OP.CHANGES_REPLAY:
      return pruneEmpty({ ...compactRepositoryState(value), checkpointId: value.checkpointId, payloadSha256: value.payloadSha256, createdAt: value.createdAt, replayed: value.replayed, staged: value.staged, path: value.path, reviewScope: value.reviewScope || value.reviewedScope, reviewedScope: value.reviewedScope, reviewHash: value.reviewHash, reviewedFiles: value.reviewedFiles, excludedWorkspaceFiles: value.excludedWorkspaceFiles, diff: value.diff });
    case OP.VALIDATE_CHECKS:
      return pruneEmpty({
        ok: value.ok,
        workspace: value.workspace || args.workspace,
        level: value.level,
        checks: value.checks,
        results: Array.isArray(value.results) ? value.results.map(compactCommandResult) : value.results,
        skippedChecks: value.skippedChecks,
        completedUnits: value.completedUnits,
        executedUnits: value.executedUnits,
        reusedUnits: value.reusedUnits,
        reusedChecks: value.reusedChecks,
        totalUnits: value.totalUnits,
        failedCheck: value.failedCheck,
        timedOut: value.timedOut,
        cancelled: value.cancelled,
        validated: value.validated,
        validationStatus: value.validationStatus,
        completionKnown: value.completionKnown,
        endReason: value.endReason,
        completionSource: value.completionSource,
        summary: value.summary,
        validationAt: value.validationAt,
        planId: value.planId,
        planSelection: value.planSelection,
        planCreatedAt: value.planCreatedAt,
        changedFiles: value.completionKnown === true ? value.changedFiles : undefined,
        residualChangedFiles: value.completionKnown === true ? value.residualChangedFiles : undefined,
        residualState: value.completionKnown === true ? value.residualState : undefined,
        message: value.message,
        nextAction: value.nextAction,
        fullOutput: value.fullOutput
      });
    case OP.EDIT:
      return pruneEmpty({
        ok: value.ok,
        workspace: value.workspace,
        operation: value.operation,
        path: value.path,
        changed: value.changed,
        changedFiles: value.changedFiles,
        editCount: value.editCount,
        appliedCount: value.appliedCount,
        verified: value.verified,
        bytes: value.bytes,
        plannerPath: value.plannerPath,
        plannerReason: value.plannerReason,
        resultDetailsCompacted: value.resultDetailsCompacted,
        validationStatus: value.validationStatus,
        summary: value.summary,
        error: value.error,
        next: value.next,
        ...(args.returnDiff === true ? { diff: value.diff } : {})
      });
    case OP.EXEC:
      return pruneEmpty({
        ok: value.ok,
        executed: value.executed,
        commandSucceeded: value.commandSucceeded,
        workspace: value.workspace || args.workspace,
        command: value.command,
        shell: value.shell || undefined,
        cwd: value.cwd && value.cwd !== '.' ? value.cwd : undefined,
        exitCode: value.exitCode,
        durationMs: value.durationMs,
        outputFinalizationTimedOut: value.outputFinalizationTimedOut,
        outputFinalizationError: value.outputFinalizationError,
        mutationOwnershipPersistenceError: value.mutationOwnershipPersistenceError,
        stdout: value.stdout || undefined,
        stderr: value.stderr || undefined,
        stdoutBytes: value.stdoutBytes || undefined,
        stderrBytes: value.stderrBytes || undefined,
        stdoutTruncated: value.stdoutTruncated === true ? true : undefined,
        stderrTruncated: value.stderrTruncated === true ? true : undefined,
        stdoutOutputRef: value.stdoutOutputRef || undefined,
        stderrOutputRef: value.stderrOutputRef || undefined,
        stdoutSpillTruncated: value.stdoutSpillTruncated != null ? value.stdoutSpillTruncated === true : undefined,
        stderrSpillTruncated: value.stderrSpillTruncated != null ? value.stderrSpillTruncated === true : undefined,
        timedOut: value.timedOut === true ? true : undefined,
        cancelled: value.cancelled === true ? true : undefined,
        rootExitConfirmed: value.rootExitConfirmed,
        terminationConfirmed: value.terminationConfirmed != null ? value.terminationConfirmed === true : undefined,
        forcedTermination: value.forcedTermination != null ? value.forcedTermination === true : undefined,
        signal: value.signal || undefined,
        error: value.error || undefined,
        environmentKeys: value.environmentKeys?.length ? value.environmentKeys : undefined,
        changedFiles: value.changedFiles?.length ? value.changedFiles : undefined,
        ephemeralChangedFiles: value.ephemeralChangedFiles?.length ? value.ephemeralChangedFiles : undefined,
        changedFilesTruncated: value.changedFilesTruncated === true ? true : undefined,
        mutationTracking: value.mutationTracking || undefined,
        mutationUnknown: value.mutationUnknown === true ? true : undefined
      });
    case OP.PROCESS_LIST:
      return {
        ok: value.ok,
        processes: Array.isArray(value.processes) ? value.processes.map(compactProcessMetadata) : value.processes,
        count: value.count
      };
    case OP.PROCESS_READ:
      return pruneEmpty({ ...compactProcessMetadata(value), stdout: value.stdout, stderr: value.stderr });
    case OP.SNAPSHOT: {
      const files = boundedStringArray(value.files, 4 * 1024);
      return pruneEmpty({
        ok: value.ok,
        workspace: value.workspace,
        manifests: value.manifests,
        discoveredCommands: value.discoveredCommands,
        projectInstructions: value.projectInstructions,
        skills: value.skills,
        fileCount: value.fileCount,
        files: files.values,
        returnedFileCount: files.count,
        omittedFiles: files.omitted,
        skippedCount: Array.isArray(value.skipped) ? value.skipped.length : undefined,
        truncated: value.truncated === true || files.omitted > 0,
        next: files.omitted > 0 ? 'Use relai_search or targeted relai_read calls for omitted repository paths.' : undefined,
        hints: value.hints,
        git: value.git,
        recommendedFlow: value.recommendedFlow
      });
    }
    default:
      return value;
  }
}

export { compactForConnector, policySentence, serializeConnectorResult };
