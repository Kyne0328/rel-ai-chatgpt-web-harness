import { matchingRelevanceTerms, relevanceTerms } from './relevance.js';

const CONCEPT_ALIASES = Object.freeze({
  visibility: ['blank', 'empty', 'invisible', 'missing', 'absent', 'nothing'],
  startup: ['startup', 'launch', 'initial', 'initially', 'boot', 'opening'],
  navigation: ['navigate', 'navigation', 'route', 'routing', 'switch', 'tab'],
  failure: ['fail', 'error', 'bug', 'broken', 'issue', 'problem'],
  latency: ['slow', 'lag', 'delay', 'hang', 'stuck', 'freeze'],
  timeout: ['timeout', 'deadline'],
  overflow: ['overflow', 'clip', 'cutoff', 'truncate'],
  crash: ['crash', 'terminate', 'fatal'],
  dependency: ['dependency', 'package', 'module', 'import'],
  bundle: ['bundle', 'bundling', 'compile', 'vite', 'chunk'],
  cancellation: ['cancel', 'abort'],
  concurrency: ['race', 'concurrent', 'parallel', 'queue', 'lock'],
  persistence: ['persist', 'storage', 'database', 'sqlite', 'restore', 'backup'],
  validation: ['validate', 'validation', 'test', 'check', 'ci']
});

