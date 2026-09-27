// Static dependency model for runtime modules copied into the packaged Electron app.
// This file is analyzed by Knip and is never executed or included in release artifacts.
import '@modelcontextprotocol/node';
import '@modelcontextprotocol/server';
import '@opentelemetry/api';
import '@opentelemetry/exporter-trace-otlp-http';
import '@opentelemetry/resources';
import '@opentelemetry/sdk-trace-node';
import '@opentelemetry/semantic-conventions';

export const packagedRuntimeDependencyModel = Object.freeze({
  cli: ['bin/rel-ai-mcp.js', 'bin/rel-ai-mcp-http.js', 'bin/relai-mcp-config.js', 'bin/relai-extension.js'],
  backend: ['src/server.js', 'src/httpServer.ts', 'src/mcpServer.js', 'src/http/mcpTransport.ts', 'src/telemetry.js'],
  electronExtraResources: ['src/**/*.js', 'public/**/*', 'node_modules/@modelcontextprotocol/**', 'node_modules/@opentelemetry/**']
});
