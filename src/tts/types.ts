/**
 * Text-to-speech providers. A provider turns one reply into audio the browser
 * can play; the server (`POST /api/tts`) is the only caller, so the provider's
 * API key never reaches the page.
 */

export type TtsErrorKind =
  /** Bad or missing credentials (HTTP 401/403). Retrying won't help. */
  | "auth"
  /** Out of credits or rate limited (HTTP 402/429). */
  | "quota_or_rate"
  /** The provider rejected the request itself (other 4xx). */
  | "bad_request"
  /** The provider failed (5xx) or answered without audio. */
  | "server"
  /** No response at all. */
  | "network"
  /** No provider is configured. */
  | "unavailable";

export class TtsError extends Error {
  constructor(
    readonly kind: TtsErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TtsError";
  }
}

export interface TtsAudio {
  audio: ReadableStream<Uint8Array>;
  /** A type `<audio>` can play, e.g. `audio/mpeg`. */
  contentType: string;
}

export interface TtsProvider {
  readonly name: string;
  /** Fingerprint of everything besides the text that changes the audio (voice,
   *  model, format, settings). Part of the cache key, so changing any of them
   *  never serves a stale clip. */
  readonly cacheKey?: string;
  /**
   * Resolves once the provider has accepted the request and audio is flowing.
   * Must reject with a `TtsError` on failure, and stop work when `signal` aborts.
   */
  synthesize(text: string, options: { signal: AbortSignal }): Promise<TtsAudio>;
}
