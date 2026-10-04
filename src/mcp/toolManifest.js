import * as crypto from 'node:crypto';
import { stableJson } from '../stableJson.js';
import { getPublicToolSchemas, getToolDefinitions, getToolSurfaceManifest } from '../tools/schema.js';
import { TOOL_SCHEMA_VERSION } from '../tools/schemaVersion.js';
import { PUBLIC_MCP_SERVER_INSTRUCTIONS } from './serverInstructions.js';

let cachedToolManifest = null;

function buildToolManifest(config = {}) {
  if (cachedToolManifest) return cachedToolManifest;
  const surface = getToolSurfaceManifest(config);
  const surfaceByName = new Map(surface.tools.map(tool => [tool.name, tool]));
  const definitionByName = new Map(getToolDefinitions().map(definition => [definition.name, definition]));
  const tools = getPublicToolSchemas(config)
    .map(tool => canonicalTool(tool, definitionByName.get(tool.name), surfaceByName.get(tool.name)))
    .sort((left, right) => left.name.localeCompare(right.name));
  const canonical = {
    schemaVersion: TOOL_SCHEMA_VERSION,
    toolSurfaceVersion: Number(surface.toolSurfaceVersion || 0),
    instructions: PUBLIC_MCP_SERVER_INSTRUCTIONS,
    tools
  };
  const hash = crypto.createHash('sha256').update(stableJson(canonical)).digest('base64url');
  cachedToolManifest = Object.freeze({
    ...canonical,
    hash,
    version: hash.slice(0, 24),
    activeToolCount: tools.length,
    disabledToolCount: 0,
    filteredToolCount: 0,
    externallyVisibleToolCount: tools.length
  });
  return cachedToolManifest;
}

function canonicalTool(tool, definition, surfaceTool) {
  return {
    name: String(tool?.name || ''),
    title: String(tool?.title || ''),
    description: String(tool?.description || ''),
    inputSchema: canonicalValue(tool?.inputSchema || {}),
    outputSchema: canonicalValue(tool?.outputSchema || definition?.outputSchema || {}),
    annotations: canonicalValue(tool?.annotations || {}),
    execution: canonicalValue(executionMetadata(surfaceTool)),
    behavior: canonicalValue(definition?.behavior || {})
  };
}

function executionMetadata(surfaceTool) {
  return {
    executionClass: String(surfaceTool?.executionClass || 'bounded_synchronous'),
    ...(Array.isArray(surfaceTool?.executionClasses) ? { executionClasses: [...surfaceTool.executionClasses] } : {}),
    ...(Array.isArray(surfaceTool?.actions) ? { actions: canonicalValue(surfaceTool.actions) } : {})
  };
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) result[key] = canonicalValue(value[key]);
  }
  return result;
}

export { buildToolManifest };
