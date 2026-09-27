const AUTO_CONTEXT_TIERS = {
  focused: {
    contextBefore: 3,
    contextAfter: 5,
    maxFiles: 20,
    maxRangesPerFile: 20,
    maxRangeLines: 80,
    maxBytes: 16 * 1024
  },
  moderate: {
    contextBefore: 3,
    contextAfter: 5,
    maxFiles: 10,
    maxRangesPerFile: 8,
    maxRangeLines: 80,
    maxBytes: 16 * 1024
  },
  broad: {
    contextBefore: 2,
    contextAfter: 4,
    maxFiles: 5,
    maxRangesPerFile: 4,
    maxRangeLines: 60,
    maxBytes: 12 * 1024
  }
};

const CONTEXT_OPTION_KEYS = [
  "contextBefore",
  "contextAfter",
  "groupByFile",
  "mergeOverlaps",
  "maxFiles",
  "maxRangesPerFile",
  "maxRangeLines",
  "maxBytes"
];

function resolveSearchPlan(args = {}, result = {}) {
  const mode = requestedSearchMode(args);
  if (mode === "compact") return { requestedMode: mode, effectiveMode: "compact" };
  if (mode === "context") return { requestedMode: mode, effectiveMode: "context", contextArgs: args };

  const matchCount = resolvedMatchCount(result);
  if (matchCount === 0) {
    return { requestedMode: "auto", effectiveMode: "compact", autoTier: "empty" };
  }
  const autoTier = autoTierForMatchCount(matchCount);
  return {
    requestedMode: "auto",
    effectiveMode: "context",
    autoTier,
    selectionStrategy: "path-and-match-density",
    contextArgs: {
      ...AUTO_CONTEXT_TIERS[autoTier],
      ...args,
      mode: "auto"
    }
  };
}

function resolvedMatchCount(result) {
  if (Number.isInteger(result.matchCount)) return result.matchCount;
  return Array.isArray(result.matches) ? result.matches.length : 0;
}

function autoTierForMatchCount(matchCount) {
  if (matchCount <= 20) return "focused";
  if (matchCount <= 100) return "moderate";
  return "broad";
}

function requestedSearchMode(args = {}) {
  const explicitMode = args.mode != null && String(args.mode).trim() !== "";
  if (explicitMode) return normalizeMode(args.mode);
  if (CONTEXT_OPTION_KEYS.some((key) => Object.hasOwn(args, key))) return "context";
  return "auto";
}

function normalizeMode(value) {
  const mode = String(value || "auto").trim().toLowerCase();
  if (!new Set(["auto", "compact", "context"]).has(mode)) {
    throw new Error("relai_search mode must be one of: auto, compact, context.");
  }
  return mode;
}

function rankMatchGroups(groups, pattern, workflowContext = {}) {
  const tokens = pathSearchTokens(pattern);
  const combinedToken = tokens.join("");
  return groups
    .map((group, index) => ({
      group,
      index,
      score: matchGroupScore(group, tokens, combinedToken) + workflowPathBoost(group.path, workflowContext)
    }))
    .sort((left, right) => right.score - left.score
      || right.group.matches.length - left.group.matches.length
      || left.index - right.index)
    .map((entry) => entry.group);
}

function workflowPathBoost(filePath, context = {}) {
  const target = normalizePath(filePath);
  if (!target) return 0;
  const taskOwned = new Set((context.taskOwnedPaths || []).map(normalizePath));
  const impacted = new Set((context.impactedPaths || []).map(normalizePath));
  const packagePaths = (context.packagePaths || []).map(normalizePath).filter(Boolean);
  const graphScore = Number(context.graphPathScores?.[target] || 0);
  let boost = Number.isFinite(graphScore) ? Math.max(0, Math.min(160, graphScore)) : 0;
  if (taskOwned.has(target)) boost += 180;
  if (impacted.has(target)) boost += 110;
  if (packagePaths.some(packagePath => target === packagePath || target.startsWith(`${packagePath}/`))) boost += 50;
  return boost;
}

function normalizePath(value) {
  return String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
}
function pathSearchTokens(pattern) {
  const expanded = String(pattern || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return [...new Set(expanded.match(/[a-z0-9]+/g) || [])].filter((token) => token.length >= 2);
}

function matchGroupScore(group, tokens, combinedToken) {
  const pathText = String(group.path || "").toLowerCase();
  const normalizedPath = pathText.replace(/[^a-z0-9]+/g, "");
  const exactPathBoost = combinedToken && normalizedPath.includes(combinedToken) ? 1000 : 0;
  const tokenHits = tokens.filter((token) => pathText.includes(token)).length;
  const matchDensity = Math.min(group.matches.length, 20) * 10;
  const pathDepth = pathText.split("/").length - 1;
  return exactPathBoost + tokenHits * 100 + matchDensity - pathDepth;
}

export { rankMatchGroups, resolveSearchPlan };
