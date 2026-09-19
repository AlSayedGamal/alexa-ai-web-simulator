import { describe, expect, it, vi } from "vitest";

import { clampSize, createHostHandlers, safeHttpsUrl } from "../host/handlers.js";

function setup(fetchResult: { ok?: boolean; status?: number; body?: unknown } = {}) {
  const fetchImpl = vi.fn(async () => ({
    ok: fetchResult.ok ?? true,
    status: fetchResult.status ?? 200,
    json: async () => fetchResult.body ?? { trace: { tool: "t" }, result: { content: [{ type: "text", text: "done" }] } },
  })) as unknown as typeof fetch;
  const say = vi.fn();
  const onViewCall = vi.fn();
  const openWindow = vi.fn();
  const confirmOpen = vi.fn(() => true);
  return { handlers: createHostHandlers({ fetchImpl, say, onViewCall, openWindow, confirmOpen }), fetchImpl, say, onViewCall, openWindow, confirmOpen };
}

describe("callTool (a view's tools/call)", () => {
  it("proxies the call to the simulator server and returns the full result", async () => {
    const t = setup();
    const result = await t.handlers.callTool({ name: "refresh_card", arguments: { id: 1 } });
    const [url, init] = (t.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/ui/tool-call");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ name: "refresh_card", arguments: { id: 1 } });
    expect(result).toEqual({ content: [{ type: "text", text: "done" }] });
    expect(t.onViewCall).toHaveBeenCalledWith({ tool: "t" });
  });

  it("sends empty arguments when the view gives none", async () => {
    const t = setup();
    await t.handlers.callTool({ name: "x" });
    expect(JSON.parse((t.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body).arguments).toEqual({});
  });

  it("turns a refusal (visibility, unknown tool) into a rejected request, not a tool result", async () => {
    const t = setup({ ok: false, status: 403, body: { error: 'Tool "model_only" can\'t be called from a view.' } });
    await expect(t.handlers.callTool({ name: "model_only" })).rejects.toThrow(/can't be called from a view/);
    expect(t.onViewCall).not.toHaveBeenCalled();
  });

  it("has a sensible message when the error body isn't JSON", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, json: async () => Promise.reject(new Error("x")) })) as unknown as typeof fetch;
    const handlers = createHostHandlers({ fetchImpl, say: vi.fn(), confirmOpen: () => true, openWindow: vi.fn() });
    await expect(handlers.callTool({ name: "x" })).rejects.toThrow("Tool call failed (500).");
  });
});

describe("message (a view's ui/message)", () => {
  it("becomes a new utterance", async () => {
    const t = setup();
    await t.handlers.message({ role: "user", content: [{ type: "text", text: "Change the summary to X." }] });
    expect(t.say).toHaveBeenCalledWith("Change the summary to X.");
  });

  it("joins several text blocks and ignores non-text ones", async () => {
    const t = setup();
    await t.handlers.message({ role: "user", content: [{ type: "text", text: "line one" }, { type: "image" }, { type: "text", text: "line two" }] });
    expect(t.say).toHaveBeenCalledWith("line one\nline two");
  });

  it("refuses an empty or non-text message", async () => {
    const t = setup();
    await expect(t.handlers.message({ role: "user", content: [{ type: "image" }] })).rejects.toThrow(/text/);
    await expect(t.handlers.message({ role: "user", content: [{ type: "text", text: "  " }] })).rejects.toThrow();
    expect(t.say).not.toHaveBeenCalled();
  });

  it("answers the view without waiting for the brain's whole turn", async () => {
    const say = vi.fn(() => new Promise<void>(() => {})); // never resolves
    const handlers = createHostHandlers({ fetchImpl: vi.fn() as never, say, confirmOpen: () => true, openWindow: vi.fn() });
    await expect(handlers.message({ role: "user", content: [{ type: "text", text: "hi" }] })).resolves.toEqual({});
  });

  it("doesn't let a failing turn surface as an unhandled rejection", async () => {
    const say = vi.fn(async () => {
      throw new Error("brain failed");
    });
    const handlers = createHostHandlers({ fetchImpl: vi.fn() as never, say, confirmOpen: () => true, openWindow: vi.fn() });
    await handlers.message({ role: "user", content: [{ type: "text", text: "hi" }] });
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe("openLink (a view's ui/open-link)", () => {
  it("opens an https link after the user confirms", async () => {
    const t = setup();
    expect(await t.handlers.openLink({ url: "https://example.com/a" })).toEqual({});
    expect(t.confirmOpen).toHaveBeenCalledWith("https://example.com/a");
    expect(t.openWindow).toHaveBeenCalledWith("https://example.com/a");
  });

  it("does nothing, and says so, when the user declines", async () => {
    const t = setup();
    t.confirmOpen.mockReturnValue(false);
    expect(await t.handlers.openLink({ url: "https://example.com" })).toEqual({ isError: true });
    expect(t.openWindow).not.toHaveBeenCalled();
  });

  it("refuses anything that isn't https, without even asking", async () => {
    const t = setup();
    for (const url of ["http://example.com", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "nonsense"]) {
      await expect(t.handlers.openLink({ url }), url).rejects.toThrow(/https/);
    }
    expect(t.confirmOpen).not.toHaveBeenCalled();
    expect(t.openWindow).not.toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("safeHttpsUrl normalises https and rejects the rest", () => {
    expect(safeHttpsUrl("https://a.example/x")).toBe("https://a.example/x");
    expect(safeHttpsUrl("http://a.example")).toBeUndefined();
    expect(safeHttpsUrl(5)).toBeUndefined();
  });

  it("clampSize keeps a requested size inside the screen", () => {
    expect(clampSize(300, 480)).toBe(300);
    expect(clampSize(9999, 480)).toBe(480);
    expect(clampSize(-5, 480)).toBe(0);
    expect(clampSize(120.6, 480)).toBe(121);
    expect(clampSize(undefined, 480)).toBeUndefined();
    expect(clampSize(Number.NaN, 480)).toBeUndefined();
  });
});
