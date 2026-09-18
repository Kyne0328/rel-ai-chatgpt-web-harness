import type { ApprovalRequirement } from '../contracts/authorization.ts';
import type { JsonSchema, ToolDefinitionMetadata, ToolGroup } from '../../types/boundaries.d.ts';
import { publicEditInputSchema, publicExecInputSchema, publicProcessInputSchema } from './publicOperationSchemas.js';
import { ACTION_REGISTRY as RAW_ACTION_REGISTRY, OPERATION_REGISTRY as RAW_OPERATION_REGISTRY } from './actionRegistry.js';
import { MAX_BATCH_EDITS } from '../editLimits.js';
import { outputSchemaFor } from './outputSchemas.js';
import { OPERATION_IDS as OP } from './operationIds.js';
import { CONCURRENCY_SCOPE, EXECUTION_CLASS, TASK_SCOPE } from './contracts.ts';

type ToolAnnotations = ToolDefinitionMetadata['annotations'];
type ToolBehavior = ToolDefinitionMetadata['behavior'];
type ToolDashboardMetadata = ToolDefinitionMetadata['dashboard'];
type ToolExecution = NonNullable<ToolDefinitionMetadata['execution']>;
type ObjectJsonSchema = ToolDefinitionMetadata['inputSchema'];

type CatalogToolDefinition = Readonly<
  Omit<ToolDefinitionMetadata, 'annotations' | 'connectorStrip' | 'groups' | 'behavior' | 'dashboard' | 'execution'> & {
    annotations: Readonly<ToolAnnotations>;
    connectorStrip: readonly string[];
    groups: readonly ToolGroup[];
    behavior: Readonly<ToolBehavior>;
    dashboard: Readonly<ToolDashboardMetadata>;
    execution?: Readonly<ToolExecution>;
  }
>;

type ToolDefinitionInput = Omit<
  ToolDefinitionMetadata,
  'annotations' | 'connectorStrip' | 'groups' | 'behavior' | 'dashboard' | 'outputSchema'
> & {
  annotations?: Partial<ToolAnnotations>;
  connectorStrip?: readonly string[];
  groups?: readonly ToolGroup[];
  behavior?: Partial<ToolBehavior>;
  dashboard?: Partial<ToolDashboardMetadata>;
  outputSchema?: JsonSchema;
};

type PublicActionContractInput = Readonly<{
  required?: readonly string[];
  omit?: readonly string[];
  extra?: Readonly<Record<string, unknown>>;
}>;

type ActionMapping = Readonly<{
  operationName: string;
  keepAction?: boolean;
  capability?: string;
  approval?: ((args: Record<string, unknown>) => ApprovalRequirement) | null;
  behavior?: Partial<ToolBehavior> | null;
  publicContract?: PublicActionContractInput | null;
}>;

type ActionRegistry = Readonly<Record<string, Readonly<Record<string, ActionMapping>>>>;
type OperationRegistryRecord = Readonly<{ definition: ToolDefinitionInput }>;

type PublicToolValue = Readonly<{
  name: string;
  title: string;
  description: string;
  annotations?: Readonly<ToolAnnotations>;
  connectorStrip?: readonly string[];
  groups?: readonly ToolGroup[];
  behavior?: Partial<ToolBehavior>;
  dashboard?: Partial<ToolDashboardMetadata>;
}>;

type PublicActionContract = Readonly<{
  fields: readonly string[];
  required: readonly string[];
}>;

