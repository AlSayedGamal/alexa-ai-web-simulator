/**
 * Reads the TTS settings from environment variables. Pure (takes the env as an
 * argument) so it can be tested, and throws a plain `Error` with a message fit
 * to print, which the CLI turns into a startup failure.
 */
import { createElevenLabsTts, type ElevenLabsVoiceSettings } from "./elevenlabs.js";
import type { TtsProvider } from "./types.js";

export interface TtsConfig {
  /** Undefined means "use the browser's own voice", exactly as before. */
  provider?: TtsProvider;
  maxChars: number;
  cacheEntries: number;
  /** A one-line note for the operator to print, if there is one. */
  hint?: string;
}

type Env = Record<string, string | undefined>;

function get(env: Env, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

function intVar(env: Env, name: string, fallback: number, min: number): number {
  const raw = get(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer of at least ${min} (got "${raw}").`);
  }
  return value;
}

function parseVoiceSettings(raw: string | undefined): ElevenLabsVoiceSettings | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ELEVENLABS_VOICE_SETTINGS must be valid JSON, e.g. {\"stability\":0.5,\"speed\":1}.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("ELEVENLABS_VOICE_SETTINGS must be a JSON object.");
  }
  return parsed as ElevenLabsVoiceSettings;
}

export function ttsConfigFromEnv(env: Env): TtsConfig {
  const maxChars = intVar(env, "SIM_TTS_MAX_CHARS", 500, 20);
  const cacheEntries = intVar(env, "SIM_TTS_CACHE", 20, 0);
  const choice = (get(env, "SIM_TTS") ?? "browser").toLowerCase();

  if (choice === "browser") {
    return {
      maxChars,
      cacheEntries,
      hint: get(env, "ELEVENLABS_API_KEY")
        ? "ELEVENLABS_API_KEY is set but SIM_TTS isn't, so replies use the browser voice. Set SIM_TTS=elevenlabs to use ElevenLabs (reply text is sent to them and billed by character)."
        : undefined,
    };
  }

  if (choice === "elevenlabs") {
    const apiKey = get(env, "ELEVENLABS_API_KEY");
    const voiceId = get(env, "ELEVENLABS_VOICE_ID");
    if (!apiKey) throw new Error("SIM_TTS=elevenlabs needs ELEVENLABS_API_KEY.");
    if (!voiceId) {
      throw new Error("SIM_TTS=elevenlabs needs ELEVENLABS_VOICE_ID (pick a voice in the ElevenLabs voice library and copy its id).");
    }
    return {
      maxChars,
      cacheEntries,
      provider: createElevenLabsTts({
        apiKey,
        voiceId,
        modelId: get(env, "ELEVENLABS_MODEL"),
        outputFormat: get(env, "ELEVENLABS_OUTPUT_FORMAT"),
        voiceSettings: parseVoiceSettings(get(env, "ELEVENLABS_VOICE_SETTINGS")),
        baseUrl: get(env, "ELEVENLABS_BASE_URL"),
      }),
    };
  }

  throw new Error(`SIM_TTS must be "browser" or "elevenlabs" (got "${choice}").`);
}
