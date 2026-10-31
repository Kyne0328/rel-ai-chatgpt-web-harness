import { navigationCommands } from '../../src/ui/navigation-catalog.js';

// Canonical routes are derived from the product catalog so adding a destination
// cannot silently omit it from the rendered accessibility/reflow sweep.
const regions = {
  home: '[data-home-react]', tasks: '[data-sessions-react]',
  browser: '.browser-route', workspaces: '[data-workspaces-react]',
  activity: '.activity-master-detail', processes: '[data-processes-react]',
  diagnostics: '.diagnostic-page', tools: '[data-tools-react]', usage: '[data-usage-react]',
  settings: '[data-settings-react="preferences"]',
  'settings/connection': '[data-settings-react="connection"]',
  'settings/privacy': '[data-settings-react="privacy"]',
  'settings/application': '[data-settings-react="application"]',
  'settings/about': '[data-settings-react="about"]', extensions: '[data-extensions-react]'
};

export const UIUX_ROUTE_COVERAGE = Object.freeze(navigationCommands({ includeExtensions: true }).map(route => {
  if (!regions[route.path]) throw new Error(`UI/UX coverage region missing for ${route.path}`);
  return Object.freeze({ route: route.path, label: route.label, region: regions[route.path] });
}));

export const UIUX_MANUAL_CHECKS = Object.freeze([
  { id: 'screen-reader', status: 'not-run', scope: 'NVDA/VoiceOver reading order, live announcements, virtual history and native focus transfer' },
  { id: 'os-forced-colors', status: 'not-run', scope: 'Real OS high-contrast rendering and control boundaries; CSS support is insufficient' },
  { id: 'magnifier', status: 'not-run', scope: 'Pointer tooltip transfer, edge clipping and focus occlusion using a desktop magnifier' },
  { id: 'native-picker', status: 'not-run', scope: 'OS project folder picker and cancellation across supported platforms' },
  { id: 'platform-matrix', status: 'not-run', scope: 'macOS/Linux native setup, Recovery, Pulse and Browser focus boundaries' }
]);
