import type { IncomingMessage, ServerResponse } from 'node:http';
import { Hono, type Context } from 'hono';

import { ERROR_CODES, errorPayload } from '../contracts/errors.ts';
import { isDashboardAuthorized } from './auth.ts';
import { handleDashboard, handleFavicon, handleStaticAsset } from './dashboardShell.ts';
import { handleHealth } from './health.ts';
import { getMcpAccess } from './mcp.ts';
import { sendMcpTransportError } from './mcpResponses.ts';
import { setBaseHeaders, sendJson } from './io.ts';
import { errorCodeForRequest } from './serverPolicy.ts';
import type { HttpRequestError, HttpRouteContext, ResolvedHttpServerOptions, RouteDefinition } from './types.ts';

const ALREADY_SENT_HEADER = 'x-hono-already-sent';

const NOT_FOUND_PAYLOAD = {
  ok: false,
  error: 'Not found.',
  endpoints: {
    health: 'GET /health',
    dashboard: 'GET /dashboard',
    dashboardV10Api: 'GET /api/dashboard/v10',
    logsApi: 'GET /api/logs',
    diagnosticsApi: 'GET /api/diagnostics',
    diagnosticsResetApi: 'POST /api/diagnostics/reset',
    extensionsApi: 'GET /api/extensions',
    extensionsActionApi: 'POST /api/extensions',
    updateWorkspacesApi: 'POST /api/workspaces',
    workspacePreflightApi: 'GET /api/workspace/preflight?workspace=...',
    events: 'GET /events',
    streamableHttp: 'POST /mcp (MCP 2026-07-28; Authentication: private Bearer token)'
  }
} as const;

type NodeBindings = {
  incoming: IncomingMessage;
  outgoing: ServerResponse<IncomingMessage>;
};
type NodeContext = Context<{ Bindings: NodeBindings }>;

function authDashboard(ctx: HttpRouteContext): boolean {
  if (isDashboardAuthorized(ctx.req, ctx.parsed, ctx.options, ctx.res)) return true;
  sendJson(ctx.res, 401, errorPayload(
    ERROR_CODES.DASHBOARD_UNAVAILABLE,
    'Dashboard authorization expired. Reopen the dashboard from the Rel.AI desktop app.'
  ));
  return false;
}

function authNone(): boolean {
  return true;
}

const loadDashboard = () => import('./dashboard.ts');
const loadDashboardComputer = () => import('./dashboardComputer.ts');
const loadDashboardDiagnostics = () => import('./dashboardDiagnostics.ts');
const loadDashboardExtensions = () => import('./dashboardExtensions.ts');
const loadDashboardProcesses = () => import('./dashboardProcesses.ts');
let mcpTransportPromise: ReturnType<typeof importMcpTransport> | null = null;
function importMcpTransport() { return import('./mcpTransport.ts'); }
function loadMcpTransport() {
  mcpTransportPromise ||= importMcpTransport();
  return mcpTransportPromise;
}

function lazyRoute(loader: () => Promise<unknown>, exportName: string): RouteDefinition['handler'] {
  return async ctx => {
    const module = await loader() as Record<string, unknown>;
    const handler = module[exportName];
    if (typeof handler !== 'function') throw new Error(`HTTP route handler '${exportName}' is unavailable.`);
    await (handler as RouteDefinition['handler'])(ctx);
  };
}

const GET_ROUTES: Readonly<Record<string, RouteDefinition>> = Object.freeze({
  '/dashboard': { auth: authDashboard, handler: handleDashboard },
  '/favicon.ico': { auth: authNone, handler: handleFavicon },
  '/health': { auth: authNone, handler: handleHealth },
  '/api/tools': { auth: authDashboard, handler: lazyRoute(loadDashboard, 'handleApiTools') },
  '/api/onboarding/status': { auth: authDashboard, handler: lazyRoute(loadDashboard, 'handleOnboardingStatus') },
  '/api/connection': { auth: authDashboard, handler: lazyRoute(loadDashboard, 'handleConnection') },
  '/api/dashboard/v10': { auth: authDashboard, handler: lazyRoute(loadDashboard, 'handleDashboardV10') },
  '/api/tasks/session': { auth: authDashboard, handler: lazyRoute(loadDashboard, 'handleTaskSession') },
  '/api/logs': { auth: authDashboard, handler: lazyRoute(loadDashboard, 'handleApiLogs') },
  '/api/diagnostics': { auth: authDashboard, handler: lazyRoute(loadDashboardDiagnostics, 'handleApiDiagnostics') },
  '/api/extensions': { auth: authDashboard, handler: lazyRoute(loadDashboardExtensions, 'handleApiExtensions') },
  '/api/computer': { auth: authDashboard, handler: lazyRoute(loadDashboardComputer, 'handleApiComputer') },
  '/api/release-notes': { auth: authDashboard, handler: lazyRoute(loadDashboard, 'handleReleaseNotes') },
  '/api/workspace/preflight': { auth: authDashboard, handler: lazyRoute(loadDashboard, 'handleWorkspacePreflight') },
  '/events': { auth: authDashboard, handler: lazyRoute(loadDashboard, 'handleEvents') }
});

