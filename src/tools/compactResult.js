const REQUIRED_EMPTY_ARRAY_FIELDS = Object.freeze({
  'relai_process:list': new Set(['processes']),
  'relai_validate:diagnostics': new Set(['diagnostics'])
});

function pruneEmpty(value, preserveEmptyArrays = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => {
    if (item == null) return false;
    if (!Array.isArray(item) || item.length > 0) return true;
    return preserveEmptyArrays?.has(key) === true;
  }));
}

function slimCompactPublicResult(publicName, action, value) {
  if (!value || typeof value !== 'object') return value;
  if (publicName === 'relai_work' && action === 'begin') {
    const next = { ...value };
    if (next.workspaceBinding?.alias === next.workspace) delete next.workspaceBinding;
    return pruneEmpty(next);
  }
  if (publicName === 'relai_work' && action === 'status' && value.toolSurface) {
    return {
      ...value,
      toolSurface: pruneEmpty({
        schemaVersion: value.toolSurface.schemaVersion,
        toolSurfaceVersion: value.toolSurface.toolSurfaceVersion,
        profile: value.toolSurface.profile,
        toolCount: value.toolSurface.toolCount
      })
    };
  }
  const preserveEmptyArrays = REQUIRED_EMPTY_ARRAY_FIELDS[`${publicName}:${action || 'default'}`] || null;
  return pruneEmpty(value, preserveEmptyArrays);
}

export { slimCompactPublicResult };
