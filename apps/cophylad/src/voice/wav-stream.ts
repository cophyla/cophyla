// A WAV body arriving in pieces, turned into int16 mono at 24 kHz as it comes: what the
// speech routes that answer with a WAV file stream back. The server's hosted speech parses
// its vendor's answer the same way (apps/server, capabilities/tts.ts); the two are kept in
// step by hand.

import { OUT_RATE } from "./engines.ts";

/** Samples per chunk handed on: 200 ms. */
export const CHUNK_SAMPLES = 4800;

interface Format {
  channels: number;
  sampleRate: number;
  bits: number;
  float: boolean;
}

/**
 * Turns the bytes of a WAV file, arriving in any pieces, into int16 frames at 24 kHz. Raw
 * PCM (no RIFF header) is taken as int16 mono at `fallbackRate`.
 */
export class WavStream {
  private buf = new Uint8Array(0);
  private headerDone = false;
  private format: Format = { channels: 1, sampleRate: OUT_RATE, bits: 16, float: false };
  private pending: number[] = [];
  /** The last source sample and the fractional read position past it, for the resampler. */
  private carry: number[] = [];
  private pos = 0;
  private fallbackRate: number;
  private out: (chunk: Int16Array) => void;

  constructor(out: (chunk: Int16Array) => void, fallbackRate = OUT_RATE) {
    this.out = out;
    this.fallbackRate = fallbackRate;
  }

  get sampleRate(): number {
    return this.format.sampleRate;
  }

  push(bytes: Uint8Array): void {
    const joined = new Uint8Array(this.buf.length + bytes.length);
    joined.set(this.buf, 0);
    joined.set(bytes, this.buf.length);
    this.buf = joined;
    if (!this.headerDone && !this.parseHeader()) return;
    this.drain(false);
  }

  end(): void {
    if (!this.headerDone) {
      // too short for a header: treat what there is as raw samples
      this.headerDone = true;
      this.format = { channels: 1, sampleRate: this.fallbackRate, bits: 16, float: false };
    }
    this.drain(true);
    if (this.pending.length > 0) {
      this.out(Int16Array.from(this.pending));
      this.pending = [];
    }
  }

  /** True once the format is known and `buf` starts at the samples. */
  private parseHeader(): boolean {
    if (this.buf.length < 12) return false;
    const tag = (o: number) => String.fromCharCode(this.buf[o]!, this.buf[o + 1]!, this.buf[o + 2]!, this.buf[o + 3]!);
    if (tag(0) !== "RIFF" || tag(8) !== "WAVE") {
      this.headerDone = true;
      this.format = { channels: 1, sampleRate: this.fallbackRate, bits: 16, float: false };
      return true;
    }
    const v = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    let o = 12;
    for (;;) {
      if (o + 8 > this.buf.length) return false;
      const id = tag(o);
      const size = v.getUint32(o + 4, true);
      if (id === "data") {
        this.buf = this.buf.slice(o + 8);
        this.headerDone = true;
        return true;
      }
      if (o + 8 + size > this.buf.length) return false;
      if (id === "fmt ") {
        const formatTag = v.getUint16(o + 8, true);
        const channels = v.getUint16(o + 10, true);
        const sampleRate = v.getUint32(o + 12, true);
        const bits = v.getUint16(o + 22, true);
        this.format = { channels: Math.max(1, channels), sampleRate: sampleRate || this.fallbackRate, bits: bits || 16, float: formatTag === 3 };
      }
      o += 8 + size + (size % 2);
    }
  }

  private drain(final: boolean): void {
    const f = this.format;
    const bytesPerSample = f.bits / 8;
    const frameBytes = bytesPerSample * f.channels;
    const frames = Math.floor(this.buf.length / frameBytes);
    if (frames === 0 && !final) return;
    const v = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    const mono: number[] = [];
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < f.channels; c++) {
        const at = i * frameBytes + c * bytesPerSample;
        let s: number;
        if (f.float && f.bits === 32) s = Math.max(-1, Math.min(1, v.getFloat32(at, true))) * 32767;
        else if (f.bits === 8) s = (v.getUint8(at) - 128) * 256;
        else if (f.bits === 24) s = ((v.getUint8(at) | (v.getUint8(at + 1) << 8) | (v.getInt8(at + 2) << 16)) << 8) >> 16;
        else if (f.bits === 32) s = v.getInt32(at, true) >> 16;
        else s = v.getInt16(at, true);
        sum += s;
      }
      mono.push(Math.round(sum / f.channels));
    }
    this.buf = this.buf.slice(frames * frameBytes);
    this.emit(mono);
  }

  /** Resamples to 24 kHz (linear) and hands on whole chunks. */
  private emit(samples: number[]): void {
    if (this.format.sampleRate === OUT_RATE) {
      for (const s of samples) this.pending.push(s);
    } else {
      const ratio = this.format.sampleRate / OUT_RATE;
      const src = this.carry.concat(samples);
      let pos = this.pos;
      while (pos + 1 < src.length) {
        const i = Math.floor(pos);
        const frac = pos - i;
        this.pending.push(Math.round(src[i]! * (1 - frac) + src[i + 1]! * frac));
        pos += ratio;
      }
      const keep = src.length - 1;
      this.carry = keep >= 0 ? [src[keep]!] : [];
      this.pos = keep >= 0 ? pos - keep : pos;
    }
    while (this.pending.length >= CHUNK_SAMPLES) {
      this.out(Int16Array.from(this.pending.slice(0, CHUNK_SAMPLES)));
      this.pending = this.pending.slice(CHUNK_SAMPLES);
    }
  }
}
