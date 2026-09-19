/**
 * ElevenLabs text-to-speech over plain `fetch` (no SDK, so no extra dependency).
 *
 *   POST {baseUrl}/v1/text-to-speech/{voice_id}?output_format=...
 *   header  xi-api-key: <key>
 *   body    { text, model_id?, voice_settings? }
 *   200     audio bytes
 *
 * @see https://elevenlabs.io/docs/api-reference/text-to-speech/convert
 */
import { TtsError, type TtsErrorKind, type TtsProvider } from "./types.js";

export interface ElevenLabsVoiceSettings {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  speed?: number;
  use_speaker_boost?: boolean;
}

export interface ElevenLabsTtsOptions {
  apiKey: string;
  voiceId: string;
  /** Leave unset to use the API's own default model. */
  modelId?: string;
  /** Must be something `<audio>` can play: `mp3_*`, `opus_*` or `wav_*`. Default `mp3_44100_128`. */
  outputFormat?: string;
  voiceSettings?: ElevenLabsVoiceSettings;
  /** Default `https://api.elevenlabs.io`. Overridable for tests and proxies. */
  baseUrl?: string;
  /** Injectable for tests, like `fetchImpl` in discovery.ts. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_FORMAT = "mp3_44100_128";

const CONTENT_TYPE_BY_FORMAT: Array<[RegExp, string]> = [
  [/^mp3_/, "audio/mpeg"],
  [/^opus_/, "audio/ogg"],
  [/^wav_/, "audio/wav"],
];

function contentTypeForFormat(format: string): string | undefined {
  return CONTENT_TYPE_BY_FORMAT.find(([re]) => re.test(format))?.[1];
}

export function kindForStatus(status: number): TtsErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || status === 429) return "quota_or_rate";
  if (status >= 500) return "server";
  return "bad_request";
}

/** ElevenLabs errors are usually `{ detail: { message } }` or `{ detail: "…" }`; fall back to raw text. */
async function describeFailure(res: Response): Promise<string> {
  const raw = (await res.text().catch(() => "")).trim();
  try {
    const detail = (JSON.parse(raw) as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
    const message = (detail as { message?: unknown } | undefined)?.message;
    if (typeof message === "string") return message;
  } catch {
    // not JSON
  }
  return raw.slice(0, 200);
}

export function createElevenLabsTts(options: ElevenLabsTtsOptions): TtsProvider {
  const format = options.outputFormat ?? DEFAULT_FORMAT;
  const fallbackContentType = contentTypeForFormat(format);
  if (!fallbackContentType) {
    throw new Error(
      `ElevenLabs output format "${format}" can't be played by a browser <audio> element; use an mp3_*, opus_* or wav_* format.`,
    );
  }
  const baseUrl = (options.baseUrl ?? "https://api.elevenlabs.io").replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;

  return {
    name: "elevenlabs",
    cacheKey: JSON.stringify([options.voiceId, options.modelId ?? "", format, options.voiceSettings ?? {}]),
    async synthesize(text, { signal }) {
      const url = new URL(`${baseUrl}/v1/text-to-speech/${encodeURIComponent(options.voiceId)}`);
      url.searchParams.set("output_format", format);

      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "xi-api-key": options.apiKey, "content-type": "application/json" },
          body: JSON.stringify({
            text,
            ...(options.modelId ? { model_id: options.modelId } : {}),
            ...(options.voiceSettings ? { voice_settings: options.voiceSettings } : {}),
          }),
          signal,
        });
      } catch (err) {
        if (signal.aborted) throw err; // the caller cancelled; let the abort through untouched
        throw new TtsError("network", `Could not reach ElevenLabs: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (!res.ok) {
        const detail = await describeFailure(res);
        throw new TtsError(
          kindForStatus(res.status),
          `ElevenLabs request failed (${res.status})${detail ? `: ${detail}` : ""}`,
          res.status,
        );
      }
      if (!res.body) throw new TtsError("server", "ElevenLabs returned no audio.", res.status);

      return {
        audio: res.body as ReadableStream<Uint8Array>,
        contentType: res.headers.get("content-type") ?? fallbackContentType,
      };
    },
  };
}
