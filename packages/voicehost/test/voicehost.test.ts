// Voice on the client's side over fakes: the audio frames cut from a microphone at any rate,
// the PCM on the wire, the jitter buffer's hold, target and played report, the frames shed on
// a backed-up link, the Opus fallback, the wake word's bookkeeping, frame ring and detector,
// which way each frame goes, and which microphone the host listens on. No browser: the timers, the audio context and the worker are
// all injected.

import { describe, expect, test } from "bun:test";
import { Chunker, FRAME, toInt16 } from "../src/chunk.ts";
import { decodeChunk, encodeChunk, toFloat } from "../src/pcm.ts";
import { PlaybackQueue, TARGET_LAN_MS, TARGET_RELAY_MS, TARGET_UP_MS } from "../src/audio.ts";
import type { PlayStats, Timers } from "../src/audio.ts";
import { listMics, micMisplaced, micWords, resolveMic } from "../src/mics.ts";
import { detectCodecs, SpeechDecoder } from "../src/opus.ts";
import { SHED_BYTES, Uplink } from "../src/uplink.ts";
import { BUNDLED_FILES, BUNDLED_HEADS } from "../src/wake/bundled.ts";
import { route } from "../src/voicehost.ts";
import type { RouteInput } from "../src/voicehost.ts";
import { WakeDetector } from "../src/wake/detector.ts";
import type { FileCache } from "../src/wake/detector.ts";
import { FrameRing } from "../src/wake/ring.ts";
import { initialWake, PENDING_MS, reduceWake } from "../src/wake/state.ts";
import type { WorkerIn, WorkerOut } from "../src/wake/worker.ts";

describe("chunking", () => {
  test("16 kHz input passes through as whole 40 ms frames", () => {
    const chunker = new Chunker(16000);
    const frames = chunker.push(new Float32Array(1600));
    expect(frames).toHaveLength(2);
    expect(frames[0]!.length).toBe(FRAME);
    // 320 samples are left over and come out with the next push.
    expect(chunker.push(new Float32Array(320))).toHaveLength(1);
  });

  test("48 kHz input is resampled, with the carry keeping the count right across calls", () => {
    const chunker = new Chunker(48000);
    let total = 0;
    // One second of audio in 10 ms pieces: 16 kHz of output, so 25 frames of 640.
    for (let i = 0; i < 100; i++) total += chunker.push(new Float32Array(480)).length;
    expect(total).toBeGreaterThanOrEqual(24);
    expect(total).toBeLessThanOrEqual(25);
  });

  test("a sine keeps its shape through the resampler", () => {
    const chunker = new Chunker(48000);
    const input = new Float32Array(4800);
    for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 100 * i) / 48000);
    const frames = chunker.push(input);
    const all = frames.flatMap((f) => [...f]);
    const peak = Math.max(...all.map(Math.abs));
    // A 100 Hz tone at full scale stays at full scale, give or take the interpolation.
    // int16 reaches one further below zero than above it, so the peak may be 32768.
    expect(peak).toBeGreaterThan(30000);
    expect(peak).toBeLessThanOrEqual(32768);
  });

  test("samples are clamped, and drain gives back the tail", () => {
    expect(toInt16(2)).toBe(32767);
    expect(toInt16(-2)).toBe(-32768);
    expect(toInt16(0)).toBe(0);
    const chunker = new Chunker(16000);
    chunker.push(new Float32Array(100));
    expect(chunker.drain()!.length).toBe(100);
    expect(chunker.drain()).toBeUndefined();
  });
});

