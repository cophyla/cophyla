// The voice module: three stages, one conversation per controller, and the fan-out between
// them and the rest of the daemon. The stages load in the background at start, so a daemon
// with voice on is up as fast as one without and a model that takes a minute to fetch
// delays nothing; each stage reports itself through the node's capabilities as it comes up.
//
// Audio belongs to one controller at a time. A frame arrives as a `voice.audio` signal and
// goes to that controller's conversation; speech goes back to that one controller and to no
// other client, because a phone in another room should not start talking. What every client
// does hear is `voice.state`, which names the controller the conversation belongs to, so the
// desktop app can show what the phone is doing.
//
// The wake word listens for several phrases at once, a keyword head each. It is heard on the
// phone when the phone can run every head the node listens with: it says which heads it
// carries with `voice.wakeword`, and from then on sends audio only after `voice.wake`. A
// controller that never asks — an older app, a phone without one of the heads — streams while
// it listens and the node detects the words for it, as before. The desktop app is a client
// like the phone in this: it carries the same heads and hears the words itself.
//
// Audio goes as Opus both ways when the controller says it speaks it (`audio.codecs`), and
// as PCM otherwise: a frame up names its codec, and the speech down is encoded once per
// conversation in the codec the controller asked for, each frame numbered within its reply.
//
// The engine that speaks is config.toml's unless the app picked another (`voice.configure`),
// which is kept in the store over it, with a voice per engine. A new pick loads behind the
// answer while the engine before it goes on speaking, and takes its place once it is up; a
// new voice for the same engine needs no load at all.

import { RpcError } from "@cophyla/protocol";
import type { AudioCodec, Client, ClientSignalName, clientSignals, ContentBlock, TtsEngineId, TtsEngineInfo, VoiceSettings, VoiceState, WakewordMode } from "@cophyla/protocol";
import type { z } from "zod";
import type { Bus } from "../bus.ts";
import type { Activity } from "../chat/activity.ts";
import type { Chat } from "../chat/index.ts";
import type { VoiceConfig } from "../config/schema.ts";
import type { Logger } from "../log.ts";
import type { Sidecars } from "../sidecars/index.ts";
import type { ClientRegistry } from "../api/clients.ts";
import { composeSpeech } from "./compose.ts";
import type { SpeechNames } from "./compose.ts";
import { Conversation } from "./conversation.ts";
import { OpusDecoder, OpusEncoder, opusRate } from "./opus.ts";
import type { EngineFactory, ModelResolver, SttEngine, TtsEngine, VadEngine, WakeModel } from "./engines.ts";
import { IN_RATE } from "./engines.ts";
import type { StageState } from "./engines.ts";
import { sherpaEngine, STT_MODEL, TTS_MODELS, VAD_MODEL, WAKE_MODEL } from "./local.ts";
import type { VoicePrefs, VoicePrefsStore } from "./prefs.ts";

type VoiceSetup = import("@cophyla/protocol").ClientNotificationParams<"voice.setup">;

/** Bytes of one `voice.audio` frame; a bigger one is dropped rather than decoded. */
const MAX_CHUNK_BYTES = 64 * 1024;

/** How long `voice.wakeword` waits on a wake stage still loading before it answers `node`. */
export const WAKE_WAIT_MS = 10_000;

/** The codecs the node takes and sends, best first; told to every client in its `hello`. */
export const AUDIO_CODECS: AudioCodec[] = ["opus", "pcm"];

/** The engines the app offers, in the order it lists them. */
export const TTS_ENGINES: TtsEngineInfo[] = [
  { id: "piper", label: "Piper", detail: "The fastest: it starts speaking about a tenth of a second after the reply. English." },
  { id: "kokoro", label: "Kokoro", detail: "Sounds the most natural, but takes a second or more to start, longer on a busy computer. English." },
  { id: "supertonic", label: "Supertonic", detail: "Fast, and speaks 31 languages." },
  { id: "chatterbox", label: "Chatterbox", detail: "Your own voice, cloned from a clip. Needs an NVIDIA graphics card and a one-time download of several gigabytes." },
  { id: "server", label: "Hosted", detail: "Your account's hosted voice, over the internet." },
  { id: "off", label: "Off", detail: "Replies are shown, not spoken." },
];

