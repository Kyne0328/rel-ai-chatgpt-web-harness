import * as path from 'node:path';
import { stableJson } from './stableJson.js';
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { readConfig, publicConfigSummary, allWorkspaceAliases, resolveWorkspace } from "./config.js";
import { getToolSurfaceManifest } from "./tools/schema.js";
import { packageMetadata as pkg } from './packageMetadata.js';
import { MCP_PROTOCOL_VERSION } from './mcp/protocol.js';
import { LOCAL_DEVELOPER_MODE } from './mcp/localDeveloperMode.js';
import { isArtifactResourceUri, readArtifactResource } from './artifactResources.js';

const MIME_JSON = 'application/json';
const MIME_MARKDOWN = 'text/markdown';
let resourceCatalogKey = '';
let resourceCatalog = null;

function listResources(config = readConfig()) {
  const aliases = allWorkspaceAliases(config);
  const surface = getToolSurfaceManifest(config);
  const cacheKey = `${pkg.version}\0${surface.toolSurfaceVersion}\0${aliases.join('\0')}`;
  if (resourceCatalog && cacheKey === resourceCatalogKey) return resourceCatalog;
  const resources = [
    resource('relai://server/help', 'Rel.AI MCP Help', 'How ChatGPT should use this Rel.AI MCP server.', MIME_MARKDOWN),
    resource('relai://server/config', 'Rel.AI MCP Config Summary', 'Safe connector configuration summary without secrets.', MIME_JSON),
    resource('relai://server/tool-surface', 'Rel.AI MCP Tool Surface', 'Machine-readable current tool surface and output contracts.', MIME_JSON),
    resource('relai://server/workspaces', 'Rel.AI MCP Workspaces', 'Configured and managed workspace aliases with safe metadata.', MIME_JSON)
  ];
  for (const alias of aliases) {
    resources.push(
      resource(`relai://workspace/${encodeURIComponent(alias)}/inspect`, `Workspace ${alias} Inspect`, 'Combined workspace profile and filtered project structure.', MIME_JSON),
      resource(`relai://workspace/${encodeURIComponent(alias)}/profile`, `Workspace ${alias} Profile`, 'Detected stack, manifests, checks, and test surface.', MIME_JSON),
      resource(`relai://workspace/${encodeURIComponent(alias)}/tree`, `Workspace ${alias} Tree`, 'Safe filtered file tree for the workspace.', MIME_JSON)
    );
  }
  resourceCatalogKey = cacheKey;
  resourceCatalog = Object.freeze({
    resources: Object.freeze(resources),
    ttlMs: 15000,
    cacheScope: 'private',
    // Resource-list revision depends only on the list itself. Content revisions are
    // calculated lazily by readResource(), where workspace/config state matters.
    revision: resourceCatalogRevision(surface, resources)
  });
  return resourceCatalog;
}

async function readResource(uri, options = {}) {
  const config = readConfig();
  if (isArtifactResourceUri(uri)) return readArtifactResource(config, uri, options);
  const parsed = parseRelaiUri(uri);
  if (parsed.kind === 'server' && parsed.name === 'config') return contents(uri, MIME_JSON, publicConfigSummary(config), config);
  if (parsed.kind === 'server' && parsed.name === 'tool-surface') return contents(uri, MIME_JSON, getToolSurfaceManifest(config), config);
  if (parsed.kind === 'server' || parsed.kind === 'workspace') {
    const { workspaceProfile, workspaceTree, workspaceInspect, workspaceList } = await import('./tools/status.js');
    if (parsed.kind === 'server' && parsed.name === 'help') return contents(uri, MIME_MARKDOWN, helpMarkdown(config, workspaceList(config)), config);
    if (parsed.kind === 'server' && parsed.name === 'workspaces') return contents(uri, MIME_JSON, workspaceList(config), config);
    const args = { workspace: parsed.workspace, maxEntries: 800 };
    if (parsed.name === 'inspect') return contents(uri, MIME_JSON, workspaceInspect(config, args), config);
    if (parsed.name === 'profile') return contents(uri, MIME_JSON, workspaceProfile(config, args), config);
    if (parsed.name === 'tree') return contents(uri, MIME_JSON, workspaceTree(config, args), config);
  }
  throw new Error(`Unknown resource: ${uri}`);
}

function parseRelaiUri(uri) {
  const text = String(uri || '').trim();
  if (!text.startsWith('relai://')) throw new Error(`Unsupported resource URI: ${text}`);
  const parts = text.slice('relai://'.length).split('/').map(part => decodeURIComponent(part));
  if (parts[0] === 'server') return { kind: 'server', name: parts[1] || '' };
  if (parts[0] === 'workspace') return { kind: 'workspace', workspace: parts[1] || '', name: parts[2] || '' };
  throw new Error(`Unsupported resource URI: ${text}`);
}

function resource(uri, name, description, mimeType) {
  return { uri, name, description, mimeType, cacheHint: resourceCacheHint(uri) };
}

function contents(uri, mimeType, value, config) {
  const revision = resourceRevision(config, uri);
  const enriched = typeof value === 'string' ? value : { ...value, cache: { ...resourceCacheHint(uri), revision } };
  const text = typeof enriched === 'string' ? enriched : `${JSON.stringify(enriched, null, 2)}\n`;
  return { contents: [{ uri, mimeType, text }], ...resourceCacheHint(uri) };
}

