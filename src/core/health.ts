import { getApplicationMetadata } from '../appMetadata.js';
import { mcpConnectionManager } from '../mcp/connectionManager.js';

export function readHealthStatus(): Record<string, unknown> {
  const mcpConnection = mcpConnectionManager.snapshot();
  const application = getApplicationMetadata();
  return {
    ok: mcpConnection.status !== 'failed',
    name: application.name,
    version: application.version,
    transports: ['streamable-http'],
    serverStatus: mcpConnection.status,
    toolManifestVersion: mcpConnection.toolManifestVersion,
    activeToolCount: mcpConnection.currentActiveToolCount
  };
}