/** What a preview says when the app gives it nothing to say. */
export const PREVIEW_LINE = "This is how I sound. I'll read my replies to you like this.";

type SignalParams<N extends ClientSignalName> = z.infer<(typeof clientSignals)[N]>;

/** One conversation's codecs: the decoder for its microphone, and its speech's encoder and numbering. */
interface Codecs {
  decoder?: OpusDecoder;
  encoder?: OpusEncoder;
  reply: number;
  seq: number;
}

export type StageName = "wake" | "stt" | "tts";

export interface VoiceDeps {
  config: VoiceConfig;
  /** `<home>/data`. */
  dataDir: string;
  bus: Bus;
  log: Logger;
  clients: ClientRegistry;
  chat: Chat;
  activity: Activity;
  models: ModelResolver;
  sidecars: Sidecars;
  engines: EngineFactory;
  /** The account's hosted engines, taken when a stage is configured as `server`. */
  hosted?: { stt: () => SttEngine; tts: () => TtsEngine };
  /** What the things a reply points at are called, when it is read out. */
  names?: SpeechNames;
  /** A stage came up or went down: the node's capabilities changed. */
  onStageChange?: () => void;
  /** The app's picks; config.toml alone when absent. */
  prefs?: VoicePrefsStore;
  now?: () => number;
}

export class Voice {
  private deps: VoiceDeps;
  private log: Logger;
  private config: VoiceConfig;
  private stages: Record<StageName, StageState>;
  private wakeModel?: WakeModel;
  private makeVad?: () => VadEngine;
  private sttEngine?: SttEngine;
  private ttsEngine?: TtsEngine;
  private conversations = new Map<string, Conversation>();
  private codecs = new Map<string, Codecs>();
  /** The controllers that detect the wake word themselves: the node runs none over their frames. */
  private phoneWake = new Set<string>();
  /** The controller whose utterance is being answered: where the reply is spoken. */
  private active?: string;
  private lastSetup?: VoiceSetup;
  /** Counts speech loads, so one a newer pick overtook is dropped when it lands. */
  private ttsLoads = 0;
  private unsubscribe: (() => void)[] = [];
  private stopped = false;
  private loading?: Promise<void>;
  /** The wake stage's latest load, settled once it is ready or unavailable. */
  private wakeLoading?: Promise<void>;
  /** Settles once `start` has run: the daemon takes clients seconds before it starts voice. */
  private begun: Promise<void>;
  private markBegun!: () => void;

  constructor(deps: VoiceDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.config = deps.config;
    const off: StageState = { status: "off" };
    this.stages = { wake: { ...off }, stt: { ...off }, tts: { ...off } };
    this.begun = new Promise((resolve) => (this.markBegun = resolve));
  }

  // --- lifecycle ---------------------------------------------------------------------------

  /** Returns at once; the engines load behind it and each stage reports itself as it comes up. */
  async start(): Promise<void> {
    try {
      await this.begin();
    } finally {
      this.markBegun();
    }
  }

  private async begin(): Promise<void> {
    if (!this.config.enabled) {
      this.log.info("voice off");
      return;
    }
    this.unsubscribe.push(
      // A reply that was not spoken still ends the turn on the phone.
      this.deps.bus.on("chat.message", (message) => {
        if (message.role !== "orchestrator") return;
        const active = this.active ? this.conversations.get(this.active) : undefined;
        active?.replyArrived();
      }),
    );
    this.loading = this.load();
    // Failures are reported per stage; nothing here throws into the daemon's start.
    void this.loading.catch(() => {});
  }

  /** For the tests and the live check: waits for every stage to settle. */
  ready(): Promise<void> {
    return this.loading ?? Promise.resolve();
  }

  private async load(): Promise<void> {
    this.wakeLoading = this.loadWake();
    await Promise.all([this.wakeLoading, this.loadStt(), this.loadTts()]);
    this.log.info("voice stages", { wake: this.stages.wake.status, stt: this.stages.stt.status, tts: this.stages.tts.status });
  }

