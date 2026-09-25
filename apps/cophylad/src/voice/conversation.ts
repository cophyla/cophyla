// One conversation with one controller: the state machine that turns a stream of microphone
// frames into an utterance and speech back. Audio arrives every 40 ms and each stage of the
// pipeline is slower than that, so frames go through a serial pump with a bounded backlog:
// under load the oldest frame is dropped rather than the newest, because the newest is what
// the user is saying now.
//
// Idle, the wake word runs over everything and nothing else does — on the node for a
// controller that streams while it listens, on the phone for one that detects the word
// itself and says so with `wakeHeard`. Once it fires — or the button is pressed — the
// utterance begins: the VAD and the recogniser both see the audio, partials go out as they
// grow, and the end of the utterance (silence, or the button released) closes it. An empty
// utterance ends the turn without waking the brain, so a tap on the button costs nothing,
// and one the wake word began is abandoned without transcribing when no speech follows or
// the phone stops sending. While the reply is spoken the wake word keeps running, so a word
// over the top of it stops the speech and starts the next utterance.
//
// Each spoken line is a numbered reply whose last frame says `end`. A phone that said it
// reports playback answers that end with `voice.played` once the last of it has left its
// speaker, and `speaking` lasts until then; for one that does not, the node estimates when
// the audio it sent will have played, as it always did. Each turn's stages are timed and
// the times logged as one `voice turn` line, to tell the network's delay from the pipeline's.

import type { VoiceState } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import type { SttEngine, SttStream, TtsEngine, VadEngine, WakeEngine } from "./engines.ts";
import { FRAME, IN_RATE, OUT_RATE } from "./engines.ts";

/** Samples in one `voice.audio` frame of speech: 200 ms at 24 kHz. */
export const OUT_FRAME = 4800;
/** Audio held before the oldest frames are dropped. */
export const BACKLOG_MS = 2000;
/**
 * Added to the playback estimate, for the hop and the controller's own scheduling: a phone on
 * mobile data through the server relay hears a frame several hundred ms after it left.
 */
export const PLAYBACK_SLACK_MS = 800;
/** How much longer than the estimate a reply's `voice.played` is waited for before `speaking` ends anyway. */
export const PLAYED_FALLBACK_MS = 5000;
/** How long `thinking` survives a reply that was not spoken. */
export const REPLY_GRACE_MS = 1500;
/** Audio after a wake word with no speech in it, before the utterance is abandoned: a false accept. */
export const NO_SPEECH_MS = 5000;
/** How long an utterance the wake word began waits for the next frame before it is abandoned. */
export const LISTEN_STALL_MS = 4000;

export interface ConversationHandlers {
  state(state: VoiceState): void;
  partial(text: string): void;
  final(text: string): void;
  /** The edges of the user speaking, for `user.activity`. */
  speaking(active: boolean): void;
  /** A slice of speech for reply `reply`; the reply's last call says `end` and may carry no samples. */
  audio(pcm: Int16Array, sampleRate: number, frame: { reply: number; end?: true }): void;
}

/** How a reply played on the phone, from its `voice.played`. */
export interface PlayedStats {
  underruns: number;
  maxLateMs: number;
  targetMs: number;
  frames: number;
}

/** The moments of one turn, for its `voice turn` line. */
type Stamp = "speechEnd" | "sttFinal" | "reply" | "speak" | "firstChunk" | "synthDone" | "played";

export interface ConversationDeps {
  client: string;
  /** The node's wake word over this controller's frames; none when the phone detects it (see `useWake`). */
  wake?: WakeEngine;
  /** A detector of this conversation's own, made at the first utterance so the stage can come up later. */
  vad?: () => VadEngine | undefined;
  /** The recogniser, looked up per utterance for the same reason. */
  stt?: () => SttEngine | undefined;
  /** The engine that speaks, looked up per utterance so a stage can come up later. */
  tts?: () => TtsEngine | undefined;
  /** The controller answers each reply's end with `voice.played`, so `speaking` waits for it. */
  acksPlayed?: boolean;
  wakeThreshold: number;
  thinkingTimeoutMs: number;
  /** For the tests: `NO_SPEECH_MS`, `LISTEN_STALL_MS` and `PLAYED_FALLBACK_MS` unless given. */
  noSpeechMs?: number;
  stallMs?: number;
  playedFallbackMs?: number;
  on: ConversationHandlers;
  now?: () => number;
  log?: Logger;
}

