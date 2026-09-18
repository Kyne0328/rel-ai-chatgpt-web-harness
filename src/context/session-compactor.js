function compactSessionSummary(session = {}, options = {}) {
  const changedFiles = unique(session.changedFiles);
  const summary = String(session.resultSummary || session.summary || '').trim();
  const current = compactCurrentState(session);
  const recentActivity = compactRecoveryActivity(session.events);
  const recentEvidence = recentActivity.length ? recentActivity : compactRecoveryEvidence(session.workflowEvidence);
  return prune({
    goal: String(session.objective || session.title || '').trim() || undefined,
    ...(session.goalMode === true ? { mode: 'goal', goal_completed: session.goal_completed === true } : {}),
    summary: summary || undefined,
    changes: changedFiles.length ? changedFiles : undefined,
    validation: compactValidation(session),
    hostContextSummary: String(session.contextSummary || '').trim() || undefined,
    current,
    recentEvidence: recentEvidence.length ? recentEvidence : undefined,
    continuity: options.continuity && Object.keys(options.continuity).length ? options.continuity : undefined,
    status: String(session.status || '').trim() || undefined
  });
}

function compactCurrentState(session) {
  const stage = String(session.currentStage || '').trim();
  const activity = String(session.currentActivity || session.operation || '').trim();
  const tool = String(session.lastTool || '').trim();
  const outcome = String(session.lastOutcome || '').trim();
  if (!stage && !activity && !tool && !outcome) return undefined;
  return prune({
    stage: stage || undefined,
    activity: activity || undefined,
    tool: tool || undefined,
    outcome: outcome || undefined
  });
}

function compactRecoveryActivity(values) {
  if (!Array.isArray(values)) return [];
  return values.map(item => {
    const operation = String(item?.metadata?.internalOperation || '').trim();
    const outcome = String(item?.status || '').trim();
    if (operation === 'work.begin' || operation === 'work.status' || outcome === 'running') return null;
    const tool = String(item?.tool?.name || item?.tool || '').trim();
    const summary = String(item?.summary || item?.message || '').trim();
    const paths = unique([
      item?.target?.workspaceRelativePath,
      ...(Array.isArray(item?.metadata?.changedFiles) ? item.metadata.changedFiles : [])
    ]).slice(0, 5);
    if (!tool && !summary && !outcome && !paths.length) return null;
    return prune({
      kind: String(item?.category || 'activity').trim() || 'activity',
      outcome: outcome || undefined,
      tool: tool || undefined,
      summary: summary || undefined,
      paths: paths.length ? paths : undefined
    });
  }).filter(Boolean).slice(-3);
}

function compactRecoveryEvidence(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(-3).map(item => {
    const paths = unique(item?.paths).slice(0, 5);
    return prune({
      kind: String(item?.kind || '').trim() || undefined,
      outcome: String(item?.outcome || '').trim() || undefined,
      tool: String(item?.sourceTool || '').trim() || undefined,
      check: String(item?.commandId || '').trim() || undefined,
      paths: paths.length ? paths : undefined
    });
  }).filter(item => Object.keys(item).length);
}

function compactValidation(session) {
  const status = String(session.validationStatus || session.validation || '').trim();
  return status || undefined;
}

function unique(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(item => String(item || '').trim()).filter(Boolean))];
}

function prune(value) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

export { compactSessionSummary };
