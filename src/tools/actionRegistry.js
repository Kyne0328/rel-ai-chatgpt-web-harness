// @ts-check

import { z } from 'zod';
import { OPERATION_DEFINITION_VALUES } from './operationDefinitionValues.js';
import { OPERATION_IDS as OP } from './operationIds.js';
import { AUTHORIZATION_CAPABILITY } from './contracts.ts';

const PUBLIC_CONTRACT_SCHEMA = z.object({
  required: z.array(z.string()).default([]),
  omit: z.array(z.string()).default([]),
  extra: z.record(z.string(), z.unknown()).default({})
}).strict();

const READ = AUTHORIZATION_CAPABILITY.REPOSITORY_READ;
const WRITE = AUTHORIZATION_CAPABILITY.REPOSITORY_WRITE;
const EXECUTE = AUTHORIZATION_CAPABILITY.COMMAND_EXECUTE;
const PROCESS = AUTHORIZATION_CAPABILITY.PROCESS_MANAGE;
const COMPUTER = AUTHORIZATION_CAPABILITY.COMPUTER_CONTROL;
const PUBLISH = AUTHORIZATION_CAPABILITY.GIT_PUBLISH;

const INSPECT_LOCATION_OR_SYMBOL = Object.freeze({
  anyOf: [
    { required: ['symbol'] },
    { required: ['path', 'line', 'column'] }
  ]
});

const INSPECT_FIELDS = Object.freeze({
  symbol: contract({ required: ['symbol'], omit: ['query', 'paths', 'maxDepth', 'path', 'line', 'column'] }),
  definition: contract({ omit: ['query', 'paths', 'maxDepth'], extra: INSPECT_LOCATION_OR_SYMBOL }),
  references: contract({ omit: ['query', 'paths', 'maxDepth'], extra: INSPECT_LOCATION_OR_SYMBOL }),
  hover: contract({ omit: ['query', 'paths', 'maxDepth'], extra: INSPECT_LOCATION_OR_SYMBOL }),
  implementation: contract({ omit: ['query', 'paths', 'maxDepth'], extra: INSPECT_LOCATION_OR_SYMBOL }),
  related: contract({ omit: ['paths', 'maxDepth', 'path', 'line', 'column'], extra: { anyOf: [{ required: ['query'] }, { required: ['symbol'] }] } }),
  impact: contract({ omit: ['query', 'path', 'line', 'column'], extra: { anyOf: [{ required: ['symbol'] }, { required: ['paths'] }] } }),
  trace: contract({ required: ['symbol'], omit: ['query', 'paths', 'path', 'line', 'column'] }),
  diagnostics: contract({ omit: ['symbol', 'query', 'paths', 'maxResults', 'maxDepth', 'path', 'line', 'column'] }),
  architecture: contract({ omit: ['symbol', 'query', 'paths', 'maxDepth', 'path', 'line', 'column'] }),
  audit: contract({ omit: ['symbol', 'query', 'paths', 'maxDepth', 'path', 'line', 'column'] })
});

const DESKTOP_FIELDS = Object.freeze(['path', 'uri', 'application', 'text']);
const DESKTOP_OMIT = Object.freeze({
  open_path: DESKTOP_FIELDS.filter(field => field !== 'path'),
  reveal_path: DESKTOP_FIELDS.filter(field => field !== 'path'),
  open_uri: DESKTOP_FIELDS.filter(field => field !== 'uri'),
  launch_application: DESKTOP_FIELDS.filter(field => field !== 'application'),
  clipboard_read: DESKTOP_FIELDS,
  clipboard_write: DESKTOP_FIELDS.filter(field => field !== 'text')
});

