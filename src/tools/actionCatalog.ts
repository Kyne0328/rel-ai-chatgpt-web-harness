import type { ApprovalRequirement } from '../contracts/authorization.ts';
import {
  getCatalogToolDefinition,
  getCatalogToolDefinitions,
  getOperationDefinition,
  getOperationDefinitions,
  getPublicActionContract
} from './actionDefinitions.ts';
import type { ActionMapping, ActionRegistry, CatalogToolDefinition, PublicActionContract } from './actionDefinitions.ts';
import { ACTION_REGISTRY as RAW_ACTION_REGISTRY } from './actionRegistry.js';

const TOOL_SURFACE_VERSION = 85;
const ACTION_REGISTRY = RAW_ACTION_REGISTRY as unknown as ActionRegistry;

type ToolActionCatalogEntry = Readonly<{
  publicTool: string;
  action: string;
  operationName: string;
  keepAction: boolean;
  title: string;
  description: string;
  fields: readonly string[];
  required: readonly string[];
  inputSchema: CatalogToolDefinition['inputSchema'];
  outputSchema: CatalogToolDefinition['outputSchema'];
  annotations: CatalogToolDefinition['annotations'];
  behavior: CatalogToolDefinition['behavior'];
  execution: CatalogToolDefinition['execution'] | undefined;
  dashboard: CatalogToolDefinition['dashboard'];
  groups: CatalogToolDefinition['groups'];
  capability: string;
  approval: ((args: Record<string, unknown>) => ApprovalRequirement) | null;
  handlerName: string;
}>;

type CatalogTool = Readonly<{
  definition: CatalogToolDefinition;
  actions: readonly ToolActionCatalogEntry[];
}>;

type ResolvedToolOperation = Readonly<{
  publicName: string;
  action: string;
  operationName: string;
  operationArgs: Record<string, unknown>;
  definition: CatalogToolDefinition | null;
  catalogEntry: ToolActionCatalogEntry;
  compact: true;
}>;

const TOOL_ACTION_CATALOG: readonly ToolActionCatalogEntry[] = Object.freeze(buildCatalog());
const ACTION_BY_KEY = new Map<string, ToolActionCatalogEntry>(
  TOOL_ACTION_CATALOG.map(entry => [catalogKey(entry.publicTool, entry.action), entry])
);
const TOOL_CATALOG: readonly CatalogTool[] = Object.freeze(getCatalogToolDefinitions().map(definition => Object.freeze({
  definition,
  actions: Object.freeze(TOOL_ACTION_CATALOG.filter(entry => entry.publicTool === definition.name))
})));

function buildCatalog(): ToolActionCatalogEntry[] {
  const entries: ToolActionCatalogEntry[] = [];
  for (const [publicTool, actions] of Object.entries(ACTION_REGISTRY)) {
    const publicDefinition = getCatalogToolDefinition(publicTool);
    if (!publicDefinition) throw new Error(`Catalog references unknown public tool '${publicTool}'.`);
    for (const [action, mapping] of Object.entries(actions)) {
      const operationMetadata = getOperationDefinition(mapping.operationName);
      if (!operationMetadata) {
        throw new Error(`Catalog action ${publicTool}:${action} references unknown operation '${mapping.operationName}'.`);
      }
      const contract = actionContract(publicDefinition, action);
      const capability = mapping.capability;
      if (!capability) throw new Error(`Catalog action ${publicTool}:${action} has no authorization capability.`);
      entries.push(Object.freeze({
        publicTool,
        action,
        operationName: mapping.operationName,
        keepAction: mapping.keepAction === true,
        title: operationMetadata.title,
        description: operationMetadata.description,
        fields: contract.fields,
        required: contract.required,
        inputSchema: operationMetadata.inputSchema,
        outputSchema: operationMetadata.outputSchema,
        annotations: operationMetadata.annotations,
        behavior: Object.freeze({ ...operationMetadata.behavior, ...(mapping.behavior || {}) }),
        execution: operationMetadata.execution,
        dashboard: operationMetadata.dashboard,
        groups: operationMetadata.groups,
        capability,
        approval: mapping.approval || null,
        handlerName: operationMetadata.handlerName
      }));
    }
  }
  return entries;
}

