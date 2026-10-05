import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  THEME_NAMES,
  COLOR_THEMES,
  semanticEntries,
  renderDashboardTokenCss,
  renderElectronTokenCss,
  renderColorReferenceSvg,
  contrastRatio
} from '../src/ui/colorTokens.mjs';
import { pillClass } from '../src/ui/components/pill.js';
import { statusDotClass, statusTone } from '../src/ui/status-tone.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function expectContrast(themeName, foregroundRole, backgroundRole, threshold) {
  const theme = COLOR_THEMES[themeName];
  const ratio = contrastRatio(theme[foregroundRole], theme[backgroundRole]);
  assert.ok(
    ratio >= threshold,
    `${themeName}.${foregroundRole} on ${backgroundRole} is ${ratio.toFixed(2)}:1; expected at least ${threshold}:1`
  );
}

function expectNeutralHex(value, label) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value));
  assert.ok(match, `${label} must be a six-digit hex color`);
  const [red, green, blue] = [match[1].slice(0, 2), match[1].slice(2, 4), match[1].slice(4, 6)];
  assert.equal(red, green, `${label} must remain neutral rather than tinted`);
  assert.equal(green, blue, `${label} must remain neutral rather than tinted`);
}

function expectNeutralGradient(value, label) {
  const channels = [...String(value).matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi)];
  assert.ok(channels.length > 0, `${label} must contain explicit RGB color stops`);
  for (const [, red, green, blue] of channels) {
    assert.equal(red, green, `${label} must not add a color cast`);
    assert.equal(green, blue, `${label} must not add a color cast`);
  }
}

assert.deepEqual(THEME_NAMES, ['dark', 'light']);
for (const role of ['canvas', 'surfacePrimary', 'surfaceSecondary', 'surfaceRaised', 'selectionBackground']) {
  expectNeutralHex(COLOR_THEMES.dark[role], `dark.${role}`);
}
expectNeutralGradient(COLOR_THEMES.dark.electronAppGradient, 'dark.electronAppGradient');
assert.notEqual(COLOR_THEMES.dark.actionPrimary, COLOR_THEMES.dark.statusInfoForeground, 'brand actions and informational state must remain semantically distinct');
assert.notEqual(COLOR_THEMES.dark.actionPrimary, COLOR_THEMES.dark.surfacePrimary, 'primary actions must remain visually distinct from dark surfaces');
assert.notEqual(COLOR_THEMES.light.actionPrimary, COLOR_THEMES.light.surfacePrimary, 'primary actions must remain visually distinct from light surfaces');
assert.notEqual(COLOR_THEMES.dark.selectionBackground, COLOR_THEMES.dark.statusInfoBackground, 'selection feedback must not reuse informational state styling');
assert.deepEqual(
  Object.keys(COLOR_THEMES.dark).sort(),
  Object.keys(COLOR_THEMES.light).sort(),
  'light and dark themes must expose identical semantic roles'
);

for (const themeName of THEME_NAMES) {
  for (const foreground of ['textPrimary', 'textSecondary', 'textTertiary']) {
    for (const background of ['surfacePrimary', 'surfaceSecondary']) {
      expectContrast(themeName, foreground, background, 4.5);
    }
  }
  for (const background of ['actionPrimary', 'actionPrimaryHover', 'actionPrimaryActive']) {
    expectContrast(themeName, 'actionPrimaryForeground', background, 4.5);
  }
  for (const tone of ['Info', 'Success', 'Warning', 'Danger']) {
    expectContrast(themeName, `status${tone}Foreground`, `status${tone}Background`, 4.5);
  }
  for (const background of ['surfacePrimary', 'surfaceSecondary']) {
    expectContrast(themeName, 'focusRing', background, 3);
    expectContrast(themeName, 'borderControl', background, 3);
  }
}

