import fs from 'node:fs';
import path from 'node:path';
import { importResourceModule } from './resource-path.js';

const { buildIdFromFingerprint, normalizeBuildProvenance } = await importResourceModule('src/buildProvenance.js');

function readBuildStatus({ app, resourcesPath = process.resourcesPath } = {}) {
  if (app?.isPackaged !== true) return Object.freeze({ state: 'development' });
  const provenance = readPackagedProvenance(resourcesPath);
  if (!provenance) return Object.freeze({ state: 'unavailable' });
  if (String(app?.getVersion?.() || '').trim() !== provenance.version) {
    return Object.freeze({ state: 'unavailable' });
  }

  return Object.freeze({
    state: 'recorded',
    version: provenance.version,
    buildId: buildIdFromFingerprint(provenance.sourceFingerprint),
    builtAt: provenance.builtAt,
    sourceRevision: provenance.sourceRevision,
    sourceFingerprint: provenance.sourceFingerprint,
    sourceDirty: provenance.dirty
  });
}

function readPackagedProvenance(resourcesPath) {
  try {
    const file = path.join(String(resourcesPath || ''), 'build-provenance.json');
    return normalizeBuildProvenance(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

export { readBuildStatus };
