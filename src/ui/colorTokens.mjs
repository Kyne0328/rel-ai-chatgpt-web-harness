export const THEME_NAMES = Object.freeze(['dark', 'light']);

export const COLOR_THEMES = Object.freeze({
  dark: Object.freeze({
    canvas: '#0a0a0a', surfacePrimary: '#111111', surfaceSecondary: '#161616', surfaceRaised: '#1f1f1f', surfaceInput: '#131313',
    textPrimary: '#f4f4f5', textSecondary: '#b4b4bc', textTertiary: '#909099', textDisabled: '#5a5a62',
    borderSubtle: '#222222', borderDefault: '#333333', borderControl: '#666666',
    brandMarkSurface: '#111111', brandMarkBorder: 'rgba(200,255,61,.18)', brandMarkShadow: '0 .25rem 1rem rgba(0,0,0,.35)',
    actionPrimary: '#c8ff3d', actionPrimaryHover: '#d8ff66', actionPrimaryActive: '#b5f229', actionPrimaryForeground: '#090a0f',
    focusRing: '#c8ff3d', selectionBackground: '#262626',
    statusInfoForeground: '#5aa6ff', statusInfoBackground: '#122033', statusInfoBorder: '#4f86bd',
    statusSuccessForeground: '#4fe09a', statusSuccessBackground: '#10251a', statusSuccessBorder: '#3b9a6d',
    statusWarningForeground: '#ffc24b', statusWarningBackground: '#2a2316', statusWarningBorder: '#b38631',
    statusDangerForeground: '#ff6f88', statusDangerBackground: '#2b171b', statusDangerBorder: '#b94f67',
    statusNeutralForeground: '#a1a1aa', statusNeutralBackground: '#1f1f1f', statusNeutralBorder: '#666666',
    disabledBackground: '#1a1a1a', disabledBorder: '#2e2e2e',
    overlayModal: 'rgba(0,0,0,.70)', overlayDrawer: 'rgba(0,0,0,.48)',
    windowCloseForeground: '#ffffff', windowCloseBackground: '#c42b1c', switchThumb: '#ffffff', codeAccent: '#e4e4e7',
    scrollbarTrack: 'rgba(255,255,255,.035)', scrollbarThumb: 'rgba(161,161,170,.38)', scrollbarThumbHover: 'rgba(161,161,170,.56)', scrollbarThumbActive: 'rgba(161,161,170,.72)', scrollbarCorner: '#0a0a0a',
    shadowTitlebar: 'none', shadowSidebar: 'none', shadowTopbar: 'none', shadowWindow: '0 20px 56px rgba(0,0,0,.45)', shadowPopover: '0 20px 60px rgba(0,0,0,.55)',
    electronSurfaceGradient: 'linear-gradient(180deg, rgba(255,255,255,.025), rgba(255,255,255,0))',
    electronAppGradient: 'linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,0) 42%)',
    electronElevation1: '0 1px 3px rgba(0,0,0,.45)', electronElevation2: '0 18px 44px -28px rgba(0,0,0,.95)',
    electronGlowAccent: '0 0 0 1px rgba(200,255,61,.32)', electronGlowSuccess: '0 0 0 1px rgba(79,224,154,.30)',
    heroAccentSoft: 'rgba(255,255,255,.03)', heroAccentStrong: 'rgba(255,255,255,.05)', pulseRing: 'rgba(200,255,61,.25)'
  }),
  light: Object.freeze({
    canvas: '#f8fafc', surfacePrimary: '#ffffff', surfaceSecondary: '#f1f5f9', surfaceRaised: '#e2e8f0', surfaceInput: '#ffffff',
    textPrimary: '#0f172a', textSecondary: '#334155', textTertiary: '#475569', textDisabled: '#64748b',
    borderSubtle: '#e2e8f0', borderDefault: '#cbd5e1', borderControl: '#64748b',
    brandMarkSurface: '#111111', brandMarkBorder: 'rgba(21,128,61,.18)', brandMarkShadow: '0 .25rem .75rem rgba(0,0,0,.14)',
    actionPrimary: '#15803d', actionPrimaryHover: '#166534', actionPrimaryActive: '#14532d', actionPrimaryForeground: '#ffffff',
    focusRing: '#166534', selectionBackground: '#dcfce7',
    statusInfoForeground: '#0369a1', statusInfoBackground: '#e0f2fe', statusInfoBorder: '#7dd3fc',
    statusSuccessForeground: '#15803d', statusSuccessBackground: '#dcfce7', statusSuccessBorder: '#86efac',
    statusWarningForeground: '#b45309', statusWarningBackground: '#fef3c7', statusWarningBorder: '#fde047',
    statusDangerForeground: '#b91c1c', statusDangerBackground: '#fee2e2', statusDangerBorder: '#fca5a5',
    statusNeutralForeground: '#475569', statusNeutralBackground: '#e2e8f0', statusNeutralBorder: '#64748b',
    disabledBackground: '#e2e8f0', disabledBorder: '#cbd5e1',
    overlayModal: 'rgba(15,23,42,.45)', overlayDrawer: 'rgba(15,23,42,.24)',
    windowCloseForeground: '#ffffff', windowCloseBackground: '#c42b1c', switchThumb: '#ffffff', codeAccent: '#0369a1',
    scrollbarTrack: 'rgba(15,23,42,.06)', scrollbarThumb: 'rgba(71,85,105,.38)', scrollbarThumbHover: 'rgba(71,85,105,.58)', scrollbarThumbActive: 'rgba(71,85,105,.72)', scrollbarCorner: '#f8fafc',
    shadowTitlebar: 'none', shadowSidebar: 'none', shadowTopbar: 'none', shadowWindow: '0 20px 48px rgba(15,23,42,.10)', shadowPopover: '0 20px 54px rgba(15,23,42,.14)',
    electronSurfaceGradient: 'linear-gradient(180deg, rgba(255,255,255,.98), rgba(248,250,252,.98))',
    electronAppGradient: 'linear-gradient(180deg, rgba(255,255,255,.72), rgba(255,255,255,0) 42%)',
    electronElevation1: '0 1px 3px rgba(15,23,42,.08)', electronElevation2: '0 18px 44px -28px rgba(15,23,42,.22)',
    electronGlowAccent: '0 0 0 1px rgba(21,128,61,.28)', electronGlowSuccess: '0 0 0 1px rgba(21,128,61,.24)',
    heroAccentSoft: 'rgba(15,23,42,.025)', heroAccentStrong: 'rgba(15,23,42,.045)', pulseRing: 'rgba(21,128,61,.22)'
  })
});