const COMPUTER_FIELDS = Object.freeze([
  'displayId', 'app', 'x', 'y', 'toX', 'toY', 'direction', 'distance', 'text', 'value', 'key', 'keys', 'actions',
  'observationId', 'previousObservationId', 'profile', 'forceImage', 'timeoutMs', 'pollMs',
  'semanticObservationId', 'targetId', 'maxElements', 'perception', 'stableMs'
]);
const COMPUTER_OMIT = Object.freeze({
  status: COMPUTER_FIELDS,
  displays: COMPUTER_FIELDS,
  observe: COMPUTER_FIELDS.filter(field => !['displayId', 'app', 'previousObservationId', 'profile', 'forceImage', 'maxElements', 'perception'].includes(field)),
  activate: COMPUTER_FIELDS.filter(field => !['app', 'semanticObservationId', 'targetId'].includes(field)),
  set_value: COMPUTER_FIELDS.filter(field => !['app', 'semanticObservationId', 'targetId', 'value'].includes(field)),
  screenshot: COMPUTER_FIELDS.filter(field => !['displayId', 'app', 'previousObservationId', 'profile', 'forceImage'].includes(field)),
  wait_for_change: COMPUTER_FIELDS.filter(field => !['displayId', 'app', 'previousObservationId', 'profile', 'forceImage', 'timeoutMs', 'pollMs'].includes(field)),
  wait_for_stable: COMPUTER_FIELDS.filter(field => !['displayId', 'app', 'previousObservationId', 'profile', 'forceImage', 'timeoutMs', 'pollMs', 'stableMs'].includes(field)),
  move: COMPUTER_FIELDS.filter(field => !['displayId', 'app', 'x', 'y', 'observationId'].includes(field)),
  click: COMPUTER_FIELDS.filter(field => !['displayId', 'app', 'x', 'y', 'observationId'].includes(field)),
  double_click: COMPUTER_FIELDS.filter(field => !['displayId', 'app', 'x', 'y', 'observationId'].includes(field)),
  right_click: COMPUTER_FIELDS.filter(field => !['displayId', 'app', 'x', 'y', 'observationId'].includes(field)),
  drag: COMPUTER_FIELDS.filter(field => !['displayId', 'app', 'x', 'y', 'toX', 'toY', 'observationId'].includes(field)),
  scroll: COMPUTER_FIELDS.filter(field => !['displayId', 'app', 'direction', 'distance', 'x', 'y', 'observationId'].includes(field)),
  type: COMPUTER_FIELDS.filter(field => !['app', 'text'].includes(field)),
  key: COMPUTER_FIELDS.filter(field => !['app', 'key'].includes(field)),
  hotkey: COMPUTER_FIELDS.filter(field => !['app', 'keys'].includes(field)),
  batch: COMPUTER_FIELDS.filter(field => !['app', 'actions', 'observationId', 'profile', 'semanticObservationId', 'perception'].includes(field)),
  stop: COMPUTER_FIELDS,
  approve_app: COMPUTER_FIELDS.filter(field => field !== 'app'),
  revoke_app: COMPUTER_FIELDS.filter(field => field !== 'app')
});

const BROWSER_FIELDS = Object.freeze([
  'sessionId', 'tabId', 'url', 'profile', 'ignoreHTTPSErrors', 'width', 'height', 'timeoutMs', 'detail',
  'interaction', 'target', 'input', 'key', 'selectValue', 'state', 'fullPage', 'path'
]);
function browserOmit(...allowed) {
  const keep = new Set(allowed);
  return BROWSER_FIELDS.filter(field => !keep.has(field));
}
const BROWSER_OMIT = Object.freeze({
  status: browserOmit('sessionId'),
  start: browserOmit('url', 'profile', 'ignoreHTTPSErrors', 'width', 'height', 'timeoutMs'),
  tabs: browserOmit('sessionId'),
  open_tab: browserOmit('sessionId', 'url', 'timeoutMs'),
  close_tab: browserOmit('sessionId', 'tabId'),
  navigate: browserOmit('sessionId', 'tabId', 'url', 'timeoutMs'),
  snapshot: browserOmit('sessionId', 'tabId', 'timeoutMs', 'detail'),
  interact: browserOmit('sessionId', 'tabId', 'timeoutMs', 'interaction', 'target', 'input', 'key', 'selectValue', 'state'),
  screenshot: browserOmit('sessionId', 'tabId', 'fullPage'),
  upload: browserOmit('sessionId', 'tabId', 'timeoutMs', 'target', 'path'),
  download: browserOmit('sessionId', 'tabId', 'timeoutMs', 'interaction', 'target', 'path'),
  stop: browserOmit('sessionId')
});

