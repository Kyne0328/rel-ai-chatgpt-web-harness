import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function evaluateSkillBehavior(expectations, observations) {
  const expected = normalizeCases(expectations, 'expectation');
  const actual = normalizeCases(observations, 'observation', { requireExpectations: false });
  const byKey = new Map(actual.map(item => [caseKey(item), item]));
  const failures = [];

  for (const item of expected) {
    const key = caseKey(item);
    const observed = byKey.get(key);
    if (!observed) {
      failures.push(failure(item, 'missing_observation', 'No recorded agent observation matched this behavior case.'));
      continue;
    }

    if (!sameArray(item.skills, observed.skills)) {
      failures.push(failure(item, 'skills', `Expected skills ${JSON.stringify(item.skills)} but observed ${JSON.stringify(observed.skills)}.`));
    }
    if ((item.firstTool ?? null) !== (observed.firstTool ?? null)) {
      failures.push(failure(item, 'first_tool', `Expected first tool ${JSON.stringify(item.firstTool ?? null)} but observed ${JSON.stringify(observed.firstTool ?? null)}.`));
    }
    if ((item.firstAction ?? null) !== (observed.firstAction ?? null)) {
      failures.push(failure(item, 'first_action', `Expected first action ${JSON.stringify(item.firstAction ?? null)} but observed ${JSON.stringify(observed.firstAction ?? null)}.`));
    }
    if (item.forbiddenTool) {
      const usedTools = new Set([observed.firstTool, ...(observed.tools || [])].filter(Boolean));
      if (usedTools.has(item.forbiddenTool)) {
        failures.push(failure(item, 'forbidden_tool', `Observed forbidden tool ${item.forbiddenTool}.`));
      }
    }
  }

  return {
    ok: failures.length === 0,
    evaluated: expected.length,
    passed: expected.length - new Set(failures.map(item => item.key)).size,
    failed: new Set(failures.map(item => item.key)).size,
    failures
  };
}

function assertSkillBehavior(report) {
  if (report?.ok) return report;
  const lines = (report?.failures || []).map(item => `${item.key} [${item.kind}]: ${item.message}`);
  throw new Error(`Skill behavior evaluation failed:\n- ${lines.join('\n- ')}`);
}

function normalizeCases(value, label, options = {}) {
  if (!Array.isArray(value)) throw new Error(`Skill behavior ${label}s must be a JSON array.`);
  const seen = new Set();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} ${index + 1} must be an object.`);
    const prompt = String(raw.prompt || '').trim();
    const id = String(raw.id || '').trim();
    if (!id && !prompt) throw new Error(`${label} ${index + 1} requires id or prompt.`);
    const key = id || prompt;
    if (seen.has(key)) throw new Error(`Duplicate skill behavior ${label} key: ${key}`);
    seen.add(key);
    const skills = normalizeSkills(raw.skills, `${label} ${key}`);
    const firstTool = nullableString(raw.firstTool);
    const firstAction = nullableString(raw.firstAction);
    const tools = Array.isArray(raw.tools) ? raw.tools.map(value => String(value || '').trim()).filter(Boolean) : [];
    const taskMode = normalizeTaskMode(raw.taskMode, skills.length ? 'required' : 'none', `${label} ${key}`);
    if (options.requireExpectations !== false) {
      if (skills.length === 0 && taskMode !== 'none') throw new Error(`${label} ${key} without repository skills must use taskMode "none".`);
      if (skills.length === 0 && (firstTool !== null || firstAction !== null)) throw new Error(`${label} ${key} without repository skills must not expect a repository tool call.`);
      if (taskMode === 'required' && (firstTool !== 'relai_work' || firstAction !== 'begin')) {
        throw new Error(`${label} ${key} requires a durable task and must expect relai_work begin first.`);
      }
      if (taskMode === 'existing' && firstTool === 'relai_work' && firstAction === 'begin') {
        throw new Error(`${label} ${key} continues an existing task and must not expect a new relai_work begin.`);
      }
    }
    return {
      ...raw,
      id,
      prompt,
      skills,
      firstTool,
      firstAction,
      taskMode,
      tools,
      forbiddenTool: nullableString(raw.forbiddenTool)
    };
  });
}

function normalizeTaskMode(value, fallback, label) {
  const mode = String(value || fallback).trim().toLowerCase();
  if (!['required', 'optional', 'existing', 'none'].includes(mode)) {
    throw new Error(`${label} has invalid taskMode ${JSON.stringify(value)}.`);
  }
  return mode;
}

function normalizeSkills(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} requires a skills array.`);
  const skills = value.map(item => String(item || '').trim()).filter(Boolean);
  if (new Set(skills).size !== skills.length) throw new Error(`${label} contains duplicate skills.`);
  return skills;
}

function caseKey(item) {
  return item.id || item.prompt;
}

function failure(item, kind, message) {
  return { key: caseKey(item), scenario: item.scenario || '', prompt: item.prompt, kind, message };
}

function nullableString(value) {
  if (value == null || value === '') return null;
  return String(value).trim() || null;
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const expectationFile = process.argv[2];
  const observationFile = process.argv[3];
  if (!expectationFile || !observationFile) {
    console.error('Usage: node scripts/evaluate-skill-behavior.mjs <expectations.json> <recorded-observations.json>');
    process.exitCode = 2;
  } else {
    const report = evaluateSkillBehavior(readJson(expectationFile), readJson(observationFile));
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
}

export { assertSkillBehavior, evaluateSkillBehavior };
