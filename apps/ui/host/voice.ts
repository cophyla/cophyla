// Voice in the desktop app's host page: `@cophyla/voicehost`, which the phone runs too, over
// the shell's link. The page starts the microphone and the wake word at launch — the shell
// grants the microphone and lets audio start with no click — and keeps both running while the
// window is hidden in the tray, so a wake word reaches Cophyla whether or not the app is in
// front. The talk key comes from the shell as `voice:ptt`; a view draws a talk button of its
// own and holds `voice.ptt` itself (`talk` in `host.ready`); replies play through the
// speakers. What the user chose — listening, speaking, the talk key, the microphone — is kept
// in the page's storage and shown in the Voice section of the host's settings.

import type { LinkSnapshot, VoiceSettings, VoiceSettingsState } from "@cophyla/viewhost";
import { VoiceHost } from "@cophyla/voicehost";
import type { MicChoice, VoiceLink, VoiceView } from "@cophyla/voicehost";

export const LISTEN_KEY = "cophyla.voice.listen";
export const SPEAK_KEY = "cophyla.voice.speak";
export const TALK_KEY = "cophyla.voice.talkKey";
/** The microphone picked, as `{ id, label }`; the system's default when absent. */
export const MIC_KEY = "cophyla.voice.mic";
/** The talk key unless the user chose another. */
export const DEFAULT_TALK_KEY = "Ctrl+Alt+Space";
/** A Mac's: Control+Option+Space is macOS's own "Select next source in Input menu". */
export const MAC_TALK_KEY = "Ctrl+Shift+Space";

/** Whether the page runs on a Mac: WebKit there says `MacIntel`, Apple Silicon too. */
function onMac(): boolean {
  return /^Mac/.test(globalThis.navigator?.platform ?? "");
}

/** The talk key a fresh install starts with, on this platform. */
export function defaultTalkKey(mac: boolean = onMac()): string {
  return mac ? MAC_TALK_KEY : DEFAULT_TALK_KEY;
}
/** How long the audio may take to start on its own before the page waits for a click. */
export const START_MS = 4000;
/** How often the page looks for a click that lets a held-back audio context start. */
const ACTIVATION_POLL_MS = 500;
/** How long the page waits for WebCodecs before it says PCM alone. */
const CODECS_MS = 1500;

export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface DesktopVoiceDeps {
  link: VoiceLink & { readonly state: LinkSnapshot };
  /** The shell's commands and events. */
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
  store?: Store;
  /** Recording an utterance started or stopped, and how loud it is meanwhile: for the view to draw. */
  onRecording?: (on: boolean) => void;
  onLevels?: (levels: number[]) => void;
  log?: (message: string) => void;
  /** On a Mac, where the talk key's default differs; read from the web view when not given. */
  mac?: boolean;
}

/** The hello's `audio`: a microphone and a speaker, the codecs this web view speaks, and `voice.played` acks. */
export interface HelloAudio {
  in: boolean;
  out: boolean;
  codecs: string[];
  played: boolean;
}

/** What the Voice section says voice is doing, in words. */
export function statusWords(v: VoiceView, connected: boolean): string {
  if (!connected) return "Not connected to cophylad.";
  if (!v.audioReady) return "Starting the microphone…";
  if (v.refused) return `Cophyla cannot listen: ${v.refused}`;
  if (v.voice && v.voice !== "idle") return v.voice === "listening" ? "Listening to you…" : `${v.voice[0]!.toUpperCase()}${v.voice.slice(1)}…`;
  if (v.wake === "off") return "The wake words are off on this node; the talk key still works.";
  if (!v.listening) return "Not listening for the wake words; the talk key still works.";
  if (v.wake === "node") return "Listening: this computer streams to the node, which hears the wake words.";
  return "Listening for the wake words, here on this computer.";
}

export class DesktopVoice implements VoiceSettings {
  readonly host: VoiceHost;
  private deps: DesktopVoiceDeps;
  private talkKey = "";
  private subscribers = new Set<() => void>();
  private activationTimer?: ReturnType<typeof setInterval>;