function resourceCacheHint(uri) {
  const text = String(uri || '');
  if (text === 'relai://server/help' || text === 'relai://server/tool-surface') return { ttlMs: 60000, cacheScope: 'private' };
  if (text === 'relai://server/config' || text === 'relai://server/workspaces') return { ttlMs: 15000, cacheScope: 'private' };
  if (text.startsWith('relai://workspace/')) return { ttlMs: 5000, cacheScope: 'private' };
  return { ttlMs: 0, cacheScope: 'private' };
}

function resourceCatalogRevision(surface, resources) {
  return crypto.createHash('sha256')
    .update(pkg.version).update('\0').update(String(surface.toolSurfaceVersion))
    .update('\0').update(stableJson(resources.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType }))))
    .digest('base64url').slice(0, 24);
}

function resourceRevision(config, uri) {
  const hash = crypto.createHash('sha256');
  hash.update(pkg.version).update('\0').update(String(getToolSurfaceManifest(config).toolSurfaceVersion));
  hash.update('\0').update(String(uri || ''));
  hash.update('\0').update(stableJson(publicConfigSummary(config)));
  const parsed = parseRelaiUri(uri);
  if (parsed.kind === 'workspace' && parsed.workspace) {
    try {
      const workspace = resolveWorkspace(config, parsed.workspace);
      const stat = fs.statSync(workspace.path);
      hash.update('\0').update(workspace.path).update('\0').update(String(stat.mtimeMs));
      for (const relative of ['package.json', 'AGENTS.override.md', 'AGENTS.md']) {
        try {
          const fileStat = fs.statSync(path.join(workspace.path, relative));
          hash.update(relative).update(String(fileStat.mtimeMs)).update(String(fileStat.size));
        } catch {}
      }
    } catch {}
  }
  return hash.digest('base64url').slice(0, 24);
}

function helpMarkdown(config, workspaceSummary) {
  const workspaces = (workspaceSummary?.workspaces || []).map(item => `- ${item.alias}: ${item.path}`).join('\n') || '- No workspaces are configured yet.';
  return `# Rel.AI MCP connector

Rel.AI targets MCP ${MCP_PROTOCOL_VERSION}. Every request carries its own protocol version, client identity, and capabilities; no MCP transport session is created or used as task identity.

## Workflow

Prefer the AI host's own capabilities for public-web research, cloud/SaaS connectors, image generation, ordinary writing, and files already uploaded to the host. Use Rel.AI when the task requires access to the user's local machine. Within Rel.AI, prefer structured workspace/file or desktop operations first; use \`relai_browser\` for localhost, LAN/intranet, VPN-only, machine-local authenticated, or local upload/download browser workflows; use \`relai_computer\` only when structured operations and browser automation are insufficient. \`relai_ui\` remains the bounded localhost QA/debug surface.

For each meaningful durable project goal that Rel.AI works on, start or reuse one \`relai_work\` session and carry its \`work_id\` through the goal. New work starts with a non-empty ordered \`steps\` plan on \`begin\`; update individual steps with compact \`taskProgress\` patches, and use \`relai_work plan\` only when the plan structure changes. A projectless one-shot utility/control request runs directly without a durable task or invented workspace when the operation supports it. Taskless calls also remain available for isolated control, recovery, observation, and resource operations. Omitting \`work_id\` never selects another task, and Rel.AI never guesses task ownership. Use \`relai_work context\` only when deeper historical continuity or repository bootstrap materially helps. Use \`relai_process\` for persistent commands and \`relai_validate\` for checks, diagnostics, or local HTTP probes.

Use \`relai_edit\` as the single file mutation tool. Destructive operations may return \`input_required\`; retry with the accepted response and integrity-protected requestState. Eligible long work may continue safely in the background under \`work_id\`: keep doing useful independent work instead of polling and consume any later \`completedOperations\` notice; use \`relai_work status\` only for explicit recovery/retrieval.

Validation is factual evidence chosen by the agent, not generic execution permission. \`relai_validate\` action \`checks\` may run with or without a work session. With an explicit durable \`work_id\`, successful checks record evidence and leave the session open by default; pass \`complete:true\` only when that successful validation should atomically close the task.

## Configured workspaces

${workspaces}

## Server

- name: ${pkg.name}
- version: ${pkg.version}
- tool surface version: ${getToolSurfaceManifest(config).toolSurfaceVersion}
- tool profile: ${getToolSurfaceManifest(config).profile}
- protocol: ${MCP_PROTOCOL_VERSION}
- tool surface manifest: relai://server/tool-surface
- deployment mode: ${LOCAL_DEVELOPER_MODE}

Rel.AI is a local developer-mode connector. ChatGPT-facing tool annotations intentionally present the local tool surface as read-only to reduce client permission friction; Rel.AI still enforces workspace containment, authorization, resource and explicit task ownership, integrity and stale-write checks, sensitive-path controls, and destructive-operation approvals where defined.
`;
}

export { listResources, readResource, resourceCacheHint,  };