  private setStage(name: StageName, state: StageState): void {
    const before = this.stages[name].status;
    this.stages[name] = state;
    if (before !== state.status) this.deps.onStageChange?.();
  }

  private async stage(name: StageName, engine: string, run: () => Promise<void>): Promise<void> {
    this.setStage(name, { status: "loading", engine });
    try {
      await run();
      this.setStage(name, { status: "ready", engine });
      this.log.info("voice stage ready", { stage: name, engine });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.setStage(name, { status: "unavailable", engine, reason });
      this.log.warn("voice stage unavailable", { stage: name, engine, reason });
    }
  }

  /** The models this configuration's engines need; a factory that needs none asks for none. */
  private needed(): Set<string> {
    return new Set(this.deps.engines.models(this.effective()));
  }

  private prefs(): VoicePrefs {
    return this.deps.prefs?.read() ?? {};
  }

  /** config.toml with the app's picks over it: the engine, and its voice when one was set for it. */
  private effective(): VoiceConfig {
    const prefs = this.prefs();
    const tts = prefs.tts ?? this.config.tts;
    const voice = prefs.voices?.[tts] ?? (tts === this.config.tts ? this.config.tts_voice : undefined);
    const out: VoiceConfig = { ...this.config, tts };
    if (voice === undefined) delete out.tts_voice;
    else out.tts_voice = voice;
    return out;
  }

  /** The directory of a model the engines want, or `""` for one they do not use. */
  private async dir(model: string): Promise<string> {
    if (!this.needed().has(model)) return "";
    const dir = await this.deps.models.resolve(model);
    if (!dir) throw new Error(`the ${model} model is not available`);
    return dir;
  }

  private async loadWake(): Promise<void> {
    if (this.config.wake === "off") return;
    await this.stage("wake", "openwakeword", async () => {
      this.wakeModel = await this.deps.engines.wake(await this.dir(WAKE_MODEL), this.config);
    });
    // A controller that streamed before the model was loaded is listened to from now on.
    const model = this.wakeModel;
    if (this.stopped || !model || this.stages.wake.status !== "ready") return;
    for (const c of this.conversations.values()) if (!this.phoneWake.has(c.client)) c.useWake(model.stream());
  }

  private async loadStt(): Promise<void> {
    if (this.config.stt === "off") return;
    const engine = this.config.stt;
    await this.stage("stt", engine, async () => {
      // The VAD is local either way: it closes the utterance the hosted recogniser then reads whole.
      this.makeVad = await this.deps.engines.vad(await this.dir(VAD_MODEL), this.config);
      if (engine === "server") {
        if (!this.deps.hosted) throw new Error("no hosted transcription on this node");
        this.sttEngine = this.deps.hosted.stt();
      } else this.sttEngine = await this.deps.engines.stt(await this.dir(STT_MODEL), this.config);
    });
  }

  /**
   * Loads the engine the configuration names and puts it in place of the one speaking, which
   * goes on speaking until then. A load a newer pick overtook is dropped when it lands; one
   * that fails leaves nothing speaking, and the stage says why.
   */
  private async loadTts(): Promise<void> {
    const config = this.effective();
    const engine = config.tts;
    const load = ++this.ttsLoads;
    const current = () => load === this.ttsLoads && !this.stopped;
    if (engine === "off") {
      this.swapTts(undefined);
      this.setStage("tts", { status: "off" });
      return;
    }
    this.setStage("tts", { status: "loading", engine });
    try {
      let next: TtsEngine;
      if (engine === "server") {
        if (!this.deps.hosted) throw new Error("no hosted speech on this node");
        next = this.deps.hosted.tts();
      } else {
        const local = sherpaEngine(engine);
        const dir = local ? (await this.dir(TTS_MODELS[local])) || undefined : undefined;
        next = await this.deps.engines.tts(dir, config, this.deps.sidecars);
      }
      if (!current()) {
        void Promise.resolve(next.close()).catch(() => {});
        return;
      }
      // A voice picked while the engine loaded is its voice from the first line.
      const voice = this.effective().tts_voice;
      if (voice !== config.tts_voice) next.useVoice?.(voice);
      this.swapTts(next);
      this.setStage("tts", { status: "ready", engine });
      this.log.info("voice stage ready", { stage: "tts", engine });
    } catch (e) {
      if (!current()) return;
      const reason = e instanceof Error ? e.message : String(e);
      this.swapTts(undefined);
      this.setStage("tts", { status: "unavailable", engine, reason });
      this.log.warn("voice stage unavailable", { stage: "tts", engine, reason });
    }
  }

