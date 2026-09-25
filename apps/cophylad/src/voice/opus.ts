// Opus for `voice.audio`, through opusscript (libopus as WebAssembly): one encoder for the
// speech a conversation sends, one decoder for the microphone it hears. A frame on the wire
// holds several 20 ms packets, framed by `packPackets` from the protocol so the phone and
// the node read the same bytes. Speech arrives in slices that are not a whole number of
// packets long, so the encoder carries the rest over to the next slice and pads the last
// one of a reply with silence.

import OpusScript from "opusscript";
import { packPackets, unpackPackets } from "@cophyla/protocol";

/** One packet's worth of audio. */
export const OPUS_FRAME_MS = 20;
/** Speech is voice: ~32 kbps holds 24 kHz speech clean. */
export const OUT_BITRATE = 32_000;

type OpusRate = 8000 | 12000 | 16000 | 24000 | 48000;

/** Whether Opus can run at this rate at all; speech at any other rate goes as PCM. */
export function opusRate(rate: number): rate is OpusRate {
  return rate === 8000 || rate === 12000 || rate === 16000 || rate === 24000 || rate === 48000;
}

export class OpusEncoder {
  readonly rate: OpusRate;
  private enc: OpusScript;
  private frame: number;
  private carry = new Int16Array(0);

  constructor(rate: OpusRate, bitrate = OUT_BITRATE) {
    this.rate = rate;
    this.frame = (rate * OPUS_FRAME_MS) / 1000;
    this.enc = new OpusScript(rate, 1, OpusScript.Application.VOIP);
    this.enc.setBitrate(bitrate);
  }

  /** Samples in, the whole packets they make out, packed; what is left waits for the next call or `flush`. */
  encode(pcm: Int16Array): Uint8Array {
    const all = new Int16Array(this.carry.length + pcm.length);
    all.set(this.carry);
    all.set(pcm, this.carry.length);
    const packets: Uint8Array[] = [];
    let off = 0;
    for (; off + this.frame <= all.length; off += this.frame) packets.push(this.packet(all.subarray(off, off + this.frame)));
    this.carry = all.slice(off);
    return packPackets(packets);
  }

  /** The rest, padded with silence to a whole packet: the end of a reply. */
  flush(): Uint8Array {
    if (this.carry.length === 0) return new Uint8Array(0);
    const last = new Int16Array(this.frame);
    last.set(this.carry);
    this.carry = new Int16Array(0);
    return packPackets([this.packet(last)]);
  }

  /** Drops what was carried: a reply was cut. */
  reset(): void {
    this.carry = new Int16Array(0);
  }

  private packet(samples: Int16Array): Uint8Array {
    const out = this.enc.encode(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength), this.frame);
    // opusscript hands back a view of its own heap; the next call reuses it.
    return new Uint8Array(out);
  }

  close(): void {
    this.enc.delete();
  }
}

export class OpusDecoder {
  readonly rate: OpusRate;
  private dec: OpusScript;

  constructor(rate: OpusRate) {
    this.rate = rate;
    this.dec = new OpusScript(rate, 1, OpusScript.Application.VOIP);
  }

  /** A frame's packets back to samples at this decoder's rate; a malformed frame throws. */
  decode(bytes: Uint8Array): Int16Array {
    const parts: Int16Array[] = [];
    let total = 0;
    for (const packet of unpackPackets(bytes)) {
      const out = this.dec.decode(Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength));
      // Copied out of the heap, and read little-endian whatever the alignment.
      const pcm = new Int16Array(out.byteLength >> 1);
      for (let i = 0; i < pcm.length; i++) pcm[i] = out.readInt16LE(i * 2);
      parts.push(pcm);
      total += pcm.length;
    }
    const all = new Int16Array(total);
    let off = 0;
    for (const p of parts) {
      all.set(p, off);
      off += p.length;
    }
    return all;
  }

  close(): void {
    this.dec.delete();
  }
}