const ACTION_REGISTRY = RAW_ACTION_REGISTRY as unknown as ActionRegistry;
const OPERATION_REGISTRY = RAW_OPERATION_REGISTRY as unknown as readonly OperationRegistryRecord[];

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  OP.WORK_CONTEXT, OP.SNAPSHOT, OP.READ, OP.SEARCH_TEXT, OP.INSPECT, OP.SEARCH_SEMANTIC,
  OP.PROCESS_READ, OP.PROCESS_LIST, OP.CHANGES_TIDY_PLAN, OP.VALIDATE_HTTP, OP.CHANGES_DIFF, OP.CHANGES_REPLAY,
  OP.WORK_STATUS, OP.PUBLISH_DRAFT_PR
]);
const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  OP.EXEC, OP.PROCESS_START, OP.PROCESS_WRITE, OP.PROCESS_STOP, OP.UI, OP.BROWSER, OP.DESKTOP, OP.COMPUTER,
  OP.VALIDATE_DIAGNOSTICS, OP.CHANGES_TIDY_RUN, OP.VALIDATE_CHECKS, OP.CHANGES_RESTORE,
  OP.CHANGES_RESET, OP.EDIT
]);
const IDEMPOTENT_TOOLS: ReadonlySet<string> = new Set([
  ...READ_ONLY_TOOLS, OP.PROCESS_STOP, OP.CHANGES_RESTORE, OP.CHANGES_RESET,
  OP.WORK_PLAN, OP.WORK_CANCEL, OP.WORK_FINISH
]);
const OPEN_WORLD_TOOLS: ReadonlySet<string> = new Set([
  OP.EXEC, OP.PROCESS_START, OP.PROCESS_WRITE, OP.UI, OP.BROWSER, OP.DESKTOP, OP.COMPUTER,
  OP.VALIDATE_DIAGNOSTICS, OP.VALIDATE_CHECKS, OP.PUBLISH_PUSH
]);
// These operations use Native MCP Tasks when the connected client explicitly negotiates
// the Tasks capability. Clients without it keep the same public operations, but long work
// can continue under work_id after the tool response returns; no legacy operation names are retained.
const NATIVE_TASK_ELIGIBLE_TOOLS: ReadonlySet<string> = new Set([
  OP.WORK_CONTEXT,
  OP.SEARCH_SEMANTIC,
  OP.INSPECT,
  OP.EDIT,
  OP.EXEC,
  OP.VALIDATE_DIAGNOSTICS,
  OP.VALIDATE_CHECKS,
  OP.VALIDATE_HTTP
]);
const PERSISTENT_PROCESS_TOOLS: ReadonlySet<string> = new Set([
  OP.PROCESS_START, OP.PROCESS_READ, OP.PROCESS_WRITE, OP.PROCESS_STOP, OP.PROCESS_LIST
]);
const ALWAYS_IMMEDIATE_TOOLS: ReadonlySet<string> = new Set([
  OP.WORK_BEGIN, OP.WORK_PLAN, OP.SNAPSHOT, OP.READ, OP.SEARCH_TEXT,
  OP.WORK_STATUS, OP.WORK_CANCEL, OP.WORK_FINISH
]);

const DEFAULT_BEHAVIOR: Readonly<ToolBehavior> = Object.freeze({
  audit: '', cache: '', startsSession: false, deferStagedSession: false, sessionWrite: false,
  summary: '', longRunning: false, taskScope: TASK_SCOPE.REQUIRED, concurrencyScope: CONCURRENCY_SCOPE.TASK, executionClass: EXECUTION_CLASS.BOUNDED_SYNCHRONOUS
});
const DEFAULT_DASHBOARD: Readonly<ToolDashboardMetadata> = Object.freeze({
  category: 'Workspace tools', requiredProfile: 'workspace', requiresApproval: false
});
const RESULT_SCHEMA: Readonly<JsonSchema> = Object.freeze({
  type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: true
});

function annotationsFor(name: string): ToolAnnotations {
  return {
    readOnlyHint: READ_ONLY_TOOLS.has(name),
    destructiveHint: DESTRUCTIVE_TOOLS.has(name),
    idempotentHint: IDEMPOTENT_TOOLS.has(name),
    openWorldHint: OPEN_WORLD_TOOLS.has(name)
  };
}

function executionClassFor(name: string): ToolBehavior['executionClass'] {
  if (NATIVE_TASK_ELIGIBLE_TOOLS.has(name)) return EXECUTION_CLASS.NATIVE_TASK_ELIGIBLE;
  if (PERSISTENT_PROCESS_TOOLS.has(name)) return EXECUTION_CLASS.PERSISTENT_PROCESS;
  if (ALWAYS_IMMEDIATE_TOOLS.has(name)) return EXECUTION_CLASS.ALWAYS_IMMEDIATE;
  return EXECUTION_CLASS.BOUNDED_SYNCHRONOUS;
}

function defineTool(definition: ToolDefinitionInput): CatalogToolDefinition {
  return Object.freeze({
    ...definition,
    connectorStrip: [...(definition.connectorStrip || [])],
    groups: [...(definition.groups || [])],
    annotations: Object.freeze(annotationsFor(definition.name)),
    ...(NATIVE_TASK_ELIGIBLE_TOOLS.has(definition.name)
      ? { execution: Object.freeze({ taskSupport: 'optional' as const }) }
      : {}),
    outputSchema: Object.freeze(definition.outputSchema || outputSchemaFor(definition.name)) as JsonSchema,
    behavior: Object.freeze({
      ...DEFAULT_BEHAVIOR,
      ...(definition.behavior || {}),
      executionClass: executionClassFor(definition.name)
    }),
    dashboard: Object.freeze({ ...DEFAULT_DASHBOARD, ...(definition.dashboard || {}) })
  }) as CatalogToolDefinition;
}

