// A client's side of voice, once for the phone and the desktop app: the microphone and the
// speaker (`Audio`), the wake word in its worker (`WakeDetector`), and where each microphone
// frame goes. The host listens for the wake word the whole time it is open (unless listening
// was turned off), sending frames up as `voice.audio` only once it heard a word or while the
// button is held — a node that cannot hand it the words (an older one, or a head this build
// does not carry) gets the stream while the host listens and detects them itself; speech
// comes back the same way and is played through a jitter buffer, each reply acked with
// `voice.played` once it has played, and dropped the moment the node says the conversation
// is no longer speaking. Audio goes as Opus both ways when WebCodecs has it and the node
// takes it, as PCM otherwise; a frame up is numbered, and shed rather than queued when the
// link already holds more than it can send.
//
// What it does not own is the host's: the link (a `Connection` from `@cophyla/viewhost`, over
// the phone's link core or the desktop's shell), the page, and the controls. The host passes
// on each frame from the node (`handleFrame`) and each change of the link (`linkChanged`), and
// calls `ptt`, `listen` and `mute` from its own buttons; `onChange` says when what it shows
// moved.

import type { AudioCodec, VoiceState, WakeHeadMode, WakewordMode } from "@cophyla/protocol";
import { Audio } from "./audio.ts";
import type { LinkVia, PlayStats, SpeechFrame } from "./audio.ts";
import { detectCodecs, MicEncoder } from "./opus.ts";
import { encodeChunk } from "./pcm.ts";
import { Uplink } from "./uplink.ts";
import { headsOf, WakeDetector } from "./wake/detector.ts";
import type { FileCache } from "./wake/detector.ts";
import { FrameRing } from "./wake/ring.ts";

/**
 * Frames from before the word fired that go up after `voice.wake`, 160 ms: a word fires a
 * moment after it ends, often inside the next word, which the recogniser needs whole. The node
 * gives them to the recogniser alone (`lead`), not to its end-of-speech detector. More lets
 * the word's own tail into the transcript.
 */
export const LEAD_FRAMES = 4;
import { initialWake, PENDING_MS, reduceWake } from "./wake/state.ts";
import type { WakeBook, WakeEvent, WakeMode } from "./wake/state.ts";

/** The part of a host's connection voice uses: viewhost's `Connection` fits. */
export interface VoiceLink {
  readonly connected: boolean;
  readonly state: { hello?: { client: { id: string }; audio?: { codecs: AudioCodec[] } } };
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  send(frame: object): Promise<void>;
}

/** What decides where a microphone frame goes. */
export interface RouteInput {
  connected: boolean;
  /** The audio context runs and the microphone was asked for. */
  audioReady: boolean;
  /** A remote desktop covers the app: nothing listens meanwhile. */
  watching?: boolean;
  /** The button is held. */
  talking: boolean;
  /** The node's voice state for this client. */
  voice?: VoiceState;
  /** The host heard a word and the node has not yet said `listening`. */
  pending: boolean;
  /** Listening for the wake word, on unless turned off. */
  listening: boolean;
  /** Where the wake word is detected: the node's last answer. */
  wake: WakeMode;
}

export interface Route {
  /** Frames go up to the node. */
  streaming: boolean;
  /** Frames go to the host's own wake word. */
  detecting: boolean;
}

/** Which way each microphone frame goes: up to the node, into the host's own wake word, both, or nowhere. */
export function route(input: RouteInput): Route {
  const live = input.connected && input.audioReady && input.watching !== true;
  const inUtterance = input.voice === "listening" || input.voice === "transcribing";
  return {
    // A held button beats the toggle: it is how you speak with the wake word off. Whenever the
    // node is listening to this client, audio goes up, whatever else is true, so the node never
    // waits on a client that stopped sending; and until it says so, the host's own word is enough.
    streaming: live && (input.talking || input.voice === "listening" || input.pending || (input.listening && input.wake === "node")),
    // The host's wake word runs whenever the node's would have: through a reply too, so a word
    // over it interrupts, but not over the utterance itself or while the button is held.
    detecting: live && input.listening && input.wake === "phone" && !input.talking && !input.pending && !inUtterance,
  };
}

