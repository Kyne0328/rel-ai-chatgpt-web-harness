import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { EXTENSIONS_REPOSITORY_URL, PERMISSION_METADATA, TABS, TEMPLATES } from '../src/ui/features/extensions/metadata.js';
import { parseExtensionManifest, PERMISSIONS } from '../src/extensions/registry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reactCode = fs.readFileSync(path.join(root, 'src/ui/features/extensions/react.js'), 'utf8');
const stylesCode = fs.readFileSync(path.join(root, 'src/ui/features/extensions/styles.css'), 'utf8');

// 1. Module/data boundaries
assert.match(reactCode, /function createExtensionsRoute\(\)/, 'React route factory remains defined in the frontend module');
assert.match(reactCode, /from '\.\/metadata\.js'/, 'React route consumes CSS-free extension metadata');
assert.equal(EXTENSIONS_REPOSITORY_URL, 'https://github.com/Kyne0328/rel-ai-extensions');
assert.match(reactCode, /EXTENSIONS_LOAD_TIMEOUT_MS = 30 \* 1000/, 'Extension catalog loading must outlive the backend catalog fetch timeout');
assert.match(reactCode, /EXTENSIONS_CACHE_TTL_MS = 15 \* 1000/, 'Extension remounts must reuse a short-lived catalog snapshot instead of cold-fetching every time');
assert.match(reactCode, /refresh[\s\S]*cache: 'no-store'[\s\S]*cacheTtlMs: EXTENSIONS_CACHE_TTL_MS/, 'Explicit Extension refreshes must bypass cache while ordinary route loads reuse the short-lived cache');
assert.match(reactCode, /invalidateCache\('\/api\/extensions'\)/, 'Extension mutations must invalidate the ordinary route cache before reloading installed state');
assert.match(reactCode, /timeout: EXTENSIONS_LOAD_TIMEOUT_MS/, 'Extension catalog GET requests must use the dedicated longer timeout');

