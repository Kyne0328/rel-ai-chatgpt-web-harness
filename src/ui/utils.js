// Shared UI time helpers for dashboard sections.
export function timeAgo(v, now = Date.now()) {
  const ts = typeof v === 'number' && Number.isFinite(v) ? v : Date.parse(String(v || ''));
  if (!Number.isFinite(ts)) return '';
  const m = Math.floor(Math.max(0, now - ts) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  return h < 24 ? h + 'h ago' : Math.floor(h / 24) + 'd ago';
}

export function formatDuration(milliseconds, options = {}) {
  const seconds = Math.max(0, Math.round(Number(milliseconds || 0) / 1000));
  if (options.historical) {
    if (seconds <= 0) return '0m';
    if (seconds < 60) return '<1m';
    const minutes = Math.floor(seconds / 60);
    const days = Math.floor(minutes / (24 * 60));
    const remainderAfterDays = minutes % (24 * 60);
    const hours = Math.floor(remainderAfterDays / 60);
    const remainderMinutes = remainderAfterDays % 60;
    if (days) return `${days}d${hours ? ` ${hours}h` : ''}${remainderMinutes ? ` ${remainderMinutes}m` : ''}`;
    if (hours) return `${hours}h${remainderMinutes ? ` ${remainderMinutes}m` : ''}`;
    return `${minutes}m`;
  }
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  if (minutes < 60) {
    return options.live && remainderSeconds ? `${minutes}m ${remainderSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  const minuteText = remainderMinutes ? ` ${remainderMinutes}m` : '';
  const secondText = options.live && remainderSeconds ? ` ${remainderSeconds}s` : '';
  return `${hours}h${minuteText}${secondText}`;
}

export function formatTerminalOutput(raw) {
  if (raw == null) return '';
  const text = String(raw);
  // Strip ANSI escape codes (CSI, OSC, etc.)
  const stripped = text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B[@-Z\\-_]/g, '');
  // Normalize Windows CRLF and lone CR to standard LF
  return stripped.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
