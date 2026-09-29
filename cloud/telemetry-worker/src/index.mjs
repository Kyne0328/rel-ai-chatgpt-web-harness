const MAX_PRESENCE_BYTES = 4096;
const MAX_TRACE_BYTES = 1024 * 1024;
const PRESENCE_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;
const ALLOWED_PLATFORMS = new Set(['win32', 'darwin', 'linux']);
const ALLOWED_ARCHITECTURES = new Set(['x64', 'arm64', 'arm', 'ia32']);
const PRESENCE_KEYS = new Set(['schemaVersion', 'installationId', 'version', 'platform', 'arch']);

function withSecurityHeaders(headers = {}) {
  return {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...headers
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: withSecurityHeaders({ 'content-type': 'application/json; charset=utf-8', ...headers })
  });
}

function text(value, status = 200, headers = {}) {
  return new Response(value, {
    status,
    headers: withSecurityHeaders({ 'content-type': 'text/plain; charset=utf-8', ...headers })
  });
}

function validUuidV4(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validVersion(value) {
  return /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(value) && value.length <= 64;
}

function validatePresence(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'Expected a JSON object.' };
  const keys = Object.keys(input);
  if (keys.some(key => !PRESENCE_KEYS.has(key))) return { ok: false, error: 'Unexpected field.' };
  if (input.schemaVersion !== 1) return { ok: false, error: 'Unsupported schema version.' };
  const installationId = String(input.installationId || '').trim();
  const version = String(input.version || '').trim();
  const platform = String(input.platform || '').trim();
  const arch = String(input.arch || '').trim();
  if (!validUuidV4(installationId)) return { ok: false, error: 'Invalid installation ID.' };
  if (!validVersion(version)) return { ok: false, error: 'Invalid Rel.AI version.' };
  if (!ALLOWED_PLATFORMS.has(platform)) return { ok: false, error: 'Unsupported platform.' };
  if (!ALLOWED_ARCHITECTURES.has(arch)) return { ok: false, error: 'Unsupported architecture.' };
  return { ok: true, value: { installationId, version, platform, arch } };
}

async function hashAdminPassword(password, salt) {
  const bytes = new TextEncoder().encode(`${salt}\0${password}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function constantTimeEqual(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

function parseBasicAuthorization(request) {
  const header = String(request.headers.get('authorization') || '');
  if (!header.startsWith('Basic ')) return null;
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(':');
    if (separator < 0) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

async function isAuthorizedAdmin(request, env) {
  const credentials = parseBasicAuthorization(request);
  if (!credentials) return false;
  const expectedUsername = String(env.ADMIN_USERNAME || 'admin');
  const salt = String(env.ADMIN_PASSWORD_SALT || '');
  const expectedHash = String(env.ADMIN_PASSWORD_HASH || '');
  if (!salt || !expectedHash || credentials.username !== expectedUsername) return false;
  const actualHash = await hashAdminPassword(credentials.password, salt);
  return constantTimeEqual(actualHash, expectedHash);
}

function axiomTraceUrl(env) {
  const domain = String(env.AXIOM_DOMAIN || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  return domain ? `https://${domain}/v1/traces` : '';
}

async function allowRate(binding, key) {
  if (!binding?.limit) return true;
  const result = await binding.limit({ key });
  return result?.success === true;
}

async function readLimitedBody(request, maxBytes) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > maxBytes) throw Object.assign(new Error('Payload too large.'), { status: 413 });
  const body = await request.arrayBuffer();
  if (body.byteLength > maxBytes) throw Object.assign(new Error('Payload too large.'), { status: 413 });
  return body;
}

async function handlePresence(request, env) {
  if (!String(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    return json({ ok: false, error: 'Content-Type must be application/json.' }, 415);
  }

  let body;
  try {
    const bytes = await readLimitedBody(request, MAX_PRESENCE_BYTES);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    return json({ ok: false, error: error?.status === 413 ? 'Payload too large.' : 'Invalid JSON.' }, error?.status || 400);
  }

  const parsed = validatePresence(body);
  if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);

  const presence = parsed.value;
  if (!await allowRate(env.USAGE_RATE_LIMITER, presence.installationId)) {
    return json({ ok: false, error: 'Too many presence requests.' }, 429, { 'retry-after': '60' });
  }

  const existing = await env.DB.prepare(
    'SELECT last_seen_at, current_version, platform, architecture FROM installations WHERE installation_id = ?'
  ).bind(presence.installationId).first();

  const now = new Date();
  const nowIso = now.toISOString();
  if (existing) {
    const lastSeen = Date.parse(String(existing.last_seen_at || ''));
    const metadataChanged = existing.current_version !== presence.version
      || existing.platform !== presence.platform
      || existing.architecture !== presence.arch;
    if (!metadataChanged && Number.isFinite(lastSeen) && now.getTime() - lastSeen < PRESENCE_MIN_INTERVAL_MS) {
      return json({ ok: true, updated: false }, 202);
    }

    await env.DB.prepare(
      `UPDATE installations
       SET last_seen_at = ?, current_version = ?, platform = ?, architecture = ?
       WHERE installation_id = ?`
    ).bind(nowIso, presence.version, presence.platform, presence.arch, presence.installationId).run();
    return json({ ok: true, updated: true }, 202);
  }

  await env.DB.prepare(
    `INSERT INTO installations
      (installation_id, first_seen_at, last_seen_at, first_version, current_version, platform, architecture)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    presence.installationId,
    nowIso,
    nowIso,
    presence.version,
    presence.version,
    presence.platform,
    presence.arch
  ).run();
  return json({ ok: true, updated: true }, 202);
}

async function handleTraces(request, env) {
  const contentType = String(request.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
  if (!['application/x-protobuf', 'application/json'].includes(contentType)) {
    return text('Unsupported OTLP content type.', 415);
  }

  const actor = request.headers.get('cf-connecting-ip') || 'unknown';
  if (!await allowRate(env.TRACE_RATE_LIMITER, actor)) {
    return text('Too many trace requests.', 429, { 'retry-after': '60' });
  }

  if (!env.AXIOM_TOKEN || !env.AXIOM_DATASET || !axiomTraceUrl(env)) {
    return text('Diagnostic backend is not configured.', 503);
  }

  let body;
  try {
    body = await readLimitedBody(request, MAX_TRACE_BYTES);
  } catch (error) {
    return text(error?.status === 413 ? 'Trace payload too large.' : 'Invalid trace payload.', error?.status || 400);
  }

  const headers = new Headers({
    authorization: `Bearer ${env.AXIOM_TOKEN}`,
    'content-type': contentType,
    'x-axiom-dataset': String(env.AXIOM_DATASET)
  });
  const encoding = request.headers.get('content-encoding');
  if (encoding) headers.set('content-encoding', encoding);

  const upstream = await fetch(axiomTraceUrl(env), { method: 'POST', headers, body });
  if (!upstream.ok) return text('Diagnostic backend rejected the trace batch.', 502);

  return new Response(upstream.body, {
    status: upstream.status,
    headers: withSecurityHeaders({
      'content-type': upstream.headers.get('content-type') || 'application/x-protobuf'
    })
  });
}

async function aggregateSummary(db) {
  const [
    totals,
    versions,
    platforms,
    architectures,
    history
  ] = await db.batch([
    db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN unixepoch(last_seen_at) >= unixepoch('now', '-1 day') THEN 1 ELSE 0 END) AS active_1d,
        SUM(CASE WHEN unixepoch(last_seen_at) >= unixepoch('now', '-7 days') THEN 1 ELSE 0 END) AS active_7d,
        SUM(CASE WHEN unixepoch(last_seen_at) >= unixepoch('now', '-30 days') THEN 1 ELSE 0 END) AS active_30d,
        SUM(CASE WHEN unixepoch(first_seen_at) >= unixepoch('now', '-1 day') THEN 1 ELSE 0 END) AS new_1d,
        SUM(CASE WHEN unixepoch(first_seen_at) >= unixepoch('now', '-7 days') THEN 1 ELSE 0 END) AS new_7d,
        SUM(CASE WHEN unixepoch(first_seen_at) >= unixepoch('now', '-30 days') THEN 1 ELSE 0 END) AS new_30d
      FROM installations
    `),
    db.prepare('SELECT current_version AS name, COUNT(*) AS count FROM installations GROUP BY current_version ORDER BY count DESC, name ASC LIMIT 25'),
    db.prepare('SELECT platform AS name, COUNT(*) AS count FROM installations GROUP BY platform ORDER BY count DESC, name ASC'),
    db.prepare('SELECT architecture AS name, COUNT(*) AS count FROM installations GROUP BY architecture ORDER BY count DESC, name ASC'),
    db.prepare('SELECT day, total_installations, active_1d, active_7d, active_30d, new_1d FROM daily_metrics ORDER BY day DESC LIMIT 90')
  ]);

  const totalRow = totals.results?.[0] || {};
  return {
    generatedAt: new Date().toISOString(),
    totals: {
      installations: Number(totalRow.total || 0),
      active1d: Number(totalRow.active_1d || 0),
      active7d: Number(totalRow.active_7d || 0),
      active30d: Number(totalRow.active_30d || 0),
      new1d: Number(totalRow.new_1d || 0),
      new7d: Number(totalRow.new_7d || 0),
      new30d: Number(totalRow.new_30d || 0)
    },
    versions: versions.results || [],
    platforms: platforms.results || [],
    architectures: architectures.results || [],
    history: (history.results || []).reverse()
  };
}

