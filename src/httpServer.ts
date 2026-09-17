import * as http from "node:http";
import { performance } from 'node:perf_hooks';
import { getRequestListener } from '@hono/node-server';
import * as connection from "./connectionProfile.js";
import { DEFAULT_MAX_BODY_BYTES, normalizeMaxBodyBytes } from './http/io.ts';
import { isLoopbackHost } from './http/serverPolicy.ts';
import { createHttpApp, prewarmHttpRoutes, shutdownHttpRoutes } from './http/routes.ts';
import type { HttpServerOptions, RelaiHttpServer, ResolvedHttpServerOptions } from './http/types.ts';
import { createRelaiCoreRuntime } from './core/runtime.ts';
import { ensureConfig, getConfigPath } from './config.js';
import { buildToolManifest } from './mcp/toolManifest.js';
import { resolveConnectionGenerations } from './mcp/connectionGenerations.js';
import { mcpConnectionManager } from './mcp/connectionManager.js';
import { SERVER_INSTANCE_ID } from './mcp/context.js';

const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 300_000;
const MAX_NODE_TIMEOUT_MS = 2_147_483_647;

function resolveHttpRequestTimeoutMs(maxBodyBytes: unknown): number {
  const bodyBytes = normalizeMaxBodyBytes(maxBodyBytes);
  const scaledTimeoutMs = Math.ceil(DEFAULT_HTTP_REQUEST_TIMEOUT_MS * (bodyBytes / DEFAULT_MAX_BODY_BYTES));
  return Math.min(MAX_NODE_TIMEOUT_MS, Math.max(DEFAULT_HTTP_REQUEST_TIMEOUT_MS, scaledTimeoutMs));
}

