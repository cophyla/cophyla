// The speech process, from the daemon's side. A local transcription or speech engine holds a
// hundred megabytes to most of a gigabyte once it is loaded, and a node spends nearly all its
// time with nobody speaking to it. So the engines run in a process of their own
// (`speech-worker.ts`), started when something needs one and killed the moment nothing does:
// a voice turn, from the wake word or the talk button until its reply has played or the turn
// is dropped; a reply read out; Hear it in Settings; the one load that checks an engine the
// user has just picked or installed. The voice module sees an ordinary `SttEngine` and
// `TtsEngine`: each call starts the process if it is not running and asks it to load the
// stage's engine if it has not, and what the call sends waits in the process until the engine
// is up, so what is said while it loads is still heard.
//
// A turn holds the process (`hold`): transcription loads at the word, and the speech engine
// behind it while the user is still talking, so the reply waits for no load. The process goes
// once no turn holds it and no stream or synthesis is open in it. One that dies on its own
// ends what was open in it (an empty transcript, a synthesis that failed), says so, and the
// next call starts another.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "../log.ts";
import { applyPidAffinity } from "./affinity.ts";
import type { SttEngine, SttStream, TtsEngine } from "./engines.ts";
import { OUT_RATE } from "./engines.ts";
import type { SherpaTtsEngine } from "./sherpa-tts.ts";

export type SpeechStage = "stt" | "tts";

/** The transcription engine the process loads: the catalog's engine id and its model directory. */
export interface SttSpec {
  engine: string;
  dir: string;
  threads: number;
  language?: string;
}

/** The speech engine the process loads. */
export interface TtsSpec {
  engine: SherpaTtsEngine;
  dir: string;
  threads: number;
  voice?: number;
}

export type ToWorker =
  | { t: "init"; dataDir: string; dev: boolean; nospin: string }
  | { t: "load"; stage: "stt"; spec: SttSpec }
  | { t: "load"; stage: "tts"; spec: TtsSpec }
  | { t: "stt.open"; id: number; language?: string }
  | { t: "stt.audio"; id: number; pcm: Int16Array }
  | { t: "stt.final"; id: number }
  | { t: "stt.reset"; id: number }
  | { t: "stt.dispose"; id: number }
  | { t: "tts.synth"; id: number; text: string; voice?: number }
  | { t: "tts.cancel"; id: number };

export type FromWorker =
  | { t: "hello"; pid: number }
  | { t: "loaded"; stage: SpeechStage; engine: string; ms: number; voices?: number; voice?: number }
  | { t: "failed"; stage: SpeechStage; engine: string; reason: string }
  | { t: "stt.partial"; id: number; text: string }
  | { t: "stt.text"; id: number; text: string }
  | { t: "tts.chunk"; id: number; pcm: Int16Array }
  | { t: "tts.end"; id: number; error?: string }
  | { t: "log"; level: "debug" | "info" | "warn"; msg: string; fields?: Record<string, unknown> };

/** A running speech process, as the daemon holds it. */
export interface WorkerHandle {
  readonly pid: number | undefined;
  send(m: ToWorker): void;
  kill(): void;
}

export interface WorkerEvents {
  message(m: FromWorker): void;
  exit(code: number | null): void;
  /** A line the process wrote to stderr: a native crash says why there. */
  stderr?(line: string): void;
}

export type SpawnWorker = (on: WorkerEvents) => WorkerHandle;

export const WORKER_PATH = join(import.meta.dir, "speech-worker.ts");

/** The speech process as a Bun child over IPC: this daemon's own runtime running `speech-worker.ts`. */
export const bunWorker: SpawnWorker = (on) => {
  const proc = Bun.spawn([process.execPath, "run", WORKER_PATH], {
    cwd: dirname(dirname(import.meta.dir)),
    stdio: ["ignore", "ignore", "pipe"],
    serialization: "advanced",
    windowsHide: true,
    ipc: (m) => on.message(m as FromWorker),
    onExit: (_p, code) => on.exit(code),
  });
  void (async () => {
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      rest += decoder.decode(chunk, { stream: true });
      const lines = rest.split(/\r?\n/);
      rest = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) on.stderr?.(line);
    }
  })().catch(() => {});
  return {
    pid: proc.pid,
    send: (m) => proc.send(m),
    kill: () => proc.kill(),
  };
};

