function route(id, label, path, description, group) {
  return Object.freeze({ id, label, path, href: `#${path}`, description, group, icon: id });
}

export const WORK_NAV_ITEMS = Object.freeze([
  route('home', 'Overview', 'home', 'Connection status, projects, and recent tasks.', 'Work'),
  route('tasks', 'Tasks', 'tasks', 'See active and completed Rel.AI tasks.', 'Work'),
  route('code', 'Changes', 'code', 'Review current and committed file changes for a Rel.AI task.', 'Work'),
  route('browser', 'Browser', 'browser', 'View and take over the live local browser session used by Rel.AI.', 'Work'),
  route('workspaces', 'Projects', 'workspaces', 'Choose which project folders Rel.AI can use.', 'Work'),
  route('activity', 'Activity', 'activity', 'See Rel.AI actions and their results.', 'Work')
]);

export const SYSTEM_NAV_ITEMS = Object.freeze([
  route('processes', 'Running commands', 'processes', 'See and stop long-running commands started by Rel.AI.', 'System'),
  route('diagnostics', 'Troubleshooting', 'diagnostics', 'Find and fix problems, view logs, or export support information.', 'System'),
  route('tools', 'ChatGPT tools', 'tools', 'See the actions ChatGPT can ask Rel.AI to perform.', 'System'),
  route('usage', 'Analytics', 'usage', 'See activity trends, success rates, timing, and problem areas.', 'System')
]);

export const APPLICATION_NAV_ITEMS = Object.freeze([
  route('system', 'System', 'processes', 'Running commands, troubleshooting, tools, and analytics.', 'Application'),
  route('settings', 'Settings', 'settings', 'Change connection, preferences, and app settings.', 'Application')
]);

export const EXTENSIONS_NAV_ITEM = route(
  'extensions',
  'Extensions',
  'extensions',
  'Browse Rel.AI extensions and resources for building integrations.',
  'Application'
);

export const DESKTOP_NAV_ITEMS = Object.freeze([
  ...WORK_NAV_ITEMS,
  APPLICATION_NAV_ITEMS[0],
  APPLICATION_NAV_ITEMS[1]
]);
export const MOBILE_PRIMARY_NAV_ITEMS = Object.freeze([
  WORK_NAV_ITEMS.find(item => item.id === 'home'),
  WORK_NAV_ITEMS.find(item => item.id === 'tasks'),
  WORK_NAV_ITEMS.find(item => item.id === 'workspaces'),
  WORK_NAV_ITEMS.find(item => item.id === 'activity')
].filter(Boolean));
export const MOBILE_MORE_NAV_ITEMS = Object.freeze([
  WORK_NAV_ITEMS.find(item => item.id === 'code'),
  WORK_NAV_ITEMS.find(item => item.id === 'browser'),
  APPLICATION_NAV_ITEMS[0],
  APPLICATION_NAV_ITEMS[1]
].filter(Boolean));
export const MOBILE_NAV_ITEMS = Object.freeze([...DESKTOP_NAV_ITEMS]);

export const SETTINGS_NAV_ITEMS = Object.freeze([
  route('connection', 'Connection', 'settings/connection', 'Connect this computer and change OpenAI connection settings.', 'Settings'),
  route('preferences', 'Preferences', 'settings', 'Change appearance and desktop notifications.', 'Settings'),
  route('application', 'App', 'settings/application', 'Choose startup behavior and manage app updates.', 'Settings'),
  route('about', 'About', 'settings/about', 'View app, developer, source code, and license information.', 'Settings')
]);

const ROUTES = new Map([...DESKTOP_NAV_ITEMS, EXTENSIONS_NAV_ITEM, ...SYSTEM_NAV_ITEMS, ...SETTINGS_NAV_ITEMS].map(item => [item.path, item]));

export function routeMetadata(path) {
  return ROUTES.get(String(path || '').toLowerCase()) || ROUTES.get('home');
}

export function desktopNavigationOwner(sectionId) {
  const id = String(sectionId || '').toLowerCase();
  if (SYSTEM_NAV_ITEMS.some(item => item.id === id)) return 'system';
  if (SETTINGS_NAV_ITEMS.some(item => item.id === id)) return 'settings';
  return id;
}

export function navigationCommands() {
  return [...WORK_NAV_ITEMS, ...SYSTEM_NAV_ITEMS, ...SETTINGS_NAV_ITEMS];
}