const OPERATION_DEFINITIONS: readonly CatalogToolDefinition[] = Object.freeze(
  OPERATION_REGISTRY.map(record => defineTool(record.definition))
);
const OPERATION_DEFINITION_BY_NAME = new Map<string, CatalogToolDefinition>(
  OPERATION_DEFINITIONS.map(definition => [definition.name, definition])
);

function getOperationDefinition(name: unknown): CatalogToolDefinition | null {
  return OPERATION_DEFINITION_BY_NAME.get(String(name || '')) || null;
}

function getOperationDefinitions(): readonly CatalogToolDefinition[] {
  return OPERATION_DEFINITIONS;
}

const PUBLIC_TOOL_VALUES = [
  {
    name: 'relai_work',
    title: 'Manage Workspace Work',
    description: 'Manages a durable workspace task. Use begin for substantial or multi-step repository work, including read-first investigations; it returns work_id promptly. context loads repository context, plan records or replaces the ordered checklist, and status, finish, and cancel manage lifecycle state. Carry work_id on subsequent task operations.',
    annotations: annotations(false, false, false, false),
    behavior: { taskScope: 'optional', executionClass: 'always_immediate' },
    dashboard: { category: 'Workflow', capabilities: ['workflow'] }
  },
  {
    name: 'relai_snapshot', title: 'Workspace Snapshot',
    description: 'Returns a compact local workspace or repository bootstrap overview. This read-only operation may use an authorized workspace directly without a work_id.'
  },
  {
    name: 'relai_read', title: 'Read Local Workspace',
    description: 'Reads exact local workspace files, ranges, directories, discovered skills, or execution output. Host-uploaded files stay host-owned; asResource:true returns one exact local file as a private resource_link for transfer or download.'
  },
  {
    name: 'relai_search', title: 'Search Repository',
    description: 'Provides lexical or semantic discovery across repository content.',
    annotations: annotations(true, false, true, false), behavior: { taskScope: 'optional' }
  },
  {
    name: 'relai_inspect', title: 'Inspect Code Relationships',
    description: 'Provides read-only symbol, reference, impact, trace, diagnostic, and architecture analysis.',
    annotations: annotations(true, false, true, false), groups: ['audit'], behavior: { taskScope: 'optional' }
  },
  {
    name: 'relai_edit', title: 'Edit Local Workspace',
    description: 'Mutates authorized workspace files or environment through semantic rename, structural symbol edits, exact replacement, full-file content, host file import, patch text, batch edits, or secret-safe environment operations.',
    dashboard: { capabilities: ['edit'] }
  },
  {
    name: 'relai_exec', title: 'Run Command',
    description: 'Runs bounded one-shot workspace commands through direct executable + argv or a command string; work_id is optional attribution.',
    dashboard: { capabilities: ['execute'] }
  },
  {
    name: 'relai_process', title: 'Manage Process',
    description: 'Manages persistent services, watchers, and interactive programs with stable process identity. Startup accepts direct executable + argv or a command string; one-shot work belongs in relai_exec or relai_validate.',
    annotations: annotations(false, true, false, true),
    dashboard: { capabilities: ['execute'] }, behavior: { executionClass: 'persistent_process', taskScope: 'optional' }
  },
  {
    name: 'relai_ui', title: 'Test Local UI',
    description: 'Bounded QA for an allowed localhost app: snapshots, interactions, screenshots, console/network capture, viewport changes, and reloads. General machine-local browsing belongs in relai_browser; public web stays host-owned.',
    annotations: annotations(false, true, false, true), dashboard: { capabilities: ['execute'] }
  },
  {
    name: 'relai_browser', title: 'Use Local Browser',
    description: 'Local browser for localhost/LAN/intranet/VPN, machine-authenticated sessions, and workspace file transfer. Semantic snapshots explain page content, layout snapshots cover geometry/overflow, and screenshots provide pixel evidence. Public web stays host-owned.',
    annotations: annotations(false, true, false, true), dashboard: { capabilities: ['execute'] }
  },
  {
    name: 'relai_desktop', title: 'Desktop & OS Operations',
    description: 'Structured local OS actions without pointer/keyboard simulation: open or reveal workspace paths, open URIs, launch apps, and read/write bounded clipboard text. relai_computer is the UI fallback.',
    annotations: annotations(false, true, false, true), dashboard: { capabilities: ['execute'] }
  },
  {
    name: 'relai_computer', title: 'Control Computer',
    description: 'User-authorized final fallback for local desktop input after structured local and browser capabilities. Windows uses UI Automation first, optional built-in OCR hybrid targeting for custom text UI, and Midscene pixels only when semantics cannot perform the action. activate revalidates targets and prefers native UIA actions; set_value uses UIA ValuePattern. wait_for_change, wait_for_stable, observe, and batch support bounded verified action bursts. Requires Computer control and per-app approval; browsers are view-only (relai_browser), terminals/IDEs click-only (relai_desktop for typing). One session drives input at a time.',
    annotations: annotations(false, true, false, true), dashboard: { capabilities: ['execute'] }
  },
  {
    name: 'relai_validate', title: 'Validate Repository',
    description: 'Runs explicit repository checks, diagnostics, or local HTTP validation. Validation is factual repository evidence and may run directly against an authorized workspace; work_id optionally records task provenance.',
    annotations: annotations(false, true, false, true), behavior: { longRunning: true, taskScope: 'optional' },
    dashboard: { capabilities: ['validate'] }
  },
  {
    name: 'relai_changes', title: 'Review or Restore Changes',
    description: 'Reviews, checkpoints or replays reviews, restores, resets, or tidies workspace changes. Read-only review/replay and explicitly scoped restore/reset can use an authorized workspace when their action contract permits.',
    annotations: annotations(false, true, false, false), dashboard: { capabilities: ['review', 'recover'] },
    groups: ['audit', 'cleanup'], behavior: { taskScope: 'optional' }
  },
  {
    name: 'relai_publish', title: 'Publish Repository Work',
    description: 'Commits repository changes, pushes Git branches, or drafts PR text. Commit scope defaults to task-owned paths unless explicit paths or addAll are supplied. Commit, push, and draft-PR actions may use an authorized workspace directly. Real push remains approval-gated.',
    annotations: annotations(false, false, false, true), dashboard: { capabilities: ['git'] }, groups: ['git'], behavior: { taskScope: 'optional' }
  }
] satisfies readonly PublicToolValue[];

