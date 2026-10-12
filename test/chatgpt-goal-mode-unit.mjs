import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConversationUrl, activeMessages, turnState, findGoalConversation, sendContinue, configureGoalBrowserTransport, hasGoalBrowserTransport, getConversation } from '../src/chatgptGoalProtocol.js';
import { activateGoal, goalStatus, stopGoal, dashboardGoalStatus, stopDashboardGoal } from '../src/chatgptGoalMode.js';
import { getToolSchemas } from '../src/tools/schema.js';

const ID = 'b5b9731a-8496-4a92-9b44-55d080038c7d';
const OTHER = 'ca32ef5a-77b0-49f0-983d-b39c12c45ff2';
const credentials = { bearer: 'placeholder', cookie: 'session=fake' };

function response(payload) {
  return { ok: true, json: async () => payload, text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload) };
}

function conversation(id, goalText = '/goal Fix the current project') {
  return {
    conversation_id: id, current_node: 'a',
    mapping: {
      root: { parent: null, message: null },
      u: { parent: 'root', message: { id: 'user-1', author: { role: 'user' }, create_time: Date.now() / 1000, content: { parts: [goalText] } } },
      a: { parent: 'u', message: { id: 'assistant-1', author: { role: 'assistant' },
        content: { content_type: 'text', parts: ['Working'] }, end_turn: true, status: 'finished_successfully' } },
      unrelated: { parent: 'root', message: { id: 'unrelated', author: { role: 'assistant' },
        content: { parts: ['Wrong branch'] }, end_turn: true } }
    }
  };
}

test('Goal Mode reuses relai_work and is opt-in on begin', () => {
  const schemas = getToolSchemas();
  assert.equal(schemas.some(schema => schema.name === 'relai_goal'), false);
  const work = schemas.find(schema => schema.name === 'relai_work');
  assert.ok(work);
  const branches = work.inputSchema.oneOf || [];
  const begin = branches.find(branch => branch.properties?.action?.const === 'begin');
  assert.ok(begin);
  assert.equal(begin.properties.goal.type, 'boolean');
  assert.equal(begin.required.includes('goal'), false);
  assert.ok(branches.some(branch => branch.properties?.action?.const === 'goal_status'));
  assert.ok(branches.some(branch => branch.properties?.action?.const === 'goal_stop'));
});

test('conversation URL validation is bound to chatgpt.com', () => {
  assert.equal(parseConversationUrl('https://chatgpt.com/c/' + ID), ID);
  assert.equal(parseConversationUrl(ID), ID);
  assert.throws(() => parseConversationUrl('https://evil.example/c/' + ID));
  assert.throws(() => parseConversationUrl('https://chatgpt.com/c/not-a-uuid'));
});

test('current conversation branch is parsed without side branches', () => {
  const tree = conversation(ID);
  const messages = activeMessages(tree);
  assert.equal(messages.length, 2);
  assert.equal(turnState(tree).lastMessageId, 'assistant-1');
  assert.equal(turnState(tree).complete, true);
  tree.mapping.a.message.end_turn = false;
  assert.equal(turnState(tree).complete, false);
});

test('goal discovery links only an exact unique slash command', async () => {
  const seen = [];
  const fetch = async url => {
    seen.push(url);
    if (url.includes('/backend-api/conversations?')) return response({ items: [{ id: ID }, { id: OTHER }] });
    return response(conversation(url.endsWith(ID) ? ID : OTHER, url.endsWith(ID) ? '/goal Fix the current project' : '/goal Other project'));
  };
  assert.equal(await findGoalConversation('Fix the current project', { credentials, fetch, startedAt: Date.now() }), ID);
  assert.ok(seen.some(url => url.endsWith(ID)));
  const ambiguous = async url => url.includes('/conversations?') ? response({ items: [{ id: ID }, { id: OTHER }] })
    : response(conversation(ID));
  assert.equal(await findGoalConversation('Fix the current project', { credentials, fetch: ambiguous, startedAt: Date.now() }), null);
  const bareCommand = async url => url.includes('/conversations?') ? response({ items: [{ id: ID }] })
    : response(conversation(ID, '/goal'));
  assert.equal(await findGoalConversation('Fix the current project', { credentials, fetch: bareCommand, startedAt: Date.now() }), ID);
  const stopCommand = async url => url.includes('/conversations?') ? response({ items: [{ id: ID }] })
    : response(conversation(ID, '/goal stop'));
  assert.equal(await findGoalConversation('Fix the current project', { credentials, fetch: stopCommand, startedAt: Date.now() }), null);
  const old = async url => url.includes('/conversations?') ? response({ items: [{ id: ID }] })
    : response({ ...conversation(ID), mapping: { ...conversation(ID).mapping,
      u: { parent: 'root', message: { id: 'old', author: { role: 'user' }, create_time: 1, content: { parts: ['/goal Fix the current project'] } } } } });
  assert.equal(await findGoalConversation('Fix the current project', { credentials, fetch: old, startedAt: Date.now() }), null);
});