for (const themeName of THEME_NAMES) {
  const defined = new Set(semanticEntries(themeName).map(([property]) => property));
  for (const relativePath of ['src/ui/styles/app.css', 'electron/renderer/app.css']) {
    for (const match of read(relativePath).matchAll(/var\((--ui-[a-z0-9-]+)/g)) {
      assert.ok(defined.has(match[1]), `${relativePath} references undefined semantic token ${match[1]}`);
    }
  }
}

assert.equal(read('src/ui/styles/color-tokens.css'), renderDashboardTokenCss(), 'dashboard color tokens must match the ESM manifest');
assert.equal(read('electron/renderer/color-tokens.css'), renderElectronTokenCss(), 'Electron color tokens must match the ESM manifest');
assert.equal(read('docs/color-system-reference.svg'), renderColorReferenceSvg(), 'the color reference SVG must match the ESM manifest');

const legacyProperties = [
  '--bg', '--surface', '--surface-2', '--surface-3', '--surface-subtle',
  '--text', '--text-muted', '--text-dim', '--muted', '--line', '--line-soft',
  '--blue', '--blue-dim', '--green', '--green-dim', '--yellow', '--yellow-dim',
  '--red', '--red-dim', '--accent', '--ring', '--scrollbar-track', '--scrollbar-thumb',
  '--scrollbar-thumb-hover', '--scrollbar-thumb-active', '--scrollbar-corner',
  '--shadow-window', '--shadow-popover', '--grad-surface', '--grad-accent', '--grad-app',
  '--elev-1', '--elev-2', '--glow-accent', '--glow-green'
];
for (const relativePath of [
  'src/ui/styles/app.css',
  'electron/renderer/app.css',
  'src/ui/styles/color-tokens.css',
  'electron/renderer/color-tokens.css'
]) {
  const source = read(relativePath);
  for (const property of legacyProperties) {
    assert.equal(source.includes(property), false, `${relativePath} retains removed compatibility property ${property}`);
  }
}

const authoredUiFiles = ['src/http/auth.ts', 'electron/dashboard-window.js'];
function collectUiFiles(relativeDirectory) {
  const directory = path.join(root, relativeDirectory);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) collectUiFiles(relativePath);
    else if (/\.(?:css|html|m?js|svg)$/i.test(entry.name)) authoredUiFiles.push(relativePath);
  }
}
collectUiFiles('src/ui');
collectUiFiles('electron/renderer');

const rawColorAllowList = new Set([
  'src/ui/colorTokens.mjs',
  'src/ui/styles/color-tokens.css',
  'electron/renderer/color-tokens.css'
]);
const literalPattern = /(?<!&)#[0-9a-f]{3,8}\b|rgba?\(|\brgb\(/i;
for (const relativePath of authoredUiFiles) {
  if (rawColorAllowList.has(relativePath)) continue;
  const content = read(relativePath);
  const twMatches = content.match(/\b(?:text|bg|border)-(?:zinc|slate|gray|neutral|stone)-(?:100|200|300|400|500|600|700|800|900)\b/g);
  if (twMatches) {
    throw new Error(`File ${relativePath} contains ${twMatches.length} hardcoded Tailwind color utilities bypassing tokens: ${twMatches.slice(0, 5).join(', ')}`);
  }
  assert.doesNotMatch(content, literalPattern, `${relativePath} must consume semantic tokens or generated CSS instead of raw colors`);
}

