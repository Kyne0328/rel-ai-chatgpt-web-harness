import { eventTimestampMs } from './taskEvents.js';

const MAX_MILESTONES = 8;
const NATIVE_BINARY_PATTERN = /\.(?:so|dylib|dll|exe)(?:\b|["')\s])/i;
const APK_PATTERN = /\.apk(?:\b|["')\s])/i;
const SUPPORT_DIRECTORY_PATTERN = /^(?:\.relai|\.cache|\.tmp|tmp|temp|artifacts?\/tools?|vendor\/tools?)(?:\/|$)/i;
const TOOL_DIRECTORY_PATTERN = /^(?:tools?|tooling)(?:\/|$)/i;
const SUPPORT_BINARY_PATTERN = /\.(?:jar|exe|msi|zip|7z|tgz|tar\.gz|whl|appimage)$/i;
const GENERIC_ACTIVITY_PATTERN = /^(?:planning(?: next step)?|waiting for the next task step|ready for the next step|reviewing result|running tool|inspect(?:ing)? repository|read repository content|searched repository content|ran a repository command)\.?$/i;
const RAW_COMMAND_PATTERN = /^(?:ran\s+)?(?:powershell(?:\.exe)?|pwsh(?:\.exe)?|cmd(?:\.exe)?|bash|sh|zsh|node(?:\.exe)?|python(?:\.exe)?)(?:\s|$)/i;

function normalizePath(value) {
  return String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
}

function basename(value) {
  const normalized = normalizePath(value).replace(/\/+$/, '');
  return normalized.split('/').filter(Boolean).pop() || normalized;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(normalizePath).filter(Boolean))];
}

function isSupportArtifactPath(value) {
  const path = normalizePath(value);
  if (!path) return false;
  if (SUPPORT_DIRECTORY_PATTERN.test(path)) return true;
  return TOOL_DIRECTORY_PATTERN.test(path) && SUPPORT_BINARY_PATTERN.test(path);
}

function classifyTaskChangedFiles(files = []) {
  const productFiles = [];
  const supportArtifacts = [];
  for (const file of uniqueStrings(files)) {
    (isSupportArtifactPath(file) ? supportArtifacts : productFiles).push(file);
  }
  return {
    productFiles,
    supportArtifacts,
    productChangedFileCount: productFiles.length,
    supportArtifactCount: supportArtifacts.length
  };
}

function eventTool(event = {}) {
  return String(event?.tool?.name || event?.tool || event?.internalOperation || event?.action || '').trim().toLowerCase();
}

function eventStatus(event = {}) {
  return String(event?.status || (event?.ok === false ? 'failed' : 'succeeded')).trim().toLowerCase();
}

function eventPath(event = {}) {
  return normalizePath(
    event?.target?.workspaceRelativePath
    || event?.path
    || event?.filePath
    || event?.metadata?.changedFiles?.[0]
    || event?.result?.changedFiles?.[0]
    || ''
  );
}

function eventChangedFiles(event = {}) {
  return uniqueStrings([
    ...(Array.isArray(event?.metadata?.changedFiles) ? event.metadata.changedFiles : []),
    ...(Array.isArray(event?.result?.changedFiles) ? event.result.changedFiles : [])
  ]);
}

function eventText(event = {}) {
  return [
    eventTool(event),
    event?.action,
    event?.title,
    event?.summary,
    event?.message,
    event?.operation,
    event?.result?.outcome,
    eventPath(event)
  ].filter(Boolean).join(' ');
}

function commandTarget(text, pattern) {
  const normalized = String(text || '').replaceAll('\\', '/');
  const match = normalized.match(pattern);
  return normalizePath(match?.[1] || '');
}

function milestoneTool(event = {}) {
  const raw = String(event?.metadata?.publicTool || event?.tool?.name || event?.tool || '').trim();
  if (!raw) return '';
  if (raw.startsWith('relai_')) return raw;
  const internal = String(event?.metadata?.internalOperation || raw).trim();
  const root = internal.split(/[._]/)[0];
  return root ? `relai_${root}` : raw;
}

function milestoneAction(event = {}) {
  const explicit = String(event?.metadata?.publicAction || '').trim();
  if (explicit) return explicit;
  const internal = String(event?.metadata?.internalOperation || event?.tool?.name || event?.tool || '').trim();
  const separator = internal.indexOf('.');
  return separator >= 0 ? internal.slice(separator + 1) : '';
}

function milestone(key, label, stage, event, details = {}) {
  const path = normalizePath(details.path || eventPath(event));
  const tool = milestoneTool(event);
  const action = milestoneAction(event);
  return {
    key,
    label,
    stage,
    status: details.status || eventStatus(event),
    at: eventTimestampMs(event),
    ...(path ? { path, detail: details.detail || basename(path) } : details.detail ? { detail: details.detail } : {}),
    ...(tool ? { tool } : {}),
    ...(action ? { action } : {}),
    ...(details.command ? { command: details.command } : {}),
    kind: details.kind || key.split(':')[0]
  };
}

function semanticExecMilestone(event, text, options = {}) {
  const normalized = String(text || '').replaceAll('\\', '/');
  const nativePath = commandTarget(normalized, /([A-Za-z]:\/[^\s'";]+\.(?:so|dylib|dll|exe)|\/[^\s'";]+\.(?:so|dylib|dll|exe))/i);
  const apkPath = commandTarget(normalized, /([A-Za-z]:\/[^\s'";]+\.apk|\/[^\s'";]+\.apk)/i);

  const command = options.includeCommands ? String(event.command || '') : '';
  const withCommand = details => command ? { ...details, command } : details;

  if (/\b(?:apktool(?:\.jar)?|apktool\.jar)\b[\s\S]{0,220}\s(?:d|decode)(?:\s|$)/i.test(normalized)
    || /\bjadx(?:\.bat|\.exe)?\b[\s\S]{0,220}(?:\s-d\s|\s--output-dir\s)/i.test(normalized)) {
    return milestone('artifact:decompile', 'Decompiled application artifact', 'Analyzing decompiled application', event, withCommand({
      path: apkPath,
      kind: 'artifact'
    }));
  }
  if (/\b(?:apktool(?:\.jar)?|apktool\.jar)\b[\s\S]{0,220}\s(?:b|build)(?:\s|$)/i.test(normalized)) {
    return milestone('build:apk', 'Rebuilt APK', 'Building modified application', event, withCommand({ path: apkPath, kind: 'build' }));
  }
  if (/\b(?:apksigner|jarsigner)(?:\.exe)?\b/i.test(normalized)) {
    return milestone('sign:apk', 'Signed rebuilt APK', 'Preparing rebuilt application', event, withCommand({ path: apkPath, kind: 'sign' }));
  }
  if (NATIVE_BINARY_PATTERN.test(normalized)
    && /\b(?:readallbytes|strings|objdump|readelf|readobj|llvm-readobj|llvm-readelf|dumpbin)\b/i.test(normalized)) {
    return milestone(`inspect:native:${basename(nativePath) || 'binary'}`, 'Inspected native binary', 'Analyzing native implementation', event, withCommand({
      path: nativePath,
      kind: 'inspect'
    }));
  }
  if (/\b(?:where(?:\.exe)?|get-command|command\s+-v)\b/i.test(normalized)) {
    return milestone('tooling:availability', 'Checked local analysis tooling', 'Preparing analysis tooling', event, withCommand({ kind: 'tooling' }));
  }
  if (/\b(?:curl|wget|invoke-webrequest|downloadfile|start-bitstransfer)\b/i.test(normalized)) {
    const changed = classifyTaskChangedFiles(eventChangedFiles(event));
    if (changed.supportArtifactCount > 0 || /(?:\/|\\)(?:tools?|tooling)(?:\/|\\)/i.test(normalized)) {
      return milestone('tooling:prepared', 'Prepared task tooling', 'Preparing analysis tooling', event, withCommand({
        path: changed.supportArtifacts[0],
        kind: 'tooling'
      }));
    }
  }
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|compile)\b|\b(?:gradle|gradlew|mvn|dotnet)\b[\s\S]{0,100}\b(?:build|assemble|package|publish)\b/i.test(normalized)) {
    return milestone('build:project', 'Built project output', 'Building changes', event, withCommand({ kind: 'build' }));
  }
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\b(?:pytest|vitest|jest|go\s+test|cargo\s+test)\b|\b(?:gradle|gradlew|mvn|dotnet)\b[\s\S]{0,100}\btest\b/i.test(normalized)) {
    return milestone('validation:tests', 'Ran project tests', 'Validating changes', event, withCommand({ kind: 'validation' }));
  }
  if (APK_PATTERN.test(normalized) && /\b(?:7z|unzip|expand-archive)\b/i.test(normalized)) {
    return milestone('artifact:extract', 'Extracted application artifact', 'Inspecting application contents', event, withCommand({
      path: apkPath,
      kind: 'artifact'
    }));
  }
  const eventKey = event.id || event.eventId || event.tool?.invocationId || event.invocationId || eventTimestampMs(event);
  return milestone(`exec:${eventKey || 'command'}`, 'Ran project command', 'Running project command', event, withCommand({ kind: 'exec' }));
}

function semanticMilestoneForEvent(event = {}, options = {}) {
  const status = eventStatus(event);
  if (!['running', 'succeeded', 'success', 'completed', 'complete', 'failed'].includes(status)) return null;
  const tool = eventTool(event);
  const text = eventText(event);
  const path = eventPath(event);
  const changed = classifyTaskChangedFiles(eventChangedFiles(event));

  if (/work[._]?(?:begin|status)|process[._]?list/.test(tool)) return null;
  if (/\b(?:repository status|workspace and repository status)\b/i.test(text)) return null;

  if (/validate|diagnostic|run_checks/.test(tool)) {
    return milestone('validation:repository', status === 'failed' ? 'Validation failed' : 'Validated repository changes', 'Validating changes', event, {
      status,
      kind: 'validation'
    });
  }
  if (/publish[._]?commit|git[._]?commit/.test(tool)) return milestone('publish:commit', 'Created Git commit', 'Publishing changes', event, { kind: 'publish' });
  if (/publish[._]?push|git[._]?push/.test(tool)) return milestone('publish:push', 'Published Git branch', 'Publishing changes', event, { kind: 'publish' });
  if (/publish[._]?draft_pr/.test(tool)) return milestone('publish:pr', 'Prepared pull request', 'Preparing review', event, { kind: 'publish' });

  if (/changes[._]?diff/.test(tool)) return milestone('review:changes', 'Reviewed repository changes', 'Reviewing changes', event, { kind: 'review' });
  if (/changes[._]?checkpoint/.test(tool)) return milestone('review:checkpoint', 'Saved review checkpoint', 'Reviewing changes', event, { kind: 'review' });

  if (/(?:^|[._])edit$|changes[._]?(?:restore|reset|tidy_run)/.test(tool)) {
    if (changed.productChangedFileCount > 0) {
      const label = changed.productChangedFileCount === 1 ? 'Updated project file' : `Updated ${changed.productChangedFileCount} project files`;
      return milestone(`edit:${changed.productFiles[0] || 'product'}`, label, 'Reviewing applied changes', event, {
        path: changed.productFiles[0] || path,
        kind: 'edit'
      });
    }
    if (changed.supportArtifactCount > 0) {
      return milestone('tooling:prepared', 'Prepared task tooling', 'Preparing analysis tooling', event, {
        path: changed.supportArtifacts[0],
        kind: 'tooling'
      });
    }
    return milestone(`edit:${path || 'repository'}`, 'Applied repository changes', 'Reviewing applied changes', event, { path, kind: 'edit' });
  }

  if (/(?:^|[._])exec$/.test(tool)) {
    const commandText = [event.command, text].filter(Boolean).join(' ');
    return semanticExecMilestone(event, commandText, options);
  }

  if (/snapshot/.test(tool)) return milestone('inspect:inventory', 'Inventoried project structure', 'Inspecting project structure', event, { kind: 'inspect' });
  if (/inspect/.test(tool)) return milestone(`inspect:relationships:${path || 'repository'}`, 'Inspected code relationships', 'Analyzing implementation', event, { path, kind: 'inspect' });
  if (/search/.test(tool)) return milestone('inspect:search', 'Searched project code', 'Tracing relevant implementation', event, { kind: 'inspect' });
  if (/(?:^|[._])read$/.test(tool)) {
    if (NATIVE_BINARY_PATTERN.test(path)) return milestone(`inspect:native:${basename(path)}`, 'Inspected native binary', 'Analyzing native implementation', event, { path, kind: 'inspect' });
    if (/androidmanifest\.xml$/i.test(path)) return milestone('inspect:manifest', 'Inspected application manifest', 'Analyzing application structure', event, { path, kind: 'inspect' });
    if (APK_PATTERN.test(path)) return milestone('inspect:apk', 'Inspected APK', 'Analyzing application artifact', event, { path, kind: 'inspect' });
    return milestone('inspect:files', 'Inspected project files', 'Analyzing implementation', event, { path, kind: 'inspect' });
  }
  return null;
}

function meaningfulFallback(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || GENERIC_ACTIVITY_PATTERN.test(text) || RAW_COMMAND_PATTERN.test(text)) return '';
  return text.length <= 240 ? text : `${text.slice(0, 239).trimEnd()}…`;
}

function buildTaskSemanticProgress(task = {}, options = {}) {
  const events = [...(Array.isArray(task.events) ? task.events : [])].sort((left, right) => eventTimestampMs(left) - eventTimestampMs(right));
  const completedByKey = new Map();
  let latestMeaningful = null;
  let latestRunning = null;

  for (const event of events) {
    const item = semanticMilestoneForEvent(event, options);
    if (!item) continue;
    latestMeaningful = item;
    if (item.status === 'running') {
      latestRunning = item;
      continue;
    }
    if (['succeeded', 'success', 'completed', 'complete'].includes(item.status)) completedByKey.set(item.key, item);
    if (item.status === 'failed' && ['failed', 'blocked', 'validation_failed'].includes(String(task.status || '').toLowerCase())) completedByKey.set(item.key, item);
  }

  const milestones = [...completedByKey.values()]
    .sort((left, right) => Number(left.at || 0) - Number(right.at || 0))
    .slice(-MAX_MILESTONES)
    .map(({ key: _key, ...item }) => item);
  const files = classifyTaskChangedFiles(task.changedFiles || []);
  const productChangedFileCount = Number.isFinite(Number(task.productChangedFileCount))
    ? Math.max(files.productChangedFileCount, Number(task.productChangedFileCount))
    : files.productChangedFileCount;
  const supportArtifactCount = Number.isFinite(Number(task.supportArtifactCount))
    ? Math.max(files.supportArtifactCount, Number(task.supportArtifactCount))
    : files.supportArtifactCount;
  const latest = latestRunning || latestMeaningful || milestones[milestones.length - 1] || null;
  const terminal = ['completed', 'failed', 'cancelled', 'expired'].includes(String(task.status || '').toLowerCase());
  const waiting = !terminal && Number(task.activeCalls || 0) === 0;
  const fallback = meaningfulFallback(task.currentActivity) || meaningfulFallback(task.currentStage) || meaningfulFallback(task.objective) || meaningfulFallback(task.title);
  const currentActivity = latest
    ? [latest.label, latest.detail].filter(Boolean).join(' · ')
    : fallback || (terminal ? 'Task ended.' : 'Task is open.');
  let currentStage = latest?.stage || (terminal ? 'Task ended' : 'Working on task');
  if (waiting && latest) currentStage = 'Latest meaningful progress';
  if (task.status === 'completed') currentStage = 'Completed';
  else if (['failed', 'validation_failed'].includes(String(task.status || '').toLowerCase())) currentStage = 'Needs attention';
  else if (task.status === 'blocked') currentStage = 'Blocked';

  return {
    currentStage,
    currentActivity,
    milestones,
    ...files,
    productChangedFileCount,
    supportArtifactCount
  };
}

export {
  buildTaskSemanticProgress,
  classifyTaskChangedFiles,
  semanticMilestoneForEvent
};