describe("pcm on the wire", () => {
  test("encodes and decodes the same samples, negatives included", () => {
    const pcm = new Int16Array([0, 1, -1, 32767, -32768, 1234, -4321]);
    expect([...decodeChunk(encodeChunk(pcm))]).toEqual([...pcm]);
  });

  test("a long frame does not blow the argument limit", () => {
    const pcm = new Int16Array(48000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = (i % 1000) - 500;
    expect([...decodeChunk(encodeChunk(pcm))]).toEqual([...pcm]);
  });

  test("floats come back scaled", () => {
    expect([...toFloat(new Int16Array([0, 16384, -16384]))]).toEqual([0, 0.5, -0.5]);
  });
});

describe("playback", () => {
  class FakeSource {
    buffer: { duration: number } | null = null;
    started?: number;
    stopped = false;
    onended: (() => void) | null = null;
    connect(): void {}
    start(at: number): void {
      this.started = at;
    }
    stop(): void {
      this.stopped = true;
    }
  }

  function ctx(): { ctx: AudioContext; sources: FakeSource[]; rates: number[]; tick(seconds: number): void } {
    const sources: FakeSource[] = [];
    const rates: number[] = [];
    let currentTime = 0;
    const fake = {
      get currentTime() {
        return currentTime;
      },
      createBuffer: (_channels: number, length: number, rate: number) => {
        rates.push(rate);
        return { duration: length / rate, getChannelData: () => new Float32Array(length) };
      },
      createBufferSource: () => {
        const s = new FakeSource();
        sources.push(s);
        return s;
      },
    };
    return { ctx: fake as unknown as AudioContext, sources, rates, tick: (s) => (currentTime += s) };
  }

  /** Timers the test fires by hand. */
  function timers(): Timers & { fire(): void; pending(): number } {
    const due = new Map<number, () => void>();
    let n = 0;
    return {
      setTimeout: (fn) => {
        due.set(++n, fn);
        return n;
      },
      clearTimeout: (h) => void due.delete(h as number),
      fire: () => {
        const fns = [...due.values()];
        due.clear();
        for (const fn of fns) fn();
      },
      pending: () => due.size,
    };
  }

  /** A queue on a fake context, with its played reports kept. */
  function queue(floorMs = TARGET_LAN_MS) {
    const c = ctx();
    const t = timers();
    const played: { reply: number; stats: PlayStats }[] = [];
    const q = new PlaybackQueue(c.ctx, {} as AudioNode, { floorMs, timers: t, onPlayed: (reply, stats) => played.push({ reply, stats }) });
    /** Every scheduled slice finishes playing. */
    const finish = () => {
      for (const s of c.sources) s.onended?.();
    };
    return { ...c, t, q, played, finish };
  }

  // 100 ms at 24 kHz
  const slice = () => new Int16Array(2400);

  test("on the LAN a slice past the target plays at once, and the next follows it exactly", () => {
    const { q, sources } = queue();
    q.enqueue(slice(), 24000, 1);
    q.enqueue(slice(), 24000, 1);
    expect(sources).toHaveLength(2);
    // The first is scheduled a moment ahead; the second follows its duration exactly.
    expect(sources[0]!.started).toBeCloseTo(0.02, 5);
    expect(sources[1]!.started).toBeCloseTo(0.12, 5);
    expect(q.queuedMs).toBeCloseTo(220, 0);
  });

  test("on the relay speech is held until the target is buffered, then runs end to end", () => {
    const { q, sources } = queue(TARGET_RELAY_MS);
    q.enqueue(slice(), 24000, 1);
    q.enqueue(slice(), 24000, 1);
    expect(sources).toHaveLength(0);
    expect(q.holding).toBe(true);
    q.enqueue(slice(), 24000, 1);
    expect(sources.map((s) => Number(s.started!.toFixed(5)))).toEqual([0.02, 0.12, 0.22]);
  });

  test("a short hold goes once the target's time has passed, or at the reply's end", () => {
    const a = queue(TARGET_RELAY_MS);
    a.q.enqueue(slice(), 24000, 1);
    expect(a.sources).toHaveLength(0);
    a.t.fire();
    expect(a.sources).toHaveLength(1);
    const b = queue(TARGET_RELAY_MS);
    b.q.enqueue(slice(), 24000, 1);
    b.q.end(1);
    expect(b.sources).toHaveLength(1);
    expect(b.t.pending()).toBe(0);
  });

  test("a slice late mid-reply is an underrun: held again, the target raised, and reported when the reply has played", () => {
    const { q, sources, tick, played, finish } = queue();
    q.enqueue(slice(), 24000, 1);
    tick(0.5);
    q.enqueue(slice(), 24000, 1);
    expect(q.holding).toBe(true);
    expect(q.targetMs).toBe(TARGET_LAN_MS + TARGET_UP_MS);
    q.end(1);
    expect(sources).toHaveLength(2);
    expect(sources[1]!.started).toBeCloseTo(0.52, 5);
    expect(played).toEqual([]);
    finish();
    expect(played).toEqual([{ reply: 1, stats: { underruns: 1, maxLateMs: 380, targetMs: TARGET_LAN_MS + TARGET_UP_MS, frames: 2 } }]);
  });

  test("a clean reply lowers the target, never below the floor", () => {
    const { q, tick, played, finish } = queue();
    q.enqueue(slice(), 24000, 1);
    tick(0.5);
    q.enqueue(slice(), 24000, 1);
    q.end(1);
    finish();
    tick(1);
    q.enqueue(slice(), 24000, 2);
    q.enqueue(slice(), 24000, 2);
    q.end(2);
    finish();
    expect(played.at(-1)).toMatchObject({ reply: 2, stats: { underruns: 0, targetMs: TARGET_LAN_MS + TARGET_UP_MS - 20 } });
    for (let r = 3; r < 20; r++) {
      tick(1);
      q.enqueue(slice(), 24000, r);
      q.end(r);
      finish();
    }
    expect(q.targetMs).toBe(TARGET_LAN_MS);
  });

  test("a reply is played only once its end came and its last slice finished", () => {
    const { q, played, sources } = queue();
    q.enqueue(slice(), 24000, 4);
    sources[0]!.onended?.();
    expect(played).toEqual([]);
    q.enqueue(slice(), 24000, 4);
    q.end(4);
    expect(played).toEqual([]);
    sources[1]!.onended?.();
    expect(played.map((p) => p.reply)).toEqual([4]);
  });

  test("the node's rate is honoured", () => {
    const { q, sources, rates } = queue();
    q.enqueue(new Int16Array(4800), 48000, 1);
    q.enqueue(new Float32Array(4800), 48000, 1);
    expect(rates).toEqual([48000, 48000]);
    expect(sources[1]!.started).toBeCloseTo(0.12, 5);
  });

  test("a new reply while the last still plays follows it with no hold", () => {
    const { q, sources } = queue(TARGET_RELAY_MS);
    for (let i = 0; i < 3; i++) q.enqueue(slice(), 24000, 1);
    q.end(1);
    q.enqueue(slice(), 24000, 2);
    expect(sources).toHaveLength(4);
    expect(sources[3]!.started).toBeCloseTo(0.32, 5);
  });

  test("flush stops everything scheduled and held, and reports nothing", () => {
    const { q, sources, played, t } = queue();
    q.enqueue(slice(), 24000, 1);
    q.enqueue(slice(), 24000, 1);
    q.end(1);
    q.setFloor(TARGET_RELAY_MS);
    q.enqueue(slice(), 24000, 2);
    q.flush();
    expect(sources.every((s) => s.stopped)).toBe(true);
    expect(q.queuedMs).toBe(0);
    expect(q.holding).toBe(false);
    expect(t.pending()).toBe(0);
    for (const s of sources) s.onended?.();
    expect(played).toEqual([]);
  });

  test("muted, nothing is scheduled, and the reply still reports it played", () => {
    const { q, sources, played } = queue();
    q.muted = true;
    q.enqueue(slice(), 24000, 1);
    q.end(1);
    expect(sources).toHaveLength(0);
    expect(played.map((p) => p.reply)).toEqual([1]);
  });

  test("a node that does not number its replies is played and never reported", () => {
    const { q, sources, played, finish } = queue();
    q.enqueue(slice());
    q.enqueue(slice());
    finish();
    expect(sources).toHaveLength(2);
    expect(played).toEqual([]);
  });
});

describe("the microphone's frames up", () => {
  test("each frame is numbered, and one is shed rather than queued when the link holds too much", () => {
    let backlog = 0;
    const sent: { chunk: string; codec: string; seq: number }[] = [];
    const up = new Uplink({ backlog: () => backlog, send: (p) => sent.push(p) });
    expect(up.frame("a", "opus")).toBe(true);
    backlog = SHED_BYTES + 1;
    expect(up.frame("b", "opus")).toBe(false);
    backlog = SHED_BYTES;
    expect(up.frame("c", "pcm")).toBe(true);
    // the shed frame keeps its number, so the node sees the gap
    expect(sent).toEqual([
      { chunk: "a", codec: "opus", seq: 0 },
      { chunk: "c", codec: "pcm", seq: 2 },
    ]);
    expect(up.counts).toEqual({ sent: 2, shed: 1, opus: 1, pcm: 1 });
  });

  test("without WebCodecs the phone speaks PCM alone", async () => {
    expect(typeof (globalThis as { AudioEncoder?: unknown }).AudioEncoder).toBe("undefined");
    expect(await detectCodecs()).toEqual(["pcm"]);
  });
});

describe("the speech decoder", () => {
  /** WebCodecs' decoder as far as the phone uses it: one output per packet, later, whose rate reads 0 once closed. */
  class FakeAudioDecoder {
    state = "unconfigured";
    private output: (d: unknown) => void;
    constructor(init: { output: (d: unknown) => void }) {
      this.output = init.output;
    }
    configure(): void {
      this.state = "configured";
    }
    decode(chunk: { data: Uint8Array }): void {
      const frames = chunk.data[0]! * 10;
      setTimeout(() => {
        let closed = false;
        this.output({
          numberOfFrames: frames,
          get sampleRate() {
            return closed ? 0 : 48000;
          },
          copyTo: (dst: Float32Array) => dst.fill(0.5),
          close: () => (closed = true),
        });
      }, 1);
    }
    close(): void {
      this.state = "closed";
    }
  }
  class FakeChunk {
    data: Uint8Array;
    constructor(init: { data: Uint8Array }) {
      this.data = init.data;
    }
  }

  test("frames come out whole, in order, at the rate the decoder gave, and an empty end frame waits its turn", async () => {
    const g = globalThis as Record<string, unknown>;
    g["AudioDecoder"] = FakeAudioDecoder;
    g["EncodedAudioChunk"] = FakeChunk;
    try {
      const { packPackets } = await import("@cophyla/protocol/audio");
      const b64 = (packets: number[]) => btoa(String.fromCharCode(...packPackets(packets.map((p) => new Uint8Array([p])))));
      const dec = new SpeechDecoder();
      const order: string[] = [];
      const a = dec.decode(b64([2, 3]), 24000).then((d) => (order.push("a"), d));
      const b = dec.decode(b64([4]), 24000).then((d) => (order.push("b"), d));
      const end = dec.decode("", 24000).then((d) => (order.push("end"), d));
      const [da, db, de] = await Promise.all([a, b, end]);
      expect(order).toEqual(["a", "b", "end"]);
      expect(da.samples.length).toBe(50);
      expect(da.rate).toBe(48000);
      expect(db.samples.length).toBe(40);
      expect(de.samples.length).toBe(0);
      dec.close();
    } finally {
      delete g["AudioDecoder"];
      delete g["EncodedAudioChunk"];
    }
  });
});

// --- what the page shows -------------------------------------------------------------------------

describe("the wake word's bookkeeping", () => {
  const phone = reduceWake(initialWake(), { type: "answer", mode: "phone" });

  test("the node detects until it says otherwise, and its answer is kept across a reconnect", () => {
    expect(initialWake()).toEqual({ mode: "node", pending: false });
    expect(phone).toEqual({ mode: "phone", pending: false });
    expect(reduceWake(phone, { type: "disconnected" }).mode).toBe("phone");
    expect(reduceWake(phone, { type: "answer", mode: "off" }).mode).toBe("off");
  });

  test("a word heard is pending until the node says listening", () => {
    const heard = reduceWake(phone, { type: "heard", at: 1000 });
    expect(heard).toMatchObject({ mode: "phone", pending: true });
    expect(reduceWake(heard, { type: "voice", state: "speaking" }).pending).toBe(true);
    expect(reduceWake(heard, { type: "voice", state: "listening" })).toEqual({ mode: "phone", pending: false });
  });

  test("or for three seconds, when the node never does", () => {
    const heard = reduceWake(phone, { type: "heard", at: 1000 });
    expect(reduceWake(heard, { type: "tick", at: 1000 + PENDING_MS - 1 }).pending).toBe(true);
    expect(reduceWake(heard, { type: "tick", at: 1000 + PENDING_MS }).pending).toBe(false);
  });

  test("a refused wake settles it, and a node that does not know the request detects the word itself", () => {
    const heard = reduceWake(phone, { type: "heard", at: 1000 });
    expect(reduceWake(heard, { type: "refused", code: "unavailable" })).toEqual({ mode: "phone", pending: false });
    expect(reduceWake(heard, { type: "refused", code: "unsupported" })).toEqual({ mode: "node", pending: false });
  });

  test("a disconnect, the background and a failed detector each settle it", () => {
    const heard = reduceWake(phone, { type: "heard", at: 1000 });
    expect(reduceWake(heard, { type: "disconnected" })).toEqual({ mode: "phone", pending: false });
    expect(reduceWake(heard, { type: "background" })).toEqual({ mode: "phone", pending: false });
    expect(reduceWake(heard, { type: "failed" })).toEqual({ mode: "node", pending: false });
  });

  test("a word heard while the node detects is not the phone's", () => {
    expect(reduceWake(initialWake(), { type: "heard", at: 1000 })).toEqual({ mode: "node", pending: false });
  });
});

describe("where the microphone's frames go", () => {
  const base: RouteInput = { connected: true, audioReady: true, talking: false, pending: false, listening: false, wake: "phone" };

  test("the button held sends them up, until the node refused or ended the press it holds", () => {
    expect(route({ ...base, talking: true }).streaming).toBe(true);
    expect(route({ ...base, talking: true, talkRefused: true }).streaming).toBe(false);
    // The node listening to this client still hears it, whatever the button says.
    expect(route({ ...base, talking: true, talkRefused: true, voice: "listening" }).streaming).toBe(true);
    // A node that detects the word still gets the stream it listens to.
    expect(route({ ...base, talking: true, talkRefused: true, listening: true, wake: "node" }).streaming).toBe(true);
    // Held, the host's own word stays off.
    expect(route({ ...base, talking: true, talkRefused: true, listening: true }).detecting).toBe(false);
  });
});

describe("the frame ring", () => {
  test("holds the last few frames and gives back those after a number, oldest first", () => {
    const ring = new FrameRing(3);
    for (let seq = 1; seq <= 5; seq++) ring.push(seq, new Int16Array([seq]));
    expect(ring.after(3).map((f) => f.seq)).toEqual([4, 5]);
    // Only the last three are kept.
    expect(ring.after(0).map((f) => f.seq)).toEqual([3, 4, 5]);
    expect(ring.after(5)).toEqual([]);
    expect(ring.after(4)[0]!.pcm[0]).toBe(5);
    ring.clear();
    expect(ring.after(0)).toEqual([]);
  });
});

/** A worker that answers `init` as the real one does, and keeps what it was sent. */
class FakeWorker {
  sent: { msg: WorkerIn; transfer: unknown[] }[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  terminated = false;
  private answer: WorkerOut;
  constructor(answer: WorkerOut = { type: "ready" }) {
    this.answer = answer;
  }
  postMessage(msg: WorkerIn, transfer: unknown[] = []): void {
    this.sent.push({ msg, transfer });
    if (msg.type === "init") queueMicrotask(() => this.emit(this.answer));
  }
  emit(msg: WorkerOut): void {
    this.onmessage?.({ data: msg } as MessageEvent);
  }
  terminate(): void {
    this.terminated = true;
  }
}

class MapCache implements FileCache {
  map = new Map<string, ArrayBuffer>();
  async get(key: string) {
    return this.map.get(key);
  }
  async put(key: string, bytes: ArrayBuffer) {
    this.map.set(key, bytes);
  }
  async keep(keys: string[]) {
    for (const k of [...this.map.keys()]) if (!keys.includes(k)) this.map.delete(k);
  }
}

describe("the wake detector", () => {
  const detector = (opts: { worker?: FakeWorker; cache?: FileCache; verify?: boolean; fetched?: string[]; onWake?: (s: number, seq: number, head: string) => void; onError?: (r: string) => void } = {}) => {
    const worker = opts.worker ?? new FakeWorker();
    const d = new WakeDetector({
      ...(opts.cache ? { cache: opts.cache } : {}),
      ...(opts.verify ? { verify: true } : {}),
      onWake: opts.onWake ?? (() => {}),
      onError: opts.onError ?? (() => {}),
      worker: () => worker as unknown as Worker,
      fetch: async (url) => {
        opts.fetched?.push(url);
        return new Response(new Uint8Array([1, 2, 3]));
      },
    });
    return { d, worker };
  };

  test("fetches the files beside the page — the wasm, the two feature models and a head per phrase — keeps them by their pins, and hands them to the worker", async () => {
    const fetched: string[] = [];
    const cache = new MapCache();
    cache.map.set("stale", new ArrayBuffer(1));
    const { d, worker } = detector({ cache, fetched });
    await d.load();
    expect(d.state).toBe("ready");
    expect(fetched).toEqual(BUNDLED_FILES.map((f) => `wake/${f.file}`));
    expect(d.heads).toEqual(BUNDLED_HEADS);
    // openWakeWord's stock heads are CC BY-NC-SA 4.0: none of them ships.
    expect(BUNDLED_HEADS).not.toContain("hey_jarvis_v0.1.onnx");
    expect(BUNDLED_HEADS).toContain("cophyla_v0.1.onnx");
    expect(BUNDLED_HEADS).toContain("hey_phyla_v0.1.onnx");
    await Bun.sleep(0);
    expect([...cache.map.keys()].sort()).toEqual(BUNDLED_FILES.map((f) => f.sha256).sort());
    const init = worker.sent[0]!;
    expect(init.msg.type).toBe("init");
    expect((init.msg as Extract<WorkerIn, { type: "init" }>).heads.map((h) => h.name)).toEqual(BUNDLED_HEADS);
    // Handed over, not copied: 20 MB is not held twice.
    expect(init.transfer).toHaveLength(BUNDLED_FILES.length);
  });

  test("a second open reads them from the cache", async () => {
    const cache = new MapCache();
    for (const f of BUNDLED_FILES) cache.map.set(f.sha256, new ArrayBuffer(4));
    const fetched: string[] = [];
    const { d } = detector({ cache, fetched });
    await d.load();
    expect(fetched).toEqual([]);
    expect(d.fromCache).toBe(BUNDLED_FILES.length);
  });

  test("a file that is not the one the build pinned is refused, and nothing is kept", async () => {
    const cache = new MapCache();
    const { d, worker } = detector({ cache, verify: true });
    await expect(d.load()).rejects.toThrow(/not the file this build was made with/);
    expect(d.state).toBe("failed");
    expect(cache.map.size).toBe(0);
    expect(worker.sent).toEqual([]);
  });

  test("a worker that cannot load the models fails the load", async () => {
    const worker = new FakeWorker({ type: "error", reason: "no wasm" });
    const { d } = detector({ worker });
    await expect(d.load()).rejects.toThrow("no wasm");
    expect(d.state).toBe("failed");
    expect(worker.terminated).toBe(true);
  });

  test("once configured it is handed copies of the frames, and passes on the word and a later failure", async () => {
    const heard: [number, number, string][] = [];
    const errors: string[] = [];
    const { d, worker } = detector({ onWake: (score, seq, head) => heard.push([score, seq, head]), onError: (r) => errors.push(r) });
    await d.load();
    const pcm = new Int16Array([1, 2, 3]);
    d.feed(1, pcm);
    // Nothing is listened to before the node said what to run.
    expect(worker.sent.map((s) => s.msg.type)).toEqual(["init"]);
    d.configure({ mode: "phone", head: "cophyla_v0.1.onnx", threshold: 0.7, scale: "int16" });
    d.feed(2, pcm);
    const frame = worker.sent.at(-1)!;
    expect(frame.msg).toMatchObject({ type: "frame", seq: 2 });
    expect((frame.msg as Extract<WorkerIn, { type: "frame" }>).pcm).not.toBe(pcm.buffer);
    expect(frame.transfer).toHaveLength(1);
    worker.emit({ type: "wake", score: 0.93, seq: 2, head: "cophyla_v0.1.onnx" });
    expect(heard).toEqual([[0.93, 2, "cophyla_v0.1.onnx"]]);
    worker.emit({ type: "error", reason: "out of memory" });
    expect(errors).toEqual(["out of memory"]);
    expect(d.state).toBe("failed");
    expect(worker.terminated).toBe(true);
  });

  test("it listens with every head the node names, each at its own threshold; a node that names one gets one", async () => {
    const { d, worker } = detector();
    await d.load();
    d.configure({
      mode: "phone",
      head: "cophyla_v0.1.onnx",
      threshold: 0.7,
      scale: "int16",
      heads: [
        { head: "cophyla_v0.1.onnx", threshold: 0.7, scale: "int16", phrase: "Cophyla" },
        { head: "hey_phyla_v0.1.onnx", threshold: 0.5, scale: "int16", phrase: "Hey Phyla" },
      ],
    });
    expect(worker.sent.at(-1)!.msg).toEqual({
      type: "configure",
      heads: [
        { head: "cophyla_v0.1.onnx", threshold: 0.7, scale: "int16" },
        { head: "hey_phyla_v0.1.onnx", threshold: 0.5, scale: "int16" },
      ],
    });
    d.configure({ mode: "phone", head: "cophyla_v0.1.onnx", threshold: 0.6, scale: "unit" });
    expect(worker.sent.at(-1)!.msg).toEqual({ type: "configure", heads: [{ head: "cophyla_v0.1.onnx", threshold: 0.6, scale: "unit" }] });
  });
});

describe("the microphone", () => {
  const lister = (devices: { deviceId: string; label: string; groupId: string; kind?: string }[]) => ({
    enumerateDevices: async () => devices.map((d) => ({ kind: "audioinput", ...d })),
  });
  const usb = { id: "usb-1", label: "Microphone (USB Advanced Audio Device)", groupId: "g-usb" };
  const brio = { id: "brio-1", label: "Microphone (Brio 101)", groupId: "g-brio" };

  test("lists the devices, reads the default from Chromium's alias of it, and lists neither alias as a device", async () => {
    const list = await listMics(
      lister([
        { deviceId: "default", label: "Default - Microphone (USB Advanced Audio Device)", groupId: "g-usb" },
        { deviceId: "communications", label: "Communications - Microphone (Brio 101)", groupId: "g-brio" },
        { deviceId: usb.id, label: usb.label, groupId: usb.groupId },
        { deviceId: brio.id, label: brio.label, groupId: brio.groupId },
        { deviceId: "speakers", label: "Speakers", groupId: "g-usb", kind: "audiooutput" },
      ]),
    );
    expect(list).toEqual({ devices: [usb, brio], defaultLabel: usb.label, defaultGroup: "g-usb" });
  });

  test("a device with no name yet (before the microphone was allowed) is still listed", async () => {
    const list = await listMics(lister([{ deviceId: "x", label: "", groupId: "g" }]));
    expect(list.devices).toEqual([{ id: "x", label: "A microphone", groupId: "g" }]);
    expect(list.defaultLabel).toBeUndefined();
  });

  test("the pick is found by its id, by its name when the id moved, and is missing when neither is connected", () => {
    const list = { devices: [usb, brio] };
    expect(resolveMic(undefined, list)).toEqual({});
    expect(resolveMic({ id: "brio-1", label: brio.label }, list)).toEqual({ id: "brio-1" });
    expect(resolveMic({ id: "brio-old", label: brio.label }, list)).toEqual({ id: "brio-1" });
    expect(resolveMic({ id: "usb-1", label: usb.label }, { devices: [brio] })).toEqual({ missing: usb.label });
  });

  test("capture moves back to the pick once it is connected, and follows the default when there is no pick", () => {
    const both = { devices: [usb, brio], defaultLabel: usb.label, defaultGroup: "g-usb" };
    // Picked the USB one, running on the Brio while it was gone: back now, so move.
    expect(micMisplaced({ id: "default", label: brio.label, groupId: "g-brio" }, { id: "usb-1", label: usb.label }, both)).toBe(true);
    expect(micMisplaced({ id: "usb-1", label: usb.label, groupId: "g-usb" }, { id: "usb-1", label: usb.label }, both)).toBe(false);
    // No pick: the default is the USB one, and capture is on the Brio.
    expect(micMisplaced({ id: "default", label: brio.label, groupId: "g-brio" }, undefined, both)).toBe(true);
    expect(micMisplaced({ id: "default", label: usb.label, groupId: "g-usb" }, undefined, both)).toBe(false);
    // The pick is still gone: stay on the default, and move only if the default moved.
    const onlyBrio = { devices: [brio], defaultLabel: brio.label, defaultGroup: "g-brio" };
    expect(micMisplaced({ id: "default", label: brio.label, groupId: "g-brio" }, { id: "usb-1", label: usb.label }, onlyBrio)).toBe(false);
    // Nothing to tell by: never a move.
    expect(micMisplaced({ label: brio.label }, undefined, { devices: [brio] })).toBe(false);
  });

  test("why the microphone could not be had is said in words", () => {
    const named = (name: string) => Object.assign(new Error("raw"), { name });
    expect(micWords(named("NotAllowedError"))).toBe("the microphone was not allowed");
    expect(micWords(named("NotFoundError"))).toBe("no microphone is connected");
    expect(micWords(named("OverconstrainedError"))).toBe("the microphone picked is not connected");
    expect(micWords(named("NotReadableError"))).toContain("could not be read");
    expect(micWords(new Error("something else"))).toBe("something else");
  });
});