assert.equal(fs.existsSync(path.join(root, 'src/ui/colorTokens.js')), false, 'the CommonJS color module must be deleted');
const manifestSource = read('src/ui/colorTokens.mjs');
const generatorSource = read('scripts/generate-color-tokens.mjs');
assert.match(manifestSource, /export const COLOR_THEMES/);
assert.doesNotMatch(manifestSource, /module\.exports|\brequire\s*\(/);
assert.match(generatorSource, /from '\.\.\/src\/ui\/colorTokens\.mjs'/);
assert.doesNotMatch(generatorSource, /createRequire|\brequire\s*\(/);
assert.doesNotMatch(generatorSource, /LEGACY_ALIASES/);

const dashboardCss = read('src/ui/styles/app.css');
const systemCss = read('src/ui/features/system/styles.css');
assert.match(dashboardCss, /\.status-pill\.open, \.status-pill\.working, \.status-pill\.waiting[\s\S]*--ui-status-info-foreground/);
assert.match(dashboardCss, /\.status-pill\.warn, \.status-pill\.incomplete[\s\S]*--ui-status-warning-foreground/);
assert.doesNotMatch(dashboardCss, /\.status-pill\.warn[^{]*\.status-pill\.working/);
assert.match(dashboardCss, /button\.primary[\s\S]*--ui-action-primary-foreground/);
assert.match(dashboardCss, /button:disabled[\s\S]*--ui-text-disabled/);
assert.doesNotMatch(systemCss, /--ui-surface-muted/, 'System UI must not reference an undefined semantic surface token');
assert.match(systemCss, /\.chatgpt-first-prompt[^{]*\{[^}]*--ui-surface-secondary/s, 'ChatGPT first-prompt guidance must use a defined semantic surface token');

const electronCss = read('electron/renderer/app.css');
assert.match(electronCss, /button\.primary[\s\S]*--ui-action-primary-foreground/);
assert.match(electronCss, /status-badge\.connecting::before[^}]*--ui-status-info-foreground/);
assert.match(electronCss, /status-badge\.working::before[\s\S]*--ui-status-info-foreground/);
assert.match(electronCss, /status-badge\.waiting::before[\s\S]*--ui-status-info-foreground/);
assert.match(electronCss, /status-health-card\.connecting \.health-dot[^}]*--ui-status-info-foreground/);

for (const relativePath of ['electron/renderer/status.html', 'electron/renderer/wizard.html']) {
  const html = read(relativePath);
  assert.ok(html.indexOf('color-tokens.css') < html.indexOf('app.css'), `${relativePath} must load generated tokens before component CSS`);
}

const auth = read('src/http/auth.ts');
assert.doesNotMatch(auth, /oauth|public\/oauth\.css/i, 'local dashboard authorization must not restore the removed OAuth UI');
const dashboardWindow = read('electron/dashboard-window.js');
const startupBackground = read('electron/startup-background.js');
assert.doesNotMatch(dashboardWindow, /colorTokens|getTheme\('dark'\)/);
assert.match(dashboardWindow, /backgroundColor:\s*STARTUP_BACKGROUND_COLOR/);
assert.match(startupBackground, /STARTUP_BACKGROUND_COLOR\s*=\s*'#[0-9a-f]{6}'/i);
assert.doesNotMatch(startupBackground, /colorTokens|getTheme|require\s*\(/);

assert.match(read('src/ui/components/toast.js'), /upsertToastOverlay/, 'toast helpers must publish into the React overlay store instead of rendering DOM directly');

const statusExpectations = Object.freeze({
  danger: [
    'blocked', 'validation_failed', 'failed', 'error', 'unavailable', 'needs attention'
  ],
  warning: [
    'waiting_for_approval', 'approval', 'input_required', 'degraded', 'paused', 'stale',
    'capability_mismatch', 'orphaned', 'not configured', 'warning', 'unsupported'
  ],
  information: [
    'queued', 'planning', 'running', 'validating', 'working', 'active', 'starting', 'stopping',
    'connecting', 'reconnecting', 'open', 'waiting', 'settling', 'info', 'live', 'checking',
    'downloading', 'installing'
  ],
  success: [
    'completed', 'succeeded', 'ready', 'passed', 'available', 'connected', 'exited', 'downloaded', 'up_to_date'
  ],
  neutral: [
    'cancelled', 'stopped', 'idle', 'inactive', 'expired', 'unknown', 'offline', 'disabled', 'disconnected'
  ]
});
const pillClasses = { danger: 'bad', warning: 'warn', information: 'working', success: 'ok', neutral: '' };
const dotClasses = { danger: 'bad', warning: 'warn', information: 'info', success: '', neutral: 'neutral' };
for (const [tone, statuses] of Object.entries(statusExpectations)) {
  for (const status of statuses) {
    assert.equal(statusTone(status), tone, `${status} must use the ${tone} semantic tone`);
    assert.equal(pillClass(status), pillClasses[tone], `${status} must use the expected pill class`);
    assert.equal(statusDotClass(status), dotClasses[tone], `${status} must use the expected dot class`);
  }
}

assert.match(systemCss, /\.diagnostic-finding\.warning[^}]*--ui-status-warning-foreground/);
assert.match(systemCss, /\.diagnostic-finding\.error[^}]*--ui-status-danger-foreground/);
assert.match(systemCss, /\.diagnostic-log-row\.info[^}]*--ui-status-info-foreground/);
assert.match(systemCss, /\.diagnostic-log-row\.warning[^}]*--ui-status-warning-foreground/);
assert.match(systemCss, /\.diagnostic-log-row\.error[^}]*--ui-status-danger-foreground/);
assert.match(dashboardCss, /\.dot\.neutral[^}]*--ui-status-neutral-foreground/);
assert.match(systemCss, /\.connection-summary-card\.working[^}]*--ui-status-info-foreground/);
assert.match(systemCss, /\.connection-path-step\.working \.connection-layer-dot[^}]*--ui-status-info-foreground/);
assert.match(systemCss, /\.connection-layer-state\.working[^}]*--ui-status-info-foreground/);

console.log('ESM color-system hard-cutover, contrast, exhaustive status-tone mapping, and raw-color checks passed.');
