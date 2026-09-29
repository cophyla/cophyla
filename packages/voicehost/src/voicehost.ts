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
// link already holds more than it can send. The node reads replies out only where a speaker
// plays them, so the host tells it whether its speaker is muted (`voice.presence {speaker}`),
// on every connect and whenever the user changes it.
//
// What it does not own is the host's: the link (a `Connection` from `@cophyla/viewhost`, over
// the phone's link core or the desktop's shell), the page, and the controls. The host passes
// on each frame from the node (`handleFrame`) and each change of the link (`linkChanged`), and
// calls `ptt`, `listen` and `mute` from its own buttons; `onChange` says when what it shows
// moved.
//
// The microphone is kept alive on its own. A device that goes away (unplugged, turned off)
// ends the capture, and the host asks at once for what is there now; with nothing there, it
// says the microphone is off and starts again when a device arrives. It runs on the one the
// user picked (`setMic`) whenever that is connected, and otherwise follows the system's
// default as it moves. What it runs on, and why not on the one picked, is in `view`.
//
// Whenever the microphone records an utterance, however it began (`recordingOf`), the user
// hears it: a rising tone as it starts and a falling one as it stops (cues.ts), and the host
// is handed how loud each 20 ms is meanwhile (`onLevels`), for a view to draw. The node may
// end a press the button still holds (its limit reached, the allowance used up, the utterance
// taken back): once this client's `listening` is over, recording stops and nothing more goes
// up until the button is let go and pressed again.

import type { AudioCodec, VoiceState, WakeHeadMode, WakewordMode } from "@cophyla/protocol";
import { Audio } from "./audio.ts";
import type { LinkVia, PlayStats, SpeechFrame } from "./audio.ts";
import { levelsOf } from "./cues.ts";
import { micMisplaced, micWords } from "./mics.ts";
import type { MicChoice, MicDevice, MicList } from "./mics.ts";
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
/** How long a burst of device changes (a headset shows its microphone and its speaker apart) is gathered before the host looks. */
export const DEVICES_SETTLE_MS = 400;
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
  /** The node refused the press still held, or ended it: the button no longer records. */
  talkRefused?: boolean;
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
    streaming: live && ((input.talking && input.talkRefused !== true) || input.voice === "listening" || input.pending || (input.listening && input.wake === "node")),
    // The host's wake word runs whenever the node's would have: through a reply too, so a word
    // over it interrupts, but not over the utterance itself or while the button is held.
    detecting: live && input.listening && input.wake === "phone" && !input.talking && !input.pending && !inUtterance,
  };
}

export interface RecordingInput extends RouteInput {
  /** The button was let go and the node has not yet answered: a `listening` meanwhile is the press's, already over. */
  released: boolean;
  /** The node refused the press still held, or ended it: nothing it hears is kept. */
  talkRefused: boolean;
}

/**
 * The microphone records an utterance: the button is held, the host heard a word, or the node
 * listens to this client (a word it heard, or a view's own talk button). Frames streamed only
 * so the node can hear the word are not an utterance.
 */
export function recordingOf(input: RecordingInput): boolean {
  const live = input.connected && input.audioReady && input.watching !== true;
  return live && ((input.talking && !input.talkRefused) || input.pending || (input.voice === "listening" && !input.released));
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
  /** The microphone the user picked; the system's default when absent. */
  mic?: MicChoice;
  /** Something the host shows moved. */
  onChange?: () => void;
  /** Recording an utterance started or stopped; the cue for it is already playing. */
  onRecording?: (on: boolean) => void;
  /** How loud the microphone was over the last frame, 0 to 1 per 20 ms, while it records. */
  onLevels?: (levels: number[]) => void;
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
  /** The microphone records an utterance (`recordingOf`). */
  recording: boolean;
  listening: boolean;
  muted: boolean;
  watching: boolean;
  /** The phrases the node listens for, once it said which. */
  phrases: string[];
  /** Why the microphone is not on, when it failed or its device went away. */
  micError?: string;
  /** The device the microphone runs on. */
  mic?: string;
  /** Why it runs on another than the one it did or the one picked: that one went away, or is not connected. */
  micNote?: string;
  /** The microphone picked; the system's default when absent. */
  micChoice?: MicChoice;
  /** The microphones there are, and the system's default by name, once the web view listed them. */
  mics: MicDevice[];
  defaultMic?: string;
  /** Why the node last refused the button or a heard word (nothing to transcribe with, voice off). */
  refused?: string;
}

