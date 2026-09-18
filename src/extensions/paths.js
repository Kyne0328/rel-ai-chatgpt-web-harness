import * as path from 'node:path';
import { getStateDir } from '../statePaths.js';

function extensionBinRoot(config = {}) {
  return path.join(getStateDir(config), 'extensions', '.bin');
}

function managedExtensionCommandFilename(command, platform = process.platform) {
  const name = String(command || '').trim();
  if (!name) throw new Error('Managed extension command name is required.');
  return platform === 'win32' && !name.toLowerCase().endsWith('.exe') ? `${name}.exe` : name;
}

function managedExtensionCommandPath(config, command, platform = process.platform) {
  return path.join(extensionBinRoot(config), managedExtensionCommandFilename(command, platform));
}

function managedExtensionCommandMetadataPath(config, command, platform = process.platform) {
  return `${managedExtensionCommandPath(config, command, platform)}.relai-owner.json`;
}

export {
  extensionBinRoot,
  managedExtensionCommandFilename,
  managedExtensionCommandMetadataPath,
  managedExtensionCommandPath
};
