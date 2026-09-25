// The controller's own modules over fakes: the credential and the code, the audio
// frames it cuts from a microphone at any rate, the PCM on the wire, what the page shows
// and which way each frame goes, the jitter buffer's hold, target and played report, the
// frames shed on a backed-up link, the Opus fallback, and the wake word's bookkeeping,
// frame ring and detector. No browser: the socket, the storage, the timers, the audio
// context and the worker are all injected.

import { describe, expect, test } from "bun:test";
import { Chunker, FRAME, toInt16 } from "../src/chunk.ts";
import { deriveChrome } from "../src/chrome.ts";
import type { ChromeInput } from "../src/chrome.ts";
import { inviteLink, inviteText } from "@cophyla/protocol";
import type { InviteBody } from "@cophyla/protocol";
import { codeFromUrl, guessName, INVITE_CLOCK_SLACK_MS, inviteLanNodes, isInviteLink, LISTEN_KEY, parseCode, parseInviteLink, parsePairLink, pkcePair, readCredential, readListen, signInUrl, STORAGE_KEY, writeCredential, writeListen } from "../src/pairing.ts";
import type { Storage } from "../src/pairing.ts";
import { decodeChunk, encodeChunk, toFloat } from "../src/pcm.ts";
import { PlaybackQueue, TARGET_LAN_MS, TARGET_RELAY_MS, TARGET_UP_MS } from "../src/audio.ts";
import type { PlayStats, Timers } from "../src/audio.ts";
import { detectCodecs, SpeechDecoder } from "../src/opus.ts";
import { SHED_BYTES, Uplink } from "../src/uplink.ts";
import { openTarget } from "../src/remote.ts";
import { BUNDLED_FILES } from "../src/wake/bundled.ts";
import { WakeDetector } from "../src/wake/detector.ts";
import type { FileCache } from "../src/wake/detector.ts";
import { FrameRing } from "../src/wake/ring.ts";
import { initialWake, PENDING_MS, reduceWake } from "../src/wake/state.ts";
import type { WorkerIn, WorkerOut } from "../src/wake/worker.ts";

// --- fakes ---------------------------------------------------------------------------------

class FakeStorage implements Storage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

// --- pairing ---------------------------------------------------------------------------------

