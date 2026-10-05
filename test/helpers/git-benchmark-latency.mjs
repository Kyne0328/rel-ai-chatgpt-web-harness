// Pure arithmetic shared by the benchmark and its injected-regression tests.
function buildGitBenchmarkLatencyBudgets(metrics, wrapperOverheadMs = 150) {
  const required = ['cleanRawMs', 'cleanV2Ms', 'dirtyRawMs', 'dirtyV2Ms', 'rawSpawnMs', 'readOnlyMs', 'mutatingMs'];
  for (const key of required) {
    if (!Number.isFinite(metrics[key]) || metrics[key] < 0) throw new Error('Invalid benchmark timing: ' + key);
  }
  if (!Number.isFinite(wrapperOverheadMs) || wrapperOverheadMs < 0) throw new Error('Invalid wrapper overhead budget.');
  const round = value => Math.round(value * 10) / 10;
  const budget = (label, measuredMs, componentBaselineMs, overheadBudgetMs, components) => {
    const maximumMs = componentBaselineMs + overheadBudgetMs;
    return {
      label, measuredMs: round(measuredMs), componentBaselineMs: round(componentBaselineMs),
      overheadMs: round(measuredMs - componentBaselineMs), overheadBudgetMs: round(overheadBudgetMs),
      maximumMs: round(maximumMs), passed: measuredMs <= maximumMs, components
    };
  };
  return [
    budget('clean v2 status', metrics.cleanV2Ms, metrics.cleanRawMs, metrics.cleanRawMs + 75,
      { rawStatusMs: metrics.cleanRawMs, multiplier: 2, allowanceMs: 75 }),
    budget('dirty v2 status', metrics.dirtyV2Ms, metrics.dirtyRawMs, metrics.dirtyRawMs + 75,
      { rawStatusMs: metrics.dirtyRawMs, multiplier: 2, allowanceMs: 75 }),
    budget('read-only wrapper', metrics.readOnlyMs, metrics.rawSpawnMs, wrapperOverheadMs,
      { rawSpawnMs: metrics.rawSpawnMs, statusReads: 0 }),
    budget('mutating wrapper', metrics.mutatingMs, metrics.rawSpawnMs + 2 * metrics.dirtyRawMs, wrapperOverheadMs,
      { rawSpawnMs: metrics.rawSpawnMs, dirtyRawStatusMs: metrics.dirtyRawMs, statusReads: 2 })
  ];
}

export { buildGitBenchmarkLatencyBudgets };
