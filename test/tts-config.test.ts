import { describe, expect, it } from "vitest";

import { ttsConfigFromEnv } from "../src/tts/config.js";

describe("ttsConfigFromEnv", () => {
  it("defaults to the browser voice with sensible limits", () => {
    const config = ttsConfigFromEnv({});
    expect(config.provider).toBeUndefined();
    expect(config.maxChars).toBe(500);
    expect(config.cacheEntries).toBe(20);
    expect(config.hint).toBeUndefined();
  });

  it("does not silently switch to a metered provider just because a key is set", () => {
    const config = ttsConfigFromEnv({ ELEVENLABS_API_KEY: "sk" });
    expect(config.provider).toBeUndefined();
    expect(config.hint).toMatch(/SIM_TTS=elevenlabs/);
  });

  it("builds ElevenLabs when opted in", () => {
    const config = ttsConfigFromEnv({
      SIM_TTS: "elevenlabs",
      ELEVENLABS_API_KEY: "sk",
      ELEVENLABS_VOICE_ID: "v1",
      ELEVENLABS_MODEL: "m1",
      ELEVENLABS_VOICE_SETTINGS: '{"stability":0.5}',
    });
    expect(config.provider?.name).toBe("elevenlabs");
    expect(config.provider?.cacheKey).toContain("m1");
    expect(config.provider?.cacheKey).toContain("stability");
  });

  it("is case-insensitive and reads the limits", () => {
    const config = ttsConfigFromEnv({
      SIM_TTS: "ElevenLabs",
      ELEVENLABS_API_KEY: "sk",
      ELEVENLABS_VOICE_ID: "v1",
      SIM_TTS_MAX_CHARS: "120",
      SIM_TTS_CACHE: "0",
    });
    expect(config.provider?.name).toBe("elevenlabs");
    expect(config.maxChars).toBe(120);
    expect(config.cacheEntries).toBe(0);
  });

  it("explains what's missing", () => {
    expect(() => ttsConfigFromEnv({ SIM_TTS: "elevenlabs", ELEVENLABS_VOICE_ID: "v" })).toThrow(/ELEVENLABS_API_KEY/);
    expect(() => ttsConfigFromEnv({ SIM_TTS: "elevenlabs", ELEVENLABS_API_KEY: "k" })).toThrow(/ELEVENLABS_VOICE_ID/);
  });

  it("rejects unknown providers and bad numbers or JSON", () => {
    expect(() => ttsConfigFromEnv({ SIM_TTS: "polly" })).toThrow(/"browser" or "elevenlabs"/);
    expect(() => ttsConfigFromEnv({ SIM_TTS_MAX_CHARS: "5" })).toThrow(/SIM_TTS_MAX_CHARS/);
    expect(() => ttsConfigFromEnv({ SIM_TTS_CACHE: "-1" })).toThrow(/SIM_TTS_CACHE/);
    expect(() => ttsConfigFromEnv({ SIM_TTS_CACHE: "many" })).toThrow(/SIM_TTS_CACHE/);
    const base = { SIM_TTS: "elevenlabs", ELEVENLABS_API_KEY: "k", ELEVENLABS_VOICE_ID: "v" };
    expect(() => ttsConfigFromEnv({ ...base, ELEVENLABS_VOICE_SETTINGS: "{nope" })).toThrow(/valid JSON/);
    expect(() => ttsConfigFromEnv({ ...base, ELEVENLABS_VOICE_SETTINGS: "[1]" })).toThrow(/JSON object/);
    expect(() => ttsConfigFromEnv({ ...base, ELEVENLABS_OUTPUT_FORMAT: "pcm_16000" })).toThrow(/can't be played/);
  });

  it("treats blank values as unset", () => {
    const config = ttsConfigFromEnv({ SIM_TTS: "  ", SIM_TTS_MAX_CHARS: " " });
    expect(config.provider).toBeUndefined();
    expect(config.maxChars).toBe(500);
  });
});
