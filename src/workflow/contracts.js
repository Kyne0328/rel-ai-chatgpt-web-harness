import * as crypto from 'node:crypto';
import { stableJson } from '../stableJson.js';
import { WORKFLOW_INTENTS } from '../contracts/analyticsTaxonomy.js';

function deterministicActionId(action = {}) {
  const tool = String(action.tool || 'action');
  const name = String(action.action || 'run');
  const digest = crypto.createHash('sha256').update(stableJson(action.args || {})).digest('hex').slice(0, 16);
  return `${tool}:${name}:${digest}`;
}

export { WORKFLOW_INTENTS, deterministicActionId };