export interface VoiceHostOptions {
  link: VoiceLink;
  /** Bytes the link holds unsent, so a frame is shed rather than queued behind them; none on a loopback link. */
  backlog?: () => number;
  /** How the wake files are kept: the browser page caches and checks what it fetched; the apps have them as their own files. */
  wake?: { cache?: FileCache; verify?: boolean };
  /** Listening for the wake word from the start: the host keeps the user's choice. */
  listening: boolean;
  /** Where the capture worklet is served from; `worklet.js` beside the page by default. */
  workletUrl?: string;
  /** Something the host shows moved. */
  onChange?: () => void;
  /** The codecs this web view speaks moved (WebCodecs answered, or the encoder failed); a link that says them in its hello wants them. */
  onCodecs?: (codecs: AudioCodec[]) => void;
  log?: (message: string) => void;
}

/** What the host shows about voice: its controls and the words beside them. */
export interface VoiceView {
  audioReady: boolean;
  voice?: VoiceState;
  wake: WakeMode;
  pending: boolean;
  talking: boolean;
  listening: boolean;
  muted: boolean;
  watching: boolean;
  /** The phrases the node listens for, once it said which. */
  phrases: string[];
  /** Why the microphone is not on, when it failed. */
  micError?: string;
  /** Why the node last refused the button or a heard word (nothing to transcribe with, voice off). */
  refused?: string;
}

export class VoiceHost {
  readonly audio: Audio;
  private opts: VoiceHostOptions;
  private book: WakeBook = initialWake();
  private voice?: VoiceState;
  private talking = false;
  private listening: boolean;
  private muted = false;
  private watching = false;
  private away = false;
  private audioReady = false;
  private micError?: string;
  private refused?: string;
  private heads: WakeHeadMode[] = [];
  private streaming = false;
  private detecting = false;
  private seq = 0;
  private ring = new FrameRing();
  private detector?: WakeDetector;
  private pendingTimer?: ReturnType<typeof setTimeout>;
  private starting?: Promise<void>;
  private codecList: AudioCodec[] = ["pcm"];
  private encoder?: MicEncoder;
  private uplink: Uplink;
  /** Where the wake word and the audio stand, for Playwright and the web inspector. */
  readonly heard = { count: 0, lastScore: 0, lastHead: "" };
  readonly played = { count: 0, last: undefined as (PlayStats & { reply: number }) | undefined };
  /** Resolves once WebCodecs has been asked what it speaks. */
  readonly codecsKnown: Promise<AudioCodec[]>;

  constructor(opts: VoiceHostOptions) {
    this.opts = opts;
    this.listening = opts.listening;
    this.uplink = new Uplink({
      backlog: () => this.opts.backlog?.() ?? 0,
      send: (params) => void this.opts.link.send({ jsonrpc: "2.0", method: "voice.audio", params }).catch(() => {}),
    });
    this.audio = new Audio({
      // Every frame is numbered and kept a moment, so the ones captured while the worker scored
      // the word can follow `voice.wake` up; each goes to the node, to the wake word, or both.
      onFrame: (pcm) => {
        const n = ++this.seq;
        this.ring.push(n, pcm);
        if (this.streaming) this.sendFrame(pcm);
        if (this.detecting) this.detector?.feed(n, pcm);
      },
      onPlayed: (reply, stats) => {
        this.played.count++;
        this.played.last = { reply, ...stats };
        if (this.opts.link.connected) void this.opts.link.send({ jsonrpc: "2.0", method: "voice.played", params: { reply, stats } }).catch(() => {});
      },
      onNote: (message) => this.log(message),
      ...(opts.workletUrl ? { workletUrl: opts.workletUrl } : {}),
    });
    this.codecsKnown = detectCodecs().then((found) => {
      this.setCodecs(found);
      return found;
    });
  }

