// The capture worklet: the microphone at whatever rate the audio context runs, resampled to
// 16 kHz and posted to the page as 40 ms int16 frames, each with the audio clock's time as the
// block that finished it ended (`t`, seconds), so the page knows when it was captured however
// late it takes it. It runs on the audio thread, so it does as little as possible and never
// allocates per sample.

import { Chunker } from "./chunk.ts";

declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare const AudioWorkletProcessor: {
  new (): { port: { postMessage(message: unknown, transfer?: unknown[]): void } };
};

/** What the worklet posts for each frame. */
export interface CapturedFrame {
  pcm: ArrayBuffer;
  t: number;
}

class Capture extends AudioWorkletProcessor {
  private chunker = new Chunker(sampleRate);

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    const t = currentTime + channel.length / sampleRate;
    for (const frame of this.chunker.push(channel)) {
      // Transferred, not copied: the page turns it straight into base64.
      const message: CapturedFrame = { pcm: frame.buffer as ArrayBuffer, t };
      this.port.postMessage(message, [frame.buffer]);
    }
    return true;
  }
}

registerProcessor("capture", Capture);
