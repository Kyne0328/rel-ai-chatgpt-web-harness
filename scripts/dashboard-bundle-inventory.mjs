import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BUNDLE_INVENTORY_NAME = 'dashboard-bundle-dependencies.json';
const RENDERER_REFERENCE = 'rel.ai:dashboard-renderer';

function dashboardBundleInventory() {
  return {
    name: 'relai-dashboard-bundle-inventory',
    generateBundle(_options, bundle) {
      const components = new Map();
      const owners = new Map();
      const outputs = {};
      for (const [file, chunk] of Object.entries(bundle)) {
        if (chunk.type !== 'chunk') continue;
        outputs[file] = crypto.createHash('sha256').update(chunk.code).digest('hex');
        for (const [id, rendered] of Object.entries(chunk.modules || {})) {
          if (rendered.renderedLength === 0) continue;
          const component = packageForModule(id);
          if (!component) continue;
          components.set(component['bom-ref'], component);
          owners.set(id, component['bom-ref']);
        }
      }
      const dependencies = new Map([...components.keys()].map(ref => [ref, new Set()]));
      for (const [id, owner] of owners) {
        const info = this.getModuleInfo(id);
        for (const imported of [...(info?.importedIds || []), ...(info?.dynamicallyImportedIds || [])]) {
          const target = owners.get(imported) || packageForModule(imported)?.['bom-ref'];
          if (target && target !== owner && components.has(target)) dependencies.get(owner).add(target);
        }
      }
      const inventory = {
        schemaVersion: 1,
        outputs: Object.fromEntries(Object.entries(outputs).sort(([left], [right]) => left.localeCompare(right))),
        components: [...components.values()].sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref'])),
        dependencies: [
          { ref: RENDERER_REFERENCE, dependsOn: [...components.keys()].sort() },
          ...[...dependencies].sort(([left], [right]) => left.localeCompare(right))
            .map(([ref, targets]) => ({ ref, dependsOn: [...targets].sort() }))
        ]
      };
      this.emitFile({ type: 'asset', fileName: BUNDLE_INVENTORY_NAME, source: `${JSON.stringify(inventory, null, 2)}\n` });
    },
    writeBundle(options, bundle) {
      // Vite's later import-analysis hooks can still rewrite chunk code after
      // generateBundle. Bind inventory to the bytes actually emitted to disk.
      if (!options.dir) throw new Error('Dashboard inventory requires a directory build output.');
      const inventory = JSON.parse(String(bundle[BUNDLE_INVENTORY_NAME].source));
      inventory.outputs = Object.fromEntries(Object.values(bundle)
        .filter(output => output.type === 'chunk')
        .map(output => [output.fileName, crypto.createHash('sha256')
          .update(fs.readFileSync(path.join(options.dir, output.fileName))).digest('hex')])
        .sort(([left], [right]) => left.localeCompare(right)));
      const source = `${JSON.stringify(inventory, null, 2)}\n`;
      bundle[BUNDLE_INVENTORY_NAME].source = source;
      fs.writeFileSync(path.join(options.dir, BUNDLE_INVENTORY_NAME), source);
    }
  };
}

function packageForModule(moduleId) {
  const normalized = String(moduleId).replaceAll('\\', '/').replace(/^\0/, '').split('?')[0];
  const marker = normalized.lastIndexOf('/node_modules/');
  if (marker < 0) return null;
  const suffix = normalized.slice(marker + '/node_modules/'.length).split('/');
  const name = suffix[0].startsWith('@') ? suffix.slice(0, 2).join('/') : suffix[0];
  const manifestPath = normalized.slice(0, marker + '/node_modules/'.length) + name + '/package.json';
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.name || !manifest.version) throw new Error(`Bundled module lacks package identity: ${moduleId}`);
  const ref = `pkg:npm/${manifest.name.replace('@', '%40')}@${manifest.version}`;
  return {
    type: 'library', name: manifest.name, version: manifest.version, purl: ref, 'bom-ref': ref,
    ...(typeof manifest.license === 'string' ? { licenses: [{ license: { id: manifest.license } }] } : {})
  };
}

function verifyBundleInventory(publicRoot, inventory) {
  if (inventory?.schemaVersion !== 1 || !Array.isArray(inventory.components) || !inventory.components.length
      || !Array.isArray(inventory.dependencies) || !inventory.outputs || !Object.keys(inventory.outputs).length) {
    throw new Error('Dashboard bundle dependency inventory is missing or malformed; rebuild the frontend.');
  }
  for (const [relative, hash] of Object.entries(inventory.outputs)) {
    const file = path.resolve(publicRoot, relative);
    const inside = path.relative(path.resolve(publicRoot), file);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || !/^[a-f0-9]{64}$/.test(hash)
        || !fs.existsSync(file) || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== hash) {
      throw new Error(`Dashboard bundle inventory does not match shipped asset: ${relative}`);
    }
  }
  return inventory;
}

export { BUNDLE_INVENTORY_NAME, RENDERER_REFERENCE, dashboardBundleInventory, verifyBundleInventory };
