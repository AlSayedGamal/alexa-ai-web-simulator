import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Brain } from "../src/brains/types.js";
import { allowedHosts, allowedOrigins, guardRequest } from "../src/security.js";
import { createServer } from "../src/server.js";
import type { McpSessionManager } from "../src/session.js";

interface Reply {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

/** Raw request, because `fetch` forbids setting Host/Origin the way an attacker can. */
function send(
  port: number,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: res.headers }),
      );
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

describe("local API guards", () => {
  let server: http.Server;
  let port: number;
  let turn: ReturnType<typeof vi.fn>;
  let invalidate: ReturnType<typeof vi.fn>;
  const self = () => `127.0.0.1:${port}`;
  const json = () => ({ "content-type": "application/json" });

  beforeEach(async () => {
    turn = vi.fn().mockResolvedValue({ reply: "hi", trace: [] });
    invalidate = vi.fn();
    const brain: Brain = { name: "test", turn: turn as Brain["turn"], reset: vi.fn() };
    const sessionManager = {
      mcpUrl: "https://mcp.example.com/mcp",
      linkStatus: async () => ({ state: "linked" }),
      ensureSession: async () => ({ tools: [] }),
      invalidate,
    } as unknown as McpSessionManager;
    server = createServer({ sessionManager, brain, port: 0 });
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.close();
    await once(server, "close");
  });

  it("serves the normal browser flow", async () => {
    const status = await send(port, "GET", "/api/status", { headers: { host: self() } });
    expect(status.status).toBe(200);

    const reply = await send(port, "POST", "/api/turn", {
      headers: { host: self(), origin: `http://${self()}`, ...json() },
      body: JSON.stringify({ utterance: "hello" }),
    });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body).reply).toBe("hi");
    expect(turn).toHaveBeenCalledOnce();
  });

  it("also accepts localhost as the host name", async () => {
    const res = await send(port, "GET", "/api/status", { headers: { host: `localhost:${port}` } });
    expect(res.status).toBe(200);
  });

  it("rejects a foreign Host header (DNS rebinding) on the API and the page", async () => {
    for (const path of ["/api/status", "/"]) {
      const res = await send(port, "GET", path, { headers: { host: `attacker.example:${port}` } });
      expect(res.status, path).toBe(403);
    }
  });

  it("rejects a cross-origin POST without running the brain (CSRF)", async () => {
    const res = await send(port, "POST", "/api/turn", {
      headers: { host: self(), origin: "https://attacker.example", ...json() },
      body: JSON.stringify({ utterance: "confirm" }),
    });
    expect(res.status).toBe(403);
    expect(turn).not.toHaveBeenCalled();
  });

  it("rejects a text/plain POST, the no-preflight 'simple request' shape", async () => {
    const res = await send(port, "POST", "/api/turn", {
      headers: { host: self(), "content-type": "text/plain" },
      body: JSON.stringify({ utterance: "confirm" }),
    });
    expect(res.status).toBe(415);
    expect(turn).not.toHaveBeenCalled();
  });

  it("requires JSON on POST even with no body", async () => {
    expect((await send(port, "POST", "/api/reset", { headers: { host: self() } })).status).toBe(415);
    const ok = await send(port, "POST", "/api/reset", { headers: { host: self(), ...json() }, body: "{}" });
    expect(ok.status).toBe(200);
  });

  it("answers malformed JSON with 400 and does not throw away the linked session", async () => {
    const res = await send(port, "POST", "/api/turn", {
      headers: { host: self(), ...json() },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("frames-protects and nosniffs the page", async () => {
    const res = await send(port, "GET", "/", { headers: { host: self() } });
    expect(res.status).toBe(200);
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sends no CORS headers", async () => {
    const res = await send(port, "GET", "/api/status", { headers: { host: self(), origin: `http://${self()}` } });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("guardRequest", () => {
  const req = (headers: Record<string, string>, method = "GET") =>
    ({ headers, method }) as unknown as http.IncomingMessage;

  it("lists both loopback names for a port", () => {
    expect(allowedHosts(8790)).toEqual(["127.0.0.1:8790", "localhost:8790"]);
    expect(allowedOrigins(8790)).toEqual(["http://127.0.0.1:8790", "http://localhost:8790"]);
  });

  it("rejects a missing Host header", () => {
    expect(guardRequest(req({}), 8790)).toMatchObject({ ok: false, status: 403 });
  });

  it("rejects the opaque 'null' origin", () => {
    expect(guardRequest(req({ host: "127.0.0.1:8790", origin: "null" }), 8790)).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("is case-insensitive about the host and tolerates a charset on the content type", () => {
    const ok = guardRequest(
      req({ host: "LOCALHOST:8790", "content-type": "application/json; charset=utf-8" }, "POST"),
      8790,
    );
    expect(ok).toEqual({ ok: true });
  });
});
