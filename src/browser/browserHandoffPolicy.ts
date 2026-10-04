const BROWSER_HANDOFF_TTL_MS = 10 * 60 * 1000;

function browserHandoffExpired(handoff: { expiresAt?: unknown } | null | undefined, now = Date.now()): boolean {
  const expiresAt = Date.parse(String(handoff?.expiresAt || ''));
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

export { BROWSER_HANDOFF_TTL_MS, browserHandoffExpired };
