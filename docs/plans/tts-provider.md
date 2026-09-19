# Plan: pluggable text-to-speech (ElevenLabs first)

**Status:** draft plan, no code yet. Feedback wanted before implementation starts.

## Why

Replies are spoken with the browser's built-in `speechSynthesis`. The voices depend entirely on the user's OS and browser, often sound robotic, and differ between machines. That matters most for the thing this simulator is often used for: recording a demo of a voice experience. A natural voice makes a demo read as an assistant instead of a screen reader.

Let the user choose a text-to-speech provider. Ship ElevenLabs as the first one, behind a small interface so others (OpenAI, Amazon Polly, Google, Azure) are ~40-line contributions.

## Goals

- Opt-in provider selection. **Unset = exactly today's behaviour.**
- The provider's API key never reaches the browser.
- A provider failure never breaks a turn: that reply falls back to the browser voice and the problem is shown once.
- Cost and privacy controls: character cap, a small in-memory cache, and clear documentation that reply text is sent to a third party.
- Cancellation works everywhere speech is cancelled today (the mic button, the 🔊 toggle, and a new reply replacing the old one), plus reset, which does not cancel speech today, and it stops the upstream request too.
- Echo suppression (the mic must never hear the simulator's own voice) keeps working.
- No new runtime dependency.

## Non-goals

- Speech *input*: the mic stays on the browser's `SpeechRecognition`.
- Voice cloning or voice management, SSML, word timings, provider WebSocket/real-time streaming.
- Changing what the brain says (prompt text is untouched).

## What exists today (facts from the code)

| Piece | Today |
| --- | --- |
| `public/index.html` `speak(text)` | Uses `speechSynthesis`. Aborts recognition (`rec?.abort()`), sets `quietUntil = Infinity` while speaking, then `Date.now() + 1500` on `end`/`error`. Stores `lastReply` for echo detection. |
| Cancel points | The mic button calls `speechSynthesis.cancel()`; the 🔊 toggle calls it when turning speech off; `speak()` cancels the previous utterance before starting a new one. The reset button does **not** cancel speech, so resetting mid-reply leaves it talking. |
| Server (`src/server.ts`) | `/api/status`, `/api/turn`, `/api/reset`, and serves only `/` and `/index.html`. No audio route, no other static files. |
| Config (`src/cli.ts`) | Env vars read at startup; brains auto-pick from which API key is set. |
| Dependencies | One runtime dependency (`@modelcontextprotocol/client`); the two LLM SDKs are optional peers. |
| Replies | Plain text, one to three short sentences, no markdown (the brain system prompt says so). |

## ElevenLabs API facts

Verified against the ElevenLabs API reference:

- `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}`, auth header `xi-api-key`, JSON body `{ text, model_id?, language_code?, voice_settings?, apply_text_normalization?, … }`.
- `voice_settings` fields: `stability`, `similarity_boost`, `style`, `speed`, `use_speaker_boost`.
- `output_format` query param, default `mp3_44100_128` (others listed include `opus_48000_128`, `pcm_16000`, `wav_44100`, `ulaw_8000`).
- Response is the audio bytes. `model_id` defaults to `eleven_multilingual_v2` when omitted.
- Streaming variant: `POST …/v1/text-to-speech/{voice_id}/stream`.

**Not confirmed from those pages, so a spike item, not an assumption:** a per-request character limit, which models are the low-latency ones, and how `401`/`429`/out-of-credits responses and quota headers look.

## Design

### 1. Provider interface

```ts
export interface TtsProvider {
  readonly name: string;
  synthesize(
    text: string,
    opts: { signal: AbortSignal },
  ): Promise<{ audio: ReadableStream<Uint8Array>; contentType: string }>;
}
```

`createElevenLabsTts({ apiKey, voiceId, modelId?, outputFormat?, voiceSettings?, fetchImpl? })`. `fetchImpl` is injectable, following the `fetchImpl` pattern already used in `src/discovery.ts`, so tests never touch the network. Use plain `fetch` (Node ≥ 20), not the ElevenLabs SDK, to add no dependency.

Errors are a `TtsError { status, kind, message }`. `kind` is derived from the HTTP status (`auth` for 401/403, `quota_or_rate` for 402/429, `bad_request` for 400/422, `server` for 5xx, `network` for no response) and carries the provider's message through. It deliberately doesn't invent provider-specific codes the docs don't state.

### 2. Server route

- `createServer({ tts?: TtsProvider })`; the CLI builds it from env.
- `POST /api/tts` with `{ text }`:
  1. Validate: non-empty string, cap at `SIM_TTS_MAX_CHARS` (default 500, cut at a sentence boundary).
  2. Cache lookup (below).
  3. `provider.synthesize` with an `AbortController` tied to `req.on("close")`, so a cancelled request in the browser also stops the upstream one.
  4. Stream the audio back with the provider's `content-type` and `cache-control: no-store`.
- Provider errors return JSON `{ error, kind }` with `502`; no provider configured returns `503`. Never an HTML 500.
- `GET /api/status` gains `tts: { name }` so the page knows which path to use.
- **Static files.** The server only serves `index.html` today. Add a small allowlisted route for the new `public/tts.js` (fixed filenames, no path traversal).
- **`POST` only.** A `GET /api/tts?text=` would be trivially triggerable cross-origin by any page (an `<audio src>` needs no preflight) and would spend the user's credits. See Phase 0.

### 3. Browser: a testable speaker

Move the audio logic out of the inline script into `public/tts.js` (plain ES module, no build step) as `createSpeaker({ fetch, Audio, speechSynthesis, provider, onStart, onEnd })`, with the browser globals injected so it can be tested with fakes.

- **Browser provider (default):** today's behaviour, unchanged.
- **Server provider:** `POST /api/tts` → `blob()` → `URL.createObjectURL` → `Audio.play()`. `ended`/`error` run the same `quietUntil` logic as `speechSynthesis`'s `onend`/`onerror`, so echo suppression is unchanged (`Infinity` until the audio ends, then +1500 ms).
- **v1 plays the whole clip.** Replies are one to three sentences, so it's simple and robust. Streaming playback (MediaSource for MP3 where supported, whole-clip otherwise) is Phase 3, once the spike measures time-to-first-audio.
- **Cancel** aborts the in-flight `fetch`, pauses and releases the audio, and cancels `speechSynthesis`, from every existing cancel point. Reset joins them (a small fix to today's behaviour, and worth a test).
- **Failure:** the reply is spoken with the browser voice instead, and the Connection card shows the provider error once (not per reply). After an `auth` error, stop calling the provider for the rest of the page session.
- **Autoplay policy:** `Audio.play()` can reject with `NotAllowedError` if the page has had no user gesture. Normal use always starts with a click/Enter/mic press, but treat a rejection as a failure: fall back to the browser voice and show a "click to enable audio" hint.

### 4. Configuration

Read in `src/cli.ts`, and available programmatically via `createServer({ tts })`.

| Env var | Purpose |
| --- | --- |
| `SIM_TTS` | `browser` (default) or `elevenlabs` |
| `ELEVENLABS_API_KEY` | required when `SIM_TTS=elevenlabs` |
| `ELEVENLABS_VOICE_ID` | required when `SIM_TTS=elevenlabs` (find it in the ElevenLabs voice library) |
| `ELEVENLABS_MODEL` | optional; the API default is used when unset |
| `ELEVENLABS_OUTPUT_FORMAT` | default `mp3_44100_128` |
| `ELEVENLABS_VOICE_SETTINGS` | optional JSON (`stability`, `similarity_boost`, `speed`, …) |
| `SIM_TTS_MAX_CHARS` | default 500 |
| `SIM_TTS_CACHE` | max cached clips, default 20; `0` disables |

**Opt-in on purpose.** If `ELEVENLABS_API_KEY` is set but `SIM_TTS` isn't, print a one-line hint and keep the browser voice. Unlike picking an LLM brain, switching voice silently would start sending reply text to a metered third-party service.

### 5. Cache

In-memory LRU keyed by a hash of (provider, voice, model, output format, settings, text), bounded by count and by total bytes (e.g. 20 MB). Identical replies ("Sorry, something went wrong", repeated confirmations) are then free and instant. Never written to disk.

### 6. Privacy and cost (goes in the README)

- The reply text is sent to the provider. It can contain data returned by the user's MCP server (ticket titles, meeting notes, names). That's why it's opt-in and off by default.
- ElevenLabs bills by characters. The cap and cache limit accidental spend, but it isn't a hard budget.

### 7. Extensibility

Export `TtsProvider`, `TtsError` and `createElevenLabsTts`. The README gets a short "add your own provider" example. Each further provider (OpenAI TTS, Polly, Google, Azure) is one module implementing `synthesize`; no plugin loader.

## Phase 0 (prerequisite, shared with the MCP Apps plan): harden the local API

Found while reading `src/server.ts`, **not yet reproduced**: `readJsonBody` parses the body regardless of `content-type`, and there is no `Host` or `Origin` check. A web page open in the same browser can send a cross-origin "simple" `POST` (`text/plain`, `mode: "no-cors"`) to `http://127.0.0.1:8790/api/turn` with no preflight, which runs a brain turn on the user's linked MCP account and LLM key. A DNS-rebinding page can do the same with a chosen `Host`.

`/api/tts` would add a route that spends money, so fix this first, as a small PR:

1. Reject any `/api/*` request whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>`.
2. Reject any request carrying an `Origin` that isn't the server's own.
3. Require `content-type: application/json` on `POST`s; send no CORS headers.
4. Tests for each rejection, and for the normal browser flow still working.

Whichever of this work and the MCP Apps UI work lands first takes this PR.

## Phases (each its own PR)

| # | PR | Size | Notes |
| --- | --- | --- | --- |
| 0 | Local API hardening (above) | S | Independent, do first |
| 1 | `TtsProvider` interface, `POST /api/tts`, allowlisted static route, `public/tts.js` speaker with the **browser provider only** | S–M | Refactor with no behaviour change; ships the tests and fakes |
| 2 | ElevenLabs provider, env config, cache, char cap, fallback, status, README | M | The spike happens at the start |
| 3 | Optional: streamed playback and a latency write-up | M | Only if the spike shows whole-clip latency hurts |
| 4 | Community providers | S each | Same interface |

## Spike (start of Phase 2, ~2 hours, needs a real key)

1. Confirm request/response for a short reply, and measure end-to-end latency with the default model against the lower-latency candidates named on ElevenLabs' models page. Pick the documented default from the result.
2. What do `401`, `429` and out-of-credits look like (status and body)? Are remaining-quota values in headers or a separate call?
3. The maximum text length accepted per request.
4. Does aborting the upstream request stop billing? (Unknown; document whatever is found.)

## Testing

- **Provider unit tests (no network):** the exact request built (URL with `voice_id`, `xi-api-key` header, JSON body, `output_format` query); status → `TtsError.kind` mapping; the `AbortSignal` is passed through; empty and oversize text rejected before any fetch.
- **Cache:** hit skips `fetch`; eviction respects both count and byte bounds; keys differ by voice/model/text.
- **Server routes** (fake provider, real `http` server): `/api/tts` returns audio and `content-type`; `400` on a bad body; `503` with no provider; provider error → `502` JSON; client disconnect aborts the provider signal; the Phase 0 rejections apply to it; `/api/status` reports the provider.
- **Speaker** (`vitest`, injected fakes, no jsdom): the browser path is unchanged; the server path plays and reports end; cancel aborts the fetch and pauses audio; failure falls back to the browser voice and reports once; `NotAllowedError` falls back; `quietUntil` follows the same `Infinity` → +1500 ms rule as before.
- **Manual with a real key:** cancel mid-reply from the mic, the toggle and reset; a wrong key gives the browser voice plus one visible warning; the key never appears in page source or the network tab; the mic does not re-hear the reply (echo suppression, including with slower audio start).
- CI already runs `npm run check`.

## Risks and open questions

- **Latency.** Whole-clip v1 can add a noticeable delay per reply compared with the browser voice. Streaming (Phase 3) mitigates it; the spike measures it first.
- **Echo suppression** depends on the spoken text matching `lastReply`. It does, since it's the same text, but the longer audio start means `quietUntil = Infinity` until `ended` matters more than before. Covered by the speaker tests and the manual check.
- **Provider drift.** Model names and defaults change. Keep the model id configurable and never hard-code behaviour on it.
- **Privacy and cost** (above): opt-in, documented, capped.
- **Interaction with the MCP Apps plan.** A reply that arrives without a fresh user gesture (for example one caused by a view's `ui/message`) is the case most likely to hit the autoplay policy; the fallback covers it.

## Definition of done

`SIM_TTS=elevenlabs` speaks replies in the configured voice; unset behaves identically to today; provider failures fall back without breaking a turn; the key never reaches the browser; the new tests are in CI; the README documents the env vars, the privacy note and how to add a provider; Phase 0 is merged.
