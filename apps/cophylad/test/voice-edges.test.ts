// The button's edges keep their place among the frames. Under load the frames of a press are
// still queued behind a slow end-of-speech detector when its release arrives, and a talk key
// handled late sends its press and release together: the release waits behind the frames, so
// all of them are heard, and its answer comes after the states it moved. A release that names
// its last frame (`upTo`) waits for it, or a grace when it never comes, and hears nothing past
// it; a press behind a queued release waits its turn; a cancel drops what waits; and a held
// utterance's frames are never shed short of the hard cap, while frames nobody holds still are.

import { describe, expect, test } from "bun:test";
import type { VoiceState } from "@cophyla/protocol";
import { BACKLOG_MS, Conversation, HELD_BACKLOG_MS } from "../src/voice/conversation.ts";
import type { SttEngine, SttStream, VadEngine, WakeEngine } from "../src/voice/engines.ts";
import { FRAME, IN_RATE } from "../src/voice/engines.ts";
import { speechChunk } from "../src/voice/fake.ts";
import type { Logger } from "../src/log.ts";

/** Samples of silence each utterance's stream hears first. */
const PRIME = 3200;

/** A recogniser that counts what each utterance's stream heard, and answers `transcript`. */
function counting(transcript = "words") {
  const heard: number[] = [];
  const engine: SttEngine = {
    stream: (): SttStream => {
      const i = heard.push(0) - 1;
      return {
        accept: (pcm) => {
          heard[i]! += pcm.length;
        },
        final: async () => transcript,
        reset: () => {},
        dispose: () => {},
      };
    },
    close: () => {},
  };
  return { engine, heard };
}

/** An end-of-speech detector slower than the frames: each takes `ms`, and it never closes an utterance itself. */
function slowVad(ms: number): VadEngine {
  return {
    feed: async () => {
      await Bun.sleep(ms);
      return false;
    },
    heard: true,
    reset: () => {},
    close: () => {},
  };
}

/** A conversation on those, keeping its states and the lines it logged. */
function conversation(opts: { vadMs?: number; vad?: VadEngine; upToGraceMs?: number; wake?: WakeEngine; transcript?: string } = {}) {
  const stt = counting(opts.transcript);
  const seen: VoiceState[] = [];
  const finals: string[] = [];
  const lines: { message: string; fields?: Record<string, unknown> }[] = [];
  const log = {
    info: (message: string, fields?: Record<string, unknown>) => lines.push({ message, ...(fields ? { fields } : {}) }),
    debug: () => {},
    warn: (message: string, fields?: Record<string, unknown>) => lines.push({ message, ...(fields ? { fields } : {}) }),
    error: () => {},
    child: () => log,
  } as unknown as Logger;
  const vad = opts.vad ?? slowVad(opts.vadMs ?? 3);
  const c = new Conversation({
    client: "cli_edges",
    vad: () => vad,
    stt: () => stt.engine,
    ...(opts.wake ? { wake: opts.wake } : {}),
    thinkingTimeoutMs: 60_000,
    ...(opts.upToGraceMs !== undefined ? { upToGraceMs: opts.upToGraceMs } : {}),
    log,
    on: {
      state: (s) => seen.push(s),
      partial: () => {},
      final: (text) => finals.push(text),
      speaking: () => {},
      audio: () => {},
    },
  });
  return { c, seen, finals, lines, heard: stt.heard };
}

/** `n` frames of speech, numbered from `from` when numbered. */
function frames(c: Conversation, n: number, from?: number): void {
  for (let i = 0; i < n; i++) c.push(speechChunk(), from !== undefined ? from + i : undefined);
}

const until = async (ok: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
};

describe("a release behind queued frames", () => {
  test("press, frames and release in one tick: every frame is heard, and the release is answered after the states it moved", async () => {
    const { c, seen, finals, lines, heard } = conversation();
    void c.ptt(true);
    frames(c, 10);
    let answered: VoiceState[] | undefined;
    const release = c.ptt(false).then(() => (answered = [...seen]));
    // Still held while its frames are heard: nothing ended it early.
    expect(seen).toEqual(["listening"]);
    await release;
    expect(heard).toEqual([PRIME + 10 * FRAME]);
    // Answered once the release was reached: the transcript may have landed by then too.
    expect(answered?.slice(0, 2)).toEqual(["listening", "transcribing"]);
    await until(() => finals.length === 1);
    expect(seen).toEqual(["listening", "transcribing", "thinking"]);
    // The line says the release waited for all ten.
    const line = lines.find((l) => l.message === "utterance")?.fields;
    expect(line).toMatchObject({ why: "button", backfilled: 10 });
    expect(line?.["spreadMs"]).toBeGreaterThanOrEqual(0);
    c.dispose();
  });

  test("with nothing queued a release ends the utterance at once", async () => {
    const { c, seen } = conversation();
    void c.ptt(true);
    frames(c, 2);
    await until(() => seen.length === 1 && !(c as unknown as { pumping: boolean }).pumping);
    void c.ptt(false);
    expect(seen).toEqual(["listening", "transcribing"]);
    c.dispose();
  });

  test("the hold the client measured is logged, and says no audio came for a long press no frame reached", async () => {
    const { c, seen, lines } = conversation({ transcript: "" });
    await c.ptt(true, { at: 10_000 });
    await c.ptt(false, { at: 12_500 });
    await until(() => seen.at(-1) === "idle");
    const line = lines.find((l) => l.message === "utterance was empty")?.fields;
    // The node saw a press of a moment; the client held it two and a half seconds.
    expect(line).toMatchObject({ clientHeldMs: 2500, unheard: "no-audio", backfilled: 0 });
    expect(line?.["heldMs"]).toBeLessThan(1000);
    c.dispose();
  });

  test("a press behind a queued release waits its turn: two utterances, each with its own frames", async () => {
    const { c, seen, finals, heard } = conversation();
    void c.ptt(true);
    frames(c, 4);
    const first = c.ptt(false);
    const second = c.ptt(true);
    frames(c, 6);
    const last = c.ptt(false);
    await Promise.all([first, second, last]);
    await until(() => finals.length === 2);
    expect(heard).toEqual([PRIME + 4 * FRAME, PRIME + 6 * FRAME]);
    expect(seen).toEqual(["listening", "transcribing", "listening", "transcribing", "thinking"]);
    c.dispose();
  });
});

