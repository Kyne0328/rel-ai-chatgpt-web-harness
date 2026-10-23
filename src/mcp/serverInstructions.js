import { STATIC_CONTEXT } from '../context/static-context.js';

const PUBLIC_MCP_SERVER_INSTRUCTIONS = `${STATIC_CONTEXT} work_id omission never selects another task. Mode required: normal|goal|loop. /goal or explicit Goal Mode selects goal; /loop selects loop. Verify modeAcknowledgement.`;

export { PUBLIC_MCP_SERVER_INSTRUCTIONS };
