import assert from 'node:assert/strict';

import { STATIC_CONTEXT } from '../../src/context/static-context.js';
import { PUBLIC_MCP_SERVER_INSTRUCTIONS } from '../../src/mcp/serverInstructions.js';

assert.ok(PUBLIC_MCP_SERVER_INSTRUCTIONS.startsWith(STATIC_CONTEXT), 'server instructions must begin with the canonical static context');
assert.ok(Buffer.byteLength(STATIC_CONTEXT, 'utf8') < 2000, 'static context must remain small');
assert.doesNotMatch(STATIC_CONTEXT, /changelog|previous fix|release history|example:/i, 'static context must not accumulate project history or examples');
assert.match(STATIC_CONTEXT, /work_id/);
assert.match(STATIC_CONTEXT, /substantial or multi-step repository work, start relai_work begin before the first project operation and carry work_id/i, 'substantial local project work must start a durable task');
assert.match(STATIC_CONTEXT, /even when the first steps are read-only investigation/i, 'read-first substantial work must still start a durable task');
assert.match(STATIC_CONTEXT, /taskProgress on supported calls; relai_work plan is the fallback/i, 'multi-step tasks must support piggybacked durable checklist updates without requiring a separate plan round trip');
assert.match(STATIC_CONTEXT, /isolated reads\/inspection\/small one-shots may omit it for workspace\/resource work/i, 'small resource-scoped operations must remain taskless-capable');
assert.match(STATIC_CONTEXT, /never infer one/i, 'omitted task identity must never be guessed');
assert.match(STATIC_CONTEXT, /authorization/i);
assert.match(STATIC_CONTEXT, /validation is factual evidence/i);
assert.match(STATIC_CONTEXT, /Route: AI-host native capability>AI-host plugin\/connector>Rel\.AI structured local>Rel\.AI browser>Rel\.AI computer control/i);

console.log('Static context stays small and contains only universal runtime and capability-routing invariants.');
