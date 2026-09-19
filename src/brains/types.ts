import type { ToolCallTrace } from "../mcp.js";

export interface BrainTurnResult {
  reply: string;
  trace: ToolCallTrace[];
}

/** Something that turns one utterance into tool calls plus a spoken reply.
 *  Write your own for your server's specific tools (see examples/), or use
 *  one of the built-in LLM-driven brains, which need no per-server tuning
 *  since they pick tools from whatever tools/list returns. */
export interface Brain {
  readonly name: string;
  turn(utterance: string): Promise<BrainTurnResult>;
  /** Clear any conversation state. Optional — stateless brains don't need it. */
  reset?(): Promise<void> | void;
}
