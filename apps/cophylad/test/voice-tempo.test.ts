// Replies read at another speed: as long as the speed says, at the pitch they were spoken in,
// the same however the audio arrives in chunks, and the engine itself at 1.

import { describe, expect, test } from "bun:test";
import type { TtsEngine } from "../src/voice/engines.ts";
import { atSpeed, Tempo } from "../src/voice/tempo.ts";

const RATE = 24000;

/** A voice at `hz` with a few harmonics, rising and falling in loudness like syllables. */
function voiced(seconds: number, hz: number): Int16Array {
  const out = new Int16Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const tone = Math.sin(2 * Math.PI * hz * t) + 0.5 * Math.sin(4 * Math.PI * hz * t) + 0.25 * Math.sin(6 * Math.PI * hz * t);
    const syllable = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t);
    out[i] = Math.round(tone * syllable * 9000);
  }
  return out;
}

/** The strongest period between 2.5 ms and 15 ms, by autocorrelation over the middle of the clip, in Hz. */
function pitch(pcm: Int16Array): number {
  const from = Math.floor(pcm.length / 4);
  const span = Math.floor(pcm.length / 2);
  let best = 0;
  let bestScore = -Infinity;
  for (let lag = Math.floor(RATE / 400); lag <= Math.ceil(RATE / 65); lag++) {
    let score = 0;
    for (let i = from; i < from + span; i++) score += pcm[i]! * pcm[i + lag]!;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  return RATE / best;
}

function whole(tempo: Tempo, chunks: Int16Array[]): Int16Array {
  const parts = [...chunks.map((c) => tempo.push(c)), tempo.flush()];
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function engine(chunks: Int16Array[]): TtsEngine & { closed: boolean } {
  return {
    name: "fake",
    sampleRate: RATE,
    closed: false,
    async *synth(_text, opts = {}) {
      for (const c of chunks) {
        if (opts.signal?.aborted) return;
        yield c;
      }
    },
    close() {
      this.closed = true;
    },
  };
}

describe("tempo", () => {
  for (const speed of [0.75, 1.25, 1.5, 2, 2.5, 3]) {
    test(`at ${speed}x a reply lasts 1/${speed} as long, at the same pitch`, () => {
      const input = voiced(3, 150);
      const out = whole(new Tempo(RATE, speed), [input]);
      expect(Math.abs(out.length - input.length / speed) / (input.length / speed)).toBeLessThan(0.01);
      expect(Math.abs(pitch(out) - 150) / 150).toBeLessThan(0.03);
    });
  }

  test("the audio comes out the same however it is cut into chunks", () => {
    const input = voiced(2, 210);
    const once = whole(new Tempo(RATE, 1.75), [input]);
    const cuts: Int16Array[] = [];
    for (let at = 0, n = 1; at < input.length; at += n, n = (n * 7 + 311) % 2900) cuts.push(input.subarray(at, Math.min(input.length, at + n)));
    expect(whole(new Tempo(RATE, 1.75), cuts)).toEqual(once);
  });

  test("the end of a reply is sped up too, but for the last few milliseconds", () => {
    const tail = voiced(0.02, 150);
    const tempo = new Tempo(RATE, 2);
    expect(tempo.push(tail).length).toBe(0);
    expect(tempo.flush().length).toBeLessThan(tail.length * 0.6);
    const blip = voiced(0.004, 150);
    expect(new Tempo(RATE, 2).flush()).toEqual(new Int16Array(0));
    const short = new Tempo(RATE, 2);
    short.push(blip);
    expect(short.flush()).toEqual(blip);
  });

  test("the engine itself reads at 1, and a wrapped one is left for the voice module to close", async () => {
    const e = engine([voiced(1, 150)]);
    expect(atSpeed(e, 1)).toBe(e);
    const fast = atSpeed(e, 2);
    expect(fast.name).toBe("fake");
    expect(fast.sampleRate).toBe(RATE);
    let samples = 0;
    for await (const c of fast.synth("hello")) samples += c.length;
    expect(Math.abs(samples - RATE / 2)).toBeLessThan(RATE * 0.01);
    await fast.close();
    expect(e.closed).toBe(false);
  });

  test("a barge-in stops the speech with nothing held back said after it", async () => {
    const ac = new AbortController();
    const fast = atSpeed(engine([voiced(0.5, 150), voiced(0.5, 150), voiced(0.5, 150)]), 2);
    let chunks = 0;
    for await (const _ of fast.synth("hello", { signal: ac.signal })) {
      chunks++;
      ac.abort();
    }
    expect(chunks).toBe(1);
  });
});
