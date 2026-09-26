// The real engines, on the real models, from two recorded clips. Skipped unless the four
// model directories are there (Piper speaks), since they are a gigabyte and a checkout does
// not carry them:
//
//   bun run apps/cophylad/scripts/fetch-models.ts --voice
//   bun test apps/cophylad/test/voice-engines.live.test.ts
//   COPHYLA_VOICE_MODELS=C:/D/scratch-m8/models bun test …   (models somewhere else)
//
// What it holds to: onnxruntime-node loads before sherpa-onnx (the order the two native
// runtimes need on Windows), the wake word fires on its own phrase and not on the question,
// the recogniser gets the question word for word, the VAD closes the utterance after the
// clip, each in-process speech engine whose model is here speaks in more than one chunk at
// 24 kHz in the voice picked, and the whole module turns a stream of frames into a
// `user.message` and speech back.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../src/bus.ts";
import { Activity } from "../src/chat/activity.ts";
import { Chat } from "../src/chat/index.ts";
import { ClientRegistry } from "../src/api/clients.ts";
import { Config } from "../src/config/schema.ts";
import { Asks } from "../src/gate/asks.ts";
import { silentLogger } from "../src/log.ts";
import { Sidecars } from "../src/sidecars/index.ts";
import { Store } from "../src/store/index.ts";
import { FRAME, IN_RATE, toInt16 } from "../src/voice/engines.ts";
import { Voice } from "../src/voice/index.ts";
import { localEngines, STT_MODEL, TTS_MODELS, VAD_MODEL, WAKE_MODEL } from "../src/voice/local.ts";
import { removeHome, sleep, tempHome, waitFor } from "./helpers.ts";

const MODELS = process.env["COPHYLA_VOICE_MODELS"] ?? join(import.meta.dir, "..", "models", "voice");
const CLIPS = join(import.meta.dir, "fixtures", "audio");
const NEEDED = [WAKE_MODEL, VAD_MODEL, STT_MODEL, TTS_MODELS.piper];
const present = NEEDED.every((m) => existsSync(join(MODELS, m, "manifest.json")));
const QUESTION = "What time is the meeting tomorrow afternoon?";

/** A 16-bit PCM wav's samples and rate. */
function readWav(path: string): { sampleRate: number; samples: Int16Array } {
  const bytes = new Uint8Array(readFileSync(path));
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 12;
  let sampleRate = 0;
  let channels = 1;
  while (pos + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(pos, pos + 4));
    const size = dv.getUint32(pos + 4, true);
    if (id === "fmt ") {
      channels = dv.getUint16(pos + 10, true);
      sampleRate = dv.getUint32(pos + 12, true);
    } else if (id === "data") {
      const count = Math.floor(Math.min(size, bytes.length - pos - 8) / 2 / channels);
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i++) samples[i] = dv.getInt16(pos + 8 + i * 2 * channels, true);
      return { sampleRate, samples };
    }
    pos += 8 + size + (size & 1);
  }
  throw new Error(`no data chunk in ${path}`);
}

const frames = (pcm: Int16Array): Int16Array[] => {
  const out: Int16Array[] = [];
  for (let i = 0; i + FRAME <= pcm.length; i += FRAME) out.push(pcm.subarray(i, i + FRAME));
  return out;
};
const silence = (ms: number): Int16Array[] => frames(new Int16Array(Math.round((IN_RATE * ms) / 1000)));
/** A frame's loudness, for deciding when a clip has gone quiet. */
const rms = (f: Int16Array): number => Math.sqrt([...f].reduce((n, v) => n + v * v, 0) / Math.max(1, f.length));
/** A frame is 40 ms of audio; the pipeline keeps up with several times real time, not with all of it at once. */
const FEED_MS = 8;

/** Words, lowercased with punctuation dropped: what a word error rate is counted over. */
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean);

