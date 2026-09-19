import { describe, expect, it } from "vitest";

import { createTtsCache, ttsCacheKey } from "../src/tts/cache.js";
import { capText } from "../src/tts/text.js";

const clip = (n: number, type = "audio/mpeg") => ({ contentType: type, bytes: new Uint8Array(n) });

describe("capText", () => {
  it("leaves short text alone (trimmed)", () => {
    expect(capText("  Hello there.  ", 100)).toBe("Hello there.");
  });

  it("cuts at the last sentence end before the limit", () => {
    const text = "First sentence here. Second sentence goes on and on and on.";
    expect(capText(text, 40)).toBe("First sentence here.");
  });

  it("falls back to a word boundary, then a hard cut", () => {
    expect(capText("alpha beta gamma delta epsilon", 20)).toBe("alpha beta gamma");
    expect(capText("x".repeat(50), 20)).toBe("x".repeat(20));
  });

  it("never returns more than the limit", () => {
    for (const max of [10, 25, 60]) {
      expect(capText("One. Two two two. Three three three three. Four four four four four.", max).length).toBeLessThanOrEqual(max);
    }
  });
});

describe("createTtsCache", () => {
  it("returns what it stored, and misses otherwise", () => {
    const cache = createTtsCache({ maxEntries: 5 });
    expect(cache.get("a")).toBeUndefined();
    cache.set("a", clip(10));
    expect(cache.get("a")?.bytes.length).toBe(10);
  });

  it("evicts the least recently used when over the entry limit", () => {
    const cache = createTtsCache({ maxEntries: 2 });
    cache.set("a", clip(1));
    cache.set("b", clip(1));
    cache.get("a"); // a is now more recent than b
    cache.set("c", clip(1));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.size).toBe(2);
  });

  it("evicts to stay under the byte limit, and skips a clip that alone is too big", () => {
    const cache = createTtsCache({ maxEntries: 10, maxBytes: 100 });
    cache.set("a", clip(60));
    cache.set("b", clip(60));
    expect(cache.get("a")).toBeUndefined();
    expect(cache.bytes).toBe(60);
    cache.set("huge", clip(101));
    expect(cache.get("huge")).toBeUndefined();
    expect(cache.bytes).toBe(60);
  });

  it("replacing a key doesn't double-count its bytes", () => {
    const cache = createTtsCache({ maxEntries: 10 });
    cache.set("a", clip(10));
    cache.set("a", clip(30));
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(30);
  });

  it("is disabled at zero entries", () => {
    const cache = createTtsCache({ maxEntries: 0 });
    cache.set("a", clip(1));
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});

describe("ttsCacheKey", () => {
  it("differs by any part and is stable for the same parts", () => {
    const base = ttsCacheKey(["elevenlabs", "v1", "hello"]);
    expect(ttsCacheKey(["elevenlabs", "v1", "hello"])).toBe(base);
    expect(ttsCacheKey(["elevenlabs", "v2", "hello"])).not.toBe(base);
    expect(ttsCacheKey(["elevenlabs", "v1", "hello!"])).not.toBe(base);
    expect(ttsCacheKey(["other", "v1", "hello"])).not.toBe(base);
  });

  it("can't be confused by parts that concatenate the same way", () => {
    expect(ttsCacheKey(["ab", "c"])).not.toBe(ttsCacheKey(["a", "bc"]));
  });
});