export interface SpeechProcessDeps {
  /** `<home>/data`: where the process finds sherpa-onnx, and where what it learned of each engine is kept. */
  dataDir: string;
  /** A checkout developing against `[voice] models_dir`: its node_modules copy of sherpa-onnx stands in. */
  dev: boolean;
  /** The ORT session config every engine reads, written when first asked for. */
  nospin: () => string;
  log: Logger;
  /** The performance cores, to pin the process to. */
  affinity?: bigint;
  /** How the process is started; `bunWorker` unless a test gives another. */
  spawn?: SpawnWorker;
  /** A stage's engine failed to load (`reason`), or loaded (`undefined`). */
  onStage?: (stage: SpeechStage, engine: string, failure: string | undefined) => void;
}

/** What a speech engine said about itself the last time it loaded, kept so Settings can show it before the next. */
interface EngineInfo {
  voices: number;
  voice: number;
}

interface OpenSynth {
  chunk(pcm: Int16Array): void;
  end(error?: string): void;
}

/** One process: what was asked of it, and the calls still waiting on it. */
class Child {
  readonly handle: WorkerHandle;
  asked: { stt?: SttSpec; tts?: TtsSpec } = {};
  dead = false;
  killed = false;
  readonly started = performance.now();
  readonly finals = new Map<number, (text: string) => void>();
  readonly partials = new Map<number, (text: string) => void>();
  readonly synths = new Map<number, OpenSynth>();
  /** Checks waiting on a load asked of this process. */
  waiters: { stage: SpeechStage; engine: string; resolve: (failure: string | undefined) => void }[] = [];

  constructor(handle: WorkerHandle) {
    this.handle = handle;
  }

  /** A process killed, or whose channel closed before its exit was seen, is sent nothing. */
  send(m: ToWorker): void {
    if (this.dead || this.killed) return;
    try {
      this.handle.send(m);
    } catch {
      this.dead = true;
    }
  }
}

/** A copy that owns its buffer, so the structured clone does not carry the rest of a larger one. */
function own(pcm: Int16Array): Int16Array {
  return pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength ? pcm : pcm.slice();
}

const sameStt = (a: SttSpec | undefined, b: SttSpec | undefined) => a?.engine === b?.engine && a?.dir === b?.dir && a?.threads === b?.threads && a?.language === b?.language;
const sameTts = (a: TtsSpec | undefined, b: TtsSpec | undefined) => a?.engine === b?.engine && a?.dir === b?.dir && a?.threads === b?.threads;

export class SpeechProcess {
  private deps: SpeechProcessDeps;
  private log: Logger;
  private child?: Child;
  private specs: { stt?: SttSpec; tts?: TtsSpec } = {};
  /** A turn is in progress: the process stays, whatever is open. */
  private held = false;
  /** Streams not yet finished, syntheses in flight and loads being checked: each keeps the process. */
  private open = 0;
  private ids = 0;
  private info: Record<string, EngineInfo>;
  private infoPath: string;
  private closed = false;
  /** How many processes were started, for the tests and the log. */
  spawns = 0;

  constructor(deps: SpeechProcessDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.infoPath = join(deps.dataDir, "voice", "speech-engines.json");
    this.info = this.readInfo();
  }

  /** Whether a process is running now. */
  get running(): boolean {
    return this.child !== undefined;
  }

  get pid(): number | undefined {
    return this.child?.handle.pid;
  }

  /** The engine a stage uses from now on; a running process loads it in place of the one it has. */
  set(stage: "stt", spec: SttSpec | undefined): void;
  set(stage: "tts", spec: TtsSpec | undefined): void;
  set(stage: SpeechStage, spec: SttSpec | TtsSpec | undefined): void {
    if (stage === "stt") this.specs.stt = spec as SttSpec | undefined;
    else this.specs.tts = spec as TtsSpec | undefined;
    // A process that had loaded the stage swaps engines; one that had not loads it when asked.
    const child = this.child;
    if (child?.asked[stage]) this.want(child, stage);
  }

  /** A turn began (`true`) or every turn is over (`false`); a turn preloads the speech engine for its reply. */
  hold(busy: boolean): void {
    if (this.closed) return;
    this.held = busy;
    if (busy) {
      if (this.specs.tts) this.ensure("tts");
    } else this.maybeStop();
  }

  /** Loads a stage's engine once, in the running process or in one started for it, to see that it does: the reason when it does not. */
  async probe(stage: SpeechStage): Promise<string | undefined> {
    const spec = this.specs[stage];
    if (!spec) return "no engine to load";
    this.open++;
    try {
      const child = this.child ?? this.spawn();
      const done = new Promise<string | undefined>((resolve) => child.waiters.push({ stage, engine: spec.engine, resolve }));
      // Asked of this process before: asked again, so the answer is this load's.
      if (!this.want(child, stage)) this.ask(child, stage);
      return await done;
    } finally {
      this.open--;
      this.maybeStop();
    }
  }