const PUBLIC_TOOL_DEFINITIONS: readonly CatalogToolDefinition[] = Object.freeze(PUBLIC_TOOL_VALUES.map(definePublicTool));
const PUBLIC_TOOL_BY_NAME = new Map<string, CatalogToolDefinition>(
  PUBLIC_TOOL_DEFINITIONS.map(definition => [definition.name, definition])
);

function definePublicTool(value: PublicToolValue): CatalogToolDefinition {
  const mappings = ACTION_REGISTRY[value.name];
  if (!mappings) throw new Error(`Missing action registry for public tool '${value.name}'.`);
  const defaultMapping = mappings.default;
  const source = defaultMapping ? getOperationDefinition(defaultMapping.operationName) : null;
  if (defaultMapping && !source) throw new Error(`Missing internal operation '${defaultMapping.operationName}'.`);

  let inputSchema: ObjectJsonSchema = source
    ? source.inputSchema
    : actionInputSchema(value, mappings);
  if (value.name === 'relai_edit') inputSchema = publicEditInputSchema(inputSchema, MAX_BATCH_EDITS) as ObjectJsonSchema;
  if (value.name === 'relai_exec') inputSchema = publicExecInputSchema(inputSchema) as ObjectJsonSchema;
  if (value.name === 'relai_process') inputSchema = publicProcessInputSchema(inputSchema) as ObjectJsonSchema;

  const baseBehavior = source?.behavior || DEFAULT_BEHAVIOR;
  const baseDashboard = source?.dashboard || DEFAULT_DASHBOARD;
  const baseCapabilities = source?.dashboard?.capabilities || ['inspect'];
  const dashboardMetadata = {
    ...DEFAULT_DASHBOARD,
    ...baseDashboard,
    ...(value.dashboard || {}),
    capabilities: [...(value.dashboard?.capabilities || baseCapabilities)]
  };
  return Object.freeze({
    ...(source || {}),
    name: value.name,
    title: value.title,
    description: value.description,
    handlerName: 'compactDispatch',
    inputSchema: Object.freeze(inputSchema),
    outputSchema: RESULT_SCHEMA,
    connectorStrip: Object.freeze([...(source?.connectorStrip || value.connectorStrip || [])]),
    groups: Object.freeze([...(value.groups || source?.groups || [])]),
    annotations: Object.freeze(value.annotations || source?.annotations || annotations(false, false, false, false)),
    behavior: Object.freeze({ ...DEFAULT_BEHAVIOR, ...baseBehavior, ...(value.behavior || {}) }),
    dashboard: Object.freeze({ ...dashboardMetadata, capabilities: Object.freeze(dashboardMetadata.capabilities) })
  }) as CatalogToolDefinition;
}