export class Conversation {
  readonly client: string;
  private deps: ConversationDeps;
  private state: VoiceState = "idle";
  private wake?: WakeEngine;
  private vad?: VadEngine;
  private stream?: SttStream;
  /** What began the utterance in progress. */
  private began?: "wake" | "button";
  /** Samples the utterance has seen, for the no-speech abandon. */
  private samples = 0;
  private stallTimer?: ReturnType<typeof setTimeout>;
  private queue: Int16Array[] = [];
  private pumping = false;
  private pttHeld = false;
  private disposed = false;
  /** The synthesis in flight, so a barge-in can cut it. */
  private speech?: AbortController;
  private speaking = false;
  /** When the audio already sent will have finished playing. */
  private playsUntil = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private thinkingTimer?: ReturnType<typeof setTimeout>;
  /** The last reply numbered, the one `speaking` waits on, and the last the phone said it played. */
  private replies = 0;
  private awaiting?: number;
  private lastPlayed = -1;
  /** This turn's moments, the microphone's frames as they arrived, and how the phone played it. */
  private stamps: Partial<Record<Stamp, number>> = {};
  private uplink = { frames: 0, lost: 0, late: 0, maxGapMs: 0, next: -1, lastAt: 0 };
  private phone?: PlayedStats;

  constructor(deps: ConversationDeps) {
    this.deps = deps;
    this.client = deps.client;
    this.wake = deps.wake;
  }

  get current(): VoiceState {
    return this.state;
  }

