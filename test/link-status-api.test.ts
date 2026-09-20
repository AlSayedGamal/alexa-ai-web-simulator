import type http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Brain } from "../src/brains/types.js";
import { createServer } from "../src/server.js";
import type { LinkStatus, McpSessionManager } from "../src/session.js";

let server: http.Server | undefined;
afterEach(() => server?.close());

async function start(linkStatus: LinkStatus, extra: Record<string, unknown> = {}) {
  const reset = vi.fn();
  const relink = vi.fn();
  const brain: Brain = { name: "test", turn: vi.fn() as Brain["turn"], reset };
  const sessionManager = {
    mcpUrl: "https://mcp.example.com/mcp",
    linkStatus: async () => linkStatus,
    ensureSession: async () => ({ tools: [] }),
    invalidate: vi.fn(),
    relink,
    ...extra,
  } as unknown as McpSessionManager;
  server = createServer({ sessionManager, brain, port: 0, ui: false });
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, reset, relink };
}

describe("GET /api/status while linking", () => {
  it("returns the login link and its expiry, not linked yet", async () => {
    const expiresAt = new Date("2026-09-20T22:30:00.000Z");
    const { base } = await start({ state: "pending", url: "https://auth.example.com/authorize?x=1", expiresAt });
    const body = await (await fetch(`${base}/api/status`)).json();
    expect(body).toMatchObject({
      linked: false,
      linking: true,
      linkUrl: "https://auth.example.com/authorize?x=1",
      linkExpiresAt: "2026-09-20T22:30:00.000Z",
      mcpUrl: "https://mcp.example.com/mcp",
    });
    expect(body.tools).toBeUndefined();
  });

  it("omits linkUrl when there isn't a safe one to show", async () => {
    const { base } = await start({ state: "pending", expiresAt: new Date() });
    const body = await (await fetch(`${base}/api/status`)).json();
    expect(body.linking).toBe(true);
    expect("linkUrl" in body).toBe(false);
  });

  it("reports a timed-out attempt so the page can offer Try again", async () => {
    const { base } = await start({ state: "failed", error: "Timed out after 300000ms waiting for the login redirect", timedOut: true });
    expect(await (await fetch(`${base}/api/status`)).json()).toMatchObject({
      linked: false,
      linkFailed: true,
      linkTimedOut: true,
      error: expect.stringContaining("Timed out"),
    });
  });

  it("lists the tools once linked, as before", async () => {
    const { base } = await start({ state: "linked" }, { ensureSession: async () => ({ tools: [{ name: "recap", description: "d" }] }) });
    expect(await (await fetch(`${base}/api/status`)).json()).toMatchObject({
      linked: true,
      tools: [{ name: "recap", description: "d" }],
    });
  });

  it("still reports a connection error after linking (not a link failure)", async () => {
    const { base } = await start({ state: "linked" }, { ensureSession: async () => { throw new Error("connect refused"); } });
    const body = await (await fetch(`${base}/api/status`)).json();
    expect(body).toMatchObject({ linked: false, error: "connect refused" });
    expect(body.linkFailed).toBeUndefined();
  });
});

describe("POST /api/relink", () => {
  it("starts a new attempt and resets the brain", async () => {
    const { base, relink, reset } = await start({ state: "linked" });
    const res = await fetch(`${base}/api/relink`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(relink).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
  });

  it("is refused without a JSON content type, like every other POST", async () => {
    const { base, relink } = await start({ state: "linked" });
    const res = await fetch(`${base}/api/relink`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
    expect(res.status).toBe(415);
    expect(relink).not.toHaveBeenCalled();
  });
});
