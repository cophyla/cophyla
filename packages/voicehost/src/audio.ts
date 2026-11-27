// A client's microphone and speaker — the phone's, the desktop app's — each behind its own
// `AudioContext`, both started by one user gesture (browsers only let a page start one from
// a gesture, so in the phone's browser everything here starts at the Start button; the
// apps' web views are let start it at launch). Capture asks for 16 kHz, so the browser's
// resampler feeds the worklet the 16 kHz int16 frames the wake word was validated on.
// Playback runs at the device's own rate, so speech at 24 kHz is not squeezed through a
// 16 kHz context.
//
// Playback is a jitter buffer. Speech arriving while nothing plays is held until enough of
// it is buffered (the target), or the target's time has passed since the first slice, or
// the reply's end came; then it is scheduled end to end on a playhead. The target starts
// low on the LAN and higher on the relay; a slice that arrives after its turn mid-reply is
// an underrun, which holds again and raises the target, and a reply that played clean
// lowers it again. When a reply's end has come and its last slice has played, `onPlayed`
// says so with how it went: the node holds `speaking` until then.
//
// The queue is flushed whenever the node says the conversation is no longer speaking: the
// node stops sending mid-sentence on a barge-in, and the phone must stop playing it too.
//
// Each frame comes with when it was captured, epoch ms: the worklet stamps it with the audio
// clock and the page maps that to the wall clock as it arrives (clock.ts), so a frame taken
// late from a busy page still says when it was spoken.
//
// Capture runs on the microphone picked (`choice`) when it is connected, on the system's
// default otherwise (mics.ts). A device that goes away ends its track: the capture is taken
// down and `onMicEnded` says whose it was, for the host to ask again. Turning the microphone
// on and off is queued, so a switch never races a pause.
//
// The tones that say recording started and stopped (cues.ts) play on the speaker's context
// too, straight to its output: muting the replies leaves them.

import { CaptureClock } from "./clock.ts";
import { playCue } from "./cues.ts";
import type { CueKind } from "./cues.ts";
import { listMics, listSpeakers, resolveMic } from "./mics.ts";
import type { MicChoice, MicInUse, MicList } from "./mics.ts";
import { decodeChunk, toFloat } from "./pcm.ts";
import { SpeechDecoder } from "./opus.ts";
import type { CapturedFrame } from "./worklet.ts";

/** Which way a link runs, as far as playback cares: on the LAN (or the machine itself), through the relay, or on a data channel. */
export type LinkVia = "lan" | "relay" | "p2p";

export const OUT_RATE = 24000;
export const IN_RATE = 16000;
/** Held audio starts this far ahead of now, so the first slice is never clipped. */
const LEAD_S = 0.02;
/** The jitter target: where it starts on each transport, how it moves, and where it stops. */
export const TARGET_LAN_MS = 80;
export const TARGET_RELAY_MS = 300;
export const TARGET_UP_MS = 100;
export const TARGET_DOWN_MS = 20;
export const TARGET_MAX_MS = 1000;

/** How a reply played: what `voice.played` carries. */
export interface PlayStats {
  underruns: number;
  maxLateMs: number;
  targetMs: number;
  frames: number;
}

export interface Timers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: Timers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Reply {
  ended: boolean;
  /** Sources scheduled and not yet finished. */
  playing: number;
  /** Some of it has been scheduled: a slice late after that is an underrun. */
  started: boolean;
  underruns: number;
  maxLateMs: number;
  frames: number;
}

/** Replies from a node that does not number them. */
const UNNUMBERED = -1;

export interface PlaybackOptions {
  floorMs?: number;
  onPlayed?: (reply: number, stats: PlayStats) => void;
  timers?: Timers;
}

export class PlaybackQueue {
  private ctx: AudioContext;
  private out: AudioNode;
  private timers: Timers;
  private onPlayed?: (reply: number, stats: PlayStats) => void;
  private playhead = 0;
  private sources = new Set<AudioBufferSourceNode>();
  /** Slices waiting for the buffer to fill, and since when. */
  private held: { buffer: AudioBuffer; reply: number }[] = [];
  private heldS = 0;
  private holdTimer?: unknown;
  private replies = new Map<number, Reply>();
  private floor: number;
  private target: number;
  muted = false;