const UI_OMIT = Object.freeze({
  start: ['sessionId', 'interaction', 'target', 'input', 'key', 'selectValue', 'state', 'fullPage', 'maxEntries', 'clear'],
  navigate: ['port', 'host', 'protocol', 'allowedPorts', 'headless', 'width', 'height', 'interaction', 'target', 'input', 'key', 'selectValue', 'state', 'fullPage', 'maxEntries', 'clear'],
  snapshot: ['port', 'host', 'protocol', 'route', 'allowedPorts', 'headless', 'width', 'height', 'interaction', 'target', 'input', 'key', 'selectValue', 'state', 'fullPage', 'maxEntries', 'clear'],
  interact: ['port', 'host', 'protocol', 'route', 'allowedPorts', 'headless', 'width', 'height', 'fullPage', 'maxEntries', 'clear'],
  screenshot: ['port', 'host', 'protocol', 'route', 'allowedPorts', 'headless', 'width', 'height', 'interaction', 'target', 'input', 'key', 'selectValue', 'state', 'maxEntries', 'clear'],
  console: ['port', 'host', 'protocol', 'route', 'allowedPorts', 'headless', 'width', 'height', 'interaction', 'target', 'input', 'key', 'selectValue', 'state', 'fullPage'],
  network: ['port', 'host', 'protocol', 'route', 'allowedPorts', 'headless', 'width', 'height', 'interaction', 'target', 'input', 'key', 'selectValue', 'state', 'fullPage'],
  viewport: ['port', 'host', 'protocol', 'route', 'allowedPorts', 'headless', 'interaction', 'target', 'input', 'key', 'selectValue', 'state', 'fullPage', 'maxEntries', 'clear'],
  reload: ['port', 'host', 'protocol', 'route', 'allowedPorts', 'headless', 'width', 'height', 'interaction', 'target', 'input', 'key', 'selectValue', 'state', 'fullPage', 'maxEntries', 'clear'],
  stop: ['port', 'host', 'protocol', 'route', 'allowedPorts', 'headless', 'width', 'height', 'timeoutMs', 'interaction', 'target', 'input', 'key', 'selectValue', 'state', 'fullPage', 'maxEntries', 'clear']
});

