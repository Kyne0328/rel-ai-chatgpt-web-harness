import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../durableState.ts';
import { getStateDir } from '../statePaths.js';
import { requestStateKey } from './context.js';
import { stableJson } from '../stableJson.js';

function resolveConnectionGenerations(config, options = {}) {
  const file = options.file || path.join(getStateDir(config), 'connection-generations.json');
  const key = options.key || requestStateKey(config);
  const credentialFingerprint = fingerprint(key, `credential\0${String(options.token || '')}`);
  const configurationFingerprint = fingerprint(key, `configuration\0${stableJson({
    host: String(options.host || ''),
    port: Number(options.port || 0)
  })}`);
  const previous = readState(file);
  const next = {
    version: 1,
    credentialGeneration: nextGeneration(previous.credentialGeneration, previous.credentialFingerprint, credentialFingerprint),
    configurationGeneration: nextGeneration(previous.configurationGeneration, previous.configurationFingerprint, configurationFingerprint),
    credentialFingerprint,
    configurationFingerprint,
    updatedAt: new Date().toISOString()
  };
  if (!sameState(previous, next)) writeState(file, next);
  return {
    credentialGeneration: next.credentialGeneration,
    configurationGeneration: next.configurationGeneration
  };
}

function nextGeneration(value, previousFingerprint, currentFingerprint) {
  const generation = Math.max(0, Number(value || 0));
  if (!previousFingerprint) return Math.max(1, generation);
  return previousFingerprint === currentFingerprint ? Math.max(1, generation) : generation + 1;
}

function fingerprint(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest('base64url');
}

function readState(file) {
  return readJsonFile(file, {
    backup: true,
    mode: 0o600,
    validate: isConnectionGenerationState
  }) || {};
}

function writeState(file, value) {
  writeJsonAtomic(file, value, { backup: true, mode: 0o600 });
}

function isConnectionGenerationState(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.version === 1
    && Number.isInteger(value.credentialGeneration)
    && value.credentialGeneration >= 1
    && Number.isInteger(value.configurationGeneration)
    && value.configurationGeneration >= 1
    && typeof value.credentialFingerprint === 'string'
    && value.credentialFingerprint
    && typeof value.configurationFingerprint === 'string'
    && value.configurationFingerprint
    && typeof value.updatedAt === 'string'
    && Number.isFinite(Date.parse(value.updatedAt))
  );
}

function sameState(previous, next) {
  return Number(previous.credentialGeneration || 0) === next.credentialGeneration
    && Number(previous.configurationGeneration || 0) === next.configurationGeneration
    && previous.credentialFingerprint === next.credentialFingerprint
    && previous.configurationFingerprint === next.configurationFingerprint;
}

export { resolveConnectionGenerations,   };
