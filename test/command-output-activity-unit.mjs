import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { processListView } from '../src/ui/features/processes/index.js';
import { commandOutputStatusAt } from '../src/ui/clock.js';

const now = Date.parse('2026-10-28T10:00:00Z');
const outputAt = '2026-10-28T09:59:50Z';
const command = { operationId: 'command-1', workId: 'work-1', workspace: 'app',
  status: 'running', commandSummary: 'node test/example.mjs',
  lastOutputAt: outputAt, lastOutputBytes: 250 };
const row = processListView({ commandOperations: [command] }, now).rows[0];
assert.equal(row.lastOutputAt, outputAt);
assert.equal(row.lastOutputBytes, 250);
assert.equal(commandOutputStatusAt(outputAt, now), 'Recent output · now');
assert.match(commandOutputStatusAt(outputAt, now + 60_000), /^No recent output · last received/);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src/ui/features/processes/react.js'), 'utf8');
const renderContext = {
  React: {
    Fragment: 'fragment',
    createElement(type, props, ...children) {
      return typeof type === 'function' ? type({ ...props, children }) : { type, props: props || {}, children };
    }
  },
  memo: component => component,
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  Icon: () => null,
  StatusPill: ({ label }) => label,
  useDeveloperFeatureEnabled: () => false,
  commandOutputStatusAt,
  routeHref: () => '#tasks',
  requestDashboardRefresh: () => {},
  processListView
};
vm.runInNewContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '')
  + '\nglobalThis.renderCommandRow = ProcessRow;', renderContext);
const flatten = node => {
  const found = [];
  const visit = value => {
    if (value == null) return;
    if (Array.isArray(value)) return value.forEach(visit);
    found.push(value);
    if (typeof value === 'object') (value.children || []).forEach(visit);
  };
  visit(node);
  return found;
};
const htmlNodes = flatten(renderContext.renderCommandRow({ row }));
assert.ok(htmlNodes.some(node => node?.props?.['data-clock-output-since'] === outputAt),
  'running command must expose its last output timestamp to the shared clock');
assert.ok(htmlNodes.includes(commandOutputStatusAt(outputAt)), 'initial text must match the actual wall-clock time until the shared clock updates');
const noOutput = processListView({ commandOperations: [{ operationId: 'command-2', status: 'running' }] }, now).rows[0];
assert.ok(flatten(renderContext.renderCommandRow({ row: noOutput })).includes('No output yet'));
const queued = processListView({ commandOperations: [{ operationId: 'command-3', status: 'queued' }] }, now).rows[0];
assert.equal(flatten(renderContext.renderCommandRow({ row: queued })).some(node =>
  node?.props?.['data-clock-output-since']), false, 'queued commands must not claim live output recency');
console.log('Command output activity display passed.');