  /** The recogniser the voice module holds: a stream starts the process and loads the engine. */
  sttEngine(): SttEngine {
    return {
      stream: (opts) => this.openStream(opts?.language),
      close: () => {},
    };
  }

  /** The speech engine the voice module holds, named after the engine it runs. */
  ttsEngine(spec: TtsSpec): TtsEngine {
    let chosen = spec.voice;
    const known = () => this.info[spec.engine];
    const clamp = (v: number) => {
      const n = known()?.voices;
      return n === undefined ? v : Math.max(0, Math.min(n - 1, v));
    };
    return {
      name: spec.engine,
      sampleRate: OUT_RATE,
      get voices() {
        return known()?.voices;
      },
      get voice() {
        const v = chosen ?? known()?.voice;
        return v === undefined ? undefined : clamp(v);
      },
      useVoice: (voice) => {
        chosen = voice;
      },
      synth: (text, opts = {}) => this.synthesize(text, chosen, opts.signal),
      close: () => {},
    };
  }

  /** Ends the process now, whatever is open in it. */
  async close(): Promise<void> {
    this.closed = true;
    this.held = false;
    this.stop();
  }

  // --- the process ---------------------------------------------------------------------------

  private readInfo(): Record<string, EngineInfo> {
    try {
      return existsSync(this.infoPath) ? (JSON.parse(readFileSync(this.infoPath, "utf8")) as Record<string, EngineInfo>) : {};
    } catch {
      return {};
    }
  }

