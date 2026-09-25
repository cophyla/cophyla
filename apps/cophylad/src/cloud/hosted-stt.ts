// The `server` transcription engine: the voice pipeline's `SttEngine` over the link. The
// utterance is buffered as it arrives and sent whole at `final()`, so there are no partials;
// a link that is down, or a plan without voice, makes the utterance an empty one and the
// conversation goes idle, the same as silence would.

import { RpcError } from "@cophyla/protocol";
import type { SttEngine, SttStream } from "../voice/engines.ts";
import { IN_RATE } from "../voice/engines.ts";
import type { HostedDeps } from "./hosted.ts";

/** The most audio one utterance may carry, matching the server's limit. */
export const MAX_SECONDS = 60;

export class ServerSttEngine implements SttEngine {
  private deps: HostedDeps;
  private language: string | undefined;

  constructor(deps: HostedDeps, language?: string) {
    this.deps = deps;
    this.language = language;
  }

  stream(opts: { language?: string } = {}): SttStream {
    const deps = this.deps;
    const language = opts.language ?? this.language;
    let chunks: Int16Array[] = [];
    let samples = 0;
    return {
      accept(pcm: Int16Array): void {
        if (samples >= MAX_SECONDS * IN_RATE) return;
        chunks.push(pcm);
        samples += pcm.length;
      },
      async final(): Promise<string> {
        const all = new Int16Array(Math.min(samples, MAX_SECONDS * IN_RATE));
        let o = 0;
        for (const c of chunks) {
          const take = Math.min(c.length, all.length - o);
          if (take <= 0) break;
          all.set(take === c.length ? c : c.subarray(0, take), o);
          o += take;
        }
        chunks = [];
        samples = 0;
        if (all.length === 0) return "";
        const refused = deps.allowed("voice");
        if (refused) {
          deps.log.warn("hosted transcription refused", { reason: refused.message });
          return "";
        }
        const seconds = Math.ceil(all.length / IN_RATE);
        try {
          const r = (await deps.link.request("stt.transcribe", { audio: Buffer.from(all.buffer, all.byteOffset, all.byteLength).toString("base64"), ...(language ? { language } : {}) })) as { text?: unknown };
          deps.usage.add("stt_seconds", seconds);
          return typeof r?.text === "string" ? r.text : "";
        } catch (e) {
          const err = e instanceof RpcError ? e : undefined;
          deps.log.warn("hosted transcription failed", { code: err?.code, message: e instanceof Error ? e.message : String(e) });
          return "";
        }
      },
      reset(): void {
        chunks = [];
        samples = 0;
      },
      dispose(): void {
        chunks = [];
        samples = 0;
      },
    };
  }

  close(): void {
    // nothing held: the link is the owner's
  }
}
