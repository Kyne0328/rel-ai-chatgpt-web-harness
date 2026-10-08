export async function copyText(text) {
  const value = String(text == null ? '' : text);
  const desktop = window.relaiDesktop;
  if (desktop?.copyText) {
    const result = await desktop.copyText(value);
    if (result?.ok === false) throw new Error(result.error || 'Desktop clipboard write failed.');
    return true;
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Browser clipboard access can be denied on loopback HTTP or by permissions.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  try {
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = typeof document.execCommand === 'function' && document.execCommand('copy');
    if (!copied) throw new Error('Clipboard access failed.');
    return true;
  } finally {
    textarea.remove();
  }
}