// One canonical operation registry owns the internal definition and every public
// exposure of that operation. Public action lookup is derived below rather than
// maintained as an independent source of truth.
const PUBLIC_BINDINGS_BY_OPERATION = Object.freeze({
  [OP.WORK_BEGIN]: [expose('relai_work', 'begin', { capability: READ })],
  [OP.WORK_CONTEXT]: [expose('relai_work', 'context', { capability: READ })],
  [OP.WORK_PLAN]: [expose('relai_work', 'plan', { capability: READ })],
  [OP.WORK_STATUS]: [expose('relai_work', 'status', { capability: READ })],
  [OP.WORK_FINISH]: [expose('relai_work', 'finish', { capability: READ })],
  [OP.WORK_CANCEL]: [expose('relai_work', 'cancel', { capability: READ })],
  [OP.SNAPSHOT]: [expose('relai_snapshot', 'default', { capability: READ })],
  [OP.READ]: [expose('relai_read', 'default', { capability: READ })],
  [OP.SEARCH_TEXT]: [expose('relai_search', 'text', { capability: READ })],
  [OP.SEARCH_SEMANTIC]: [expose('relai_search', 'semantic', { capability: READ })],
  [OP.INSPECT]: Object.entries(INSPECT_FIELDS).map(([action, publicContract]) =>
    expose('relai_inspect', action, { capability: READ, keepAction: true, publicContract })),
  [OP.EDIT]: [expose('relai_edit', 'default', { capability: WRITE })],
  [OP.EXEC]: [expose('relai_exec', 'default', { capability: EXECUTE, behavior: { taskScope: 'optional' } })],
  [OP.PROCESS_START]: [expose('relai_process', 'start', { capability: PROCESS, behavior: { taskScope: 'optional' } })],
  [OP.PROCESS_READ]: [expose('relai_process', 'read', { capability: READ })],
  [OP.PROCESS_WRITE]: [expose('relai_process', 'write', { capability: PROCESS, behavior: { taskScope: 'optional' } })],
  [OP.PROCESS_STOP]: [expose('relai_process', 'stop', { capability: PROCESS })],
  [OP.PROCESS_LIST]: [expose('relai_process', 'list', { capability: READ })],
  [OP.BROWSER]: [
    expose('relai_browser', 'status', { capability: PROCESS, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ omit: BROWSER_OMIT.status }) }),
    expose('relai_browser', 'start', { capability: PROCESS, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['url'], omit: BROWSER_OMIT.start }) }),
    expose('relai_browser', 'tabs', { capability: PROCESS, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['sessionId'], omit: BROWSER_OMIT.tabs }) }),
    expose('relai_browser', 'open_tab', { capability: PROCESS, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['sessionId'], omit: BROWSER_OMIT.open_tab }) }),
    expose('relai_browser', 'close_tab', { capability: PROCESS, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['sessionId', 'tabId'], omit: BROWSER_OMIT.close_tab }) }),
    expose('relai_browser', 'navigate', { capability: PROCESS, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['sessionId', 'url'], omit: BROWSER_OMIT.navigate }) }),
    expose('relai_browser', 'snapshot', { capability: PROCESS, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['sessionId'], omit: BROWSER_OMIT.snapshot }) }),
    expose('relai_browser', 'interact', { capability: PROCESS, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['sessionId', 'interaction', 'target'], omit: BROWSER_OMIT.interact }) }),
    expose('relai_browser', 'screenshot', { capability: PROCESS, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['sessionId'], omit: BROWSER_OMIT.screenshot }) }),
    expose('relai_browser', 'upload', { capability: PROCESS, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['sessionId', 'path', 'target'], omit: BROWSER_OMIT.upload }) }),
    expose('relai_browser', 'download', { capability: PROCESS, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['sessionId', 'path', 'interaction', 'target'], omit: BROWSER_OMIT.download }) }),
    expose('relai_browser', 'stop', { capability: PROCESS, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['sessionId'], omit: BROWSER_OMIT.stop }) })
  ],
  [OP.UI]: [
    expose('relai_ui', 'start', { capability: PROCESS, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['port'], omit: UI_OMIT.start }) }),
    expose('relai_ui', 'navigate', { capability: PROCESS, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['sessionId', 'route'], omit: UI_OMIT.navigate }) }),
    expose('relai_ui', 'snapshot', { capability: PROCESS, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['sessionId'], omit: UI_OMIT.snapshot }) }),
    expose('relai_ui', 'interact', { capability: PROCESS, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['sessionId', 'interaction', 'target'], omit: UI_OMIT.interact }) }),
    expose('relai_ui', 'screenshot', { capability: PROCESS, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['sessionId'], omit: UI_OMIT.screenshot }) }),
    expose('relai_ui', 'console', { capability: PROCESS, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['sessionId'], omit: UI_OMIT.console }) }),
    expose('relai_ui', 'network', { capability: PROCESS, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['sessionId'], omit: UI_OMIT.network }) }),
    expose('relai_ui', 'viewport', { capability: PROCESS, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['sessionId', 'width', 'height'], omit: UI_OMIT.viewport }) }),
    expose('relai_ui', 'reload', { capability: PROCESS, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['sessionId'], omit: UI_OMIT.reload }) }),
    expose('relai_ui', 'stop', { capability: PROCESS, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['sessionId'], omit: UI_OMIT.stop }) })
  ],
  [OP.DESKTOP]: [
    expose('relai_desktop', 'open_path', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['path'], omit: DESKTOP_OMIT.open_path }) }),
    expose('relai_desktop', 'reveal_path', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['path'], omit: DESKTOP_OMIT.reveal_path }) }),
    expose('relai_desktop', 'open_uri', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['uri'], omit: DESKTOP_OMIT.open_uri }) }),
    expose('relai_desktop', 'launch_application', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['application'], omit: DESKTOP_OMIT.launch_application }) }),
    expose('relai_desktop', 'clipboard_read', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ omit: DESKTOP_OMIT.clipboard_read }) }),
    expose('relai_desktop', 'clipboard_write', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['text'], omit: DESKTOP_OMIT.clipboard_write }) })
  ],
  [OP.COMPUTER]: [
    expose('relai_computer', 'status', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ omit: COMPUTER_OMIT.status }) }),
    expose('relai_computer', 'displays', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ omit: COMPUTER_OMIT.displays }) }),
    expose('relai_computer', 'observe', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['app'], omit: COMPUTER_OMIT.observe }) }),
    expose('relai_computer', 'activate', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['app', 'semanticObservationId', 'targetId'], omit: COMPUTER_OMIT.activate }) }),
    expose('relai_computer', 'set_value', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['app', 'semanticObservationId', 'targetId', 'value'], omit: COMPUTER_OMIT.set_value }) }),
    expose('relai_computer', 'screenshot', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['app'], omit: COMPUTER_OMIT.screenshot }) }),
    expose('relai_computer', 'wait_for_change', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['app'], omit: COMPUTER_OMIT.wait_for_change }) }),
    expose('relai_computer', 'wait_for_stable', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['app'], omit: COMPUTER_OMIT.wait_for_stable }) }),
    expose('relai_computer', 'move', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['app', 'x', 'y'], omit: COMPUTER_OMIT.move }) }),
    expose('relai_computer', 'click', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['app', 'x', 'y'], omit: COMPUTER_OMIT.click }) }),
    expose('relai_computer', 'double_click', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['app', 'x', 'y'], omit: COMPUTER_OMIT.double_click }) }),
    expose('relai_computer', 'right_click', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['app', 'x', 'y'], omit: COMPUTER_OMIT.right_click }) }),
    expose('relai_computer', 'drag', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['app', 'x', 'y', 'toX', 'toY'], omit: COMPUTER_OMIT.drag }) }),
    expose('relai_computer', 'scroll', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['app', 'direction'], omit: COMPUTER_OMIT.scroll }) }),
    expose('relai_computer', 'type', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['app', 'text'], omit: COMPUTER_OMIT.type }) }),
    expose('relai_computer', 'key', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['app', 'key'], omit: COMPUTER_OMIT.key }) }),
    expose('relai_computer', 'hotkey', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['app', 'keys'], omit: COMPUTER_OMIT.hotkey }) }),
    expose('relai_computer', 'batch', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['app', 'actions'], omit: COMPUTER_OMIT.batch }) }),
    expose('relai_computer', 'stop', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ omit: COMPUTER_OMIT.stop }) }),
    expose('relai_computer', 'approve_app', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['app'], omit: COMPUTER_OMIT.approve_app }) }),
    expose('relai_computer', 'revoke_app', { capability: COMPUTER, keepAction: true, behavior: { taskScope: 'optional' }, publicContract: contract({ required: ['app'], omit: COMPUTER_OMIT.revoke_app }) })
  ],
  [OP.VALIDATE_CHECKS]: [expose('relai_validate', 'checks', { capability: EXECUTE, behavior: { taskScope: 'optional' } })],
  [OP.VALIDATE_DIAGNOSTICS]: [expose('relai_validate', 'diagnostics', { capability: EXECUTE, behavior: { taskScope: 'optional' } })],
  [OP.VALIDATE_HTTP]: [expose('relai_validate', 'http', { capability: READ })],
  [OP.CHANGES_DIFF]: [expose('relai_changes', 'diff', { capability: READ })],
  [OP.CHANGES_CHECKPOINT]: [expose('relai_changes', 'checkpoint', { capability: READ, behavior: { taskScope: 'optional' } })],
  [OP.CHANGES_REPLAY]: [expose('relai_changes', 'replay', { capability: READ })],
  [OP.CHANGES_RESTORE]: [expose('relai_changes', 'restore', { capability: WRITE })],
  [OP.CHANGES_RESET]: [expose('relai_changes', 'reset', {
    capability: WRITE,
    approval: args => ({ message: `Discard tracked workspace changes${args.removeUntracked ? ' and remove untracked files and directories' : ''}?` })
  })],
  [OP.CHANGES_TIDY_PLAN]: [expose('relai_changes', 'tidy_plan', { capability: READ })],
  [OP.CHANGES_TIDY_RUN]: [expose('relai_changes', 'tidy_run', { capability: WRITE })],
  [OP.PUBLISH_COMMIT]: [expose('relai_publish', 'commit', {
    capability: WRITE
  })],
  [OP.PUBLISH_PUSH]: [expose('relai_publish', 'push', {
    capability: PUBLISH
  })],
  [OP.PUBLISH_DRAFT_PR]: [expose('relai_publish', 'draft_pr', { capability: READ })]
});

