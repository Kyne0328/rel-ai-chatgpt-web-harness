function route(id, label, path, description, group) {
  return Object.freeze({ id, label, path, href: `#${path}`, description, group, icon: id });
}

const WORK_NAV_ITEMS = Object.freeze([
  route('home', 'Overview', 'home', 'Connection status, projects, and recent tasks.', 'Work'),
  route('tasks', 'Tasks', 'tasks', 'See active and completed Rel.AI tasks.', 'Work'),
  route('workspaces', 'Projects', 'workspaces', 'Choose which project folders Rel.AI can use.', 'Work'),
  route('browser', 'Browser', 'browser', 'View and take over the live local browser session used by Rel.AI.', 'Work'),
  route('activity', 'Activity', 'activity', 'See Rel.AI actions and their results.', 'Monitor')
]);

export const SYSTEM_NAV_ITEMS = Object.freeze([
  route('processes', 'Running commands', 'processes', 'See and stop long-running commands started by Rel.AI.', 'Monitor'),
  route('diagnostics', 'Troubleshooting', 'diagnostics', 'Find and fix problems, view logs, or export support information.', 'Monitor'),
  route('tools', 'ChatGPT tools', 'tools', 'See actions ChatGPT can run through Rel.AI.', 'Developer'),
  route('usage', 'Analytics', 'usage', 'See activity trends, success rates, timing, and problem areas.', 'Monitor')
]);

const APPLICATION_NAV_ITEMS = Object.freeze([
  route('settings', 'Settings', 'settings', 'Change connection, preferences, privacy, and app settings.', 'Application')
]);

export const EXTENSIONS_NAV_ITEM = route(
  'extensions',
  'Extensions',
  'extensions',
  'Browse and manage Rel.AI extensions. View developer templates and publishing guidance.',
  'Application'
);

export const DESKTOP_WORK_NAV_ITEMS = Object.freeze(WORK_NAV_ITEMS.filter(item => item.id !== 'activity'));
export const DESKTOP_SYSTEM_NAV_ITEMS = Object.freeze([
  WORK_NAV_ITEMS.find(item => item.id === 'activity'),
  SYSTEM_NAV_ITEMS.find(item => item.id === 'processes'),
  SYSTEM_NAV_ITEMS.find(item => item.id === 'usage'),
  SYSTEM_NAV_ITEMS.find(item => item.id === 'diagnostics')
]);
export const MOBILE_PRIMARY_NAV_ITEMS = Object.freeze([
  WORK_NAV_ITEMS.find(item => item.id === 'home'),
  WORK_NAV_ITEMS.find(item => item.id === 'tasks'),
  WORK_NAV_ITEMS.find(item => item.id === 'workspaces'),
  WORK_NAV_ITEMS.find(item => item.id === 'activity')
].filter(Boolean));
export const MOBILE_MORE_NAV_ITEMS = Object.freeze([
  WORK_NAV_ITEMS.find(item => item.id === 'browser'),
  SYSTEM_NAV_ITEMS.find(item => item.id === 'processes'),
  SYSTEM_NAV_ITEMS.find(item => item.id === 'usage'),
  SYSTEM_NAV_ITEMS.find(item => item.id === 'diagnostics'),
  APPLICATION_NAV_ITEMS[0]
].filter(Boolean));
export const SETTINGS_NAV_ITEMS = Object.freeze([
  route('preferences', 'Preferences', 'settings', 'Change appearance, Rel.AI Pulse, and desktop notifications.', 'Settings'),
  route('connection', 'Connection', 'settings/connection', 'Connect this computer and manage the saved OpenAI connection.', 'Settings'),
  route('privacy', 'Privacy & data', 'settings/privacy', 'Manage permissions, browser sign-ins, telemetry, and local data.', 'Settings'),
  route('application', 'Application', 'settings/application', 'Choose startup behavior and manage app updates.', 'Settings'),
  route('about', 'About', 'settings/about', 'View app, developer, source code, and license information.', 'Settings')
]);

export const DESKTOP_UTILITY_NAV_ITEMS = Object.freeze([
  APPLICATION_NAV_ITEMS[0]
]);
export const DESKTOP_NAV_ITEMS = Object.freeze([
  ...DESKTOP_WORK_NAV_ITEMS, ...DESKTOP_SYSTEM_NAV_ITEMS, ...DESKTOP_UTILITY_NAV_ITEMS
]);
export const MOBILE_NAV_ITEMS = Object.freeze([...MOBILE_PRIMARY_NAV_ITEMS, ...MOBILE_MORE_NAV_ITEMS]);

const ROUTES = new Map([...WORK_NAV_ITEMS, ...DESKTOP_NAV_ITEMS, EXTENSIONS_NAV_ITEM, ...SYSTEM_NAV_ITEMS, ...SETTINGS_NAV_ITEMS].map(item => [item.path, item]));

export function routeMetadata(path) {
  const id = String(path || '').toLowerCase();
  return ROUTES.get(id === 'code' ? 'tasks' : id) || ROUTES.get('home');
}

export function desktopNavigationOwner(sectionId) {
  const id = String(sectionId || '').toLowerCase();
  if (id === 'code') return 'tasks';
  if (SYSTEM_NAV_ITEMS.some(item => item.id === id)) return 'system';
  if (SETTINGS_NAV_ITEMS.some(item => item.id === id)) return 'settings';
  return id;
}

export function navigationCommands({ includeExtensions = false, includeDeveloperTools = false } = {}) {
  return [
    ...DESKTOP_WORK_NAV_ITEMS,
    ...DESKTOP_SYSTEM_NAV_ITEMS,
    ...SETTINGS_NAV_ITEMS,
    ...(includeExtensions ? [EXTENSIONS_NAV_ITEM] : []),
    ...(includeDeveloperTools ? [SYSTEM_NAV_ITEMS.find(item => item.id === 'tools')] : [])
  ];
}
