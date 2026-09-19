/**
 * PKCE (RFC 7636) verifier/challenge pair, S256 only — this library never
 * does the plain-challenge fallback, since every MCP OAuth server it targets
 * is expected to be a modern OAuth 2.1 implementation that requires S256.
 */
import { createHash, randomBytes } from "node:crypto";

export interface Pkce {
  verifier: string;
  challenge: string;
  method: "S256";
}

export function createPkce(): Pkce {
  // 32 random bytes -> 43-char base64url string, inside RFC 7636's required
  // 43-128 character range for a code_verifier.
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}
