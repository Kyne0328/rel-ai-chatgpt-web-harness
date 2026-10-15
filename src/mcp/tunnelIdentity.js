import { createHmac } from 'node:crypto';

const TUNNEL_ID = /^tunnel_[A-Za-z0-9_-]{8,200}$/;
const PRINCIPAL_PREFIX = 'secure-tunnel:';

function tunnelLocalToken(localToken, tunnelId) {
  if (!String(localToken || '').trim() || !TUNNEL_ID.test(String(tunnelId || ''))) {
    throw new Error('A local service token and configured Tunnel ID are required.');
  }
  return createHmac('sha256', localToken).update('relai-tunnel-v1:' + tunnelId).digest('base64url');
}

function principalTunnelId(principal) {
  const clientId = String(principal?.clientId || '');
  const id = clientId.startsWith(PRINCIPAL_PREFIX) ? clientId.slice(PRINCIPAL_PREFIX.length) : '';
  return TUNNEL_ID.test(id) ? id : '';
}

export { tunnelLocalToken, principalTunnelId };