async function handleAdminSummary(request, env) {
  if (!await isAuthorizedAdmin(request, env)) return json({ ok: false, error: 'Invalid username or password.' }, 401, { 'www-authenticate': 'Basic realm="Rel.AI Developer Analytics", charset="UTF-8"' });
  return json({ ok: true, summary: await aggregateSummary(env.DB) });
}

async function writeDailySnapshot(db) {
  const row = await db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN unixepoch(last_seen_at) >= unixepoch('now', '-1 day') THEN 1 ELSE 0 END) AS active_1d,
      SUM(CASE WHEN unixepoch(last_seen_at) >= unixepoch('now', '-7 days') THEN 1 ELSE 0 END) AS active_7d,
      SUM(CASE WHEN unixepoch(last_seen_at) >= unixepoch('now', '-30 days') THEN 1 ELSE 0 END) AS active_30d,
      SUM(CASE WHEN unixepoch(first_seen_at) >= unixepoch('now', '-1 day') THEN 1 ELSE 0 END) AS new_1d
    FROM installations
  `).first();

  const day = new Date().toISOString().slice(0, 10);
  await db.prepare(`
    INSERT INTO daily_metrics(day, total_installations, active_1d, active_7d, active_30d, new_1d)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET
      total_installations = excluded.total_installations,
      active_1d = excluded.active_1d,
      active_7d = excluded.active_7d,
      active_30d = excluded.active_30d,
      new_1d = excluded.new_1d
  `).bind(
    day,
    Number(row?.total || 0),
    Number(row?.active_1d || 0),
    Number(row?.active_7d || 0),
    Number(row?.active_30d || 0),
    Number(row?.new_1d || 0)
  ).run();
}

function adminHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rel.AI Operations — Developer Analytics</title>
<style>
:root {
  color-scheme: dark;
  --bg-canvas: #09090b;
  --bg-surface: #121215;
  --bg-surface-raised: #18181b;
  --bg-surface-hover: #202025;
  --bg-input: #141416;
  --border-subtle: rgba(255, 255, 255, 0.08);
  --border-default: rgba(255, 255, 255, 0.14);
  --border-control: #38383f;
  --border-focus: #10a37f;
  --text-primary: #f4f4f5;
  --text-secondary: #a1a1aa;
  --text-tertiary: #71717a;
  --accent-openai: #10a37f;
  --accent-openai-hover: #0e8c6d;
  --accent-openai-active: #0b745b;
  --accent-openai-glow: rgba(16, 163, 127, 0.18);
  --accent-relai: #d8ff74;
  --accent-relai-glow: rgba(216, 255, 116, 0.2);
  --status-success: #10b981;
  --status-danger: #ef4444;
  --status-warning: #f59e0b;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-xl: 18px;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  --shadow-card: 0 4px 20px -2px rgba(0, 0, 0, 0.45);
  --shadow-hover: 0 10px 30px -4px rgba(0, 0, 0, 0.6);
  --shadow-popover: 0 16px 44px -6px rgba(0, 0, 0, 0.7);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: var(--bg-canvas);
  color: var(--text-primary);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  min-height: 100vh;
}
input, button {
  font-family: inherit;
  font-size: 13px;
  color: inherit;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-input);
  outline: none;
  transition: all 0.15s ease;
}
input:focus-visible {
  border-color: var(--accent-openai);
  box-shadow: 0 0 0 3px var(--accent-openai-glow);
}
button {
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  font-weight: 550;
  user-select: none;
}
button:focus-visible {
  outline: 2px solid var(--accent-openai);
  outline-offset: 2px;
}
a {
  color: inherit;
  text-decoration: none;
}

/* Header */
.app-header {
  position: sticky;
  top: 0;
  z-index: 100;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  background: rgba(9, 9, 11, 0.82);
  border-bottom: 1px solid var(--border-subtle);
  height: 60px;
  display: flex;
  align-items: center;
}
.header-inner {
  width: min(1240px, calc(100% - 40px));
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.brand-group {
  display: flex;
  align-items: center;
  gap: 12px;
}
.brand-logo-mark {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: #111114;
  border: 1px solid rgba(216, 255, 116, 0.25);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.5);
  display: grid;
  place-items: center;
  flex-shrink: 0;
}
.brand-titles {
  display: flex;
  flex-direction: column;
}
.brand-eyebrow {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--accent-relai);
  line-height: 1.2;
}
.brand-title {
  font-size: 14px;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}
.badge-edge {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 99px;
  background: rgba(16, 163, 127, 0.14);
  border: 1px solid rgba(16, 163, 127, 0.3);
  color: var(--accent-openai);
  letter-spacing: 0.02em;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.status-beacon {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-secondary);
  padding: 5px 10px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 99px;
  margin-right: 4px;
}
.beacon-dot {
  width: 7px;
  height: 7px;
  border-radius: 99px;
  background: var(--accent-openai);
  box-shadow: 0 0 0 2.5px rgba(16, 163, 127, 0.25);
  animation: pulse-beacon 2s infinite ease-in-out;
}
@keyframes pulse-beacon {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.15); opacity: 0.8; }
}

.btn-secondary {
  background: var(--bg-surface-raised);
  border: 1px solid var(--border-subtle);
  padding: 6px 12px;
  font-size: 12.5px;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  height: 34px;
}
.btn-secondary:hover {
  background: var(--bg-surface-hover);
  color: var(--text-primary);
  border-color: var(--border-default);
}
.btn-ghost {
  background: transparent;
  border: 1px solid transparent;
  padding: 6px 12px;
  font-size: 12.5px;
  border-radius: var(--radius-md);
  color: var(--text-tertiary);
  height: 34px;
}
.btn-ghost:hover {
  background: var(--bg-surface-raised);
  color: var(--text-secondary);
  border-color: var(--border-subtle);
}
.btn-primary {
  background: var(--accent-openai);
  color: #ffffff;
  border: 1px solid transparent;
  font-weight: 600;
  padding: 8px 16px;
  border-radius: var(--radius-md);
  box-shadow: 0 2px 8px rgba(16, 163, 127, 0.3);
}
.btn-primary:hover {
  background: var(--accent-openai-hover);
}
.btn-primary:active {
  background: var(--accent-openai-active);
}
.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Auth View */
.auth-wrapper {
  min-height: calc(100vh - 120px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  background: radial-gradient(circle at 50% 28%, rgba(16, 163, 127, 0.08), transparent 60%);
}
.auth-card {
  width: min(420px, 100%);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xl);
  padding: 36px 32px 30px;
  box-shadow: var(--shadow-popover);
  display: flex;
  flex-direction: column;
  align-items: stretch;
}
.auth-hero {
  text-align: center;
  margin-bottom: 24px;
}
.auth-logo-box {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  background: #111114;
  border: 1px solid rgba(216, 255, 116, 0.28);
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.6), 0 0 20px rgba(16, 163, 127, 0.16);
  display: grid;
  place-items: center;
  margin: 0 auto 16px;
}
.auth-eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--accent-relai);
  margin-bottom: 6px;
}
.auth-hero h1 {
  font-size: 22px;
  font-weight: 650;
  letter-spacing: -0.02em;
  margin-bottom: 8px;
}
.auth-hero p {
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
}
.auth-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.form-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.form-field label {
  font-size: 12px;
  font-weight: 550;
  color: var(--text-secondary);
}
.input-with-icon {
  position: relative;
  display: flex;
  align-items: center;
}
.input-with-icon input {
  width: 100%;
  height: 42px;
  padding: 0 38px 0 36px;
}
.input-icon-left {
  position: absolute;
  left: 12px;
  color: var(--text-tertiary);
  pointer-events: none;
  display: flex;
}
.input-toggle-right {
  position: absolute;
  right: 8px;
  background: transparent;
  border: none;
  color: var(--text-tertiary);
  padding: 6px;
  border-radius: var(--radius-sm);
  display: flex;
}
.input-toggle-right:hover {
  color: var(--text-primary);
}
.auth-checkbox-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  user-select: none;
  cursor: pointer;
}
.auth-checkbox-row input[type="checkbox"] {
  accent-color: var(--accent-openai);
  cursor: pointer;
  width: 14px;
  height: 14px;
}
.auth-error {
  display: none;
  align-items: flex-start;
  gap: 8px;
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.28);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  font-size: 12px;
  color: #fca5a5;
  line-height: 1.4;
}
.auth-error.visible {
  display: flex;
}
.auth-submit-btn {
  height: 42px;
  margin-top: 4px;
  font-size: 13.5px;
}
.auth-footer {
  margin-top: 24px;
  padding-top: 18px;
  border-top: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: var(--text-tertiary);
  font-size: 11px;
}

/* Dashboard View */
.dashboard-container {
  width: min(1240px, calc(100% - 40px));
  margin: 0 auto;
  padding: 32px 0 64px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* Hero Overview */
.hero-overview {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
  padding-bottom: 4px;
}
.hero-text h1 {
  font-size: clamp(24px, 4vw, 32px);
  font-weight: 700;
  letter-spacing: -0.03em;
  margin-bottom: 6px;
}
.hero-text p {
  color: var(--text-secondary);
  font-size: 13.5px;
  max-width: 680px;
}
.hero-chips {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.hero-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  padding: 5px 11px;
  border-radius: 99px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  color: var(--text-secondary);
}
.hero-chip.highlight {
  border-color: rgba(216, 255, 116, 0.25);
  color: var(--accent-relai);
  background: rgba(216, 255, 116, 0.04);
}

/* KPI Bento Grid */
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 14px;
}
.kpi-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: 20px;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  box-shadow: var(--shadow-card);
  transition: border-color 0.2s, transform 0.2s, box-shadow 0.2s;
}
.kpi-card:hover {
  border-color: var(--border-default);
  box-shadow: var(--shadow-hover);
}
.kpi-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.kpi-icon {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md);
  background: var(--bg-surface-raised);
  border: 1px solid var(--border-subtle);
  display: grid;
  place-items: center;
  color: var(--accent-openai);
}
.kpi-card:nth-child(1) .kpi-icon { color: var(--accent-relai); }
.kpi-card:nth-child(5) .kpi-icon { color: #38bdf8; }

.kpi-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 99px;
  background: var(--bg-surface-raised);
  border: 1px solid var(--border-subtle);
  color: var(--text-tertiary);
  letter-spacing: 0.02em;
}
.kpi-badge.pulse {
  background: rgba(16, 163, 127, 0.12);
  border-color: rgba(16, 163, 127, 0.25);
  color: var(--accent-openai);
  display: flex;
  align-items: center;
  gap: 5px;
}
.kpi-badge.pulse::before {
  content: "";
  width: 5px;
  height: 5px;
  border-radius: 99px;
  background: var(--accent-openai);
}
.kpi-value {
  font-size: 28px;
  font-weight: 750;
  letter-spacing: -0.04em;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  margin-bottom: 4px;
}
.kpi-label {
  font-size: 11.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
  margin-bottom: 6px;
}
.kpi-meta {
  font-size: 11.5px;
  color: var(--text-secondary);
}
.kpi-sub-pills {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  flex-wrap: wrap;
}
.kpi-sub-pill {
  font-size: 10.5px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-surface-raised);
  border: 1px solid var(--border-subtle);
  color: var(--text-secondary);
}

/* Trend Chart Section */
.chart-panel {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: 22px 24px;
  box-shadow: var(--shadow-card);
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.chart-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.chart-title-group h2 {
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.01em;
  margin-bottom: 2px;
}
.chart-title-group p {
  color: var(--text-tertiary);
  font-size: 12px;
}
.chart-controls {
  display: flex;
  align-items: center;
  gap: 14px;
}
.chart-legend {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 11.5px;
  color: var(--text-secondary);
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
}
.legend-swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}
.swatch-active { background: var(--accent-openai); }
.swatch-new { background: var(--accent-relai); }

.range-tabs {
  display: flex;
  background: var(--bg-surface-raised);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 2px;
}
.range-btn {
  background: transparent;
  border: none;
  font-size: 11.5px;
  padding: 4px 10px;
  border-radius: 7px;
  color: var(--text-tertiary);
  height: auto;
}
.range-btn.active {
  background: var(--bg-surface);
  color: var(--text-primary);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0,0,0,0.4);
}

.chart-stage {
  position: relative;
  width: 100%;
  height: 200px;
  border-radius: var(--radius-md);
  background: rgba(14, 14, 17, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.04);
  overflow: hidden;
}
.chart-svg {
  width: 100%;
  height: 100%;
  display: block;
}
.chart-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--text-tertiary);
  gap: 8px;
  padding: 20px;
}
.chart-empty svg {
  color: var(--text-tertiary);
  opacity: 0.6;
}
.chart-empty strong {
  color: var(--text-secondary);
  font-size: 13px;
}
.chart-empty p {
  font-size: 12px;
  max-width: 440px;
}

.chart-tooltip {
  position: absolute;
  display: none;
  background: var(--bg-surface-raised);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 8px 12px;
  font-size: 11.5px;
  box-shadow: var(--shadow-popover);
  pointer-events: none;
  z-index: 10;
  transform: translate(-50%, -110%);
  white-space: nowrap;
}
.chart-tooltip strong {
  display: block;
  font-size: 12px;
  color: var(--text-primary);
  margin-bottom: 4px;
}
.tooltip-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--text-secondary);
}
.tooltip-val {
  font-weight: 600;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

/* Distribution Bento Grid (3-column) */
.dist-grid {
  display: grid;
  grid-template-columns: 1.4fr 1fr 1fr;
  gap: 16px;
}
.panel-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: 20px 22px;
  box-shadow: var(--shadow-card);
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.panel-title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}
.panel-header h2 {
  font-size: 14.5px;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.panel-count {
  font-size: 10.5px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 99px;
  background: var(--bg-surface-raised);
  border: 1px solid var(--border-subtle);
  color: var(--text-tertiary);
}
.panel-search {
  height: 28px;
  padding: 0 8px 0 26px;
  font-size: 11.5px;
  width: 140px;
  border-radius: var(--radius-sm);
}
.search-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}
.search-icon {
  position: absolute;
  left: 8px;
  color: var(--text-tertiary);
  pointer-events: none;
}

.dist-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 380px;
  overflow-y: auto;
  padding-right: 4px;
}
.dist-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: var(--bg-surface-raised);
  border: 1px solid rgba(255, 255, 255, 0.04);
  transition: border-color 0.15s;
}
.dist-row:hover {
  border-color: var(--border-subtle);
}
.dist-row-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 12.5px;
}
.dist-name-group {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dist-icon {
  color: var(--text-tertiary);
  display: flex;
  flex-shrink: 0;
}
.dist-name {
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dist-tag {
  font-size: 9.5px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(16, 163, 127, 0.14);
  color: var(--accent-openai);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.dist-values {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.dist-count {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}
.dist-pct {
  font-size: 11px;
  color: var(--text-tertiary);
  width: 40px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.dist-bar-track {
  width: 100%;
  height: 5px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 99px;
  overflow: hidden;
}
.dist-bar-fill {
  height: 100%;
  border-radius: 99px;
  background: linear-gradient(90deg, var(--accent-openai), var(--accent-relai));
  transition: width 0.4s ease;
}
.dist-bar-fill.platform-bar {
  background: linear-gradient(90deg, #38bdf8, var(--accent-openai));
}
.dist-bar-fill.arch-bar {
  background: linear-gradient(90deg, #a78bfa, var(--accent-openai));
}

/* Insights & Privacy Strip */
.insights-strip {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.insight-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: 18px 22px;
  display: flex;
  align-items: center;
  gap: 16px;
}
.insight-icon-box {
  width: 42px;
  height: 42px;
  border-radius: var(--radius-md);
  background: rgba(16, 163, 127, 0.1);
  border: 1px solid rgba(16, 163, 127, 0.25);
  display: grid;
  place-items: center;
  color: var(--accent-openai);
  flex-shrink: 0;
}
.insight-icon-box.relai-tint {
  background: rgba(216, 255, 116, 0.08);
  border-color: rgba(216, 255, 116, 0.22);
  color: var(--accent-relai);
}
.insight-copy strong {
  font-size: 13.5px;
  display: block;
  margin-bottom: 3px;
}
.insight-copy p {
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.45;
}
.insight-stat {
  margin-left: auto;
  text-align: right;
  flex-shrink: 0;
}
.insight-stat-num {
  font-size: 20px;
  font-weight: 750;
  color: var(--accent-openai);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.insight-stat-label {
  font-size: 10.5px;
  color: var(--text-tertiary);
  text-transform: uppercase;
  margin-top: 4px;
}

/* Footer */
.app-footer {
  border-top: 1px solid var(--border-subtle);
  padding: 24px 0 36px;
  color: var(--text-tertiary);
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
}
.footer-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.footer-right {
  display: flex;
  align-items: center;
  gap: 16px;
}
.footer-right a:hover {
  color: var(--accent-openai);
}

/* Toast */
.toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 200;
  background: var(--bg-surface-raised);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: 10px 16px;
  color: var(--text-primary);
  font-size: 12.5px;
  box-shadow: var(--shadow-popover);
  display: flex;
  align-items: center;
  gap: 8px;
  opacity: 0;
  transform: translateY(12px);
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  pointer-events: none;
}
.toast.show {
  opacity: 1;
  transform: translateY(0);
}
.toast-dot {
  width: 6px;
  height: 6px;
  border-radius: 99px;
  background: var(--accent-openai);
}

/* Spin animation */
.spinning {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Responsive */
@media (max-width: 1080px) {
  .kpi-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .dist-grid { grid-template-columns: 1fr; }
  .insights-strip { grid-template-columns: 1fr; }
}
@media (max-width: 720px) {
  .kpi-grid { grid-template-columns: 1fr 1fr; }
  .header-actions .btn-secondary span { display: none; }
  .status-beacon { display: none; }
}
@media (max-width: 480px) {
  .kpi-grid { grid-template-columns: 1fr; }
  .auth-card { padding: 24px 20px; }
}
</style>
</head>
<body>

<header class="app-header">
  <div class="header-inner">
    <div class="brand-group">
      <div class="brand-logo-mark" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
          <circle cx="10" cy="11" r="3" fill="#d8ff74"/>
          <circle cx="22" cy="11" r="3" fill="#10a37f"/>
          <circle cx="16" cy="22" r="3" fill="#d8ff74"/>
          <path d="M10 11L22 11M22 11L16 22M16 22L10 11" stroke="rgba(255,255,255,0.4)" stroke-width="1.8" stroke-linecap="round"/>
          <circle cx="16" cy="15" r="1.8" fill="#ffffff"/>
        </svg>
      </div>
      <div class="brand-titles">
        <span class="brand-eyebrow">Rel.AI Operations</span>
        <span class="brand-title">Developer Analytics <span class="badge-edge">D1 Edge</span></span>
      </div>
    </div>

    <div class="header-actions" id="header-authenticated-actions" style="display:none;">
      <div class="status-beacon" title="Connected to Cloudflare D1 (APAC Edge)">
        <span class="beacon-dot"></span>
        <span>Connected · APAC D1</span>
      </div>
      <button class="btn btn-secondary" id="btn-sync" title="Refresh metrics (Key: R)">
        <svg class="icon-sync" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>
        <span>Refresh</span>
      </button>
      <button class="btn btn-secondary" id="btn-copy" title="Copy markdown summary table">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
        <span>Copy summary</span>
      </button>
      <a href="https://app.axiom.co/" target="_blank" rel="noreferrer" class="btn btn-secondary" title="Explore diagnostic traces in Axiom">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14L21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
        <span>Axiom traces ↗</span>
      </a>
      <button class="btn btn-ghost" id="btn-logout" title="Sign out">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        <span>Sign out</span>
      </button>
    </div>
  </div>
</header>

<!-- Auth View -->
<main id="auth-view" class="auth-wrapper">
  <div class="auth-card">
    <div class="auth-hero">
      <div class="auth-logo-box" aria-hidden="true">
        <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
          <circle cx="10" cy="11" r="3.5" fill="#d8ff74"/>
          <circle cx="22" cy="11" r="3.5" fill="#10a37f"/>
          <circle cx="16" cy="22" r="3.5" fill="#d8ff74"/>
          <path d="M10 11L22 11M22 11L16 22M16 22L10 11" stroke="rgba(255,255,255,0.45)" stroke-width="2" stroke-linecap="round"/>
          <circle cx="16" cy="15" r="2.2" fill="#ffffff"/>
        </svg>
      </div>
      <div class="auth-eyebrow">Rel.AI Operations</div>
      <h1>Developer Analytics</h1>
      <p>Sign in with administrator credentials to inspect installation metrics and telemetry adoption.</p>
    </div>

    <form class="auth-form" id="auth-form" onsubmit="return false;">
      <div class="auth-error" id="auth-error" role="alert">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span id="auth-error-text">Invalid administrator credentials.</span>
      </div>

      <div class="form-field">
        <label for="login-username">Administrator Username</label>
        <div class="input-with-icon">
          <span class="input-icon-left" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          </span>
          <input id="login-username" type="text" autocomplete="username" value="admin" required placeholder="admin">
        </div>
      </div>

      <div class="form-field">
        <label for="login-password">Password</label>
        <div class="input-with-icon">
          <span class="input-icon-left" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </span>
          <input id="login-password" type="password" autocomplete="current-password" required placeholder="RelAI-••••••••••••••••••••••••">
          <button type="button" class="input-toggle-right" id="btn-toggle-pwd" title="Toggle password visibility" aria-label="Toggle password visibility">
            <svg id="eye-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </div>
      </div>

      <label class="auth-checkbox-row">
        <input type="checkbox" id="auth-remember" checked>
        <span>Remember session on this device</span>
      </label>

      <button type="submit" class="btn btn-primary auth-submit-btn" id="btn-login">
        <span id="btn-login-text">Sign in to Dashboard</span>
      </button>
    </form>

    <div class="auth-footer">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      <span>Privacy-bounded edge · Hardware-isolated APAC D1</span>
    </div>
  </div>
</main>

<!-- Dashboard View -->
<main id="dashboard-view" class="dashboard-container" style="display:none;">
  <div class="hero-overview">
    <div class="hero-text">
      <h1>Deployment & Adoption Analytics</h1>
      <p>Live installation activity recorded by the privacy-bounded usage edge. Deduplicated by random installation UUID.</p>
    </div>
    <div class="hero-chips">
      <div class="hero-chip highlight" id="chip-updated">Updated just now</div>
      <div class="hero-chip" id="chip-cadence">Sync: On Demand</div>
      <div class="hero-chip">Region: APAC (D1)</div>
    </div>
  </div>

  <!-- KPI Bento Grid -->
  <div class="kpi-grid">
    <!-- Total Installations -->
    <div class="kpi-card">
      <div class="kpi-top">
        <div class="kpi-icon" aria-hidden="true">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/></svg>
        </div>
        <span class="kpi-badge">All-Time</span>
      </div>
      <div class="kpi-value" id="kpi-total">0</div>
      <div class="kpi-label">Total Installations</div>
      <div class="kpi-meta">Deduplicated client registry</div>
    </div>

    <!-- Active 24h -->
    <div class="kpi-card">
      <div class="kpi-top">
        <div class="kpi-icon" aria-hidden="true">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
        </div>
        <span class="kpi-badge pulse">Live (DAU)</span>
      </div>
      <div class="kpi-value" id="kpi-active1d">0</div>
      <div class="kpi-label">Active 24 Hours</div>
      <div class="kpi-meta"><span id="kpi-active1d-pct">0%</span> of installations</div>
    </div>

    <!-- Active 7d -->
    <div class="kpi-card">
      <div class="kpi-top">
        <div class="kpi-icon" aria-hidden="true">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 2v4"/><path d="M16 2v4"/></svg>
        </div>
        <span class="kpi-badge">Weekly (WAU)</span>
      </div>
      <div class="kpi-value" id="kpi-active7d">0</div>
      <div class="kpi-label">Active 7 Days</div>
      <div class="kpi-meta"><span id="kpi-active7d-pct">0%</span> of installations</div>
    </div>

    <!-- Active 30d -->
    <div class="kpi-card">
      <div class="kpi-top">
        <div class="kpi-icon" aria-hidden="true">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/><path d="m19 3-.8 2.2a1 1 0 0 1-.7.7L15 6.5l2.2.8a1 1 0 0 1 .7.7l.8 2.2.8-2.2a1 1 0 0 1 .7-.7l2.2-.8-2.2-.8a1 1 0 0 1-.7-.7Z"/></svg>
        </div>
        <span class="kpi-badge">Monthly (MAU)</span>
      </div>
      <div class="kpi-value" id="kpi-active30d">0</div>
      <div class="kpi-label">Active 30 Days</div>
      <div class="kpi-meta"><span id="kpi-active30d-pct">0%</span> of installations</div>
    </div>

    <!-- New Installations Velocity -->
    <div class="kpi-card">
      <div class="kpi-top">
        <div class="kpi-icon" aria-hidden="true">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>
        </div>
        <span class="kpi-badge">Growth</span>
      </div>
      <div class="kpi-value" id="kpi-new1d">+0</div>
      <div class="kpi-label">New Installs Today</div>
      <div class="kpi-sub-pills">
        <span class="kpi-sub-pill" id="kpi-new7d">+0 in 7d</span>
        <span class="kpi-sub-pill" id="kpi-new30d">+0 in 30d</span>
      </div>
    </div>
  </div>

  <!-- Adoption & Activity Trend Chart -->
  <section class="chart-panel">
    <div class="chart-header">
      <div class="chart-title-group">
        <h2>Adoption & Active Trend</h2>
        <p>Daily active installations and new device registrations captured by daily cron snapshots.</p>
      </div>
      <div class="chart-controls">
        <div class="chart-legend">
          <div class="legend-item"><span class="legend-swatch swatch-active"></span><span>Active 24h</span></div>
          <div class="legend-item"><span class="legend-swatch swatch-new"></span><span>New Installs</span></div>
        </div>
        <div class="range-tabs">
          <button class="range-btn active" data-range="30">30 Days</button>
          <button class="range-btn" data-range="90">90 Days</button>
        </div>
      </div>
    </div>

    <div class="chart-stage" id="chart-stage">
      <div class="chart-tooltip" id="chart-tooltip"></div>
      <div id="chart-render-target" style="width:100%;height:100%;"></div>
    </div>
  </section>

  <!-- Distribution Bento Grid (3-column) -->
  <div class="dist-grid">
    <!-- Version Adoption -->
    <div class="panel-card">
      <div class="panel-header">
        <div class="panel-title-wrap">
          <h2>Version Adoption</h2>
          <span class="panel-count" id="count-versions">0 versions</span>
        </div>
        <div class="search-wrapper">
          <span class="search-icon" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          </span>
          <input type="text" class="panel-search" id="search-versions" placeholder="Filter..." aria-label="Filter versions">
        </div>
      </div>
      <div class="dist-list" id="list-versions"></div>
    </div>

    <!-- Operating Systems -->
    <div class="panel-card">
      <div class="panel-header">
        <div class="panel-title-wrap">
          <h2>Operating Systems</h2>
          <span class="panel-count" id="count-platforms">0 platforms</span>
        </div>
      </div>
      <div class="dist-list" id="list-platforms"></div>
    </div>

    <!-- CPU Architectures -->
    <div class="panel-card">
      <div class="panel-header">
        <div class="panel-title-wrap">
          <h2>CPU Architectures</h2>
          <span class="panel-count" id="count-architectures">0 archs</span>
        </div>
      </div>
      <div class="dist-list" id="list-architectures"></div>
    </div>
  </div>

  <!-- Insights & Privacy Strip -->
  <div class="insights-strip">
    <div class="insight-card">
      <div class="insight-icon-box" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20v-6M6 20V10M18 20V4"/></svg>
      </div>
      <div class="insight-copy">
        <strong>Stickiness & Engagement Ratio</strong>
        <p>Proportion of monthly active installations returning daily (DAU / MAU ratio).</p>
      </div>
      <div class="insight-stat">
        <div class="insight-stat-num" id="stat-stickiness">—</div>
        <div class="insight-stat-label">DAU / MAU</div>
      </div>
    </div>

    <div class="insight-card">
      <div class="insight-icon-box relai-tint" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
      </div>
      <div class="insight-copy">
        <strong>Privacy-Bounded Guarantee</strong>
        <p>Zero IP addresses, machine hostnames, prompts, file paths, or code payloads are stored in D1.</p>
      </div>
      <div class="insight-stat">
        <div class="insight-stat-num" style="color:var(--accent-relai); font-size:16px;">Verified</div>
        <div class="insight-stat-label">Zero-PII</div>
      </div>
    </div>
  </div>

  <footer class="app-footer">
    <div class="footer-left">
      <span>Rel.AI Operations · Developer Analytics</span>
      <span>•</span>
      <span id="footer-updated">Generated —</span>
    </div>
    <div class="footer-right">
      <a href="https://app.axiom.co/" target="_blank" rel="noreferrer">Open diagnostic traces in Axiom ↗</a>
      <span>•</span>
      <a href="https://github.com/Kyne0328/rel-ai-chatgpt-web-harness" target="_blank" rel="noreferrer">Rel.AI Repository ↗</a>
    </div>
  </footer>
</main>

<div class="toast" id="toast" role="status" aria-live="polite">
  <span class="toast-dot"></span>
  <span id="toast-message">Copied to clipboard</span>
</div>

<script>
(function() {
  const q = id => document.getElementById(id);
  const esc = val => String(val ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let currentSummary = null;
  let chartRange = 30;
  let versionFilter = '';
  let toastTimer = null;

  function showToast(message) {
    const toast = q('toast');
    q('toast-message').textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function getSavedAuth() {
    return sessionStorage.getItem('relai_telemetry_auth') || '';
  }

  function saveAuth(authorization) {
    sessionStorage.setItem('relai_telemetry_auth', authorization);
  }

  function clearAuth() {
    sessionStorage.removeItem('relai_telemetry_auth');
  }

  const platformMeta = {
    win32: { label: 'Windows', icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801"/></svg>' },
    darwin: { label: 'macOS', icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.42c.62-.75 1.04-1.8 1.04-2.85 0-.15-.01-.3-.04-.44-1 .04-2.19.67-2.88 1.48-.56.65-.99 1.69-.99 2.76 0 .15.02.3.04.41 1.09.08 2.21-.61 2.83-1.36Z"/></svg>' },
    linux: { label: 'Linux', icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>' }
  };

  const archMeta = {
    x64: 'x64 (Intel / AMD 64-bit)',
    arm64: 'arm64 (Apple Silicon / ARM64)',
    arm: 'arm (ARM 32-bit)',
    ia32: 'ia32 (x86 32-bit)'
  };

  function renderDistList(items, total, options = {}) {
    if (!items || !items.length) {
      return '<div style="padding:16px;text-align:center;color:var(--text-tertiary);font-size:12px;">No records available.</div>';
    }
    return items.map((item, idx) => {
      const count = Number(item.count || 0);
      const pct = total ? (count / total * 100) : 0;
      const pctRounded = pct.toFixed(1);
      const isTop = idx === 0 && items.length > 1;

      let iconHtml = options.icon || '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/></svg>';
      let label = esc(item.name);

      if (options.type === 'platform') {
        const key = String(item.name || '').toLowerCase();
        if (platformMeta[key]) {
          label = platformMeta[key].label;
          iconHtml = platformMeta[key].icon;
        }
      } else if (options.type === 'arch') {
        const key = String(item.name || '').toLowerCase();
        if (archMeta[key]) label = archMeta[key];
      }

      return '<div class="dist-row">' +
        '<div class="dist-row-top">' +
          '<div class="dist-name-group">' +
            '<span class="dist-icon">' + iconHtml + '</span>' +
            '<span class="dist-name" title="' + esc(label) + '">' + label + '</span>' +
            (options.type === 'version' && isTop ? '<span class="dist-tag">Leading</span>' : '') +
          '</div>' +
          '<div class="dist-values">' +
            '<span class="dist-count">' + count.toLocaleString() + '</span>' +
            '<span class="dist-pct">' + pctRounded + '%</span>' +
          '</div>' +
        '</div>' +
        '<div class="dist-bar-track">' +
          '<div class="dist-bar-fill ' + (options.barClass || '') + '" style="width:' + Math.max(pct, 1) + '%"></div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function renderChart(history, rangeDays) {
    const target = q('chart-render-target');
    if (!history || !history.length) {
      target.innerHTML = '<div class="chart-empty">' +
        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
        '<strong>No historical snapshot data yet</strong>' +
        '<p>Daily aggregates are computed at 00:15 UTC. Trend lines will populate automatically once snapshots accumulate in D1.</p>' +
      '</div>';
      return;
    }

    const slice = history.slice(-rangeDays);
    if (!slice.length) return;

    const width = 1000;
    const height = 200;
    const padX = 40;
    const padY = 25;
    const graphWidth = width - (padX * 2);
    const graphHeight = height - (padY * 2);

    let maxVal = Math.max(...slice.map(d => Math.max(Number(d.active_1d || 0), Number(d.new_1d || 0))), 1);
    maxVal = Math.ceil(maxVal * 1.15);

    const step = slice.length > 1 ? graphWidth / (slice.length - 1) : graphWidth;

    const activePoints = slice.map((d, i) => {
      const x = padX + (i * step);
      const y = height - padY - ((Number(d.active_1d || 0) / maxVal) * graphHeight);
      return { x, y, data: d };
    });

    const activePathD = activePoints.reduce((acc, pt, i) => {
      return i === 0 ? 'M ' + pt.x + ' ' + pt.y : acc + ' L ' + pt.x + ' ' + pt.y;
    }, '');

    const areaPathD = activePathD +
      ' L ' + activePoints[activePoints.length - 1].x + ' ' + (height - padY) +
      ' L ' + activePoints[0].x + ' ' + (height - padY) + ' Z';

    const barWidth = Math.max(3, Math.min(14, (graphWidth / slice.length) * 0.4));
    const barsHtml = slice.map((d, i) => {
      const x = padX + (i * step) - (barWidth / 2);
      const val = Number(d.new_1d || 0);
      const barH = (val / maxVal) * graphHeight;
      const y = height - padY - barH;
      return '<rect x="' + x + '" y="' + y + '" width="' + barWidth + '" height="' + Math.max(barH, 1) + '" fill="rgba(216,255,116,0.35)" rx="1.5"/>';
    }).join('');

    const gridLines = [0, 0.5, 1].map(ratio => {
      const y = height - padY - (ratio * graphHeight);
      const label = Math.round(ratio * maxVal);
      return '<line x1="' + padX + '" y1="' + y + '" x2="' + (width - padX) + '" y2="' + y + '" stroke="rgba(255,255,255,0.06)" stroke-dasharray="3 3"/>' +
        '<text x="' + (padX - 8) + '" y="' + (y + 3) + '" fill="#71717a" font-size="10" text-anchor="end" font-family="ui-sans-serif,system-ui">' + label + '</text>';
    }).join('');

    const firstDate = slice[0]?.day || '';
    const lastDate = slice[slice.length - 1]?.day || '';
    const axisLabels = '<text x="' + padX + '" y="' + (height - 8) + '" fill="#71717a" font-size="10" font-family="ui-sans-serif,system-ui">' + esc(firstDate) + '</text>' +
      '<text x="' + (width - padX) + '" y="' + (height - 8) + '" fill="#71717a" font-size="10" text-anchor="end" font-family="ui-sans-serif,system-ui">' + esc(lastDate) + '</text>';

    const dotsHtml = activePoints.map((pt, i) => {
      return '<circle class="chart-point" data-idx="' + i + '" cx="' + pt.x + '" cy="' + pt.y + '" r="3" fill="#10a37f" stroke="#09090b" stroke-width="1.5" style="cursor:pointer;"/>';
    }).join('');

    target.innerHTML = '<svg class="chart-svg" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none">' +
      '<defs>' +
        '<linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0%" stop-color="#10a37f" stop-opacity="0.32"/>' +
          '<stop offset="100%" stop-color="#10a37f" stop-opacity="0.0"/>' +
        '</linearGradient>' +
      '</defs>' +
      gridLines +
      barsHtml +
      '<path d="' + areaPathD + '" fill="url(#areaGrad)"/>' +
      '<path d="' + activePathD + '" fill="none" stroke="#10a37f" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
      dotsHtml +
      axisLabels +
    '</svg>';

    const stage = q('chart-stage');
    const tooltip = q('chart-tooltip');

    stage.onmousemove = e => {
      const rect = stage.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const svgX = (mouseX / rect.width) * width;

      let closest = activePoints[0];
      let minDiff = Infinity;
      for (const pt of activePoints) {
        const diff = Math.abs(pt.x - svgX);
        if (diff < minDiff) {
          minDiff = diff;
          closest = pt;
        }
      }

      if (closest && minDiff < (step * 0.85)) {
        const clientX = (closest.x / width) * rect.width;
        const clientY = (closest.y / height) * rect.height;
        tooltip.style.left = clientX + 'px';
        tooltip.style.top = clientY + 'px';
        tooltip.style.display = 'block';
        tooltip.innerHTML = '<strong>' + esc(closest.data.day) + '</strong>' +
          '<div class="tooltip-row"><span>Active 24h:</span><span class="tooltip-val" style="color:#10a37f;">' + Number(closest.data.active_1d || 0).toLocaleString() + '</span></div>' +
          '<div class="tooltip-row"><span>New installs:</span><span class="tooltip-val" style="color:#d8ff74;">+' + Number(closest.data.new_1d || 0).toLocaleString() + '</span></div>' +
          '<div class="tooltip-row"><span>Active 7d:</span><span class="tooltip-val">' + Number(closest.data.active_7d || 0).toLocaleString() + '</span></div>';
      } else {
        tooltip.style.display = 'none';
      }
    };

    stage.onmouseleave = () => {
      tooltip.style.display = 'none';
    };
  }

  function applySummary(s) {
    currentSummary = s;
    const totals = s.totals || {};
    const total = Number(totals.installations || 0);
    const active1d = Number(totals.active1d || 0);
    const active7d = Number(totals.active7d || 0);
    const active30d = Number(totals.active30d || 0);

    q('kpi-total').textContent = total.toLocaleString();
    q('kpi-active1d').textContent = active1d.toLocaleString();
    q('kpi-active7d').textContent = active7d.toLocaleString();
    q('kpi-active30d').textContent = active30d.toLocaleString();

    q('kpi-active1d-pct').textContent = total ? Math.round(active1d / total * 100) + '%' : '0%';
    q('kpi-active7d-pct').textContent = total ? Math.round(active7d / total * 100) + '%' : '0%';
    q('kpi-active30d-pct').textContent = total ? Math.round(active30d / total * 100) + '%' : '0%';

    q('kpi-new1d').textContent = '+' + Number(totals.new1d || 0).toLocaleString();
    q('kpi-new7d').textContent = '+' + Number(totals.new7d || 0).toLocaleString() + ' in 7d';
    q('kpi-new30d').textContent = '+' + Number(totals.new30d || 0).toLocaleString() + ' in 30d';

    const stickiness = active30d ? ((active1d / active30d) * 100).toFixed(1) + '%' : '—';
    q('stat-stickiness').textContent = stickiness;

    const timeStr = new Date(s.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const fullDate = new Date(s.generatedAt).toLocaleString();
    q('chip-updated').textContent = 'Synced ' + timeStr;
    q('footer-updated').textContent = 'Generated at ' + fullDate;

    filterAndRenderVersions();

    q('count-platforms').textContent = (s.platforms || []).length + ' platforms';
    q('list-platforms').innerHTML = renderDistList(s.platforms || [], total, { type: 'platform', barClass: 'platform-bar' });

    q('count-architectures').textContent = (s.architectures || []).length + ' architectures';
    q('list-architectures').innerHTML = renderDistList(s.architectures || [], total, { type: 'arch', barClass: 'arch-bar' });

    renderChart(s.history || [], chartRange);

    q('auth-view').style.display = 'none';
    q('dashboard-view').style.display = 'flex';
    q('header-authenticated-actions').style.display = 'flex';
  }

  function filterAndRenderVersions() {
    if (!currentSummary) return;
    const versions = currentSummary.versions || [];
    const total = Number(currentSummary.totals?.installations || 0);

    const filtered = versions.filter(item => {
      if (!versionFilter) return true;
      return String(item.name || '').toLowerCase().includes(versionFilter.toLowerCase());
    });

    q('count-versions').textContent = filtered.length + ' of ' + versions.length;
    q('list-versions').innerHTML = renderDistList(filtered, total, {
      type: 'version',
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16.5 9.4-9-5.19M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" y1="22" x2="12" y2="12"/></svg>'
    });
  }

  async function fetchSummary(authHeader, isManual = false) {
    const syncBtn = q('btn-sync');
    const syncIcon = syncBtn.querySelector('.icon-sync');
    if (syncIcon) syncIcon.classList.add('spinning');

    try {
      const res = await fetch('/api/v1/admin/summary', {
        headers: { authorization: authHeader }
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Authentication rejected (' + res.status + ')');
      }

      applySummary(data.summary);
      if (isManual) showToast('Metrics updated successfully');
      return true;
    } catch (err) {
      if (isManual) showToast('Sync failed: ' + err.message);
      throw err;
    } finally {
      if (syncIcon) syncIcon.classList.remove('spinning');
    }
  }

  async function handleLogin() {
    const user = q('login-username').value.trim();
    const pass = q('login-password').value;
    const errBox = q('auth-error');
    const errText = q('auth-error-text');
    const submitBtn = q('btn-login');
    const submitText = q('btn-login-text');

    if (!user || !pass) {
      errText.textContent = 'Please enter both username and password.';
      errBox.classList.add('visible');
      return;
    }

    errBox.classList.remove('visible');
    submitBtn.disabled = true;
    submitText.textContent = 'Verifying credentials…';

    const auth = 'Basic ' + btoa(user + ':' + pass);

    try {
      await fetchSummary(auth);
      if (q('auth-remember').checked) {
        saveAuth(auth);
      } else {
        clearAuth();
      }
      showToast('Welcome, Administrator');
    } catch (err) {
      errText.textContent = err.message || 'Invalid username or password.';
      errBox.classList.add('visible');
      q('login-password').focus();
    } finally {
      submitBtn.disabled = false;
      submitText.textContent = 'Sign in to Dashboard';
    }
  }

  function handleLogout() {
    clearAuth();
    currentSummary = null;
    q('login-password').value = '';
    q('dashboard-view').style.display = 'none';
    q('header-authenticated-actions').style.display = 'none';
    q('auth-view').style.display = 'flex';
    q('auth-error').classList.remove('visible');
    q('login-password').focus();
    showToast('Signed out of developer console');
  }

  function copyMarkdownSummary() {
    if (!currentSummary) return;
    const s = currentSummary;
    const t = s.totals || {};

    let md = '### Rel.AI Operations — Developer Analytics\\n\\n' +
      '| Metric | Value |\\n' +
      '|:---|---:|\\n' +
      '| Total Installations | ' + Number(t.installations || 0).toLocaleString() + ' |\\n' +
      '| Active 24 Hours (DAU) | ' + Number(t.active1d || 0).toLocaleString() + ' |\\n' +
      '| Active 7 Days (WAU) | ' + Number(t.active7d || 0).toLocaleString() + ' |\\n' +
      '| Active 30 Days (MAU) | ' + Number(t.active30d || 0).toLocaleString() + ' |\\n' +
      '| New Installs (Today) | +' + Number(t.new1d || 0).toLocaleString() + ' |\\n' +
      '| New Installs (7d) | +' + Number(t.new7d || 0).toLocaleString() + ' |\\n' +
      '| New Installs (30d) | +' + Number(t.new30d || 0).toLocaleString() + ' |\\n\\n';

    if (s.versions && s.versions.length) {
      md += '#### Version Adoption\\n\\n| Version | Installations |\\n|:---|---:|\\n';
      s.versions.forEach(v => {
        md += '| ' + v.name + ' | ' + Number(v.count || 0).toLocaleString() + ' |\\n';
      });
      md += '\\n';
    }

    if (s.platforms && s.platforms.length) {
      md += '#### Platforms\\n\\n| Platform | Installations |\\n|:---|---:|\\n';
      s.platforms.forEach(p => {
        md += '| ' + p.name + ' | ' + Number(p.count || 0).toLocaleString() + ' |\\n';
      });
      md += '\\n';
    }

    navigator.clipboard.writeText(md).then(() => {
      showToast('Markdown summary copied to clipboard');
    }).catch(() => {
      showToast('Failed to copy to clipboard');
    });
  }

  function exportJson() {
    if (!currentSummary) return;
    const blob = new Blob([JSON.stringify(currentSummary, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'relai-analytics-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Analytics JSON downloaded');
  }

  // Event Listeners
  q('auth-form').addEventListener('submit', handleLogin);
  q('login-username').addEventListener('keydown', e => {
    if (e.key === 'Enter') q('login-password').focus();
  });
  q('btn-logout').addEventListener('click', handleLogout);
  q('btn-sync').addEventListener('click', () => {
    const auth = getSavedAuth();
    if (auth) fetchSummary(auth, true);
  });
  q('btn-copy').addEventListener('click', copyMarkdownSummary);

  q('btn-toggle-pwd').addEventListener('click', () => {
    const pwdInput = q('login-password');
    const isPass = pwdInput.type === 'password';
    pwdInput.type = isPass ? 'text' : 'password';
    q('eye-icon').innerHTML = isPass
      ? '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/>'
      : '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>';
  });

  q('search-versions').addEventListener('input', e => {
    versionFilter = e.target.value.trim();
    filterAndRenderVersions();
  });

  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      chartRange = parseInt(e.target.dataset.range, 10) || 30;
      if (currentSummary) renderChart(currentSummary.history || [], chartRange);
    });
  });

  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'r' || e.key === 'R') {
      const auth = getSavedAuth();
      if (auth && q('dashboard-view').style.display !== 'none') {
        e.preventDefault();
        fetchSummary(auth, true);
      }
    }
  });

  // Auto-authenticate if session exists
  const existingAuth = getSavedAuth();
  if (existingAuth) {
    fetchSummary(existingAuth).catch(() => {
      clearAuth();
      q('auth-view').style.display = 'flex';
      q('dashboard-view').style.display = 'none';
      q('header-authenticated-actions').style.display = 'none';
    });
  } else {
    q('auth-view').style.display = 'flex';
    q('dashboard-view').style.display = 'none';
    q('header-authenticated-actions').style.display = 'none';
  }
})();
</script>
</body></html>`;
}

async function handleHealth(env) {
  try {
    await env.DB.prepare('SELECT 1 AS ok').first();
    return json({ ok: true, service: 'relai-telemetry' });
  } catch {
    return json({ ok: false, service: 'relai-telemetry' }, 503);
  }
}

const handler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/health') return handleHealth(env);
      if (request.method === 'GET' && url.pathname === '/admin') {
        return new Response(adminHtml(), {
          status: 200,
          headers: withSecurityHeaders({
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
          })
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/admin/summary') return handleAdminSummary(request, env);
      if (request.method === 'POST' && url.pathname === '/api/v1/installation/presence') return handlePresence(request, env);
      if (request.method === 'POST' && url.pathname === '/v1/traces') return handleTraces(request, env);
      return json({ ok: false, error: 'Not found.' }, 404);
    } catch (error) {
      console.error('relai-telemetry request failed', error instanceof Error ? error.message : String(error));
      return json({ ok: false, error: 'Internal telemetry service error.' }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(writeDailySnapshot(env.DB));
  }
};

export { adminHtml, aggregateSummary, axiomTraceUrl, constantTimeEqual, hashAdminPassword, isAuthorizedAdmin, parseBasicAuthorization, validatePresence, writeDailySnapshot };
export default handler;
