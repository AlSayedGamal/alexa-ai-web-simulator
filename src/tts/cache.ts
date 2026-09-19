import { createHash } from "node:crypto";

export interface TtsClip {
  contentType: string;
  bytes: Uint8Array;
}

export interface TtsCacheOptions {
  /** 0 disables the cache. */
  maxEntries: number;
  /** Total size bound across all clips. Default 20 MB. */
  maxBytes?: number;
}

/**
 * In-memory LRU of synthesized clips, so an identical reply ("Sorry, something
 * went wrong", a repeated confirmation) isn't paid for twice. Bounded by count
 * and by total bytes; never written to disk.
 */
export function createTtsCache(options: TtsCacheOptions) {
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  const clips = new Map<string, TtsClip>(); // insertion order = recency order
  let totalBytes = 0;

  function drop(key: string): void {
    const clip = clips.get(key);
    if (!clip) return;
    totalBytes -= clip.bytes.length;
    clips.delete(key);
  }

  return {
    get(key: string): TtsClip | undefined {
      const clip = clips.get(key);
      if (!clip) return undefined;
      clips.delete(key); // move to most-recent
      clips.set(key, clip);
      return clip;
    },
    set(key: string, clip: TtsClip): void {
      if (options.maxEntries <= 0 || clip.bytes.length > maxBytes) return;
      drop(key);
      clips.set(key, clip);
      totalBytes += clip.bytes.length;
      while (clips.size > options.maxEntries || totalBytes > maxBytes) {
        const oldest = clips.keys().next().value;
        if (oldest === undefined) break;
        drop(oldest);
      }
    },
    get size(): number {
      return clips.size;
    },
    get bytes(): number {
      return totalBytes;
    },
  };
}

export type TtsCache = ReturnType<typeof createTtsCache>;

/** Stable key from the parts that determine the audio. */
export function ttsCacheKey(parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
