// The `server` transcription route, over the link: a piece of an utterance of at most a minute
// sent whole (`stt.transcribe`), or an utterance transcribed as it is said (`stt.stream`). A
// live one is opened when the utterance has speech in it; the server says it hears with
// `stt.ready`, naming the most seconds it will (less than the utterance may last when the
// account's allowance is nearly used), the audio goes up as `stt.audio` frames naming the
// request, and the words come back as `stt.partial` frames. `stt.end` closes it, and the
// request's result is the whole transcript. A refusal (not signed in, no plan for it, the link
// down, the allowance used up) is thrown or rejected, for the route after this one to take.

import { RpcError } from "@cophyla/protocol";
import type { RpcId, VoiceStopped } from "@cophyla/protocol";
import type { LiveOpener, LiveResult, LiveSession } from "../voice/engines.ts";
import { IN_RATE } from "../voice/engines.ts";
import type { HostedDeps } from "./hosted.ts";

/** The most audio one `stt.transcribe` may carry, the server's limit: a longer utterance goes in pieces. */
export const MAX_SECONDS = 60;
/** How long a live utterance's request may run past the most it may last: its setup and its last words. */
export const STREAM_SLACK_MS = 60_000;

const b64 = (pcm: Int16Array) => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");

export class ServerStt {
  private deps: HostedDeps;
  private language: string | undefined;
  /** The most seconds an utterance lasts on this node: the request's deadline follows it. */
  private maxSeconds: number;

  constructor(deps: HostedDeps, opts: { language?: string; maxSeconds: number }) {
    this.deps = deps;
    this.language = opts.language;
    this.maxSeconds = opts.maxSeconds;
  }

  /** One piece over the link; a refusal (not signed in, no plan for it, the link down) or a failure is thrown, for a route to pass on. */
  async transcribe(pcm: Int16Array, language?: string): Promise<string> {
    const deps = this.deps;
    const refused = deps.allowed("voice");
    if (refused) throw refused;
    if (pcm.length > MAX_SECONDS * IN_RATE) throw new RpcError("invalid", `stt.transcribe: ${Math.ceil(pcm.length / IN_RATE)} s of audio; the most is ${MAX_SECONDS} s`);
    const seconds = Math.ceil(pcm.length / IN_RATE);
    const lang = language ?? this.language;
    const r = (await deps.link.request("stt.transcribe", { audio: b64(pcm), ...(lang ? { language: lang } : {}) })) as { text?: unknown };
    deps.usage.add("stt_seconds", seconds);
    return typeof r?.text === "string" ? r.text : "";
  }

  /** One utterance transcribed as it is said. */
  readonly listen: LiveOpener = ({ language, vocabulary }): LiveSession => {
    const deps = this.deps;
    const controller = new AbortController();
    let id: RpcId | undefined;
    let ready = false;
    let ending = false;
    let aborted = false;
    let resolveReady!: (v: { maxSeconds: number }) => void;
    let rejectReady!: (e: unknown) => void;
    const readyP = new Promise<{ maxSeconds: number }>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Nobody may be waiting on `ready` once the session is aborted.
    readyP.catch(() => {});
    const session: LiveSession = {
      ready: readyP,
      send(pcm) {
        if (!ready || ending || aborted || id === undefined) return false;
        return deps.link.notify("stt.audio", { id, chunk: b64(pcm) });
      },
      end() {
        if (!ready || aborted || id === undefined) return Promise.reject(new RpcError("unavailable", "the hosted transcription is not open", { provider: "server" }));
        ending = true;
        deps.link.notify("stt.end", { id });
        return result;
      },
      buffered: () => deps.link.buffered(),
      abort() {
        if (aborted) return;
        aborted = true;
        controller.abort();
      },
    };
    const refused = deps.allowed("voice");
    const lang = language ?? this.language;
    const result: Promise<LiveResult> = refused
      ? Promise.reject(refused)
      : deps.link
          .requestCancellable("stt.stream", { ...(lang ? { language: lang } : {}), ...(vocabulary?.length ? { vocabulary } : {}) }, {
            signal: controller.signal,
            timeoutMs: this.maxSeconds * 1000 + STREAM_SLACK_MS,
            onSent: (sent) => (id = sent),
            onNotice: (method, params) => {
              const p = params as { maxSeconds?: unknown; text?: unknown; final?: unknown };
              if (method === "stt.ready" && !ready && !aborted) {
                ready = true;
                resolveReady({ maxSeconds: typeof p.maxSeconds === "number" ? p.maxSeconds : this.maxSeconds });
              } else if (method === "stt.partial" && typeof p.text === "string" && !aborted) session.onText?.(p.text, p.final === true);
            },
          })
          .then((raw) => {
            const r = raw as { text?: unknown; seconds?: unknown; stopped?: unknown };
            if (typeof r?.seconds === "number" && r.seconds > 0) deps.usage.add("stt_seconds", r.seconds);
            const out: LiveResult = { text: typeof r?.text === "string" ? r.text : "", ...(r?.stopped === "limit" || r?.stopped === "quota" ? { stopped: r.stopped as VoiceStopped } : {}) };
            // The server stopped hearing before the node said the utterance was over.
            if (ready && !ending && !aborted) session.onEnded?.(out);
            return out;
          });
    result.then(
      () => {
        if (!ready) rejectReady(new RpcError("unavailable", "the server answered before it heard anything", { provider: "server" }));
      },
      (e: unknown) => {
        if (!ready) rejectReady(e);
        else if (!ending && !aborted) session.onEnded?.({ error: e instanceof RpcError ? e : new RpcError("unavailable", e instanceof Error ? e.message : String(e), { provider: "server" }) });
      },
    );
    // `end` hands the result to its caller; a session never ended has nobody waiting on it.
    result.catch(() => {});
    return session;
  };
}
