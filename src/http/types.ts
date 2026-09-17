import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import type { ErrorCode } from '../contracts/errors.ts';

export type JsonRecord = Record<string, unknown>;
type Unsubscribe = () => void;

interface RuntimeAccessState {
  blocked?: boolean;
  errorCode?: ErrorCode;
  message?: string;
}

export interface HttpServerOptions {
  host?: string;
  port?: number;
  token?: string;
  allowNoAuth?: boolean;
  writeProfile?: boolean;
  maxBodyBytes?: number;
  isolated?: boolean;
  exitOnError?: boolean;
  stopManagedProcessesOnClose?: boolean;
  pickFolder?: () => string | null | Promise<string | null>;
  openFolder?: (folderPath: string) => unknown | Promise<unknown>;
  getTaskActivity?: () => JsonRecord;
  getDesktopStatus?: () => JsonRecord;
  onDesktopStatusChange?: (listener: (status: JsonRecord) => void) => Unsubscribe;
  getRuntimeAccess?: () => RuntimeAccessState;
  resetTaskActivity?: () => JsonRecord;
  getRuntimeLogs?: (options?: { limit?: number }) => JsonRecord;
  clearRuntimeLogs?: () => unknown | Promise<unknown>;
  onRuntimeLogChange?: (listener: (change: JsonRecord) => void) => Unsubscribe;
}

export interface ResolvedHttpServerOptions extends HttpServerOptions {
  host: string;
  port: number;
  token: string;
  allowNoAuth: boolean;
  maxBodyBytes: number;
}

export type McpAccess =
  | { kind: 'streamable-http' }
  | { kind: 'none' };

export interface HttpRouteContext {
  req: IncomingMessage & { auth?: JsonRecord };
  res: ServerResponse<IncomingMessage>;
  options: ResolvedHttpServerOptions;
  parsed: URL;
  mcpAccess: McpAccess;
  p: string;
}

type HttpRouteHandler = (ctx: HttpRouteContext) => void | Promise<void>;
type HttpAuthorizer = (ctx: HttpRouteContext) => boolean;

export interface RouteDefinition {
  auth: HttpAuthorizer;
  handler: HttpRouteHandler;
}

export interface HttpRequestError extends Error {
  status?: number;
  errorCode?: ErrorCode;
  code?: string;
}

export interface RelaiHttpServer extends Server<typeof IncomingMessage, typeof ServerResponse> {
  waitForShutdown: () => Promise<unknown>;
  startupTimings: Record<string, number>;
}
