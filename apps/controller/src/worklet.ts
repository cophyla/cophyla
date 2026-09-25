// The capture worklet: the microphone at whatever rate the audio context runs, resampled to
// 16 kHz and posted to the page as 40 ms int16 frames. It runs on the audio thread, so it
// does as little as possible and never allocates per sample.

import { Chunker } from "./chunk.ts";

declare const sampleRate: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare const AudioWorkletProcessor: {
  new (): { port: { postMessage(message: unknown, transfer?: unknown[]): void } };
};

class Capture extends AudioWorkletProcessor {
  private chunker = new Chunker(sampleRate);

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const frame of this.chunker.push(channel)) {
      // Transferred, not copied: the page turns it straight into base64.
      this.port.postMessage(frame.buffer, [frame.buffer]);
    }
    return true;
  }
}

registerProcessor("capture", Capture);
