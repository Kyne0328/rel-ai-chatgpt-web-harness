function compactRepositoryContext(snapshot = {}) {
  const manifests = strings(snapshot.manifests);
  const hints = strings(snapshot.hints);
  const projectInstructions = compactProjectInstructions(snapshot.projectInstructions);
  const git = compactGit(snapshot.git);
  return prune({
    mode: 'compact',
    manifests: manifests.length ? manifests : undefined,
    fileCount: snapshot.truncated === true ? undefined : finiteNumber(snapshot.fileCount),
    truncated: snapshot.truncated === true ? true : undefined,
    hints: hints.length ? hints : undefined,
    git,
    projectInstructions
  });
}

function compactProjectInstructions(value) {
  if (!value || typeof value !== 'object') return undefined;
  const sources = strings(value.sources);
  const content = String(value.content || '');
  const rejectedSources = Array.isArray(value.rejectedSources) ? value.rejectedSources : [];
  const error = String(value.error || '').trim();
  if (!sources.length && !content && !rejectedSources.length && !error) return undefined;
  return prune({
    sources,
    content,
    truncated: value.truncated === true ? true : undefined,
    ...(sources.length > 1 && value.precedence ? { precedence: String(value.precedence) } : {}),
    ...(String(value.targetPath || '.') !== '.' ? { targetPath: String(value.targetPath) } : {}),
    ...(rejectedSources.length ? { rejectedSources } : {}),
    ...(error ? { error } : {})
  });
}

function compactGit(value) {
  if (!value || typeof value !== 'object') return undefined;
  const changedFiles = strings(value.changedFiles).slice(0, 20);
  return prune({
    branch: String(value.branch || '').trim() || undefined,
    aheadBehind: value.aheadBehind && typeof value.aheadBehind === 'object' ? value.aheadBehind : undefined,
    unborn: value.unborn === true ? true : undefined,
    dirtyFiles: finiteNumber(value.dirtyFiles),
    changedFiles: changedFiles.length ? changedFiles : undefined
  });
}

function strings(value) {
  return Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(Boolean) : [];
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function prune(value) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

export { compactRepositoryContext };
