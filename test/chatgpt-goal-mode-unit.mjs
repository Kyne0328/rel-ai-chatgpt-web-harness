import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseConversationUrl, activeMessages, turnState, findGoalConversation, sendContinue, configureGoalBrowserTransport, hasGoalBrowserTransport, getConversation } from '../src/chatgptGoalProtocol.js';
import { activateGoal, goalStatus, stopGoal, dashboardGoalStatus, stopDashboardGoal } from '../src/chatgptGoalMode.js';
import { getToolSchemas } from '../src/tools/schema.js';
import { withStateDatabase } from '../src/stateDatabase.ts';

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

test('native Goal Mode uses one background browser send without exposing session credentials', async () => {
  const requests = [];
  configureGoalBrowserTransport(async payload => {
    requests.push(payload);
    if (payload.action === 'continue') return { ok: true, accepted: true };
    return { ok: true, data: conversation(ID) };
  });
  try {
    assert.equal(hasGoalBrowserTransport(), true);
    assert.equal(turnState(await getConversation(ID)).complete, true);
    assert.equal((await sendContinue(ID, 'assistant-1', {
      workId: 'test-work', objective: 'Fix the current project', nodeId: 'a'
    })).accepted, true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].action, 'continue');
    assert.equal(requests[1].conversationId, ID);
    assert.equal(requests[1].parentMessageId, 'assistant-1');
    assert.equal(requests[1].expectedNodeId, 'a');
    assert.match(requests[1].prompt, /test-work/);
    assert.ok(requests.every(request => !request.headers?.authorization && !request.headers?.cookie),
      'session credentials never cross the native request boundary');
  } finally {
    configureGoalBrowserTransport(null);
  }
  assert.equal(hasGoalBrowserTransport(), false);
});

test('native composer handoff reports bounded send reasons without exposing page text', async () => {
  for (const [reason, expected] of [
    ['text_mismatch', /Composer text could not be verified/],
    ['send_unavailable', /Send button was unavailable/],
    ['verification', /Browser verification is required/],
    ['unexpected-sensitive-input', /ChatGPT needs attention/]
  ]) {
    let calls = 0;
    await assert.rejects(() => sendContinue(ID, 'assistant-1', {
      workId: 'test-work', objective: 'test', nodeId: 'a',
      nativeTransport: async () => { calls++; return { ok: false, needsUser: true, reason }; }
    }), error => expected.test(error.message) && !error.message.includes('sensitive'));
    assert.equal(calls, 1, 'failed browser handoff never replays the send');
  }
  await assert.rejects(() => sendContinue(ID, 'assistant-1', {
    workId: 'test-work', objective: 'test', nodeId: 'a',
    nativeTransport: async () => ({ ok: false, uncertain: true, stage: 'readback' })
  }), /could not be verified \(readback\).*without retrying/);
  await assert.rejects(() => sendContinue(ID, 'assistant-1', {
    workId: 'test-work', objective: 'test', nodeId: 'a',
    nativeTransport: async () => ({ ok: false, needsUser: true, stage: 'private-secret' })
  }), error => !error.message.includes('private-secret'));
});

test('continuation sends the exact parent and fails closed when verification is required', async () => {
  const sent = [];
  const fetch = async (url, options) => {
    sent.push({ url, options });
    if (url.includes('/conversation/prepare')) return response({ conduit_token: 'test-conduit' });
    if (url.includes('/chat-requirements/prepare')) return response({ prepare_token: 'test-prepare', proofofwork: { required: false } });
    if (url.includes('/chat-requirements/finalize')) return response({ token: 'test-requirement' });
    return response('event: delta_encoding\\ndata: "v1"\\n\\n');
  };
  const accepted = await sendContinue(ID, 'assistant-1', { credentials, fetch, workId: 'test-work', objective: 'Fix the current project' });
  assert.equal(accepted.accepted, true);
  assert.ok(sent[0].url.endsWith('/sentinel/chat-requirements/prepare'));
  assert.ok(sent[1].url.endsWith('/sentinel/chat-requirements/finalize'));
  assert.equal(JSON.parse(sent[1].options.body).prepare_token, 'test-prepare');
  assert.ok(sent[2].url.endsWith('/f/conversation/prepare'));
  const prepare = JSON.parse(sent[2].options.body);
  assert.equal(sent[2].options.headers['openai-sentinel-chat-requirements-token'], 'test-requirement');
  const payload = JSON.parse(sent[3].options.body);
  assert.equal(payload.messages[0].id, prepare.message_id);
  assert.equal(payload.parent_message_id, 'assistant-1');
  assert.equal(payload.conversation_id, ID);
  assert.match(payload.messages[0].content.parts[0], /test-work/);
  const challenged = async url => url.includes('/chat-requirements/prepare')
    ? response({ prepare_token: 'test-prepare', proofofwork: { required: true } })
    : response({ token: 'test-requirement' });
  await assert.rejects(() => sendContinue(ID, 'assistant-1', { credentials, fetch: challenged, workId: 'test-work', objective: 'Fix the current project' }), error =>
    error?.challenge?.phase === 'prepare' && error?.challenge?.types?.join(',') === 'proof-of-work'
      && /proof-of-work/.test(error.message) && !/interactive/.test(error.message));
});

