import { describe, expect, it, vi } from "vitest";

import { createElevenLabsTts, kindForStatus } from "../src/tts/elevenlabs.js";
import { TtsError } from "../src/tts/types.js";

const audioResponse = (init: ResponseInit = {}) =>
  new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" }, ...init });

function provider(fetchImpl: typeof fetch, options: Partial<Parameters<typeof createElevenLabsTts>[0]> = {}) {
  return createElevenLabsTts({ apiKey: "sk-test", voiceId: "voice-1", fetchImpl, ...options });
}

const signal = () => new AbortController().signal;

describe("createElevenLabsTts", () => {
  it("builds the documented request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(audioResponse());
    await provider(fetchImpl).synthesize("Hello there.", { signal: signal() });

    const [url, init] = fetchImpl.mock.calls[0];
    const parsed = new URL(url.toString());
    expect(parsed.origin + parsed.pathname).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice-1");
    expect(parsed.searchParams.get("output_format")).toBe("mp3_44100_128");
    expect(init.method).toBe("POST");
    expect(init.headers["xi-api-key"]).toBe("sk-test");
    expect(init.headers["content-type"]).toBe("application/json");
    // No model_id / voice_settings unless configured: the API's defaults apply.
    expect(JSON.parse(init.body)).toEqual({ text: "Hello there." });
  });

  it("sends the model, voice settings, output format and voice id when configured", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(audioResponse());
    await provider(fetchImpl, {
      voiceId: "a b/c",
      modelId: "eleven_test",
      outputFormat: "opus_48000_128",
      voiceSettings: { stability: 0.4, speed: 1.1 },
      baseUrl: "http://localhost:9999/",
    }).synthesize("Hi", { signal: signal() });

    const [url, init] = fetchImpl.mock.calls[0];
    const parsed = new URL(url.toString());
    expect(parsed.origin).toBe("http://localhost:9999");
    expect(parsed.pathname).toBe("/v1/text-to-speech/a%20b%2Fc");
    expect(parsed.searchParams.get("output_format")).toBe("opus_48000_128");
    expect(JSON.parse(init.body)).toEqual({
      text: "Hi",
      model_id: "eleven_test",
      voice_settings: { stability: 0.4, speed: 1.1 },
    });
  });

  it("returns the audio stream and the response's content type", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(audioResponse({ headers: { "content-type": "audio/mpeg" } }));
    const { audio, contentType } = await provider(fetchImpl).synthesize("Hi", { signal: signal() });
    expect(contentType).toBe("audio/mpeg");
    expect(new Uint8Array(await new Response(audio).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("falls back to a content type implied by the output format", async () => {
    const noType = () => new Response(new Uint8Array([1]), { status: 200 });
    for (const [format, expected] of [
      ["mp3_44100_128", "audio/mpeg"],
      ["opus_48000_128", "audio/ogg"],
      ["wav_44100", "audio/wav"],
    ] as const) {
      const out = await provider(vi.fn().mockResolvedValue(noType()), { outputFormat: format }).synthesize("Hi", {
        signal: signal(),
      });
      expect(out.contentType, format).toBe(expected);
    }
  });

  it("refuses output formats a browser <audio> element can't play", () => {
    for (const format of ["pcm_16000", "ulaw_8000", "alaw_8000"]) {
      expect(() => provider(vi.fn(), { outputFormat: format }), format).toThrow(/can't be played/);
    }
  });

  it("puts everything that changes the audio into the cache key", () => {
    const key = (o: object) => provider(vi.fn(), o).cacheKey;
    const base = key({});
    expect(key({ voiceId: "other" })).not.toBe(base);
    expect(key({ modelId: "m" })).not.toBe(base);
    expect(key({ outputFormat: "opus_48000_128" })).not.toBe(base);
    expect(key({ voiceSettings: { speed: 2 } })).not.toBe(base);
    expect(key({})).toBe(base);
  });

  it("passes the abort signal through to fetch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(audioResponse());
    const controller = new AbortController();
    await provider(fetchImpl).synthesize("Hi", { signal: controller.signal });
    expect(fetchImpl.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("lets an abort through untouched instead of calling it a network failure", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });
    const failure = await provider(fetchImpl).synthesize("Hi", { signal: controller.signal }).catch((e) => e);
    expect(failure).not.toBeInstanceOf(TtsError);
    expect(failure.name).toBe("AbortError");
  });

  it("maps a missing response to a network error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const failure = await provider(fetchImpl).synthesize("Hi", { signal: signal() }).catch((e) => e);
    expect(failure).toBeInstanceOf(TtsError);
    expect(failure.kind).toBe("network");
    expect(failure.message).toMatch(/fetch failed/);
  });

  it("maps HTTP failures to error kinds and carries the provider's message", async () => {
    const cases: Array<[number, unknown, string, string]> = [
      [401, { detail: { status: "invalid_api_key", message: "Invalid API key" } }, "auth", "Invalid API key"],
      [429, { detail: "Too many concurrent requests" }, "quota_or_rate", "Too many concurrent requests"],
      [422, { detail: { message: "Text is empty" } }, "bad_request", "Text is empty"],
      [503, "upstream down", "server", "upstream down"],
    ];
    for (const [status, body, kind, message] of cases) {
      const res = new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
      const failure = await provider(vi.fn().mockResolvedValue(res))
        .synthesize("Hi", { signal: signal() })
        .catch((e) => e);
      expect(failure, String(status)).toBeInstanceOf(TtsError);
      expect(failure.kind, String(status)).toBe(kind);
      expect(failure.status).toBe(status);
      expect(failure.message).toContain(message);
    }
  });

  it("keeps the API key out of the URL and adds nothing secret of its own to errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(audioResponse());
    await provider(fetchImpl).synthesize("Hi", { signal: signal() });
    expect(String(fetchImpl.mock.calls[0][0])).not.toContain("sk-test");

    const res = new Response(JSON.stringify({ detail: "Invalid API key" }), { status: 401 });
    const failure = await provider(vi.fn().mockResolvedValue(res)).synthesize("Hi", { signal: signal() }).catch((e) => e);
    expect(failure.message).toBe("ElevenLabs request failed (401): Invalid API key");
  });
});

describe("kindForStatus", () => {
  it("classifies status codes", () => {
    expect(kindForStatus(401)).toBe("auth");
    expect(kindForStatus(403)).toBe("auth");
    expect(kindForStatus(402)).toBe("quota_or_rate");
    expect(kindForStatus(429)).toBe("quota_or_rate");
    expect(kindForStatus(400)).toBe("bad_request");
    expect(kindForStatus(404)).toBe("bad_request");
    expect(kindForStatus(500)).toBe("server");
    expect(kindForStatus(502)).toBe("server");
  });
});
