// Diagnostics contain schema facts and illustrative read-only examples, never
// echoed command payloads, credentials, or an automatically adopted task ID.
function toolArgumentError({ publicTool, action = '', fields = [], required = [], schema = {}, issues = [], message = '' }) {
  const properties = schema.properties || {};
  const maximumBatchSizes = Object.fromEntries(Object.entries(properties).filter(([, value]) => Number.isFinite(value?.maxItems)).map(([key, value]) => [key, value.maxItems]));
  const validationIssues = issues.slice(0, 8).map(issue => ({ field: issue.field || issuePath(issue.path) || sdkIssueField(issue.message, properties) || '<root>', action, message: String(issue.message || 'Invalid value.') }));
  const error = new Error(message || `Invalid arguments for ${publicTool}${action ? ` action ${action}` : ''}: ${validationIssues.map(issue => `${issue.field}: ${issue.message}`).join('; ')}`);
  error.code = 'INVALID_TOOL_ARGUMENTS';
  error.publicTool = publicTool;
  error.retryable = true;
  error.validation = {
    action, issues: validationIssues, allowedFields: fields, requiredFields: required,
    ...(Object.keys(maximumBatchSizes).length ? { maximumBatchSizes } : {}),
    ...(publicTool === 'relai_search' ? { correctedExample: action === 'semantic'
      ? { action: 'semantic', workspace: 'your-workspace', query: 'find the configuration loader', pathPrefix: 'src' }
      : { action: 'text', workspace: 'your-workspace', pattern: 'config', glob: 'src/**', contextBefore: 1, contextAfter: 1 } } : {})
  };
  error.allowedAlternatives = [`Choose fields supported by action ${action || '(explicit action required)'}.`, ...Object.entries(maximumBatchSizes).map(([field, limit]) => `Split ${field} into batches of at most ${limit}.`)];
  return error;
}
function issuePath(path) { return Array.isArray(path) ? path.map(item => typeof item === 'object' && item !== null ? item.key : item).join('.') : ''; }
function sdkIssueField(message, properties) {
  const text = String(message || '');
  // The SDK's JSON-schema adapter sometimes emits AJV-style messages without
  // standard issue.path. Only recognize its leading data/ JSON-pointer form.
  const pointer = /^data((?:\/[^\s/]+)+)(?:\s|$)/.exec(text);
  if (pointer) return pointer[1].split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')).join('.');
  const missing = /^data must have required property ['"]([^'"]+)['"]/.exec(text);
  return missing && Object.hasOwn(properties, missing[1]) ? missing[1] : '';
}
export { toolArgumentError };