test('challenge types are accurate and sanitized; no incomplete request reaches submission', async () => {
  const cases = [
    [{ proofofwork: { required: true, seed: 'secret-seed', difficulty: 'hidden' } }, 'prepare', ['proof-of-work']],
    [{ turnstile: { required: true, dx: 'secret-dx' }, so: { required: true, collector_dx: 'hidden' } }, 'prepare', ['Turnstile', 'so']],
    [{ arkose: { required: true, token: 'secret-token' } }, 'finalize', ['Arkose']]
  ];
  for (const [challenge, phase, types] of cases) {
    const paths = [];
    const fetch = async url => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path.endsWith('/chat-requirements/prepare')) return response({ prepare_token: 'secret-prepare', ...(phase === 'prepare' ? challenge : {}) });
      if (path.endsWith('/chat-requirements/finalize')) return response({ token: 'secret-finalize', ...(phase === 'finalize' ? challenge : {}) });
      throw new Error('Conversation prepare or submit must not be called when challenged.');
    };
    await assert.rejects(() => sendContinue(ID, 'assistant-1', {
      credentials, fetch, workId: 'test-work', objective: 'Safe verification test'
    }), error => {
      assert.deepEqual(error.challenge, { phase, types });
      assert.deepEqual(Object.keys(error.challenge).sort(), ['phase', 'types']);
      assert.ok(types.every(type => error.message.includes(type)));
      assert.doesNotMatch(error.message + JSON.stringify(error.challenge), /secret|hidden|difficulty|seed|dx|token/i);
      return true;
    });
    assert.equal(paths.length, phase === 'prepare' ? 1 : 2);
  }
  await assert.rejects(() => sendContinue(ID, 'assistant-1', {
    credentials, workId: 'test-work', objective: 'Safe verification test', fetch: async url =>
      url.endsWith('/prepare') ? response({ prepare_token: 'secret-prepare' }) : response({})
  }), /finalization returned no token/);
});

test('authorized Goal Mode status exposes only challenge kinds and clears them on restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relai-goal-challenge-'));
  try {
    const config = { stateDir: dir };
    const context = { principal: 'test-principal', requestTaskContext: { session: {
      status: 'planning', workspace: 'sample', objective: 'Safe verification test'
    } } };
    const args = { work_id: 'challenge-test', objective: 'Safe verification test', conversationUrl: 'https://chatgpt.com/c/' + ID };
    activateGoal(config, args, context);
    withStateDatabase(config, db => {
      const key = 'chatgpt_goal:challenge-test';
      const original = JSON.parse(db.prepare('SELECT value FROM state_meta WHERE key=?').get(key).value);
      db.prepare('UPDATE state_meta SET value=? WHERE key=?').run(JSON.stringify({ ...original, active: false,
        state: 'paused', error: 'ChatGPT requires proof-of-work; Goal Mode paused.',
        challenge: { phase: 'prepare', types: ['proof-of-work'] } }), key);
    }, { transaction: true });
    assert.deepEqual(goalStatus(config, args, context).challenge, { phase: 'prepare', types: ['proof-of-work'] });
    assert.equal(dashboardGoalStatus(config, args.work_id).error, 'ChatGPT requires proof-of-work; Goal Mode paused.');
    assert.equal(activateGoal(config, args, context).challenge, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP 422 identifies the rejected stage without exposing response content or retrying', async () => {
  const stages = [
    ['chat requirements', '/backend-api/sentinel/chat-requirements/prepare'],
    ['chat requirements', '/backend-api/sentinel/chat-requirements/finalize'],
    ['conversation preparation', '/backend-api/f/conversation/prepare'],
    ['message submission', '/backend-api/f/conversation']
  ];
  for (const [index, [stage, path]] of stages.entries()) {
    const requested = [];
    const fetch = async url => {
      const name = new URL(url).pathname;
      requested.push(name);
      if (name === path) return { ok: false, status: 422, text: async () => 'sensitive account-equivalent data' };
      if (name.endsWith('/chat-requirements/prepare')) return response({ prepare_token: 'test-prepare', proofofwork: { required: false } });
      if (name.endsWith('/chat-requirements/finalize')) return response({ token: 'test-requirement' });
      if (name.includes('/prepare')) return response({ conduit_token: 'test-conduit' });
      return response('event: message\\ndata: {}\\n\\n');
    };
    await assert.rejects(
      () => sendContinue(ID, 'assistant-1', { credentials, fetch, workId: 'work', objective: 'test' }),
      error => error?.status === 422 && error?.stage === stage
        && error.message.includes('HTTP 422') && !error.message.includes('sensitive')
    );
    assert.equal(requested.at(-1), path, 'the adapter must stop at the first failed protocol stage');
    assert.equal(requested.length, index + 1);
  }
  const nativeRequests = [];
  await assert.rejects(() => sendContinue(ID, 'assistant-1', {
    workId: 'work', objective: 'test', nativeTransport: async request => {
      nativeRequests.push(request);
      return { ok: false, status: 422, body: 'never disclose account or conversation data' };
    }
  }), error => /could not be verified/.test(error?.message)
    && !error.message.includes('account or conversation data'));
  assert.deepEqual(nativeRequests.map(request => request.action), ['continue'],
    'native failures must not retry or fall back to protocol message submission');
});