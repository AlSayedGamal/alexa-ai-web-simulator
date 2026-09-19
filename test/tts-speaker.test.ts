import { describe, expect, it, vi } from "vitest";

// @ts-expect-error plain browser ES module with no type declarations
import { createSpeaker } from "../public/tts.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  paused = false;
  playError: unknown;
  constructor(
    readonly url: string,
    private readonly all: FakeAudio[],
    private readonly nextPlayError: () => unknown,
  ) {
    this.all.push(this);
    this.playError = nextPlayError();
  }
  play() {
    return this.playError ? Promise.reject(this.playError) : Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

function setup(options: { fetchImpl?: (...args: any[]) => Promise<any>; playError?: unknown } = {}) {
  const events: string[] = [];
  const problems: Error[] = [];
  const audios: FakeAudio[] = [];
  const spoken: string[] = [];
  const utterances: Array<{ text: string; onend?: () => void; onerror?: () => void }> = [];
  const synth = {
    cancelled: 0,
    speak(u: { text: string }) {
      spoken.push(u.text);
      utterances.push(u as never);
    },
    cancel() {
      synth.cancelled += 1;
    },
  };
  class FakeUtterance {
    onend?: () => void;
    onerror?: () => void;
    constructor(readonly text: string) {}
  }
  const urlApi = { createObjectURL: vi.fn(() => "blob:reply"), revokeObjectURL: vi.fn() };
  const fetchImpl =
    options.fetchImpl ?? vi.fn(async () => ({ ok: true, blob: async () => new Blob(["audio"]) }));

  const speaker = createSpeaker({
    fetchImpl,
    AudioImpl: class extends FakeAudio {
      constructor(url: string) {
        super(url, audios, () => options.playError);
      }
    },
    synth,
    Utterance: FakeUtterance,
    urlApi,
    onStart: () => events.push("start"),
    onEnd: () => events.push("end"),
    onProblem: (err: Error) => problems.push(err),
  });
  return { speaker, events, problems, audios, spoken, utterances, synth, urlApi, fetchImpl };
}

const failing = (status: number, body: object) => vi.fn(async () => ({ ok: false, status, json: async () => body }));

describe("browser voice (the default)", () => {
  it("speaks through speechSynthesis and brackets the reply with start/end", async () => {
    const t = setup();
    const done = t.speaker.speak("Hello there");
    expect(t.spoken).toEqual(["Hello there"]);
    expect(t.events).toEqual(["start"]);
    t.utterances[0].onend?.();
    await done;
    expect(t.events).toEqual(["start", "end"]);
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it("treats a speech error as the end of the reply", () => {
    const t = setup();
    t.speaker.speak("Hello");
    t.utterances[0].onerror?.();
    expect(t.events).toEqual(["start", "end"]);
  });

  it("does nothing for empty text or when speech is off", async () => {
    const t = setup();
    await t.speaker.speak("");
    t.speaker.setEnabled(false);
    await t.speaker.speak("Hello");
    expect(t.events).toEqual([]);
    expect(t.spoken).toEqual([]);
    t.speaker.setEnabled(true);
    t.speaker.speak("Hello");
    expect(t.spoken).toEqual(["Hello"]);
  });

  it("ends immediately where speech synthesis doesn't exist", async () => {
    const speaker = createSpeaker({
      synth: undefined,
      Utterance: undefined,
      onStart: () => events.push("start"),
      onEnd: () => events.push("end"),
    });
    const events: string[] = [];
    await speaker.speak("Hello");
    expect(events).toEqual(["start", "end"]);
  });
});

describe("server voice", () => {
  it("posts the text as JSON, plays the audio, and ends when it ends", async () => {
    const t = setup();
    t.speaker.setProvider("elevenlabs");
    const done = t.speaker.speak("Hello there");
    await flush();

    const [url, init] = (t.fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/tts");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ text: "Hello there" });

    expect(t.audios).toHaveLength(1);
    expect(t.audios[0].url).toBe("blob:reply");
    expect(t.events).toEqual(["start"]);
    t.audios[0].onended?.();
    await done;
    expect(t.events).toEqual(["start", "end"]);
    expect(t.urlApi.revokeObjectURL).toHaveBeenCalledWith("blob:reply");
    expect(t.spoken).toEqual([]);
  });

  it("aborts the request when cancelled before audio arrives, without reporting a problem", async () => {
    let signal!: AbortSignal;
    const fetchImpl = vi.fn((_url: string, init: { signal: AbortSignal }) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    });
    const t = setup({ fetchImpl });
    t.speaker.setProvider("elevenlabs");
    const done = t.speaker.speak("Hello");
    await flush();

    t.speaker.cancel();
    await done;
    expect(signal.aborted).toBe(true);
    expect(t.events).toEqual(["start", "end"]);
    expect(t.problems).toEqual([]);
    expect(t.spoken).toEqual([]);
    expect(t.synth.cancelled).toBeGreaterThan(0);
  });

  it("stops playing audio when cancelled mid-reply", async () => {
    const t = setup();
    t.speaker.setProvider("elevenlabs");
    t.speaker.speak("Hello");
    await flush();
    t.speaker.cancel();
    expect(t.audios[0].paused).toBe(true);
    expect(t.urlApi.revokeObjectURL).toHaveBeenCalledWith("blob:reply");
    expect(t.events).toEqual(["start", "end"]);
  });

  it("a new reply replaces the one still playing", async () => {
    const t = setup();
    t.speaker.setProvider("elevenlabs");
    t.speaker.speak("First");
    await flush();
    t.speaker.speak("Second");
    await flush();
    expect(t.events).toEqual(["start", "end", "start"]);
    expect(t.audios[0].paused).toBe(true);
    expect(t.audios).toHaveLength(2);
    t.audios[1].onended?.();
    await flush();
    expect(t.events).toEqual(["start", "end", "start", "end"]);
  });

  it("falls back to the browser voice on a provider failure, and says why once", async () => {
    const t = setup({ fetchImpl: failing(502, { error: "ElevenLabs request failed (500)", kind: "server" }) });
    t.speaker.setProvider("elevenlabs");

    const first = t.speaker.speak("First reply");
    await flush();
    expect(t.spoken).toEqual(["First reply"]);
    t.utterances[0].onend?.();
    await first;
    expect(t.problems.map((p) => p.message)).toEqual(["ElevenLabs request failed (500)"]);

    const second = t.speaker.speak("Second reply");
    await flush();
    t.utterances[1].onend?.();
    await second;
    expect(t.spoken).toEqual(["First reply", "Second reply"]);
    expect(t.problems).toHaveLength(1); // same failure, not repeated
    expect(t.events).toEqual(["start", "end", "start", "end"]);
  });

  it("stops calling the server voice after bad credentials", async () => {
    const t = setup({ fetchImpl: failing(502, { error: "Invalid API key", kind: "auth" }) });
    t.speaker.setProvider("elevenlabs");
    t.speaker.speak("One");
    await flush();
    t.speaker.speak("Two");
    await flush();
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
    expect(t.spoken).toEqual(["One", "Two"]);
  });

  it("falls back when the browser blocks autoplay", async () => {
    const t = setup({ playError: Object.assign(new Error("play() failed"), { name: "NotAllowedError" }) });
    t.speaker.setProvider("elevenlabs");
    t.speaker.speak("Hello");
    await flush();
    expect(t.problems[0]?.message).toBe("play() failed");
    expect(t.spoken).toEqual(["Hello"]);
  });

  it("falls back when the audio errors out", async () => {
    const t = setup();
    t.speaker.setProvider("elevenlabs");
    t.speaker.speak("Hello");
    await flush();
    t.audios[0].onerror?.();
    await flush();
    expect(t.problems).toHaveLength(1);
    expect(t.spoken).toEqual(["Hello"]);
  });

  it("switching speech off cancels what's playing", async () => {
    const t = setup();
    t.speaker.setProvider("elevenlabs");
    t.speaker.speak("Hello");
    await flush();
    t.speaker.setEnabled(false);
    expect(t.audios[0].paused).toBe(true);
    expect(t.events).toEqual(["start", "end"]);
  });

  it("goes back to the browser voice when the provider is reset to browser", async () => {
    const t = setup();
    t.speaker.setProvider("elevenlabs");
    t.speaker.setProvider("browser");
    t.speaker.speak("Hello");
    expect(t.spoken).toEqual(["Hello"]);
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });
});
