const MAX_DESKTOP_CLIPBOARD_BYTES = 64 * 1024;
const ALLOWED_DESKTOP_URI_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function normalizeDesktopUri(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('Desktop URI is required.');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Desktop URI must be an absolute valid URI.');
  }
  if (!ALLOWED_DESKTOP_URI_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
    throw new Error(`Desktop URI protocol is not allowed: ${parsed.protocol || '(missing)'}.`);
  }
  return parsed.href;
}

function normalizeApplication(value) {
  const application = String(value || '').trim();
  if (!application) throw new Error('Application identifier is required.');
  if (application.length > 200) throw new Error('Application identifier is too long.');
  if (application.startsWith('-') || /[\\/:]/.test(application) || hasControlCharacter(application)) {
    throw new Error('Application identifier must be a plain application name, executable name, or desktop identifier, not a path or command.');
  }
  return application;
}

function assertDesktopClipboardSize(text) {
  if (Buffer.byteLength(text, 'utf8') > MAX_DESKTOP_CLIPBOARD_BYTES) {
    throw new Error('Clipboard text exceeds the 64 KiB safety limit.');
  }
}

function hasControlCharacter(value) {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

export {
  MAX_DESKTOP_CLIPBOARD_BYTES,
  assertDesktopClipboardSize,
  normalizeApplication,
  normalizeDesktopUri
};
