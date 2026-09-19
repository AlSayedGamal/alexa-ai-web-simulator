/**
 * OAuth discovery for MCP servers: RFC 9728 (Protected Resource Metadata)
 * then RFC 8414 (Authorization Server Metadata). This is what makes account
 * linking work against *any* spec-compliant MCP server, not just one whose
 * login screens this library was written against — see README "Why this
 * exists" for the servers this was validated against.
 *
 * Both RFCs define the well-known URL by inserting the well-known segment
 * before the target's own path (e.g. resource `https://h/mcp` ->
 * `https://h/.well-known/oauth-protected-resource/mcp`). In practice several
 * real MCP servers (including the one this library was extracted from —
 * @cloudflare/workers-oauth-provider's defaults) serve it at the bare origin
 * instead. This module tries the spec-exact URL first and falls back to the
 * origin-root variant on a 404, rather than guessing which one a given
 * server implements.
 */

export interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  [key: string]: unknown;
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  [key: string]: unknown;
}

type Fetch = typeof fetch;

function pathInsertedWellKnownUrl(target: URL, wellKnownSegment: string): URL {
  const url = new URL(target.origin);
  const path = target.pathname === "/" ? "" : target.pathname.replace(/\/$/, "");
  url.pathname = `/.well-known/${wellKnownSegment}${path}`;
  return url;
}

function originRootWellKnownUrl(target: URL, wellKnownSegment: string): URL {
  const url = new URL(target.origin);
  url.pathname = `/.well-known/${wellKnownSegment}`;
  return url;
}

async function fetchJsonWithFallback(
  target: URL,
  wellKnownSegment: string,
  fetchImpl: Fetch,
): Promise<unknown> {
  const candidates = [
    pathInsertedWellKnownUrl(target, wellKnownSegment),
    originRootWellKnownUrl(target, wellKnownSegment),
  ];
  let lastStatus: number | undefined;
  for (const url of candidates) {
    const res = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (res.ok) return res.json();
    lastStatus = res.status;
  }
  throw new Error(
    `No ${wellKnownSegment} document found at ${target.origin} (tried ${candidates.map((c) => c.pathname).join(", ")}; last status ${lastStatus})`,
  );
}

/** RFC 9728: discover which authorization server(s) protect this MCP resource. */
export async function discoverProtectedResource(
  resourceUrl: string,
  fetchImpl: Fetch = fetch,
): Promise<ProtectedResourceMetadata> {
  const target = new URL(resourceUrl);
  const metadata = (await fetchJsonWithFallback(
    target,
    "oauth-protected-resource",
    fetchImpl,
  )) as ProtectedResourceMetadata;
  if (!metadata.authorization_servers?.length) {
    throw new Error(
      `${target.origin}'s protected resource metadata has no authorization_servers`,
    );
  }
  return metadata;
}

/** RFC 8414: discover the authorize/token/registration endpoints for an issuer. */
export async function discoverAuthorizationServer(
  issuer: string,
  fetchImpl: Fetch = fetch,
): Promise<AuthorizationServerMetadata> {
  const target = new URL(issuer);
  const metadata = (await fetchJsonWithFallback(
    target,
    "oauth-authorization-server",
    fetchImpl,
  )) as AuthorizationServerMetadata;
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new Error(`${issuer}'s authorization server metadata is missing required endpoints`);
  }
  return metadata;
}

/** RFC 7591: dynamic client registration, when the server advertises it. Returns
 *  undefined (not an error) if the server has no registration_endpoint — the
 *  caller must then supply a pre-configured clientId. */
export async function registerDynamicClient(
  metadata: AuthorizationServerMetadata,
  redirectUri: string,
  fetchImpl: Fetch = fetch,
): Promise<string | undefined> {
  if (!metadata.registration_endpoint) return undefined;
  const res = await fetchImpl(metadata.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    }),
  });
  if (!res.ok) {
    throw new Error(`Dynamic client registration failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { client_id?: string };
  if (!body.client_id) throw new Error("Dynamic client registration response had no client_id");
  return body.client_id;
}
