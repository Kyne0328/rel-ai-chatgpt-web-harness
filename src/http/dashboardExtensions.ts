import { getExtensionsDashboard, installDashboardExtension, removeDashboardExtension } from '../core/extensions.ts';
import { readJsonBody, sendJson } from './io.ts';
import type { HttpRouteContext } from './types.ts';

async function handleApiExtensions(ctx: HttpRouteContext): Promise<void> {
  const refresh = ctx.parsed.searchParams.get('refresh') === '1';
  sendJson(ctx.res, 200, await getExtensionsDashboard(refresh));
}

async function handleApiExtensionsAction(ctx: HttpRouteContext): Promise<void> {
  try {
    const payload = await readJsonBody(ctx.req, ctx.options.maxBodyBytes);
    const action = String(payload.action || '').trim().toLowerCase();
    const id = String(payload.id || '').trim();
    if (!id) throw new Error('Extension ID is required.');
    if (action === 'install' || action === 'update') {
      if (payload.confirmPermissions !== true) throw new Error('Review the extension permissions before installation.');
      const extension = await installDashboardExtension(id);
      sendJson(ctx.res, 200, { ok: true, action, extension });
      return;
    }
    if (action === 'remove') {
      if (payload.confirmRemove !== true) throw new Error('Confirm the extension removal.');
      sendJson(ctx.res, 200, removeDashboardExtension(id));
      return;
    }
    throw new Error(`Extension action '${action || '(missing)'}' is not supported.`);
  } catch (error) {
    sendJson(ctx.res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export { handleApiExtensions, handleApiExtensionsAction };