  constructor(ctx: AudioContext, out: AudioNode, opts: PlaybackOptions = {}) {
    this.ctx = ctx;
    this.out = out;
    this.timers = opts.timers ?? REAL_TIMERS;
    if (opts.onPlayed) this.onPlayed = opts.onPlayed;
    this.floor = opts.floorMs ?? TARGET_LAN_MS;
    this.target = this.floor;
  }

  /** How much is scheduled and not yet played. */
  get queuedMs(): number {
    return Math.max(0, (this.playhead - this.ctx.currentTime) * 1000);
  }

  get targetMs(): number {
    return this.target;
  }

  get holding(): boolean {
    return this.held.length > 0;
  }

  /** The link moved to another transport: the target starts again from its floor. */
  setFloor(ms: number): void {
    this.floor = ms;
    this.target = ms;
  }

  private reply(id: number): Reply {
    let r = this.replies.get(id);
    if (!r) {
      r = { ended: false, playing: 0, started: false, underruns: 0, maxLateMs: 0, frames: 0 };
      this.replies.set(id, r);
    }
    return r;
  }

  /** A slice of speech at `rate`, for reply `reply` when the node numbers them; `asked` plays even while muted (a message the user asked to hear). */
  enqueue(pcm: Int16Array | Float32Array, rate = OUT_RATE, reply = UNNUMBERED, asked = false): void {
    if (pcm.length === 0) return;
    const r = this.reply(reply);
    r.frames++;
    if (this.muted && !asked) return;
    const buffer = this.ctx.createBuffer(1, pcm.length, rate);
    buffer.getChannelData(0).set(pcm instanceof Float32Array ? pcm : toFloat(pcm));
    const now = this.ctx.currentTime;
    if (this.held.length > 0) {
      this.hold(buffer, reply);
      return;
    }
    if (this.playhead > now) {
      // Playing: this slice follows the last one exactly.
      this.schedule(buffer, reply);
      return;
    }
    if (r.started && !r.ended) {
      // Mid-reply and the playhead already passed: the network fell behind the speaker.
      r.underruns++;
      r.maxLateMs = Math.max(r.maxLateMs, (now - this.playhead) * 1000);
      this.target = Math.min(TARGET_MAX_MS, this.target + TARGET_UP_MS);
    }
    this.hold(buffer, reply);
  }

  /** The reply's last frame came: whatever is held of it plays now. */
  end(reply: number): void {
    const r = this.reply(reply);
    r.ended = true;
    if (this.held.length > 0) this.release();
    this.check(reply);
  }

  private hold(buffer: AudioBuffer, reply: number): void {
    if (this.held.length === 0) {
      this.heldS = 0;
      this.holdTimer = this.timers.setTimeout(() => {
        this.holdTimer = undefined;
        this.release();
      }, this.target);
    }
    this.held.push({ buffer, reply });
    this.heldS += buffer.duration;
    if (this.heldS * 1000 >= this.target) this.release();
  }

  /** The held slices, end to end from a moment ahead of now. */
  private release(): void {
    if (this.holdTimer !== undefined) this.timers.clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    const held = this.held;
    this.held = [];
    this.heldS = 0;
    this.playhead = Math.max(this.playhead, this.ctx.currentTime + LEAD_S);
    for (const h of held) this.schedule(h.buffer, h.reply);
  }

  private schedule(buffer: AudioBuffer, reply: number): void {
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.out);
    source.start(this.playhead);
    this.playhead += buffer.duration;
    this.sources.add(source);
    const r = this.reply(reply);
    r.started = true;
    r.playing++;
    source.onended = () => {
      if (!this.sources.delete(source)) return;
      r.playing--;
      this.check(reply);
    };
  }

  /** A reply whose end came and whose last slice finished: told, and a clean one lowers the target. */
  private check(reply: number): void {
    const r = this.replies.get(reply);
    if (!r || !r.ended || r.playing > 0 || this.held.some((h) => h.reply === reply)) return;
    this.replies.delete(reply);
    if (r.underruns === 0) this.target = Math.max(this.floor, this.target - TARGET_DOWN_MS);
    if (reply !== UNNUMBERED) this.onPlayed?.(reply, { underruns: r.underruns, maxLateMs: Math.round(r.maxLateMs), targetMs: this.target, frames: r.frames });
  }

  /** Stops everything scheduled and held: the node changed its mind about what it was saying. */
  flush(): void {
    if (this.holdTimer !== undefined) this.timers.clearTimeout(this.holdTimer);
    this.holdTimer = undefined;
    this.held = [];
    this.heldS = 0;
    const sources = [...this.sources];
    this.sources.clear();
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        // already finished
      }
    }
    this.replies.clear();
    this.playhead = 0;
  }
}

