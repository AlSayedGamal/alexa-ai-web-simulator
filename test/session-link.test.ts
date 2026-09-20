import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_LINK_TIMEOUT_MS, LinkTimeoutError, linkAccount, type LinkOptions } from "../src/link.js";
import { McpSessionManager } from "../src/session.js";

vi.mock("../src/link.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/link.js")>()),
  linkAccount: vi.fn(),
}));

interface FakeLogin {
  options: LinkOptions;
  /** The human finishing (or not finishing) the login. */
  succeed: (token?: string) => void;
  fail: (error: Error) => void;
}

/** Each linkAccount() call becomes a login the test can resolve or reject, having "printed" its URL. */
function fakeLogins(): FakeLogin[] {
  const logins: FakeLogin[] = [];
  vi.mocked(linkAccount).mockImplementation((options) => {
    const n = logins.length + 1;
    return new Promise((resolve, reject) => {
      logins.push({
        options,
        succeed: (token = `token-${n}`) => resolve({ accessToken: token, clientId: "c", authorizationServer: {} as never }),
        fail: reject,
      });
      options.onAuthorizeUrl?.(`https://auth.example.com/authorize?attempt=${n}`);
    });
  });
  return logins;
}

const newManager = (link: ConstructorParameters<typeof McpSessionManager>[0]["link"] = {}) =>
  new McpSessionManager({ mcpUrl: "https://mcp.example.com/mcp", link });

describe("account linking state", () => {
  beforeEach(() => {
    vi.mocked(linkAccount).mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("doesn't keep a failed attempt: the next call starts a fresh one", async () => {
    const logins = fakeLogins();
    const manager = newManager();

    const first = manager.accessToken();
    logins[0].fail(new LinkTimeoutError(120_000));
    await expect(first).rejects.toThrow(/Timed out/);

    const second = manager.accessToken();
    expect(logins).toHaveLength(2);
    logins[1].succeed("fresh-token");
    await expect(second).resolves.toBe("fresh-token");
  });

  it("reports a timed-out attempt once, then the next status starts a new attempt", async () => {
    const logins = fakeLogins();
    const manager = newManager();

    expect(await manager.linkStatus()).toMatchObject({ state: "pending" });
    logins[0].fail(new LinkTimeoutError(120_000));
    await new Promise((r) => setImmediate(r));

    expect(await manager.linkStatus()).toEqual({
      state: "failed",
      error: "Timed out after 120000ms waiting for the login redirect",
      timedOut: true,
    });
    expect(await manager.linkStatus()).toMatchObject({ state: "pending", url: "https://auth.example.com/authorize?attempt=2" });
    expect(logins).toHaveLength(2);
  });

  it("marks other failures as not timed out", async () => {
    const logins = fakeLogins();
    const manager = newManager();
    await manager.linkStatus();
    logins[0].fail(new Error("Authorization server returned an error: access_denied"));
    await new Promise((r) => setImmediate(r));
    expect(await manager.linkStatus()).toMatchObject({ state: "failed", timedOut: false, error: expect.stringContaining("access_denied") });
  });

  it("reports the pending URL and when it expires, without waiting for the human", async () => {
    fakeLogins();
    const manager = newManager({ timeoutMs: 300_000 });

    const status = await manager.linkStatus();
    if (status.state !== "pending") throw new Error(`expected pending, got ${status.state}`);
    expect(status.url).toBe("https://auth.example.com/authorize?attempt=1");
    const remaining = status.expiresAt.getTime() - Date.now();
    expect(remaining).toBeGreaterThan(299_000);
    expect(remaining).toBeLessThanOrEqual(300_000);
  });

  it("shares one attempt between repeated status calls", async () => {
    const logins = fakeLogins();
    const manager = newManager();
    await manager.linkStatus();
    await manager.linkStatus();
    void manager.accessToken();
    expect(logins).toHaveLength(1);
  });

  it("reports linked once the login finishes", async () => {
    const logins = fakeLogins();
    const manager = newManager();
    await manager.linkStatus();
    logins[0].succeed();
    await new Promise((r) => setImmediate(r));
    expect(await manager.linkStatus()).toEqual({ state: "linked" });
  });

  it("passes the configured timeout through, and defaults to the library's", async () => {
    const logins = fakeLogins();
    await newManager({ timeoutMs: 42_000 }).linkStatus();
    await newManager().linkStatus();
    expect(logins[0].options.timeoutMs).toBe(42_000);
    expect(logins[1].options.timeoutMs).toBe(DEFAULT_LINK_TIMEOUT_MS);
  });

  it("still hands the URL to a custom onAuthorizeUrl, or prints it by default", async () => {
    fakeLogins();
    const seen: string[] = [];
    await newManager({ onAuthorizeUrl: (url) => seen.push(url) }).linkStatus();
    expect(seen).toEqual(["https://auth.example.com/authorize?attempt=1"]);
    expect(console.log).not.toHaveBeenCalled();

    await newManager().linkStatus();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("https://auth.example.com/authorize?attempt=2"));
  });

  it("doesn't offer a login URL that isn't http(s)", async () => {
    vi.mocked(linkAccount).mockImplementation((options) => {
      options.onAuthorizeUrl?.("javascript:alert(1)");
      return new Promise(() => {});
    });
    const status = await newManager().linkStatus();
    expect(status).toMatchObject({ state: "pending", url: undefined });
  });

  it("relink() replaces the stored attempt, and the old one can no longer fail the new one", async () => {
    const logins = fakeLogins();
    const manager = newManager();
    await manager.linkStatus();

    manager.relink();
    expect(logins).toHaveLength(2);
    logins[0].fail(new LinkTimeoutError(120_000)); // the abandoned attempt running out
    await new Promise((r) => setImmediate(r));

    expect(await manager.linkStatus()).toMatchObject({ state: "pending", url: "https://auth.example.com/authorize?attempt=2" });
  });

  it("relink() after a failure clears it and starts over", async () => {
    const logins = fakeLogins();
    const manager = newManager();
    await manager.linkStatus();
    logins[0].fail(new Error("boom"));
    await new Promise((r) => setImmediate(r));

    manager.relink();
    expect(await manager.linkStatus()).toMatchObject({ state: "pending" });
    expect(logins).toHaveLength(2);
  });

  it("invalidate() keeps a login that is still waiting for the human, but drops a finished one", async () => {
    const logins = fakeLogins();
    const manager = newManager();
    await manager.linkStatus();

    manager.invalidate();
    await manager.linkStatus();
    expect(logins).toHaveLength(1);

    logins[0].succeed();
    await new Promise((r) => setImmediate(r));
    manager.invalidate();
    await manager.linkStatus();
    expect(logins).toHaveLength(2);
  });

  it("with a bearer token there's nothing to link", async () => {
    const logins = fakeLogins();
    const manager = new McpSessionManager({ mcpUrl: "https://mcp.example.com/mcp", bearerToken: "t" });
    expect(await manager.linkStatus()).toEqual({ state: "linked" });
    manager.relink();
    expect(logins).toHaveLength(0);
  });
});
