const INFERRED_ACTION_TOOLS = new Set(['relai_search', 'relai_process', 'relai_validate', 'relai_changes', 'relai_publish']);
const HIDDEN_INDEPENDENT_DISCOVERY_TOOLS = new Set(['relai_work', 'relai_snapshot', 'relai_read', 'relai_search', 'relai_inspect']);
const SHARED_ACTION_REQUIRED_FIELDS = Object.freeze({
  relai_process: 'processId',
  relai_ui: 'sessionId',
  relai_browser: 'sessionId',
  relai_computer: 'app'
});

const PUBLIC_INPUT_DESCRIPTIONS = Object.freeze({
  relai_read: new Set([
    'properties.asResource.description',
    'properties.byteOffset.description'
  ]),
  relai_edit: new Set([
    'description',
    'properties.file.description',
    'properties.expectedSha256.description',
    'properties.updateText.description',
    'properties.envAction.description'
  ]),
  relai_exec: new Set([
    'description',
    'properties.command.description',
    'properties.executable.description',
    'properties.input.description'
  ]),
  relai_process: new Set([
    'properties.command.description',
    'properties.executable.description',
    'properties.input.description'
  ])
});

function compactPublicInputSchema(name, inputSchema, catalogTool) {
  // Discovery is an ergonomic projection, not a second validator. Keep ordinary
  // callable fields visible, while rare runtime escape hatches may be hidden when
  // they do not help model selection. Leave action/form exclusivity and conditional
  // requirements to the canonical runtime contract. Some clients
  // simplify nested oneOf/anyOf/if schemas during import and can otherwise hide
  // valid fields (for example batched search queries) or collapse a tool to an
  // untyped argument object.
  const schema = importSafeInputSchema(inputSchema || {});
  let discoverySchema = name === 'relai_edit' ? hideInternalEditTransportFields(schema) : schema;
  if (INFERRED_ACTION_TOOLS.has(name) && Array.isArray(discoverySchema.required)) {
    discoverySchema = { ...discoverySchema, required: discoverySchema.required.filter(field => field !== 'action') };
  }
  const compact = compactRepeatedDiscoveryStructures(
    name,
    stripDiscoveryValidationNoise(stripPublicDescriptions(discoverySchema, PUBLIC_INPUT_DESCRIPTIONS[name] || new Set()))
  );
  const withInputForm = annotateInputForm(compact, inputSchema);
  return annotateActionGrammar(withInputForm, catalogTool, name);
}

function hideInternalEditTransportFields(schema) {
  if (!schema?.properties) return schema;
  const { stage: _stage, writeId: _writeId, ...properties } = schema.properties;
  return { ...schema, properties };
}

function compactRepeatedDiscoveryStructures(name, schema) {
  if (!schema?.properties) return schema;
  const properties = { ...schema.properties };
  if (HIDDEN_INDEPENDENT_DISCOVERY_TOOLS.has(name)) delete properties.independent;
  if (properties.taskProgress) {
    properties.taskProgress = { type: 'object', description: 'Plan step patch: id + status; optional detail.' };
  }
  if (name === 'relai_edit' && properties.edits?.items) {
    properties.edits = {
      ...properties.edits,
      items: { type: 'object', description: 'Batch item: path plus replacements, oldText/newText, content, or expectedSha256.' }
    };
  }
  if (['relai_ui', 'relai_browser'].includes(name) && properties.target) {
    properties.target = { type: 'object', description: 'Target: by + value; optional name, exact, index.' };
  }
  return { ...schema, properties };
}

function importSafeInputSchema(inputSchema) {
  const {
    oneOf: _oneOf,
    anyOf: _anyOf,
    allOf: _allOf,
    if: _if,
    then: _then,
    else: _else,
    not: _not,
    propertyNames: _propertyNames,
    ...schema
  } = inputSchema;
  return schema;
}

function stripPublicDescriptions(value, retained, path = '') {
  if (Array.isArray(value)) return value.map(item => stripPublicDescriptions(item, retained, path));
  if (!value || typeof value !== 'object') return value;
  const compact = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (key === 'description' && !retained.has(childPath)) continue;
    compact[key] = stripPublicDescriptions(child, retained, childPath);
  }
  return compact;
}

