import type { IncomingMessage, ServerResponse } from 'node:http';
import { Hono, type Context } from 'hono';

import { ERROR_CODES, errorPayload } from '../contracts/errors.ts';
import { isDashboardAuthorized } from './auth.ts';
import {
  handleApiLogs,
  handleApiTools,
  handleApiWorkspaces,
  handleConnection,
  handleDashboard,
  handleDashboardV10,
  handleEvents,
  handleFavicon,
  handleHealth,
  handleOnboardingComplete,
  handleOnboardingStatus,
  handleOpenFolder,
  handlePickFolder,
  handleReleaseNotes,
  handleStaticAsset,
  handleTaskSession,
  handleWorkspaceChecks,
  handleWorkspacePreflight
} from './dashboard.ts';
import { handleApiComputer, handleApiComputerAction } from './dashboardComputer.ts';
import { handleApiDiagnostics, handleApiDiagnosticsReset } from './dashboardDiagnostics.ts';
import { handleApiExtensions, handleApiExtensionsAction } from './dashboardExtensions.ts';
import { handleApiProcessStop } from './dashboardProcesses.ts';
import { getMcpAccess } from './mcp.ts';
import { handleMcpDelete, handleMcpGetDiagnostic, handleMcpStreamable, sendMcpTransportError } from './mcpTransport.ts';
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

const GET_ROUTES: Readonly<Record<string, RouteDefinition>> = Object.freeze({
  '/dashboard': { auth: authDashboard, handler: handleDashboard },
  '/favicon.ico': { auth: authNone, handler: handleFavicon },
  '/health': { auth: authNone, handler: handleHealth },
  '/api/tools': { auth: authDashboard, handler: handleApiTools },
  '/api/onboarding/status': { auth: authDashboard, handler: handleOnboardingStatus },
  '/api/connection': { auth: authDashboard, handler: handleConnection },
  '/api/dashboard/v10': { auth: authDashboard, handler: handleDashboardV10 },
  '/api/tasks/session': { auth: authDashboard, handler: handleTaskSession },
  '/api/logs': { auth: authDashboard, handler: handleApiLogs },
  '/api/diagnostics': { auth: authDashboard, handler: handleApiDiagnostics },
  '/api/extensions': { auth: authDashboard, handler: handleApiExtensions },
  '/api/computer': { auth: authDashboard, handler: handleApiComputer },
  '/api/release-notes': { auth: authDashboard, handler: handleReleaseNotes },
  '/api/workspace/preflight': { auth: authDashboard, handler: handleWorkspacePreflight },
  '/events': { auth: authDashboard, handler: handleEvents }
});

const POST_ROUTES: Readonly<Record<string, RouteDefinition>> = Object.freeze({
  '/api/onboarding/complete': { auth: authDashboard, handler: handleOnboardingComplete },
  '/api/workspaces': { auth: authDashboard, handler: handleApiWorkspaces },
  '/api/diagnostics/reset': { auth: authDashboard, handler: handleApiDiagnosticsReset },
  '/api/extensions': { auth: authDashboard, handler: handleApiExtensionsAction },
  '/api/computer': { auth: authDashboard, handler: handleApiComputerAction },
  '/api/pick-folder': { auth: authDashboard, handler: handlePickFolder },
  '/api/open-folder': { auth: authDashboard, handler: handleOpenFolder },
  '/api/workspace/checks': { auth: authDashboard, handler: handleWorkspaceChecks },
  '/api/processes/stop': { auth: authDashboard, handler: handleApiProcessStop }
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

  app.get('/mcp', c => dispatchDirect(c, options, handleMcpGetDiagnostic));
  app.post('/mcp', c => dispatchDirect(c, options, handleMcpStreamable));
  app.delete('/mcp', c => dispatchDirect(c, options, handleMcpDelete));

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

export { createHttpApp };
