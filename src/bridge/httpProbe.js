import { readConnectionProfile } from "../connectionProfile.js";
import { clampNumber } from "./limits.js";

const MAX_REDIRECTS = 5;
const TITLE_SAMPLE_BYTES = 64 * 1024;

function localConnectionBaseUrl() {
  let host = "127.0.0.1";
  let port = Number(process.env.REL_AI_MCP_PORT || 3333);
  try {
    const profile = readConnectionProfile();
    host = profile.host || host;
    port = Number(profile.port || port || 3333);
  } catch {}
  if (host === "0.0.0.0") host = "127.0.0.1";
  return `http://${host}:${port || 3333}`;
}

function resolveLocalRouteTarget(rawRoute) {
  const route = String(rawRoute || "").trim();
  if (!route) throw new Error('relai_validate action "http" requires route.');
  if (!route.startsWith("/") || route.startsWith("//")) {
    throw new Error('relai_validate action "http" route must be a local path beginning with one \'/\'; absolute and protocol-relative URLs are not accepted.');
  }
  const base = new URL(localConnectionBaseUrl());
  const target = new URL(route, base);
  if (target.origin !== base.origin) {
    throw new Error('relai_validate action "http" route must resolve to the configured local Rel.AI origin.');
  }
  return target.toString();
}

async function probeHttpTarget(workspace, _config, target, args = {}, requested = {}) {
  const controller = new AbortController();
  const timeoutMs = clampNumber(args.timeoutMs, 1000, 600000, 30000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const allowedOrigin = new URL(target).origin;
    let current = target;
    let response;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      response = await fetch(current, { signal: controller.signal, redirect: 'manual' });
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || !location) break;
      if (redirects === MAX_REDIRECTS) throw new Error(`HTTP probe exceeded ${MAX_REDIRECTS} redirects.`);
      const next = new URL(location, current);
      if (next.origin !== allowedOrigin) throw new Error('HTTP probe refused a redirect outside the configured local Rel.AI origin.');
      current = next.toString();
    }
    // Event streams intentionally never finish. A successful HTTP response
    // already proves reachability; do not wait for an endless body to close.
    const streaming = /^text\/event-stream\b/i.test(response.headers.get('content-type') || '');
    const summary = streaming ? { bytes: 0, sample: '' } : await readResponseSummary(response);
    if (streaming) void response.body?.cancel().catch(() => {});
    const text = summary.sample;
    const title = ((text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '');
    return {
      ok: response.ok,
      workspace: workspace.alias,
      ...requested,
      reachable: true,
      statusCode: response.status,
      finalUrl: response.url || current,
      responseBytes: summary.bytes,
      title
    };
  } catch (error) {
    return {
      ok: false,
      workspace: workspace.alias,
      ...requested,
      reachable: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseSummary(response) {
  if (!response.body) return { bytes: 0, sample: '' };
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let sampledBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    bytes += chunk.length;
    if (sampledBytes >= TITLE_SAMPLE_BYTES) continue;
    const retained = chunk.subarray(0, TITLE_SAMPLE_BYTES - sampledBytes);
    chunks.push(retained);
    sampledBytes += retained.length;
  }
  return { bytes, sample: Buffer.concat(chunks, sampledBytes).toString('utf8') };
}

async function relaiHttpProbe(workspace, config, args = {}) {
  const route = String(args.route || "").trim();
  return probeHttpTarget(workspace, config, resolveLocalRouteTarget(route), args, { route });
}

export { relaiHttpProbe };
