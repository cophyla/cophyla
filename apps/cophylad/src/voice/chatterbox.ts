// Text to speech on the GPU: Chatterbox Turbo in the `tts-py` sidecar, behind an
// OpenAI-shaped speech endpoint on loopback. The sidecar streams raw PCM one sentence at a
// time, so the first audio leaves in about a second while the rest is still being
// synthesised. Nothing here loads a model: the sidecar owns the weights, and this is the
// client. The stage is unavailable until the sidecar says it is ready.

import type { TtsEngine } from "./engines.ts";
import { OUT_RATE } from "./engines.ts";
import type { Sidecar } from "../sidecars/index.ts";

export interface ChatterboxOptions {
  fetch?: typeof fetch;
  sampleRate?: number;
}

class Chatterbox implements TtsEngine {
  readonly name = "chatterbox";
  sampleRate: number;
  private sidecar: Sidecar;
  private doFetch: typeof fetch;

  constructor(sidecar: Sidecar, opts: ChatterboxOptions = {}) {
    this.sidecar = sidecar;
    this.doFetch = opts.fetch ?? fetch;
    this.sampleRate = opts.sampleRate ?? OUT_RATE;
  }

  synth(text: string, opts: { signal?: AbortSignal } = {}): AsyncIterable<Int16Array> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const state = self.sidecar.state().status;
        if (state !== "ready") throw new Error(`the speech sidecar is ${state}`);
        const res = await self.doFetch(`${self.sidecar.url}/v1/audio/speech`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: text, response_format: "pcm" }),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        if (!res.ok || !res.body) throw new Error(`the speech sidecar answered ${res.status}`);
        const rate = Number(res.headers.get("x-sample-rate"));
        if (Number.isFinite(rate) && rate > 0) self.sampleRate = rate;
        const reader = res.body.getReader();
        // A slice may split a sample: the odd byte waits for the next one.
        let odd: Uint8Array | undefined;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          let bytes: Uint8Array = value;
          if (odd) {
            const joined = new Uint8Array(odd.length + value.byteLength);
            joined.set(odd);
            joined.set(value, odd.length);
            bytes = joined;
            odd = undefined;
          }
          const usable = bytes.byteLength - (bytes.byteLength % 2);
          if (usable < bytes.byteLength) odd = bytes.subarray(usable);
          if (usable === 0) continue;
          // The stream is not aligned to the buffer's start, so it is copied rather than viewed.
          const pcm = new Int16Array(usable / 2);
          const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
          for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(i * 2, true);
          yield pcm;
        }
      },
    };
  }

  close(): void {
    // The sidecar's life is the `Sidecars` module's, not one engine's.
  }
}

export function chatterboxEngine(sidecar: Sidecar, opts: ChatterboxOptions = {}): TtsEngine {
  return new Chatterbox(sidecar, opts);
}