  private swapTts(next: TtsEngine | undefined): void {
    const before = this.ttsEngine;
    this.ttsEngine = next;
    if (before && before !== next) void Promise.resolve(before.close()).catch(() => {});
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ttsLoads++;
    // A `voice.wakeword` still waiting for voice to start is answered now.
    this.markBegun();
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    for (const c of this.conversations.values()) c.dispose();
    this.conversations.clear();
    for (const id of [...this.codecs.keys()]) this.dropCodecs(id);
    this.phoneWake.clear();
    await Promise.allSettled([this.wakeModel?.close(), this.sttEngine?.close(), this.ttsEngine?.close()]);
    this.wakeModel = undefined;
    this.sttEngine = undefined;
    this.ttsEngine = undefined;
    this.makeVad = undefined;
  }

  // --- state ------------------------------------------------------------------------------

  /** What the node says it can do: a stage counts only once its engine is loaded. */
  capabilities(): { wake: boolean; stt: boolean; tts: boolean } {
    return { wake: this.stages.wake.status === "ready", stt: this.stages.stt.status === "ready", tts: this.stages.tts.status === "ready" };
  }

  stageStates(): Record<StageName, StageState> {
    return { wake: { ...this.stages.wake }, stt: { ...this.stages.stt }, tts: { ...this.stages.tts } };
  }

  /** What a client that just said hello is told: the conversations in flight, and any setup running. */
  snapshot(): { states: { state: VoiceState; client?: string }[]; setup: VoiceSetup[] } {
    const states: { state: VoiceState; client?: string }[] = [];
    for (const c of this.conversations.values()) if (c.busy) states.push({ state: c.current, client: c.client });
    return { states, setup: this.lastSetup ? [this.lastSetup] : [] };
  }

  /** No conversation is running: a staged model may take the place of one in use. */
  idle(): boolean {
    for (const c of this.conversations.values()) if (c.busy) return false;
    return true;
  }

  /** The node's speech as the app's Settings shows it. */
  settings(): VoiceSettings {
    const prefs = this.prefs();
    const config = this.effective();
    const engine = this.ttsEngine && this.ttsEngine.name === config.tts ? this.ttsEngine : undefined;
    const voice = config.tts_voice ?? engine?.voice;
    const stage = this.stages.tts;
    return {
      enabled: this.config.enabled,
      tts: config.tts,
      source: prefs.tts !== undefined || prefs.voices?.[config.tts] !== undefined ? "app" : "config",
      ...(voice !== undefined ? { voice } : {}),
      ...(engine?.voices !== undefined ? { voices: engine.voices } : {}),
      stage: { status: stage.status, ...(stage.reason !== undefined ? { reason: stage.reason } : {}), ...(stage.engine !== undefined ? { engine: stage.engine } : {}) },
      engines: TTS_ENGINES,
    };
  }

