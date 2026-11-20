// What a message read out sounded like, kept: by what made it, the least recently heard going
// first past the limit, and only audio made whole.

import { describe, expect, test } from "bun:test";
import type { TtsEngine } from "../src/voice/engines.ts";
import { HeardCache, heardKey, throughCache } from "../src/voice/heard.ts";

const chunk = (n: number, v = 1) => new Int16Array(n).fill(v);

/** An engine that makes one chunk per sentence and counts what it is asked. */
function counting(): TtsEngine & { asked: string[] } {
  const asked: string[] = [];
  return {
    name: "piper",
    sampleRate: 24000,
    asked,
    async *synth(text, opts = {}) {
      asked.push(text);
      for (const s of text.split(/(?<=\.)\s+/)) {
        if (opts.signal?.aborted) return;
        yield chunk(s.length);
        await Promise.resolve();
      }
    },
    close() {},
  };
}

async function all(engine: TtsEngine, text: string, signal?: AbortSignal): Promise<number> {
  let n = 0;
  for await (const c of engine.synth(text, signal ? { signal } : {})) n += c.length;
  return n;
}

describe("the audio kept of messages read out", () => {
  test("kept by engine, voice, speed and words", () => {
    expect(heardKey("piper", 0, 1, "Hi.")).toBe(heardKey("piper", 0, 1, "Hi."));
    for (const other of [heardKey("kokoro", 0, 1, "Hi."), heardKey("piper", 1, 1, "Hi."), heardKey("piper", undefined, 1, "Hi."), heardKey("piper", 0, 1.25, "Hi."), heardKey("piper", 0, 1, "Hi!")]) expect(other).not.toBe(heardKey("piper", 0, 1, "Hi."));
  });

  test("the least recently heard go first past the limit; one larger than all of it is not kept", () => {
    const cache = new HeardCache(100);
    cache.put("a", [chunk(20)]);
    cache.put("b", [chunk(20)]);
    expect(cache.size).toBe(80);
    cache.get("a");
    cache.put("c", [chunk(20)]);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.size).toBe(80);
    cache.put("huge", [chunk(51)]);
    expect(cache.get("huge")).toBeUndefined();
    expect(cache.size).toBe(80);
    // the same key again replaces what it held
    cache.put("a", [chunk(10)]);
    expect(cache.size).toBe(60);
  });

  test("through the cache: made once, then played from what was kept; a reading cut short is not kept", async () => {
    const cache = new HeardCache();
    const engine = counting();
    const text = "One. Two two. Three three three.";
    const key = heardKey(engine.name, undefined, 1, text);
    const made = await all(throughCache(engine, key, cache), text);
    expect(await all(throughCache(engine, key, cache), text)).toBe(made);
    expect(engine.asked).toEqual([text]);
    expect(cache).toMatchObject({ hits: 1, misses: 1 });

    const cut = new AbortController();
    const other = "Four. Five.";
    const otherKey = heardKey(engine.name, undefined, 1, other);
    const it = throughCache(engine, otherKey, cache).synth(other, { signal: cut.signal })[Symbol.asyncIterator]();
    await it.next();
    cut.abort();
    await it.next();
    await it.return?.(undefined);
    expect(cache.get(otherKey)).toBeUndefined();
    await all(throughCache(engine, otherKey, cache), other);
    expect(engine.asked).toEqual([text, other, other]);
  });
});