const DIAGNOSTIC_CONCEPTS = new Set(['visibility', 'latency', 'timeout', 'overflow', 'crash']);
const GENERIC_TERMS = new Set(['app', 'application', 'dashboard', 'page', 'panel', 'screen', 'view']);
const CONCEPT_BY_TERM = buildConceptIndex();
const PATH_PATTERN = /(?:^|[\s'"`(])((?:\.?\.?[\\/])?[A-Za-z0-9_@.-]+(?:[\\/][A-Za-z0-9_@.-]+)+)/g;
const FILE_PATTERN = /\b[A-Za-z0-9_@.-]+\.(?:cjs|css|html|js|jsx|json|md|mjs|mts|scss|ts|tsx|yml|yaml)\b/gi;
const CODE_IDENTIFIER_PATTERN = /\b(?:[A-Z][A-Z0-9_]{3,}|[A-Za-z_$][A-Za-z0-9_$]*Error|[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$.]*)\b/g;

function taskEpisodeMatch(session = {}, query, options = {}) {
  const portable = options.portable === true;
  const querySignature = queryTaskSignature(query);
  if (!querySignature.terms.length && !querySignature.identifiers.length && !querySignature.paths.length) return null;
  const sessionSignature = sessionTaskSignature(session);

  const pathMatches = intersection(querySignature.paths, sessionSignature.paths);
  const pathScopeMatches = intersection(querySignature.pathScopes, sessionSignature.pathScopes);
  const identifierMatches = intersection(querySignature.identifiers, portable ? sessionSignature.primaryIdentifiers : sessionSignature.identifiers);
  const primaryMatches = matchingRelevanceTerms(querySignature.terms, sessionSignature.primaryText);
  const secondaryMatches = matchingRelevanceTerms(querySignature.terms, sessionSignature.secondaryText)
    .filter(term => !primaryMatches.includes(term));
  const primaryConcepts = intersection(querySignature.concepts, sessionSignature.primaryConcepts);
  const secondaryConcepts = intersection(querySignature.concepts, sessionSignature.secondaryConcepts)
    .filter(concept => !primaryConcepts.includes(concept));
  const diagnosticQueryConcepts = querySignature.concepts.filter(concept => DIAGNOSTIC_CONCEPTS.has(concept));
  const diagnosticMatches = intersection(diagnosticQueryConcepts, [...sessionSignature.primaryConcepts, ...sessionSignature.secondaryConcepts]);
  const exactIntent = containsIntent(querySignature.normalizedText, sessionSignature.normalizedPrimary)
    || (!portable && containsIntent(querySignature.normalizedText, sessionSignature.normalizedSecondary));
  const directEvidence = pathMatches.length > 0 || identifierMatches.length > 0 || exactIntent;
  const taskModeMismatch = querySignature.mode !== 'unknown'
    && sessionSignature.mode !== 'unknown'
    && querySignature.mode !== sessionSignature.mode;

  if (diagnosticQueryConcepts.length && !diagnosticMatches.length && !pathMatches.length && !pathScopeMatches.length && !identifierMatches.length && !exactIntent) return null;

  const meaningfulTerms = [...new Set([
    ...primaryMatches.filter(term => !GENERIC_TERMS.has(term)),
    ...(!portable ? secondaryMatches.filter(term => !GENERIC_TERMS.has(term)) : []),
    ...primaryConcepts,
    ...(!portable ? secondaryConcepts : [])
  ])];
  const scopedEvidence = pathScopeMatches.length > 0 && meaningfulTerms.length > 0;
  if (!pathMatches.length && !identifierMatches.length && !exactIntent && !scopedEvidence && meaningfulTerms.length < 2) return null;

  let score = 0;
  score += pathMatches.length * 14;
  score += pathScopeMatches.length * 5;
  score += identifierMatches.length * 12;
  score += exactIntent ? 9 : 0;
  score += weightedLexicalScore(primaryMatches, 3);
  score += weightedLexicalScore(secondaryMatches, 1.5);
  score += primaryConcepts.length * 3;
  score += secondaryConcepts.length * 1.5;
  score += diagnosticMatches.length * 2;
  if (taskModeMismatch && !directEvidence) score -= 2;

  if (portable && !pathMatches.length && !identifierMatches.length && !exactIntent && (meaningfulTerms.length < 3 || score < 8)) return null;
  if (!portable && score < 4.5) return null;

  const strongEvidence = directEvidence;
  const strength = strongEvidence || (scopedEvidence && score >= 9) || (score >= 9 && meaningfulTerms.length >= 3)
    ? 'strong'
    : score >= 5.5 ? 'medium' : 'weak';
  const confidence = Math.min(0.99, Math.max(0.35,
    (strongEvidence ? 0.72 : scopedEvidence ? 0.58 : 0.36)
      + Math.min(0.2, meaningfulTerms.length * 0.04)
      + Math.min(0.07, diagnosticMatches.length * 0.035)));
  const reasons = matchReasons({ pathMatches, pathScopeMatches, identifierMatches, exactIntent, primaryMatches, secondaryMatches, primaryConcepts, secondaryConcepts });
  return { score, confidence, strength, reasons };
}

function queryTaskSignature(query) {
  const text = compactSearchText(query);
  const paths = extractPaths(text);
  const concepts = conceptTerms(text);
  return {
    terms: relevanceTerms(text),
    concepts,
    mode: taskMode(text, concepts),
    identifiers: extractIdentifiers(text),
    paths,
    pathScopes: extractPathScopes(paths),
    normalizedText: normalizeIntentText(text)
  };
}

function sessionTaskSignature(session = {}) {
  const primaryText = compactSearchText([session.objective, session.title].filter(Boolean).join(' '));
  const eventText = (Array.isArray(session.events) ? session.events.slice(-24) : [])
    .map(eventSearchText)
    .filter(Boolean)
    .join(' ');
  const evidenceText = (Array.isArray(session.workflowEvidence) ? session.workflowEvidence.slice(-16) : [])
    .map(evidenceSearchText)
    .filter(Boolean)
    .join(' ');
  const secondaryText = compactSearchText([
    session.resultSummary,
    session.summary,
    session.contextSummary,
    session.errorSummary,
    eventText,
    evidenceText
  ].filter(Boolean).join(' '));
  const paths = unique([
    ...extractPaths(primaryText),
    ...extractPaths(secondaryText),
    ...normalizePaths(session.changedFiles),
    ...(Array.isArray(session.events) ? session.events.slice(-24).flatMap(eventPaths) : []),
    ...(Array.isArray(session.workflowEvidence) ? session.workflowEvidence.slice(-16).flatMap(evidencePaths) : [])
  ]);
  const identifierText = `${primaryText} ${secondaryText} ${paths.join(' ')}`;
  const primaryConcepts = conceptTerms(primaryText);
  const secondaryConcepts = conceptTerms(secondaryText);
  return {
    primaryText,
    secondaryText,
    primaryConcepts,
    secondaryConcepts,
    mode: taskMode(primaryText, primaryConcepts),
    primaryIdentifiers: extractIdentifiers(primaryText),
    identifiers: extractIdentifiers(identifierText),
    paths,
    pathScopes: extractPathScopes(paths),
    normalizedPrimary: normalizeIntentText(primaryText),
    normalizedSecondary: normalizeIntentText(secondaryText)
  };
}

function weightedLexicalScore(matches, weight) {
  return matches.reduce((total, term) => total + weight * (GENERIC_TERMS.has(term) ? 0.35 : 1), 0);
}

function conceptTerms(value) {
  const text = String(value || '').toLowerCase();
  const termText = text.replace(/\bempty[-\s]+state\b/g, 'state');
  const terms = relevanceTerms(termText);
  const concepts = new Set();
  for (const term of terms) {
    const concept = CONCEPT_BY_TERM.get(term);
    if (concept) concepts.add(concept);
  }
  if (/\bblack\s+(?:screen|page|dashboard|panel|view)\b/.test(text)
    || /\bno\s+(?:data|content|results?|items?)\b/.test(text)
    || /\b(?:fail(?:s|ed|ing)?|unable)\b.{0,32}\b(?:render|mount|paint|show|display|appear|populate)\w*\b/.test(text)
    || /\b(?:render|mount|paint|show|display|appear|populate)\w*\b.{0,24}\b(?:fail(?:s|ed|ing|ure)?|error|broken)\b/.test(text)
    || /\b(?:does\s+not|doesn't|never)\b.{0,24}\b(?:render|show|display|appear|populate)\w*\b/.test(text)) {
    concepts.add('visibility');
  }
  if (/\b(?:initial|first)\s+(?:load|render|mount|open)\b/.test(text)) concepts.add('startup');
  return [...concepts];
}

function taskMode(value, concepts = conceptTerms(value)) {
  const text = String(value || '').toLowerCase();
  if (concepts.some(concept => DIAGNOSTIC_CONCEPTS.has(concept))
    || /\b(?:fix|repair|recover|fail(?:s|ed|ing|ure)?|error|bug|broken|issue|problem)\b/.test(text)) return 'problem';
  if (/\b(?:add|change|rename|move|update|improve|optimize|refactor|remove|replace|redesign|restyle|style|reword|relabel|reorder|reduce|increase|decrease|enable|disable|introduce|create)\b/.test(text)) return 'change';
  return 'unknown';
}

function buildConceptIndex() {
  const index = new Map();
  for (const [concept, aliases] of Object.entries(CONCEPT_ALIASES)) {
    for (const alias of aliases) {
      const normalized = relevanceTerms(alias)[0] || String(alias).toLowerCase();
      index.set(normalized, concept);
    }
  }
  return index;
}

function extractPaths(value) {
  const text = String(value || '');
  const paths = [];
  for (const match of text.matchAll(PATH_PATTERN)) paths.push(normalizePath(match[1]));
  for (const match of text.matchAll(FILE_PATTERN)) paths.push(normalizePath(match[0]));
  return unique(paths.filter(Boolean));
}

function extractIdentifiers(value) {
  const text = String(value || '');
  const identifiers = [];
  for (const match of text.matchAll(CODE_IDENTIFIER_PATTERN)) identifiers.push(String(match[0]).toLowerCase());
  return unique(identifiers);
}

function eventSearchText(event = {}) {
  return compactSearchText([
    event.title,
    event.summary,
    event.error?.code,
    event.error?.message,
    event.metadata?.errorCode,
    event.metadata?.failedCheck,
    event.command
  ].filter(Boolean).join(' '));
}

function evidenceSearchText(item = {}) {
  return compactSearchText([
    item.kind,
    item.outcome,
    item.commandId,
    item.check,
    ...(Array.isArray(item.paths) ? item.paths : [])
  ].filter(Boolean).join(' '));
}

function eventPaths(event = {}) {
  return normalizePaths([
    event.target?.workspaceRelativePath,
    ...(Array.isArray(event.metadata?.changedFiles) ? event.metadata.changedFiles : [])
  ]);
}

function evidencePaths(item = {}) {
  return normalizePaths(Array.isArray(item.paths) ? item.paths : []);
}

function normalizePaths(values) {
  return unique((Array.isArray(values) ? values : []).map(normalizePath).filter(Boolean));
}

function extractPathScopes(paths) {
  return unique((Array.isArray(paths) ? paths : []).flatMap(value => {
    const normalized = normalizePath(value);
    const separator = normalized.lastIndexOf('/');
    if (separator <= 0) return [];
    const parent = normalized.slice(0, separator);
    return parent.includes('/') ? [parent] : [];
  }));
}

function normalizePath(value) {
  return String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
}

function normalizeIntentText(value) {
  return relevanceTerms(value).join(' ');
}

function containsIntent(left, right) {
  if (!left || !right) return false;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter.length < 12) return false;
  const shorterTerms = shorter.split(' ').filter(Boolean);
  if (shorterTerms.length < 2) return false;
  return longer.includes(shorter);
}

function matchReasons({ pathMatches, pathScopeMatches, identifierMatches, exactIntent, primaryMatches, secondaryMatches, primaryConcepts, secondaryConcepts }) {
  const reasons = [];
  if (pathMatches.length) reasons.push(compactReason(`same path: ${pathMatches.slice(0, 2).join(', ')}`));
  else if (pathScopeMatches.length) reasons.push(compactReason(`same area: ${pathScopeMatches.slice(0, 2).join(', ')}`));
  if (identifierMatches.length) reasons.push(compactReason(`same identifier: ${identifierMatches.slice(0, 2).join(', ')}`));
  if (exactIntent) reasons.push('same normalized intent');
  const shared = unique([
    ...primaryMatches,
    ...secondaryMatches,
    ...primaryConcepts,
    ...secondaryConcepts
  ]).filter(term => !GENERIC_TERMS.has(term)).slice(0, 4);
  if (shared.length) reasons.push(compactReason(`shared intent: ${shared.join(', ')}`));
  return reasons.slice(0, 3);
}

function compactReason(value) {
  const text = String(value || '').trim();
  return text.length > 180 ? `${text.slice(0, 179).trimEnd()}…` : text;
}

function intersection(left, right) {
  const rightSet = new Set(right);
  return unique(left.filter(value => rightSet.has(value)));
}

function unique(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function compactSearchText(value) {
  return String(value || '').replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 12_000);
}

export { queryTaskSignature, taskEpisodeMatch };
