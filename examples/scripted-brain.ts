/**
 * Example: a keyword-routed "brain" that needs no API key at all, written
 * for one hypothetical server's tools (a simple task tracker: create_task,
 * list_tasks, get_task_status). This can't be shipped as a built-in — a
 * scripted brain is inherently tied to one server's specific tools and
 * confirm/dryRun shape — but copy this pattern for your own server's tools
 * if you want a brain that doesn't need an LLM.
 *
 * Usage:
 *   import { createServer, McpSessionManager } from "mcp-voice-simulator";
 *   import { createScriptedBrain } from "./scripted-brain.js";
 *
 *   const sessionManager = new McpSessionManager({ mcpUrl });
 *   const brain = createScriptedBrain(() => sessionManager.ensureSession());
 *   createServer({ sessionManager, brain });
 */
import { callTool, type McpSession } from "../src/mcp.js";
import type { Brain, BrainTurnResult } from "../src/brains/types.js";

const CONFIRM = /^(yes|yeah|yep|confirm(ed)?|go ahead|do it|sure|please do)\b/i;
const CANCEL = /^(no|nope|cancel|stop|never ?mind|don'?t)\b/i;

export function createScriptedBrain(session: () => Promise<McpSession>): Brain {
  let pending: { tool: string; args: Record<string, unknown> } | null = null;
  let lastText = "";

  async function call(name: string, args: Record<string, unknown>, trace: BrainTurnResult["trace"]) {
    const result = await callTool(await session(), name, args);
    trace.push(result);
    return result.text;
  }

  return {
    name: "scripted-example",
    reset() {
      pending = null;
      lastText = "";
    },
    async turn(utterance: string): Promise<BrainTurnResult> {
      const trace: BrainTurnResult["trace"] = [];

      if (pending && CONFIRM.test(utterance)) {
        const { tool, args } = pending;
        pending = null;
        return { reply: await call(tool, { ...args, confirm: true, dryRun: false }, trace), trace };
      }
      if (pending && CANCEL.test(utterance)) {
        pending = null;
        return { reply: "Okay, I won't do that.", trace };
      }

      let reply: string;
      if (/\b(status|progress)\b/i.test(utterance)) {
        const taskId = lastText.match(/\btask-\d+\b/)?.[0];
        reply = await call("get_task_status", taskId ? { taskId } : {}, trace);
      } else if (/\b(create|add|new)\b.*\btask\b/i.test(utterance)) {
        const title = utterance.replace(/^.*\b(create|add|new)\b\s*(a\s*)?task\b\s*(to|for|about)?\s*/i, "").trim();
        pending = { tool: "create_task", args: { title } };
        reply = await call("create_task", { title, dryRun: true }, trace);
      } else if (/\b(list|show|find)\b.*\btasks?\b/i.test(utterance)) {
        const query = utterance.match(/\btasks?\b(?:.*\b(?:about|for|on)\b\s+(.+))?/i)?.[1];
        reply = await call("list_tasks", { query: query ?? "" }, trace);
      } else {
        reply = "I can create a task, list your tasks, or check on a task's status. Try saying, create a task.";
      }

      lastText = [...trace.map((t) => t.text), reply].join(" ");
      return { reply, trace };
    },
  };
}
