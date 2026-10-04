import { TOOL_SURFACE_VERSION, getCatalogTools } from './actionCatalog.js';
import { TOOL_SCHEMA_VERSION } from './schemaVersion.js';

const tools = getCatalogTools();

function getToolMetadata() {
  return tools.map(tool => {
    const { definition } = tool;
    const actions = actionMetadata(tool);
    return {
      name: definition.name,
      title: definition.title || definition.name,
      displayName: definition.name.replace(/^relai_/, '').replaceAll('_', ' '),
      description: definition.description || '',
      category: definition.dashboard?.category || 'Workspace tools',
      requiredProfile: definition.dashboard?.requiredProfile || 'workspace',
      requiresApproval: definition.dashboard?.requiresApproval === true,
      capabilities: [...(definition.dashboard?.capabilities || ['inspect'])],
      state: 'active',
      replacements: [],
      parameters: Object.keys(definition.inputSchema?.properties || {}),
      outputFields: Object.keys(definition.outputSchema?.properties || {}),
      longRunning: definition.behavior?.longRunning === true,
      taskScope: definition.behavior?.taskScope || 'required',
      executionClass: definition.behavior?.executionClass || 'bounded_synchronous',
      ...(actions.length ? { actions } : {})
    };
  });
}

function getToolSurfaceManifest() {
  const manifestTools = tools.map(tool => {
    const { definition } = tool;
    const actions = actionMetadata(tool);
    return {
      name: definition.name,
      state: 'active',
      outputFields: outputFields(tool),
      executionClass: definition.behavior?.executionClass || 'bounded_synchronous',
      ...(actions.length ? {
        executionClasses: [...new Set(actions.map(action => action.executionClass))],
        actions
      } : {})
    };
  });
  return {
    schemaVersion: TOOL_SCHEMA_VERSION,
    toolSurfaceVersion: TOOL_SURFACE_VERSION,
    toolCount: manifestTools.length,
    tools: manifestTools,
    deprecations: []
  };
}

function outputFields(tool) {
  const fields = new Set(Object.keys(tool?.definition?.outputSchema?.properties || {}));
  for (const action of tool?.actions || []) {
    for (const field of Object.keys(action?.outputSchema?.properties || {})) fields.add(field);
  }
  return [...fields].sort();
}

function actionMetadata(tool) {
  return tool.actions
    .filter(entry => entry.action !== 'default')
    .map(entry => ({
      action: entry.action,
      fields: [...entry.fields],
      required: [...entry.required],
      executionClass: entry.behavior?.executionClass || 'bounded_synchronous',
      taskScope: entry.behavior?.taskScope || 'required',
      concurrencyScope: entry.behavior?.concurrencyScope || 'task',
      annotations: entry.annotations || tool.definition.annotations || {}
    }));
}


function getToolGroups() {
  const definitions = tools.map(tool => tool.definition);
  const groups = { workspace: definitions.map(definition => definition.name), git: [], audit: [], cleanup: [] };
  for (const definition of definitions) {
    for (const group of definition.groups || []) {
      if (!groups[group]) groups[group] = [];
      groups[group].push(definition.name);
    }
  }
  return groups;
}

export { getToolGroups, getToolMetadata, getToolSurfaceManifest };