function wer(ref: string, hyp: string): number {
  const r = words(ref);
  const h = words(hyp);
  const d: number[][] = Array.from({ length: r.length + 1 }, (_, i) => [i, ...new Array<number>(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0]![j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
  }
  return r.length ? d[r.length]![h.length]! / r.length : 0;
}

const config = (over: Partial<ReturnType<typeof Config.parse>["voice"]> = {}) => ({ ...Config.parse({}).voice, enabled: true, ...over });
// The models come from a local folder, as `[voice] models_dir` gives them while developing: the checkout's own sherpa-onnx stands in for an installed runtime.
const engines = () => localEngines({ dataDir: tempHome(), log: silentLogger, modelsDir: MODELS });
const dirOf = (name: string) => join(MODELS, name);

describe.skipIf(!present)("the real engines", () => {
  test("onnxruntime-node loads before sherpa-onnx, and both work", async () => {
    const { loadOrt, loadSherpa } = await import("../src/voice/runtime.ts");
    const ort = await loadOrt();
    expect(typeof ort.InferenceSession.create).toBe("function");
    const sherpa = await loadSherpa();
    expect(typeof sherpa.OnlineRecognizer).toBe("function");
    // The embedder uses the same runtime: it still loads after sherpa is in.
    const { InferenceSession } = await import("onnxruntime-node");
    expect(typeof InferenceSession.create).toBe("function");
  }, 60_000);

  test("the wake word fires on its phrase and stays quiet through the question", async () => {
    const model = await engines().wake(dirOf(WAKE_MODEL), config());
    try {
      const hit = model.stream();
      let peak = 0;
      for (const f of [...silence(500), ...frames(readWav(join(CLIPS, "cophyla.wav")).samples), ...silence(500)]) {
        peak = Math.max(peak, (await hit.feed(f)).score);
      }
      expect(peak).toBeGreaterThanOrEqual(0.9);

      const quiet = model.stream();
      let other = 0;
      for (const f of [...silence(500), ...frames(readWav(join(CLIPS, "question.wav")).samples)]) {
        other = Math.max(other, (await quiet.feed(f)).score);
      }
      expect(other).toBeLessThan(0.5);
    } finally {
      await model.close();
    }
  }, 120_000);

  test("the recogniser gets the question word for word, with partials on the way", async () => {
    const stt = await engines().stt(dirOf(STT_MODEL), config());
    try {
      const stream = stt.stream();
      const partials: string[] = [];
      stream.onPartial = (t) => partials.push(t);
      const clip = readWav(join(CLIPS, "question.wav"));
      expect(clip.sampleRate).toBe(IN_RATE);
      const started = Date.now();
      for (const f of frames(clip.samples)) stream.accept(f);
      const text = await stream.final();
      const took = Date.now() - started;
      expect(wer(QUESTION, text)).toBe(0);
      expect(partials.length).toBeGreaterThanOrEqual(2);
      // Real time is 3 s of audio: the decode must be well inside it.
      expect(took).toBeLessThan((clip.samples.length / IN_RATE) * 1000);
      stream.dispose();
    } finally {
      await stt.close();
    }
  }, 180_000);

  test("the VAD closes the utterance once, about a second after the speaking stops", async () => {
    const makeVad = await engines().vad(dirOf(VAD_MODEL), config({ vad_min_silence_ms: 700 }));
    const vad = makeVad();
    try {
      // The clip carries its own trailing silence, so the close may land inside the file: what
      // matters is that it comes after the speaking stopped, not after the bytes ran out.
      const clip = readWav(join(CLIPS, "question.wav"));
      const frameMs = (FRAME / IN_RATE) * 1000;
      let quietMs = 0;
      const closes: number[] = [];
      for (const f of [...frames(clip.samples), ...silence(2500)]) {
        quietMs = rms(f) < 200 ? quietMs + frameMs : 0;
        if (await vad.feed(f)) closes.push(quietMs);
      }
      expect(closes).toHaveLength(1);
      expect(closes[0]!).toBeGreaterThanOrEqual(600);
      expect(closes[0]!).toBeLessThan(1800);
    } finally {
      await vad.close();
    }
  }, 120_000);

  // Each in-process engine whose model is here: Piper always, Kokoro and Supertonic when fetched.
  for (const engine of ["piper", "kokoro", "supertonic"] as const) {
    test.skipIf(!existsSync(join(MODELS, TTS_MODELS[engine], "manifest.json")))(`${engine} speaks a two-sentence line in more than one chunk at 24 kHz, in the voice picked`, async () => {
      const tts = await engines().tts(dirOf(TTS_MODELS[engine]), config({ tts: engine }), new Sidecars({ dir: tempHome(), log: silentLogger }));
      try {
        expect(tts.name).toBe(engine);
        expect(tts.sampleRate).toBe(24000);
        expect(tts.voices).toBeGreaterThanOrEqual(1);
        tts.useVoice?.((tts.voices ?? 1) - 1);
        expect(tts.voice).toBe((tts.voices ?? 1) - 1);
        tts.useVoice?.(undefined);
        const started = Date.now();
        const chunks: Int16Array[] = [];
        let firstAt = 0;
        for await (const chunk of tts.synth("The meeting is at half past three. It is in the blue room.")) {
          if (!firstAt) firstAt = Date.now() - started;
          chunks.push(chunk);
        }
        const took = Date.now() - started;
        const samples = chunks.reduce((n, c) => n + c.length, 0);
        const audioMs = (samples / tts.sampleRate) * 1000;
        expect(chunks.length).toBeGreaterThanOrEqual(2);
        expect(audioMs).toBeGreaterThan(1500);
        // Faster than real time, and the first sentence leaves before the second is made.
        expect(took / audioMs).toBeLessThan(2);
        expect(firstAt).toBeLessThan(took);
      } finally {
        await tts.close();
      }
    }, 180_000);
  }

  test("the whole module: frames in, a user message out, and speech back to the phone", async () => {
    const home = tempHome();
    const store = new Store(":memory:");
    store.migrate();
    const bus = new Bus();
    const clients = new ClientRegistry();
    const asks = new Asks(store, "node_live", bus);
    const chat = new Chat({ store, bus, asks });
    const activity = new Activity({ bus });
    const sidecars = new Sidecars({ dir: join(home, "sidecars"), log: silentLogger });
    const audio: string[] = [];
    const client = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7", kind: "controller" as const, scopes: ["voice" as const, "chat" as const], via: "direct" as const, audio: { in: true, out: true }, connectedAt: 1 };
    clients.add(client, { send: (data) => { const f = JSON.parse(data) as { method: string; params: { chunk?: string } }; if (f.method === "voice.audio") audio.push(f.params.chunk!); }, close: () => {} }, "loopback");
    const voice = new Voice({
      config: config({ models_dir: MODELS }),
      dataDir: join(home, "data"),
      bus,
      log: silentLogger,
      clients,
      chat,
      activity,
      models: { resolve: async (name) => dirOf(name) },
      sidecars,
      engines: engines(),
    });
    try {
      await voice.start();
      await voice.ready();
      expect(voice.capabilities()).toEqual({ wake: true, stt: true, tts: true });

      const messages: string[] = [];
      bus.on("user.message", (m) => messages.push(m.text));
      const transcripts: string[] = [];
      bus.on("voice.transcript", (t) => transcripts.push(t.text));

      const wake = readWav(join(CLIPS, "cophyla.wav")).samples;
      const question = readWav(join(CLIPS, "question.wav")).samples;
      const send = (f: Int16Array) => voice.onAudio(client, { chunk: Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString("base64") });
      // Paced, as a phone sends it: a burst all at once would fill the backlog and the oldest
      // frames would be dropped, which is exactly what the guard is there to do.
      for (const f of [...silence(300), ...frames(wake), ...silence(200), ...frames(question), ...silence(2000)]) {
        send(f);
        await sleep(FEED_MS);
      }

      await waitFor(() => messages.length === 1, 60_000, 100);
      // The wake word fires partway through its own phrase, so its tail can lead the utterance;
      // what the question itself says must come through whole.
      expect(messages[0]!.toLowerCase()).toContain("what time is the meeting tomorrow afternoon");
      expect(wer(QUESTION, messages[0]!)).toBeLessThan(0.3);
      expect(transcripts.length).toBeGreaterThanOrEqual(2);

      voice.speak([{ type: "text", text: "It is at half past three." }], { client: client.id });
      await waitFor(() => audio.length > 0, 60_000, 100);
      const played = audio.reduce((n, c) => n + Buffer.from(c, "base64").byteLength / 2, 0);
      expect(played).toBeGreaterThan(0);
      // The speech is int16 at the engine's rate, in frames a browser can schedule.
      expect(Buffer.from(audio[0]!, "base64").byteLength % 2).toBe(0);
      await sleep(100);
    } finally {
      await voice.stop();
      await sidecars.stopAll();
      asks.dispose();
      store.close();
      removeHome(home);
    }
  }, 180_000);

  test("the ramp in and out of int16 keeps the waveform", () => {
    const floats = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const pcm = toInt16(floats);
    expect([...pcm]).toEqual([0, 16383, -16384, 32767, -32768]);
  });
});

describe.skipIf(present)("the real engines", () => {
  test.skip(`skipped: no voice models under ${MODELS} (run apps/cophylad/scripts/fetch-models.ts --voice)`, () => {});
});
