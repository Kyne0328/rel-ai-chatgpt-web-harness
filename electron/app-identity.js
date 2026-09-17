import * as path from 'node:path';

function configureApplicationIdentity(app) {
  if (!app || typeof app.setName !== 'function') throw new TypeError('Electron app identity access is required.');
  const devUserDataPath = String(process.env.REL_AI_ELECTRON_DEV_USER_DATA || '').trim();
  if (devUserDataPath) {
    app.setName('Rel.AI MCP Dev');
    if (typeof app.setPath !== 'function') throw new TypeError('Electron app path access is required.');
    app.setPath('userData', path.resolve(devUserDataPath));
  } else {
    app.setName('Rel.AI MCP');
  }
  if (process.platform === 'win32' && typeof app.setAppUserModelId === 'function') {
    app.setAppUserModelId(devUserDataPath ? 'com.relai.mcp.dev' : 'com.relai.mcp');
  }
}

export { configureApplicationIdentity };