export class VoiceHost {
  readonly audio: Audio;
  private opts: VoiceHostOptions;
  private book: WakeBook = initialWake();
  private voice?: VoiceState;
  private talking = false;
  private released = false;
  private talkRefused = false;
  private recording = false;
  private listening: boolean;
  private muted = false;
  private watching = false;
  private away = false;
  private audioReady = false;
  private micError?: string;
  private micNote?: string;
  private mics: MicList = { devices: [] };
  private devicesTimer?: ReturnType<typeof setTimeout>;
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
        if (this.recording) this.opts.onLevels?.(levelsOf(pcm));
      },
      onPlayed: (reply, stats) => {
        this.played.count++;
        this.played.last = { reply, ...stats };
        if (this.opts.link.connected) void this.opts.link.send({ jsonrpc: "2.0", method: "voice.played", params: { reply, stats } }).catch(() => {});
      },
      onNote: (message) => this.log(message),
      onMicEnded: (label) => void this.micEnded(label),
      ...(opts.workletUrl ? { workletUrl: opts.workletUrl } : {}),
    });
    if (opts.mic) this.audio.choice = opts.mic;
    // A device plugged in or pulled: the list follows, and so may the microphone.
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    media?.addEventListener?.("devicechange", () => {
      if (this.devicesTimer) clearTimeout(this.devicesTimer);
      this.devicesTimer = setTimeout(() => {
        this.devicesTimer = undefined;
        void this.devicesMoved();
      }, DEVICES_SETTLE_MS);
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
      recording: this.recording,
      listening: this.listening,
      muted: this.muted,
      watching: this.watching,
      phrases: this.heads.map((h) => h.phrase ?? h.head),
      ...(this.micError !== undefined ? { micError: this.micError } : {}),
      ...(this.audio.micDevice ? { mic: this.audio.micDevice.label } : {}),
      ...(this.micNote !== undefined ? { micNote: this.micNote } : {}),
      ...(this.audio.choice ? { micChoice: this.audio.choice } : {}),
      mics: this.mics.devices,
      ...(this.mics.defaultLabel !== undefined ? { defaultMic: this.mics.defaultLabel } : {}),
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
      this.noteMissing();
    } catch (e) {
      this.micError = micWords(e);
      this.changed();
      void this.listMics();
      throw e;
    }
    this.audioReady = true;
    this.loadDetector();
    this.refresh();
    void this.listMics();
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
        // The node ended the utterance the button still holds (its limit, the allowance, a
        // cancel): the press is over as if let go, until the button is pressed again.
        if (this.voice === "listening" && params.state !== "listening" && this.talking && !this.released) this.talkRefused = true;
        this.voice = params.state;
        // Past `listening`, the press let go has been answered.
        if (params.state !== "listening") this.released = false;
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
      this.released = false;
      this.talkRefused = false;
      this.dispatch({ type: "disconnected" });
      return;
    }
    this.detector?.reset();
    this.negotiate();
    this.tellSpeaker();
    this.refresh();
  }

  /** Whether this speaker plays, for where the node reads replies out. */
  private tellSpeaker(): void {
    if (this.opts.link.connected) void this.opts.link.send({ jsonrpc: "2.0", method: "voice.presence", params: { speaker: !this.muted } }).catch(() => {});
  }

  /** Which transport carries the link, for the jitter target. */
  setVia(via: LinkVia | undefined): void {
    this.audio.setVia(via);
  }

  // --- what the user does -----------------------------------------------------------------------

  /**
   * The button (or the key) held and let go. Let go, recording stops at once; the node's
   * `listening` for the press may still be on its way (a quick tap), and is not a new one. The
   * node says its states for a press before it answers it, so its answer ends that wait.
   */
  ptt(down: boolean): void {
    if (this.talking === down) return;
    this.talking = down;
    this.talkRefused = false;
    this.released = !down && this.opts.link.connected;
    if (down) this.detector?.reset();
    this.refresh();
    if (this.opts.link.connected) {
      const answered = (): void => {
        if (down || this.talking || !this.released) return;
        this.released = false;
        this.refresh();
      };
      void this.opts.link.request("voice.ptt", { active: down }).then(
        () => {
          this.settle();
          answered();
        },
        (e: unknown) => {
          this.refuse(`voice.ptt`, e);
          answered();
          // Refused while still held: nothing is recorded, whatever the button says.
          if (down && this.talking) {
            this.talkRefused = true;
            this.refresh();
          }
        },
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
    this.tellSpeaker();
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
    if (this.audioReady && !this.watching) await this.micAgain();
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
      void this.micAgain();
    }
    this.refresh();
  }

  /**
   * The microphone to listen on, or none for the system's default; kept by the host. Running,
   * the capture moves to it at once; off for want of a device, it is tried.
   */
  async setMic(choice: MicChoice | undefined): Promise<void> {
    if (choice) this.audio.choice = choice;
    else delete this.audio.choice;
    delete this.micNote;
    if (!this.audioReady) {
      this.changed();
      if (this.micError !== undefined) await this.start().catch(() => {});
      return;
    }
    if (this.away || this.watching) {
      this.changed();
      return;
    }
    await this.audio.mic(false);
    await this.micAgain();
  }

  /** Lists the microphones again, for a host that shows them. */
  listMics(): Promise<MicList> {
    return this.audio.microphones().then(
      (list) => {
        this.mics = list;
        this.changed();
        return list;
      },
      () => this.mics,
    );
  }

  // --- the microphone kept alive ---------------------------------------------------------------

  /**
   * The capture on again, on the pick or else the default: a failure is the microphone off,
   * with why. The word starts over once it is back.
   */
  private async micAgain(lost?: string): Promise<void> {
    try {
      await this.audio.mic(true);
    } catch (e) {
      this.micError = lost ? `${lost} went away: ${micWords(e)}` : micWords(e);
      this.log(`microphone: ${this.micError}`);
      this.changed();
      return;
    }
    delete this.micError;
    const now = this.audio.micDevice?.label;
    if (lost && now && now !== lost) this.micNote = `${lost} went away; listening on ${now} now.`;
    else this.noteMissing();
    this.detector?.reset();
    this.refresh();
  }

  /** The note when the pick is not connected and the default stands in; none otherwise. */
  private noteMissing(): void {
    const missing = this.audio.missing;
    if (missing === undefined) {
      delete this.micNote;
      return;
    }
    this.micNote = `${missing} is not connected; listening on ${this.audio.micDevice?.label ?? "the default microphone"} until it is.`;
  }

  /** The device under the capture went away: said at once, then whatever is there now is asked for. */
  private async micEnded(label: string): Promise<void> {
    this.micError = `${label} went away: unplugged, or turned off`;
    this.changed();
    if (!this.audioReady || this.away || this.watching) return;
    await this.listMics();
    await this.micAgain(label);
  }

  /**
   * Devices moved. With no microphone at all, one that arrived is started; running, the
   * capture moves back to the pick once it is connected again, or to the default when that moved.
   */
  private async devicesMoved(): Promise<void> {
    const list = await this.listMics();
    if (this.away || this.watching) return;
    if (!this.audioReady) {
      if (this.micError !== undefined) await this.start().catch(() => {});
      return;
    }
    const current = this.audio.micDevice;
    if (!current) {
      await this.micAgain();
      return;
    }
    if (!micMisplaced(current, this.audio.choice, list)) return;
    this.log(`microphone: moving off ${current.label}`);
    await this.audio.mic(false);
    await this.micAgain();
  }

  private letGo(): void {
    if (this.talking && this.opts.link.connected) void this.opts.link.request("voice.ptt", { active: false }).catch(() => {});
    this.talking = false;
  }

  // --- where frames go -----------------------------------------------------------------------------

  private refresh(): void {
    const input: RouteInput = {
      connected: this.opts.link.connected,
      audioReady: this.audioReady && !this.away,
      watching: this.watching,
      talking: this.talking,
      talkRefused: this.talkRefused,
      ...(this.voice ? { voice: this.voice } : {}),
      pending: this.book.pending,
      listening: this.listening,
      wake: this.book.mode,
    };
    const r = route(input);
    this.streaming = r.streaming;
    this.detecting = r.detecting;
    // Recording started or stopped, however it began: the tone at once, then the host.
    const recording = recordingOf({ ...input, released: this.released, talkRefused: this.talkRefused });
    if (recording !== this.recording) {
      this.recording = recording;
      this.audio.cue(recording ? "start" : "stop");
      this.opts.onRecording?.(recording);
    }
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
