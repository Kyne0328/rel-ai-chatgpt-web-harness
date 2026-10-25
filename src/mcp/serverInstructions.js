import { STATIC_CONTEXT } from '../context/static-context.js';

const PUBLIC_MCP_SERVER_INSTRUCTIONS = `${STATIC_CONTEXT} work_id omission never selects another task. Omit mode for ordinary tasks (normal default), including long multi-step fixes. Never auto-select Goal/Loop Mode based on task complexity, duration, or earlier chats. Only an explicit user request for /goal, /loop or the named monitoring feature selects goal or loop. Verify modeAcknowledgement; finish must end normal tasks. Read a returned chat linking receipt resource once in its originating chat; never display its URI or ask the user for a URL.`;

export { PUBLIC_MCP_SERVER_INSTRUCTIONS };
