// Replies read faster or slower than the engine speaks them, at the pitch it speaks them in.
// Playing speech faster raises the voice; this drops whole periods of the voice instead, or
// repeats them to slow it, the way podcast players do (Sonic's method, after PICOLA): where
// the speech is, find how long one period of the voice lasts, cross-fade two periods into
// one, and pass the speech between those through as it is. Every engine's audio goes through
// here, so each is read at exactly the speed picked. The engines' own speed settings were
// measured and not used: Piper's 2x is 1.4x, Kokoro's 1.7x, and Supertonic's is unintelligible
// from 1.5x; Chatterbox has none.

import type { TtsEngine } from "./engines.ts";
import { OUT_RATE } from "./engines.ts";

/** The lowest and the highest voice a period is looked for at. */
const LOWEST_HZ = 65;
const HIGHEST_HZ = 400;

/** One reply's audio at another speed, fed as it is made: a little is held back to find the next period in. */
export class Tempo {
  readonly speed: number;
  private minPeriod: number;
  private maxPeriod: number;
  private held = new Int16Array(0);
  /** Samples to pass through before the next period is dropped or repeated. */
  private copy = 0;
  /** What rounding left over, so a long reply is still at the speed asked. */
  private owed = 0;

  constructor(rate: number, speed: number) {
    if (!(speed > 0)) throw new RangeError(`speed ${speed}`);
    this.speed = speed;
    this.minPeriod = Math.floor(rate / HIGHEST_HZ);
    this.maxPeriod = Math.ceil(rate / LOWEST_HZ);
  }

  /** The audio this chunk let through at the new speed; empty while too little is held. */
  push(pcm: Int16Array): Int16Array {
    const joined = new Int16Array(this.held.length + pcm.length);
    joined.set(this.held);
    joined.set(pcm, this.held.length);
    return this.run(joined, false);
  }

  /** The rest, at the end of the reply: its periods looked for in what is left, and the last few milliseconds as they are. */
  flush(): Int16Array {
    return this.run(this.held, true);
  }

  private run(x: Int16Array, end: boolean): Int16Array {
    const out: Int16Array[] = [];
    let pos = 0;
    for (;;) {
      if (this.copy > 0) {
        const n = Math.min(this.copy, x.length - pos);
        if (n === 0) break;
        out.push(x.subarray(pos, pos + n));
        pos += n;
        this.copy -= n;
        continue;
      }
      // Two periods are looked at; at the end, shorter ones in what is left.
      const room = x.length - pos;
      let most = this.maxPeriod;
      if (room < 2 * most) {
        if (!end || room < 2 * this.minPeriod) break;
        most = Math.floor(room / 2);
      }
      const p = this.period(x, pos, most);
      pos += this.speed > 1 ? this.drop(x, pos, p, out) : this.repeat(x, pos, p, out);
    }
    if (end) {
      out.push(x.subarray(pos));
      pos = x.length;
    }
    this.held = x.slice(pos);
    return concat(out);
  }

  /** Two periods made one, the first fading out as the next fades in: `n` samples for `p + n`. */
  private drop(x: Int16Array, pos: number, p: number, out: Int16Array[]): number {
    const s = this.speed;
    let n: number;
    if (s >= 2) n = this.round(p / (s - 1), 1);
    else {
      n = p;
      this.copy = this.round((p * (2 - s)) / (s - 1), 0);
    }
    out.push(fade(x, pos, pos + p, n));
    return p + n;
  }

  /** A period said twice, the second fading back into where the first began: `p + n` samples for `n`. */
  private repeat(x: Int16Array, pos: number, p: number, out: Int16Array[]): number {
    const s = this.speed;
    let n: number;
    if (s < 0.5) n = this.round((p * s) / (1 - s), 1);
    else {
      n = p;
      this.copy = this.round((p * (2 * s - 1)) / (1 - s), 0);
    }
    out.push(x.slice(pos, pos + p), fade(x, pos + p, pos, n));
    return n;
  }

  /** `v` in whole samples, at least `least`, what that leaves over owed to the next. */
  private round(v: number, least: number): number {
    const n = Math.max(least, Math.round(v + this.owed));
    this.owed += v - n;
    return n;
  }

  /** The period of the voice at `at`, up to `most`: the lag at which the speech differs least from itself, per sample. */
  private period(x: Int16Array, at: number, most: number): number {
    let best = most;
    let bestDiff = Infinity;
    for (let p = this.minPeriod; p <= most; p++) {
      let diff = 0;
      for (let i = 0; i < p; i++) diff += Math.abs(x[at + i]! - x[at + p + i]!);
      const d = diff / p;
      if (d < bestDiff) {
        bestDiff = d;
        best = p;
      }
    }
    return best;
  }
}

/** `n` samples going from the speech at `down` to the speech at `up`. */
function fade(x: Int16Array, down: number, up: number, n: number): Int16Array {
  const out = new Int16Array(n);
  for (let t = 0; t < n; t++) out[t] = Math.round((x[down + t]! * (n - t) + x[up + t]! * t) / n);
  return out;
}

function concat(parts: Int16Array[]): Int16Array {
  if (parts.length === 1) return parts[0]!.slice();
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Int16Array(length);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** `engine` read at `speed`: the engine itself at 1. The engine stays the voice module's to close. */
export function atSpeed(engine: TtsEngine, speed: number): TtsEngine {
  if (speed === 1) return engine;
  return {
    get name() {
      return engine.name;
    },
    get sampleRate() {
      return engine.sampleRate;
    },
    async *synth(text, opts = {}) {
      let tempo: Tempo | undefined;
      for await (const chunk of engine.synth(text, opts)) {
        tempo ??= new Tempo(engine.sampleRate || OUT_RATE, speed);
        const out = tempo.push(chunk);
        if (out.length > 0) yield out;
      }
      const rest = tempo && !opts.signal?.aborted ? tempo.flush() : undefined;
      if (rest && rest.length > 0) yield rest;
    },
    close: () => {},
  };
}
