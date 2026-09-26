// The speech process from the daemon's side, over a worker that lives in memory: no process
// at rest; a stream starts one and loads transcription, a turn preloads speech, and the
// process goes the moment the turn is over and nothing is open in it; a check loads an engine
// in a process of its own and ends it; a process that dies ends what was open in it and the
// next call starts another; a pick while one runs swaps the engine in place.

import { describe, expect, test } from "bun:test";
import { silentLogger } from "../src/log.ts";
import type { FromWorker, SpawnWorker, ToWorker, WorkerEvents } from "../src/voice/speech-process.ts";
import { SpeechProcess } from "../src/voice/speech-process.ts";
import { removeHome, tempHome, waitFor } from "./helpers.ts";

/** One fake process: what it was sent, and a way to make it die. */
interface FakeChild {
  sent: ToWorker[];
  killed: boolean;
  crash(code: number): void;
}

/** A worker in memory that answers as speech-worker.ts does; an engine called `broken` fails to load. */
function fakeWorker(opts: { loadMs?: number; chunks?: number } = {}): { spawn: SpawnWorker; children: FakeChild[] } {
  const children: FakeChild[] = [];
  const spawn: SpawnWorker = (on: WorkerEvents) => {
    const heard = new Map<number, number>();
    let dead = false;
    const later = (fn: () => void, ms = 0) => setTimeout(() => !dead && fn(), ms);
    const reply = (m: FromWorker) => later(() => on.message(m));
    const child: FakeChild = {
      sent: [],
      killed: false,
      crash: (code) => {
        dead = true;
        setTimeout(() => on.exit(code), 0);
      },
    };
    children.push(child);
    later(() => on.message({ t: "hello", pid: 4242 }));
    return {
      pid: 4242 + children.length,
      send: (m) => {
        child.sent.push(m);
        switch (m.t) {
          case "load":
            later(() => on.message(m.spec.engine === "broken" ? { t: "failed", stage: m.stage, engine: m.spec.engine, reason: "no such model" } : { t: "loaded", stage: m.stage, engine: m.spec.engine, ms: 5, ...(m.stage === "tts" ? { voices: 4, voice: 0 } : {}) }), opts.loadMs ?? 0);
            return;
          case "stt.open":
            heard.set(m.id, 0);
            return;
          case "stt.audio":
            heard.set(m.id, (heard.get(m.id) ?? 0) + 1);
            if (heard.get(m.id) === 2) reply({ t: "stt.partial", id: m.id, text: "hello" });
            return;
          case "stt.final":
            reply({ t: "stt.text", id: m.id, text: `heard ${heard.get(m.id) ?? 0}` });
            return;
          case "tts.synth":
            for (let i = 0; i < (opts.chunks ?? 2); i++) reply({ t: "tts.chunk", id: m.id, pcm: new Int16Array(480).fill(i + 1) });
            reply({ t: "tts.end", id: m.id });
            return;
          default:
            return;
        }
      },
      kill: () => {
        child.killed = true;
        dead = true;
        setTimeout(() => on.exit(null), 0);
      },
    };
  };
  return { spawn, children };
}

const STT = { engine: "moonshine-tiny", dir: "/models/stt", threads: 2 };
const TTS = { engine: "piper" as const, dir: "/models/tts", threads: 2 };

function make(opts: Parameters<typeof fakeWorker>[0] = {}) {
  const home = tempHome();
  const w = fakeWorker(opts);
  const stages: [string, string, string | undefined][] = [];
  const proc = new SpeechProcess({ dataDir: home, dev: true, nospin: () => "/nospin.cfg", log: silentLogger, spawn: w.spawn, onStage: (s, e, f) => stages.push([s, e, f]) });
  proc.set("stt", STT);
  proc.set("tts", TTS);
  return { proc, home, stages, ...w };
}

const loads = (c: FakeChild) => c.sent.filter((m) => m.t === "load").map((m) => (m as { stage: string; spec: { engine: string } }).stage + ":" + (m as { spec: { engine: string } }).spec.engine);

