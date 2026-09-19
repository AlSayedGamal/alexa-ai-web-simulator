/**
 * `POST /api/tts { text }` → audio bytes. Kept out of server.ts so the route's
 * behaviour (validation, cache, cancellation, error mapping) lives in one place.
 */
import type http from "node:http";

import { createTtsCache, ttsCacheKey, type TtsClip } from "./cache.js";
import { capText } from "./text.js";
import { TtsError, type TtsProvider } from "./types.js";

export interface TtsRouteOptions {
  /** Undefined means no server-side voice: the page uses the browser's own. */
  provider?: TtsProvider;
  maxChars: number;
  /** 0 disables the cache. */
  cacheEntries: number;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendClip(res: http.ServerResponse, clip: TtsClip): void {
  res.writeHead(200, {
    "content-type": clip.contentType,
    "content-length": clip.bytes.length,
    // Replies are private; never let a browser or proxy keep a copy.
    "cache-control": "no-store",
  });
  res.end(clip.bytes);
}

export function createTtsRoute(options: TtsRouteOptions) {
  const cache = createTtsCache({ maxEntries: options.cacheEntries });
  const provider = options.provider;

  return {
    /** What `/api/status` reports so the page knows which voice path to use. */
    get name(): string {
      return provider?.name ?? "browser";
    },

    async handle(res: http.ServerResponse, body: unknown): Promise<void> {
      if (!provider) {
        return sendJson(res, 503, { error: "No text-to-speech provider is configured.", kind: "unavailable" });
      }
      const raw = (body as { text?: unknown } | null)?.text;
      if (typeof raw !== "string" || !raw.trim()) {
        return sendJson(res, 400, { error: "text is required" });
      }

      const text = capText(raw, options.maxChars);
      const key = ttsCacheKey([provider.name, provider.cacheKey ?? "", text]);
      const hit = cache.get(key);
      if (hit) return sendClip(res, hit);

      // If the browser gives up (cancelled reply, new turn, closed tab), stop the
      // upstream request too instead of finishing work nobody will hear.
      const abort = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) abort.abort();
      });

      try {
        const { audio, contentType } = await provider.synthesize(text, { signal: abort.signal });
        const clip: TtsClip = { contentType, bytes: new Uint8Array(await new Response(audio).arrayBuffer()) };
        if (abort.signal.aborted) return;
        cache.set(key, clip);
        return sendClip(res, clip);
      } catch (err) {
        if (abort.signal.aborted) return; // nobody is listening any more
        const failure =
          err instanceof TtsError
            ? err
            : new TtsError("server", `Text-to-speech failed: ${err instanceof Error ? err.message : String(err)}`);
        return sendJson(res, 502, { error: failure.message, kind: failure.kind });
      }
    },
  };
}

export type TtsRoute = ReturnType<typeof createTtsRoute>;