  get busy(): boolean {
    return this.state !== "idle";
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private setState(next: VoiceState): void {
    if (this.state === next) return;
    this.state = next;
    this.deps.on.state(next);
  }

  /**
   * Where the wake word is heard: a stream of the node's model over this controller's frames,
   * or none when the phone detects the word itself and says so with `wakeHeard`.
   */
  useWake(engine: WakeEngine | undefined): void {
    this.wake = engine;
  }

  // --- audio in --------------------------------------------------------------------------

  /** A frame from the controller, numbered when the phone numbers them. Never awaited by the caller: the pump is serial behind it. */
  push(pcm: Int16Array, seq?: number): void {
    if (this.disposed) return;
    this.noteUplink(seq);
    // A frame arrived: the phone is still sending the utterance the wake word began.
    if (this.abandonable()) this.armStall();
    this.queue.push(pcm);
    const max = Math.ceil((BACKLOG_MS / 1000) * (IN_RATE / FRAME));
    while (this.queue.length > max) {
      this.queue.shift();
      this.deps.log?.debug("voice backlog: a frame dropped", { client: this.client });
    }
    void this.pump();
  }

  /** Frames lost on the way (a gap in `seq`) or overtaken (one behind it), and the longest wait between two. */
  private noteUplink(seq: number | undefined): void {
    const u = this.uplink;
    const at = this.now();
    if (u.frames > 0) u.maxGapMs = Math.max(u.maxGapMs, at - u.lastAt);
    u.lastAt = at;
    u.frames++;
    if (seq === undefined) return;
    if (u.next >= 0 && seq > u.next) u.lost += seq - u.next;
    else if (u.next >= 0 && seq < u.next) u.late++;
    u.next = Math.max(u.next, seq + 1);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const frame = this.queue.shift();
        if (!frame || this.disposed) break;
        await this.frame(frame);
      }
    } catch (e) {
      this.deps.log?.warn("voice frame failed", { client: this.client, error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.pumping = false;
    }
  }

  private async frame(pcm: Int16Array): Promise<void> {
    // The wake word runs over everything but the utterance itself, so a word said over the
    // reply stops it. While the button is held there is nothing for it to decide.
    const wake = this.wake;
    if (wake && !this.pttHeld && this.state !== "listening" && this.state !== "transcribing") {
      const score = await wake.feed(pcm);
      if (score >= this.deps.wakeThreshold) {
        this.deps.log?.info("wake word", { client: this.client, score: Number(score.toFixed(3)) });
        this.begin("wake");
        return;
      }
    }
    if (this.state !== "listening") return;
    const closed = this.vad?.feed(pcm) ?? false;
    this.stream?.accept(pcm);
    if (closed && !this.pttHeld) {
      await this.finish("silence");
      return;
    }
    // A false accept in a quiet room: nothing said after the word, so nothing is transcribed.
    this.samples += pcm.length;
    if (this.abandonable() && !this.vad?.heard && this.samples >= ((this.deps.noSpeechMs ?? NO_SPEECH_MS) / 1000) * IN_RATE) this.abandon("no speech");
  }

  /**
   * The phone heard the wake word itself: the utterance begins as if the node had. Ignored
   * while one is in progress and while the button is held, which already began one.
   */
  wakeHeard(): boolean {
    if (this.disposed || this.pttHeld || this.state === "listening" || this.state === "transcribing") return false;
    this.begin("wake");
    return true;
  }

  /** The button, pressed and released. */
  ptt(active: boolean): void {
    if (this.disposed) return;
    this.pttHeld = active;
    if (active) {
      // Held, an utterance the wake word began is the button's to end.
      this.clearStall();
      if (this.state !== "listening") this.begin("button");
      return;
    }
    if (this.state === "listening") void this.finish("button");
  }

  private begin(why: "wake" | "button"): void {
    // Speaking over the reply is how a person interrupts: the speech stops where it is.
    if (this.state === "speaking" || this.speech) {
      this.stopSpeech();
      this.logTurn("cut");
    }
    this.resetTurn();
    this.clearThinking();
    this.vad ??= this.deps.vad?.();
    this.vad?.reset();
    this.wake?.reset();
    this.stream?.dispose();
    this.stream = undefined;
    this.began = why;
    this.samples = 0;
    const stt = this.deps.stt?.();
    if (stt) {
      const stream = stt.stream();
      stream.onPartial = (text) => {
        if (this.state === "listening") this.deps.on.partial(text);
      };
      this.stream = stream;
    }
    this.setSpeaking(true);
    this.setState("listening");
    if (this.abandonable()) this.armStall();
    this.deps.log?.debug("utterance begins", { client: this.client, why });
  }

  /** An utterance the wake word began and the button does not hold: the one kind that is abandoned. */
  private abandonable(): boolean {
    return this.state === "listening" && this.began === "wake" && !this.pttHeld;
  }

  private armStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      this.stallTimer = undefined;
      if (this.abandonable()) this.abandon("stalled");
    }, this.deps.stallMs ?? LISTEN_STALL_MS);
    this.stallTimer.unref?.();
  }

  private clearStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
  }

  /**
   * Ends an utterance with nothing transcribed: no speech followed the word, or the phone
   * stopped sending. The recogniser is dropped, not drained, so a hosted one is never sent
   * seconds of silence to bill.
   */
  private abandon(why: "no speech" | "stalled"): void {
    this.clearStall();
    this.stream?.dispose();
    this.stream = undefined;
    this.began = undefined;
    this.setSpeaking(false);
    this.setState("idle");
    this.deps.log?.info("utterance abandoned", { client: this.client, why });
  }

  private async finish(why: "silence" | "button"): Promise<void> {
    this.stamp("speechEnd");
    const stream = this.stream;
    this.clearStall();
    this.began = undefined;
    this.setState("transcribing");
    const text = stream ? await stream.final() : "";
    if (this.disposed) return;
    this.stamp("sttFinal");
    if (!text) {
      // A tap, a cough, a false accept: nothing was said, so nothing wakes the brain.
      this.deps.log?.debug("utterance was empty", { client: this.client, why });
      this.setSpeaking(false);
      this.setState("idle");
      return;
    }
    this.deps.log?.info("utterance", { client: this.client, why, chars: text.length });
    this.deps.on.final(text);
    this.setSpeaking(false);
    this.setState("thinking");
    this.armThinking();
  }

  private setSpeaking(active: boolean): void {
    if (this.speaking === active) return;
    this.speaking = active;
    this.deps.on.speaking(active);
  }

  // --- thinking ---------------------------------------------------------------------------

  private armThinking(): void {
    this.clearThinking();
    this.thinkingTimer = setTimeout(() => {
      this.thinkingTimer = undefined;
      if (this.state === "thinking") {
        this.deps.log?.info("no reply came; going idle", { client: this.client });
        this.logTurn("no reply");
        this.setState("idle");
      }
    }, this.deps.thinkingTimeoutMs);
    this.thinkingTimer.unref?.();
  }

  private clearThinking(): void {
    if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
    this.thinkingTimer = undefined;
  }

  /**
   * A reply reached the chat. If it is spoken, `speak` follows within a moment; if it is
   * not — the brain answered a typed turn, or said nothing worth hearing — the grace ends
   * `thinking` so the phone does not sit lit forever.
   */
  replyArrived(): void {
    if (this.state !== "thinking") return;
    this.stamp("reply");
    this.clearThinking();
    this.thinkingTimer = setTimeout(() => {
      this.thinkingTimer = undefined;
      if (this.state === "thinking") {
        this.logTurn("unspoken");
        this.setState("idle");
      }
    }, REPLY_GRACE_MS);
    this.thinkingTimer.unref?.();
  }

  // --- speech out ---------------------------------------------------------------------------

  /** Speaks a line. `interrupt` cuts whatever is playing; otherwise this waits its turn. */
  async speak(text: string, opts: { interrupt?: boolean } = {}): Promise<void> {
    if (this.disposed || !text.trim()) return;
    const engine = this.deps.tts?.();
    if (!engine) {
      // Nothing can speak: the turn is over as far as the phone is concerned.
      if (this.state === "thinking") this.setState("idle");
      return;
    }
    if (opts.interrupt) this.stopSpeech();
    this.clearThinking();
    const controller = new AbortController();
    this.speech = controller;
    const reply = ++this.replies;
    this.stamp("speak");
    this.setState("speaking");
    const rate = engine.sampleRate || OUT_RATE;
    let sent = 0;
    try {
      for await (const chunk of engine.synth(text, { signal: controller.signal })) {
        if (controller.signal.aborted || this.disposed) break;
        this.stamp("firstChunk");
        for (let off = 0; off < chunk.length; off += OUT_FRAME) {
          const slice = chunk.subarray(off, Math.min(off + OUT_FRAME, chunk.length));
          this.deps.on.audio(slice, rate, { reply });
          sent += slice.length;
        }
        // a chunk cannot start playing before it leaves: a slow first sentence moves the end out with it
        this.playsUntil = Math.max(this.playsUntil, this.now()) + (chunk.length / rate) * 1000;
      }
    } catch (e) {
      if (!controller.signal.aborted) this.deps.log?.warn("speech failed", { client: this.client, error: e instanceof Error ? e.message : String(e) });
    }
    if (this.speech !== controller) return;
    this.speech = undefined;
    if (this.disposed || controller.signal.aborted) return;
    this.stamp("synthDone", true);
    this.deps.log?.debug("spoke", { client: this.client, reply, ms: Math.round((sent / rate) * 1000) });
    // `speaking` is held until the audio already sent has played: the phone says so, or,
    // for one that cannot, the node estimates it and the state follows the estimate.
    this.awaiting = this.deps.acksPlayed ? reply : undefined;
    this.deps.on.audio(new Int16Array(0), rate, { reply, end: true });
    this.holdUntilPlayed();
  }

  private holdUntilPlayed(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const awaiting = this.awaiting;
    if (awaiting !== undefined && this.lastPlayed >= awaiting) {
      this.played(this.lastPlayed);
      return;
    }
    const estimate = Math.max(0, this.playsUntil + PLAYBACK_SLACK_MS - this.now());
    const left = awaiting !== undefined ? estimate + (this.deps.playedFallbackMs ?? PLAYED_FALLBACK_MS) : estimate;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.state === "speaking" && !this.speech) {
        if (awaiting !== undefined) this.deps.log?.info("no voice.played came; going idle", { client: this.client, reply: awaiting });
        this.awaiting = undefined;
        this.logTurn(awaiting !== undefined ? "no ack" : "estimated");
        this.setState("idle");
      }
    }, left);
    this.idleTimer.unref?.();
  }

  /** `voice.played`: the phone finished a reply. The one `speaking` waits on ends it now. */
  played(reply: number, stats?: PlayedStats): void {
    if (this.disposed) return;
    this.lastPlayed = Math.max(this.lastPlayed, reply);
    if (stats) this.phone = stats;
    if (this.awaiting === undefined || reply < this.awaiting) return;
    this.stamp("played");
    this.awaiting = undefined;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.state === "speaking" && !this.speech) {
      this.logTurn("played");
      this.setState("idle");
    }
  }

  // --- timings --------------------------------------------------------------------------------

  /** The first time a moment is reached this turn, or with `last` the latest. */
  private stamp(what: Stamp, last = false): void {
    if (last || this.stamps[what] === undefined) this.stamps[what] = this.now();
  }

  private resetTurn(): void {
    this.stamps = {};
    this.phone = undefined;
    this.uplink = { frames: 0, lost: 0, late: 0, maxGapMs: 0, next: this.uplink.next, lastAt: 0 };
  }

  /**
   * The turn's line: the recogniser's tail after the speech ended, the brain, the engine's
   * first audio, how long after the last of it the phone finished, and how the microphone's
   * frames and the phone's playback went.
   */
  private logTurn(outcome: string): void {
    const t = this.stamps;
    if (t.speechEnd === undefined && t.speak === undefined) return;
    const fields: Record<string, unknown> = { client: this.client, outcome };
    const span = (key: string, a: Stamp, b: Stamp) => {
      if (t[a] !== undefined && t[b] !== undefined) fields[key] = Math.round(t[b]! - t[a]!);
    };
    span("sttMs", "speechEnd", "sttFinal");
    span("brainMs", "sttFinal", "reply");
    span("toSpeakMs", "reply", "speak");
    span("ttsFirstMs", "speak", "firstChunk");
    span("firstAudioMs", "speechEnd", "firstChunk");
    span("synthMs", "speak", "synthDone");
    span("playedAfterMs", "synthDone", "played");
    span("totalMs", "speechEnd", "played");
    const u = this.uplink;
    if (u.frames > 0) fields["uplink"] = { frames: u.frames, lost: u.lost, late: u.late, maxGapMs: Math.round(u.maxGapMs) };
    if (this.phone) fields["phone"] = this.phone;
    this.deps.log?.info("voice turn", fields);
    this.resetTurn();
  }

  /** Cuts the speech in flight; the controller drops its queue when the state leaves `speaking`. */
  private stopSpeech(): void {
    if (this.speech) {
      this.speech.abort();
      this.speech = undefined;
      this.deps.log?.debug("speech cut", { client: this.client });
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.playsUntil = 0;
    this.awaiting = undefined;
  }

  /** Stops speaking and goes idle: a disconnect, a revoked controller, a stage going down. */
  interrupt(): void {
    this.stopSpeech();
    this.clearThinking();
    this.clearStall();
    if (this.state !== "idle") this.setState("idle");
  }

  dispose(): void {
    this.disposed = true;
    this.stopSpeech();
    this.clearThinking();
    this.clearStall();
    this.queue = [];
    this.stream?.dispose();
    this.stream = undefined;
    void this.vad?.close();
  }
}