describe("the speech process", () => {
  test("nothing runs at rest; a stream starts it with transcription, and it ends when the stream does", async () => {
    const { proc, children, home } = make();
    try {
      expect(proc.running).toBe(false);
      const stt = proc.sttEngine();
      expect(children).toHaveLength(0);
      const stream = stt.stream();
      const partials: string[] = [];
      stream.onPartial = (t) => partials.push(t);
      expect(proc.running).toBe(true);
      expect(children[0]!.sent[0]).toMatchObject({ t: "init", dev: true, nospin: "/nospin.cfg" });
      expect(loads(children[0]!)).toEqual(["stt:moonshine-tiny"]);
      stream.accept(new Int16Array(640));
      stream.accept(new Int16Array(640));
      stream.accept(new Int16Array(640));
      expect(await stream.final()).toBe("heard 3");
      expect(partials).toEqual(["hello"]);
      // Nothing held it and nothing is open: gone at once.
      expect(proc.running).toBe(false);
      expect(children[0]!.killed).toBe(true);
    } finally {
      await proc.close();
      removeHome(home);
    }
  });

  test("a turn holds it and loads speech behind transcription; it goes when the turn is over", async () => {
    const { proc, children, home } = make();
    try {
      const stream = proc.sttEngine().stream();
      proc.hold(true);
      expect(loads(children[0]!)).toEqual(["stt:moonshine-tiny", "tts:piper"]);
      stream.accept(new Int16Array(640));
      expect(await stream.final()).toBe("heard 1");
      // Held: the reply is still to come.
      expect(proc.running).toBe(true);
      const tts = proc.ttsEngine(TTS);
      const chunks: Int16Array[] = [];
      for await (const c of tts.synth("It is three.")) chunks.push(c);
      expect(chunks.map((c) => c[0])).toEqual([1, 2]);
      expect(proc.running).toBe(true);
      proc.hold(false);
      expect(proc.running).toBe(false);
      expect(proc.spawns).toBe(1);
      // The speech engine said how many voices it has: kept for the next time Settings asks.
      expect(tts.voices).toBe(4);
      const again = new SpeechProcess({ dataDir: home, dev: true, nospin: () => "", log: silentLogger, spawn: fakeWorker().spawn });
      expect(again.ttsEngine(TTS).voices).toBe(4);
    } finally {
      await proc.close();
      removeHome(home);
    }
  });

  test("a synthesis in flight keeps it past the end of the turn, and it goes when the speech ends", async () => {
    const { proc, home } = make({ chunks: 3 });
    try {
      proc.hold(true);
      const it = proc.ttsEngine(TTS).synth("One. Two. Three.")[Symbol.asyncIterator]();
      expect((await it.next()).done).toBe(false);
      proc.hold(false);
      expect(proc.running).toBe(true);
      while (!(await it.next()).done) {
        // drained
      }
      expect(proc.running).toBe(false);
    } finally {
      await proc.close();
      removeHome(home);
    }
  });

  test("a synthesis cut short tells the process, and the process goes", async () => {
    const { proc, children, home } = make({ chunks: 3 });
    try {
      const ac = new AbortController();
      const got: Int16Array[] = [];
      for await (const c of proc.ttsEngine(TTS).synth("One. Two. Three.", { signal: ac.signal })) {
        got.push(c);
        ac.abort();
      }
      expect(got).toHaveLength(1);
      expect(children[0]!.sent.some((m) => m.t === "tts.cancel")).toBe(true);
      expect(proc.running).toBe(false);
    } finally {
      await proc.close();
      removeHome(home);
    }
  });

  test("a check loads the engine in a process of its own and ends it; a broken engine says why", async () => {
    const { proc, children, stages, home } = make();
    try {
      expect(await proc.probe("tts")).toBeUndefined();
      expect(loads(children[0]!)).toEqual(["tts:piper"]);
      expect(proc.running).toBe(false);
      proc.set("stt", { ...STT, engine: "broken" });
      expect(await proc.probe("stt")).toBe("no such model");
      expect(proc.running).toBe(false);
      expect(stages).toContainEqual(["stt", "broken", "no such model"]);
      // A check while a turn runs loads in the running process, again.
      proc.set("stt", STT);
      const stream = proc.sttEngine().stream();
      expect(await proc.probe("stt")).toBeUndefined();
      expect(proc.running).toBe(true);
      expect(children).toHaveLength(3);
      expect(loads(children[2]!)).toEqual(["stt:moonshine-tiny", "stt:moonshine-tiny"]);
      stream.dispose();
      expect(proc.running).toBe(false);
    } finally {
      await proc.close();
      removeHome(home);
    }
  });

  test("a pick while it runs swaps the engine in place", async () => {
    const { proc, children, home } = make();
    try {
      const stream = proc.sttEngine().stream();
      proc.set("stt", { ...STT, engine: "whisper-base" });
      expect(loads(children[0]!)).toEqual(["stt:moonshine-tiny", "stt:whisper-base"]);
      // Speech was never asked of it: a pick of another voice loads nothing yet.
      proc.set("tts", { ...TTS, engine: "kokoro" });
      expect(loads(children[0]!)).toHaveLength(2);
      stream.dispose();
    } finally {
      await proc.close();
      removeHome(home);
    }
  });

  test("a process that dies ends what was open in it, says so, and the next call starts another", async () => {
    const { proc, children, stages, home } = make({ loadMs: 50 });
    try {
      const stream = proc.sttEngine().stream();
      proc.hold(true);
      const speaking = (async () => {
        const got: Int16Array[] = [];
        for await (const c of proc.ttsEngine(TTS).synth("Hello.")) got.push(c);
        return got;
      })();
      const final = stream.final();
      children[0]!.crash(3);
      expect(await final).toBe("");
      await expect(speaking).rejects.toThrow("the speech process ended");
      await waitFor(() => !proc.running);
      expect(stages.some(([, , f]) => f?.startsWith("the speech process ended"))).toBe(true);
      const next = proc.sttEngine().stream();
      expect(proc.running).toBe(true);
      expect(children).toHaveLength(2);
      next.dispose();
      proc.hold(false);
      expect(proc.running).toBe(false);
    } finally {
      await proc.close();
      removeHome(home);
    }
  });

  test("close ends it whatever is open, and nothing starts it after", async () => {
    const { proc, home } = make();
    try {
      proc.sttEngine().stream();
      proc.hold(true);
      await proc.close();
      expect(proc.running).toBe(false);
      proc.hold(true);
      expect(proc.running).toBe(false);
    } finally {
      removeHome(home);
    }
  });
});
