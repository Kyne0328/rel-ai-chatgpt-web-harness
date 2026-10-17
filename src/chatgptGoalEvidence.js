// A bounded, read-only evidence projection. Assistant prose is never a receipt.
import { createHash } from 'node:crypto';
import { sanitizeDisplayText } from './taskObservability.js';
import { stableJson } from './stableJson.js';

const MAX_BYTES = 24 * 1024;
const MAX_RECEIPTS = 20;
const MAX_STEPS = 16;
const MAX_CRITERIA = 12;
const SUCCESS = new Set(['passed', 'succeeded', 'observed', 'completed']);
const ACTIVE = new Set(['running', 'queued', 'starting', 'pending']);
const CONTROL = /^(?:work\.|goal\.|relai_work$|relai_goal)/;

function text(value, limit = 180) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const sanitized = String(value).slice(0, 20000)
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*/gi, '[redacted-private-key]')
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]');
  return sanitizeDisplayText(sanitized, limit);
}
function count(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function hash(value) { return createHash('sha256').update(stableJson(value)).digest('hex'); }
function list(value) { return Array.isArray(value) ? value : []; }
function id(kind, value) { return kind + ':' + hash(value).slice(0, 24); }
function reference(value) {
  const result = text(value, 200);
  return result.replace(/https?:\/\/[^\s]+/gi, match => {
    try { const url = new URL(match); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
    catch { return '[redacted-url]'; }
  });
}
function timestamp(value) {
  const number = typeof value === 'number' ? value : Date.parse(value || '');
  const date = new Date(number);
  return Number.isFinite(date.getTime()) && number > 0 ? date.toISOString() : '';
}
function digest(value) { return typeof value === 'string' && /^[a-f0-9]{32,128}$/i.test(value) ? value : ''; }

function receipt(event, workId, source) {
  if (!event || typeof event !== 'object') return null;
  const owner = String(event.taskId || event.work_id || event.sessionId || '');
  if (owner && workId && owner !== workId) return null;
  const metadata = event.metadata || {};
  const rawTool = event.sourceTool || metadata.internalOperation || event.tool?.name || event.tool;
  const tool = text(rawTool, 80);
  const receiptId = text(event.key || event.eventId || event.operationId || event.tool?.invocationId || event.id, 200);
  if (!tool || !receiptId) return null;
  const outcome = text(event.outcome || event.status, 40);
  const unsettled = ACTIVE.has(outcome) || metadata.executed === false || metadata.timedOut === true
    || metadata.cancelled === true || metadata.terminationConfirmed === false || metadata.terminationConfirmed === null;
  const exitCode = typeof metadata.exitCode === 'number' && Number.isFinite(metadata.exitCode) ? metadata.exitCode : null;
  const successful = SUCCESS.has(outcome) && !unsettled && (exitCode === null || exitCode === 0);
  const paths = [...new Set([...list(event.paths || metadata.changedFiles || event.changedFiles),
    ...(event.target?.workspaceRelativePath ? [event.target.workspaceRelativePath] : [])]
    .slice(0, 8).map(reference).filter(Boolean))];
  const reads = list(metadata.reads).slice(0, 5).map(item => ({
    path: reference(item?.path), sha256: digest(item?.sha256)
  })).filter(item => item.path && item.sha256);
  const observedAt = timestamp(event.completedAt || event.createdAt || event.timestamp || event.ts);
  const projection = {
    kind: source === 'workflow' ? 'workflow_receipt' : 'operation_receipt',
    source, sourceTool: tool, receiptId, outcome, successful, settled: !unsettled,
    verified: !unsettled, observedAt, paths, reads,
    mutationGeneration: count(event.mutationGeneration ?? event.taskMutationGeneration),
    workspaceGeneration: count(event.workspaceGeneration ?? event.taskWorkspaceGeneration),
    repositoryFingerprint: digest(event.repositoryFingerprint || event.validationFingerprint),
    validationStatus: text(metadata.validationStatus || event.validationStatus, 40),
    check: event.kind === 'check' || tool === 'validate.checks',
    exitCode,
    // A tool summary reports an operation; it cannot assert the whole goal succeeded.
    summary: text(event.result?.outcome || event.title, 180)
  };
  if (event.commandId) projection.commandId = text(event.commandId, 120);
  if (metadata.uiAction) projection.uiAction = text(metadata.uiAction, 40);
  if (metadata.route) projection.route = reference(metadata.route);
  if (metadata.evidenceId) projection.artifactReference = reference(metadata.evidenceId);
  projection.id = id('receipt', [source, receiptId, observedAt, outcome, projection.repositoryFingerprint]);
  return projection;
}

function validationEvidence(task, integrity, receipts) {
  const mutationGeneration = count(integrity?.mutationGeneration ?? task.taskMutationGeneration);
  const validatedMutationGeneration = count(integrity?.latestValidatedMutationGeneration ?? task.taskValidatedMutationGeneration);
  const workspaceGeneration = count(integrity?.workspaceGeneration);
  const validatedWorkspaceGeneration = count(integrity?.validatedWorkspaceGeneration);
  const reported = text(integrity?.validationResult || task.validation || 'not_run', 40);
  const conflict = list(integrity?.conflictingExternalMutations).length > 0 || integrity?.lastMutationUnknown === true;
  const known = Boolean(integrity && mutationGeneration !== null && validatedMutationGeneration !== null);
  const matching = known && mutationGeneration === validatedMutationGeneration
    && workspaceGeneration !== null && validatedWorkspaceGeneration === workspaceGeneration && !conflict;
  const observedAt = timestamp(integrity?.validationAt || task.validationAt);
  const fingerprint = digest(integrity?.validatedRepositoryFingerprint || integrity?.validationFingerprint);
  const matchingReceipt = receipts.find(item => item.check && item.successful
    && item.mutationGeneration === mutationGeneration && item.workspaceGeneration === workspaceGeneration
    && fingerprint && item.repositoryFingerprint === fingerprint);
  const current = reported === 'passed' && matching && Boolean(observedAt) && Boolean(fingerprint || matchingReceipt);
  return {
    id: id('validation', [reported, mutationGeneration, validatedMutationGeneration, workspaceGeneration, validatedWorkspaceGeneration, fingerprint, observedAt, conflict]),
    kind: 'validation', verified: current, status: current ? 'passed' : reported === 'passed' ? 'unverified' : reported,
    current, reportedStatus: reported, mutationGeneration, validatedMutationGeneration,
    workspaceGeneration, validatedWorkspaceGeneration, repositoryFingerprint: fingerprint, observedAt,
    freshnessScope: 'recorded_task_and_workspace_generations',
    requiresFinalFingerprintCheck: true, receiptRefs: matchingReceipt ? [matchingReceipt.id] : []
  };
}

function conversationClaims(conversation, snapshot) {
  const mapping = conversation?.mapping;
  let nodeId = snapshot?.nodeId || conversation?.current_node;
  const seen = new Set();
  while (nodeId && mapping?.[nodeId] && seen.size < 24 && !seen.has(nodeId)) {
    seen.add(nodeId);
    const node = mapping[nodeId];
    const message = node.message;
    if (message?.author?.role === 'assistant') {
      const parts = list(message.content?.parts).filter(value => typeof value === 'string').slice(0, 2);
      const claim = text(parts.map(part => part.slice(0, 2048)).join(' '), 480);
      if (claim) return [{ id: id('claim', String(message.id || nodeId)), kind: 'claim',
        verified: false, source: 'assistant', text: claim }];
    }
    if (message?.author?.role === 'user') break;
    nodeId = node.parent;
  }
  return [];
}

function criteriaEvidence(goal, task, items) {
  const raw = list(goal.successCriteria || task.successCriteria);
  const observations = new Map(items.map(item => [item.id, item]));
  return raw.slice(0, MAX_CRITERIA).map((criterion, index) => {
    const semanticReview = typeof criterion === 'string';
    const value = semanticReview ? { text: criterion } : criterion || {};
    const refs = [...new Set(list(value.evidenceRefs).slice(0, 8).map(ref => text(ref, 100)).filter(Boolean))];
    const observed = refs.length > 0 && refs.every(ref => {
      const item = observations.get(ref);
      return item?.verified === true && item.kind !== 'claim' && item.kind !== 'plan'
        && item.kind !== 'task' && item.successful !== false;
    });
    const rawText = value.text || value.description || value.title;
    const truncated = typeof rawText === 'string' && rawText.length > 500;
    const criterionText = text(rawText, 500) || 'Criterion ' + (index + 1);
    return {
      id: text(value.id, 80) || id('criterion', [index, criterionText]),
      text: criterionText, evidenceRefs: refs,
      requiresValidation: value.kind === 'validation' || value.requiresValidation === true
        || /\b(?:tests?|test suites?|(?:repository|validation|code) checks?|build|lint|type.?check)\b.{0,80}\b(?:pass|passes|passing|passed|succeed|succeeds|successful|green)\b|\b(?:passing|successful)\b.{0,40}\b(?:tests?|build|lint|type.?check)\b|\bno\s+(?:failing|failed)\s+tests?\b/i.test(criterionText),
      status: value.unverifiable === true || truncated ? 'unverifiable' : observed ? 'supported'
        : semanticReview ? 'requires_semantic_review' : 'unverified',
      // These are mechanical evidence checks, not a semantic completion decision.
      verified: observed && value.unverifiable !== true && !truncated
    };
  });
}

function progressProjection(item) {
  const { id: _id, receiptId: _receiptId, observedAt: _at, summary: _summary,
    source: _source, receiptRefs: _receiptRefs, ...progress } = item;
  return progress;
}

/**
 * All task/receipt/integrity inputs must come from the local task authority.
 * Conversation text is untrusted context. This function never mutates its inputs.
 * completion.eligible is a necessary guardrail, not proof of goal achievement.
 */
function buildGoalEvidence({ goal = {}, task = {}, conversation = null, snapshot = {}, integrity = null, previousFingerprint } = {}) {
  integrity ||= task.integrity || null;
  const workId = text(goal.workId || task.id || task.taskId || task.work_id, 160);
  const taskId = String(task.id || task.taskId || task.work_id || '');
  const evidenceMismatch = Boolean(taskId && workId && taskId !== workId
    || integrity?.taskId && workId && integrity.taskId !== workId
    || integrity?.workspace && task.workspace && integrity.workspace !== task.workspace);
  if (evidenceMismatch) { task = {}; integrity = null; }
  const mode = goal.mode === 'loop' ? 'loop' : 'goal';
  const rawSteps = list(task.plan?.steps);
  const plan = {
    id: id('plan', [workId, task.plan?.revision || 0]), kind: 'plan', verified: false,
    revision: count(task.plan?.revision) || 0,
    steps: rawSteps.slice(0, MAX_STEPS).map((step, index) => ({
      id: text(step?.id, 80) || 'step-' + (index + 1),
      title: text(step?.title, 180), status: text(step?.status || 'pending', 40),
      detail: text(step?.detail, 180)
    }))
  };
  const rawReceipts = [
    ...list(task.events).slice(-60).map(event => receipt(event, workId, 'activity')),
    ...list(task.workflowEvidence).slice(-60).map(event => receipt(event, workId, 'workflow'))
  ].filter(Boolean);
  const byContent = new Map();
  for (const item of rawReceipts) byContent.set(hash(progressProjection(item)), item);
  const receipts = [...byContent.values()]
    .sort((left, right) => (Date.parse(left.observedAt) || 0) - (Date.parse(right.observedAt) || 0))
    .slice(-MAX_RECEIPTS);
  const validation = validationEvidence(task, integrity, receipts);
  const artifacts = [];
  for (const item of receipts.filter(value => value.successful)) {
    const current = validation.mutationGeneration === null || validation.mutationGeneration === 0
      || item.mutationGeneration === validation.mutationGeneration
        && item.workspaceGeneration === validation.workspaceGeneration;
    for (const artifact of item.reads) artifacts.push({
      id: id('artifact', [artifact.path, artifact.sha256, item.id]), kind: 'artifact',
      verified: current, current, path: artifact.path, sha256: artifact.sha256,
      receiptRefs: [item.id], observation: 'read_content_hash'
    });
    if (item.artifactReference) artifacts.push({
      id: id('artifact', [item.artifactReference, item.id]), kind: 'artifact',
      verified: current, current, reference: item.artifactReference, receiptRefs: [item.id], observation: 'tool_artifact_reference'
    });
  }
  const boundedArtifacts = artifacts.slice(-8);
  const claims = conversationClaims(conversation, snapshot);
  const taskItem = {
    id: id('task', [workId, task.status, task.activeCalls, task.cancellationRequestedAt || '']),
    kind: 'task', verified: false, status: text(task.status, 40),
    activeCalls: count(task.activeCalls) || 0, calls: count(task.calls) || 0,
    cancellationRequested: Boolean(task.cancellationRequestedAt)
  };
  const items = [taskItem, plan, validation, ...receipts, ...boundedArtifacts, ...claims];
  const successCriteria = criteriaEvidence(goal, task, items);
  const blockers = plan.steps.filter(step => step.status === 'blocked').map(step => step.detail || step.title);
  if (['blocked', 'waiting_for_approval', 'failed', 'cancelled'].includes(taskItem.status)) {
    blockers.push(text(task.errorSummary || task.terminalReason, 240) || 'Task is ' + taskItem.status + '.');
  }
  const gaps = [];
  if (evidenceMismatch) gaps.push('Authoritative evidence does not match this work session or workspace.');
  if (!workId) gaps.push('No authoritative work session is linked.');
  if (typeof goal.objective === 'string' && goal.objective.length > 500) gaps.push('The complete objective exceeds the evidence budget.');
  if (taskItem.activeCalls || taskItem.cancellationRequested) gaps.push('Operations or cancellation have not settled.');
  if (snapshot.nodeId && snapshot.settled !== true) gaps.push('The current conversation turn has not settled.');
  if (blockers.length) gaps.push('Reported blockers or approval requirements remain.');
  if (!rawSteps.length || rawSteps.some(step => step?.status !== 'completed')) gaps.push('The work plan is not fully completed; skipped steps need explicit resolution.');
  if (!receipts.some(item => item.successful && !CONTROL.test(item.sourceTool))) gaps.push('No substantive successful operation receipt supports completion.');
  const repositoryChanged = (validation.mutationGeneration || 0) > 0
    || list(integrity?.taskOwnedChangedFiles || task.changedFiles).length > 0
    || receipts.some(item => item.sourceTool === 'edit' || item.paths.length && /edit|restore|tidy/.test(item.sourceTool));
  validation.required = repositoryChanged || goal.requiresValidation === true
    || successCriteria.some(criterion => criterion.requiresValidation);
  if (validation.required && !validation.current) gaps.push('Current successful validation for the recorded mutation generations is missing.');
  if (successCriteria.some(criterion => ['unverified', 'unverifiable'].includes(criterion.status))) {
    gaps.push('One or more explicit success criteria remain unverified or unverifiable.');
  }
  if (rawSteps.length > MAX_STEPS || list(goal.successCriteria || task.successCriteria).length > MAX_CRITERIA) gaps.push('The complete plan or criteria exceed the evidence budget.');
  if (mode === 'loop') gaps.push('Loop milestones do not complete the ongoing loop.');
  const completion = { eligible: gaps.length === 0, gaps };
  const evidence = {
    version: 1, stateRevision: count(goal.revision) || 0, workId, mode,
    objective: text(goal.objective || task.objective || task.title, 500),
    items, claims, plan, validation, artifacts: boundedArtifacts, blockers: blockers.slice(0, 8),
    successCriteria, completion, completionEligible: completion.eligible,
    turn: { nodeId: text(snapshot.nodeId, 160), lastMessageId: text(snapshot.lastMessageId, 160),
      role: text(snapshot.role, 40), settled: snapshot.settled === true },
    truncated: false, fingerprint: '', progressed: false
  };
  // The fingerprint deliberately excludes prose, call counters and timestamps:
  // another status check or rephrased assistant conclusion is not progress.
  evidence.fingerprint = hash({
    workId, mode, objective: evidence.objective,
    plan: plan.steps, taskStatus: taskItem.status, validation: progressProjection(validation),
    receipts: receipts.map(progressProjection).map(hash).sort(),
    successCriteria, blockers: evidence.blockers
  });
  evidence.progressed = Boolean(previousFingerprint && previousFingerprint !== evidence.fingerprint);
  // Unicode and large optional fields cannot defeat the serialized byte bound.
  while (Buffer.byteLength(JSON.stringify(evidence), 'utf8') > MAX_BYTES) {
    evidence.truncated = true;
    evidence.completionEligible = evidence.completion.eligible = false;
    if (!evidence.completion.gaps.includes('Evidence was truncated; completion requires a narrower verified observation.')) {
      evidence.completion.gaps.push('Evidence was truncated; completion requires a narrower verified observation.');
    }
    const removable = evidence.items.findIndex(item => item.kind === 'claim' || item.kind.endsWith('_receipt') || item.kind === 'artifact');
    if (removable >= 0) {
      const [removed] = evidence.items.splice(removable, 1);
      evidence.claims = evidence.claims.filter(item => item.id !== removed.id);
      evidence.artifacts = evidence.artifacts.filter(item => item.id !== removed.id && !item.receiptRefs.includes(removed.id));
      evidence.items = evidence.items.filter(item => item.kind !== 'artifact' || !item.receiptRefs.includes(removed.id));
    } else if (evidence.plan.steps.length) evidence.plan.steps.pop();
    else if (evidence.successCriteria.length) evidence.successCriteria.pop();
    else break;
  }
  return evidence;
}

export { buildGoalEvidence };
