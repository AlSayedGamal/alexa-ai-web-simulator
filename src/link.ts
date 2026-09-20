/**
 * Account linking: the OAuth 2.1 + PKCE "loopback" flow (RFC 8252 — the same
 * pattern `gcloud auth login` and similar CLIs use) against whatever
 * authorization server RFC 9728/8414 discovery (discovery.ts) finds for the
 * target MCP server. This works against any spec-compliant server regardless
 * of what its own login screen looks like, since a human completes it in
 * their own browser — nothing here assumes a particular login form.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { createPkce } from "./pkce.js";
import {
  discoverAuthorizationServer,
  discoverProtectedResource,
  registerDynamicClient,
  type AuthorizationServerMetadata,
} from "./discovery.js";

export interface LinkOptions {
  /** The MCP server's resource URL, e.g. https://your-server.example.com/mcp */
  mcpUrl: string;
  /** Skip RFC 7591 dynamic registration and use this client_id instead —
   *  required for servers (this library's own origin included) that don't
   *  implement dynamic registration and expect a pre-bootstrapped client. */
  clientId?: string;
  /** How long to wait for the human to complete login in their browser. Default 2 minutes. */
  timeoutMs?: number;
  /** Called with the URL to open once it's built. Defaults to console.log —
   *  pass your own to open a browser automatically or show it in a UI. */
  onAuthorizeUrl?: (url: string) => void;
}

/** How long linkAccount() waits for the login redirect when no `timeoutMs` is given. */
export const DEFAULT_LINK_TIMEOUT_MS = 120_000;

/** The human didn't finish logging in within `timeoutMs`. */
export class LinkTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for the login redirect`);
    this.name = "LinkTimeoutError";
  }
}

/** What linkAccount() does with the URL when `onAuthorizeUrl` isn't given. */
export function logAuthorizeUrl(url: string): void {
  console.log(`Open this URL to link your account:\n${url}`);
}

export interface LinkResult {
  accessToken: string;
  clientId: string;
  authorizationServer: AuthorizationServerMetadata;
}

function startLoopbackServer(): Promise<{
  port: number;
  waitForCode: (state: string, timeoutMs: number) => Promise<string>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        close: () => server.close(),
        waitForCode: (expectedState, timeoutMs) =>
          new Promise((resolveCode, rejectCode) => {
            const timer = setTimeout(() => {
              rejectCode(new LinkTimeoutError(timeoutMs));
            }, timeoutMs);
            server.on("request", (req, res) => {
              const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
              if (url.pathname !== "/callback") {
                res.writeHead(404).end();
                return;
              }
              clearTimeout(timer);
              const error = url.searchParams.get("error");
              const code = url.searchParams.get("code");
              const state = url.searchParams.get("state");
              res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
              res.end(
                error
                  ? `<p>Login failed: ${error}. You can close this window.</p>`
                  : `<p>Linked. You can close this window and return to the app.</p>`,
              );
              if (error) return rejectCode(new Error(`Authorization server returned an error: ${error}`));
              if (state !== expectedState) return rejectCode(new Error("State mismatch — possible CSRF, aborting"));
              if (!code) return rejectCode(new Error("No authorization code in the redirect"));
              resolveCode(code);
            });
          }),
      });
    });
  });
}

/** Runs the full OAuth 2.1 + PKCE loopback flow and returns a bearer token. */
export async function linkAccount(options: LinkOptions): Promise<LinkResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LINK_TIMEOUT_MS;

  const resource = await discoverProtectedResource(options.mcpUrl);
  const issuer = resource.authorization_servers![0];
  const authorizationServer = await discoverAuthorizationServer(issuer);

  const loopback = await startLoopbackServer();
  const redirectUri = `http://127.0.0.1:${loopback.port}/callback`;

  try {
    const clientId =
      options.clientId ??
      (await registerDynamicClient(authorizationServer, redirectUri)) ??
      (() => {
        throw new Error(
          `${issuer} has no registration_endpoint (RFC 7591) — pass a pre-configured clientId instead.`,
        );
      })();

    const pkce = createPkce();
    const state = randomBytes(16).toString("base64url");

    const authorizeUrl = new URL(authorizationServer.authorization_endpoint);
    authorizeUrl.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      code_challenge: pkce.challenge,
      code_challenge_method: pkce.method,
      state,
      resource: options.mcpUrl, // RFC 8707 — binds the token's audience where the server checks it
    }).toString();

    (options.onAuthorizeUrl ?? logAuthorizeUrl)(authorizeUrl.toString());

    const code = await loopback.waitForCode(state, timeoutMs);

    const tokenRes = await fetch(authorizationServer.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: pkce.verifier,
      }),
    });
    const tokens = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
    if (!tokens.access_token) {
      throw new Error(`Token exchange failed: ${tokens.error ?? tokenRes.status} ${tokens.error_description ?? ""}`.trim());
    }

    return { accessToken: tokens.access_token, clientId, authorizationServer };
  } finally {
    loopback.close();
  }
}
