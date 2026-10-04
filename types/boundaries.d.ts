type ToolName = string;
export type ToolGroup = 'git' | 'audit' | 'cleanup';
type AuditKind = '' | 'snapshot' | 'read' | 'path' | 'checks' | 'edit' | 'exec' | 'completion';
type CacheKind = '' | 'paths' | 'edit' | 'workspace';
type SummaryKind = '' | 'checks' | 'diff' | 'edit' | 'completion';

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  enum?: string[];
  const?: unknown;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  not?: JsonSchema;
  pattern?: string;
}

interface ObjectJsonSchema extends JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchema>;
  required: string[];
  additionalProperties: false;
}

interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

type ToolExecutionClass = 'always_immediate' | 'bounded_synchronous' | 'background_fallback_eligible' | 'persistent_process';

interface ToolBehavior {
  audit: AuditKind;
  cache: CacheKind;
  startsSession: boolean;
  deferStagedSession: boolean;
  sessionWrite: boolean;
  summary: SummaryKind;
  longRunning: boolean;
  taskScope: 'required' | 'optional' | 'none';
  concurrencyScope: 'task' | 'mutation' | 'workspace';
  executionClass: ToolExecutionClass;
}

type ToolCapability = 'inspect' | 'edit' | 'execute' | 'workflow' | 'review' | 'validate' | 'git' | 'recover';

interface ToolDashboardMetadata {
  category: string;
  requiredProfile: 'workspace';
  requiresApproval: boolean;
  capabilities?: readonly ToolCapability[];
}

export interface ToolDefinitionMetadata {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: ObjectJsonSchema;
  outputSchema: JsonSchema;
  annotations: ToolAnnotations;
  execution?: ToolExecution;
  handlerName: string;
  connectorStrip: string[];
  groups: ToolGroup[];
  behavior: ToolBehavior;
  dashboard: ToolDashboardMetadata;
}


export interface ToolArgs extends Record<string, unknown> {
  workspace?: string;
  work_id?: string;
  title?: string;
  objective?: string;
  bootstrap?: 'compact' | 'full' | 'none';
  instructionPath?: string;
  path?: string;
  paths?: string[];
  startLine?: number;
  endLine?: number;
  guidanceMode?: string;
  mode?: string;
  contextBefore?: number;
  contextAfter?: number;
  groupByFile?: boolean;
  mergeOverlaps?: boolean;
  maxFiles?: number;
  maxRangesPerFile?: number;
  maxRangeLines?: number;
  maxBytes?: number;
  maxResults?: number;
  dryRun?: boolean;
  stage?: string;
  updateText?: string;
  edits?: Array<{ path?: string }>;
  timeoutMs?: number;
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  maxOutputBytes?: number;
  processId?: string;
  stdoutOffset?: number;
  stderrOffset?: number;
  input?: string;
  label?: string;
  startupWaitMs?: number;
  maxLogBytes?: number;
  graceMs?: number;
  limit?: number;
  status?: string;
  name?: string;
  base?: string;
  branch?: string;
  alias?: string;
  force?: boolean;
  query?: string;
  pathPrefix?: string;
  language?: string;
  commands?: string[];
  planId?: string;
  planLevel?: string;
  release?: boolean;
  defer?: boolean;
  operationTaskId?: string;
  complete?: boolean;
  summary?: string;
}

export interface ToolResult extends Record<string, unknown> {
  ok?: boolean;
  plannerPath?: string;
  plannerReason?: string;
  validationLevel?: string;
  validationLevelReason?: string;
  aliasNormalizations?: number;
  policy?: { sessionActive?: boolean };
  operation?: string;
  items?: Array<{ cacheHit?: boolean }>;
  effectiveMaxEntries?: number;
  budgetMultiplied?: boolean;
  completionKnown?: boolean;
  endReason?: string;
  completionSource?: string;
  summary?: string;
  validationAt?: string;
  changedFiles?: string[];
  nextAction?: string;
  commandSummary?: string;
  cwd?: string;
  exitCode?: number;
  durationMs?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  timedOut?: boolean;
  mutationTracking?: string;
  mutationUnknown?: boolean;
  environmentKeys?: string[];
  matches?: Array<{ path: string; line: number; text: string }>;
  files?: Array<Record<string, unknown>>;
  contexts?: Array<Record<string, unknown>>;
  matchCount?: number;
  contextMatchCount?: number;
  effectiveMode?: string;
  autoTier?: string;
  selectionStrategy?: string;
  returnedFileCount?: number;
  returnedRangeCount?: number;
  returnedBytes?: number;
  contextTruncated?: boolean;
}


export interface LauncherConfigInput {
  port?: number | string;
  tunnelId?: string;
  tunnelApiKey?: string;
  token?: string;
}

export interface LauncherConfig {
  port: number;
  tunnelId: string;
  token: string;
}

