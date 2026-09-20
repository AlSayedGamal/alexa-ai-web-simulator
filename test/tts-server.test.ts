import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { Brain } from "../src/brains/types.js";
import { createServer } from "../src/server.js";
import type { McpSessionManager } from "../src/session.js";
import { TtsError, type TtsProvider } from "../src/tts/types.js";

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  bytes: Buffer;
  text: string;
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
        headers: {
          host: `127.0.0.1:${port}`,
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
          ...extra,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const bytes = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, bytes, text: bytes.toString() });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const audioBytes = new Uint8Array([9, 8, 7, 6]);

function fakeProvider(overrides: Partial<TtsProvider> = {}): TtsProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "fake",
    cacheKey: "v1",
    calls,
    async synthesize(text) {
      calls.push(text);
      return { audio: new Blob([audioBytes]).stream(), contentType: "audio/mpeg" };
    },
    ...overrides,
  };
}

describe("POST /api/tts", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      s.close();
      await once(s, "close");
    }
  });

  async function start(options: { tts?: TtsProvider; ttsMaxChars?: number; ttsCacheEntries?: number } = {}) {
    const brain: Brain = { name: "test", turn: async () => ({ reply: "hi", trace: [] }) };
    const sessionManager = {
      mcpUrl: "https://mcp.example.com/mcp",
      linkStatus: async () => ({ state: "linked" }),
      ensureSession: async () => ({ tools: [] }),
      invalidate: () => {},
    } as unknown as McpSessionManager;
    const server = createServer({ sessionManager, brain, port: 0, ...options });
    servers.push(server);
    await once(server, "listening");
    return (server.address() as AddressInfo).port;
  }

  it("answers 503 when no provider is configured", async () => {
    const port = await start();
    const res = await send(port, "POST", "/api/tts", { text: "hello" });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.text).kind).toBe("unavailable");
  });

  it("rejects a missing or blank text", async () => {
    const provider = fakeProvider();
    const port = await start({ tts: provider });
    expect((await send(port, "POST", "/api/tts", {})).status).toBe(400);
    expect((await send(port, "POST", "/api/tts", { text: "   " })).status).toBe(400);
    expect((await send(port, "POST", "/api/tts", { text: 5 })).status).toBe(400);
    expect(provider.calls).toEqual([]);
  });

  it("returns the audio with its content type and no caching", async () => {
    const port = await start({ tts: fakeProvider() });
    const res = await send(port, "POST", "/api/tts", { text: "hello" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/mpeg");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-length"]).toBe("4");
    expect(new Uint8Array(res.bytes)).toEqual(audioBytes);
  });

  it("serves an identical reply from the cache, but not a different one", async () => {
    const provider = fakeProvider();
    const port = await start({ tts: provider });
    await send(port, "POST", "/api/tts", { text: "same" });
    await send(port, "POST", "/api/tts", { text: "same" });
    expect(provider.calls).toEqual(["same"]);
    await send(port, "POST", "/api/tts", { text: "different" });
    expect(provider.calls).toEqual(["same", "different"]);
  });

  it("does not cache when the cache is disabled", async () => {
    const provider = fakeProvider();
    const port = await start({ tts: provider, ttsCacheEntries: 0 });
    await send(port, "POST", "/api/tts", { text: "same" });
    await send(port, "POST", "/api/tts", { text: "same" });
    expect(provider.calls).toEqual(["same", "same"]);
  });

  it("caps how much text is sent to the provider", async () => {
    const provider = fakeProvider();
    const port = await start({ tts: provider, ttsMaxChars: 30 });
    await send(port, "POST", "/api/tts", { text: "First sentence. Second sentence that is much too long to send." });
    expect(provider.calls).toEqual(["First sentence."]);
  });

  it("maps a provider failure to a 502 with its kind, and never to an HTML 500", async () => {
    const port = await start({
      tts: fakeProvider({
        async synthesize() {
          throw new TtsError("quota_or_rate", "ElevenLabs request failed (429): slow down", 429);
        },
      }),
    });
    const res = await send(port, "POST", "/api/tts", { text: "hello" });
    expect(res.status).toBe(502);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(res.text)).toEqual({ error: "ElevenLabs request failed (429): slow down", kind: "quota_or_rate" });
  });

  it("wraps an unexpected provider error as a server failure", async () => {
    const port = await start({
      tts: fakeProvider({
        async synthesize() {
          throw new Error("boom");
        },
      }),
    });
    const res = await send(port, "POST", "/api/tts", { text: "hello" });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.text)).toMatchObject({ kind: "server", error: expect.stringContaining("boom") });
  });

  it("does not cache a failure", async () => {
    let attempts = 0;
    const port = await start({
      tts: fakeProvider({
        async synthesize() {
          attempts += 1;
          if (attempts === 1) throw new TtsError("server", "down", 500);
          return { audio: new Blob([audioBytes]).stream(), contentType: "audio/mpeg" };
        },
      }),
    });
    expect((await send(port, "POST", "/api/tts", { text: "retry me" })).status).toBe(502);
    expect((await send(port, "POST", "/api/tts", { text: "retry me" })).status).toBe(200);
  });

  it("stops the upstream request when the browser gives up", async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((r) => (started = r));
    let sawAbort!: () => void;
    const abortPromise = new Promise<void>((r) => (sawAbort = r));

    const port = await start({
      tts: fakeProvider({
        synthesize(_text, { signal }) {
          started();
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              sawAbort();
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        },
      }),
    });

    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/api/tts",
      headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" },
    });
    req.on("error", () => {});
    req.end(JSON.stringify({ text: "long reply" }));
    await startedPromise;
    req.destroy(); // the page cancelled (mic pressed, new reply, tab closed)

    await expect(Promise.race([abortPromise, new Promise((_, r) => setTimeout(() => r(new Error("provider was not aborted")), 2000))])).resolves.toBeUndefined();
  });

  it("is covered by the local API guards", async () => {
    const provider = fakeProvider();
    const port = await start({ tts: provider });
    const foreign = await send(port, "POST", "/api/tts", { text: "hi" }, { origin: "https://attacker.example" });
    expect(foreign.status).toBe(403);
    const rebound = await send(port, "POST", "/api/tts", { text: "hi" }, { host: `attacker.example:${port}` });
    expect(rebound.status).toBe(403);
    const plain = await send(port, "POST", "/api/tts", undefined, { "content-type": "text/plain" });
    expect(plain.status).toBe(415);
    expect(provider.calls).toEqual([]);
  });

  it("reports the voice in /api/status", async () => {
    const withTts = await start({ tts: fakeProvider() });
    expect(JSON.parse((await send(withTts, "GET", "/api/status")).text).tts).toEqual({ name: "fake" });
    const without = await start();
    expect(JSON.parse((await send(without, "GET", "/api/status")).text).tts).toEqual({ name: "browser" });
  });

  it("serves the speaker module the page imports", async () => {
    const port = await start();
    const res = await send(port, "GET", "/tts.js");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/javascript");
    expect(res.text).toContain("export function createSpeaker");
  });
});
