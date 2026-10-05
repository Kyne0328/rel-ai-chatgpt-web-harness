export const THEME_NAMES = Object.freeze(['dark', 'light']);

export const COLOR_THEMES = Object.freeze({
  dark: Object.freeze({
    canvas: '#0a0a0a', surfacePrimary: '#111111', surfaceSecondary: '#171717', surfaceRaised: '#1f1f1f', surfaceInput: '#141414',
    textPrimary: '#f2f2f2', textSecondary: '#c2c2c2', textTertiary: '#aeaeae', textDisabled: '#8a8a8a',
    borderSubtle: '#262626', borderDefault: '#363636', borderControl: '#666666',
    brandMarkSurface: '#111111', brandMarkBorder: 'rgba(216,255,116,.12)', brandMarkShadow: '0 .25rem .75rem rgba(0,0,0,.22)',
    actionPrimary: '#d8ff74', actionPrimaryHover: '#e3ff9a', actionPrimaryActive: '#c7eb62', actionPrimaryForeground: '#0b0d0a',
    focusRing: '#d8ff74', selectionBackground: '#242424',
    statusInfoForeground: '#5aa6ff', statusInfoBackground: '#122033', statusInfoBorder: '#4f86bd',
    statusSuccessForeground: '#4fe09a', statusSuccessBackground: '#10251a', statusSuccessBorder: '#3b9a6d',
    statusWarningForeground: '#ffc24b', statusWarningBackground: '#2a2316', statusWarningBorder: '#b38631',
    statusDangerForeground: '#ff6f88', statusDangerBackground: '#2b171b', statusDangerBorder: '#b94f67',
    statusNeutralForeground: '#b2b2b2', statusNeutralBackground: '#1f1f1f', statusNeutralBorder: '#666666',
    disabledBackground: '#1f1f1f', disabledBorder: '#363636',
    overlayModal: 'rgba(0,0,0,.62)', overlayDrawer: 'rgba(0,0,0,.42)',
    windowCloseForeground: '#ffffff', windowCloseBackground: '#c42b1c', switchThumb: '#ffffff', codeAccent: '#e5e5e5',
    scrollbarTrack: 'rgba(255,255,255,.035)', scrollbarThumb: 'rgba(178,178,178,.38)', scrollbarThumbHover: 'rgba(178,178,178,.56)', scrollbarThumbActive: 'rgba(178,178,178,.72)', scrollbarCorner: '#0a0a0a',
    shadowTitlebar: 'none', shadowSidebar: 'none', shadowTopbar: 'none', shadowWindow: '0 16px 48px rgba(0,0,0,.28)', shadowPopover: '0 18px 54px rgba(0,0,0,.48)',
    electronSurfaceGradient: 'linear-gradient(180deg, rgba(255,255,255,.018), rgba(255,255,255,0))',
    electronAppGradient: 'linear-gradient(180deg, rgba(255,255,255,.018), rgba(255,255,255,0) 42%)',
    electronElevation1: '0 1px 2px rgba(0,0,0,.38)', electronElevation2: '0 16px 40px -30px rgba(0,0,0,.9)',
    electronGlowAccent: '0 0 0 1px rgba(216,255,116,.28)', electronGlowSuccess: '0 0 0 1px rgba(79,224,154,.30)',
    heroAccentSoft: 'rgba(255,255,255,.025)', heroAccentStrong: 'rgba(255,255,255,.045)', pulseRing: 'rgba(216,255,116,.22)'
  }),
  light: Object.freeze({
    canvas: '#edf2f8', surfacePrimary: '#ffffff', surfaceSecondary: '#f5f8fc', surfaceRaised: '#e8eef6', surfaceInput: '#f7f9fd',
    textPrimary: '#172033', textSecondary: '#3f4c61', textTertiary: '#4d5a70', textDisabled: '#5b697f',
    borderSubtle: '#dce3ec', borderDefault: '#c6d0dd', borderControl: '#7e8da2',
    brandMarkSurface: '#111111', brandMarkBorder: 'rgba(216,255,116,.12)', brandMarkShadow: '0 .25rem .75rem rgba(0,0,0,.16)',
    actionPrimary: '#5a7200', actionPrimaryHover: '#546b00', actionPrimaryActive: '#4e6500', actionPrimaryForeground: '#ffffff',
    focusRing: '#455900', selectionBackground: '#dbe8b8',
    statusInfoForeground: '#1769c2', statusInfoBackground: '#e5f0fb', statusInfoBorder: '#6a94bd',
    statusSuccessForeground: '#137a4c', statusSuccessBackground: '#e5f0eb', statusSuccessBorder: '#5c9276',
    statusWarningForeground: '#7a4b00', statusWarningBackground: '#fff3d6', statusWarningBorder: '#aa7925',
    statusDangerForeground: '#bf3149', statusDangerBackground: '#f8e8eb', statusDangerBorder: '#c15b6d',
    statusNeutralForeground: '#526078', statusNeutralBackground: '#e8eef6', statusNeutralBorder: '#7e8da2',
    disabledBackground: '#e8eef6', disabledBorder: '#c6d0dd',
    overlayModal: 'rgba(3,7,14,.45)', overlayDrawer: 'rgba(3,7,14,.24)',
    windowCloseForeground: '#ffffff', windowCloseBackground: '#c42b1c', switchThumb: '#ffffff', codeAccent: '#1769c2',
    scrollbarTrack: 'rgba(23,32,51,.06)', scrollbarThumb: 'rgba(82,96,120,.38)', scrollbarThumbHover: 'rgba(82,96,120,.58)', scrollbarThumbActive: 'rgba(82,96,120,.72)', scrollbarCorner: '#edf2f8',
    shadowTitlebar: 'none', shadowSidebar: 'none', shadowTopbar: 'none', shadowWindow: '0 16px 46px rgba(38,52,76,.12)', shadowPopover: '0 18px 54px rgba(38,52,76,.18)',
    electronSurfaceGradient: 'linear-gradient(180deg, rgba(255,255,255,.98), rgba(247,249,253,.98))',
    electronAppGradient: 'linear-gradient(180deg, rgba(255,255,255,.72), rgba(255,255,255,0) 42%)',
    electronElevation1: '0 1px 2px rgba(29,43,68,.10)', electronElevation2: '0 16px 40px -30px rgba(29,43,68,.28)',
    electronGlowAccent: '0 0 0 1px rgba(90,114,0,.22)', electronGlowSuccess: '0 0 0 1px rgba(19,122,76,.24)',
    heroAccentSoft: 'rgba(23,32,51,.025)', heroAccentStrong: 'rgba(23,32,51,.045)', pulseRing: 'rgba(90,114,0,.22)'
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
