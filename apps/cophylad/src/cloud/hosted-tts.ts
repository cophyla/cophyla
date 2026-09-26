// The `server` speech engine: the voice pipeline's `TtsEngine` over the link. One `tts.speak`
// per sentence; the `tts.delta` frames are yielded as they arrive, so the phone hears the
// first chunk before the server has made the last; an abort cancels the request on the server.

import { RpcError } from "@cophyla/protocol";
import type { TtsEngine } from "../voice/engines.ts";
import { OUT_RATE } from "../voice/engines.ts";
import type { HostedDeps } from "./hosted.ts";

export class ServerTtsEngine implements TtsEngine {
  readonly name = "server";
  readonly sampleRate = OUT_RATE;
  private deps: HostedDeps;
  private voiceName: string | undefined;

  constructor(deps: HostedDeps, voice?: string) {
    this.deps = deps;
    this.voiceName = voice;
  }

  async *synth(text: string, opts: { signal?: AbortSignal } = {}): AsyncIterable<Int16Array> {
    const refused = this.deps.allowed("voice");
    if (refused) throw refused;
    if (!text.trim()) return;
    const queue: Int16Array[] = [];
    let done = false;
    let failed: unknown;
    let wake: (() => void) | undefined;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const request = this.deps.link
      .requestCancellable("tts.speak", { text, ...(this.voiceName ? { voice: this.voiceName } : {}) }, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        onNotice: (method, params) => {
          if (method !== "tts.delta") return;
          const chunk = (params as { chunk?: unknown }).chunk;
          if (typeof chunk !== "string") return;
          const b = Buffer.from(chunk, "base64");
          const even = b.length - (b.length % 2);
          queue.push(new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + even)));
          notify();
        },
      })
      .then(
        () => {
          done = true;
          notify();
        },
        (e: unknown) => {
          failed = e;
          done = true;
          notify();
        },
      );
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (done) break;
      await new Promise<void>((r) => (wake = r));
    }
    await request;
    if (failed) throw failed instanceof RpcError ? failed : new RpcError("unavailable", failed instanceof Error ? failed.message : String(failed), { provider: "server" });
    this.deps.usage.add("tts_chars", text.length);
  }

  close(): void {
    // nothing held: the link is the owner's
  }
}
