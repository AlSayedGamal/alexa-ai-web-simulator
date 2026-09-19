/**
 * Checks an MCP server against Alexa+ MCP Toolkit's *published* account-linking
 * requirements — so a server that passes these today needs no changes when
 * real `alexa-ai` access is eventually granted (see docs/ALEXA_AI_CONTRACT.md
 * for the exact source and confidence level behind every check here; this
 * file implements nothing not documented there).
 *
 * This does NOT simulate alexa-ai's own request shapes (no fetch of
 * developer.amazon.com content was possible from the environment this was
 * written in — see the contract doc's "How this was sourced" section) — it
 * only checks the requirements Amazon's public docs state a server must
 * satisfy. Treat a clean report as "the known, documented bar is met," not
 * as proof of behavior undocumented pages might also require.
 */
import { discoverAuthorizationServer, discoverProtectedResource } from "./discovery.js";

export type ConformanceConfidence = "documented" | "advisory";

export interface ConformanceResult {
  id: string;
  description: string;
  source: string;
  confidence: ConformanceConfidence;
  pass: boolean;
  detail: string;
}

export interface ConformanceReport {
  mcpUrl: string;
  results: ConformanceResult[];
  /** True only if every "documented" (not "advisory") check passed. */
  passed: boolean;
}

type Fetch = typeof fetch;

async function checkUnauthenticatedIs401(mcpUrl: string, fetchImpl: Fetch): Promise<ConformanceResult> {
  const base = {
    id: "unauthenticated-401",
    description: "An unauthenticated request to the MCP endpoint returns 401.",
    source: "https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview.html",
    confidence: "documented" as const,
  };
  try {
    const res = await fetchImpl(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    return { ...base, pass: res.status === 401, detail: `Got HTTP ${res.status}` };
  } catch (err) {
    return { ...base, pass: false, detail: `Request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function checkWwwAuthenticateAbsent(mcpUrl: string, fetchImpl: Fetch): Promise<ConformanceResult> {
  const base = {
    id: "no-www-authenticate-on-401",
    description:
      'The 401 response has no WWW-Authenticate header (a claim seen in secondhand summaries of Amazon\'s docs, not independently confirmed against the primary source — see the contract doc). A server that DOES send WWW-Authenticate per the more common MCP auth convention is not necessarily wrong; treat this check as informational only, never as a reason to remove a header your own testing shows works.',
    source: "https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview.html (unverified detail)",
    confidence: "advisory" as const,
  };
  try {
    const res = await fetchImpl(mcpUrl, { method: "POST", headers: { "content-type": "application/json" } });
    const header = res.headers.get("www-authenticate");
    return {
      ...base,
      pass: !header,
      detail: header ? `Response includes WWW-Authenticate: ${header}` : "No WWW-Authenticate header present",
    };
  } catch (err) {
    return { ...base, pass: false, detail: `Request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function checkPkceS256Supported(mcpUrl: string, fetchImpl: Fetch): Promise<ConformanceResult> {
  const base = {
    id: "pkce-s256-supported",
    description:
      'Authorization server metadata advertises "S256" in code_challenge_methods_supported. Amazon states alexa-ai deploy is blocked without it.',
    source: "https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-account-linking.html",
    confidence: "documented" as const,
  };
  try {
    const resource = await discoverProtectedResource(mcpUrl, fetchImpl);
    const issuer = resource.authorization_servers?.[0];
    if (!issuer) return { ...base, pass: false, detail: "No authorization_servers in protected resource metadata" };
    const as = await discoverAuthorizationServer(issuer, fetchImpl);
    const methods = (as as { code_challenge_methods_supported?: string[] }).code_challenge_methods_supported ?? [];
    return {
      ...base,
      pass: methods.includes("S256"),
      detail: `code_challenge_methods_supported: ${JSON.stringify(methods)}`,
    };
  } catch (err) {
    return { ...base, pass: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function checkAuthorizationCodeGrant(mcpUrl: string, fetchImpl: Fetch): Promise<ConformanceResult> {
  const base = {
    id: "authorization-code-grant",
    description:
      '"Alexa+ add-ons support only the Authorization Code Grant" — the server\'s metadata must advertise authorization_code (other grants may also be listed; this only checks authorization_code is one of them).',
    source: "https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview.html",
    confidence: "documented" as const,
  };
  try {
    const resource = await discoverProtectedResource(mcpUrl, fetchImpl);
    const issuer = resource.authorization_servers?.[0];
    if (!issuer) return { ...base, pass: false, detail: "No authorization_servers in protected resource metadata" };
    const as = await discoverAuthorizationServer(issuer, fetchImpl);
    const grants = (as as { grant_types_supported?: string[] }).grant_types_supported;
    // RFC 8414: grant_types_supported defaults to ["authorization_code", "implicit"]
    // when the server omits it entirely, so an absent field isn't a failure.
    const pass = !grants || grants.includes("authorization_code");
    return { ...base, pass, detail: grants ? `grant_types_supported: ${JSON.stringify(grants)}` : "field omitted (RFC 8414 default applies)" };
  } catch (err) {
    return { ...base, pass: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function checkStreamableHttp(mcpUrl: string, fetchImpl: Fetch): Promise<ConformanceResult> {
  const base = {
    id: "streamable-http",
    description:
      "The MCP spec (2025-11-25) deprecated standalone HTTP+SSE in favor of Streamable HTTP; the endpoint must accept POST with an Accept header covering application/json and text/event-stream.",
    source: "https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview.html",
    confidence: "documented" as const,
  };
  try {
    const res = await fetchImpl(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    // Any non-5xx, non-network-error response means the endpoint speaks HTTP
    // POST at all — full protocol negotiation is exercised by mcp.ts's real
    // connectMcp() once a token is available, not by this unauthenticated probe.
    return { ...base, pass: res.status < 500, detail: `Got HTTP ${res.status}` };
  } catch (err) {
    return { ...base, pass: false, detail: `Request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const CHECKS = [
  checkStreamableHttp,
  checkUnauthenticatedIs401,
  checkWwwAuthenticateAbsent,
  checkPkceS256Supported,
  checkAuthorizationCodeGrant,
];

export async function checkAlexaPlusConformance(
  mcpUrl: string,
  fetchImpl: Fetch = fetch,
): Promise<ConformanceReport> {
  const results = await Promise.all(CHECKS.map((check) => check(mcpUrl, fetchImpl)));
  const passed = results.filter((r) => r.confidence === "documented").every((r) => r.pass);
  return { mcpUrl, results, passed };
}
