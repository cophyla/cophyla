// What a message read out sounded like, kept: the audio an engine made for it, so a second
// listen (Listen again, or the same message from another device) plays at once and costs an
// online engine nothing more. Kept by what made it: the engine, its voice, the speed and the
// words. Only audio made whole is kept; a reading cut short is made again next time. The
// least recently heard go first past `HEARD_BYTES`.

import { createHash } from "node:crypto";
import type { TtsEngine } from "./engines.ts";

/** How much audio is kept: about ten minutes at 24 kHz. */
export const HEARD_BYTES = 32 * 1024 * 1024;

export class HeardCache {
  private entries = new Map<string, Int16Array[]>();
  private bytes = 0;
  /** How many readings came from the cache, and how many an engine made: for the tests and the log. */
  hits = 0;
  misses = 0;

  private readonly max: number;

  constructor(max = HEARD_BYTES) {
    this.max = max;
  }

  get(key: string): Int16Array[] | undefined {
    const chunks = this.entries.get(key);
    if (!chunks) return undefined;
    // heard again: the last to go
    this.entries.delete(key);
    this.entries.set(key, chunks);
    return chunks;
  }

  put(key: string, chunks: Int16Array[]): void {
    const size = chunks.reduce((n, c) => n + c.byteLength, 0);
    if (size === 0 || size > this.max) return;
    this.drop(key);
    this.entries.set(key, chunks);
    this.bytes += size;
    for (const [old] of this.entries) {
      if (this.bytes <= this.max) break;
      this.drop(old);
    }
  }

  get size(): number {
    return this.bytes;
  }

  private drop(key: string): void {
    const had = this.entries.get(key);
    if (!had) return;
    this.entries.delete(key);
    this.bytes -= had.reduce((n, c) => n + c.byteLength, 0);
  }
}

/** The key a reading is kept under: what makes it sound as it does, and its words. */
export function heardKey(engine: string, voice: number | undefined, speed: number, text: string): string {
  return `${engine}|${voice ?? ""}|${speed}|${createHash("sha256").update(text).digest("hex")}`;
}

/** `engine`, through the cache: what was made for `key` before plays from it; what it makes whole is kept. */
export function throughCache(engine: TtsEngine, key: string, cache: HeardCache): TtsEngine {
  return {
    get name() {
      return engine.name;
    },
    get sampleRate() {
      return engine.sampleRate;
    },
    async *synth(text, opts = {}) {
      const kept = cache.get(key);
      if (kept) {
        cache.hits++;
        for (const chunk of kept) {
          if (opts.signal?.aborted) return;
          yield chunk;
        }
        return;
      }
      cache.misses++;
      const made: Int16Array[] = [];
      let whole = false;
      try {
        for await (const chunk of engine.synth(text, opts)) {
          made.push(chunk.slice());
          yield chunk;
        }
        whole = opts.signal?.aborted !== true;
      } finally {
        if (whole) cache.put(key, made);
      }
    },
    // the engine is the voice module's, closed with it
    close() {},
  };
}