  /**
   * `voice.configure`: the engine or its voice, set over config.toml, `null` handing either
   * back. A new engine loads behind the answer; a new voice for the one loaded is used from
   * its next line.
   */
  configure(patch: { tts?: TtsEngineId | null; voice?: number | null }): VoiceSettings {
    if (!this.deps.prefs) throw new RpcError("unavailable", "this node keeps no voice settings");
    const before = this.effective();
    const prefs: VoicePrefs = { ...this.prefs() };
    if (patch.tts === null) delete prefs.tts;
    else if (patch.tts !== undefined) prefs.tts = patch.tts;
    if (patch.voice !== undefined) {
      const engine = prefs.tts ?? this.config.tts;
      const voices = { ...prefs.voices };
      if (patch.voice === null) delete voices[engine];
      else voices[engine] = patch.voice;
      if (Object.keys(voices).length > 0) prefs.voices = voices;
      else delete prefs.voices;
    }
    this.deps.prefs.write(prefs);
    const after = this.effective();
    this.log.info("voice settings", { tts: after.tts, voice: after.tts_voice, source: prefs.tts !== undefined ? "app" : "config" });
    if (this.config.enabled && !this.stopped) {
      if (after.tts !== before.tts) void this.loadTts();
      // The engine in place takes the voice now; one still loading takes it as it lands.
      else if (after.tts_voice !== before.tts_voice && this.ttsEngine?.name === after.tts) this.ttsEngine.useVoice?.(after.tts_voice);
    }
    return this.settings();
  }

  /** `voice.preview`: a line to this client in the voice set now. Refused when nothing can speak it to this client. */
  preview(client: Client, text?: string): void {
    if (!this.config.enabled) throw new RpcError("unavailable", "voice is off on this node");
    if (!client.audio.out) throw new RpcError("invalid", "this client cannot play audio");
    const stage = this.stages.tts;
    if (stage.status !== "ready") throw new RpcError("unavailable", `speech is ${stage.status}${stage.reason ? `: ${stage.reason}` : ""}`);
    const conversation = this.conversation(client);
    if (!conversation) throw new RpcError("unavailable", "voice is stopping");
    void conversation.speak(text ?? PREVIEW_LINE, { interrupt: true });
  }

  /** A step of an engine bootstrap, on its way to every client with the voice scope. */
  setup(event: VoiceSetup): void {
    this.lastSetup = event.step === "ready" || event.step === "failed" ? undefined : event;
    this.deps.bus.emit("voice.setup", event);
  }

  /** The controllers that detect their own wake word, for the tests and the log. */
  phoneWakeClients(): string[] {
    return [...this.phoneWake];
  }

  // --- conversations -------------------------------------------------------------------------

