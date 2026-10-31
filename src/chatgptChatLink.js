// A resource-read reference survives hosts that omit MCP result bodies from
// conversation history. It is correlation evidence, never execution authority.
const CHAT_LINK_RESOURCE_TEMPLATE = 'relai://chat-link/{workId}/{linkId}';
const CHAT_LINK_URI = /^relai:\/\/chat-link\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9_-]{32})$/;

function parseChatLinkResource(uri) {
  const match = typeof uri === 'string' && CHAT_LINK_URI.exec(uri);
  return match ? { workId: match[1], linkId: match[2] } : null;
}

function chatLinkResource(workId, linkId) {
  const uri = `relai://chat-link/${workId}/${linkId}`;
  if (!parseChatLinkResource(uri)) throw new Error('Invalid chat linking receipt.');
  return { type: 'resource_link', uri, name: 'Rel.AI chat linking receipt', mimeType: 'application/json',
    description: 'Read this resource once in this originating chat to make its exact task receipt discoverable.' };
}

async function readChatLinkResource(config, uri, context = {}) {
  const receipt = parseChatLinkResource(uri);
  if (!receipt) throw new Error('Invalid chat linking receipt.');
  const [{ loadGoal, readChatLink }, { principalFingerprint }, { principalTunnelId }, { assertAuthorizedToolCall }] = await Promise.all([
    import('./chatgptGoalState.js'), import('./mcp/principal.ts'), import('./mcp/tunnelIdentity.js'),
    import('./mcp/authorizationPolicy.ts')
  ]);
  const goal = loadGoal(config, receipt.workId);
  if (!goal || goal.owner !== principalFingerprint(context.principal || 'anonymous')
    || (goal.tunnelId || '') !== principalTunnelId(context.principal)) throw new Error('Chat linking receipt is unavailable.');
  assertAuthorizedToolCall({ principal: context.principal, operationName: 'goal.status', workspace: goal.workspace });
  const link = readChatLink(config, goal);
  if (!link || link.linkId !== receipt.linkId) throw new Error('Chat linking receipt is unavailable.');
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify({
    work_id: receipt.workId, chat_link: { version: 1, link_id: receipt.linkId }
  }) }], ttlMs: 0, cacheScope: 'private' };
}

// A chat-visible pairing marker avoids host resource reads and file approval.
// It only correlates a conversation; it is never a task execution capability.
function chatPairingMarker(workId, linkId) {
  if (!parseChatLinkResource(`relai://chat-link/${workId}/${linkId}`)) {
    throw new Error('Invalid chat pairing marker.');
  }
  return `Rel.AI Goal pairing: ${workId}:${linkId}`;
}

function parseChatPairingMarkers(text) {
  if (typeof text !== 'string') return [];
  const markers = [];
  const pattern = /(?:^|\n)Rel\.AI Goal pairing: ([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{32})(?=\s|$)/g;
  const sample = text.length <= 16_384 ? text : text.slice(0, 8192) + '\n' + text.slice(-8192);
  for (const match of sample.matchAll(pattern)) {
    if (markers.length >= 8) break;
    markers.push({ workId: match[1], linkId: match[2] });
  }
  return markers;
}

export { CHAT_LINK_RESOURCE_TEMPLATE, parseChatLinkResource, chatLinkResource, readChatLinkResource,
  chatPairingMarker, parseChatPairingMarkers };