export interface AudioInfo {
  sampleRate: number;
  playbackRate?: number;
  state: string;
  track?: MediaTrackSettings;
}

/** A `voice.audio` frame from the node, as it came. */
export interface SpeechFrame {
  chunk: string;
  codec?: "opus" | "pcm";
  rate?: number;
  reply?: number;
  end?: boolean;
  /** The user asked to hear it: played even while muted. */
  asked?: boolean;
}

export interface AudioDeps {
  /** Every 40 ms frame the microphone produced, and when its last sample was captured (epoch ms); where each goes is the app's to decide. */
  onFrame: (pcm: Int16Array, at: number) => void;
  /** A numbered reply finished playing here. */
  onPlayed?: (reply: number, stats: PlayStats) => void;
  /** Where the worklet module is served from. */
  workletUrl?: string;
  /** The microphone's device went away (unplugged, turned off): capture is down, and this was its name. */
  onMicEnded?: (label: string) => void;
  onNote?: (message: string) => void;
}

/** An `AudioContext` that can play on a device of its own: Chromium's `setSinkId`, `""` for the system's default. */
type SinkContext = AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };

export class Audio {
  private deps: AudioDeps;
  private ctx?: AudioContext;
  private out?: AudioContext;
  private stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private node?: AudioWorkletNode;
  /** Turning the microphone on and off, one after another. */
  private micQueue: Promise<void> = Promise.resolve();
  /** The microphone the user picked; the system's default when none. */
  choice?: MicChoice;
  /** The pick's name, when capture last started on the default because it was not connected. */
  missing?: string;
  /** The speaker the user picked; the system's default when none. */
  speaker?: MicChoice;
  /** The speaker pick's name, while speech plays on the default because it is not connected. */
  speakerMissing?: string;
  /** The device speech plays on now, by the web view's id; `""` is the system's default. */
  private sink = "";
  private playback?: PlaybackQueue;
  private decoder?: SpeechDecoder;
  private opening?: Promise<void>;
  private floorMs = TARGET_LAN_MS;
  /** When the last cue ends, on the speaker's clock. */
  private cueEnd = 0;
  /** Bumped by a flush, so speech still being decoded from before it is dropped. */
  private generation = 0;
  /** The capture's audio clock on the wall clock. */
  private clock = new CaptureClock();
  /** Frames dropped because they could not be decoded, and what came in each codec. */
  readonly counts = { pcm: 0, opus: 0, undecodable: 0 };

  constructor(deps: AudioDeps) {
    this.deps = deps;
  }

  get context(): AudioContext | undefined {
    return this.ctx;
  }

  get queue(): PlaybackQueue | undefined {
    return this.playback;
  }

  get info(): AudioInfo | undefined {
    if (!this.ctx) return undefined;
    const track = this.stream?.getAudioTracks()[0]?.getSettings();
    return { sampleRate: this.ctx.sampleRate, ...(this.out ? { playbackRate: this.out.sampleRate } : {}), state: this.ctx.state, ...(track ? { track } : {}) };
  }

  /** Which transport carries the link: the jitter target starts from its floor, the LAN's or, off the LAN (the relay, a data channel), the relay's. */
  setVia(via: LinkVia | undefined): void {
    this.floorMs = via === "relay" || via === "p2p" ? TARGET_RELAY_MS : TARGET_LAN_MS;
    this.playback?.setFloor(this.floorMs);
  }

  /**
   * The contexts, the worklet and the playback chain, once: inside the Start gesture in a
   * browser, at launch in the app. A second call resumes the contexts — a tap unsticks a
   * first call the page was not yet allowed to start — and waits for the first.
   */
  open(): Promise<void> {
    const opening = this.opening;
    if (opening) return this.resume().then(() => opening);
    const next = this.build();
    this.opening = next;
    next.catch(() => {
      if (this.opening === next) this.opening = undefined;
    });
    return next;
  }