const OPERATION_REGISTRY = buildOperationRegistry(OPERATION_DEFINITION_VALUES, PUBLIC_BINDINGS_BY_OPERATION);
const ACTION_REGISTRY = buildActionRegistry(PUBLIC_BINDINGS_BY_OPERATION);

/** @param {Record<string, any>} [value] */
function contract(value = {}) {
  const parsed = PUBLIC_CONTRACT_SCHEMA.parse(value);
  return Object.freeze({
    required: Object.freeze([...parsed.required]),
    omit: Object.freeze([...parsed.omit]),
    extra: Object.freeze({ ...parsed.extra })
  });
}

/** @param {string} publicName @param {string} action @param {Record<string, any>} [options] */
function expose(publicName, action, options = {}) {
  return Object.freeze({
    publicName,
    action,
    keepAction: options.keepAction === true,
    capability: String(options.capability || ''),
    approval: typeof options.approval === 'function' ? options.approval : null,
    behavior: options.behavior ? Object.freeze({ ...options.behavior }) : null,
    publicContract: options.publicContract || null
  });
}

function buildOperationRegistry(definitions, bindingsByOperation) {
  const definitionNames = new Set(definitions.map(definition => definition.name));
  for (const operationName of Object.keys(bindingsByOperation)) {
    if (!definitionNames.has(operationName)) {
      throw new Error(`Public binding references unknown operation '${operationName}'.`);
    }
  }
  return Object.freeze(definitions.map(definition => {
    const publicActions = bindingsByOperation[definition.name] || [];
    if (publicActions.length === 0) {
      throw new Error(`Operation '${definition.name}' has no public tool/action binding.`);
    }
    return Object.freeze({
      definition: Object.freeze({ ...definition }),
      publicActions: Object.freeze([...publicActions])
    });
  }));
}

function buildActionRegistry(bindingsByOperation) {
  const tools = new Map();
  for (const [operationName, publicActions] of Object.entries(bindingsByOperation)) {
    for (const exposure of publicActions) {
      if (!tools.has(exposure.publicName)) tools.set(exposure.publicName, new Map());
      const actions = tools.get(exposure.publicName);
      if (actions.has(exposure.action)) {
        throw new Error(`Duplicate public binding '${exposure.publicName}:${exposure.action}'.`);
      }
      actions.set(exposure.action, Object.freeze({
        operationName,
        keepAction: exposure.keepAction,
        capability: exposure.capability,
        approval: exposure.approval,
        behavior: exposure.behavior,
        publicContract: exposure.publicContract
      }));
    }
  }
  return Object.freeze(Object.fromEntries([...tools].map(([publicName, actions]) => [
    publicName,
    Object.freeze(Object.fromEntries(actions))
  ])));
}

function isToolSurfaceSourcePath(value) {
  const normalized = String(value || '').trim().replaceAll('\\', '/').replace(/^\.\//, '');
  return normalized.startsWith('src/tools/');
}

export { ACTION_REGISTRY, OPERATION_REGISTRY, isToolSurfaceSourcePath };