describe("a release that names its last frame", () => {
  test("waits for that frame when it has not come yet, and ends once it is heard", async () => {
    const { c, seen, heard } = conversation({ upToGraceMs: 5000 });
    void c.ptt(true);
    frames(c, 3, 0);
    let done = false;
    const release = c.ptt(false, { upTo: 5 }).then(() => (done = true));
    await Bun.sleep(60);
    expect(done).toBe(false);
    expect(seen).toEqual(["listening"]);
    frames(c, 3, 3);
    await release;
    expect(heard).toEqual([PRIME + 6 * FRAME]);
    expect(seen.slice(0, 2)).toEqual(["listening", "transcribing"]);
    c.dispose();
  });

  test("a frame numbered past it ends the press, unheard", async () => {
    const { c, heard } = conversation({ upToGraceMs: 5000 });
    void c.ptt(true);
    frames(c, 3, 0);
    const release = c.ptt(false, { upTo: 4 });
    // 3 and 4 were shed on the way; 7 is after the release.
    frames(c, 1, 7);
    await release;
    expect(heard).toEqual([PRIME + 3 * FRAME]);
    c.dispose();
  });

  test("one that never comes is given up after the grace, with what was heard", async () => {
    const { c, seen, heard } = conversation({ upToGraceMs: 80 });
    void c.ptt(true);
    frames(c, 2, 0);
    const t0 = Date.now();
    // Something keeps the loop alive beside the grace's timer, which a daemon does not wait on.
    await Promise.all([c.ptt(false, { upTo: 9 }), Bun.sleep(120)]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
    expect(heard).toEqual([PRIME + 2 * FRAME]);
    expect(seen.slice(0, 2)).toEqual(["listening", "transcribing"]);
    c.dispose();
  });

  test("one already heard ends the press at once", async () => {
    const { c, seen } = conversation();
    void c.ptt(true);
    frames(c, 3, 0);
    await until(() => !(c as unknown as { pumping: boolean }).pumping);
    void c.ptt(false, { upTo: 2 });
    expect(seen).toEqual(["listening", "transcribing"]);
    c.dispose();
  });

  test("a press while it waits ends it there, and begins the next", async () => {
    const { c, seen, heard } = conversation({ upToGraceMs: 5000 });
    void c.ptt(true);
    frames(c, 2, 0);
    await until(() => !(c as unknown as { pumping: boolean }).pumping);
    const release = c.ptt(false, { upTo: 4 });
    await c.ptt(true);
    await release;
    frames(c, 2, 5);
    await until(() => heard[1] === PRIME + 2 * FRAME);
    expect(heard[0]).toBe(PRIME + 2 * FRAME);
    expect(seen.slice(0, 3)).toEqual(["listening", "transcribing", "listening"]);
    c.dispose();
  });
});

describe("a cancel with edges waiting", () => {
  test("drops the queued frames and the release with the utterance, and answers the release", async () => {
    const { c, seen, finals, heard } = conversation({ vadMs: 10 });
    void c.ptt(true);
    frames(c, 20);
    const release = c.ptt(false);
    await Bun.sleep(25);
    expect(c.cancel()).toBe(true);
    await release;
    expect(seen).toEqual(["listening", "idle"]);
    await Bun.sleep(50);
    expect(heard[0]!).toBeLessThan(PRIME + 20 * FRAME);
    expect(finals).toEqual([]);
    expect(seen).toEqual(["listening", "idle"]);
    c.dispose();
  });

  test("drops a release still waiting for its last frame", async () => {
    const { c, seen, finals } = conversation({ upToGraceMs: 5000 });
    void c.ptt(true);
    frames(c, 2, 0);
    const release = c.ptt(false, { upTo: 8 });
    await Bun.sleep(30);
    expect(c.cancel()).toBe(true);
    await release;
    frames(c, 3, 2);
    await Bun.sleep(40);
    expect(seen).toEqual(["listening", "idle"]);
    expect(finals).toEqual([]);
    c.dispose();
  });
});

describe("the backlog", () => {
  const backlog = Math.ceil((BACKLOG_MS / 1000) * (IN_RATE / FRAME));

  test("a held utterance keeps every frame past the idle backlog", async () => {
    const { c, heard } = conversation({ vadMs: 1 });
    void c.ptt(true);
    frames(c, backlog + 30);
    await c.ptt(false);
    expect(heard).toEqual([PRIME + (backlog + 30) * FRAME]);
    c.dispose();
  });

  test("frames nobody holds are still shed past it, oldest first", async () => {
    let fed = 0;
    const wake: WakeEngine = {
      feed: async () => {
        fed++;
        await Bun.sleep(1);
        return { fired: false, score: 0 };
      },
      reset: () => {},
    };
    const { c } = conversation({ wake });
    frames(c, backlog + 30);
    await until(() => !(c as unknown as { pumping: boolean }).pumping);
    // The first was already being scored when the rest came; past the backlog, the oldest of the rest went.
    expect(fed).toBe(backlog + 1);
    c.dispose();
  });

  test("the hard cap is far past any press", () => {
    expect(HELD_BACKLOG_MS).toBeGreaterThanOrEqual(30_000);
  });
});
