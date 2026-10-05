// Rendered navigation, modal, and accessibility workflows live in dashboard-browser-acceptance.mjs
// and filter-experience-browser.mjs. This suite keeps model, diagnostic rendering, and unique safety contracts.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OperationDiagnostics, RuntimeBuildIdentity } from '../src/ui/components/operation-diagnostics.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESKTOP_NAV_ITEMS, MOBILE_MORE_NAV_ITEMS, MOBILE_NAV_ITEMS, MOBILE_PRIMARY_NAV_ITEMS, SETTINGS_NAV_ITEMS, navigationCommands, routeMetadata } from '../src/ui/navigation-catalog.js';
import { normalizeRouteKey } from '../src/ui/route-policy.js';
import { repositorySummary } from '../src/ui/features/workspaces/model.js';
import { advanceDeveloperUnlockClicks, runtimeCompatibilityNotice } from '../src/ui/features/settings/react.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const settingsReact = read('src/ui/features/settings/react.js');
const reactShell = read('src/ui/react/main.js');

assert.match(settingsReact, /about-runtime-mismatch/, 'Runtime/source skew needs a bounded developer-facing notice instead of staying invisible');
assert.match(settingsReact, /Beta \/ pre-release \(developers & testers\)/, 'the beta release option must identify its developer/tester audience before selection');
assert.match(settingsReact, /updateChannel === 'beta' \? h\('div', \{[\s\S]*className: 'application-update-beta-warning'[\s\S]*role: 'alert'/, 'selecting beta must show a prominent accessible warning');
assert.match(settingsReact, /serious bugs or incomplete changes/i, 'the beta warning must state the risk of severe breakage plainly');
assert.match(settingsReact, /reinstall if a beta build fails/i, 'the beta warning must preserve the recovery consequence');
assert.match(settingsReact, /Use Stable for normal work/, 'the beta warning must clearly recommend Stable for normal use');
assert.equal(runtimeCompatibilityNotice(
  { applicationVersion: '1.1.3' },
  { applicationVersion: '1.1.3' },
  { available: true, metadataMatches: true }
), null, 'matching runtime/source metadata must stay silent');
assert.equal(runtimeCompatibilityNotice(
  { applicationVersion: '1.1.4' },
  { applicationVersion: '1.1.4' },
  { available: true, metadataMatches: false, compatible: true, restartRequired: false }
), null, 'same-version compatible metadata drift must not produce a false runtime/source warning');
const restartNotice = runtimeCompatibilityNotice(
  { applicationVersion: '1.1.2' },
  { applicationVersion: '1.1.3' },
  { available: true, metadataMatches: false, restartRequired: true, activeTasksPreventRestart: false }
);
assert.match(restartNotice?.message || '', /Restart Rel\.AI.*current source/i, 'restart-required skew must tell developers how to load the current source');
const blockedRestartNotice = runtimeCompatibilityNotice(
  { applicationVersion: '1.1.2' },
  { applicationVersion: '1.1.3' },
  { available: true, metadataMatches: false, restartRequired: true, activeTasksPreventRestart: true }
);
assert.match(blockedRestartNotice?.message || '', /Finish active tasks before restarting/i, 'active work must suppress misleading immediate-restart guidance');
const extensionsReact = read('src/ui/features/extensions/react.js');
const homeReact = read('src/ui/features/home/react.js');
const activityReact = read('src/ui/features/activity/react.js');
const browserReact = read('src/ui/features/browser/react.js');

assert.match(browserReact, /Sign-ins are remembered unless ChatGPT explicitly starts a private session/, 'Browser empty state must explain persistent login behavior');
assert.match(browserReact, /Private session/, 'Ephemeral browser sessions must visibly identify private mode');
assert.match(browserReact, /Enter passwords and verification codes here, not in ChatGPT/, 'Browser handoff must direct sensitive sign-in input to the local browser');
assert.match(browserReact, /Allow for this session/, 'Site permission requests must require an explicit session-scoped user decision');
assert.doesNotMatch(browserReact, /Clear all saved browser data|Clear all browser data/, 'The Browser empty state must stay focused on live browsing instead of destructive saved-data management');
assert.match(settingsReact, /Remember site sign-ins/, 'Privacy & data must explain the default remembered-sign-in behavior');
assert.match(settingsReact, /dedicated browser profile/, 'Privacy & data must distinguish Rel.AI browser state from the user\'s normal browser profile');
assert.match(settingsReact, /personal Chrome profile/, 'Privacy & data must make clear that Rel.AI does not automatically attach the user\'s Chrome profile');
assert.match(settingsReact, /Remove saved data for \$\{site\.host\}/, 'Privacy & data must support removing one saved site without clearing unrelated browser data');
assert.match(settingsReact, /Clear all browser data/, 'Privacy & data must retain an explicit all-sites reset');

const desktopNavIds = DESKTOP_NAV_ITEMS.map(item => item.id);
const mobileNavIds = MOBILE_NAV_ITEMS.map(item => item.id);
assert.deepEqual(mobileNavIds, desktopNavIds, 'desktop and mobile navigation must keep the same reachable destinations');
assert.deepEqual(MOBILE_PRIMARY_NAV_ITEMS.map(item => item.id), ['home', 'tasks', 'workspaces', 'activity']);
assert.deepEqual(MOBILE_MORE_NAV_ITEMS.map(item => item.id), ['code', 'browser', 'system', 'settings']);
assert.equal(new Set(desktopNavIds).size, desktopNavIds.length, 'primary navigation destinations must be unique');
for (const required of ['home', 'tasks', 'workspaces', 'activity', 'browser', 'system', 'settings']) assert.ok(desktopNavIds.includes(required), `${required} must remain reachable`);
assert.ok(!desktopNavIds.includes('extensions'), 'Extensions must stay out of normal navigation while the feature is experimental');
assert.ok(DESKTOP_NAV_ITEMS.every(item => String(item.label || '').trim()), 'every navigation destination must have a label');
assert.equal(DESKTOP_NAV_ITEMS.find(item => item.id === 'system')?.href, '#processes');
assert.equal(DESKTOP_NAV_ITEMS.find(item => item.id === 'system')?.label, 'System');
assert.equal(routeMetadata('extensions').id, 'extensions', 'Extensions must remain a valid hidden route');
assert.ok(!navigationCommands().some(item => item.id === 'extensions'), 'Extensions must stay out of quick navigation by default');
assert.ok(navigationCommands({ includeExtensions: true }).some(item => item.id === 'extensions'), 'The Extensions feature flag must add Extensions to quick navigation');
const settingsNavIds = SETTINGS_NAV_ITEMS.map(item => item.id);
assert.deepEqual(settingsNavIds, ['connection', 'preferences', 'privacy', 'application', 'about'], 'Settings must follow connection, preferences, privacy/data, app lifecycle, then about');
assert.equal(SETTINGS_NAV_ITEMS.find(item => item.id === 'connection')?.href, '#settings/connection');
assert.equal(normalizeRouteKey('settings/privacy'), 'settings/privacy', 'Privacy & data must be a canonical settings route instead of falling back to Overview');
assert.match(extensionsReact, /confirmPermissions: true/, 'Extension installation must require permission review confirmation');
assert.match(settingsReact, /developerOptionsUnlocked \? h\(DeveloperOptions, \{/, 'Developer options must stay hidden until they are unlocked');
assert.match(settingsReact, /writeDeveloperFeatureEnabled\(feature, enabled\)/, 'Developer feature changes must persist independently');
assert.doesNotMatch(settingsReact, /label: 'Developer mode'/, 'Developer options must not use a global Developer mode toggle');
assert.match(reactShell, /extensionsEnabled \? h\(NavLink, \{ item: EXTENSIONS_NAV_ITEM/, 'The Extensions flag must expose Extensions in desktop navigation');
assert.match(reactShell, /extensionsEnabled \? \[\.\.\.MOBILE_MORE_NAV_ITEMS, EXTENSIONS_NAV_ITEM\]/, 'The Extensions flag must expose Extensions in mobile navigation');
let unlockState = {};
for (const now of [1000, 1400, 1800, 2200]) {
  unlockState = advanceDeveloperUnlockClicks(unlockState, now);
  assert.equal(unlockState.unlocked, false);
}
unlockState = advanceDeveloperUnlockClicks(unlockState, 2600);
assert.equal(unlockState.unlocked, true, 'The fifth fast build click must unlock developer options');
let expiredUnlockState = advanceDeveloperUnlockClicks({}, 1000);
expiredUnlockState = advanceDeveloperUnlockClicks(expiredUnlockState, 4000);
assert.equal(expiredUnlockState.count, 1, 'Slow build clicks must restart the unlock sequence');
assert.equal(expiredUnlockState.unlocked, false);
assert.match(settingsReact.match(/function PrivacyDataPage[\s\S]*?function BrowserDataSettings/)?.[0] || '', /ComputerControlSettings/, 'Privacy & data must own computer-control permission');
assert.match(settingsReact, /typeof desktop\?\.quitApp === 'function'/, 'App settings must expose Quit only inside the installed desktop app');
assert.match(settingsReact, /Quit Rel\.AI MCP/, 'App settings must provide a graceful desktop quit action');
assert.match(homeReact, /state\.tasks\.filter\(task => workSessionStateView\(task\)\.terminal === true\)/, 'Latest tasks must avoid duplicating active tasks already summarized above');
assert.deepEqual(repositorySummary({ exists: true, isGit: false }), {
  kindLabel: 'Folder',
  label: 'Local folder',
  description: 'File and command actions are available. Git actions are unavailable.',
  tone: 'neutral'
}, 'ordinary authorized folders must not be presented as broken repositories');
assert.equal(repositorySummary({ exists: true, isGit: true, branch: 'main' }).kindLabel, 'Repository');
assert.match(activityReact, /const fileLocation = activityFileLocation\(entry\)/, 'Activity details must derive the successful local file destination');
assert.match(activityReact, /readableSection\('File location', fileLocationText\)/, 'Activity details must expose successful local file destinations without requiring Technical details');
assert.match(activityReact, /command \? h\(CommandDetail, \{ command \}\) : null/, 'Activity details must expose the full recorded command without requiring Technical details');

console.log('Dashboard UI ownership contracts passed.');

// Render the actual shared inspector component, including older uninstrumented events.
const renderDiagnostics = props => renderToStaticMarkup(React.createElement(OperationDiagnostics, props));
const legacyDiagnostics = renderDiagnostics({ operation: { status: 'completed' } });
assert.match(legacyDiagnostics, /Operation ended/);
assert.match(legacyDiagnostics, /Unknown/);
assert.doesNotMatch(legacyDiagnostics, /role="status"|data-clock-elapsed-start/, 'historical/unknown records must not announce or run a live clock');
const liveDiagnostics = renderDiagnostics({ live: true, operation: { id: 'operation-wait', metadata: { timeline: {
  phase: 'queued', phaseStartedAt: '2026-10-05T01:00:00Z', executed: false,
  blocking: { owner: '<script>untrusted owner</script>', operationId: 'owner-op' },
  phases: [{ phase: 'accepted', durationMs: 123, endedAt: '2026-10-05T01:00:00Z' }]
} } } });
assert.match(liveDiagnostics, /Waiting for this owner/);
assert.match(liveDiagnostics, /<details><summary>Details<\/summary>/, 'diagnostic disclosure must use native keyboard-operable semantics');
assert.match(liveDiagnostics, /role="status" aria-atomic="true"/);
assert.doesNotMatch(liveDiagnostics.match(/role="status"[\s\S]*?<\/div>/)?.[0] || '', /data-clock-elapsed-start/, 'elapsed clocks must not create second-by-second live announcements');
assert.match(liveDiagnostics, /data-clock-elapsed-start/);
assert.match(liveDiagnostics, /123 ms/);
assert.match(liveDiagnostics, /&lt;script&gt;untrusted owner&lt;\/script&gt;/);
assert.doesNotMatch(liveDiagnostics, /<script>/, 'backend diagnostic labels must render as escaped text');
const readyDiagnostics = renderDiagnostics({ live: true, operation: { timeline: { phase: 'result-ready', terminationCertainty: 'unconfirmed' } } });
assert.match(readyDiagnostics, /Result ready/);
assert.match(readyDiagnostics, /termination is unconfirmed/);
assert.doesNotMatch(readyDiagnostics, /data-clock-elapsed-start/);
const buildDiagnostics = renderToStaticMarkup(React.createElement(RuntimeBuildIdentity, {
  runtime: { buildIdentity: { buildId: 'runtime-a' } }, compatibility: { metadataMatches: true }
}));
assert.match(buildDiagnostics, /Runtime: runtime-a/);
assert.match(buildDiagnostics, /Source\/build parity<\/dt><dd>Unknown/);
assert.match(buildDiagnostics, /role="tooltip"/);
