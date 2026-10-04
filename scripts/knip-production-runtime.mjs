// Static dependency model for runtime modules copied into the packaged Electron app.
// This file is analyzed by Knip and is never executed or included in release artifacts.
import '@modelcontextprotocol/node';
import '@modelcontextprotocol/server';
import '@opentelemetry/api';
import '@opentelemetry/exporter-trace-otlp-http';
import '@opentelemetry/resources';
import '@opentelemetry/sdk-trace-node';
import '@opentelemetry/semantic-conventions';
// Model exact APIs consumed across Electron's dynamic resource-import boundary.
import { forgetPersistentBrowserSite, persistentBrowserProfileDirectories, readPersistentBrowserSites } from '../src/browser/browserProfile.ts';
import { stopAllBrowserSessions } from '../src/browser/browserRuntime.ts';

void forgetPersistentBrowserSite;
void persistentBrowserProfileDirectories;
void readPersistentBrowserSites;
void stopAllBrowserSessions;

/**
 * @typedef {import('../src/repo/gitStatus.ts').GitAheadBehind} GitAheadBehind
 * @typedef {import('../src/process.ts').RunProcessResult} RunProcessResult
 */
/** @type {ReadonlyArray<GitAheadBehind | RunProcessResult>} */
const exportedRuntimeResultTypes = [];
void exportedRuntimeResultTypes;

export const packagedRuntimeDependencyModel = Object.freeze({
  cli: ['bin/rel-ai-mcp.js', 'bin/rel-ai-mcp-http.js', 'bin/relai-mcp-config.js', 'bin/relai-extension.js'],
  backend: ['src/server.js', 'src/httpServer.ts', 'src/mcpServer.js', 'src/http/mcpTransport.ts', 'src/telemetry.js'],
  electronExtraResources: ['src/**/*.js', 'public/**/*', 'node_modules/@modelcontextprotocol/**', 'node_modules/@opentelemetry/**']
});
