import { McpServer, ResourceTemplate, fromJsonSchema } from '@modelcontextprotocol/server';
import { readConfig } from './config.js';
import { createRelaiRequestStateCodec, SERVER_INSTANCE_ID, toolContext } from './mcp/context.js';
import {
  MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_PROTOCOL_VERSION,
  TASKS_EXTENSION_ID,
  TASKS_EXTENSION_REVISION
} from './mcp/protocol.js';
import { PUBLIC_MCP_SERVER_INSTRUCTIONS } from './mcp/serverInstructions.js';
import { toolResult } from './mcp/results.js';
import { validateToolOutput } from './tools/outputValidation.js';
import { packageMetadata as pkg } from './packageMetadata.js';
import { listResources, readResource, resourceCacheHint } from './resources.js';
import { getPublicToolSchemas, getToolSurfaceManifest } from './tools/schema.ts';
import { LOCAL_DEVELOPER_MODE } from './mcp/localDeveloperMode.js';
import { ARTIFACT_RESOURCE_TEMPLATE } from './artifactResources.js';
import { readGoalModeResource } from './mcp/goalModeApp.js';
import { GOAL_MODE_RESOURCE_MIME_TYPE, GOAL_MODE_RESOURCE_URI } from './mcp/goalModeContract.js';

interface RelaiMcpServerOptions {
  config?: Record<string, unknown>;
  legacyCompatibility?: boolean;
  nativeTasks?: boolean;
  principal?: unknown;
  publicHttpOnly?: boolean;
  transportType?: string;
}

const MCP_SERVER_INFO = Object.freeze({
  name: String(pkg.name),
  version: String(pkg.version),
  toolSurfaceVersion: getToolSurfaceManifest().toolSurfaceVersion
});
const PUBLIC_TOOL_SCHEMAS = getPublicToolSchemas();
const TOOL_REGISTRATIONS = new Map(PUBLIC_TOOL_SCHEMAS.map(definition => [definition.name, toolRegistration(definition)]));

function createRelaiMcpServer(options: RelaiMcpServerOptions = {}): McpServer {
  const config = options.config || readConfig();
  const definitions = PUBLIC_TOOL_SCHEMAS;
  const surface = getToolSurfaceManifest(config);
  const legacyCompatibility = options.legacyCompatibility === true;
  const requestStateCodec = createRelaiRequestStateCodec(config, options.principal);
  const capabilities = {
    tools: {},
    resources: { subscribe: false },
    ...(options.nativeTasks === true ? {
      extensions: { [TASKS_EXTENSION_ID]: { revision: TASKS_EXTENSION_REVISION } }
    } : {}),
    experimental: {
      relai: {
        targetProtocolVersion: MCP_PROTOCOL_VERSION,
        supportedProtocolVersions: legacyCompatibility
          ? [...MCP_LEGACY_PROTOCOL_VERSIONS]
          : [MCP_PROTOCOL_VERSION],
        compatibilityMode: legacyCompatibility ? 'legacy_http' : 'modern',
        toolSurfaceVersion: surface.toolSurfaceVersion,
        toolCount: definitions.length,
        deploymentMode: LOCAL_DEVELOPER_MODE,
        taskIdentityVersion: 2,
        statelessRequestModel: true,
        manifestResource: 'relai://server/tool-surface'
      }
    }
  };
  const server: any = new McpServer(MCP_SERVER_INFO, {
    supportedProtocolVersions: legacyCompatibility
      ? [...MCP_LEGACY_PROTOCOL_VERSIONS]
      : [MCP_PROTOCOL_VERSION],
    capabilities,
    instructions: connectorInstructions(config),
    cacheHints: {
      'server/discover': { ttlMs: 30000, cacheScope: 'private' },
      'tools/list': { ttlMs: 30000, cacheScope: 'private' },
      'resources/list': { ttlMs: 15000, cacheScope: 'private' },
      'resources/read': { ttlMs: 5000, cacheScope: 'private' }
    },
    inputRequired: {
      maxRounds: 4,
      roundTimeoutMs: 10 * 60 * 1000,
      legacyShim: legacyCompatibility
    },
    requestState: { verify: requestStateCodec.verify }
  });

  for (const definition of definitions) registerTool(server, config, definition, requestStateCodec, options);
  for (const resource of listResources(config).resources) {
    server.registerResource(resource.name, resource.uri, {
      description: resource.description,
      mimeType: resource.mimeType,
      cacheHint: resourceCacheHint(resource.uri)
    }, async (uri: URL) => readResource(uri.href));
  }
  server.registerResource(
    'Rel.AI Goal Continuation',
    GOAL_MODE_RESOURCE_URI,
    {
      description: 'Compact MCP App view that safely continues an unfinished Rel.AI Goal across ChatGPT turns.',
      mimeType: GOAL_MODE_RESOURCE_MIME_TYPE,
      cacheHint: { ttlMs: 300000, cacheScope: 'private' }
    },
    async (uri: URL) => readGoalModeResource(uri.href)
  );
  server.registerResource(
    'Rel.AI Artifact',
    new ResourceTemplate(ARTIFACT_RESOURCE_TEMPLATE, { list: undefined }),
    {
      description: 'Private principal- and workspace-bound artifact returned by relai_read asResource.',
      mimeType: 'application/octet-stream',
      cacheHint: { ttlMs: 0, cacheScope: 'private' }
    },
    async (uri: URL, _variables: Record<string, string>, context: any) => readResource(uri.href, {
      principal: options.principal || context?.http?.authInfo
    })
  );
  return server as McpServer;
}

function registerTool(
  server: any,
  config: Record<string, unknown>,
  definition: (typeof PUBLIC_TOOL_SCHEMAS)[number],
  requestStateCodec: any,
  options: RelaiMcpServerOptions
): void {
  server.registerTool(definition.name, TOOL_REGISTRATIONS.get(definition.name), async (args: Record<string, unknown> | undefined, context: any) => {
    const { invokeRelaiTool } = await import('./mcp/toolInvocation.js');
    const input = args || {};
    return invokeRelaiTool({
      config,
      name: definition.name,
      args: input,
      context: toolContext(context, options),
      approvalContext: context,
      requestStateCodec,
      validateOutput: (output: unknown) => validateToolOutput(config, definition.name, input, output)
    });
  });
}

function toolRegistration(definition: (typeof PUBLIC_TOOL_SCHEMAS)[number]): Record<string, unknown> {
  return {
    title: definition.title,
    description: definition.description,
    inputSchema: fromJsonSchema(definition.inputSchema as Parameters<typeof fromJsonSchema>[0]),
    outputSchema: fromJsonSchema(definition.outputSchema as Parameters<typeof fromJsonSchema>[0]),
    annotations: definition.annotations,
    ...(definition._meta ? { _meta: definition._meta } : {})
  };
}

function connectorInstructions(_config: Record<string, unknown> = readConfig()): string {
  return PUBLIC_MCP_SERVER_INSTRUCTIONS;
}

export {
  SERVER_INSTANCE_ID,
  connectorInstructions,
  createRelaiMcpServer,
  MCP_SERVER_INFO,
  toolResult
};
