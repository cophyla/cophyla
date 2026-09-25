// Capture worklet: takes the microphone at whatever rate the context runs, resamples to 16 kHz if
// needed, converts to int16 and posts 40 ms (640-sample) chunks to the page, which sends them.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000; // input samples per output sample
    this.acc = [];
    this.pos = 0; // fractional read position into the accumulated input
    this.out = new Int16Array(640);
    this.n = 0;
    this.frames = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    this.frames++;
    if (this.ratio === 1) {
      for (let i = 0; i < ch.length; i++) this.push(ch[i]);
    } else {
      // Linear interpolation; good enough for a spike, and cheap.
      const buf = this.carry ? concat(this.carry, ch) : ch;
      let p = this.pos;
      while (p + 1 < buf.length) {
        const i = p | 0, f = p - i;
        this.push(buf[i] * (1 - f) + buf[i + 1] * f);
        p += this.ratio;
      }
      const keep = p | 0;
      this.carry = buf.subarray(keep);
      this.pos = p - keep;
    }
    return true;
  }
  push(v) {
    const s = Math.max(-1, Math.min(1, v));
    this.out[this.n++] = s < 0 ? s * 32768 : s * 32767;
    if (this.n === this.out.length) {
      this.port.postMessage(this.out.buffer.slice(0));
      this.n = 0;
    }
  }
}
function concat(a, b) { const o = new Float32Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }
registerProcessor('capture', Capture);
