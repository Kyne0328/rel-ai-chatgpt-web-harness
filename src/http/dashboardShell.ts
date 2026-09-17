import * as crypto from 'node:crypto';

import { resolvePackagePath } from '../packageMetadata.js';
import { readCachedStaticAsset } from './dashboardAssets.ts';
import { renderDashboardShellBootstrap } from './dashboardShellChrome.ts';
import { contentTypeForStaticAsset, sendHtml } from './io.ts';
import type { HttpRouteContext } from './types.ts';

async function handleFavicon(ctx: HttpRouteContext): Promise<void> {
  try {
    const content = readCachedStaticAsset(resolvePackagePath('public', 'assets', 'favicon.ico'));
    ctx.res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'private, max-age=60' });
    ctx.res.end(content);
  } catch {
    ctx.res.writeHead(404);
    ctx.res.end('Not found');
  }
}

function handleStaticAsset(ctx: HttpRouteContext): void {
  const safePath = ctx.parsed.pathname.replaceAll('\\', '/');
  if (safePath.includes('..')) {
    ctx.res.writeHead(400);
    ctx.res.end('Bad path');
    return;
  }
  let filePath: string;
  if (safePath.startsWith('/ui/')) {
    filePath = resolvePackagePath('src', 'ui', safePath.slice(4));
  } else if (safePath.startsWith('/public/ui/')) {
    filePath = resolvePackagePath('src', 'ui', safePath.slice(11));
  } else if (safePath.startsWith('/vendor/monaco/')) {
    filePath = resolvePackagePath('node_modules', 'monaco-editor', 'min', 'vs', safePath.slice('/vendor/monaco/'.length));
  } else {
    filePath = resolvePackagePath('public', safePath.slice(8));
  }
  try {
    const content = readCachedStaticAsset(filePath);
    const contentType = contentTypeForStaticAsset(safePath);
    const charset = contentType.startsWith('text/') || contentType === 'application/javascript' ? '; charset=utf-8' : '';
    ctx.res.writeHead(200, { 'Content-Type': contentType + charset, 'Cache-Control': cacheControlForStaticAsset(safePath) });
    ctx.res.end(content);
  } catch {
    ctx.res.writeHead(404);
    ctx.res.end('Not found');
  }
}

function cacheControlForStaticAsset(safePath: string): string {
  if (safePath.startsWith('/public/dashboard-chunks/') || safePath.startsWith('/public/dashboard-assets/')) {
    return 'public, max-age=31536000, immutable';
  }
  return 'private, max-age=60';
}

function handleDashboard(ctx: HttpRouteContext): void {
  const nonce = crypto.randomBytes(18).toString('base64');
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join('; ');
  sendHtml(ctx.res, 200, renderDashboardHtml(nonce), {
    'Content-Security-Policy': csp,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  });
}

function renderDashboardHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Overview · Rel.AI MCP</title>
<link rel="icon" href="/public/assets/favicon.ico" sizes="any">
<link rel="icon" type="image/png" href="/public/assets/favicon.png">
<link rel="apple-touch-icon" href="/public/assets/relai-logo-192.png">
<script nonce="${nonce}">${renderDashboardShellBootstrap()}</script>
<link rel="stylesheet" href="/public/dashboard.css">
</head>
<body>
<div id="dashboardRoot"></div>
<script type="module" src="/public/dashboard-app.js"></script>
</body>
</html>`;
}

export { handleDashboard, handleFavicon, handleStaticAsset };
