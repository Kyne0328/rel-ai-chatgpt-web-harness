import { readHealthStatus } from '../core/health.ts';
import { sendJson } from './io.ts';
import type { HttpRouteContext } from './types.ts';

function handleHealth(ctx: HttpRouteContext): void {
  sendJson(ctx.res, 200, {
    ...readHealthStatus(),
    auth: ctx.options.token ? 'bearer' : 'disabled'
  });
}

export { handleHealth };
