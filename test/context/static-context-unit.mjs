import assert from 'node:assert/strict';

import { STATIC_CONTEXT } from '../../src/context/static-context.js';
import { PUBLIC_MCP_SERVER_INSTRUCTIONS } from '../../src/mcp/serverInstructions.js';

assert.ok(PUBLIC_MCP_SERVER_INSTRUCTIONS.startsWith(STATIC_CONTEXT), 'server instructions must begin with the canonical static context');
assert.ok(Buffer.byteLength(STATIC_CONTEXT, 'utf8') < 2000, 'static context must remain small');
assert.doesNotMatch(STATIC_CONTEXT, /changelog|previous fix|release history|example:/i, 'static context must not accumulate project history or examples');
assert.match(STATIC_CONTEXT, /work_id/);
assert.match(STATIC_CONTEXT, /meaningful project goal.*begin relai_work.*non-empty steps.*first project operation.*carry work_id/i, 'durable project goals must start with plan-backed attribution');
assert.match(STATIC_CONTEXT, /Projectless one-shot utility\/control work runs taskless/i, 'projectless utility/control work must remain taskless');
assert.match(STATIC_CONTEXT, /taskless calls may also handle isolated resource\/recovery\/observation/i, 'low-level recovery/resource operations must remain taskless-capable');
assert.match(STATIC_CONTEXT, /authorization/i);
assert.match(STATIC_CONTEXT, /validation is factual evidence, not execution permission/i);
assert.match(STATIC_CONTEXT, /explicit-work_id checks stay open by default.*complete:true/i, 'validation completion must be explicit');
assert.match(STATIC_CONTEXT, /Route: AI-host native capability>AI-host plugin\/connector>Rel\.AI structured local>Rel\.AI browser>Rel\.AI computer control/i);

console.log('Static context stays small and contains only universal runtime and capability-routing invariants.');
