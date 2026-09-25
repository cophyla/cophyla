// Opus through opusscript: speech encoded in slices that are not whole packets comes back
// the same length, and close enough to what went in; the bitrate is what a phone on mobile
// data can carry; a malformed frame throws instead of decoding to noise.

import { describe, expect, test } from "bun:test";
import { OpusDecoder, OpusEncoder, opusRate, OUT_BITRATE } from "../src/voice/opus.ts";

const RATE = 24000;

function sine(n: number, rate: number, hz: number, amp = 8000): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * hz * i) / rate));
  return out;
}

/** The signal-to-noise ratio at the best alignment: Opus delays what it decodes by a few ms. */
function snrDb(ref: Int16Array, got: Int16Array, maxLag = 600): number {
  let best = -Infinity;
  for (let lag = 0; lag <= maxLag; lag++) {
    let sig = 0;
    let err = 0;
    const n = Math.min(ref.length, got.length - lag) - 2400;
    for (let i = 2400; i < n; i++) {
      const e = got[i + lag]! - ref[i]!;
      sig += ref[i]! * ref[i]!;
      err += e * e;
    }
    best = Math.max(best, 10 * Math.log10(sig / Math.max(1, err)));
  }
  return best;
}

describe("opus", () => {
  test("speech in odd slices round-trips: the same length, padded to a packet, and a clean signal", () => {
    const enc = new OpusEncoder(RATE);
    const dec = new OpusDecoder(RATE);
    const input = sine(RATE, RATE, 440);
    const decoded: Int16Array[] = [];
    let bytes = 0;
    // 4800-sample slices and an odd tail, as the conversation sends them.
    for (let off = 0; off < input.length; off += 4700) {
      const packed = enc.encode(input.subarray(off, Math.min(off + 4700, input.length)));
      bytes += packed.length;
      if (packed.length) decoded.push(dec.decode(packed));
    }
    const tail = enc.flush();
    bytes += tail.length;
    decoded.push(dec.decode(tail));
    const total = decoded.reduce((n, d) => n + d.length, 0);
    expect(total).toBe(Math.ceil(input.length / 480) * 480);
    const all = new Int16Array(total);
    let off = 0;
    for (const d of decoded) {
      all.set(d, off);
      off += d.length;
    }
    expect(snrDb(input, all)).toBeGreaterThan(10);
    // One second of speech at ~32 kbps, framing included, is a few KB rather than 48 KB of PCM.
    expect(bytes).toBeLessThan((OUT_BITRATE / 8) * 1.3);
    enc.close();
    dec.close();
  });

  test("the microphone's 40 ms frames at 16 kHz are two packets each", () => {
    const enc = new OpusEncoder(16000, 24_000);
    const dec = new OpusDecoder(16000);
    const packed = enc.encode(sine(640, 16000, 300));
    expect(dec.decode(packed).length).toBe(640);
    enc.close();
    dec.close();
  });

  test("a frame cut short throws, and a reset drops what was carried", () => {
    const enc = new OpusEncoder(RATE);
    const dec = new OpusDecoder(RATE);
    const packed = enc.encode(sine(960, RATE, 440));
    expect(() => dec.decode(packed.subarray(0, packed.length - 3))).toThrow();
    enc.encode(sine(100, RATE, 440));
    enc.reset();
    expect(enc.flush().length).toBe(0);
    enc.close();
    dec.close();
  });

  test("only the rates Opus runs at are Opus rates", () => {
    expect(opusRate(24000)).toBe(true);
    expect(opusRate(16000)).toBe(true);
    expect(opusRate(22050)).toBe(false);
  });
});
