import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";

import type { Brain } from "../src/brains/types.js";
import { callTool, type ToolCallTrace } from "../src/mcp.js";
import { createServer } from "../src/server.js";
import { McpSessionManager } from "../src/session.js";

import { startAppsFixture, type AppsFixture } from "./fixtures/apps-server.js";

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any;
}

function send(port: number, method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: { host: `127.0.0.1:${port}`, ...(payload === undefined ? {} : { "content-type": "application/json" }), ...extra },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

let fixture: AppsFixture;
beforeAll(async () => {
  fixture = await startAppsFixture();
});
afterAll(() => fixture.close());

describe("MCP Apps views in the simulator server", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      s.close();
      await once(s, "close");
    }
  });

  async function start(options: { ui?: boolean; brain?: (session: () => ReturnType<McpSessionManager["ensureSession"]>) => Brain } = {}) {
    const sessionManager = new McpSessionManager({ mcpUrl: fixture.url, bearerToken: fixture.token, ui: options.ui });
    // Like the Claude brain: tool calls go through callTool, so the full result is kept.
    const brain: Brain =
      options.brain?.(() => sessionManager.ensureSession()) ?? {
        name: "test",
        async turn() {
          const session = await sessionManager.ensureSession();
          const entry = await callTool(session, "show_card", { title: "Hi" });
          return { reply: "Here is your card.", trace: [entry] };
        },
      };
    const server = createServer({ sessionManager, brain, port: 0, ui: options.ui });
    servers.push(server);
    await once(server, "listening");
    return (server.address() as AddressInfo).port;
  }

  const turn = (port: number, utterance = "show me the card") => send(port, "POST", "/api/turn", { utterance });

  it("adds the view for the turn to /api/turn", async () => {
    const port = await start();
    const res = await turn(port);
    expect(res.status).toBe(200);
    expect(res.json.reply).toBe("Here is your card.");
    expect(res.json.ui).toMatchObject({
      resourceUri: "ui://fixture/card",
      tool: "show_card",
      toolInput: { title: "Hi" },
      toolResult: { structuredContent: { title: "Hi", tool: "show_card" } },
      csp: { connectDomains: ["https://content.example"] },
    });
    expect(res.json.ui.html).toContain("card view");
    expect(res.json.uiWarnings).toBeUndefined();
    // Still the same trace as before, plus the new optional fields.
    expect(res.json.trace[0]).toMatchObject({ tool: "show_card", text: "show_card ran with Hi", isError: false, origin: "brain" });
  });

  it("leaves a turn with no view exactly as it was", async () => {
    const port = await start({
      brain: (session) => ({
        name: "test",
        async turn() {
          return { reply: "ok", trace: [await callTool(await session(), "plain", {})] };
        },
      }),
    });
    const res = await turn(port);
    expect(res.json.ui).toBeUndefined();
    expect(res.json.uiWarnings).toBeUndefined();
  });

  it("tells the developer when a declared view can't be shown", async () => {
    const port = await start({
      brain: (session) => ({
        name: "test",
        async turn() {
          return { reply: "ok", trace: [await callTool(await session(), "bad_view", {})] };
        },
      }),
    });
    const res = await turn(port);
    expect(res.status).toBe(200);
    expect(res.json.ui).toBeUndefined();
    expect(res.json.uiWarnings[0]).toMatch(/MIME type/);
  });

  it("explains that a brain that makes calls itself can't show views", async () => {
    const port = await start({
      brain: () => ({
        name: "cursor",
        async turn() {
          const textOnly: ToolCallTrace = { tool: "show_card", args: {}, text: "ran", isError: false, ms: 1 };
          return { reply: "ok", trace: [textOnly] };
        },
      }),
    });
    const res = await turn(port);
    expect(res.json.ui).toBeUndefined();
    expect(res.json.uiWarnings[0]).toMatch(/cursor brain/);
  });

  it("reports the sandbox origin and which tools declare a view in /api/status", async () => {
    const port = await start();
    const status = (await send(port, "GET", "/api/status")).json;
    expect(status.ui.enabled).toBe(true);
    expect(status.ui.sandboxOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(status.ui.sandboxOrigin).not.toBe(`http://127.0.0.1:${port}`);
    const byName = Object.fromEntries(status.tools.map((t: { name: string; ui?: string }) => [t.name, t.ui]));
    expect(byName.show_card).toBe("ui://fixture/card");
    expect(byName.plain).toBeUndefined();
  });

  it("serves the sandbox proxy on that second origin", async () => {
    const port = await start();
    const { ui } = (await send(port, "GET", "/api/status")).json;
    const sandboxPort = Number(new URL(ui.sandboxOrigin).port);
    const page = await send(sandboxPort, "GET", "/sandbox.html");
    expect(page.status).toBe(200);
    expect(page.text).toContain("sandbox-proxy-ready");
  });

  it("with views off: no view, no capability advertised, no sandbox, no call-back route", async () => {
    const before = fixture.initCapabilities.length;
    const port = await start({ ui: false });
    const res = await turn(port);
    expect(res.json.ui).toBeUndefined();
    expect(res.json.trace[0].ui).toBeUndefined();

    const status = (await send(port, "GET", "/api/status")).json;
    expect(status.ui).toEqual({ enabled: false });
    expect(status.tools.every((t: { ui?: string }) => t.ui === undefined)).toBe(true);

    const initialize = fixture.initCapabilities[before] as { extensions?: unknown } | undefined;
    expect(initialize?.extensions).toBeUndefined();

    expect((await send(port, "POST", "/api/ui/tool-call", { name: "show_card" })).status).toBe(404);
  });

  describe("POST /api/ui/tool-call (a view calling a tool through the host)", () => {
    it("runs a tool with default visibility and returns the full result", async () => {
      const port = await start();
      const res = await send(port, "POST", "/api/ui/tool-call", { name: "show_card", arguments: { title: "again" } });
      expect(res.status).toBe(200);
      expect(res.json.result.structuredContent).toEqual({ title: "again", tool: "show_card" });
      expect(res.json.trace).toMatchObject({ tool: "show_card", origin: "view", args: { title: "again" } });
    });

    it("runs an app-only tool, which the model never sees", async () => {
      const port = await start();
      const res = await send(port, "POST", "/api/ui/tool-call", { name: "refresh_card", arguments: {} });
      expect(res.status).toBe(200);
      expect(res.json.trace.text).toBe("refresh_card ran with no title");
    });

    it("REJECTS a model-only tool and does not run it (the spec's MUST)", async () => {
      const port = await start();
      const before = fixture.calls.filter((c) => c === "model_only").length;
      const res = await send(port, "POST", "/api/ui/tool-call", { name: "model_only", arguments: {} });
      expect(res.status).toBe(403);
      expect(res.json.error).toMatch(/visibility/);
      expect(fixture.calls.filter((c) => c === "model_only").length).toBe(before);
    });

    it("rejects unknown tools and malformed bodies", async () => {
      const port = await start();
      expect((await send(port, "POST", "/api/ui/tool-call", { name: "nope" })).status).toBe(404);
      expect((await send(port, "POST", "/api/ui/tool-call", {})).status).toBe(400);
      expect((await send(port, "POST", "/api/ui/tool-call", { name: "show_card", arguments: [1] })).status).toBe(400);
    });

    it("is covered by the local API guards", async () => {
      const port = await start();
      const before = fixture.calls.length;
      const foreign = await send(port, "POST", "/api/ui/tool-call", { name: "show_card" }, { origin: "https://attacker.example" });
      expect(foreign.status).toBe(403);
      const plain = await send(port, "POST", "/api/ui/tool-call", undefined, { "content-type": "text/plain" });
      expect(plain.status).toBe(415);
      const rebound = await send(port, "POST", "/api/ui/tool-call", { name: "show_card" }, { host: `attacker.example:${port}` });
      expect(rebound.status).toBe(403);
      expect(fixture.calls.length).toBe(before);
    });
  });

  it("closes the sandbox port along with the server", async () => {
    const port = await start();
    const { ui } = (await send(port, "GET", "/api/status")).json;
    const sandboxPort = Number(new URL(ui.sandboxOrigin).port);
    const server = servers.pop()!;
    server.close();
    await once(server, "close");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(send(sandboxPort, "GET", "/sandbox.html")).rejects.toThrow();
  });

  it("serves the host bundle the page imports", async () => {
    const port = await start();
    const res = await send(port, "GET", "/host.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/javascript");
    expect(res.text).toContain("export{");
  });

  it("answers 500 JSON, not a hung connection, when a static file is missing", async () => {
    const sessionManager = new McpSessionManager({ mcpUrl: fixture.url, bearerToken: fixture.token });
    const server = createServer({
      sessionManager,
      brain: { name: "t", turn: async () => ({ reply: "", trace: [] }) },
      port: 0,
      publicDir: "/nonexistent-public-dir",
    });
    servers.push(server);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const res = await send(port, "GET", "/host.js");
    expect(res.status).toBe(500);
  });
});
