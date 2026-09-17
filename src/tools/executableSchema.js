import { z } from 'zod';

const WORK_ID_SCHEMA = zodJsonSchema(
  z.string().min(1).max(200).describe('Opaque ID returned when a repository work session begins.')
);
const INDEPENDENT_SCHEMA = { type: 'boolean', description: 'Set true only for intentionally independent workspace/resource work, outside any unfinished task in this conversation. Cannot be combined with work_id.' };

function executableInputSchema(definition, catalogTool) {
  const actionScopes = (catalogTool?.actions || []).map(action => action.behavior?.taskScope || definition.behavior?.taskScope || 'required');
  const taskScope = actionScopes.length
    ? (actionScopes.every(scope => scope === 'required') ? 'required' : actionScopes.every(scope => scope === 'none') ? 'none' : 'optional')
    : (definition.behavior?.taskScope || 'required');
  const properties = { ...(definition.inputSchema?.properties || {}) };
  if (taskScope !== 'none') properties.work_id = WORK_ID_SCHEMA;
  if (taskScope === 'optional') properties.independent = INDEPENDENT_SCHEMA;
  const required = [...(definition.inputSchema?.required || [])];
  applyTaskScope(required, taskScope);
  const branches = Array.isArray(definition.inputSchema?.oneOf)
    ? definition.inputSchema.oneOf.map(branch => executableActionBranch(branch, catalogTool, taskScope))
    : undefined;
  return { ...definition.inputSchema, properties, required, ...(branches ? { oneOf: branches } : {}) };
}

function executableActionBranch(branch, catalogTool, fallbackTaskScope) {
  const action = String(branch?.properties?.action?.const || '');
  const taskScope = catalogTool?.actions?.find(item => item.action === action)?.behavior?.taskScope || fallbackTaskScope;
  if (taskScope === 'none') return branch;
  const properties = { ...(branch.properties || {}), work_id: WORK_ID_SCHEMA };
  if (taskScope === 'optional') properties.independent = INDEPENDENT_SCHEMA;
  const required = [...(branch.required || [])];
  applyTaskScope(required, taskScope);
  return { ...branch, properties, required };
}

function applyTaskScope(required, taskScope) {
  if (taskScope === 'required' || taskScope === 'optional') {
    const workspaceIndex = required.indexOf('workspace');
    if (workspaceIndex >= 0) required.splice(workspaceIndex, 1);
  }
  if (taskScope === 'required' && !required.includes('work_id')) required.push('work_id');
}

function zodJsonSchema(schema) {
  const { $schema: _schema, ...jsonSchema } = z.toJSONSchema(schema);
  return Object.freeze(jsonSchema);
}

export { executableInputSchema };
