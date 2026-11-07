// Live transcription (`gemini-live`): the words of an utterance while it is said, over the
// same routes as the rest of the online engines (`[providers] stt`: the account's server,
// then the user's own key). Each utterance keeps its audio, however it goes, and opens a live
// session only once the VAD hears speech in it (`heard`), so a tap or a false accept costs
// nothing; the audio from `LEAD_IN_SECONDS` before the speech was heard until the session was
// ready is sent first, a second at a time (a button held in silence first is not sent, nor
// billed), then the rest as it comes, a few frames at a time.
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
// A session hears about ten minutes at most (Gemini Live's time), and an utterance may last
// longer, so one nearing the most it hears hands the utterance on: `ROLL_LEAD_SECONDS` before
// then, the audio is held back for `ROLL_SEARCH_SECONDS` while its quietest moment is found,
// the session hears up to there and is ended, its words kept, and a new one opens over the
// routes in order for the rest, the audio held meanwhile going first. A session that ends at
// its time before that hands on the same way, from what it was sent. One that hears less than
// `ROLL_MIN_SECONDS` is the account's allowance ending, not the session's time: the utterance
// ends where it does. When no route opens the next, the rest goes to the batch routes at the
// end, after the words before it, and when a route refused for the allowance the utterance
// ends there too. Only the audio from where the session now hearing it began is kept.
//
// At the end, a session still opening gets `OPEN_WAIT_MS` more; one that is streaming sends
// the rest and waits `END_WAIT_MS` for the last words, and the words so far stand when they do
// not come in time. When more than `MAX_UNSENT_SECONDS` never went, or the session never
// opened, the utterance goes to the batch routes instead (after a handover, the part from it
// on), and the words shown stand if that fails too.

import { RpcError } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import type { LiveOpener, LiveResult, LiveSession, SttEngine, SttFailed, SttStream } from "./engines.ts";
import { FRAME, IN_RATE, sttFailed } from "./engines.ts";

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
/**
 * How long before the most a session hears that it hands the utterance on: room to find a
 * quiet moment, to end it, and for Gemini, which warns (`goAway`) 540 s into a session of 580.
 */
export const ROLL_LEAD_SECONDS = 80;
/** How long the audio is held back while the quietest moment to hand on at is found. */
export const ROLL_SEARCH_SECONDS = 5;
/** A session that hears less than this is the account's allowance ending, not its time: it does not hand on. */
export const ROLL_MIN_SECONDS = 120;
/** The stretch the quietest moment is measured over: 100 ms. */
const QUIET_STEP = IN_RATE / 10;

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
  /** Whether the words are cleaned up (smart transcription), read as each utterance begins; word for word without it. */
  clean?: () => boolean;
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

type Phase = "waiting" | "opening" | "streaming" | "rolling" | "stopped" | "failed" | "done";

const asRpc = (route: string, e: unknown) => (e instanceof RpcError ? e : new RpcError("unavailable", e instanceof Error ? e.message : String(e), { provider: route }));