function stripDiscoveryValidationNoise(value) {
  if (Array.isArray(value)) return value.map(stripDiscoveryValidationNoise);
  if (!value || typeof value !== 'object') return value;
  const compact = {};
  for (const [key, child] of Object.entries(value)) {
    if (['minLength', 'maxLength', 'minimum', 'maximum'].includes(key)) continue;
    compact[key] = stripDiscoveryValidationNoise(child);
  }
  return compact;
}

function annotateActionGrammar(schema, catalogTool, name) {
  const actions = (catalogTool?.actions || []).filter(entry => entry.action !== 'default');
  if (!actions.length || !schema?.properties?.action) return schema;

  const formHints = actions.map(actionInputFormHint).filter(Boolean);
  const actionGrammar = compactActionGrammar(actions, name);
  return {
    ...schema,
    properties: {
      ...schema.properties,
      action: {
        ...schema.properties.action,
        description: [
          actionGrammar,
          name === 'relai_search' ? `text accepts pattern or queries (max ${actions.find(entry => entry.action === 'text')?.inputSchema?.properties?.queries?.maxItems || 'schema limit'}), glob, contextBefore/contextAfter; pathPrefix applies only to semantic. Omitted action infers text from pattern and semantic from query; queries alone requires action.` : '',
          formHints.length ? `Forms: ${formHints.join('; ')}.` : ''
        ].filter(Boolean).join(' ')
      }
    }
  };
}

function annotateInputForm(schema, inputSchema) {
  const form = inputFormAlternatives(inputSchema);
  if (!form) return schema;
  return {
    ...schema,
    description: [schema.description, `Input form: ${form}.`].filter(Boolean).join(' ')
  };
}

function actionInputFormHint(entry) {
  const form = inputFormAlternatives(entry.inputSchema);
  return form ? `${entry.action}: ${form}` : '';
}

function inputFormAlternatives(schema) {
  const branches = Array.isArray(schema?.oneOf) ? schema.oneOf : Array.isArray(schema?.anyOf) ? schema.anyOf : [];
  if (branches.length < 2 || branches.length > 4) return '';
  const alternatives = branches.map(branch => [...new Set((branch?.required || [])
    .filter(field => !['workspace', 'work_id', 'action'].includes(field)))].sort());
  if (alternatives.some(fields => fields.length === 0)) return '';
  const labels = alternatives.map(fields => fields.join(' + '));
  if (new Set(labels).size !== labels.length) return '';
  return labels.join(' or ');
}

function compactActionGrammar(actions, name) {
  const shared = sharedActionRequiredFieldHint(name, actions);
  const parts = actions.map(entry => {
    const required = new Set(entry.required || []);
    const fields = [...new Set([
      ...(entry.required || []),
      ...((entry.fields || []).filter(field => field === 'operationId'))
    ])]
      .filter(field => !['workspace', 'action', shared.field].includes(field))
      .map(field => `${field}${required.has(field) ? '!' : ''}`);
    return fields.length ? `${entry.action}(${fields.join(',')})` : entry.action;
  });
  const grammar = parts.length ? `Actions: ${parts.join(', ')}. ! required.` : '';
  return [shared.hint, grammar].filter(Boolean).join(' ');
}

function sharedActionRequiredFieldHint(name, actions) {
  const field = SHARED_ACTION_REQUIRED_FIELDS[name];
  if (!field) return { field: '', hint: '' };
  const requiring = actions.filter(entry => (entry.required || []).includes(field)).map(entry => entry.action);
  if (requiring.length < 2) return { field: '', hint: '' };
  const exceptions = actions.filter(entry => !(entry.required || []).includes(field)).map(entry => entry.action);
  const forHint = `${field}! for ${requiring.join('/')}.`;
  const exceptHint = exceptions.length ? `${field}! except ${exceptions.join('/')}.` : `${field}! for every action.`;
  return { field, hint: forHint.length <= exceptHint.length ? forHint : exceptHint };
}

export { compactPublicInputSchema };