  private async build(): Promise<void> {
    let ctx: AudioContext;
    try {
      // 16 kHz asks the browser to resample for us; Android often refuses and runs at 48 kHz.
      ctx = new AudioContext({ sampleRate: IN_RATE });
    } catch {
      ctx = new AudioContext();
    }
    // The speaker's own context, at the device's rate, made in the same gesture.
    const out = new AudioContext();
    this.ctx = ctx;
    this.out = out;
    try {
      await Promise.all([ctx.resume(), out.resume()]);
      await ctx.audioWorklet.addModule(this.deps.workletUrl ?? "worklet.js");
    } catch (e) {
      this.ctx = undefined;
      this.out = undefined;
      void ctx.close().catch(() => {});
      void out.close().catch(() => {});
      throw e;
    }
    const gain = out.createGain();
    gain.gain.value = 1;
    gain.connect(out.destination);
    this.playback = new PlaybackQueue(out, gain, { floorMs: this.floorMs, ...(this.deps.onPlayed ? { onPlayed: this.deps.onPlayed } : {}) });
    this.deps.onNote?.(`audio ${ctx.sampleRate} Hz in, ${out.sampleRate} Hz out, ${ctx.state}`);
  }

  /** The microphone is captured: frames are coming, however late the page takes them. */
  get capturing(): boolean {
    return this.node !== undefined && this.ctx?.state === "running";
  }

  /** How far the capture has got, on the wall clock (epoch ms): frames up to here were captured, if not yet taken. */
  get capturedTo(): number | undefined {
    return this.ctx && this.node ? this.clock.at(this.ctx.currentTime) : undefined;
  }

  /** The device capture runs on, while it runs. */
  get micDevice(): MicInUse | undefined {
    const track = this.stream?.getAudioTracks()[0];
    if (!track || track.readyState === "ended") return undefined;
    const s = track.getSettings();
    return { label: track.label || "the microphone", ...(s.deviceId ? { id: s.deviceId } : {}), ...(s.groupId ? { groupId: s.groupId } : {}) };
  }

  /** The microphones the web view lists; none where it cannot list them. */
  async microphones(): Promise<MicList> {
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (!media?.enumerateDevices) return { devices: [] };
    return listMics(media);
  }

  /** Whether this web view can play on a speaker other than the system's default (`AudioContext.setSinkId`). */
  static get canPickSpeaker(): boolean {
    return typeof AudioContext !== "undefined" && typeof (AudioContext.prototype as SinkContext).setSinkId === "function";
  }

  /** The speakers the web view lists; none where it cannot list them or cannot play on one. */
  async speakers(): Promise<MicList> {
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
    if (!media?.enumerateDevices || !Audio.canPickSpeaker) return { devices: [] };
    return listSpeakers(media);
  }