  /** What this web view speaks, best first; PCM until WebCodecs has been asked. */
  get codecs(): AudioCodec[] {
    return this.codecList;
  }

  get view(): VoiceView {
    return {
      audioReady: this.audioReady,
      ...(this.voice ? { voice: this.voice } : {}),
      wake: this.book.mode,
      pending: this.book.pending,
      talking: this.talking,
      listening: this.listening,
      muted: this.muted,
      watching: this.watching,
      phrases: this.heads.map((h) => h.phrase ?? h.head),
      ...(this.micError !== undefined ? { micError: this.micError } : {}),
      ...(this.refused !== undefined ? { refused: this.refused } : {}),
    };
  }

  /** Where frames go now, for the host's own chrome and the tests. */
  get routed(): Route {
    return { streaming: this.streaming, detecting: this.detecting };
  }

  /** The state of the wake word, for the web inspector. */
  get wakeState(): Record<string, unknown> {
    const d = this.detector;
    return { detector: d?.state ?? "idle", mode: this.book.mode, pending: this.book.pending, streaming: this.streaming, detecting: this.detecting, heard: { ...this.heard }, loadMs: d?.loadMs, fromCache: d?.fromCache ?? 0, configured: d?.configured, stats: d?.stats };
  }

  /** The state of the audio, for the web inspector. */
  get audioState(): Record<string, unknown> {
    return { codecs: this.codecList, opusUp: this.opusUp(), up: { ...this.uplink.counts }, played: { ...this.played }, targetMs: this.audio.queue?.targetMs, queuedMs: this.audio.queue?.queuedMs, audio: this.audio.info, down: { ...this.audio.counts } };
  }

