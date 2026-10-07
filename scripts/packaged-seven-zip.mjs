import fs from 'node:fs';
import path from 'node:path';
import { normalizeElectronArch, normalizeElectronPlatform } from './electron-platform.mjs';

function packagedSevenZipExecutable(resourcesRoot, platform, arch) {
  const targetPlatform = normalizeElectronPlatform(String(platform ?? ''));
  const targetArch = normalizeElectronArch(String(arch ?? ''));
  const directory = targetPlatform === 'win32' ? 'win' : targetPlatform === 'darwin' ? 'mac' : 'linux';
  return path.join(resourcesRoot, 'node_modules', '7zip-bin', directory, targetArch, targetPlatform === 'win32' ? '7za.exe' : '7za');
}

function preparePackagedSevenZipExecutable(resourcesRoot, platform, arch) {
  if (normalizeElectronPlatform(String(platform ?? '')) === 'win32') return;
  const executable = packagedSevenZipExecutable(resourcesRoot, platform, arch);
  const stat = regularExecutableStat(executable);
  // Change only the staged target binary. System installs can be root-owned,
  // so all users need execute permission before distribution.
  fs.chmodSync(executable, (stat.mode & 0o7777) | 0o111);
  assertPackagedSevenZipExecutable(resourcesRoot, platform, arch);
}

function assertPackagedSevenZipExecutable(resourcesRoot, platform, arch) {
  if (normalizeElectronPlatform(String(platform ?? '')) === 'win32') return;
  const executable = packagedSevenZipExecutable(resourcesRoot, platform, arch);
  const stat = regularExecutableStat(executable);
  if ((stat.mode & 0o111) !== 0o111) {
    throw new Error(`Packaged 7-Zip must be executable by owner, group, and other users: ${executable}`);
  }
  if (process.platform !== 'win32') fs.accessSync(executable, fs.constants.X_OK);
}

function regularExecutableStat(executable) {
  const stat = fs.lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Packaged 7-Zip executable must be a regular file: ${executable}`);
  }
  return stat;
}

export { assertPackagedSevenZipExecutable, preparePackagedSevenZipExecutable };
