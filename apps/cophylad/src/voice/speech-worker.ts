// The speech process: the local transcription and speech engines, in a process of their own
// that cophylad starts when a voice turn begins and ends as soon as it is over
// (`speech-process.ts`), so a node holds none of their models while nobody speaks. It answers
// messages over Bun's IPC channel, audio as typed arrays; the engines load one at a time,
// transcription first because it is wanted first, and what arrives for a stage while it
// loads waits for it. A speech engine says a throwaway line once it is up, since its first
// line costs most of a second more than the ones after it (espeak-ng and ONNX Runtime warm
// up), and that second is better spent while the user is still speaking. The process ends
// when the channel does, so it never outlives the daemon.

import type { FromWorker, SttSpec, ToWorker, TtsSpec } from "./speech-process.ts";
import type { SttEngine, SttStream, TtsEngine } from "./engines.ts";
import { loadNemotron } from "./nemotron.ts";
import { loadOrt, useSherpaFrom } from "./runtime.ts";
import { loadOfflineStt } from "./sherpa-stt.ts";
import { loadSherpaTts } from "./sherpa-tts.ts";

const WARM_UP = "Ready.";

function send(m: FromWorker): void {
  process.send?.(m);
}

function log(level: "debug" | "info" | "warn", msg: string, fields?: Record<string, unknown>): void {
  send({ t: "log", level, msg, ...(fields ? { fields } : {}) });
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

let nospin = "";

/** One stage: the engine in use, the loads asked for and not yet settled, and what waits for them. */
class Stage<E, S> {
  engine?: E;
  failure?: string;
  private waiting: ((engine: E | undefined) => void)[] = [];
  private loads = 0;

  /** A load was asked for: what arrives from now on waits for it, though it runs after the loads before it. */
  expect(): void {
    this.loads++;
  }

  /** Runs `fn` with the engine once the loads asked for settle; with none when the last failed. */
  use(fn: (engine: E | undefined) => void): void {
    if (this.loads === 0) fn(this.failure ? undefined : this.engine);
    else this.waiting.push(fn);
  }

  async load(spec: S, make: (spec: S) => Promise<E>, after: (engine: E) => Promise<void> = async () => {}): Promise<{ engine?: E; failure?: string }> {
    try {
      const engine = await make(spec);
      await after(engine);
      this.engine = engine;
      this.failure = undefined;
      return { engine };
    } catch (e) {
      this.failure = reason(e);
      return { failure: this.failure };
    } finally {
      this.loads--;
      if (this.loads === 0) for (const fn of this.waiting.splice(0)) fn(this.failure ? undefined : this.engine);
    }
  }
}

const stt = new Stage<SttEngine, SttSpec>();
const tts = new Stage<TtsEngine, TtsSpec>();
const streams = new Map<number, SttStream>();
const synths = new Map<number, AbortController>();

function makeStt(spec: SttSpec): Promise<SttEngine> {
  const common = { threads: spec.threads, nospin, ...(spec.language ? { language: spec.language } : {}) };
  return spec.engine === "nemotron" ? loadNemotron(spec.dir, common) : loadOfflineStt(spec.dir, common);
}

async function makeTts(spec: TtsSpec): Promise<TtsEngine> {
  return loadSherpaTts(spec.engine, spec.dir, { threads: spec.threads, nospin, ...(spec.voice !== undefined ? { voice: spec.voice } : {}) });
}

async function warm(engine: TtsEngine): Promise<void> {
  for await (const _ of engine.synth(WARM_UP)) {
    // made and dropped
  }
}

/** One load at a time, in the order asked. */
let loading: Promise<void> = Promise.resolve();

function load(m: Extract<ToWorker, { t: "load" }>): void {
  (m.stage === "stt" ? stt : tts).expect();
  loading = loading.then(async () => {
    const started = performance.now();
    if (m.stage === "stt") {
      const r = await stt.load(m.spec, makeStt);
      const ms = Math.round(performance.now() - started);
      if (r.engine) send({ t: "loaded", stage: "stt", engine: m.spec.engine, ms });
      else send({ t: "failed", stage: "stt", engine: m.spec.engine, reason: r.failure ?? "failed" });
    } else {
      const r = await tts.load(m.spec, makeTts, warm);
      const ms = Math.round(performance.now() - started);
      if (r.engine) send({ t: "loaded", stage: "tts", engine: m.spec.engine, ms, voices: r.engine.voices ?? 1, voice: r.engine.voice ?? 0 });
      else send({ t: "failed", stage: "tts", engine: m.spec.engine, reason: r.failure ?? "failed" });
    }
  });
}

async function synth(m: Extract<ToWorker, { t: "tts.synth" }>, engine: TtsEngine | undefined): Promise<void> {
  const ac = synths.get(m.id);
  if (!ac || ac.signal.aborted) {
    synths.delete(m.id);
    send({ t: "tts.end", id: m.id });
    return;
  }
  if (!engine) {
    synths.delete(m.id);
    send({ t: "tts.end", id: m.id, error: tts.failure ?? "no speech engine is loaded" });
    return;
  }
  try {
    engine.useVoice?.(m.voice);
    for await (const pcm of engine.synth(m.text, { signal: ac.signal })) {
      if (ac.signal.aborted) break;
      send({ t: "tts.chunk", id: m.id, pcm });
    }
    send({ t: "tts.end", id: m.id });
  } catch (e) {
    send({ t: "tts.end", id: m.id, ...(ac.signal.aborted ? {} : { error: reason(e) }) });
  } finally {
    synths.delete(m.id);
  }
}

function handle(m: ToWorker): void {
  switch (m.t) {
    case "init":
      nospin = m.nospin;
      useSherpaFrom({ dataDir: m.dataDir, dev: m.dev });
      // onnxruntime-node before sherpa, always: see runtime.ts.
      loading = loading.then(
        () => loadOrt().then(() => undefined),
        () => undefined,
      );
      loading = loading.catch((e: unknown) => log("warn", "onnxruntime-node did not load", { error: reason(e) }));
      return;
    case "load":
      load(m);
      return;
    case "stt.open":
      stt.use((engine) => {
        if (!engine) return;
        const stream = engine.stream(m.language ? { language: m.language } : {});
        stream.onPartial = (text) => send({ t: "stt.partial", id: m.id, text });
        streams.set(m.id, stream);
      });
      return;
    case "stt.audio":
      stt.use(() => streams.get(m.id)?.accept(m.pcm));
      return;
    case "stt.final":
      stt.use(() => {
        const stream = streams.get(m.id);
        if (!stream) {
          send({ t: "stt.text", id: m.id, text: "" });
          return;
        }
        stream.final().then(
          (text) => send({ t: "stt.text", id: m.id, text }),
          (e: unknown) => {
            log("warn", "transcription failed", { error: reason(e) });
            send({ t: "stt.text", id: m.id, text: "" });
          },
        );
      });
      return;
    case "stt.reset":
      stt.use(() => streams.get(m.id)?.reset());
      return;
    case "stt.dispose":
      stt.use(() => {
        streams.get(m.id)?.dispose();
        streams.delete(m.id);
      });
      return;
    case "tts.synth":
      synths.set(m.id, new AbortController());
      tts.use((engine) => void synth(m, engine));
      return;
    case "tts.cancel":
      synths.get(m.id)?.abort();
      return;
  }
}

process.on("message", (m: ToWorker) => {
  try {
    handle(m);
  } catch (e) {
    log("warn", "speech message failed", { t: m.t, error: reason(e) });
  }
});
// The daemon went, or closed the channel: nothing is left to answer.
process.on("disconnect", () => process.exit(0));
send({ t: "hello", pid: process.pid });
