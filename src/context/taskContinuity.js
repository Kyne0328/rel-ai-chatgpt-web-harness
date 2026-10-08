import { knowledgeSettings } from '../knowledgeStore.js';
import { readConversationContinuity, readCrossWorkspaceTaskEpisodes } from '../taskHistoryStore.ts';
import { matchingRelevanceTerms, relevanceTerms } from './relevance.js';

const SOURCE_PRIORITY = Object.freeze({
  suggestedSkills: 6,
  conversationContinuity: 4.5,
  relatedTasks: 4,
  crossWorkspaceTasks: 2
});

function buildTaskContinuity(config, options = {}) {
  const settings = knowledgeSettings(config);
  const query = String(options.query || '').trim();
  if (!query) return {};
  const workspace = String(options.workspace || '').trim();
  const excludeTaskId = String(options.excludeTaskId || '').trim();
  const conversationId = String(options.conversationId || '').trim();
  const authority = {
    principalFingerprint: String(options.principalFingerprint || ''),
    authorizedWorkspaces: Array.isArray(options.authorizedWorkspaces) ? options.authorizedWorkspaces : []
  };
  return rankBootstrapGroups(query, {
    conversationContinuity: conversationId ? safeList(() => readConversationContinuity(config, conversationId, { ...authority, excludeTaskId, limit: 4 })) : [],
    crossWorkspaceTasks: safeList(() => readCrossWorkspaceTaskEpisodes(config, workspace, query, { ...authority, excludeTaskId, limit: 3 }))
  }, settings.maxBootstrapBytes);
}

function rankBootstrapGroups(query, groups = {}, maxBytes = 4096) {
  const queryTerms = relevanceTerms(query);
  const candidates = [];
  let sourceIndex = 0;
  for (const [source, values] of Object.entries(groups)) {
    for (const [itemIndex, value] of (Array.isArray(values) ? values : []).entries()) {
      if (!value) continue;
      const serialized = JSON.stringify(value);
      const bytes = Buffer.byteLength(serialized, 'utf8') + 8;
      const matches = matchingRelevanceTerms(queryTerms, serialized).length;
      const sourcePriority = Number(SOURCE_PRIORITY[source] || 3);
      const confidence = Number(value?.confidence);
      const confidenceBoost = Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0;
      const reservedTaskMatch = source === 'relatedTasks' && (value?.matchStrength === 'strong' || confidenceBoost >= 0.8);
      candidates.push({
        source,
        value,
        bytes,
        reservedTaskMatch,
        score: sourcePriority + matches * 0.8 + confidenceBoost * 0.5 - Math.min(0.75, bytes / 8192),
        sourceIndex: sourceIndex++,
        itemIndex
      });
    }
  }
  candidates.sort((left, right) => Number(right.reservedTaskMatch) - Number(left.reservedTaskMatch)
    || right.score - left.score
    || left.sourceIndex - right.sourceIndex
    || left.itemIndex - right.itemIndex);

  const result = {};
  for (const candidate of candidates) {
    const next = { ...result, [candidate.source]: [...(result[candidate.source] || []), candidate.value] };
    if (Buffer.byteLength(JSON.stringify(next), 'utf8') > maxBytes) continue;
    result[candidate.source] = next[candidate.source];
  }
  return result;
}

function safeList(read) {
  try {
    const value = read();
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (process.env.REL_AI_MCP_DEBUG) console.error('[rel-ai-mcp] task continuity:', error);
    return [];
  }
}

export { buildTaskContinuity, rankBootstrapGroups };