function startHttpServer(options: HttpServerOptions = {}): RelaiHttpServer {
  const startupStarted = performance.now();
  const isolated = options.isolated === true
    || Number(options.port) === 0
    || process.env.REL_AI_MCP_ISOLATED === '1';
  const launchEnv = isolated ? {} : connection.readLaunchEnv();
  const savedProfile = isolated ? {} : connection.readConnectionProfile();
  const host = options.host || process.env.REL_AI_MCP_HOST || savedProfile.host || "127.0.0.1";
  const port = Number(options.port ?? process.env.REL_AI_MCP_PORT ?? 3333);
  const token = options.token || process.env.REL_AI_MCP_TOKEN || launchEnv.REL_AI_MCP_TOKEN || "";
  const allowNoAuth = Boolean(options.allowNoAuth || process.env.REL_AI_MCP_ALLOW_NO_AUTH === "1");
  // connection.json is global state the desktop app and the ChatGPT connector read to
  // find the live server. A second instance (a test, a benchmark, a manual
  // `npm run start:http` on another port) would otherwise silently repoint it.
  const writeProfile = !isolated && options.writeProfile !== false && process.env.REL_AI_MCP_NO_PROFILE_WRITE !== "1";
  const maxBodyBytes = normalizeMaxBodyBytes(options.maxBodyBytes ?? process.env.REL_AI_MCP_MAX_BODY_BYTES);
  // Native folder picker, injected by the Electron launcher (the HTTP server runs
  // in the same process). Absent when the server runs standalone — the endpoint then
  // reports unsupported and the dashboard falls back to manual path entry.
  const pickFolder = typeof options.pickFolder === "function" ? options.pickFolder : null;
  const openFolder = typeof options.openFolder === "function" ? options.openFolder : null;
  const getTaskActivity = typeof options.getTaskActivity === "function" ? options.getTaskActivity : null;
  const getDesktopStatus = typeof options.getDesktopStatus === "function" ? options.getDesktopStatus : null;
  const onDesktopStatusChange = typeof options.onDesktopStatusChange === "function" ? options.onDesktopStatusChange : null;
  const getRuntimeAccess = typeof options.getRuntimeAccess === "function" ? options.getRuntimeAccess : null;
  const resetTaskActivity = typeof options.resetTaskActivity === "function" ? options.resetTaskActivity : null;
  const getRuntimeLogs = typeof options.getRuntimeLogs === "function" ? options.getRuntimeLogs : null;
  const clearRuntimeLogs = typeof options.clearRuntimeLogs === "function" ? options.clearRuntimeLogs : null;
  const onRuntimeLogChange = typeof options.onRuntimeLogChange === "function" ? options.onRuntimeLogChange : null;

  if (!token && !allowNoAuth) {
    throw new Error("REL_AI_MCP_TOKEN is required for the HTTP server. Set a strong token, or set REL_AI_MCP_ALLOW_NO_AUTH=1 for local-only testing.");
  }
  if (allowNoAuth && !isLoopbackHost(host)) {
    throw new Error('REL_AI_MCP_ALLOW_NO_AUTH is permitted only on a loopback bind.');
  }

  const configurationStarted = performance.now();
  ensureConfig();
  const coreRuntime = createRelaiCoreRuntime({
    isolated,
    stopManagedProcessesOnShutdown: options.stopManagedProcessesOnClose !== false
  });
  const configurationMs = performance.now() - configurationStarted;
  const coreRuntimeStarted = performance.now();
  const coreStartup = coreRuntime.start();
  const coreRuntimeMs = performance.now() - coreRuntimeStarted;
  const runtimeConfig = coreStartup.config as Record<string, unknown>;
  const manifestStarted = performance.now();
  const manifest = buildToolManifest(runtimeConfig);
  const generations = resolveConnectionGenerations(runtimeConfig, { token, host, port });
  mcpConnectionManager.configure({
    serverInstanceId: SERVER_INSTANCE_ID,
    credentialGeneration: generations.credentialGeneration,
    configurationGeneration: generations.configurationGeneration,
    manifest
  });
  const manifestMs = performance.now() - manifestStarted;
  const routeOptions: ResolvedHttpServerOptions = {
    ...options,
    host,
    port,
    token,
    allowNoAuth,
    maxBodyBytes,
    ...(pickFolder ? { pickFolder } : {}),
    ...(openFolder ? { openFolder } : {}),
    ...(getTaskActivity ? { getTaskActivity } : {}),
    ...(getDesktopStatus ? { getDesktopStatus } : {}),
    ...(onDesktopStatusChange ? { onDesktopStatusChange } : {}),
    ...(getRuntimeAccess ? { getRuntimeAccess } : {}),
    ...(resetTaskActivity ? { resetTaskActivity } : {}),
    ...(getRuntimeLogs ? { getRuntimeLogs } : {}),
    ...(clearRuntimeLogs ? { clearRuntimeLogs } : {}),
    ...(onRuntimeLogChange ? { onRuntimeLogChange } : {})
  };

  const httpSetupStarted = performance.now();
  const app = createHttpApp(routeOptions);
  const requestListener = getRequestListener(app.fetch, {
    hostname: host,
    overrideGlobalObjects: false,
    autoCleanupIncoming: false
  });
  const server = http.createServer(requestListener) as RelaiHttpServer;
  server.startupTimings = {
    configurationMs,
    coreRuntimeMs,
    ...numericTimingRecord(coreStartup.startupTimings),
    manifestMs,
    httpSetupMs: performance.now() - httpSetupStarted,
    beforeListenMs: performance.now() - startupStarted
  };

  let shutdownPromise: Promise<unknown> = Promise.resolve();
  server.on('close', () => {
    shutdownPromise = (async () => {
      const transportCleanup = await Promise.allSettled([
        shutdownHttpRoutes(),
        mcpConnectionManager.shutdown('http_server_closed')
      ]);
      const runtimeCleanup = await coreRuntime.shutdown();
      const errors = [...runtimeCleanup.errors];
      if (transportCleanup[0]?.status === 'rejected') {
        errors.push({ step: 'mcpTransport', error: shutdownErrorMessage(transportCleanup[0].reason) });
      }
      if (transportCleanup[1]?.status === 'rejected') {
        errors.push({ step: 'mcpConnectionManager', error: shutdownErrorMessage(transportCleanup[1].reason) });
      }
      return errors.length === runtimeCleanup.errors.length
        ? runtimeCleanup
        : { ...runtimeCleanup, clean: false, errors };
    })();
  });
  server.waitForShutdown = () => shutdownPromise;

  // Keep a finite total receive bound for slow clients, but scale it with the body
  // size the server explicitly accepts so raising the payload limit does not make
  // legitimate uploads proportionally more likely to time out.
  server.requestTimeout = resolveHttpRequestTimeoutMs(maxBodyBytes);
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;

  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  server.on('error', (error: NodeJS.ErrnoException) => {
    mcpConnectionManager.markFailed(error);
    if (error.code === 'EADDRINUSE') {
      console.error(`[rel-ai-mcp] Port ${port} is already in use. Stop the other process or use --port to pick a different port.`);
    } else {
      console.error(`[rel-ai-mcp] Server error: ${error.message}`);
    }
    if (options.exitOnError === false) return;
    process.exit(1);
  });

  const listenStarted = performance.now();
  server.listen(port, host, () => {
    server.startupTimings.listenMs = performance.now() - listenStarted;
    server.startupTimings.localReadyMs = performance.now() - startupStarted;
    mcpConnectionManager.markReady();
    const address = server.address();
    const actualPort = address && typeof address === "object" ? address.port : port;
    console.error(`[rel-ai-mcp] HTTP server listening on http://${host}:${actualPort}`);
    if (writeProfile) {
      const previousPort = Number(savedProfile.port || 0);
      if (previousPort && previousPort !== actualPort) {
        console.error(`[rel-ai-mcp] Notice: repointing the saved connector profile from port ${previousPort} to ${actualPort}. Start with --no-profile-write to leave it untouched.`);
      }
      connection.writeConnectionProfile({ host, port: actualPort, configPath: getConfigPath() });
    }
    const summary = connection.buildConnectionSummary({ host, port: actualPort, token, includeTokenInUrls: false, tunnelId: savedProfile.tunnelId || '' });
    console.error(`[rel-ai-mcp] Dashboard: ${summary.dashboardUrl}`);
    console.error(`[rel-ai-mcp] Local MCP: ${summary.localMcpUrl}`);
    console.error('[rel-ai-mcp] ChatGPT connectivity is provided only by OpenAI Secure MCP Tunnel.');
    setImmediate(() => {
      void prewarmHttpRoutes().catch(error => debugStartupPrewarm('MCP transport', error));
      if (!isolated) {
        void import('./processManager.js')
          .then(module => module.pruneManagedProcesses(runtimeConfig))
          .catch(error => debugStartupPrewarm('managed-process cleanup', error));
      }
    });
    if (!token) {
      console.error("[rel-ai-mcp] Notice: HTTP auth is disabled. Use only on a trusted local network.");
    }
  });

  return server;
}

function numericTimingRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])));
}

function debugStartupPrewarm(component: string, error: unknown): void {
  if (!process.env.REL_AI_MCP_DEBUG) return;
  console.error(`[rel-ai-mcp] ${component} prewarm failed: ${shutdownErrorMessage(error)}`);
}

function shutdownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}

export { resolveHttpRequestTimeoutMs, startHttpServer };