assert.match(reactCode, /reviewFingerprint: entry\.reviewFingerprint/, 'Install requests must return the exact reviewed catalog fingerprint');
assert.match(reactCode, /version \$\{entry\.version\} from \$\{entry\.sourceName/, 'The permission prompt must identify the reviewed version and source');

// 2. CSS integration
assert.match(reactCode, /import '\.\/styles\.css';/, 'Extensions React module must own its feature stylesheet');
assert.match(stylesCode, /\.extensions-page/, 'styles.css must style extensions-page');
assert.match(stylesCode, /\.extensions-kpi-strip/, 'styles.css must style extensions-kpi-strip');
assert.match(stylesCode, /\.extension-pro-card/, 'styles.css must style extension-pro-card');
assert.match(stylesCode, /\.extensions-filter-toolbar/, 'styles.css must style extensions-filter-toolbar');
assert.match(stylesCode, /\.extensions-source-add-card/, 'styles.css must style the source add form');
assert.match(stylesCode, /\.extensions-source-card/, 'styles.css must style configured extension sources');

// 3. Permission coverage
for (const permission of PERMISSIONS) {
  assert.ok(
    Boolean(PERMISSION_METADATA[permission]?.label),
    `Extensions metadata must declare a label for permission '${permission}'`
  );
}

// 4. Manifest scaffolding templates in Developer tab
const templatesList = Object.values(TEMPLATES);
assert.ok(templatesList.length >= 3, 'Must provide at least 3 scaffolding templates (skill, cli binary, cli bundle)');

for (const template of templatesList) {
  assert.ok(template.label, 'Template must have a label');
  assert.ok(template.code, 'Template must provide JSON code');
  const parsed = JSON.parse(template.code);
  assert.ok(parsed.id, 'Scaffolding template must have an id');
  assert.ok(parsed.name, 'Scaffolding template must have a name');
  const validated = parseExtensionManifest(parsed);
  assert.equal(validated.id, parsed.id, 'Scaffolding template must strictly conform to extensionManifestSchema');
}

// 5. Accessibility & UX landmarks
assert.match(reactCode, /role: 'tablist'/);
assert.match(reactCode, /role: 'tabpanel'/);
assert.match(reactCode, /'aria-selected'/);
assert.match(reactCode, /'aria-controls'/);
assert.match(reactCode, /onKeyDown/);
assert.doesNotMatch(reactCode, /function ExtensionsKpiStrip/, 'Extensions must not restore the oversized KPI strip');
assert.match(reactCode, /Extensions add reusable skills and local tools to ChatGPT\./, 'Extensions must retain concise orientation copy');
assert.match(reactCode, /needsSetupCount/);
assert.match(reactCode, /Show setup needed/, 'Extensions must surface installed packages that still require setup');
assert.match(reactCode, /ExtensionsFilterToolbar/);
assert.match(reactCode, /ExtensionInspectorDialog/);
assert.ok(TABS.some(([id]) => id === 'sources'), 'Extensions navigation must expose source management');
assert.match(reactCode, /function SourcesPanel/);
assert.match(reactCode, /Add an extension source/);
assert.match(reactCode, /type: 'url'/, 'Source input must use native URL validation');
assert.match(reactCode, /action: 'add_source'/);
assert.match(reactCode, /action: 'remove_source'/);
assert.match(reactCode, /installed extension.*will stay installed/s, 'Source removal must explain that installed extensions are retained');

// 6. Selection semantics and keyboard-native field contracts.
const flatten = node => node == null || node === false ? [] : Array.isArray(node)
  ? node.flatMap(flatten)
  : typeof node === 'object' ? [node, ...flatten(node.children)] : [];
const textOf = node => node == null || node === false ? '' : Array.isArray(node)
  ? node.map(textOf).join('')
  : typeof node === 'object' ? textOf(node.children) : String(node);
const context = {
  React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
  Icon: () => null,
  OverlayFrame: () => null,
  Dialog: { Title: 'dialog-title', Description: 'dialog-description' },
  TABS, TEMPLATES, PERMISSION_METADATA,
  EXTENSION_SCHEMA_URL: 'https://example.test/schema',
  useMemo: compute => compute(),
  useEffect: () => {}
};
let slots = [];
let cursor = 0;
context.useState = initial => {
  const index = cursor++;
  if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
  return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
};
context.useRef = initial => context.useState(() => ({ current: initial }))[0];
vm.runInNewContext(
  reactCode.replace(/^import .*;\n/gm, '').replace(/^export \{.*\};$/m, '')
    + '\nglobalThis.components = { ExtensionsFilterToolbar, DeveloperPanel, ExtensionTabs, ExtensionInspectorDialog, ExtensionsLoadingSkeleton, Route: createExtensionsRoute() };',
  context
);
const render = (component, props = {}) => { cursor = 0; return component(props); };
let filterState = { activeTab: 'installed', searchQuery: '', filterKind: 'all', filterStatus: 'all', installedCount: 3 };
const toolbar = () => render(context.components.ExtensionsFilterToolbar, {
  ...filterState,
  setSearchQuery: value => { filterState.searchQuery = value; },
  setFilterKind: value => { filterState.filterKind = value; },
  setFilterStatus: value => { filterState.filterStatus = value; }
});
const button = (tree, label) => flatten(tree).find(node => node.type === 'button' && textOf(node) === label);
const group = (tree, label) => flatten(tree).find(node => node.props.role === 'group' && node.props['aria-label'] === label);
const pressedLabels = tree => flatten(tree).filter(node => node.type === 'button' && node.props['aria-pressed'] === true).map(textOf);
assert.deepEqual(pressedLabels(group(toolbar(), 'Extension type')), ['All types']);
assert.deepEqual(pressedLabels(group(toolbar(), 'Extension status')), ['All statuses']);
button(toolbar(), 'Skills').props.onClick();
assert.deepEqual(pressedLabels(group(toolbar(), 'Extension type')), ['Skills'], 'A selected type must be exposed as pressed');
button(toolbar(), 'Skills').props.onClick();
assert.deepEqual(pressedLabels(group(toolbar(), 'Extension type')), ['All types'], 'Selecting the active type must retain toggle-to-all behavior');
button(toolbar(), 'CLI tools').props.onClick();
button(toolbar(), 'Setup needed').props.onClick();
assert.deepEqual(pressedLabels(group(toolbar(), 'Extension type')), ['CLI tools']);
assert.deepEqual(pressedLabels(group(toolbar(), 'Extension status')), ['Setup needed']);
button(toolbar(), 'Setup needed').props.onClick();
assert.deepEqual(pressedLabels(group(toolbar(), 'Extension status')), ['All statuses'], 'Status toggles must clear independently of type');
button(toolbar(), 'Updates').props.onClick();
let search = flatten(toolbar()).find(node => node.type === 'input' && node.props.type === 'search');
const label = flatten(toolbar()).find(node => node.type === 'label' && node.props.htmlFor === search.props.id);
assert.equal(textOf(label), 'Search extensions', 'Search must have a persistent associated visible label');
search.props.onChange({ target: { value: 'sample' } });
assert.equal(textOf(flatten(toolbar()).find(node => node.type === 'label')), 'Search extensions', 'Typing must not replace the search name');
assert.match(textOf(toolbar()), /CLI tools; Updates; search: “sample”/, 'Filter summary identifies each chosen value');
button(toolbar(), 'Reset filters').props.onClick();
assert.equal(filterState.searchQuery, '');
assert.deepEqual(pressedLabels(group(toolbar(), 'Extension type')), ['All types']);
assert.deepEqual(pressedLabels(group(toolbar(), 'Extension status')), ['All statuses']);
filterState.activeTab = 'discover';
button(toolbar(), 'Installed').props.onClick();
assert.deepEqual(pressedLabels(group(toolbar(), 'Extension status')), ['Installed']);
button(toolbar(), 'Installed').props.onClick();
assert.deepEqual(pressedLabels(group(toolbar(), 'Extension status')), ['All statuses']);

slots = [];
let developer = render(context.components.DeveloperPanel, { installRoot: '' });
let radios = flatten(developer).filter(node => node.type === 'input' && node.props.type === 'radio');
assert.equal(radios.length, templatesList.length);
assert.equal(new Set(radios.map(node => node.props.name)).size, 1, 'Native radios share one keyboard selection group');
assert.equal(radios.filter(node => node.props.checked).length, 1);
const templateGroup = flatten(developer).find(node => node.type === 'fieldset');
assert.equal(textOf(flatten(templateGroup).find(node => node.type === 'legend')), 'Manifest template');
radios.find(node => node.props.value === 'cliBinary').props.onChange();
developer = render(context.components.DeveloperPanel, { installRoot: '' });
radios = flatten(developer).filter(node => node.type === 'input' && node.props.type === 'radio');
assert.deepEqual(radios.filter(node => node.props.checked).map(node => node.props.value), ['cliBinary'], 'Template choice remains exclusive');
assert.equal(textOf(flatten(developer).find(node => node.type === 'pre')), TEMPLATES.cliBinary.code, 'Selected template controls the displayed code');

slots = [];
slots[1] = { ok: true, installed: [], catalog: [], sources: [] };
const route = () => render(context.components.Route);
const routeComponent = (tree, name) => flatten(tree).find(node => node.type === context.components[name]);
routeComponent(route(), 'ExtensionsFilterToolbar').props.setFilterStatus('needs_setup');
routeComponent(route(), 'ExtensionTabs').props.setActiveTab('discover');
assert.equal(routeComponent(route(), 'ExtensionsFilterToolbar').props.filterStatus, 'all', 'Installed-only status must not remain silently active in Discover');
routeComponent(route(), 'ExtensionsFilterToolbar').props.setFilterStatus('updates');
routeComponent(route(), 'ExtensionTabs').props.setActiveTab('installed');
assert.equal(routeComponent(route(), 'ExtensionsFilterToolbar').props.filterStatus, 'updates', 'A status supported by both sections may remain selected');
routeComponent(route(), 'ExtensionTabs').props.setActiveTab('discover');
routeComponent(route(), 'ExtensionsFilterToolbar').props.setFilterStatus('installed');
routeComponent(route(), 'ExtensionTabs').props.setActiveTab('installed');
assert.equal(routeComponent(route(), 'ExtensionsFilterToolbar').props.filterStatus, 'all', 'Discover-only status must not filter the Installed section');

// 7. Inspector presentation retains workflow callbacks, complete identifiers, and a focus fallback.
slots = [];
let closed = 0;
let fallbackFocused = 0;
let openerFocused = 0;
let prevented = 0;
const opener = { isConnected: true, focus: () => { openerFocused++; } };
context.document = { activeElement: opener, querySelector: () => ({ focus: () => { fallbackFocused++; } }) };
const checksum = 'a'.repeat(64);
const inspector = render(context.components.ExtensionInspectorDialog, {
  extension: { id: 'publisher.example', name: 'Example', kind: 'skill', version: '1.0.0', ready: true, files: [{ path: 'SKILL.md', sha256: checksum }], permissions: [] },
  busy: '',
  onClose: () => { closed++; },
  onInstall: () => {},
  onRemove: () => {}
});
assert.equal(inspector.type, context.OverlayFrame);
assert.equal(inspector.props.size, 'wide');
inspector.props.onOpenChange(false);
assert.equal(closed, 1, 'Frame delegates dismissal to the feature callback');
assert.ok(flatten(inspector).some(node => node.type === 'dialog-description'), 'Inspector supplies a dialog description');
assert.ok(textOf(inspector).includes(checksum), 'Inspector keeps the complete checksum available');
inspector.props.contentProps.onCloseAutoFocus({ preventDefault: () => { prevented++; } });
assert.equal(prevented, 1);
assert.equal(openerFocused, 1, 'Inspector restores its actual opener even without a Radix Trigger');
opener.isConnected = false;
inspector.props.contentProps.onCloseAutoFocus({ preventDefault: () => { prevented++; } });
assert.equal(prevented, 2);
assert.equal(fallbackFocused, 1, 'Removed opener falls back to the selected Extensions tab');
const loading = render(context.components.ExtensionsLoadingSkeleton);
assert.equal(loading.props.role, 'status');
assert.equal(loading.props['aria-label'], 'Loading extensions');

console.log('Extensions UI and design intelligence unit tests passed.');
