/**
 * What the simulator page does when a view asks the host for something. Pure
 * (everything it touches is injected), so it's tested without a browser.
 * The wire protocol itself is AppBridge's job (host/main.ts).
 */

export interface ToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface MessageParams {
  role: "user";
  content: Array<{ type: string; text?: string }>;
}

export interface HostDeps {
  fetchImpl: typeof fetch;
  /** A view asked the assistant something: run it as a turn, as if typed. */
  say: (text: string) => void | Promise<void>;
  /** Show a tool call a view made in the trace panel. */
  onViewCall?: (trace: unknown) => void;
  /** Ask the user before opening a link a view requested. */
  confirmOpen: (url: string) => boolean;
  openWindow: (url: string) => void;
}

/** Only https links are ever opened, whatever the view asks for. */
export function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Keep a view-requested size inside the screen. */
export function clampSize(requested: number | undefined, max: number): number | undefined {
  if (requested === undefined || !Number.isFinite(requested)) return undefined;
  return Math.max(0, Math.min(Math.round(requested), max));
}

export function createHostHandlers(deps: HostDeps) {
  return {
    /**
     * A view's `tools/call`. The server enforces the spec's visibility rule (a
     * tool without "app" visibility is refused); a refusal or failure becomes a
     * rejected request, which the view sees as an error, not a tool result.
     */
    async callTool(params: ToolCallParams) {
      const res = await deps.fetchImpl("/api/ui/tool-call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: params.name, arguments: params.arguments ?? {} }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; trace?: unknown; result?: unknown };
      if (!res.ok) throw new Error(data.error ?? `Tool call failed (${res.status}).`);
      deps.onViewCall?.(data.trace);
      return (data.result ?? { content: [] }) as Record<string, unknown>;
    },

    /** A view's `ui/message`: becomes a new utterance to the brain. This is how a "Modify" button hands a change back. */
    async message(params: MessageParams) {
      const text = params.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n")
        .trim();
      if (!text) throw new Error("Only text messages are supported.");
      // Don't hold the view's request open for a whole brain turn.
      void Promise.resolve(deps.say(text));
      return {};
    },

    /** A view's `ui/open-link`: https only, and only after the user says yes. */
    async openLink(params: { url: string }) {
      const url = safeHttpsUrl(params.url);
      if (!url) throw new Error("Only https links can be opened.");
      if (!deps.confirmOpen(url)) return { isError: true };
      deps.openWindow(url);
      return {};
    },
  };
}

export type HostHandlers = ReturnType<typeof createHostHandlers>;
