import {
  MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_PROTOCOL_VERSION
} from '../contracts/mcp.ts';
import {
  validateJsonRpcRequestEnvelope,
  validJsonRpcId
} from './protocolEnvelope.js';

const LEGACY_LIFECYCLE_METHODS = Object.freeze(['initialize', 'notifications/initialized']);

export {
  LEGACY_LIFECYCLE_METHODS,
  MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_PROTOCOL_VERSION,
  validateJsonRpcRequestEnvelope,
  validJsonRpcId
};
