const $ = id => document.getElementById(id);
const queryParams = new URLSearchParams(location.search);
const recoveryMode = queryParams.get('recovery') === '1';
const updateMode = queryParams.get('update') === '1';
const updatePreviousVersion = (queryParams.get('previousVersion') || '').slice(0, 80);
const updateCurrentVersion = (queryParams.get('currentVersion') || '').slice(0, 80);

function setError(value = '') {
  $('setupError').textContent = String(value || '');
}

function validPort(value) {
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}

function validTunnelId(value) {
  return /^tunnel_[A-Za-z0-9_-]{8,200}$/.test(String(value || '').trim());
}

function validRuntimeKey(value) {
  const key = String(value || '').trim();
  return key.length >= 12 && !/\s/.test(key);
}

function clearFieldError(inputId, errorId) {
  const input = $(inputId);
  const error = $(errorId);
  input?.setAttribute('aria-invalid', 'false');
  if (error) {
    error.textContent = '';
    error.hidden = true;
  }
}

function setFieldError(inputId, errorId, message) {
  const input = $(inputId);
  const error = $(errorId);
  input?.setAttribute('aria-invalid', 'true');
  if (error) {
    error.textContent = message;
    error.hidden = false;
  }
  input?.focus();
}

function clearValidationErrors() {
  clearFieldError('tunnelIdInput', 'tunnelIdError');
  clearFieldError('tunnelApiKeyInput', 'runtimeKeyError');
  clearFieldError('portInput', 'portError');
}

async function openOpenAISetup(button) {
  const destination = String(button?.dataset?.openOpenai || '');
  if (!destination) return;
  setError();
  try {
    await window.electronAPI.openOpenAISetup(destination);
  } catch (error) {
    setError(`Could not open OpenAI setup: ${messageOf(error)}`);
  }
}

async function connect() {
  const tunnelId = $('tunnelIdInput').value.trim();
  const tunnelApiKey = $('tunnelApiKeyInput').value.trim();
  const runtimeKeyConfigured = $('tunnelApiKeyInput').dataset.configured === '1';
  const port = Number($('portInput').value);
  setError();
  clearValidationErrors();
  if (!validTunnelId(tunnelId)) {
    setFieldError('tunnelIdInput', 'tunnelIdError', 'Paste a valid Secure MCP Tunnel ID beginning with tunnel_.');
    return;
  }
  if (!tunnelApiKey && !runtimeKeyConfigured) {
    setFieldError('tunnelApiKeyInput', 'runtimeKeyError', 'Paste the API key you created for this tunnel in the same OpenAI organization.');
    return;
  }
  if (tunnelApiKey && !validRuntimeKey(tunnelApiKey)) {
    setFieldError('tunnelApiKeyInput', 'runtimeKeyError', 'Paste a valid runtime API key with no spaces.');
    return;
  }
  if (!validPort(port)) {
    setFieldError('portInput', 'portError', 'Enter a local connection port from 1024 to 65535.');
    return;
  }

  const button = $('connectBtn');
  button.disabled = true;
  button.textContent = 'Connecting…';
  try {
    const result = await window.electronAPI.wizardDone({ tunnelId, tunnelApiKey, port, restart: recoveryMode });
    if (!result?.ok || !result?.status?.serverRunning) {
      throw new Error(result?.status?.error || 'The ChatGPT connection did not become ready.');
    }
  } catch (error) {
    setError(messageOf(error));
    button.disabled = false;
    button.textContent = button.dataset.updateLabel || 'Connect this computer';
  }
}

async function loadExistingSettings() {
  try {
    const config = await window.electronAPI.getRecoveryConfig();
    if (config?.port) $('portInput').value = String(config.port);
    if (config?.tunnelId) $('tunnelIdInput').value = config.tunnelId;
    if (config?.tunnelApiKeyConfigured) {
      $('tunnelApiKeyInput').placeholder = 'Stored securely. Leave blank to keep it.';
      $('tunnelApiKeyInput').dataset.configured = '1';
      $('tunnelApiKeyInput').required = false;
    }
  } catch {}
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error || 'Setup failed.');
}

function applyUpdateMode() {
  if (!updateMode || recoveryMode) return;
  document.title = 'Rel.AI MCP Update';
  const banner = $('updateBanner');
  if (banner) banner.hidden = false;
  const detail = $('updateBannerDetail');
  if (detail && (updatePreviousVersion || updateCurrentVersion)) {
    const from = updatePreviousVersion ? ` from v${updatePreviousVersion}` : '';
    const to = updateCurrentVersion ? ` to v${updateCurrentVersion}` : '';
    detail.textContent = `Rel.AI was updated${from}${to} with a full download. This launch did not find the saved connection. Reconnect once to continue.`;
  }
  const eyebrow = $('wizardEyebrow');
  if (eyebrow) eyebrow.textContent = 'Finish updating Rel.AI';
  const title = $('wizardTitle');
  if (title) title.textContent = 'Reconnect after the update';
  const subtitle = $('wizardSubtitle');
  if (subtitle) subtitle.textContent = 'Rel.AI was updated with a full download. Confirm your Secure MCP Tunnel below. No other settings need to change.';
  const action = $('connectBtn');
  if (action) action.textContent = 'Reconnect after update';
  // Remember the pre-update button label so a failed reconnect restores the
  // update copy instead of the fresh-install copy.
  if (action) action.dataset.updateLabel = 'Reconnect after update';
}

$('connectionForm').addEventListener('submit', event => {
  event.preventDefault();
  void connect();
});
$('runtimeKeyToggle').addEventListener('click', () => {
  const input = $('tunnelApiKeyInput');
  const button = $('runtimeKeyToggle');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  button.textContent = showing ? 'Show' : 'Hide';
  button.setAttribute('aria-pressed', String(!showing));
  input.focus();
});
$('cancelWizardBtn').addEventListener('click', () => window.electronAPI.closeWizard());
document.querySelectorAll('[data-open-openai]').forEach(button => button.addEventListener('click', () => openOpenAISetup(button)));
for (const [inputId, errorId] of [['tunnelIdInput', 'tunnelIdError'], ['tunnelApiKeyInput', 'runtimeKeyError'], ['portInput', 'portError']]) {
  $(inputId).addEventListener('input', () => clearFieldError(inputId, errorId));
}
applyUpdateMode();
void loadExistingSettings();
