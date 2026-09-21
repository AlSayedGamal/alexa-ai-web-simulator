/**
 * Run the simulator against the sample task-tracker MCP server (no API key).
 *
 *   npx tsx examples/run-demo.ts
 *
 * Then open the printed URL. This sample server is fictional; it is not any
 * real application's MCP API.
 */
import { createServer, McpSessionManager } from "../src/index.js";
import { startDemoServer } from "./demo-server.js";
import { createScriptedBrain } from "./scripted-brain.js";

const port = Number(process.env.SIM_PORT ?? 8870);
const demo = await startDemoServer({ port: port + 2 });
const sessionManager = new McpSessionManager({ mcpUrl: demo.url, bearerToken: demo.token, ui: true });
const brain = createScriptedBrain(() => sessionManager.ensureSession());

createServer({ sessionManager, brain, port, ui: { sandboxPort: port + 1 } });

console.log(`mcp-voice-simulator demo: http://127.0.0.1:${port}`);
console.log(`  sample MCP server: ${demo.url}`);
console.log("  brain: scripted-example (no API key)");
console.log("  try: “list my tasks”, then Mark done in the ui:// view, then Confirm a new task");
