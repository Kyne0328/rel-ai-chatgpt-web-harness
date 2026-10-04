export const MCP_CONTENT_TYPES = Object.freeze({ TEXT: 'text', IMAGE: 'image', RESOURCE_LINK: 'resource_link' } as const);

export interface McpTextContent { type: typeof MCP_CONTENT_TYPES.TEXT; text: string }
export interface McpImageContent { type: typeof MCP_CONTENT_TYPES.IMAGE; data: string; mimeType: string }
export interface McpResourceLinkContent { type: typeof MCP_CONTENT_TYPES.RESOURCE_LINK; uri: string; name: string; description?: string; mimeType?: string; size?: number }
export type McpContent = McpTextContent | McpImageContent | McpResourceLinkContent;

export interface McpToolResultDto<T extends Record<string, unknown> = Record<string, unknown>> {
  content: McpContent[];
  structuredContent: T;
  isError: boolean;
  _meta?: Record<string, unknown>;
}

export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const MCP_LEGACY_PROTOCOL_VERSIONS = Object.freeze(['2025-11-25']);

export const MCP_AUTH_MODE = Object.freeze({
  STATIC_BEARER: 'static_bearer',
  LOCAL_NO_AUTH: 'local_no_auth'
} as const);

const MCP_AUTH_MODES = Object.freeze(Object.values(MCP_AUTH_MODE));
export type McpAuthMode = typeof MCP_AUTH_MODE[keyof typeof MCP_AUTH_MODE];

export function isMcpAuthMode(value: unknown): value is McpAuthMode {
  return MCP_AUTH_MODES.includes(String(value) as McpAuthMode);
}