  private writeInfo(): void {
    try {
      mkdirSync(dirname(this.infoPath), { recursive: true });
      writeFileSync(this.infoPath, JSON.stringify(this.info, null, 2) + "\n");
    } catch (e) {
      this.log.debug("speech engine info not written", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** The running process, started if there is none, with the stage's engine asked of it. */
  private ensure(stage: SpeechStage): Child {
    const child = this.child ?? this.spawn();
    this.want(child, stage);
    return child;
  }

  /** Asks the process for the stage's engine unless it was already asked for that one: true when it asked now. */
  private want(child: Child, stage: SpeechStage): boolean {
    const same = stage === "stt" ? sameStt(child.asked.stt, this.specs.stt) : sameTts(child.asked.tts, this.specs.tts);
    if (!this.specs[stage] || same) return false;
    this.ask(child, stage);
    return true;
  }

  private ask(child: Child, stage: SpeechStage): void {
    if (stage === "stt") {
      const spec = this.specs.stt;
      if (!spec) return;
      child.asked.stt = spec;
      child.send({ t: "load", stage: "stt", spec });
    } else {
      const spec = this.specs.tts;
      if (!spec) return;
      child.asked.tts = spec;
      child.send({ t: "load", stage: "tts", spec });
    }
  }

  private spawn(): Child {
    const spawn = this.deps.spawn ?? bunWorker;
    this.spawns++;
    let child!: Child;
    const handle = spawn({
      message: (m) => this.onMessage(child, m),
      exit: (code) => this.onExit(child, code),
      stderr: (line) => this.log.debug("speech process stderr", { line: line.slice(0, 400) }),
    });
    child = new Child(handle);
    this.child = child;
    if (this.deps.affinity !== undefined && handle.pid !== undefined) applyPidAffinity(handle.pid, this.deps.affinity);
    child.send({ t: "init", dataDir: this.deps.dataDir, dev: this.deps.dev, nospin: this.deps.nospin() });
    this.log.info("speech process started", { pid: handle.pid });
    return child;
  }

  private onMessage(child: Child, m: FromWorker): void {
    switch (m.t) {
      case "hello":
        this.log.debug("speech process up", { pid: m.pid, ms: Math.round(performance.now() - child.started) });
        return;
      case "loaded": {
        this.log.info("speech engine loaded", { stage: m.stage, engine: m.engine, ms: m.ms, sinceStart: Math.round(performance.now() - child.started) });
        if (m.stage === "tts" && m.voices !== undefined) {
          const before = this.info[m.engine];
          const info = { voices: m.voices, voice: m.voice ?? 0 };
          if (before?.voices !== info.voices || before.voice !== info.voice) {
            this.info[m.engine] = info;
            this.writeInfo();
          }
        }
        this.settle(child, m.stage, m.engine, undefined);
        return;
      }
      case "failed":
        this.log.warn("speech engine did not load", { stage: m.stage, engine: m.engine, reason: m.reason });
        this.settle(child, m.stage, m.engine, m.reason);
        return;
      case "stt.partial":
        child.partials.get(m.id)?.(m.text);
        return;
      case "stt.text": {
        const done = child.finals.get(m.id);
        child.finals.delete(m.id);
        done?.(m.text);
        return;
      }
      case "tts.chunk":
        child.synths.get(m.id)?.chunk(m.pcm);
        return;
      case "tts.end": {
        const s = child.synths.get(m.id);
        child.synths.delete(m.id);
        s?.end(m.error);
        return;
      }
      case "log":
        this.log[m.level](m.msg, m.fields);
        return;
    }
  }

  private settle(child: Child, stage: SpeechStage, engine: string, failure: string | undefined): void {
    const settled = child.waiters.filter((w) => w.stage === stage && w.engine === engine);
    child.waiters = child.waiters.filter((w) => !settled.includes(w));
    for (const w of settled) w.resolve(failure);
    this.deps.onStage?.(stage, engine, failure);
  }

  private onExit(child: Child, code: number | null): void {
    child.dead = true;
    if (this.child === child) this.child = undefined;
    const ms = Math.round(performance.now() - child.started);
    if (child.killed) this.log.info("speech process ended", { pid: child.handle.pid, ms });
    else this.log.warn("speech process ended by itself", { pid: child.handle.pid, code, ms });
    for (const done of child.finals.values()) done("");
    child.finals.clear();
    child.partials.clear();
    for (const s of child.synths.values()) s.end("the speech process ended");
    child.synths.clear();
    // Its engines failed with it: each stage it held says so, and the next turn tries again.
    if (!child.killed) {
      for (const stage of ["stt", "tts"] as const) {
        const spec = child.asked[stage];
        if (spec) this.settle(child, stage, spec.engine, `the speech process ended${code !== null ? ` (${code})` : ""}`);
      }
    }
    for (const w of child.waiters.splice(0)) w.resolve("the speech process was stopped");
  }

  private maybeStop(): void {
    if (!this.held && this.open === 0) this.stop();
  }

  private stop(): void {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    child.killed = true;
    child.handle.kill();
  }

  // --- the calls -----------------------------------------------------------------------------

  private openStream(language: string | undefined): SttStream {
    const child = this.ensure("stt");
    const id = ++this.ids;
    child.send({ t: "stt.open", id, ...(language ? { language } : {}) });
    let active = true;
    this.open++;
    const finish = () => {
      if (!active) return;
      active = false;
      this.open--;
      this.maybeStop();
    };
    const stream: SttStream = {
      accept: (pcm) => {
        if (child.dead) return;
        if (!active) {
          active = true;
          this.open++;
        }
        child.send({ t: "stt.audio", id, pcm: own(pcm) });
      },
      final: async () => {
        if (child.dead) {
          finish();
          return "";
        }
        const text = await new Promise<string>((resolve) => {
          child.finals.set(id, resolve);
          child.send({ t: "stt.final", id });
        });
        finish();
        return text;
      },
      reset: () => child.send({ t: "stt.reset", id }),
      dispose: () => {
        child.partials.delete(id);
        child.finals.get(id)?.("");
        child.finals.delete(id);
        child.send({ t: "stt.dispose", id });
        finish();
      },
    };
    child.partials.set(id, (text) => stream.onPartial?.(text));
    return stream;
  }

  private synthesize(text: string, voice: number | undefined, signal: AbortSignal | undefined): AsyncIterable<Int16Array> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const child = self.ensure("tts");
        const id = ++self.ids;
        self.open++;
        const queue: Int16Array[] = [];
        let done = false;
        let error: string | undefined;
        let wake: (() => void) | undefined;
        const notify = () => {
          const w = wake;
          wake = undefined;
          w?.();
        };
        child.synths.set(id, {
          chunk: (pcm) => {
            queue.push(pcm);
            notify();
          },
          end: (e) => {
            done = true;
            error = e;
            notify();
          },
        });
        const onAbort = () => {
          child.send({ t: "tts.cancel", id });
          notify();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        child.send({ t: "tts.synth", id, text, ...(voice !== undefined ? { voice } : {}) });
        try {
          for (;;) {
            while (queue.length > 0) yield queue.shift()!;
            if (done || signal?.aborted) break;
            await new Promise<void>((r) => (wake = r));
          }
          if (error && !signal?.aborted) throw new Error(error);
        } finally {
          signal?.removeEventListener("abort", onAbort);
          if (!done) {
            child.synths.delete(id);
            child.send({ t: "tts.cancel", id });
          }
          self.open--;
          self.maybeStop();
        }
      },
    };
  }
}
