'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';

const LOCAL_SCHEME = 'relai-app';
const LOCAL_HOST = 'renderer';
const registeredProtocols = new WeakSet();
const installedProtocols = new WeakSet();
const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png'
});

function registerLocalScheme(protocol) {
  if (registeredProtocols.has(protocol)) return false;
  protocol.registerSchemesAsPrivileged([{
    scheme: LOCAL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true
    }
  }]);
  registeredProtocols.add(protocol);
  return true;
}

function installLocalProtocol(protocol, rendererRoot) {
  if (!protocol || typeof protocol.handle !== 'function') {
    throw new TypeError('An Electron protocol handler is required.');
  }
  if (installedProtocols.has(protocol)) return false;
  const root = path.resolve(rendererRoot);
  protocol.handle(LOCAL_SCHEME, async request => {
    const target = resolveLocalRendererPath(request.url, root);
    if (!target) return new Response('Not found', { status: 404 });
    try {
      const contentType = CONTENT_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream';
      return new Response(await fs.promises.readFile(target), {
        status: 200,
        headers: {
          'content-type': contentType,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        }
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
  installedProtocols.add(protocol);
  return true;
}

function localRendererUrl(fileName, query = {}) {
  const safeName = path.posix.basename(String(fileName || ''));
  if (!safeName || safeName !== String(fileName || '').replaceAll('\\', '/')) {
    throw new Error('Local renderer URL must reference a renderer file name.');
  }
  const url = new URL(`${LOCAL_SCHEME}://${LOCAL_HOST}/${encodeURIComponent(safeName)}`);
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, String(value));
  return url.href;
}

function resolveLocalRendererPath(target, rendererRoot) {
  try {
    const rawTarget = String(target || '');
    if (hasParentPathSegment(rawTarget)) return '';
    const url = new URL(rawTarget);
    if (url.protocol !== `${LOCAL_SCHEME}:` || url.hostname !== LOCAL_HOST || url.username || url.password || url.port) return '';
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!relative || relative.includes('/') || relative.includes('\\') || relative.includes('\0')) return '';
    const extension = path.extname(relative).toLowerCase();
    if (!Object.hasOwn(CONTENT_TYPES, extension)) return '';
    const root = path.resolve(rendererRoot);
    const absolute = path.resolve(root, relative);
    if (path.dirname(absolute) !== root) return '';
    return absolute;
  } catch {
    return '';
  }
}

function hasParentPathSegment(target) {
  const schemeIndex = target.indexOf('://');
  const pathStart = schemeIndex >= 0 ? target.indexOf('/', schemeIndex + 3) : -1;
  if (pathStart < 0) return false;
  const rawPath = target.slice(pathStart).split(/[?#]/, 1)[0];
  try {
    return decodeURIComponent(rawPath).split('/').includes('..');
  } catch {
    return true;
  }
}

export {  installLocalProtocol, localRendererUrl, registerLocalScheme, resolveLocalRendererPath };
