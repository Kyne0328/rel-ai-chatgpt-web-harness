import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSIONS_REPOSITORY_URL, PERMISSION_METADATA, TEMPLATES } from '../src/ui/features/extensions/metadata.js';
import { parseExtensionManifest, PERMISSIONS } from '../src/extensions/registry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reactCode = fs.readFileSync(path.join(root, 'src/ui/features/extensions/react.js'), 'utf8');
const stylesCode = fs.readFileSync(path.join(root, 'src/ui/features/extensions/styles.css'), 'utf8');

// 1. Module/data boundaries
assert.match(reactCode, /function createExtensionsRoute\(\)/, 'React route factory remains defined in the frontend module');
assert.match(reactCode, /from '\.\/metadata\.js'/, 'React route consumes CSS-free extension metadata');
assert.equal(EXTENSIONS_REPOSITORY_URL, 'https://github.com/Kyne0328/rel-ai-extensions');

// 2. CSS integration
assert.match(reactCode, /import '\.\/styles\.css';/, 'Extensions React module must own its feature stylesheet');
assert.match(stylesCode, /\.extensions-page/, 'styles.css must style extensions-page');
assert.match(stylesCode, /\.extensions-kpi-strip/, 'styles.css must style extensions-kpi-strip');
assert.match(stylesCode, /\.extension-pro-card/, 'styles.css must style extension-pro-card');
assert.match(stylesCode, /\.extensions-filter-toolbar/, 'styles.css must style extensions-filter-toolbar');

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
assert.match(reactCode, /ExtensionsKpiStrip/);
assert.match(reactCode, /ExtensionsFilterToolbar/);
assert.match(reactCode, /ExtensionInspectorDialog/);

console.log('Extensions UI and design intelligence unit tests passed.');