const POST_ROUTES: Readonly<Record<string, RouteDefinition>> = Object.freeze({
  '/api/onboarding/complete': { auth: authDashboard, handler: lazyRoute(loadDashboard, 'handleOnboardingComplete') },
  '/api/workspaces': { auth: authDashboard, handler: lazyRoute(loadDashboard, 'handleApiWorkspaces') },
  '/api/diagnostics/reset': { auth: authDashboard, handler: lazyRoute(loadDashboardDiagnostics, 'handleApiDiagnosticsReset') },
  '/api/extensions': { auth: authDashboard, handler: lazyRoute(loadDashboardExtensions, 'handleApiExtensionsAction') },
  '/api/computer': { auth: authDashboard, handler: lazyRoute(loadDashboardComputer, 'handleApiComputerAction') },
  '/api/pick-folder': { auth: authDashboard, handler: lazyRoute(loadDashboard, 'handlePickFolder') },
  '/api/open-folder': { auth: authDashboard, handler: lazyRoute(loadDashboard, 'handleOpenFolder') },
  '/api/tasks/control': { auth: authDashboard, handler: lazyRoute(loadDashboard, 'handleTaskControl') },
  '/api/workspace/checks': { auth: authDashboard, handler: lazyRoute(loadDashboard, 'handleWorkspaceChecks') },
  '/api/processes/stop': { auth: authDashboard, handler: lazyRoute(loadDashboardProcesses, 'handleApiProcessStop') }
});

function createHttpApp(options: ResolvedHttpServerOptions) {
  const app = new Hono<{ Bindings: NodeBindings }>();

  app.use('*', async (c, next) => {
    const ctx = routeContext(c, options);
    setBaseHeaders(ctx.req, ctx.res, options);
    if (ctx.mcpAccess.kind !== 'none' && blockMcpForRuntimeAccess(ctx.res, options.getRuntimeAccess)) {
      return alreadySentResponse();
    }
    await next();
  });

  app.options('*', c => {
    c.env.outgoing.writeHead(204);
    c.env.outgoing.end();
    return alreadySentResponse();
  });

  for (const [route, definition] of Object.entries(GET_ROUTES)) {
    app.get(route, c => dispatchRoute(c, options, definition));
  }
  for (const [route, definition] of Object.entries(POST_ROUTES)) {
    app.post(route, c => dispatchRoute(c, options, definition));
  }

  for (const route of ['/ui/*', '/public/*', '/vendor/monaco/*']) {
    app.get(route, c => dispatchDirect(c, options, handleStaticAsset));
  }

  app.get('/mcp', c => dispatchDirect(c, options, lazyRoute(loadMcpTransport, 'handleMcpGetDiagnostic')));
  app.post('/mcp', c => dispatchDirect(c, options, lazyRoute(loadMcpTransport, 'handleMcpStreamable')));
  app.delete('/mcp', c => dispatchDirect(c, options, lazyRoute(loadMcpTransport, 'handleMcpDelete')));

  app.notFound(c => {
    sendJson(c.env.outgoing, 404, NOT_FOUND_PAYLOAD);
    return alreadySentResponse();
  });

  app.onError((error, c) => {
    const requestError = error as HttpRequestError;
    const status = Number(requestError?.status || 500);
    const ctx = routeContext(c, options);
    if (ctx.mcpAccess.kind !== 'none') {
      sendMcpTransportError(ctx.res, { status });
      return alreadySentResponse();
    }
    const code = requestError?.errorCode || errorCodeForRequest(ctx.req);
    sendJson(ctx.res, status, errorPayload(code, error instanceof Error ? error.message : String(error)));
    return alreadySentResponse();
  });

  return app;
}

async function dispatchRoute(c: NodeContext, options: ResolvedHttpServerOptions, definition: RouteDefinition): Promise<Response> {
  const ctx = routeContext(c, options);
  if (!definition.auth(ctx)) return alreadySentResponse();
  await definition.handler(ctx);
  return alreadySentResponse();
}

async function dispatchDirect(c: NodeContext, options: ResolvedHttpServerOptions, handler: RouteDefinition['handler']): Promise<Response> {
  await handler(routeContext(c, options));
  return alreadySentResponse();
}

function routeContext(c: NodeContext, options: ResolvedHttpServerOptions): HttpRouteContext {
  const req = c.env.incoming as HttpRouteContext['req'];
  const res = c.env.outgoing;
  const parsed = new URL(req.url || '/', 'http://127.0.0.1');
  return {
    req,
    res,
    options,
    parsed,
    mcpAccess: getMcpAccess(parsed.pathname),
    p: parsed.pathname
  };
}

async function prewarmHttpRoutes(): Promise<void> {
  await loadMcpTransport();
}

async function shutdownHttpRoutes(): Promise<void> {
  if (!mcpTransportPromise) return;
  const transport = await mcpTransportPromise;
  await transport.shutdownMcpTransport();
}

function alreadySentResponse(): Response {
  return new Response(null, { headers: { [ALREADY_SENT_HEADER]: '1' } });
}

function blockMcpForRuntimeAccess(
  res: ServerResponse<IncomingMessage>,
  getRuntimeAccess: ResolvedHttpServerOptions['getRuntimeAccess']
): boolean {
  if (typeof getRuntimeAccess !== 'function') return false;
  let access;
  try {
    access = getRuntimeAccess();
  } catch {
    return false;
  }
  if (access?.blocked !== true) return false;
  sendJson(res, 426, errorPayload(
    access.errorCode || ERROR_CODES.UPDATE_REQUIRED,
    access.message || 'Update Rel.AI MCP before continuing MCP work.'
  ));
  return true;
}

export { createHttpApp, prewarmHttpRoutes, shutdownHttpRoutes };
