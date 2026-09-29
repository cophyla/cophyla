// Live transcription (`gemini-live`): the words of an utterance while it is said, over the
// same routes as the rest of the online engines (`[providers] stt`: the account's server,
// then the user's own key). Each utterance keeps all of its audio, however it goes, and opens
// a live session only once the VAD hears speech in it (`heard`), so a tap or a false accept
// costs nothing; the audio from `LEAD_IN_SECONDS` before the speech was heard until the
// session was ready is sent first, a second at a time (a button held in silence first is not
// sent, nor billed), then the rest as it comes, a few frames at a time.
//
// The routes are tried in order until one hears. A refusal before it does passes to the next
// the way the model's routing passes a call on (the account's server may also refuse a plan
// the node still thinks it has); when none hears, the utterance is sent whole once it ends,
// as the `gemini` engine sends it. A session that fails under the utterance (a send that does
// not go, a link backed up past `MAX_BUFFERED`, the route closing) is not replaced by another
// route mid-sentence: the words shown so far stay, and the utterance is sent whole at its end.
// A route that stops hearing on its own (the account's allowance ran out) ends the utterance
// with what it heard.
//
// At the end, a session still opening gets `OPEN_WAIT_MS` more; one that is streaming sends
// the rest and waits `END_WAIT_MS` for the last words, and the words so far stand when they do
// not come in time. When more than `MAX_UNSENT_SECONDS` never went, or the session never
// opened, the whole utterance goes to the batch routes instead, and the words shown stand if
// that fails too.

import { RpcError } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import type { LiveOpener, LiveResult, LiveSession, SttEngine, SttStream } from "./engines.ts";
import { FRAME, IN_RATE } from "./engines.ts";

/** At the end, how much longer a session still opening is waited for. */
export const OPEN_WAIT_MS = 3000;
/** At the end, how long the last words are waited for before the words so far stand. */
export const END_WAIT_MS = 5000;
/** Audio still unsent at the end past which the utterance goes whole instead. */
export const MAX_UNSENT_SECONDS = 10;
/** The least audio sent at once while streaming: three frames, 120 ms. */
export const SEND_MIN = 3 * FRAME;
/** The most audio sent at once: a second, while the backlog goes. */
export const PIECE_MAX = IN_RATE;
/** Bytes queued toward the route past which the session is failing. */
export const MAX_BUFFERED = 256 * 1024;
/** Audio from before the VAD heard speech that the session still hears: the start of soft speech. */
export const LEAD_IN_SECONDS = 2;

/** The codes that hand an opening session to the next route, as in the model's routing. */
const PASS_ON = new Set(["unavailable", "quota_exceeded", "timeout"]);

export interface LiveSttDeps {
  /** `[providers] stt`, as it is now. */
  routes: () => string[];
  /** The opener of a route that transcribes live; none for one that does not. */
  opener: (route: string) => LiveOpener | undefined;
  /** The whole utterance over the batch routes, and the route that took it. */
  batch: (pcm: Int16Array, language: string | undefined) => Promise<{ text: string; route?: string }>;
  /** The most seconds an utterance lasts. */
  maxSeconds: number;
  language?: string;
  /** Words the recogniser should expect: names of this node's things. */
  vocabulary?: () => string[];
  log: Logger;
  /** For the tests: `OPEN_WAIT_MS` and `END_WAIT_MS` unless given. */
  openWaitMs?: number;
  endWaitMs?: number;
}

export function liveStt(deps: LiveSttDeps): SttEngine {
  return {
    maxSeconds: deps.maxSeconds,
    stream: (opts = {}) => new LiveStream(deps, opts.language ?? deps.language),
    close: () => {},
  };
}

type Phase = "waiting" | "opening" | "streaming" | "stopped" | "failed" | "done";

const asRpc = (route: string, e: unknown) => (e instanceof RpcError ? e : new RpcError("unavailable", e instanceof Error ? e.message : String(e), { provider: route }));