function customPropertyName(key) {
  return `--ui-${String(key).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
}

function getTheme(name = 'dark') {
  if (!Object.hasOwn(COLOR_THEMES, name)) throw new Error(`Unknown color theme: ${name}`);
  return COLOR_THEMES[name];
}

export function semanticEntries(name) {
  return Object.entries(getTheme(name)).map(([key, value]) => [customPropertyName(key), value]);
}

function renderDeclarations(name) {
  return semanticEntries(name).map(([property, value]) => `  ${property}: ${value};`).join('\n');
}

export function renderDashboardTokenCss() {
  return `/* Generated by scripts/generate-color-tokens.mjs. Do not edit directly. */\n:root {\n  color-scheme: dark;\n${renderDeclarations('dark')}\n}\n\n:root[data-theme="light"] {\n  color-scheme: light;\n${renderDeclarations('light')}\n}\n`;
}

export function renderElectronTokenCss() {
  return `/* Generated by scripts/generate-color-tokens.mjs. Do not edit directly. */\n:root {\n  color-scheme: dark;\n${renderDeclarations('dark')}\n}\n\n@media (prefers-color-scheme: light) {\n  :root:not([data-theme]) {\n    color-scheme: light;\n${renderDeclarations('light').split('\n').map(line => `  ${line}`).join('\n')}\n  }\n}\n\n:root[data-theme="light"] {\n  color-scheme: light;\n${renderDeclarations('light')}\n}\n`;
}

function parseHex(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value));
  if (!match) throw new Error(`Contrast checks require a six-digit hex color: ${value}`);
  const integer = Number.parseInt(match[1], 16);
  return [(integer >> 16) & 255, (integer >> 8) & 255, integer & 255];
}

function relativeLuminance(value) {
  const channels = parseHex(value).map(channel => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));
}

export function renderColorReferenceSvg() {
  const roles = [
    ['Canvas', 'canvas'], ['Surface', 'surfacePrimary'], ['Surface secondary', 'surfaceSecondary'],
    ['Text primary', 'textPrimary'], ['Text secondary', 'textSecondary'], ['Text tertiary', 'textTertiary'],
    ['Action primary', 'actionPrimary'], ['Information', 'statusInfoForeground'], ['Success', 'statusSuccessForeground'],
    ['Warning', 'statusWarningForeground'], ['Danger', 'statusDangerForeground']
  ];
  const columns = THEME_NAMES.map((name, columnIndex) => {
    const theme = getTheme(name);
    const x = columnIndex === 0 ? 40 : 620;
    const heading = name === 'dark' ? 'Dark theme' : 'Light theme';
    const foreground = name === 'dark' ? '#ffffff' : '#07111f';
    const opposite = name === 'dark' ? '#07111f' : '#ffffff';
    const cards = roles.map(([label, key], rowIndex) => {
      const y = 92 + rowIndex * 62;
      const fill = theme[key];
      const text = contrastRatio(fill, '#07111f') >= 4.5 ? '#07111f' : opposite;
      return `<g><rect x="${x}" y="${y}" width="520" height="48" rx="8" fill="${fill}" stroke="${theme.borderDefault}"/><text x="${x + 16}" y="${y + 21}" fill="${text}" font-size="14" font-weight="700">${escapeXml(label)}</text><text x="${x + 16}" y="${y + 38}" fill="${text}" font-size="11">${fill}</text></g>`;
    }).join('');
    return `<text x="${x}" y="52" fill="${foreground}" font-size="24" font-weight="700">${heading}</text>${cards}`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="820" viewBox="0 0 1200 820" role="img" aria-labelledby="title desc"><title id="title">Rel.AI MCP color-system reference</title><desc id="desc">Canonical light and dark semantic color tokens generated from src/ui/colorTokens.mjs.</desc><rect width="1200" height="820" fill="#111827"/><g font-family="Segoe UI,Arial,sans-serif">${columns}</g></svg>\n`;
}
