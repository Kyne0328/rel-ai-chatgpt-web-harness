const MAX_COMMAND_LENGTH = 20_000;
const AUDIT_COMMAND_LENGTH = 180;

interface CommandDisplayInvocation {
  readonly command?: unknown;
  readonly executable?: unknown;
  readonly argv?: unknown;
}

function redactCommandSecrets(value: unknown): string {
  return String(value == null ? '' : value)
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]{0,50000}?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]')
    .replace(/\b(Authorization)\s*:\s*(Bearer|Basic)\s+[^\s,;]+/gi, '$1: $2 [REDACTED]')
    .replace(/\b(Set-Cookie|Cookie)\s*:\s*[^\r\n]+/gi, '$1: [REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=:-]{6,}/gi, '$1 [REDACTED]')
    .replace(/(--(?:token|password|passwd|secret|api[-_]?key|auth[-_]?token|authtoken|client[-_]?secret))(?:=|\s+)("[^"]*"|'[^']*'|\S+)/gi, '$1 [REDACTED]')
    .replace(/\b((?:token|password|passwd|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?token|auth[-_]?token|authtoken|client[-_]?secret)[A-Za-z0-9_-]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi, '$1=[REDACTED]')
    .replace(/\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|AUTH_CODE|CLIENT_SECRET)[A-Z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/g, '$1=[REDACTED]')
    .replace(/(https?:\/\/[^\s:@/]+:)[^\s@/]+@/gi, '$1[REDACTED]@');
}

function redactCommandForDisplay(value: unknown): string {
  return redactCommandSecrets(value).slice(0, MAX_COMMAND_LENGTH);
}

function redactCommandForAudit(value: unknown): string {
  const text = redactCommandSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length <= AUDIT_COMMAND_LENGTH) return text;
  const marker = '[REDACTED]';
  let clipped = `${text.slice(0, AUDIT_COMMAND_LENGTH - 1)}…`;
  if (text.includes(marker) && !clipped.includes(marker)) {
    const suffix = `… ${marker}`;
    const prefixLength = Math.max(0, AUDIT_COMMAND_LENGTH - suffix.length);
    clipped = `${text.slice(0, prefixLength)}${suffix}`;
  }
  return clipped;
}

function formatCliArg(value: unknown): string {
  const str = String(value == null ? '' : value);
  if (!str) return '""';
  if (/^[a-zA-Z0-9_./:@%+-]+$/.test(str)) return str;
  return JSON.stringify(str);
}

function directCommandDisplay(executable: unknown, argv: unknown = []): string {
  const items = Array.isArray(argv) ? argv : [];
  return [executable, ...items].map(formatCliArg).join(' ');
}

function commandDisplayForInvocation(args: CommandDisplayInvocation = {}): string {
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (command) return redactCommandForDisplay(command);
  const executable = typeof args.executable === 'string' ? args.executable.trim() : '';
  return executable ? redactCommandForDisplay(directCommandDisplay(executable, Array.isArray(args.argv) ? args.argv : [])) : '';
}

export { commandDisplayForInvocation, directCommandDisplay, redactCommandForAudit, redactCommandForDisplay };
