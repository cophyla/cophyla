// Opus on the phone, through WebCodecs: the microphone's 40 ms frames encoded to 20 ms packets
// at ~24 kbps, and the node's speech decoded back to samples. A web view without WebCodecs,
// or one whose WebCodecs has no Opus, says `codecs: ["pcm"]` and both ways stay PCM. The
// packets ride `voice.audio` framed by `packPackets`, the node's own framing.
//
// Both sides are asynchronous. The encoder's packets are gathered and sent two at a time,
// one microphone frame's worth, with a short timer for a lone one at the end of an
// utterance. The decoder is never flushed mid-reply, which would reset it and click at
// every frame: each packet gives one output, so a frame is whole once it has as many as it
// had packets, and frames resolve in the order they came in. A frame whose outputs never
// all come is let go after a moment with what it has.

import { packPackets, unpackPackets } from "@cophyla/protocol/audio";
import type { AudioCodec } from "@cophyla/protocol";

export const MIC_RATE = 16000;
export const MIC_BITRATE = 24_000;
/** Packets per `voice.audio` frame up: one 40 ms microphone frame. */
const PACKETS_PER_FRAME = 2;
/** A lone packet waits this long for its partner before it goes up alone. */
const LONE_PACKET_MS = 60;
/** How long a frame of speech may wait for its decoded samples before it goes on without the rest. */
const DECODE_WAIT_MS = 400;

const ENCODER_CONFIG: AudioEncoderConfig = { codec: "opus", sampleRate: MIC_RATE, numberOfChannels: 1, bitrate: MIC_BITRATE, opus: { frameDuration: 20_000 } };
const decoderConfig = (rate: number): AudioDecoderConfig => ({ codec: "opus", sampleRate: rate, numberOfChannels: 1 });

/** What this web view can speak, best first: Opus when WebCodecs encodes and decodes it. */
export async function detectCodecs(): Promise<AudioCodec[]> {
  if (typeof AudioEncoder === "undefined" || typeof AudioDecoder === "undefined" || typeof AudioData === "undefined") return ["pcm"];
  try {
    const [enc, dec] = await Promise.all([AudioEncoder.isConfigSupported(ENCODER_CONFIG), AudioDecoder.isConfigSupported(decoderConfig(24000))]);
    return enc.supported && dec.supported ? ["opus", "pcm"] : ["pcm"];
  } catch {
    return ["pcm"];
  }
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function unbase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The microphone's encoder: 16 kHz int16 frames in, base64 frames of packed packets out. */
export class MicEncoder {
  private encoder: AudioEncoder;
  private onFrame: (chunk: string) => void;
  private pending: Uint8Array[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private timestamp = 0;
  private failed = false;

  constructor(onFrame: (chunk: string) => void, onError: (e: Error) => void = () => {}) {
    this.onFrame = onFrame;
    this.encoder = new AudioEncoder({
      output: (chunk) => {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        this.pending.push(bytes);
        if (this.pending.length >= PACKETS_PER_FRAME) this.send();
        else this.arm();
      },
      error: (e) => {
        this.failed = true;
        onError(e instanceof Error ? e : new Error(String(e)));
      },
    });
    this.encoder.configure(ENCODER_CONFIG);
  }

  /** Whether it still works; a failed encoder hands the frames back to PCM. */
  get ok(): boolean {
    return !this.failed && this.encoder.state === "configured";
  }

  encode(pcm: Int16Array): void {
    const data = new AudioData({ format: "s16", sampleRate: MIC_RATE, numberOfChannels: 1, numberOfFrames: pcm.length, timestamp: this.timestamp, data: new Int16Array(pcm) });
    this.timestamp += Math.round((pcm.length / MIC_RATE) * 1_000_000);
    this.encoder.encode(data);
    data.close();
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.pending.length) this.send();
    }, LONE_PACKET_MS);
  }

  private send(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const packets = this.pending;
    this.pending = [];
    this.onFrame(base64(packPackets(packets)));
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
    if (this.encoder.state !== "closed") this.encoder.close();
  }
}

/** One frame of speech decoded: its samples at the rate they came out at. */
export interface Decoded {
  samples: Float32Array;
  rate: number;
}

interface Waiting {
  expected: number;
  got: Float32Array[];
  rate: number;
  done: () => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** The speech decoder: a frame's packets in, its samples out whole, frames in order. */
export class SpeechDecoder {
  private decoder?: AudioDecoder;
  private rate = 0;
  private waiting: Waiting[] = [];
  /** The last frame handed in: the next resolves after it. */
  private last: Promise<unknown> = Promise.resolve();
  private timestamp = 0;

  private open(rate: number): AudioDecoder {
    if (this.decoder && this.rate === rate && this.decoder.state === "configured") return this.decoder;
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    // a decoder replaced mid-frame gives nothing more for the frames it had
    for (const w of this.waiting.splice(0)) this.release(w);
    const decoder = new AudioDecoder({
      output: (data) => {
        const samples = new Float32Array(data.numberOfFrames);
        data.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
        // read before the close, which zeroes it
        const rate = data.sampleRate;
        data.close();
        const head = this.waiting[0];
        if (!head) return;
        head.got.push(samples);
        if (rate > 0) head.rate = rate;
        if (head.got.length >= head.expected) this.release(this.waiting.shift()!);
      },
      error: () => {
        for (const w of this.waiting.splice(0)) this.release(w);
      },
    });
    decoder.configure(decoderConfig(rate));
    this.decoder = decoder;
    this.rate = rate;
    return decoder;
  }

  private release(w: Waiting): void {
    if (w.timer) clearTimeout(w.timer);
    w.done();
  }

  /** A frame's base64 packets at the node's rate; resolves after every frame before it. */
  decode(chunk: string, rate: number): Promise<Decoded> {
    let packets: Uint8Array[] = [];
    try {
      packets = chunk ? unpackPackets(unbase64(chunk)) : [];
    } catch {
      packets = [];
    }
    const w: Waiting = { expected: packets.length, got: [], rate, done: () => {} };
    const own = new Promise<void>((resolve) => (w.done = resolve));
    if (packets.length === 0) w.done();
    else {
      const decoder = this.open(rate);
      this.waiting.push(w);
      w.timer = setTimeout(() => {
        const i = this.waiting.indexOf(w);
        if (i >= 0) this.waiting.splice(i, 1);
        w.done();
      }, DECODE_WAIT_MS);
      for (const packet of packets) {
        decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: this.timestamp, data: packet }));
        this.timestamp += 20_000;
      }
    }
    const next = Promise.all([this.last, own]).then((): Decoded => {
      const total = w.got.reduce((n, s) => n + s.length, 0);
      const samples = new Float32Array(total);
      let off = 0;
      for (const s of w.got) {
        samples.set(s, off);
        off += s.length;
      }
      return { samples, rate: w.rate };
    });
    this.last = next;
    return next;
  }

  close(): void {
    for (const w of this.waiting.splice(0)) this.release(w);
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = undefined;
  }
}