describe("the sign-in with the account", () => {
  test("PKCE: a 43-character verifier and its S256 challenge, as RFC 7636 computes it", async () => {
    // RFC 7636, appendix B: these 32 bytes give this verifier and this challenge
    const bytes = new Uint8Array([116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121]);
    const p = await pkcePair(() => bytes);
    expect(p.verifier).toBe("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(p.challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    const fresh = await pkcePair();
    expect(fresh.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fresh.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signInUrl("https://orc.test/", p.challenge)).toBe("https://orc.test/pair?challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("the grant from cophyla://pair, and nothing from any other link", () => {
    expect(parsePairLink("cophyla://pair?grant=prg_Zk3uQ0cV8yT1mN4b")).toBe("prg_Zk3uQ0cV8yT1mN4b");
    expect(parsePairLink("cophyla://pair/?grant=prg_Zk3uQ0cV8yT1mN4b&x=1")).toBe("prg_Zk3uQ0cV8yT1mN4b");
    expect(parsePairLink("cophyla://ask/ask_1/y")).toBeUndefined();
    expect(parsePairLink("cophyla://pair?grant=")).toBeUndefined();
    expect(parsePairLink("cophyla://pair?grant=<script>")).toBeUndefined();
    expect(parsePairLink("https://evil.test/pair?grant=prg_Zk3uQ0cV8yT1mN4b")).toBeUndefined();
  });
});

describe("an invite from the desktop", () => {
  const NOW = 1_758_196_800_000;
  const body: InviteBody = {
    v: 1,
    kind: "controller",
    grant: "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC5",
    secret: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    expiresAt: NOW + 900_000,
    node: { id: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "Studio PC" },
    lan: { hosts: ["192.168.1.44", "fe80::1", "127.0.0.1"], port: 4818, spki: "q2f0y5Hk9u1m3C1vJb0pZ6oQnqQ8yWm3rX4vA1Rk2tE=" },
    relay: { url: "https://orc.test", peer: "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC6", token: "rly_x" },
  };

  test("its text and its link read back, with what a paste brings along", () => {
    expect(parseInviteLink(inviteText(body), NOW)).toEqual(body);
    expect(parseInviteLink(inviteLink(body), NOW)).toEqual(body);
    expect(parseInviteLink(`  ${inviteText(body).replace(/(.{40})/g, "$1\n")}  `, NOW)).toEqual(body);
    expect(isInviteLink(inviteLink(body))).toBe(true);
    expect(isInviteLink("cophyla://invited")).toBe(false);
    expect(isInviteLink("cophyla://pair?grant=x")).toBe(false);
  });

  test("what it cannot be used for says so", () => {
    expect(() => parseInviteLink("482913", NOW)).toThrow(/not a Cophyla invite/);
    expect(() => parseInviteLink(inviteText(body).slice(0, 40), NOW)).toThrow(/copy it again/);
    expect(() => parseInviteLink(inviteText({ ...body, kind: "node", grant: "grt_01ARZ3NDEKTSV4RRFFQ69G5FC5" }), NOW)).toThrow(/cophylad join/);
    expect(() => parseInviteLink(inviteText(body), body.expiresAt + INVITE_CLOCK_SLACK_MS)).toThrow(/run out/);
    // a phone clock a little ahead still reads it
    expect(parseInviteLink(inviteText(body), body.expiresAt + 60_000).grant).toBe(body.grant);
    const { lan: _lan, relay: _relay, ...bare } = body;
    expect(() => parseInviteLink(inviteText(bare), NOW)).toThrow(/no way/);
  });

  test("its LAN addresses, each pinned, the node's loopback left out", () => {
    expect(inviteLanNodes(body)).toEqual([
      { host: "192.168.1.44", port: 4818, spki: body.lan!.spki },
      { host: "[fe80::1]", port: 4818, spki: body.lan!.spki },
    ]);
    expect(inviteLanNodes({})).toEqual([]);
  });
});

describe("the credential", () => {
  test("round-trips, and rubbish is no credential at all", () => {
    const storage = new FakeStorage();
    expect(readCredential(storage)).toBeUndefined();
    writeCredential(storage, { token: "t", controller: "ctl_1", name: "Pixel" });
    expect(readCredential(storage)).toEqual({ token: "t", controller: "ctl_1", name: "Pixel" });
    storage.map.set(STORAGE_KEY, "{not json");
    expect(readCredential(storage)).toBeUndefined();
    storage.map.set(STORAGE_KEY, JSON.stringify({ token: 1 }));
    expect(readCredential(storage)).toBeUndefined();
  });

  test("listening is on unless the user turned it off, and the off is remembered", () => {
    const storage = new FakeStorage();
    expect(readListen(storage)).toBe(true);
    writeListen(storage, false);
    expect(storage.map.get(LISTEN_KEY)).toBe("off");
    expect(readListen(storage)).toBe(false);
    writeListen(storage, true);
    expect(storage.map.has(LISTEN_KEY)).toBe(false);
    expect(readListen(storage)).toBe(true);
    // a page with no storage listens
    expect(readListen(undefined)).toBe(true);
  });

  test("a code is six digits, however the user types it", () => {
    expect(parseCode("482913")).toBe("482913");
    expect(parseCode("482 913")).toBe("482913");
    expect(parseCode("482-913")).toBe("482913");
    // A pasted code often carries spaces around it; they are the user's, not an error.
    expect(parseCode(" 482913 ")).toBe("482913");
    expect(parseCode("48291")).toBeUndefined();
    expect(parseCode("4829134")).toBeUndefined();
    expect(parseCode("abcdef")).toBeUndefined();
    expect(codeFromUrl("?code=482913")).toBe("482913");
    expect(codeFromUrl("?code=nope")).toBeUndefined();
    expect(codeFromUrl("")).toBeUndefined();
  });

  test("the name guessed from a user agent is one a person would recognise", () => {
    expect(guessName("Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A) AppleWebKit")).toBe("Pixel 8");
    expect(guessName("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("iPhone");
    expect(guessName("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows PC");
    expect(guessName("")).toBe("a browser");
  });
});

// --- audio ------------------------------------------------------------------------------------

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

describe("chrome", () => {
  const base: ChromeInput = { link: "connected", paired: true, audioReady: true, sttReady: true, listening: false, wake: "node", pending: false, talking: false, muted: false };

  test("the three screens follow the credential and the start gesture", () => {
    expect(deriveChrome({ ...base, paired: false }).screen).toBe("pair");
    expect(deriveChrome({ ...base, audioReady: false }).screen).toBe("gate");
    expect(deriveChrome(base).screen).toBe("main");
  });

  test("the app starts on its own: no gate while it does, the gate once it failed", () => {
    expect(deriveChrome({ ...base, audioReady: false, autoStart: true })).toMatchObject({ screen: "main", status: "starting the microphone…", pttEnabled: false, streaming: false });
    expect(deriveChrome({ ...base, audioReady: false, autoStart: false })).toMatchObject({ screen: "gate", status: "tap to start" });
    expect(deriveChrome({ ...base, audioReady: false, autoStart: true, paired: false }).screen).toBe("pair");
  });

  test("which way frames go, across where the word is detected, the button, a word just heard and the node's state", () => {
    const problems: string[] = [];
    const check = (what: string, got: boolean, want: boolean, input: object) => {
      if (got !== want) problems.push(`${what} is ${got} for ${JSON.stringify(input)}`);
    };
    for (const wake of ["phone", "node", "off"] as const) {
      for (const voice of [undefined, "idle", "listening", "transcribing", "thinking", "speaking"] as const) {
        for (const talking of [false, true]) {
          for (const pending of [false, true]) {
            for (const listening of [false, true]) {
              const input: ChromeInput = { ...base, wake, talking, pending, listening, ...(voice ? { voice } : {}) };
              const c = deriveChrome(input);
              // Whenever the node listens to this phone, audio goes up; with the node detecting, the toggle alone sends it.
              check("streaming", c.streaming, talking || voice === "listening" || pending || (listening && wake === "node"), input);
              // The phone's word runs in phone mode with the toggle on, outside an utterance and the button — through a reply too.
              check("detecting", c.detecting, wake === "phone" && listening && !talking && !pending && voice !== "listening" && voice !== "transcribing", input);
              check("awakeLock", c.awakeLock, talking || voice === "listening" || (listening && wake !== "off"), input);
              check("both ways", c.streaming && c.detecting, false, input);
              // Offline, or before the microphone, nothing at all.
              for (const gone of [{ link: "disconnected" as const }, { audioReady: false }]) {
                const o = deriveChrome({ ...input, ...gone });
                check("anything offline", o.streaming || o.detecting || o.awakeLock, false, { ...input, ...gone });
              }
            }
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test("a remote desktop on the screen: nothing goes up, nothing listens, whatever the node or the button says", () => {
    for (const wake of ["node", "phone"] as const) {
      const input: ChromeInput = { ...base, listening: true, wake, watching: true };
      expect(deriveChrome(input)).toMatchObject({ streaming: false, detecting: false, awakeLock: false });
      expect(deriveChrome({ ...input, voice: "listening", talking: true, pending: true })).toMatchObject({ streaming: false, detecting: false });
      expect(deriveChrome({ ...input, watching: false }).awakeLock).toBe(true);
    }
  });

  test("in phone mode nothing goes up until the word is heard, and then everything until the utterance ends", () => {
    const phone: ChromeInput = { ...base, listening: true, wake: "phone" };
    expect(deriveChrome(phone)).toMatchObject({ streaming: false, detecting: true, awakeLock: true, status: "listening for the wake word" });
    // Heard: frames go up before the node has said a word, and the phone stops listening for another.
    expect(deriveChrome({ ...phone, pending: true })).toMatchObject({ streaming: true, detecting: false });
    expect(deriveChrome({ ...phone, voice: "listening" })).toMatchObject({ streaming: true, detecting: false });
    expect(deriveChrome({ ...phone, voice: "transcribing" })).toMatchObject({ streaming: false, detecting: false });
    // A word over the reply interrupts it.
    expect(deriveChrome({ ...phone, voice: "speaking" })).toMatchObject({ streaming: false, detecting: true });
    // The toggle off stops the word, not an utterance already under way.
    expect(deriveChrome({ ...phone, listening: false })).toMatchObject({ streaming: false, detecting: false, awakeLock: false });
    expect(deriveChrome({ ...phone, listening: false, voice: "listening" })).toMatchObject({ streaming: true, awakeLock: true });
  });

  test("with the node detecting, the phone streams while it listens, as it always did", () => {
    expect(deriveChrome({ ...base, listening: true })).toMatchObject({ streaming: true, detecting: false, awakeLock: true });
    expect(deriveChrome({ ...base, talking: true })).toMatchObject({ streaming: true, detecting: false });
  });

  test("with the wake word off on the node, only the button sends audio, and the status says why", () => {
    const off: ChromeInput = { ...base, listening: true, wake: "off" };
    expect(deriveChrome(off)).toMatchObject({ streaming: false, detecting: false, awakeLock: false, status: "ready — the wake word is off on the node" });
    expect(deriveChrome({ ...off, talking: true })).toMatchObject({ streaming: true, awakeLock: true });
  });

  test("the controls are live only when the node can hear", () => {
    expect(deriveChrome(base).pttEnabled).toBe(true);
    expect(deriveChrome({ ...base, sttReady: false }).pttEnabled).toBe(false);
    expect(deriveChrome({ ...base, sttReady: false }).status).toContain("cannot transcribe");
    expect(deriveChrome({ ...base, link: "connecting" }).pttEnabled).toBe(false);
  });

  test("the dot and the words follow the conversation", () => {
    expect(deriveChrome({ ...base, voice: "listening" })).toMatchObject({ dot: "listening", voiceWord: "listening", status: "listening" });
    expect(deriveChrome({ ...base, voice: "thinking" }).dot).toBe("thinking");
    expect(deriveChrome({ ...base, voice: "speaking" }).dot).toBe("speaking");
    expect(deriveChrome({ ...base, voice: "idle" })).toMatchObject({ dot: "idle", voiceWord: "", status: "ready" });
    expect(deriveChrome({ ...base, link: "disconnected", error: "gone" })).toMatchObject({ dot: "offline", status: "offline — gone" });
  });

  test("the talk button says Hold to talk when it is live, else what it waits on or what the conversation is doing", () => {
    expect(deriveChrome(base).pttLabel).toBe("Hold to talk");
    expect(deriveChrome({ ...base, talking: true }).pttLabel).toBe("listening");
    expect(deriveChrome({ ...base, voice: "thinking" }).pttLabel).toBe("thinking");
    expect(deriveChrome({ ...base, voice: "speaking", via: "relay" }).pttLabel).toBe("speaking");
    expect(deriveChrome({ ...base, sttReady: false }).pttLabel).toBe("cannot transcribe");
    expect(deriveChrome({ ...base, audioReady: false, autoStart: true }).pttLabel).toBe("starting…");
    expect(deriveChrome({ ...base, link: "connecting" }).pttLabel).toBe("connecting…");
    expect(deriveChrome({ ...base, link: "disconnected", error: "gone" }).pttLabel).toBe("offline");
    expect(deriveChrome({ ...base, link: "unauthorized" }).pttLabel).toBe("refused");
  });

  test("an overlay is what the status line shows when there is one", () => {
    expect(deriveChrome({ ...base, overlay: "allow the microphone" }).overlay).toBe("allow the microphone");
  });
});

describe("host.open", () => {
  const origin = "https://192.168.1.44:4818";

  test("a stream page on this origin goes over the view; another page to a window; an invite to its app", () => {
    expect(openTarget(`${origin}/remote/?t=abc`, origin)).toEqual({ kind: "frame", url: `${origin}/remote/?t=abc` });
    expect(openTarget("https://example.com/help", origin)).toEqual({ kind: "window", url: "https://example.com/help" });
    expect(openTarget("https://192.168.1.44:4819/remote/?t=abc", origin).kind).toBe("window");
    expect(openTarget("art://192.168.1.44:47989?pin=1234&passphrase=x&name=study", origin)).toEqual({ kind: "app", url: "art://192.168.1.44:47989?pin=1234&passphrase=x&name=study" });
  });

  test("anything else is refused before it can reach a navigation", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "file:///C:/Windows", "blob:https://x/1", "not a url", 42, undefined, `${origin}/`, `${origin}/view/abc/index.html`]) {
      expect(() => openTarget(bad, origin)).toThrow();
    }
  });
});

// --- the wake word on the phone ------------------------------------------------------------------

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
  const detector = (opts: { worker?: FakeWorker; cache?: FileCache; verify?: boolean; fetched?: string[]; onWake?: (s: number, seq: number) => void; onError?: (r: string) => void } = {}) => {
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

  test("fetches the four files beside the page, keeps them by their pins, and hands them to the worker", async () => {
    const fetched: string[] = [];
    const cache = new MapCache();
    cache.map.set("stale", new ArrayBuffer(1));
    const { d, worker } = detector({ cache, fetched });
    await d.load();
    expect(d.state).toBe("ready");
    expect(fetched).toEqual(BUNDLED_FILES.map((f) => `wake/${f.file}`));
    expect(d.heads).toEqual(["hey_jarvis_v0.1.onnx"]);
    await Bun.sleep(0);
    expect([...cache.map.keys()].sort()).toEqual(BUNDLED_FILES.map((f) => f.sha256).sort());
    const init = worker.sent[0]!;
    expect(init.msg.type).toBe("init");
    expect((init.msg as Extract<WorkerIn, { type: "init" }>).heads.map((h) => h.name)).toEqual(["hey_jarvis_v0.1.onnx"]);
    // Handed over, not copied: 18 MB is not held twice.
    expect(init.transfer).toHaveLength(4);
  });

  test("a second open reads them from the cache", async () => {
    const cache = new MapCache();
    for (const f of BUNDLED_FILES) cache.map.set(f.sha256, new ArrayBuffer(4));
    const fetched: string[] = [];
    const { d } = detector({ cache, fetched });
    await d.load();
    expect(fetched).toEqual([]);
    expect(d.fromCache).toBe(4);
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
    const heard: [number, number][] = [];
    const errors: string[] = [];
    const { d, worker } = detector({ onWake: (score, seq) => heard.push([score, seq]), onError: (r) => errors.push(r) });
    await d.load();
    const pcm = new Int16Array([1, 2, 3]);
    d.feed(1, pcm);
    // Nothing is listened to before the node said what to run.
    expect(worker.sent.map((s) => s.msg.type)).toEqual(["init"]);
    d.configure({ mode: "phone", head: "hey_jarvis_v0.1.onnx", threshold: 0.7, scale: "int16" });
    d.feed(2, pcm);
    const frame = worker.sent.at(-1)!;
    expect(frame.msg).toMatchObject({ type: "frame", seq: 2 });
    expect((frame.msg as Extract<WorkerIn, { type: "frame" }>).pcm).not.toBe(pcm.buffer);
    expect(frame.transfer).toHaveLength(1);
    worker.emit({ type: "wake", score: 0.93, seq: 2 });
    expect(heard).toEqual([[0.93, 2]]);
    worker.emit({ type: "error", reason: "out of memory" });
    expect(errors).toEqual(["out of memory"]);
    expect(d.state).toBe("failed");
    expect(worker.terminated).toBe(true);
  });
});
