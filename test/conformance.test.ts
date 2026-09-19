import { describe, expect, it, vi } from "vitest";

import { checkAlexaPlusConformance } from "../src/conformance.js";

const MCP_URL = "https://mcp.example.com/mcp";

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  const h = new Headers(headers);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: h,
    json: async () => body,
  } as Response;
}

/** A fetch mock standing in for a server that satisfies every documented check. */
function compliantServerFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const method = init?.method ?? "GET";

    if (url.pathname === "/mcp") {
      return response(401, { error: "unauthorized" }); // no www-authenticate header
    }
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return response(200, { authorization_servers: ["https://as.example.com"] });
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      return response(200, {
        issuer: "https://as.example.com",
        authorization_endpoint: "https://as.example.com/authorize",
        token_endpoint: "https://as.example.com/token",
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
      });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
}

describe("checkAlexaPlusConformance", () => {
  it("passes every documented check for a fully compliant server", async () => {
    const report = await checkAlexaPlusConformance(MCP_URL, compliantServerFetch());
    expect(report.passed).toBe(true);
    const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));
    expect(byId["streamable-http"].pass).toBe(true);
    expect(byId["unauthenticated-401"].pass).toBe(true);
    expect(byId["pkce-s256-supported"].pass).toBe(true);
    expect(byId["authorization-code-grant"].pass).toBe(true);
    // Advisory-only: doesn't affect report.passed either way, but should
    // reflect reality for this fixture (no header was sent).
    expect(byId["no-www-authenticate-on-401"].pass).toBe(true);
  });

  it("fails the documented PKCE check when S256 isn't advertised", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname === "/mcp") return response(401, {});
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return response(200, { authorization_servers: ["https://as.example.com"] });
      }
      return response(200, {
        issuer: "https://as.example.com",
        authorization_endpoint: "https://as.example.com/authorize",
        token_endpoint: "https://as.example.com/token",
        code_challenge_methods_supported: ["plain"],
      });
    });
    const report = await checkAlexaPlusConformance(MCP_URL, fetchImpl);
    expect(report.passed).toBe(false);
    const check = report.results.find((r) => r.id === "pkce-s256-supported")!;
    expect(check.pass).toBe(false);
    expect(check.confidence).toBe("documented");
  });

  it("does not fail the report over the advisory WWW-Authenticate check alone", async () => {
    // Every check hits /mcp concurrently (Promise.all), so the header is set
    // unconditionally on that path rather than relying on call order.
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname === "/mcp") {
        return response(401, {}, { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"' });
      }
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return response(200, { authorization_servers: ["https://as.example.com"] });
      }
      return response(200, {
        issuer: "https://as.example.com",
        authorization_endpoint: "https://as.example.com/authorize",
        token_endpoint: "https://as.example.com/token",
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
      });
    });
    const report = await checkAlexaPlusConformance(MCP_URL, fetchImpl);
    const advisory = report.results.find((r) => r.id === "no-www-authenticate-on-401")!;
    expect(advisory.pass).toBe(false);
    expect(advisory.confidence).toBe("advisory");
    // The advisory failure must not drag down the overall report — only
    // "documented" checks (which don't inspect this header) decide `passed`.
    expect(report.passed).toBe(true);
    expect(report.results.filter((r) => r.confidence === "documented").every((r) => r.pass)).toBe(true);
  });

  it("treats an absent grant_types_supported as passing (RFC 8414 default)", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString());
      if (url.pathname === "/mcp") return response(401, {});
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return response(200, { authorization_servers: ["https://as.example.com"] });
      }
      return response(200, {
        issuer: "https://as.example.com",
        authorization_endpoint: "https://as.example.com/authorize",
        token_endpoint: "https://as.example.com/token",
        code_challenge_methods_supported: ["S256"],
        // grant_types_supported omitted on purpose
      });
    });
    const report = await checkAlexaPlusConformance(MCP_URL, fetchImpl);
    const check = report.results.find((r) => r.id === "authorization-code-grant")!;
    expect(check.pass).toBe(true);
  });
});
