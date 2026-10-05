#!/usr/bin/env node
import { main } from "../src/server.js";

try {
  await main();
} catch (error) {
  console.error(`[rel-ai-mcp] fatal: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
}