test('goal record is scoped to principal and stopped without cancelling the task', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-goal-unit-'));
  try {
    const config = { stateDir: dir };
    const work_id = 'task-test';
    const context = { principal: 'test-principal', requestTaskContext: { session: {
      status: 'planning', workspace: 'sample', objective: 'Fix the current project'
    } } };
    const created = activateGoal(config, { work_id, objective: 'Fix the current project', conversationUrl: 'https://chatgpt.com/c/' + ID }, context);
    assert.equal(created.state, 'linking');
    assert.equal(goalStatus(config, { work_id }, context).goalActive, true);
    assert.throws(() => goalStatus(config, { work_id }, { principal: 'other-principal' }));
    const stopped = stopGoal(config, { work_id }, context);
    assert.equal(stopped.goalActive, false);
    assert.equal(goalStatus(config, { work_id }, context).state, 'stopped');
    assert.equal(dashboardGoalStatus(config, work_id).goalActive, false);
    assert.equal(stopDashboardGoal(config, work_id).state, 'stopped');
    assert.equal(activateGoal(config, { work_id, objective: 'Fix the current project' }, context).goalActive, true,
      'only an explicit new start may reactivate a stopped goal');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('native browser protocol transport keeps session credentials outside the service process', async () => {
  const requests = [];
  configureGoalBrowserTransport(async payload => {
    requests.push(payload);
    if (payload.path.includes('/conversation/prepare')) return { ok: true, data: { conduit_token: 'test-conduit' } };
    if (payload.path.includes('/sentinel/')) return { ok: true, data: { token: 'test-requirement', proofofwork: { required: false } } };
    if (payload.raw) return { ok: true, streamObserved: true };
    return { ok: true, data: conversation(ID) };
  });
  try {
    assert.equal(hasGoalBrowserTransport(), true);
    assert.equal(turnState(await getConversation(ID)).complete, true);
    assert.equal((await sendContinue(ID, 'assistant-1', { workId: 'test-work', objective: 'Fix the current project' })).accepted, true);
    assert.deepEqual(requests.map(request => request.method), ['GET', 'POST', 'POST', 'POST']);
    assert.ok(requests.every(request => !request.headers?.authorization && !request.headers?.cookie),
      'session secrets must never enter the native request payload');
    assert.equal(requests.at(-1).body.parent_message_id, 'assistant-1');
  } finally {
    configureGoalBrowserTransport(null);
  }
  assert.equal(hasGoalBrowserTransport(), false);
});

test('continuation sends the exact parent and fails closed when verification is required', async () => {
  const sent = [];
  const fetch = async (url, options) => {
    sent.push({ url, options });
    if (url.includes('/conversation/prepare')) return response({ conduit_token: 'test-conduit' });
    if (url.includes('/sentinel/')) return response({ token: 'test-requirement', proofofwork: { required: false } });
    return response('event: delta_encoding\\ndata: "v1"\\n\\n');
  };
  const accepted = await sendContinue(ID, 'assistant-1', { credentials, fetch, workId: 'test-work', objective: 'Fix the current project' });
  assert.equal(accepted.accepted, true);
  const payload = JSON.parse(sent[2].options.body);
  assert.equal(payload.parent_message_id, 'assistant-1');
  assert.equal(payload.conversation_id, ID);
  assert.match(payload.messages[0].content.parts[0], /test-work/);
  const challenged = async url => url.includes('/conversation/prepare') ? response({ conduit_token: 'test-conduit' })
    : response({ token: 'test-requirement', proofofwork: { required: true } });
  await assert.rejects(() => sendContinue(ID, 'assistant-1', { credentials, fetch: challenged, workId: 'test-work', objective: 'Fix the current project' }), /interactive verification/);
});