// Voice in the controller page in a wide window on a computer: `@cophyla/voicehost`, which the
// phone's page and the desktop app run too, with the Voice section the desktop app has in its
// settings and none of what a shell arranges. There is no Start screen and no bar: the view
// draws the talk button (`talk` in `host.ready`) and holds `voice.ptt` itself. A browser lets
// no audio start before the page was clicked, so the microphone and the speaker start at the
// first click anywhere, the view's frame included. Listening for the wake words is off until
// it is switched on in the settings: a tab left open on a computer should not be a microphone
// nobody remembers. There is no talk key: a page cannot hold a key outside its own window.
// What the user chose (listening, speaking, the microphone) is kept in the page's storage.

import type { VoiceSettings, VoiceSettingsState } from "@cophyla/viewhost";
import { readMic, statusWords, VoiceHost } from "@cophyla/voicehost";
import type { FileCache, MicChoice, VoiceLink } from "@cophyla/voicehost";

export const LISTEN_KEY = "cophyla.voice.listen";
export const SPEAK_KEY = "cophyla.voice.speak";
/** The microphone picked, as `{ id, label }`; the system's default when absent. */
export const MIC_KEY = "cophyla.voice.mic";
/** How long the audio may take to start on its own before the page waits for a click. */
export const START_MS = 4000;
/** How often the page looks for a click that lets a held-back audio context start. */
const ACTIVATION_POLL_MS = 500;

export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BrowserVoiceDeps {
  link: VoiceLink;
  /** Bytes the link has not yet put on the wire. */
  backlog?: () => number;
  store?: Store;
  /** How the wake files are kept: the page caches and checks what it fetched from the node. */
  wake?: { cache?: FileCache; verify?: boolean };
  onChange?: () => void;
  /** Recording an utterance started or stopped, and how loud it is meanwhile: for the view to draw. */
  onRecording?: (on: boolean) => void;
  onLevels?: (levels: number[]) => void;
  onCodecs?: (codecs: ("opus" | "pcm")[]) => void;
  /** Whether the page has been clicked: `navigator.userActivation` when not given. */
  activated?: () => boolean;
  timers?: { setInterval(handler: () => void, ms: number): unknown; clearInterval(handle: unknown): void };
  startMs?: number;
  log?: (message: string) => void;
}

export class BrowserVoice implements VoiceSettings {
  readonly host: VoiceHost;
  private deps: BrowserVoiceDeps;
  private subscribers = new Set<() => void>();
  /** Whether it has been made: a change while it is being built is told to nobody. */
  private built = false;
  private activationTimer?: unknown;

  constructor(deps: BrowserVoiceDeps) {
    this.deps = deps;
    const mic = readMic(this.read(MIC_KEY));
    this.host = new VoiceHost({
      link: deps.link,
      ...(deps.backlog ? { backlog: deps.backlog } : {}),
      ...(deps.wake ? { wake: deps.wake } : {}),
      // off until it is switched on here: a tab on a computer is not a microphone by default
      listening: this.read(LISTEN_KEY) === "on",
      ...(mic ? { mic } : {}),
      onChange: () => this.changed(),
      ...(deps.onRecording ? { onRecording: deps.onRecording } : {}),
      ...(deps.onLevels ? { onLevels: deps.onLevels } : {}),
      ...(deps.onCodecs ? { onCodecs: deps.onCodecs } : {}),
      ...(deps.log ? { log: deps.log } : {}),
    });
    this.host.mute(this.read(SPEAK_KEY) === "off");
    // from here on: whoever is building this has nothing to hear from it until it has it
    this.built = true;
  }

  /** Starts the audio at once where the browser lets it, and at the first click where it does not. */
  async start(): Promise<void> {
    const late = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), this.deps.startMs ?? START_MS));
    const how = await Promise.race([this.host.openAudio().then(() => "open" as const), late]).catch((e: unknown) => {
      this.log(`audio: ${message(e)}`);
      return "failed" as const;
    });
    if (how === "late" || how === "failed") {
      this.waitForActivation();
      return;
    }
    await this.host.start().catch((e: unknown) => this.log(`microphone: ${message(e)}`));
  }

  /** Polls for the page's user activation, which a click in the view's frame passes up, and starts the audio then. */
  private waitForActivation(): void {
    if (this.activationTimer !== undefined) return;
    const timers = this.deps.timers ?? { setInterval: (h: () => void, ms: number) => setInterval(h, ms), clearInterval: (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>) };
    const activated = this.deps.activated ?? (() => !navigator.userActivation || navigator.userActivation.isActive);
    this.activationTimer = timers.setInterval(() => {
      if (!activated()) return;
      timers.clearInterval(this.activationTimer);
      this.activationTimer = undefined;
      void this.host.start().catch((e: unknown) => this.log(`microphone: ${message(e)}`));
    }, ACTIVATION_POLL_MS);
  }

  // --- the Voice section ------------------------------------------------------------------------

  state(): VoiceSettingsState {
    const v = this.host.view;
    return {
      listening: v.listening,
      speak: !v.muted,
      talkKey: "",
      phrases: v.phrases,
      status: !v.audioReady && this.deps.link.connected ? "The microphone starts at the first click on this page." : statusWords(v, this.deps.link.connected, "the talk button"),
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

  async retry(): Promise<void> {
    await this.host.start();
  }

  /** Listens on a microphone from the list, or on the system's default for `""`; kept for the next visit. */
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
    if (!this.built) return;
    this.deps.onChange?.();
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