  private conversation(client: Client): Conversation | undefined {
    const existing = this.conversations.get(client.id);
    if (existing) return existing;
    if (this.stopped || !this.config.enabled) return undefined;
    // The engines are looked up late, so a controller that streamed before a stage came up is heard once it does.
    const c = new Conversation({
      client: client.id,
      ...(this.wakeModel && !this.phoneWake.has(client.id) ? { wake: this.wakeModel.stream() } : {}),
      vad: () => this.makeVad?.(),
      stt: () => this.sttEngine,
      tts: () => this.ttsEngine,
      acksPlayed: client.audio.played === true,
      thinkingTimeoutMs: this.config.thinking_timeout_ms,
      log: this.log.child("conversation"),
      ...(this.deps.now ? { now: this.deps.now } : {}),
      on: {
        state: (state) => this.deps.bus.emit("voice.state", { state, client: client.id }),
        partial: (text) => this.deps.bus.emit("voice.transcript", { at: this.now(), text }),
        final: (text) => {
          this.active = client.id;
          this.deps.chat.userMessage({ text, source: "voice", client: client.id });
        },
        speaking: (active) => this.deps.activity.speaking(client, active),
        // Speech goes to the one controller whose utterance produced it.
        audio: (pcm, rate, frame) => this.sendSpeech(client, pcm, rate, frame),
      },
    });
    this.conversations.set(client.id, c);
    return c;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private codecsOf(id: string): Codecs {
    let c = this.codecs.get(id);
    if (!c) {
      c = { reply: -1, seq: 0 };
      this.codecs.set(id, c);
    }
    return c;
  }

  private dropCodecs(id: string): void {
    const c = this.codecs.get(id);
    if (!c) return;
    c.decoder?.close();
    c.encoder?.close();
    this.codecs.delete(id);
  }

  /** A slice of a reply to its controller, in Opus when it takes it and the rate allows, numbered within the reply. */
  private sendSpeech(client: Client, pcm: Int16Array, rate: number, frame: { reply: number; end?: true }): void {
    const c = this.codecsOf(client.id);
    if (frame.reply !== c.reply) {
      c.reply = frame.reply;
      c.seq = 0;
      c.encoder?.reset();
    }
    const opus = (client.audio.codecs ?? []).includes("opus") && opusRate(rate);
    let codec: AudioCodec = "pcm";
    let bytes: Uint8Array = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    if (opus) {
      if (!c.encoder || c.encoder.rate !== rate) {
        c.encoder?.close();
        c.encoder = new OpusEncoder(rate);
      }
      const packed = c.encoder.encode(pcm);
      const tail = frame.end ? c.encoder.flush() : new Uint8Array(0);
      bytes = tail.length ? concat(packed, tail) : packed;
      codec = "opus";
    }
    // A slice shorter than a packet is carried to the next; only the end goes out empty.
    if (bytes.length === 0 && !frame.end) return;
    this.deps.clients.send(client.id, "voice.audio", {
      chunk: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
      codec,
      rate,
      seq: c.seq++,
      reply: frame.reply,
      ...(frame.end ? { end: true as const } : {}),
    });
  }

  /** A `voice.audio` frame from a controller, PCM or Opus. A signal: nothing is thrown at the sender. */
  onAudio(client: Client, p: SignalParams<"voice.audio">): void {
    if (!this.config.enabled || this.stopped) return;
    if (!client.audio.in) return;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(p.chunk, "base64");
    } catch {
      return;
    }
    const opus = p.codec === "opus";
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_CHUNK_BYTES || (!opus && bytes.byteLength % 2 !== 0)) {
      this.log.debug("voice.audio frame dropped", { client: client.id, bytes: bytes.byteLength });
      return;
    }
    let pcm: Int16Array;
    if (opus) {
      const c = this.codecsOf(client.id);
      c.decoder ??= new OpusDecoder(IN_RATE);
      try {
        pcm = c.decoder.decode(bytes);
      } catch (e) {
        this.log.debug("voice.audio frame dropped: bad Opus", { client: client.id, error: e instanceof Error ? e.message : String(e) });
        return;
      }
    } else {
      // Copied rather than viewed: a Buffer from base64 is not guaranteed to be 2-byte aligned.
      pcm = new Int16Array(bytes.byteLength / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2);
    }
    this.conversation(client)?.push(pcm, p.seq);
  }

  /** `voice.played`: the controller finished playing a reply. */
  onPlayed(client: Client, p: SignalParams<"voice.played">): void {
    if (!this.config.enabled || this.stopped) return;
    this.conversations.get(client.id)?.played(p.reply, p.stats);
  }

  /** What the button and the phone's wake word both need: a microphone, and something to transcribe with. */
  private hearable(client: Client): void {
    if (!this.config.enabled) throw new RpcError("unavailable", "voice is off on this node");
    if (!client.audio.in) throw new RpcError("invalid", "this client has no microphone");
    if (this.stages.stt.status !== "ready") throw new RpcError("unavailable", `speech to text is ${this.stages.stt.status}${this.stages.stt.reason ? `: ${this.stages.stt.reason}` : ""}`);
  }

  /** The push-to-talk button. Refused when nothing could transcribe what is said. */
  ptt(client: Client, active: boolean): void {
    this.hearable(client);
    this.conversation(client)?.ptt(active);
  }

  /**
   * The wake model once its stage settles, waiting a while for one still loading; none when it
   * is not up. A client that connected while the daemon was still starting waits for voice to
   * start first, however long the rest of the start takes: the daemon always gets there, or
   * stops.
   */
  private async settledWake(): Promise<WakeModel | undefined> {
    await this.begun;
    if (this.stages.wake.status === "loading" && this.wakeLoading) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, WAKE_WAIT_MS);
        timer.unref?.();
      });
      await Promise.race([this.wakeLoading, late]);
      clearTimeout(timer);
    }
    return this.stages.wake.status === "ready" ? this.wakeModel : undefined;
  }

  /**
   * `voice.wakeword`: where this controller's wake word is detected. On the phone when it
   * carries every head the node listens with, which it then runs at the node's thresholds and
   * scales; on the node otherwise, over the frames the phone streams while it listens. An
   * empty list hands detection back to the node, and so does a wake stage that is not up,
   * since the thresholds are the model's.
   */
  async wakeword(client: Client, heads: string[]): Promise<WakewordMode> {
    if (!client.audio.in) throw new RpcError("invalid", "this client has no microphone");
    if (!this.config.enabled || this.config.wake === "off") {
      this.phoneWake.delete(client.id);
      return { mode: "off" };
    }
    const model = await this.settledWake();
    // Gone while the stage loaded: there is nobody to hear for.
    if (this.stopped || !this.deps.clients.get(client.id)) return { mode: "node" };
    const was = this.phoneWake.has(client.id);
    const listening = model?.heads ?? [];
    const existing = this.conversations.get(client.id);
    const first = listening[0];
    if (first && listening.every((h) => heads.includes(h.name))) {
      if (!was) {
        this.phoneWake.add(client.id);
        existing?.useWake(undefined);
        this.log.info("the wake word is heard on the phone", { client: client.id, heads: listening.map((h) => h.name) });
      }
      return {
        mode: "phone",
        head: first.name,
        threshold: first.threshold,
        scale: first.scale,
        heads: listening.map((h) => ({ head: h.name, threshold: h.threshold, scale: h.scale, phrase: h.phrase })),
      };
    }
    if (was) {
      this.phoneWake.delete(client.id);
      existing?.useWake(this.wakeModel?.stream());
      this.log.info("the wake word is heard on the node", { client: client.id });
    }
    return { mode: "node" };
  }

  /**
   * `voice.wake`: the phone heard the word; the first `lead` frames that follow were captured
   * before it fired. Ignored mid-utterance and while the button is held.
   */
  wake(client: Client, score: number, head?: string, lead?: number): void {
    this.hearable(client);
    const heard = this.conversation(client)?.wakeHeard(lead) ?? false;
    if (heard) this.log.info("wake word (phone)", { client: client.id, score: Number(score.toFixed(3)), ...(head ? { head } : {}) });
    else this.log.debug("wake word (phone) ignored: an utterance is in progress", { client: client.id });
  }

  /**
   * `voice.speak` from the brain: the blocks composed for the ear and sent to the controller
   * whose utterance started the turn. Resolves when the speech is queued, not when it is heard.
   */
  speak(blocks: ContentBlock[], opts: { interrupt?: boolean; client?: string } = {}): void {
    if (!this.config.enabled) return;
    const id = opts.client ?? this.active;
    const conversation = id ? this.conversations.get(id) : undefined;
    if (!conversation) {
      this.log.debug("nothing to speak to: no controller is in a conversation");
      return;
    }
    const target = this.deps.clients.get(conversation.client);
    if (!target?.client.audio.out) {
      this.log.debug("the controller cannot play audio", { client: conversation.client });
      return;
    }
    const text = composeSpeech(blocks, this.deps.names ?? {});
    if (!text) return;
    void conversation.speak(text, { ...(opts.interrupt !== undefined ? { interrupt: opts.interrupt } : {}) });
  }

  /** A model became current while the daemon ran: the stage that uses it loads it again. */
  onModel(name: string, dir: string): void {
    if (!this.config.enabled || this.stopped) return;
    this.log.info("voice model changed", { model: name, dir });
    const speech = sherpaEngine(this.effective().tts);
    if (name === WAKE_MODEL) void (this.wakeLoading = this.loadWake());
    else if (name === VAD_MODEL || name === STT_MODEL) void this.loadStt();
    else if (speech && name === TTS_MODELS[speech]) void this.loadTts();
  }

  /** A client went away: its conversation goes with it. */
  onDisconnect(clientId: string): void {
    this.phoneWake.delete(clientId);
    this.dropCodecs(clientId);
    const c = this.conversations.get(clientId);
    if (!c) return;
    c.dispose();
    this.conversations.delete(clientId);
    if (this.active === clientId) this.active = undefined;
    this.log.debug("voice conversation ended", { client: clientId });
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
