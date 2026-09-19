/**
 * The page's voice. Plain ES module (no build step). Everything it touches in
 * the browser is injected, so it can be tested with fakes.
 *
 * Two ways to speak a reply:
 *  - "browser": the browser's own speechSynthesis (the default, unchanged).
 *  - anything else: POST /api/tts, play the returned audio. The provider's API
 *    key lives on the server; this file never sees it.
 *
 * Whatever goes wrong with the server voice, the reply is still spoken, just by
 * the browser voice, and `onProblem` is told once so the page can say why.
 *
 * `onStart` / `onEnd` bracket each reply: the page uses them to keep the mic
 * from hearing its own voice (mute while speaking, plus a short tail after).
 */
export function createSpeaker(deps = {}) {
  const {
    fetchImpl = (...args) => globalThis.fetch(...args),
    AudioImpl = globalThis.Audio,
    synth = globalThis.speechSynthesis,
    Utterance = globalThis.SpeechSynthesisUtterance,
    urlApi = globalThis.URL,
    onStart = () => {},
    onEnd = () => {},
    onProblem = () => {},
  } = deps;

  let provider = "browser";
  let enabled = true;
  let serverVoiceBroken = false; // after bad credentials, don't keep trying
  let lastProblem = ""; // the same failure is reported once, not on every reply
  let generation = 0; // bumped on every cancel/speak so stale async work goes quiet
  let speaking = false;
  let active = null; // { abort, audio, url } for the reply being played

  function begin() {
    speaking = true;
    onStart();
  }

  function finish(gen) {
    if (gen !== generation || !speaking) return;
    speaking = false;
    active = null;
    onEnd();
  }

  function releaseActive() {
    if (!active) return;
    active.abort?.();
    if (active.audio) {
      active.audio.onended = null;
      active.audio.onerror = null;
      active.audio.pause?.();
    }
    if (active.url) urlApi?.revokeObjectURL?.(active.url);
    active = null;
  }

  function speakWithBrowser(text, gen) {
    if (!synth || !Utterance) return finish(gen);
    const utterance = new Utterance(text);
    utterance.onend = () => finish(gen);
    utterance.onerror = () => finish(gen);
    synth.speak(utterance);
  }

  function playBlob(blob, gen) {
    const url = urlApi.createObjectURL(blob);
    const audio = new AudioImpl(url);
    active = { audio, url };
    return new Promise((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("The audio could not be played."));
      Promise.resolve(audio.play()).catch(reject);
    }).finally(() => {
      if (gen === generation) {
        urlApi.revokeObjectURL(url);
        active = null;
      }
    });
  }

  async function speakWithServer(text, gen) {
    const controller = new AbortController();
    active = { abort: () => controller.abort() };
    try {
      const res = await fetchImpl("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const info = await res.json().catch(() => ({}));
        throw Object.assign(new Error(info.error || `Text-to-speech failed (${res.status}).`), {
          kind: info.kind,
          status: res.status,
        });
      }
      const blob = await res.blob();
      if (gen !== generation) return;
      await playBlob(blob, gen);
      finish(gen);
    } catch (err) {
      if (gen !== generation || err?.name === "AbortError") return; // cancelled: not a failure
      if (err?.kind === "auth") serverVoiceBroken = true;
      if (err?.message !== lastProblem) {
        lastProblem = err?.message ?? "";
        onProblem(err);
      }
      releaseActive();
      speakWithBrowser(text, gen);
    }
  }

  function cancel() {
    generation += 1;
    releaseActive();
    synth?.cancel?.();
    if (speaking) {
      speaking = false;
      onEnd();
    }
  }

  return {
    /** "browser" or the provider name reported by /api/status. */
    setProvider(name) {
      provider = name || "browser";
    },
    setEnabled(on) {
      enabled = Boolean(on);
      if (!enabled) cancel();
    },
    cancel,
    async speak(text) {
      cancel();
      if (!enabled || !text) return;
      const gen = generation;
      begin();
      if (provider === "browser" || serverVoiceBroken) return speakWithBrowser(text, gen);
      return speakWithServer(text, gen);
    },
  };
}
