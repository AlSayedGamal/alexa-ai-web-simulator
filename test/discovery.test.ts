import { describe, expect, it, vi } from "vitest";

import {
  discoverAuthorizationServer,
  discoverProtectedResource,
  registerDynamicClient,
} from "../src/discovery.js";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("discoverProtectedResource", () => {
  it("tries the spec-exact path-inserted well-known URL first", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { authorization_servers: ["https://as.example.com"] }));
    const result = await discoverProtectedResource("https://mcp.example.com/mcp", fetchImpl);
    expect(result.authorization_servers).toEqual(["https://as.example.com"]);
    const calledUrl = new URL(fetchImpl.mock.calls[0][0].toString());
    expect(calledUrl.pathname).toBe("/.well-known/oauth-protected-resource/mcp");
  });

  it("falls back to the origin-root well-known URL on a 404", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(200, { authorization_servers: ["https://as.example.com"] }));
    const result = await discoverProtectedResource("https://mcp.example.com/mcp", fetchImpl);
    expect(result.authorization_servers).toEqual(["https://as.example.com"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondUrl = new URL(fetchImpl.mock.calls[1][0].toString());
    expect(secondUrl.pathname).toBe("/.well-known/oauth-protected-resource");
  });

  it("throws when neither well-known URL resolves", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, {}));
    await expect(discoverProtectedResource("https://mcp.example.com/mcp", fetchImpl)).rejects.toThrow(
      /No oauth-protected-resource document/,
    );
  });

  it("throws when the metadata has no authorization_servers", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    await expect(discoverProtectedResource("https://mcp.example.com/mcp", fetchImpl)).rejects.toThrow(
      /no authorization_servers/,
    );
  });
});

describe("discoverAuthorizationServer", () => {
  it("returns authorize/token endpoints from the metadata document", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        issuer: "https://as.example.com",
        authorization_endpoint: "https://as.example.com/authorize",
        token_endpoint: "https://as.example.com/token",
      }),
    );
    const result = await discoverAuthorizationServer("https://as.example.com", fetchImpl);
    expect(result.authorization_endpoint).toBe("https://as.example.com/authorize");
    expect(result.token_endpoint).toBe("https://as.example.com/token");
  });

  it("throws when required endpoints are missing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { issuer: "https://as.example.com" }));
    await expect(discoverAuthorizationServer("https://as.example.com", fetchImpl)).rejects.toThrow(
      /missing required endpoints/,
    );
  });
});

describe("registerDynamicClient", () => {
  const metadata = {
    issuer: "https://as.example.com",
    authorization_endpoint: "https://as.example.com/authorize",
    token_endpoint: "https://as.example.com/token",
  };

  it("returns undefined when the server has no registration_endpoint", async () => {
    const fetchImpl = vi.fn();
    const result = await registerDynamicClient(metadata, "http://127.0.0.1:1234/callback", fetchImpl);
    expect(result).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("registers and returns the client_id when supported", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { client_id: "abc123" }));
    const result = await registerDynamicClient(
      { ...metadata, registration_endpoint: "https://as.example.com/register" },
      "http://127.0.0.1:1234/callback",
      fetchImpl,
    );
    expect(result).toBe("abc123");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://as.example.com/register");
    expect(JSON.parse(init.body).redirect_uris).toEqual(["http://127.0.0.1:1234/callback"]);
  });

  it("throws on a failed registration", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, {}));
    await expect(
      registerDynamicClient(
        { ...metadata, registration_endpoint: "https://as.example.com/register" },
        "http://127.0.0.1:1234/callback",
        fetchImpl,
      ),
    ).rejects.toThrow(/registration failed/);
  });
});
