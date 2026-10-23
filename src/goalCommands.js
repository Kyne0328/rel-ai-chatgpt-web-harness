// Slash commands are authority only when authored by the user at the start of
// the latest message. Do not scan quoted text, model output or tool receipts.
const MAX_COMMAND_CHARS = 4096;
const CONTROLS = new Set(['status', 'pause', 'resume', 'stop', 'cancel']);

function parseGoalCommand(message) {
  const parts = message?.content?.parts;
  if (message?.author?.role !== 'user' || message?.content?.commandInvalid
    || !Array.isArray(parts) || !parts.length || parts.length > 8
    || parts.some(part => typeof part !== 'string')) return null;
  const raw = parts.join('\n');
  if (raw.length > MAX_COMMAND_CHARS) return null;
  // Up to three leading spaces are ordinary Markdown; four or a tab is code.
  const match = /^ {0,3}\/(goal|loop)(?:\s|$)/i.exec(raw);
  if (!match) return null;
  const mode = match[1].toLowerCase();
  const body = raw.slice(match[0].length).trim().replace(/^mode(?:\s+|$)/i, '').trim();
  const first = body.split(/\s/, 1)[0].toLowerCase();
  if (CONTROLS.has(first)) {
    // '/goal stop later' must neither stop work nor create a fresh objective.
    if (body.toLowerCase() !== first) return null;
    return { mode, action: first === 'cancel' ? 'stop' : first };
  }
  // The durable controller must reject an objective change for unrelated work.
  // Bare commands leave objective resolution to the exact existing work session.
  if (body.length > (mode === 'loop' ? 2000 : 500)) return null;
  return { mode, action: 'start', strategy: 'adaptive', objective: body.length <= 500 ? body : '',
    ...(mode === 'loop' ? { brief: body } : {}) };
}

function validateWorkMode(args = {}) {
  if (!['normal', 'goal', 'loop'].includes(args.mode)) throw new Error('Work begin requires mode: normal, goal, or loop.');
  const monitoringOptions = ['strategy', 'successCriteria', 'brief', 'conversationUrl', 'chatgptProjectName']
    .some(key => args[key] !== undefined);
  if (args.mode === 'normal' && monitoringOptions || args.goal === true && args.mode !== 'goal'
    || args.mode !== 'normal' && args.goal === false) throw new Error('Conflicting work mode and Goal/Loop options.');
  return args.mode;
}

export { parseGoalCommand, validateWorkMode };
