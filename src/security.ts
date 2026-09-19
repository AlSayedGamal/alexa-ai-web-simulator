/**
 * Guards for the simulator's local HTTP API.
 *
 * The server only listens on 127.0.0.1, but that alone doesn't stop a web page
 * open in the same browser from talking to it:
 *
 *  - CSRF: a page can send a cross-origin "simple" POST (`text/plain`, no CORS
 *    preflight) to http://127.0.0.1:<port>/api/turn, which would run a brain
 *    turn on the user's linked MCP account and LLM key.
 *  - DNS rebinding: a page on attacker.example (resolving to 127.0.0.1) can
 *    read and write the API as "same origin", with `Host: attacker.example`.
 *
 * So every request must carry a loopback `Host`, any `Origin` must be this
 * server's own, and POSTs must be JSON (which a cross-origin page can't send
 * without a preflight, and we send no CORS headers).
 */
import type http from "node:http";

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost"];

export type GuardResult = { ok: true } | { ok: false; status: number; error: string };

/** `Host` header values this server may legitimately be reached as. */
export function allowedHosts(port: number): string[] {
  return LOOPBACK_HOSTS.map((h) => `${h}:${port}`);
}

/** `Origin` header values that are this server itself. */
export function allowedOrigins(port: number): string[] {
  return LOOPBACK_HOSTS.map((h) => `http://${h}:${port}`);
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function guardRequest(req: http.IncomingMessage, port: number): GuardResult {
  const host = header(req, "host")?.toLowerCase();
  if (!host || !allowedHosts(port).includes(host)) {
    return { ok: false, status: 403, error: "Forbidden: unexpected Host header." };
  }

  const origin = header(req, "origin");
  if (origin !== undefined && !allowedOrigins(port).includes(origin.toLowerCase())) {
    return { ok: false, status: 403, error: "Forbidden: cross-origin requests are not allowed." };
  }

  if (req.method === "POST") {
    const type = header(req, "content-type")?.split(";")[0].trim().toLowerCase();
    if (type !== "application/json") {
      return { ok: false, status: 415, error: "POST requests must be application/json." };
    }
  }

  return { ok: true };
}

/** Headers for the HTML page: it has a Confirm button and talks to a linked account,
 *  so it must not be framed by another site. */
export const HTML_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;
