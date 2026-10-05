import { toolArgumentError } from './validationGuidance.js';
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

const TOOL_SURFACE_VERSION = 89;
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
  const action = inferCatalogAction(publicTool, args, actions);
  const entry = ACTION_BY_KEY.get(catalogKey(publicTool, action));
  if (!entry) {
    const choices = Object.keys(actions).filter(value => value !== 'default');
    throw toolArgumentError({ publicTool, action, message: `Unsupported action '${action || '(missing)'}' for ${publicTool}. Supported actions: ${choices.join(', ')}. Supply action explicitly when inference is ambiguous.`, issues: [{ field: 'action', message: `Supported actions: ${choices.join(', ')}. Supply action explicitly when inference is ambiguous.` }] });
  }
  return entry;
}

function inferCatalogAction(publicTool: string, args: Record<string, unknown>, actions: Record<string, unknown>): string {
  const explicit = String(args.action || '').trim();
  if (explicit) return explicit;
  if (Object.hasOwn(actions, 'default')) return 'default';

  switch (publicTool) {
    case 'relai_search':
      if (nonEmptyArg(args, 'pattern')) return 'text';
      if (nonEmptyArg(args, 'query')) return 'semantic';
      return '';
    case 'relai_validate':
      if (nonEmptyArg(args, 'route')) return 'http';
      if (nonEmptyArg(args, 'command') || Array.isArray(args.commands) || Object.hasOwn(args, 'maxResults')) return 'diagnostics';
      return 'checks';
    case 'relai_changes':
      if (nonEmptyArg(args, 'checkpointId')) return 'replay';
      if (Array.isArray(args.paths)) return 'restore';
      if (nonEmptyArg(args, 'planId')) return 'tidy_run';
      if (Object.hasOwn(args, 'maxCandidates') || Object.hasOwn(args, 'mode')) return 'tidy_plan';
      if (Object.hasOwn(args, 'removeUntracked')) return 'reset';
      return 'diff';
    case 'relai_process':
      if (['kind', 'purpose', 'command', 'executable', 'argv', 'reuseExisting', 'pty', 'startupWaitMs', 'maxLogBytes']
        .some(key => Object.hasOwn(args, key))) return 'start';
      if (nonEmptyArg(args, 'processId')) {
        if (['input', 'columns', 'rows'].some(key => Object.hasOwn(args, key))) return 'write';
        if (Object.hasOwn(args, 'graceMs')) return 'stop';
        return 'read';
      }
      return 'list';
    case 'relai_publish':
      if (['title', 'body', 'base', 'head'].some(key => Object.hasOwn(args, key))) return 'draft_pr';
      if (['message', 'addAll', 'paths', 'sensitiveAuthorization'].some(key => Object.hasOwn(args, key))) return 'commit';
      if (['remote', 'branch', 'setUpstream'].some(key => Object.hasOwn(args, key))) return 'push';
      return '';
    default:
      return '';
  }
}

function normalizePublicToolArguments(name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  const entry = getCatalogAction(name, args);
  if (!entry) return args;
  // Resolve once before schema validation so discovery and every transport use
  // exactly the same inference and action-specific field grammar as execution.
  resolveToolOperation(name, args);
  return !String(args.action || '').trim() && entry.action !== 'default' ? { ...args, action: entry.action } : args;
}

function nonEmptyArg(args: Record<string, unknown>, key: string): boolean {
  if (!Object.hasOwn(args, key)) return false;
  const value = args[key];
  return value != null && String(value).trim() !== '';
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
  const allowed = new Set(entry.fields || []);
  if (entry.keepAction) allowed.add('action');
  const unsupported = Object.keys(args).filter(field => !allowed.has(field));
  if (unsupported.length) {
    throw toolArgumentError({ publicTool: publicName, action, fields: entry.fields, required: entry.required, schema: entry.inputSchema, issues: unsupported.map(field => ({ field, message: `Field is not supported by action ${action}.` })), message: `Unsupported field '${unsupported[0]}' for ${publicName} action ${action}.` });
  }
  for (const field of entry.required || []) {
    const allowsEmptyValue = publicName === 'relai_computer' && action === 'set_value' && field === 'value';
    if (args[field] === undefined || args[field] === null || (!allowsEmptyValue && args[field] === '')) {
      throw toolArgumentError({ publicTool: publicName, action, fields: entry.fields, required: entry.required, schema: entry.inputSchema, issues: [{ field, message: 'Required field is missing.' }], message: `Missing required field '${field}' for ${publicName} action ${action}.` });
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
  resolveToolOperation,
  normalizePublicToolArguments
};
export type { CatalogTool, ToolActionCatalogEntry };
