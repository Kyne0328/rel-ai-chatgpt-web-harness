import { readConfig } from '../config.js';
import { extensionDashboard, installExtension, removeExtension } from '../extensions/registry.js';
import { readJsonBody, sendJson } from './io.ts';
import type { HttpRouteContext } from './types.ts';

async function handleApiExtensions(ctx: HttpRouteContext): Promise<void> {
  const refresh = ctx.parsed.searchParams.get('refresh') === '1';
  sendJson(ctx.res, 200, await extensionDashboard(readConfig(), { refresh }));
}

async function handleApiExtensionsAction(ctx: HttpRouteContext): Promise<void> {
  try {
    const payload = await readJsonBody(ctx.req, ctx.options.maxBodyBytes);
    const action = String(payload.action || '').trim().toLowerCase();
    const id = String(payload.id || '').trim();
    if (!id) throw new Error('Extension id is required.');
    if (action === 'install' || action === 'update') {
      if (payload.confirmPermissions !== true) throw new Error('Extension installation requires an explicit permission review.');
      const extension = await installExtension(readConfig(), id);
      sendJson(ctx.res, 200, { ok: true, action, extension });
      return;
    }
    if (action === 'remove') {
      if (payload.confirmRemove !== true) throw new Error('Extension removal requires explicit confirmation.');
      sendJson(ctx.res, 200, removeExtension(readConfig(), id));
      return;
    }
    throw new Error(`Unsupported extension action '${action || '(missing)'}.`);
  } catch (error) {
    sendJson(ctx.res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export { handleApiExtensions, handleApiExtensionsAction };