  /**
   * The context, the worklet, then the microphone, and the wake word's worker: inside a
   * gesture in a browser, at launch in the apps. A second call while the first runs waits for
   * it; one after it failed tries again.
   */
  start(): Promise<void> {
    if (this.audioReady) return Promise.resolve();
    if (!this.starting) {
      this.starting = this.doStart().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  private async doStart(): Promise<void> {
    await this.audio.open();
    // A speaker muted before the audio started stays muted.
    if (this.audio.queue) this.audio.queue.muted = this.muted;
    try {
      await this.audio.mic(true);
      delete this.micError;
    } catch (e) {
      this.micError = e instanceof Error ? e.message : String(e);
      this.changed();
      throw e;
    }
    this.audioReady = true;
    this.loadDetector();
    this.refresh();
  }

  /** Opens only the audio context, for a host that races it against a timer before asking for the microphone. */
  openAudio(): Promise<void> {
    return this.audio.open();
  }

  // --- the node's frames and the link -------------------------------------------------------------

  /**
   * A frame from the node. Speech is played here and never handed on: true says it was
   * taken. This client's `voice.state` moves where frames go and is handed on too.
   */
  handleFrame(frame: { method?: string; params?: unknown }): boolean {
    if (frame.method === "voice.audio") {
      this.audio.play(frame.params as SpeechFrame);
      return true;
    }
    if (frame.method === "voice.state") {
      const params = frame.params as { state: VoiceState; client?: string };
      const mine = params.client === undefined || params.client === this.opts.link.state.hello?.client.id;
      if (mine) {
        this.voice = params.state;
        // The node stopped speaking, whatever it had queued: drop what is scheduled here too.
        if (params.state !== "speaking") this.audio.flush();
        // `listening` settles a word the host heard; every state moves where frames go.
        this.dispatch({ type: "voice", state: params.state });
      }
    }
    return false;
  }

  /** The link came up or went down. Up is a new conversation on the node: the word starts over and is asked for again. */
  linkChanged(connected: boolean): void {
    if (!connected) {
      this.voice = undefined;
      this.audio.flush();
      this.talking = false;
      this.dispatch({ type: "disconnected" });
      return;
    }
    this.detector?.reset();
    this.negotiate();
    this.refresh();
  }

  /** Which transport carries the link, for the jitter target. */
  setVia(via: LinkVia | undefined): void {
    this.audio.setVia(via);
  }

  // --- what the user does -----------------------------------------------------------------------

  /** The button (or the key) held and let go. */
  ptt(down: boolean): void {
    if (this.talking === down) return;
    this.talking = down;
    if (down) this.detector?.reset();
    this.refresh();
    if (this.opts.link.connected) {
      void this.opts.link.request("voice.ptt", { active: down }).then(
        () => this.settle(),
        (e: unknown) => this.refuse(`voice.ptt`, e),
      );
    }
  }

  /** Listening for the wake word, on or off. */
  listen(on: boolean): void {
    this.listening = on;
    if (on) this.detector?.reset();
    this.refresh();
  }

  /** The speaker quiet, or not. */
  mute(on: boolean): void {
    this.muted = on;
    if (this.audio.queue) this.audio.queue.muted = on;
    if (on) this.audio.flush();
    this.changed();
  }

  /** The host went to the background: the microphone off, the button up, the speaker quiet. */
  pause(): void {
    this.away = true;
    this.letGo();
    this.dispatch({ type: "background" });
    this.streaming = false;
    this.detecting = false;
    this.audio.flush();
    void this.audio.mic(false);
  }

  /** Back in front: the microphone on again, and the word starts over after the gap. */
  async resume(): Promise<void> {
    this.away = false;
    await this.audio.resume();
    if (this.audioReady && !this.watching) await this.audio.mic(true);
    this.detector?.reset();
    this.refresh();
  }

  /** A remote desktop covers the app, or no longer does: the microphone and the wake word stand down meanwhile. */
  watch(on: boolean): void {
    if (this.watching === on) return;
    this.watching = on;
    if (on) {
      this.letGo();
      this.audio.flush();
      void this.audio.mic(false);
    } else if (this.audioReady && !this.away) {
      void this.audio.mic(true).then(() => this.detector?.reset());
    }
    this.refresh();
  }

  private letGo(): void {
    if (this.talking && this.opts.link.connected) void this.opts.link.request("voice.ptt", { active: false }).catch(() => {});
    this.talking = false;
  }

  // --- where frames go -----------------------------------------------------------------------------

  private refresh(): void {
    const r = route({
      connected: this.opts.link.connected,
      audioReady: this.audioReady && !this.away,
      watching: this.watching,
      talking: this.talking,
      ...(this.voice ? { voice: this.voice } : {}),
      pending: this.book.pending,
      listening: this.listening,
      wake: this.book.mode,
    });
    this.streaming = r.streaming;
    this.detecting = r.detecting;
    this.changed();
  }

  /** Something happened to the wake word's bookkeeping: the frames and the page follow it. */
  private dispatch(event: WakeEvent): void {
    this.book = reduceWake(this.book, event);
    if (!this.book.pending && this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
    this.refresh();
  }

  /** Tells the node which heads this client can run, once the detector is up and on every connect. */
  private negotiate(): void {
    const d = this.detector;
    if (!this.opts.link.connected || !d?.ready) return;
    void this.opts.link
      .request<WakewordMode>("voice.wakeword", { heads: d.heads })
      .then((answer) => {
        if (this.detector !== d || !d.ready) return;
        if (answer.mode === "phone") {
          d.configure(answer);
          this.heads = headsOf(answer);
        } else {
          this.heads = [];
        }
        d.reset();
        this.dispatch({ type: "answer", mode: answer.mode });
      })
      .catch((e: unknown) => {
        // A node from before a client could hear the word detects it itself.
        if (codeOf(e) === "unsupported") this.dispatch({ type: "answer", mode: "node" });
        else this.log(`voice.wakeword: ${message(e)}`);
      });
  }

  /** The detector or its worker failed: the node takes the word back, for as long as the page is open. */
  private wakeFailed(reason: string): void {
    this.log(`wake word: ${reason}`);
    this.heads = [];
    this.dispatch({ type: "failed" });
    if (this.opts.link.connected) void this.opts.link.request("voice.wakeword", { heads: [] }).catch(() => {});
  }

  /** Loads the detector once, at the first time the audio starts. */
  private loadDetector(): void {
    if (this.detector) return;
    const d = new WakeDetector({ ...(this.opts.wake ?? {}), onWake: (score, seq, head) => this.onWake(score, seq, head), onError: (reason) => this.wakeFailed(reason) });
    this.detector = d;
    d.load().then(
      () => this.negotiate(),
      (e: unknown) => this.wakeFailed(message(e)),
    );
  }

  /**
   * The worker heard a word. The reply stops playing into the microphone, the node is told,
   * and the frames captured since a moment before the one that fired go up before the live
   * ones; until the node says `listening` (or three seconds pass) the host streams on its own
   * say-so.
   */
  private onWake(score: number, heardIn: number, head: string): void {
    if (!this.detecting || !this.opts.link.connected) return;
    this.heard.count++;
    this.heard.lastScore = Number(score.toFixed(3));
    this.heard.lastHead = head;
    this.audio.flush();
    this.detector?.reset();
    this.dispatch({ type: "heard", at: Date.now() });
    const lead = this.ring.after(heardIn - LEAD_FRAMES).filter((f) => f.seq <= heardIn).length;
    void this.opts.link.request("voice.wake", { score: Math.min(1, Math.max(0, score)), ...(head ? { head } : {}), lead }).then(
      () => this.settle(),
      (e: unknown) => {
        this.refuse("voice.wake", e);
        this.dispatch({ type: "refused", ...(codeOf(e) ? { code: codeOf(e)! } : {}) });
      },
    );
    for (const f of this.ring.after(heardIn - LEAD_FRAMES)) this.sendFrame(f.pcm);
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = undefined;
      this.dispatch({ type: "tick", at: Date.now() });
    }, PENDING_MS);
  }

  // --- frames up ---------------------------------------------------------------------------------

  private setCodecs(codecs: AudioCodec[]): void {
    this.codecList = codecs;
    this.opts.onCodecs?.(codecs);
  }

  /** The node said in its hello that it takes Opus, and this web view can make it. */
  private opusUp(): boolean {
    return this.codecList.includes("opus") && this.opts.link.state.hello?.audio?.codecs.includes("opus") === true;
  }

  private sendFrame(pcm: Int16Array): void {
    if (this.opusUp()) {
      try {
        this.encoder ??= new MicEncoder(
          (chunk) => void this.uplink.frame(chunk, "opus"),
          (e) => {
            this.log(`opus encoder: ${message(e)}`);
            this.setCodecs(["pcm"]);
          },
        );
        if (this.encoder.ok) {
          this.encoder.encode(pcm);
          return;
        }
      } catch (e) {
        this.log(`opus encoder: ${message(e)}`);
      }
      this.encoder?.close();
      this.encoder = undefined;
      this.setCodecs(["pcm"]);
    }
    void this.uplink.frame(encodeChunk(pcm), "pcm");
  }

  /** The node refused the button or a word: why, until the next one it takes. */
  private refuse(what: string, e: unknown): void {
    this.log(`${what}: ${message(e)}`);
    this.refused = message(e);
    this.changed();
  }

  private settle(): void {
    if (this.refused === undefined) return;
    delete this.refused;
    this.changed();
  }

  private changed(): void {
    this.opts.onChange?.();
  }

  private log(text: string): void {
    (this.opts.log ?? console.info)(text);
  }
}

/** A protocol error's code, from whatever a request rejected with. */
function codeOf(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
