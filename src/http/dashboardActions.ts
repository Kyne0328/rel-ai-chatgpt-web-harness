import {
  controlDashboardTask,
  resolveWorkspaceFolder,
  runWorkspaceValidation,
  workspacePathPreflight
} from '../core/dashboard-actions.ts';
import { readJsonBody, sendJson } from './io.ts';
import type { HttpRouteContext } from './types.ts';

async function handleOpenFolder(ctx: HttpRouteContext): Promise<void> {
  if (typeof ctx.options.openFolder !== 'function') {
    sendJson(ctx.res, 200, { ok: false, unsupported: true, error: 'Opening folders is only available in the Rel.AI desktop app.' });
    return;
  }
  try {
    const payload = await readJsonBody(ctx.req, ctx.options.maxBodyBytes);
    const workspaceAlias = String(payload.workspace || '').trim();
    if (!workspaceAlias) throw new Error('workspace is required');
    const openedPath = await ctx.options.openFolder(resolveWorkspaceFolder(workspaceAlias));
    sendJson(ctx.res, 200, { ok: true, workspace: workspaceAlias, path: openedPath });
  } catch (error) {
    sendJson(ctx.res, 200, { ok: false, error: errorMessage(error) });
  }
}

async function handleWorkspaceChecks(ctx: HttpRouteContext): Promise<void> {
  try {
    const payload = await readJsonBody(ctx.req, ctx.options.maxBodyBytes);
    const workspace = String(payload.workspace || '').trim();
    if (!workspace) throw new Error('workspace is required');
    sendJson(ctx.res, 200, await runWorkspaceValidation(workspace));
  } catch (error) {
    sendJson(ctx.res, 200, { ok: false, error: errorMessage(error) });
  }
}

async function handleTaskControl(ctx: HttpRouteContext): Promise<void> {
  try {
    const payload = await readJsonBody(ctx.req, ctx.options.maxBodyBytes);
    const action = String(payload.action || '').trim();
    const workId = String(payload.work_id || payload.workId || '').trim();
    const operationId = String(payload.operationId || '').trim();
    if (action !== 'stop' && action !== 'cancel') throw new Error('action must be stop or cancel');
    if (!workId) throw new Error('work_id is required');
    sendJson(ctx.res, 200, await controlDashboardTask(action, workId, operationId));
  } catch (error) {
    sendJson(ctx.res, 200, { ok: false, error: errorMessage(error) });
  }
}

async function handlePickFolder(ctx: HttpRouteContext): Promise<void> {
  if (typeof ctx.options.pickFolder !== 'function') {
    sendJson(ctx.res, 200, { ok: false, unsupported: true, error: 'Native folder picker is only available in the Rel.AI desktop launcher.' });
    return;
  }
  try {
    const picked = await ctx.options.pickFolder();
    if (!picked) {
      sendJson(ctx.res, 200, { ok: false, canceled: true });
      return;
    }
    sendJson(ctx.res, 200, workspacePathPreflight(picked));
  } catch (error) {
    sendJson(ctx.res, 200, { ok: false, error: errorMessage(error) });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { handleOpenFolder, handlePickFolder, handleTaskControl, handleWorkspaceChecks, workspacePathPreflight };