  /**
   * Speech and cues play on the pick when it is connected, else on the system's default; once
   * the speaker's context is up. Called when the pick changes and whenever devices come and go.
   */
  async routeSpeaker(list: MicList): Promise<void> {
    const want = resolveMic(this.speaker, list);
    if (want.missing !== undefined) this.speakerMissing = want.missing;
    else delete this.speakerMissing;
    const sink = want.id ?? "";
    const out = this.out as SinkContext | undefined;
    if (!out?.setSinkId || sink === this.sink) return;
    try {
      await out.setSinkId(sink);
      this.sink = sink;
      this.deps.onNote?.(`speaker: ${sink === "" ? "the system's default" : (list.devices.find((d) => d.id === sink)?.label ?? sink)}`);
    } catch (e) {
      this.deps.onNote?.(`speaker: could not play on it: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Asks for the microphone and starts the worklet, or stops both; idempotent, and each call waits for the one before. */
  mic(on: boolean): Promise<void> {
    const next = this.micQueue.then(() => (on ? this.micOn() : this.micOff()));
    this.micQueue = next.catch(() => {});
    return next;
  }

  private micOff(): void {
    this.source?.disconnect();
    this.source = undefined;
    this.node?.disconnect();
    this.node = undefined;
    for (const track of this.stream?.getAudioTracks() ?? []) track.stop();
    this.stream = undefined;
  }

  private async micOn(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || this.node) return;
    // The pick is looked for among what is connected now; gone, the default stands in.
    const want = this.choice ? resolveMic(this.choice, await this.microphones().catch(() => ({ devices: [] }))) : {};
    if (want.missing !== undefined) this.missing = want.missing;
    else delete this.missing;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...(want.id !== undefined ? { deviceId: { exact: want.id } } : {}), channelCount: 1, sampleRate: IN_RATE, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    this.stream = stream;
    const track = stream.getAudioTracks()[0];
    // `stop()` never fires it: only the device itself going away does.
    track?.addEventListener("ended", () => this.micEnded(stream));
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "capture");
    this.clock.reset();
    node.port.onmessage = (ev: MessageEvent) => {
      const arrived = Date.now();
      const data = ev.data as CapturedFrame | ArrayBuffer;
      // A worklet from before the frames were stamped posts the bare buffer: captured as it arrives.
      if (data instanceof ArrayBuffer) this.deps.onFrame(new Int16Array(data), arrived);
      else this.deps.onFrame(new Int16Array(data.pcm), this.clock.wall(data.t, arrived));
    };
    source.connect(node);
    // A silent gain keeps the graph running without the user hearing themselves.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute);
    mute.connect(ctx.destination);
    this.source = source;
    this.node = node;
    this.deps.onNote?.(`microphone on: ${track?.label ?? "a device"}`);
  }

  /** The device under the capture went away: it is taken down, and the host is told whose it was. */
  private micEnded(stream: MediaStream): void {
    if (this.stream !== stream) return;
    const label = stream.getAudioTracks()[0]?.label || "The microphone";
    this.deps.onNote?.(`microphone ended: ${label}`);
    void this.mic(false).then(() => this.deps.onMicEnded?.(label));
  }

  /**
   * The tone that says recording started or stopped, on the speaker's context and around the
   * replies' mute, which quiets replies alone. One that comes while the last still sounds
   * waits for it, so a press let go at once is still heard as up then down.
   */
  cue(kind: CueKind): void {
    const out = this.out;
    if (!out || out.state === "closed") return;
    try {
      this.cueEnd = playCue(out, kind, this.cueEnd);
    } catch (e) {
      this.deps.onNote?.(`cue: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Speech from the node: decoded by its codec and queued at its rate; the reply's end is passed on after its last samples. */
  play(frame: SpeechFrame): void {
    const queue = this.playback;
    if (!queue) return;
    const rate = frame.rate ?? OUT_RATE;
    const reply = frame.reply ?? UNNUMBERED;
    if (frame.codec === "opus") {
      this.counts.opus++;
      this.decoder ??= new SpeechDecoder();
      const generation = this.generation;
      const current = () => this.playback === queue && this.generation === generation;
      void this.decoder.decode(frame.chunk, rate).then(
        (d) => {
          if (!current()) return;
          queue.enqueue(d.samples, d.rate, reply, frame.asked === true);
          if (frame.end) queue.end(reply);
        },
        () => {
          this.counts.undecodable++;
          if (current() && frame.end) queue.end(reply);
        },
      );
      return;
    }
    this.counts.pcm++;
    queue.enqueue(decodeChunk(frame.chunk), rate, reply, frame.asked === true);
    if (frame.end) queue.end(reply);
  }

  flush(): void {
    this.generation++;
    this.playback?.flush();
  }

  async resume(): Promise<void> {
    if (this.ctx && this.ctx.state === "suspended") {
      // The audio clock stood still meanwhile: its offset from the wall clock is found again.
      this.clock.reset();
      await this.ctx.resume();
    }
    if (this.out && this.out.state === "suspended") await this.out.resume();
  }

  async close(): Promise<void> {
    await this.mic(false);
    this.playback?.flush();
    this.decoder?.close();
    this.decoder = undefined;
    await Promise.all([this.ctx?.close().catch(() => {}), this.out?.close().catch(() => {})]);
    this.sink = "";
    this.ctx = undefined;
    this.out = undefined;
    this.playback = undefined;
    this.opening = undefined;
  }
}