  constructor(deps: DesktopVoiceDeps) {
    this.deps = deps;
    const mic = readMic(this.read(MIC_KEY));
    this.host = new VoiceHost({
      link: deps.link,
      // The files are the app's own, served from its own assets.
      wake: { verify: false },
      listening: this.read(LISTEN_KEY) !== "off",
      ...(mic ? { mic } : {}),
      onChange: () => this.changed(),
      ...(deps.onRecording ? { onRecording: deps.onRecording } : {}),
      ...(deps.onLevels ? { onLevels: deps.onLevels } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    });
    this.host.mute(this.read(SPEAK_KEY) === "off");
  }

  /** What the hello says of the page's audio, once WebCodecs has said what it speaks (or not in time). */
  async helloAudio(): Promise<HelloAudio> {
    const late = new Promise<void>((resolve) => setTimeout(resolve, CODECS_MS));
    await Promise.race([this.host.codecsKnown.then(() => undefined), late]);
    return { in: true, out: true, codecs: this.host.codecs, played: true };
  }

  /**
   * The talk key, the shell's events, and the audio. The audio is started at once; one the web
   * view holds back until a click (a platform with no autoplay switch) is started on the first.
   */
  async start(): Promise<void> {
    await this.deps.listen<{ down: boolean }>("voice:ptt", (e) => this.host.ptt(e.down === true));
    void this.setTalkKey(this.read(TALK_KEY) ?? defaultTalkKey(this.deps.mac)).catch((e: unknown) => this.log(`talk key: ${message(e)}`));
    await this.startAudio();
  }

  private async startAudio(): Promise<void> {
    const late = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), START_MS));
    const how = await Promise.race([this.host.openAudio().then(() => "open" as const), late]).catch((e: unknown) => {
      this.log(`audio: ${message(e)}`);
      return "failed" as const;
    });
    if (how === "late") {
      this.log("the audio did not start on its own; it starts at the first click");
      this.waitForActivation();
      return;
    }
    if (how === "failed") return;
    await this.host.start().catch((e: unknown) => this.log(`microphone: ${message(e)}`));
  }

  /** Polls for the page's user activation, which a click in the view's frame passes up, and starts the audio then. */
  private waitForActivation(): void {
    if (this.activationTimer) return;
    this.activationTimer = setInterval(() => {
      if (navigator.userActivation && !navigator.userActivation.isActive) return;
      clearInterval(this.activationTimer);
      this.activationTimer = undefined;
      void this.host.start().catch((e: unknown) => this.log(`microphone: ${message(e)}`));
    }, ACTIVATION_POLL_MS);
  }

  /** A frame from cophylad: speech is played and taken; everything else goes on to the view. */
  handleFrame(frame: { method?: string; params?: unknown }): boolean {
    return this.host.handleFrame(frame);
  }

  linkChanged(snapshot: LinkSnapshot): void {
    this.host.linkChanged(snapshot.state === "connected");
  }

  // --- the Voice section ------------------------------------------------------------------------

  state(): VoiceSettingsState {
    const v = this.host.view;
    return {
      listening: v.listening,
      speak: !v.muted,
      talkKey: this.talkKey,
      phrases: v.phrases,
      status: statusWords(v, this.deps.link.connected),
      ...(v.micError ? { micError: v.micError } : {}),
      ...(v.mic ? { mic: v.mic } : {}),
      ...(v.micNote ? { micNote: v.micNote } : {}),
      ...(v.micChoice ? { micChoice: v.micChoice } : {}),
      mics: v.mics.map((m) => ({ id: m.id, label: m.label })),
      ...(v.defaultMic ? { defaultMic: v.defaultMic } : {}),
    };
  }

  subscribe(changed: () => void): () => void {
    this.subscribers.add(changed);
    return () => this.subscribers.delete(changed);
  }

  setListening(on: boolean): void {
    this.write(LISTEN_KEY, on ? "on" : "off");
    this.host.listen(on);
  }

  setSpeak(on: boolean): void {
    this.write(SPEAK_KEY, on ? "on" : "off");
    this.host.mute(!on);
  }

  async setTalkKey(accelerator: string): Promise<string> {
    const key = await this.deps.invoke<string>("ptt_shortcut", { accelerator: accelerator.trim() });
    this.talkKey = key;
    // Kept as typed when it was taken, so an empty one stays empty rather than the default.
    this.write(TALK_KEY, accelerator.trim());
    this.changed();
    return key;
  }

  async retry(): Promise<void> {
    await this.host.start();
  }

  /** Listens on a microphone from the list, or on the system's default for `""`; kept for the next launch. */
  async setMic(id: string): Promise<void> {
    const device = id === "" ? undefined : this.host.view.mics.find((m) => m.id === id);
    const choice: MicChoice | undefined = device ? { id: device.id, label: device.label } : undefined;
    // An id no longer listed keeps the pick as it was.
    if (id !== "" && !choice) return;
    this.write(MIC_KEY, choice ? JSON.stringify(choice) : "");
    await this.host.setMic(choice);
  }

  listMics(): void {
    void this.host.listMics();
  }

  private changed(): void {
    for (const s of this.subscribers) s();
  }

  private read(key: string): string | null {
    try {
      return this.deps.store?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: string): void {
    try {
      this.deps.store?.setItem(key, value);
    } catch {
      // storage refused: the choice lasts until the page reloads
    }
  }

  private log(text: string): void {
    (this.deps.log ?? console.info)(text);
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The microphone kept in storage, when what is kept reads as one. */
export function readMic(raw: string | null): MicChoice | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as { id?: unknown; label?: unknown };
    return typeof v.id === "string" && v.id !== "" && typeof v.label === "string" ? { id: v.id, label: v.label } : undefined;
  } catch {
    return undefined;
  }
}