function actionContract(publicDefinition: CatalogToolDefinition, action: string): PublicActionContract {
  return getPublicActionContract(publicDefinition, action);
}

function catalogKey(publicTool: string, action: string): string {
  return `${publicTool}:${action || 'default'}`;
}

function getToolActionCatalog(): readonly ToolActionCatalogEntry[] {
  return TOOL_ACTION_CATALOG;
}

function getCatalogTools(): readonly CatalogTool[] {
  return TOOL_CATALOG;
}

function getCatalogAction(publicTool: string, args: Record<string, unknown> = {}): ToolActionCatalogEntry | null {
  const actions = ACTION_REGISTRY[String(publicTool || '')];
  if (!actions) return null;
  const action = Object.hasOwn(actions, 'default') ? 'default' : String(args.action || '').trim();
  const entry = ACTION_BY_KEY.get(catalogKey(publicTool, action));
  if (!entry) {
    const choices = Object.keys(actions).filter(value => value !== 'default');
    throw new Error(`Unsupported action '${action || '(missing)'}' for ${publicTool}. Supported actions: ${choices.join(', ')}.`);
  }
  return entry;
}

function resolveToolOperation(name: string, args: Record<string, unknown> = {}): ResolvedToolOperation | null {
  const publicName = String(name || '');
  const entry = getCatalogAction(publicName, args);
  if (!entry) return null;
  let operationArgs: Record<string, unknown> = { ...(args || {}) };
  if (!entry.keepAction) delete operationArgs.action;
  operationArgs = normalizeOperationArguments(publicName, entry.action, entry, operationArgs);
  return {
    publicName,
    action: entry.action === 'default' ? '' : entry.action,
    operationName: entry.operationName,
    operationArgs,
    definition: getOperationDefinition(entry.operationName),
    catalogEntry: entry,
    compact: true
  };
}

function normalizeOperationArguments(
  publicName: string,
  action: string,
  entry: ToolActionCatalogEntry,
  args: Record<string, unknown>
): Record<string, unknown> {
  const allowed = new Set([...(entry.fields || []), '_operationTaskId']);
  if (entry.keepAction) allowed.add('action');
  const unsupported = Object.keys(args).filter(field => !allowed.has(field));
  if (unsupported.length) {
    throw new Error(`Unsupported field '${unsupported[0]}' for ${publicName} action ${action}.`);
  }
  for (const field of entry.required || []) {
    const allowsEmptyValue = publicName === 'relai_computer' && action === 'set_value' && field === 'value';
    if (args[field] === undefined || args[field] === null || (!allowsEmptyValue && args[field] === '')) {
      throw new Error(`Missing required field '${field}' for ${publicName} action ${action}.`);
    }
  }
  return args;
}

function getOperationCapability(operationName: string): string {
  const name = String(operationName || '');
  const entries = TOOL_ACTION_CATALOG.filter(entry => entry.operationName === name);
  if (!entries.length) return '';
  const capabilities = new Set(entries.map(entry => entry.capability));
  if (capabilities.size !== 1) throw new Error(`Operation '${name}' has conflicting action capabilities.`);
  return entries[0]?.capability || '';
}

function catalogApprovalRequirement(publicTool: string, args: Record<string, unknown> = {}): ApprovalRequirement | null {
  const resolution = resolveToolOperation(publicTool, args);
  if (!resolution?.catalogEntry?.approval) return null;
  return resolution.catalogEntry.approval(resolution.operationArgs);
}

export {
  ACTION_REGISTRY,
  TOOL_SURFACE_VERSION,
  catalogApprovalRequirement,
  getCatalogAction,
  getCatalogToolDefinition,
  getCatalogToolDefinitions,
  getCatalogTools,
  getOperationCapability,
  getOperationDefinition,
  getOperationDefinitions,
  getToolActionCatalog,
  resolveToolOperation
};
export type { CatalogTool, ToolActionCatalogEntry };
