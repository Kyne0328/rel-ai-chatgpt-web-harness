'use strict';

import fs from 'node:fs';
import * as path from 'node:path';
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';
import { normalizeBuildProvenance } from '../../src/buildProvenance.js';
import { Arch } from 'electron-builder';
import { preparePackagedSevenZipExecutable } from '../../scripts/packaged-seven-zip.mjs';

export default async function hardenElectronBinary(context) {
  const executable = resolveExecutable(context);
  await flipFuses(executable, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false
  });
  preparePackagedSevenZipExecutable(resolveResourcesDirectory(context), context.electronPlatformName, Arch[context.arch]);
  writeBuildProvenance(context);
};

function writeBuildProvenance(context) {
  const raw = String(process.env.REL_AI_BUILD_PROVENANCE || '');
  let provenance;
  try {
    provenance = normalizeBuildProvenance(JSON.parse(raw));
  } catch {}
  if (!provenance) throw new Error('REL_AI_BUILD_PROVENANCE is missing or invalid. Use the guarded Rel.AI packaging command.');
  const packageVersion = String(context.packager.appInfo.version || '').trim();
  if (provenance.version !== packageVersion) {
    throw new Error(`Build provenance version ${provenance.version} does not match packaged version ${packageVersion}.`);
  }
  const resources = resolveResourcesDirectory(context);
  fs.writeFileSync(path.join(resources, 'build-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, 'utf8');
}

function resolveExecutable(context) {
  const productName = context.packager.appInfo.productFilename;
  if (context.electronPlatformName === 'darwin') {
    return path.join(context.appOutDir, `${productName}.app`, 'Contents', 'MacOS', productName);
  }
  if (context.electronPlatformName === 'linux') {
    return path.join(context.appOutDir, context.packager.executableName);
  }
  return path.join(context.appOutDir, `${productName}.exe`);
}

function resolveResourcesDirectory(context) {
  if (context.electronPlatformName === 'darwin') {
    const productName = context.packager.appInfo.productFilename;
    return path.join(context.appOutDir, `${productName}.app`, 'Contents', 'Resources');
  }
  return path.join(context.appOutDir, 'resources');
}
