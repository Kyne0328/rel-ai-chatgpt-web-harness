// Stream-projected view of ChatGPT conversations. Never retain response history,
// attachment bodies, or unrelated metadata in Goal Mode.
import { JSONParser } from '@streamparser/json';

const MAX_TRANSFER_BYTES = 256 * 1024 * 1024; // Wire safety bound, not RAM buffering.
const MAX_NODES = 100_000;
const MAX_COMMAND_CHARS = 4096;
const MAX_CONTINUATION_CHARS = 8192;
// Work responses include plans and bootstrap context. Their receipt budget is
// separate from command text; only extracted IDs survive projection.
const MAX_RECEIPT_CHARS = 1024 * 1024;
const PATHS = [
  '$.current_node', '$.mapping.*.parent', '$.mapping.*.message.id',
  '$.mapping.*.message.author.role', '$.mapping.*.message.create_time',
  '$.mapping.*.message.status', '$.mapping.*.message.end_turn',
  '$.mapping.*.message.content.parts.*'
];

// Opaque host session IDs cannot identify a Web chat. Retain only exact work
// IDs from bounded JSON tool receipts so discovery can prove the association.
function receiptWorkIds(text) {
  if (typeof text !== 'string' || text.length > MAX_RECEIPT_CHARS) return [];
  let receipt;
  try { receipt = JSON.parse(text); } catch { return []; }
  const ids = new Set();
  const visit = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 3 || ids.size >= 8) return;
    if (typeof value.work_id === 'string' && value.work_id.length <= 128) ids.add(value.work_id);
    visit(value.structuredContent, depth + 1);
    for (const part of Array.isArray(value.content) ? value.content.slice(0, 8) : []) {
      if (part?.type === 'text' && typeof part.text === 'string' && part.text.length <= MAX_RECEIPT_CHARS) {
        try { visit(JSON.parse(part.text), depth + 1); } catch {}
      }
    }
  };
  visit(receipt, 0);
  return [...ids];
}

function goalMessageExists(conversation, expectedText, expectedParentNode) {
  const nodes = conversation?.mapping;
  let nodeId = conversation?.current_node;
  const seen = new Set();
  let found = false;
  while (nodeId && nodes?.[nodeId] && !seen.has(nodeId) && seen.size < 1000) {
    if (nodeId === expectedParentNode) return found;
    seen.add(nodeId);
    const message = nodes[nodeId].message;
    if (message?.author?.role === 'user' && Array.isArray(message.content?.parts)
      && message.content.parts.join('\n').trim() === expectedText) found = true;
    nodeId = nodes[nodeId].parent;
  }
  return false;
}

function conversationProjection() {
  const result = { current_node: '', mapping: Object.create(null) };
  let nodes = 0;
  const parser = new JSONParser({ paths: PATHS, keepStack: false });
  parser.onValue = ({ value, key, stack }) => {
    if (stack.length === 1 && key === 'current_node') {
      if (typeof value === 'string' && value.length <= 256) result.current_node = value;
      return;
    }
    if (stack.length < 3 || stack[1]?.key !== 'mapping') return;
    const id = stack[2]?.key;
    if (typeof id !== 'string' || !id || id.length > 256) return;
    let node = result.mapping[id];
    if (!node) {
      if (++nodes > MAX_NODES) throw new Error('ChatGPT conversation has too many nodes to inspect safely.');
      node = { parent: null, message: null };
      result.mapping[id] = node;
    }
    if (stack.length === 3 && key === 'parent') {
      node.parent = typeof value === 'string' && value.length <= 256 ? value : null;
      return;
    }
    if (stack[3]?.key !== 'message') return;
    if (!node.message) node.message = { author: {}, content: { parts: [] } };
    const message = node.message;
    if (stack.length === 4) {
      if (key === 'id' && typeof value === 'string' && value.length <= 256) message.id = value;
      if (key === 'status' && typeof value === 'string' && value.length <= 80) message.status = value;
      if (key === 'end_turn' && typeof value === 'boolean') message.end_turn = value;
      if (key === 'create_time' && typeof value === 'number' && Number.isFinite(value)) message.create_time = value;
      return;
    }
    if (stack.length === 5 && stack[4]?.key === 'author' && key === 'role') {
      if (['user', 'assistant', 'tool', 'system'].includes(value)) message.author.role = value;
      return;
    }
    if (stack.length === 6 && stack[4]?.key === 'content' && stack[5]?.key === 'parts'
      && Number.isSafeInteger(key) && key >= 0) {
      const parts = message.content.parts;
      const workIds = receiptWorkIds(value);
      if (workIds.length && key < 8) message.content.workIds = [...new Set([
        ...(message.content.workIds || []), ...workIds
      ])].slice(0, 8);
      // The command can span multiple content parts. Preserve the complete
      // command or nothing: a partial '/goal' must not pass as a bare command.
      const textLimit = /^Continue goal /i.test(key === 0 ? value : parts[0] || '')
        ? MAX_CONTINUATION_CHARS : MAX_COMMAND_CHARS;
      if (typeof value !== 'string' || key >= 8 || value.length > textLimit) {
        if (key === 0 || parts.length) { parts.length = 0; message.content.commandInvalid = true; }
        return;
      }
      if (message.content.commandInvalid) return;
      if (key === 0 && (/^\s*\/(?:goal|loop)(?:\s|$)/i.test(value) || /^Continue goal /i.test(value))) {
        parts[0] = value;
      } else if (key > 0 && parts.length && key === parts.length
        && parts.join('\n').length + value.length + 1 <= textLimit) {
        parts[key] = value;
      } else if (parts.length) {
        parts.length = 0;
        message.content.commandInvalid = true;
      }
    }
  };
  return { parser, result };
}

async function readConversationProjection(response) {
  const { parser, result } = conversationProjection();
  let total = 0;
  const reader = response.body?.getReader?.();
  if (!reader) {
    // Synthetic tests may not offer a readable stream. Real Electron/fetch do.
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_TRANSFER_BYTES) throw new Error('ChatGPT conversation transfer exceeded the safety budget.');
    parser.write(text);
  } else {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_TRANSFER_BYTES) throw new Error('ChatGPT conversation transfer exceeded the safety budget.');
        parser.write(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
  }
  if (!parser.isEnded) parser.end();
  if (!result.current_node || !result.mapping[result.current_node]) {
    throw new Error('ChatGPT conversation has no verifiable active branch.');
  }
  return result;
}

export { readConversationProjection, goalMessageExists };
