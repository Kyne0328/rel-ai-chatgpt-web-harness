export const CHATGPT_CONNECTOR_CREATE_URL = 'https://chatgpt.com/plugins#settings/Connectors?create-connector=true';
const RELAI_CONNECTOR_ICON_FILENAME = 'relai-mcp.png';
const CHATGPT_REFRESH_GROUPS = Object.freeze([
  Object.freeze({
    label: 'Go / Plus / Pro',
    steps: Object.freeze([
      'Open Settings → Plugins → Rel.AI MCP.',
      'Scroll to Information.',
      'Click Refresh.'
    ])
  }),
  Object.freeze({
    label: 'Enterprise / Edu',
    steps: Object.freeze([
      'Open Workspace settings → Apps.',
      'Find Rel.AI MCP.',
      'Open its menu and choose Action control.',
      'Click Refresh.',
      'Review the changed actions.',
      'Publish or apply the update.'
    ])
  })
]);
const CHATGPT_REFRESH_BUSINESS_NOTE = 'Business: published custom apps cannot update tools or metadata in place. Recreate and republish the app when the Rel.AI ChatGPT actions change.';

export function chatGptFirstPrompt(workspaceAlias = 'myapp') {
  const alias = String(workspaceAlias || 'myapp').trim() || 'myapp';
  return `Use Rel.AI MCP with project "${alias.replaceAll('"', '\\"')}". Look through its files and folders and summarize the project structure. Do not change any files yet.`;
}

export function chatGptGuideSteps({ mode = 'create', tunnelId = '' } = {}) {
  const tunnel = String(tunnelId || '').trim();
  const name = 'Rel.AI MCP';
  if (mode === 'reconnect') {
    return [
      'Keep Rel.AI running.',
      'Confirm that the Secure MCP Tunnel shows Connected on the Connection page.',
      'If you changed ChatGPT accounts or workspaces, sign in to the workspace that you want to use.',
      `If “${name}” already exists in that workspace, open it instead of creating a duplicate.`,
      'Set Connection to Tunnel.',
      tunnel ? `Select ${tunnel}.` : 'Select this computer’s Secure MCP Tunnel.',
      'Set Authentication to No authentication.',
      `If “${name}” does not exist in that workspace, create it once with these settings.`,
      `Enable “${name}” in the chat.`,
      'Retry the request.'
    ];
  }
  return [
    'Open ChatGPT connector setup.',
    `Set Name to “${name}”.`,
    'Set Connection to Tunnel.',
    tunnel ? `Select ${tunnel}.` : 'Select this computer’s tunnel.',
    'Set Authentication to No authentication.',
    'Click Scan Tools.',
    'Confirm that the Rel.AI tools appear.',
    'Click Create.',
    `Enable “${name}” in the chat.`,
    'Optional: Open Manage.',
    `Optional: Upload ${RELAI_CONNECTOR_ICON_FILENAME} as the connector logo.`
  ];
}

export {
  CHATGPT_REFRESH_BUSINESS_NOTE,
  CHATGPT_REFRESH_GROUPS
};