function actionInputSchema(_value: PublicToolValue, mappings: Readonly<Record<string, ActionMapping>>): ObjectJsonSchema {
  const branches = Object.entries(mappings).map(([action, mapping]) => actionBranch(action, mapping));
  const properties: Record<string, JsonSchema> = { action: { type: 'string', enum: Object.keys(mappings) } };
  for (const branch of branches) {
    for (const [name, fieldSchema] of Object.entries(branch.properties || {})) {
      if (name === 'action') continue;
      properties[name] = properties[name] ? mergePropertySchema(properties[name], fieldSchema) : fieldSchema;
    }
  }
  return { type: 'object', properties, required: ['action'], oneOf: branches, additionalProperties: false };
}

function actionBranch(action: string, mapping: ActionMapping): ObjectJsonSchema {
  const operation = getOperationDefinition(mapping.operationName);
  if (!operation) throw new Error(`Missing internal operation '${mapping.operationName}'.`);
  const schema = operation.inputSchema;
  const properties: Record<string, JsonSchema> = { ...(schema.properties || {}) };
  if (!mapping.keepAction) delete properties.action;
  properties.action = { type: 'string', const: action };

  const publicContract = mapping.publicContract || {};
  for (const field of publicContract.omit || []) delete properties[field];
  const taskScope = mapping.behavior?.taskScope || operation.behavior?.taskScope || TASK_SCOPE.REQUIRED;
  const taskScoped = taskScope === TASK_SCOPE.REQUIRED;
  // Let work.begin reach runtime workspace resolution so missing/typo inputs can
  // return authorized workspace aliases instead of failing in schema validation.
  const workspaceRecoverable = mapping.operationName === OP.WORK_BEGIN;
  const required = new Set((schema.required || [])
    .filter(field => field !== 'action' && !((taskScoped || workspaceRecoverable) && field === 'workspace') && Object.hasOwn(properties, field)));
  for (const field of publicContract.required || []) {
    if (Object.hasOwn(properties, field)) required.add(field);
  }
  required.add('action');

  const {
    type: _type,
    properties: _properties,
    required: _required,
    additionalProperties: _additionalProperties,
    ...constraints
  } = schema;
  return {
    type: 'object',
    properties,
    required: [...required],
    ...constraints,
    ...(publicContract.extra || {}),
    additionalProperties: false
  } as ObjectJsonSchema;
}

function mergePropertySchema(left: JsonSchema, right: JsonSchema): JsonSchema {
  if (JSON.stringify(left) === JSON.stringify(right)) return left;
  if (isBoundedSchemaSubset(left, right)) return right;
  if (isBoundedSchemaSubset(right, left)) return left;
  const variants: JsonSchema[] = [];
  for (const candidate of [left, right]) {
    if (Array.isArray(candidate.anyOf) && Object.keys(candidate).length === 1) variants.push(...candidate.anyOf);
    else variants.push(candidate);
  }
  const unique: JsonSchema[] = [];
  const seen = new Set<string>();
  for (const variant of variants) {
    const key = JSON.stringify(variant);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(variant);
  }
  return { anyOf: unique };
}

