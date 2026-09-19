/**
 * The server side of MCP Apps view support: picks the view for a turn, and
 * proxies a view's `tools/call` back to the MCP server under the host's rules.
 * Kept out of server.ts so the behaviour lives in one place.
 */
import type http from "node:http";

import type { ToolCallTrace } from "../mcp.js";
import { callTool } from "../mcp.js";
import type { McpSessionManager } from "../session.js";

import { isAppCallable, uiResourceUri } from "./meta.js";
import { resolveUiForTurn, type UiPayload } from "./resolve.js";

export interface UiRouteOptions {
  /** False when SIM_UI=off: no capability advertised, no views, no call-back route. */
  enabled: boolean;
  sessionManager: McpSessionManager;
  brainName: string;
  /** Where the sandbox proxy is listening, once it is. */
  sandboxOrigin: () => string | undefined;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export interface TurnUi {
  ui?: UiPayload;
  uiWarnings?: string[];
}

export function createUiRoute(options: UiRouteOptions) {
  return {
    get enabled(): boolean {
      return options.enabled;
    },

    /** What `/api/status` reports so the page knows whether, and where, to host views. */
    status(): { enabled: boolean; sandboxOrigin?: string } {
      return { enabled: options.enabled, sandboxOrigin: options.enabled ? options.sandboxOrigin() : undefined };
    },

    /** The view for this turn's tool calls, if any, plus anything worth telling the developer. */
    async forTurn(trace: ToolCallTrace[]): Promise<TurnUi> {
      if (!options.enabled) return {};
      try {
        const session = await options.sessionManager.ensureSession();
        const { ui, warnings } = await resolveUiForTurn(session, trace, options.brainName);
        return { ...(ui ? { ui } : {}), ...(warnings.length ? { uiWarnings: warnings } : {}) };
      } catch {
        return {}; // no session means no views, not a failed turn
      }
    },

    /** `POST /api/ui/tool-call { name, arguments }`: a view calling a tool through the host. */
    async handleToolCall(res: http.ServerResponse, body: unknown): Promise<void> {
      if (!options.enabled) return sendJson(res, 404, { error: "MCP Apps view support is turned off (SIM_UI=off)." });

      const { name, arguments: args } = (body ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof name !== "string" || !name) return sendJson(res, 400, { error: "name is required" });
      if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
        return sendJson(res, 400, { error: "arguments must be an object" });
      }

      const session = await options.sessionManager.ensureSession();
      const tool = session.tools.find((t) => t.name === name);
      if (!tool) return sendJson(res, 404, { error: `Unknown tool "${name}".` });
      // The spec: a host MUST reject a view's tools/call for a tool whose visibility lacks "app".
      if (!isAppCallable(tool)) {
        return sendJson(res, 403, {
          error: `Tool "${name}" can't be called from a view: its _meta.ui.visibility doesn't include "app".`,
        });
      }

      try {
        const trace = await callTool(session, name, (args as Record<string, unknown> | undefined) ?? {}, "view");
        return sendJson(res, 200, { trace, result: trace.result });
      } catch (err) {
        // A tool failing is the tool's problem, not a reason to drop the linked session.
        return sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
      }
    },

    /** For the Tools card: which tools declare a view. */
    toolView(tool: { _meta?: Record<string, unknown> }): string | undefined {
      return options.enabled ? uiResourceUri(tool) : undefined;
    },
  };
}

export type UiRoute = ReturnType<typeof createUiRoute>;
