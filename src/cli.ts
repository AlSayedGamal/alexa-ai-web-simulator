#!/usr/bin/env node
import { createClaudeBrain } from "./brains/claude.js";
import { createCursorBrain } from "./brains/cursor.js";
import type { Brain } from "./brains/types.js";
import { createServer } from "./server.js";
import { McpSessionManager } from "./session.js";

function env(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function fail(message: string): never {
  console.error(`mcp-voice-simulator: ${message}`);
  process.exit(1);
}

const mcpUrl = env("MCP_URL");
if (!mcpUrl) fail("MCP_URL is required — the full URL of the MCP endpoint to simulate against.");

const port = Number(env("SIM_PORT") ?? 8790);
const anthropicKey = env("ANTHROPIC_API_KEY");
const cursorKey = env("CURSOR_API_KEY");
const forcedBrain = env("SIM_BRAIN");

const sessionManager = new McpSessionManager({
  mcpUrl,
  bearerToken: env("MCP_BEARER_TOKEN"),
  link: { clientId: env("MCP_CLIENT_ID") },
});

function pickBrainName(): "claude" | "cursor" {
  if (forcedBrain === "claude" || forcedBrain === "cursor") return forcedBrain;
  if (cursorKey) return "cursor";
  if (anthropicKey) return "claude";
  fail(
    "No brain available — set CURSOR_API_KEY or ANTHROPIC_API_KEY (there's no built-in key-free brain, " +
      "since picking tools from natural language needs an LLM unless you write your own for your specific " +
      "tools — see examples/ and use the programmatic API instead of this CLI to supply one).",
  );
}

const brainName = pickBrainName();
const brain: Brain =
  brainName === "cursor"
    ? createCursorBrain({
        apiKey: cursorKey!,
        mcpUrl,
        accessToken: () => sessionManager.accessToken(),
        model: env("SIM_CURSOR_MODEL"),
      })
    : createClaudeBrain({
        apiKey: anthropicKey!,
        session: () => sessionManager.ensureSession(),
        model: env("SIM_MODEL"),
      });

createServer({ sessionManager, brain, port });
console.log(`mcp-voice-simulator: http://127.0.0.1:${port}`);
console.log(`  MCP server: ${mcpUrl}`);
console.log(`  Brain: ${brainName}`);