/** A wait at the end of an utterance: short, and kept alive, so the answer it bounds always comes. */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class LiveStream implements SttStream {
  onPartial?: (text: string) => void;
  onStop?: (why: "limit" | "quota") => void;
  how?: { route?: string; live?: boolean };
  private deps: LiveSttDeps;
  private language: string | undefined;
  private chunks: Int16Array[] = [];
  private samples = 0;
  /** The first chunk not yet sent whole, the samples of it that went, and all the samples that went. */
  private sendIdx = 0;
  private sendOff = 0;
  private sent = 0;
  private phase: Phase = "waiting";
  private session?: LiveSession;
  private route?: string;
  /** The most seconds the route hears, as it said when it was ready. */
  private routeMax = Infinity;
  /** Where the audio sent begins: shortly before the speech was heard. */
  private skipTo = 0;
  private finals: string[] = [];
  private interim = "";
  private shown = "";
  /** What the route said when it stopped hearing on its own. */
  private stoppedWith?: LiveResult;
  private told = false;
  /** Settles once the session is no longer opening. */
  private opened?: Promise<void>;
  private disposed = false;
  private drop!: (text: string) => void;
  private dropped: Promise<string>;

  constructor(deps: LiveSttDeps, language: string | undefined) {
    this.deps = deps;
    this.language = language;
    this.dropped = new Promise((resolve) => (this.drop = resolve));
  }

  accept(pcm: Int16Array): void {
    if (this.disposed || this.phase === "done") return;
    if (this.samples + pcm.length > (this.deps.maxSeconds + 1) * IN_RATE) return;
    this.chunks.push(pcm);
    this.samples += pcm.length;
    if (this.phase !== "streaming") return;
    this.pump(false);
    // The route hears less than the utterance may last (the account's allowance): the utterance ends where it stops.
    if (!this.told && this.routeMax < this.deps.maxSeconds && this.samples - this.skipTo >= this.routeMax * IN_RATE) {
      this.told = true;
      this.onStop?.("quota");
    }
  }

  heard(): void {
    if (this.disposed || this.phase !== "waiting") return;
    this.skipTo = Math.max(0, this.samples - LEAD_IN_SECONDS * IN_RATE);
    this.opened = this.open();
  }

  private async open(): Promise<void> {
    this.phase = "opening";
    const refusals: string[] = [];
    const vocabulary = this.deps.vocabulary?.();
    for (const route of this.deps.routes()) {
      const opener = this.deps.opener(route);
      if (!opener) {
        refusals.push(`${route}: does not transcribe live`);
        continue;
      }
      const session = opener({ ...(this.language ? { language: this.language } : {}), ...(vocabulary?.length ? { vocabulary } : {}) });
      this.session = session;
      this.route = route;
      session.onText = (text, final) => this.onText(session, text, final);
      session.onEnded = (outcome) => this.onEnded(session, outcome);
      try {
        const { maxSeconds } = await session.ready;
        if (this.session !== session || this.disposed) {
          session.abort();
          return;
        }
        this.routeMax = maxSeconds;
        this.phase = "streaming";
        this.skip(this.skipTo);
        this.deps.log.debug("live transcription open", { route, backlogMs: Math.round((this.samples / IN_RATE) * 1000), maxSeconds });
        this.pump(false);
        return;
      } catch (e) {
        session.abort();
        if (this.session !== session || this.disposed) return;
        const err = asRpc(route, e);
        refusals.push(`${route}: ${err.message}`);
        // A plan the node still thinks it has, which the server no longer grants, passes on too.
        if (!PASS_ON.has(err.code) && !(err.code === "denied" && route === "server")) break;
      }
    }
    this.session = undefined;
    this.route = undefined;
    this.phase = "failed";
    this.deps.log.info("no live transcription; the utterance goes whole at its end", { routes: refusals });
  }

  /** What is unsent goes, in pieces of at most a second; with `all`, the last frames short of `SEND_MIN` too. */
  private pump(all: boolean): void {
    const session = this.session;
    if (!session || this.phase !== "streaming") return;
    for (;;) {
      const unsent = this.samples - this.sent;
      if (unsent === 0 || (!all && unsent < SEND_MIN)) return;
      const piece = this.take(Math.min(unsent, PIECE_MAX));
      if (!session.send(piece)) return this.fail(session, "the audio could not be sent");
      const buffered = session.buffered?.() ?? 0;
      if (buffered > MAX_BUFFERED) return this.fail(session, `${buffered} bytes are waiting to go`);
    }
  }

  /** Moves past the first `n` samples unsent. */
  private skip(n: number): void {
    while (this.sent < n) {
      const c = this.chunks[this.sendIdx]!;
      const k = Math.min(c.length - this.sendOff, n - this.sent);
      this.sendOff += k;
      this.sent += k;
      if (this.sendOff === c.length) {
        this.sendIdx++;
        this.sendOff = 0;
      }
    }
  }

  private take(n: number): Int16Array {
    const out = new Int16Array(n);
    let o = 0;
    while (o < n) {
      const c = this.chunks[this.sendIdx]!;
      const k = Math.min(c.length - this.sendOff, n - o);
      out.set(c.subarray(this.sendOff, this.sendOff + k), o);
      o += k;
      this.sendOff += k;
      if (this.sendOff === c.length) {
        this.sendIdx++;
        this.sendOff = 0;
      }
    }
    this.sent += n;
    return out;
  }

  /** The session failed under the utterance: the words shown stay, and the utterance goes whole at its end. */
  private fail(session: LiveSession, why: string): void {
    if (this.session !== session) return;
    session.abort();
    this.session = undefined;
    if (this.phase === "streaming") this.phase = "failed";
    this.deps.log.warn("live transcription failed under the utterance; it goes whole at its end", { route: this.route, why });
  }

  private onText(session: LiveSession, text: string, final: boolean): void {
    if (this.session !== session || this.disposed) return;
    if (final) {
      if (text.trim()) this.finals.push(text.trim());
      this.interim = "";
    } else this.interim = text.trim();
    const shown = this.display();
    if (shown === this.shown) return;
    this.shown = shown;
    this.onPartial?.(shown);
  }

  private onEnded(session: LiveSession, outcome: LiveResult | { error: RpcError }): void {
    if (this.session !== session || this.disposed) return;
    if ("error" in outcome) return this.fail(session, outcome.error.message);
    this.stoppedWith = outcome;
    this.phase = "stopped";
    this.deps.log.info("live transcription stopped by its route", { route: this.route, stopped: outcome.stopped });
    if (outcome.stopped && !this.told) {
      this.told = true;
      this.onStop?.(outcome.stopped);
    }
  }

  private display(): string {
    return [...this.finals, this.interim].filter(Boolean).join(" ");
  }

  final(): Promise<string> {
    if (this.disposed) return Promise.resolve("");
    return Promise.race([this.conclude(), this.dropped]);
  }

  private async conclude(): Promise<string> {
    if (this.phase === "opening") await Promise.race([this.opened, sleep(this.deps.openWaitMs ?? OPEN_WAIT_MS)]);
    if (this.disposed) return "";
    if (this.phase === "opening") {
      this.session?.abort();
      this.session = undefined;
      this.phase = "failed";
      this.deps.log.info("live transcription still opening at the end; the utterance goes whole", { route: this.route });
    }
    if (this.phase === "stopped") {
      this.phase = "done";
      this.how = { ...(this.route ? { route: this.route } : {}), live: true };
      return this.stoppedWith?.text || this.display();
    }
    if (this.phase === "streaming" && this.session) {
      const session = this.session;
      const unsent = (this.samples - this.sent) / IN_RATE;
      if (unsent > MAX_UNSENT_SECONDS) this.fail(session, `${unsent.toFixed(1)} s of audio never went`);
      else {
        this.pump(true);
        if (this.session === session) {
          const late = sleep(this.deps.endWaitMs ?? END_WAIT_MS).then(() => undefined);
          try {
            const r = await Promise.race([session.end(), late]);
            if (this.disposed) return "";
            this.phase = "done";
            this.how = { ...(this.route ? { route: this.route } : {}), live: true };
            if (!r) {
              session.abort();
              this.deps.log.info("the last words did not come in time; the words so far stand", { route: this.route });
              return this.display();
            }
            if (r.stopped) this.deps.log.info("live transcription stopped by its route", { route: this.route, stopped: r.stopped });
            return r.text || this.display();
          } catch (e) {
            this.fail(session, e instanceof Error ? e.message : String(e));
          }
        }
      }
    }
    return this.whole();
  }

  /** The utterance whole, over the batch routes; the words shown stand when that fails. */
  private async whole(): Promise<string> {
    this.phase = "done";
    const all = new Int16Array(this.samples);
    let o = 0;
    for (const c of this.chunks) {
      all.set(c, o);
      o += c.length;
    }
    try {
      const r = await this.deps.batch(all, this.language);
      if (this.disposed) return "";
      this.how = { route: r.route ?? "none", live: false };
      return r.text || this.display();
    } catch (e) {
      this.deps.log.warn("the utterance was not transcribed whole; the words shown stand", { error: e instanceof Error ? e.message : String(e) });
      this.how = { route: "none", live: false };
      return this.display();
    }
  }

  reset(): void {
    this.session?.abort();
    this.session = undefined;
    this.route = undefined;
    this.chunks = [];
    this.samples = 0;
    this.sendIdx = 0;
    this.sendOff = 0;
    this.sent = 0;
    this.skipTo = 0;
    this.finals = [];
    this.interim = "";
    this.shown = "";
    this.stoppedWith = undefined;
    this.told = false;
    this.phase = "waiting";
    this.drop("");
    this.dropped = new Promise((resolve) => (this.drop = resolve));
  }

  dispose(): void {
    this.disposed = true;
    this.session?.abort();
    this.session = undefined;
    this.chunks = [];
    this.samples = 0;
    this.drop("");
  }
}