/** A wait at the end of an utterance: short, and kept alive, so the answer it bounds always comes. */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class LiveStream implements SttStream {
  onPartial?: (text: string) => void;
  onStop?: (why: "limit" | "quota") => void;
  how?: { route?: string; live?: boolean; failed?: SttFailed };
  private deps: LiveSttDeps;
  private language: string | undefined;
  /** Every session of the utterance cleans the words up, or none does. */
  private clean: boolean;
  /** The audio kept, from sample `base` of the utterance on. */
  private chunks: Int16Array[] = [];
  private base = 0;
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
  /** Where the audio the session hears begins: shortly before the speech was heard, then where the one before handed on. */
  private from = 0;
  /** The words of the sessions that heard the utterance before this one, in order. */
  private closed: string[] = [];
  /** Nothing past this goes while the moment to hand on at is found. */
  private holdAt?: number;
  /** The handover under way: settles once the session before is ended and the next is opening. */
  private rolling?: Promise<void>;
  /** Counts the resets, so a handover a reset overtook stops there. */
  private gen = 0;
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
    this.clean = deps.clean?.() ?? false;
    this.dropped = new Promise((resolve) => (this.drop = resolve));
  }

  accept(pcm: Int16Array): void {
    if (this.disposed || this.phase === "done") return;
    if (this.samples + pcm.length > (this.deps.maxSeconds + 1) * IN_RATE) return;
    this.chunks.push(pcm);
    this.samples += pcm.length;
    if (this.phase !== "streaming") return;
    this.pump(false);
    if (this.rolls()) {
      // Near the most the session hears: the audio is held back, then handed on at its quietest moment.
      if (this.holdAt === undefined && this.sent - this.from >= (this.routeMax - ROLL_LEAD_SECONDS) * IN_RATE) this.holdAt = this.sent;
      if (this.holdAt !== undefined && this.samples - this.holdAt >= ROLL_SEARCH_SECONDS * IN_RATE) this.rolling = this.roll(this.quietest(this.holdAt, this.holdAt + ROLL_SEARCH_SECONDS * IN_RATE));
    } else if (!this.told && this.routeMax < this.deps.maxSeconds && this.samples - this.from >= this.routeMax * IN_RATE) {
      // The route hears less than the utterance may last (the account's allowance): the utterance ends where it stops.
      this.told = true;
      this.onStop?.("quota");
    }
  }

  heard(): void {
    if (this.disposed || this.phase !== "waiting") return;
    this.from = Math.max(0, this.samples - LEAD_IN_SECONDS * IN_RATE);
    this.opened = this.open();
  }

  /** Whether the most the session hears is its time, after which the next goes on, rather than the allowance. */
  private rolls(): boolean {
    return this.routeMax >= ROLL_MIN_SECONDS && this.routeMax < this.deps.maxSeconds;
  }

  private async open(): Promise<void> {
    this.phase = "opening";
    const refusals: string[] = [];
    let quota = false;
    const vocabulary = this.deps.vocabulary?.();
    for (const route of this.deps.routes()) {
      const opener = this.deps.opener(route);
      if (!opener) {
        refusals.push(`${route}: does not transcribe live`);
        continue;
      }
      const session = opener({ ...(this.language ? { language: this.language } : {}), ...(vocabulary?.length ? { vocabulary } : {}), clean: this.clean });
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
        this.skip(this.from);
        this.deps.log.debug("live transcription open", { route, backlogMs: Math.round(((this.samples - this.from) / IN_RATE) * 1000), maxSeconds, ...(this.closed.length > 0 ? { session: this.closed.length + 1 } : {}) });
        this.pump(false);
        return;
      } catch (e) {
        session.abort();
        if (this.session !== session || this.disposed) return;
        const err = asRpc(route, e);
        refusals.push(`${route}: ${err.message}`);
        if (err.code === "quota_exceeded") quota = true;
        // A plan the node still thinks it has, which the server no longer grants, passes on too.
        if (!PASS_ON.has(err.code) && !(err.code === "denied" && route === "server")) break;
      }
    }
    this.session = undefined;
    this.route = undefined;
    this.phase = "failed";
    if (this.closed.length === 0) {
      this.deps.log.info("no live transcription; the utterance goes whole at its end", { routes: refusals });
      return;
    }
    this.deps.log.info("no live transcription to hand on to; the rest goes whole at its end", { routes: refusals });
    // The allowance is used up: nothing would hear what comes after.
    if (quota && !this.told) {
      this.told = true;
      this.onStop?.("quota");
    }
  }

  /** The session hears up to `cut` and is ended, its words kept, and the next opens for the rest. */
  private async roll(cut: number): Promise<void> {
    const session = this.session!;
    const gen = this.gen;
    this.pump(true, cut);
    this.holdAt = undefined;
    // The session failed taking the last of its audio: the rest goes whole at the end.
    if (this.session !== session) return;
    this.phase = "rolling";
    this.deps.log.info("live transcription hands on to a new session", { route: this.route, atSeconds: Math.round(cut / IN_RATE) });
    let text: string | undefined;
    try {
      const r = await Promise.race([session.end(), sleep(this.deps.endWaitMs ?? END_WAIT_MS).then(() => undefined)]);
      if (!r) {
        session.abort();
        this.deps.log.info("the session handing on gave no last words in time; the words so far stand", { route: this.route });
      }
      text = r?.text;
    } catch (e) {
      session.abort();
      this.deps.log.warn("the session handing on failed at its end; the words so far stand", { route: this.route, error: e instanceof Error ? e.message : String(e) });
    }
    if (this.disposed || gen !== this.gen) return;
    this.handOn(text, cut);
  }

  /** The session before is over, with `text` or else the words it showed: the next opens to hear from `from`. */
  private handOn(text: string | undefined, from: number): void {
    this.closed.push(text?.trim() || this.current());
    this.finals = [];
    this.interim = "";
    this.session = undefined;
    this.route = undefined;
    this.routeMax = Infinity;
    this.from = from;
    this.forget(from);
    this.opened = this.open();
  }

  /** What is unsent goes, up to `upTo`, in pieces of at most a second; with `all`, the last frames short of `SEND_MIN` too. */
  private pump(all: boolean, upTo = this.holdAt ?? Infinity): void {
    const session = this.session;
    if (!session || this.phase !== "streaming") return;
    for (;;) {
      const unsent = Math.min(this.samples, upTo) - this.sent;
      if (unsent <= 0 || (!all && unsent < SEND_MIN)) return;
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

  /** The utterance's audio from sample `a` to `b`, of what is kept. */
  private audio(a: number, b = this.samples): Int16Array {
    const out = new Int16Array(Math.max(0, b - a));
    let at = this.base;
    for (const c of this.chunks) {
      const end = at + c.length;
      if (end > a && at < b) {
        const s = Math.max(a, at);
        out.set(c.subarray(s - at, Math.min(b, end) - at), s - a);
      }
      if (end >= b) break;
      at = end;
    }
    return out;
  }

  /** The middle of the quietest 100 ms from `a` to `b`, where a session hands on. */
  private quietest(a: number, b: number): number {
    const pcm = this.audio(a, b);
    let cut = a + QUIET_STEP / 2;
    let least = Infinity;
    for (let o = 0; o + QUIET_STEP <= pcm.length; o += QUIET_STEP) {
      let energy = 0;
      for (let i = o; i < o + QUIET_STEP; i++) energy += Math.abs(pcm[i]!);
      if (energy < least) {
        least = energy;
        cut = a + o + QUIET_STEP / 2;
      }
    }
    return cut;
  }

  /** Lets go of the audio before `from`, sent whole to the sessions before. */
  private forget(from: number): void {
    let k = 0;
    let at = this.base;
    while (k < this.sendIdx && at + this.chunks[k]!.length <= from) at += this.chunks[k++]!.length;
    if (k === 0) return;
    this.chunks = this.chunks.slice(k);
    this.sendIdx -= k;
    this.base = at;
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
    // Handing on, the session's end is awaited where it was asked for.
    if (this.phase === "rolling") return;
    if ("error" in outcome) return this.fail(session, outcome.error.message);
    // The session's time ran out before it handed on: the next goes on from what it was sent.
    if (outcome.stopped === "limit" && this.phase === "streaming" && this.rolls()) {
      this.deps.log.info("live transcription ended at its time; a new session goes on", { route: this.route, atSeconds: Math.round(this.sent / IN_RATE) });
      this.holdAt = undefined;
      this.handOn(outcome.text, this.sent);
      return;
    }
    this.stoppedWith = outcome;
    this.phase = "stopped";
    this.deps.log.info("live transcription stopped by its route", { route: this.route, stopped: outcome.stopped });
    if (outcome.stopped && !this.told) {
      this.told = true;
      this.onStop?.(outcome.stopped);
    }
  }

  /** The words of the session hearing the utterance now: the stretches it kept and the one in progress. */
  private current(): string {
    return [...this.finals, this.interim].filter(Boolean).join(" ");
  }

  /** `text` after the words of the sessions before. */
  private withClosed(text: string): string {
    return [...this.closed, text].filter(Boolean).join(" ");
  }

  private display(): string {
    return this.withClosed(this.current());
  }

  final(): Promise<string> {
    if (this.disposed) return Promise.resolve("");
    return Promise.race([this.conclude(), this.dropped]);
  }

  private async conclude(): Promise<string> {
    // What was held back while a moment to hand on at was found goes to the session that has it.
    this.holdAt = undefined;
    if (this.rolling) await this.rolling;
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
      return this.withClosed(this.stoppedWith?.text || this.current());
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
            return r.text ? this.withClosed(r.text) : this.display();
          } catch (e) {
            this.fail(session, e instanceof Error ? e.message : String(e));
          }
        }
      }
    }
    return this.whole();
  }

  /** The utterance over the batch routes (after a handover, the part from it on); the words shown stand when that fails. */
  private async whole(): Promise<string> {
    this.phase = "done";
    const pcm = this.audio(this.closed.length > 0 ? this.from : 0);
    try {
      const r = await this.deps.batch(pcm, this.language);
      if (this.disposed) return "";
      this.how = { route: r.route ?? "none", live: false };
      return r.text ? this.withClosed(r.text) : this.display();
    } catch (e) {
      this.deps.log.warn("the utterance was not transcribed whole; the words shown stand", { error: e instanceof Error ? e.message : String(e) });
      this.how = { route: "none", live: false, failed: sttFailed(e) };
      return this.display();
    }
  }

  reset(): void {
    this.session?.abort();
    this.session = undefined;
    this.route = undefined;
    this.routeMax = Infinity;
    this.chunks = [];
    this.base = 0;
    this.samples = 0;
    this.sendIdx = 0;
    this.sendOff = 0;
    this.sent = 0;
    this.from = 0;
    this.closed = [];
    this.holdAt = undefined;
    this.rolling = undefined;
    this.gen++;
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
