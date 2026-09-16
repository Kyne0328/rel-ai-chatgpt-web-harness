import assert from 'node:assert/strict';
import { canonicalPathFor, normalizeRouteKey, routeAllowsParam } from '../src/ui/route-policy.js';

assert.equal(canonicalPathFor('settings/connection'), 'settings/connection');
assert.equal(canonicalPathFor('connection'), 'home');
assert.equal(canonicalPathFor('settings/diagnostics'), 'home');
assert.equal(canonicalPathFor('settings/general'), 'home');
assert.equal(canonicalPathFor('settings/dashboard'), 'home');
assert.equal(canonicalPathFor('settings/desktop'), 'home');
assert.equal(canonicalPathFor('missing'), 'home');
assert.equal(canonicalPathFor('tools'), 'tools');
assert.equal(canonicalPathFor('extensions'), 'extensions');
assert.equal(canonicalPathFor('settings/advanced'), 'home');
assert.equal(canonicalPathFor('settings/learning'), 'home');
assert.equal(canonicalPathFor('settings/memory'), 'home');
assert.equal(canonicalPathFor('settings/about'), 'settings/about');
assert.equal(canonicalPathFor('processes'), 'processes');
assert.equal(canonicalPathFor('usage'), 'usage');
assert.equal(canonicalPathFor('reference'), 'home');
assert.equal(canonicalPathFor('unknown/page'), 'home');

assert.equal(normalizeRouteKey('#activity?workspace=app&search=read&status=failed&time=24h'), 'activity?workspace=app&search=read&status=failed&time=24h');
assert.equal(normalizeRouteKey('activity?status=ok'), 'activity?status=ok');
assert.equal(normalizeRouteKey('activity?status=succeeded'), 'activity?status=succeeded');
assert.equal(normalizeRouteKey('activity?status=active'), 'activity?status=active');
assert.equal(normalizeRouteKey('activity?status=other'), 'activity?status=other');
assert.equal(normalizeRouteKey('tasks?workspace=app&task=task-123'), 'tasks?workspace=app&task=task-123', 'task deep links must preserve the selected task');
assert.equal(normalizeRouteKey('code?task=task-123&file=src/app.js'), 'code?task=task-123&file=src%2Fapp.js', 'Changes deep links must preserve the selected changed file');
const longFilePath = `src/${'nested/'.repeat(20)}${'a'.repeat(30)}.js`;
const normalizedLongFileRoute = normalizeRouteKey(`code?task=task-123&file=${encodeURIComponent(longFilePath)}`);
assert.equal(new URLSearchParams(normalizedLongFileRoute.split('?')[1]).get('file'), longFilePath, 'Changes deep links must preserve valid file paths longer than 160 characters');
assert.equal(normalizeRouteKey('activity?token=secret&search=hello'), 'activity?search=hello');
assert.equal(normalizeRouteKey('workspaces?focus=1'), 'workspaces');
assert.equal(normalizeRouteKey('workspaces?workspace=myapp&focus=1'), 'workspaces?workspace=myapp&focus=1');
assert.equal(normalizeRouteKey('workspaces?create=1'), 'workspaces?create=1', 'Add project deep links must preserve the create request');
assert.equal(normalizeRouteKey('workspaces?create=true'), 'workspaces', 'Add project deep links must reject non-canonical create values');
assert.equal(normalizeRouteKey('settings/connection?workspace=app'), 'settings/connection');
assert.equal(normalizeRouteKey('extensions?token=secret'), 'extensions');

assert.equal(routeAllowsParam('activity', 'search'), true);
assert.equal(routeAllowsParam('code', 'file'), true);
assert.equal(routeAllowsParam('workspaces', 'create'), true);
assert.equal(routeAllowsParam('activity', 'token'), false);
assert.equal(routeAllowsParam('settings', 'workspace'), false);

console.log('Route policy contracts passed.');
