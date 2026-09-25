// Cutting the microphone into the frames the node expects: 16 kHz mono int16, 640 samples
// (40 ms) to a frame. A phone's audio context may run at 48 kHz whatever the constraints
// asked for, so the input is resampled here with a carry across callbacks, which is what
// keeps a word from being clipped at a buffer boundary. Linear interpolation is enough: the
// recogniser's own front end is a mel filterbank at 16 kHz and hears no difference.
//
// This runs inside an AudioWorklet, so it is DOM-free and allocation-light on purpose.

export const FRAME = 640;
export const TARGET_RATE = 16000;

export function toInt16(value: number): number {
  const v = Math.max(-1, Math.min(1, value));
  return v < 0 ? v * 32768 : v * 32767;
}

export class Chunker {
  readonly ratio: number;
  private frame: Int16Array;
  private n = 0;
  private carry?: Float32Array;
  /** Fractional read position into the carried input. */
  private pos = 0;

  constructor(inputRate: number, frame = FRAME, target = TARGET_RATE) {
    this.ratio = inputRate / target;
    this.frame = new Int16Array(frame);
  }

  /** Whatever the microphone gave, as whole frames; the remainder waits for the next call. */
  push(samples: Float32Array): Int16Array[] {
    const out: Int16Array[] = [];
    const take = (v: number) => {
      this.frame[this.n++] = toInt16(v);
      if (this.n === this.frame.length) {
        out.push(this.frame.slice());
        this.n = 0;
      }
    };
    if (this.ratio === 1) {
      for (let i = 0; i < samples.length; i++) take(samples[i]!);
      return out;
    }
    const buf = this.carry && this.carry.length > 0 ? concat(this.carry, samples) : samples;
    let p = this.pos;
    while (p + 1 < buf.length) {
      const i = p | 0;
      const f = p - i;
      take(buf[i]! * (1 - f) + buf[i + 1]! * f);
      p += this.ratio;
    }
    const keep = p | 0;
    this.carry = buf.subarray(keep);
    this.pos = p - keep;
    return out;
  }

  /** The partial frame, zero-padded, for the end of a recording. */
  drain(): Int16Array | undefined {
    if (this.n === 0) return undefined;
    const out = this.frame.slice(0, this.n);
    this.n = 0;
    return out;
  }

  reset(): void {
    this.n = 0;
    this.pos = 0;
    this.carry = undefined;
  }
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