function isBoundedSchemaSubset(candidate: JsonSchema | undefined, superset: JsonSchema | undefined): boolean {
  if (!candidate || !superset || candidate.type !== superset.type) return false;
  if (candidate.type === 'number' || candidate.type === 'integer') {
    if (!hasOnlyKeys(candidate, ['type', 'minimum', 'maximum']) || !hasOnlyKeys(superset, ['type', 'minimum', 'maximum'])) return false;
    return lowerBound(candidate.minimum) >= lowerBound(superset.minimum)
      && upperBound(candidate.maximum) <= upperBound(superset.maximum);
  }
  if (candidate.type === 'string') {
    if (!hasOnlyKeys(candidate, ['type', 'minLength', 'maxLength']) || !hasOnlyKeys(superset, ['type', 'minLength', 'maxLength'])) return false;
    return lowerBound(candidate.minLength, 0) >= lowerBound(superset.minLength, 0)
      && upperBound(candidate.maxLength) <= upperBound(superset.maxLength);
  }
  if (candidate.type === 'array') {
    if (!hasOnlyKeys(candidate, ['type', 'items', 'minItems', 'maxItems']) || !hasOnlyKeys(superset, ['type', 'items', 'minItems', 'maxItems'])) return false;
    return lowerBound(candidate.minItems, 0) >= lowerBound(superset.minItems, 0)
      && upperBound(candidate.maxItems) <= upperBound(superset.maxItems)
      && isBoundedSchemaSubset(candidate.items, superset.items);
  }
  return false;
}

function hasOnlyKeys(value: JsonSchema, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every(key => allowedKeys.has(key));
}

function lowerBound(value: number | undefined, fallback = Number.NEGATIVE_INFINITY): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function upperBound(value: number | undefined): number {
  return Number.isFinite(value) ? Number(value) : Number.POSITIVE_INFINITY;
}

function getPublicActionContract(definition: CatalogToolDefinition, action: string): PublicActionContract {
  if (action === 'default') {
    const taskScope = definition.behavior?.taskScope || TASK_SCOPE.REQUIRED;
    const fields = Object.keys(definition.inputSchema?.properties || {}).filter(field => field !== 'action');
    if (taskScope !== TASK_SCOPE.NONE && !fields.includes('work_id')) fields.push('work_id');
    if (taskScope === TASK_SCOPE.OPTIONAL && !fields.includes('independent')) fields.push('independent');
    const required = [...(definition.inputSchema?.required || [])].filter(field => field !== 'action');
    if (taskScope === TASK_SCOPE.REQUIRED || taskScope === TASK_SCOPE.OPTIONAL) {
      const workspaceIndex = required.indexOf('workspace');
      if (workspaceIndex >= 0) required.splice(workspaceIndex, 1);
    }
    if (taskScope === TASK_SCOPE.REQUIRED && !required.includes('work_id')) required.push('work_id');
    return Object.freeze({ fields: Object.freeze(fields.sort()), required: Object.freeze(required.sort()) });
  }
  const branch = definition.inputSchema?.oneOf?.find(item => item?.properties?.action?.const === action);
  if (!branch) throw new Error(`Public action ${definition.name}:${action} has no schema branch.`);
  const mapping = ACTION_REGISTRY[definition.name]?.[action];
  const operation = mapping ? getOperationDefinition(mapping.operationName) : null;
  const taskScope = mapping?.behavior?.taskScope || operation?.behavior?.taskScope || TASK_SCOPE.REQUIRED;
  const fields = Object.keys(branch.properties || {}).filter(field => field !== 'action');
  if (taskScope !== TASK_SCOPE.NONE && !fields.includes('work_id')) fields.push('work_id');
  if (taskScope === TASK_SCOPE.OPTIONAL && !fields.includes('independent')) fields.push('independent');
  const required = [...(branch.required || [])].filter(field => field !== 'action');
  if (taskScope === TASK_SCOPE.REQUIRED || taskScope === TASK_SCOPE.OPTIONAL) {
    const workspaceIndex = required.indexOf('workspace');
    if (workspaceIndex >= 0) required.splice(workspaceIndex, 1);
  }
  if (taskScope === TASK_SCOPE.REQUIRED && !required.includes('work_id')) required.push('work_id');
  return Object.freeze({ fields: Object.freeze(fields.sort()), required: Object.freeze(required.sort()) });
}

function annotations(readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean, openWorldHint: boolean): ToolAnnotations {
  return Object.freeze({ readOnlyHint, destructiveHint, idempotentHint, openWorldHint });
}

function getCatalogToolDefinition(name: unknown): CatalogToolDefinition | null {
  return PUBLIC_TOOL_BY_NAME.get(String(name || '')) || null;
}

function getCatalogToolDefinitions(): readonly CatalogToolDefinition[] {
  return PUBLIC_TOOL_DEFINITIONS;
}

export {
  getCatalogToolDefinition,
  getCatalogToolDefinitions,
  getOperationDefinition,
  getOperationDefinitions,
  getPublicActionContract
};
export type { ActionMapping, ActionRegistry, CatalogToolDefinition, PublicActionContract };
