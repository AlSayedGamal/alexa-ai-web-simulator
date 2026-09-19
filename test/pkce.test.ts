import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createPkce } from "../src/pkce.js";

describe("createPkce", () => {
  it("produces a verifier within RFC 7636's 43-128 character range", () => {
    const { verifier } = createPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("derives the challenge as base64url(sha256(verifier)), method S256", () => {
    const { verifier, challenge, method } = createPkce();
    expect(method).toBe("S256");
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("generates a fresh pair every call", () => {
    const a = createPkce();
    const b = createPkce();
    expect(a.verifier).not.toBe(b.verifier);
  });
});
