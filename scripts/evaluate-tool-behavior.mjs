import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function evaluateToolBehavior(expectations, observations) {
  const expected = normalizeCases(expectations, 'expectation');
  const actual = normalizeCases(observations, 'observation');
  const byId = new Map(actual.map(item => [item.id, item]));
  const failures = [];

  for (const item of expected) {
    const observed = byId.get(item.id);
    if (!observed) {
      failures.push(failure(item, 'missing_observation', 'No recorded tool-selection observation matched this case.'));
      continue;
    }
    const used = new Set(observed.tools);
    for (const tool of item.expectedTools) {
      if (!used.has(tool)) failures.push(failure(item, 'missing_tool', `Expected ${tool} to be selected.`));
    }
    for (const tool of item.forbiddenTools) {
      if (used.has(tool)) failures.push(failure(item, 'forbidden_tool', `Observed forbidden tool ${tool}.`));
    }
    if (!sameSet(item.renderedTools, observed.renderedTools)) {
      failures.push(failure(item, 'render_boundary', `Expected rendered tools ${JSON.stringify(item.renderedTools)} but observed ${JSON.stringify(observed.renderedTools)}.`));
    }
    if (observed.tools.some(tool => tool.startsWith('relai_app_'))) {
      failures.push(failure(item, 'app_only_tool', 'An app-only helper was model-selected.'));
    }
    if (item.maxCalls != null && observed.tools.length > item.maxCalls) {
      failures.push(failure(item, 'excessive_calls', `Observed ${observed.tools.length} tool calls; scenario limit is ${item.maxCalls}.`));
    }
    const duplicateCalls = Math.max(0, observed.tools.length - new Set(observed.tools).size);
    if (item.maxDuplicateCalls != null && duplicateCalls > item.maxDuplicateCalls) {
      failures.push(failure(item, 'duplicate_calls', `Observed ${duplicateCalls} duplicate tool calls; scenario limit is ${item.maxDuplicateCalls}.`));
    }
  }

  const failedKeys = new Set(failures.map(item => item.id));
  return { ok: failures.length === 0, evaluated: expected.length, passed: expected.length - failedKeys.size, failed: failedKeys.size, failures };
}

function assertToolBehavior(report) {
  if (report?.ok) return report;
  const lines = (report?.failures || []).map(item => `${item.id} [${item.kind}]: ${item.message}`);
  throw new Error(`Tool behavior evaluation failed:\n- ${lines.join('\n- ')}`);
}

function normalizeCases(value, label) {
  if (!Array.isArray(value)) throw new Error(`Tool behavior ${label}s must be a JSON array.`);
  const seen = new Set();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} ${index + 1} must be an object.`);
    const id = String(raw.id || '').trim();
    if (!id) throw new Error(`${label} ${index + 1} requires id.`);
    if (seen.has(id)) throw new Error(`Duplicate tool behavior ${label} id: ${id}`);
    seen.add(id);
    return {
      ...raw,
      id,
      prompt: String(raw.prompt || '').trim(),
      expectedTools: stringArray(raw.expectedTools),
      forbiddenTools: stringArray(raw.forbiddenTools),
      tools: label === 'observation' ? stringList(raw.tools) : stringArray(raw.tools),
      renderedTools: stringArray(raw.renderedTools),
      maxCalls: optionalNonNegativeInteger(raw.maxCalls, `${label} ${id} maxCalls`),
      maxDuplicateCalls: optionalNonNegativeInteger(raw.maxDuplicateCalls, `${label} ${id} maxDuplicateCalls`)
    };
  });
}

function stringList(value) {
  return Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(Boolean) : [];
}

function stringArray(value) {
  return [...new Set(stringList(value))];
}

function optionalNonNegativeInteger(value, label) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${label} must be a non-negative integer.`);
  return number;
}

function sameSet(left, right) {
  if (left.length !== right.length) return false;
  const values = new Set(right);
  return left.every(value => values.has(value));
}

function failure(item, kind, message) {
  return { id: item.id, scenario: item.scenario || '', prompt: item.prompt, kind, message };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const expectationFile = process.argv[2];
  const observationFile = process.argv[3];
  if (!expectationFile || !observationFile) {
    console.error('Usage: node scripts/evaluate-tool-behavior.mjs <expectations.json> <recorded-observations.json>');
    process.exitCode = 2;
  } else {
    const report = evaluateToolBehavior(readJson(expectationFile), readJson(observationFile));
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  }
}

export { assertToolBehavior, evaluateToolBehavior };
