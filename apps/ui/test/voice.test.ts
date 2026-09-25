// The desktop app's voice over fakes: the hello's audio, the talk key and the switches kept
// in the page's storage, the Voice section's words, and the talk key from the shell reaching
// the node as `voice.ptt`. No web view: the link, the shell's commands and events, and the
// storage are injected, and the audio is never opened.

import { describe, expect, test } from "bun:test";
import type { LinkSnapshot } from "@cophyla/viewhost";
import type { VoiceView } from "@cophyla/voicehost";
import { DEFAULT_TALK_KEY, DesktopVoice, LISTEN_KEY, SPEAK_KEY, statusWords, TALK_KEY } from "../host/voice.ts";

class MapStore {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

function fixture(opts: { stored?: Record<string, string>; refuseKey?: string } = {}) {
  const store = new MapStore();
  for (const [k, v] of Object.entries(opts.stored ?? {})) store.setItem(k, v);
  const requests: { method: string; params: unknown }[] = [];
  const invoked: { cmd: string; args?: Record<string, unknown> }[] = [];
  const handlers = new Map<string, (payload: unknown) => void>();
  const state: LinkSnapshot = { state: "connected", since: 0, hello: { client: { id: "cli_desk" } } as never };
  const link = {
    get connected() {
      return state.state === "connected";
    },
    state,
    request: async <T>(method: string, params?: unknown): Promise<T> => {
      requests.push({ method, params });
      return {} as T;
    },
    send: async () => {},
  };
  const voice = new DesktopVoice({
    link,
    store,
    invoke: async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      invoked.push({ cmd, ...(args ? { args } : {}) });
      const accelerator = String(args?.["accelerator"] ?? "");
      if (opts.refuseKey !== undefined && accelerator === opts.refuseKey) throw "unavailable: Ctrl+X could not be had, another app may hold it";
      return accelerator as T;
    },
    listen: async <T>(event: string, handler: (payload: T) => void) => {
      handlers.set(event, handler as (payload: unknown) => void);
      return () => handlers.delete(event);
    },
    log: () => {},
  });
  return { voice, store, requests, invoked, handlers };
}

const VIEW: VoiceView = { audioReady: true, wake: "phone", pending: false, talking: false, listening: true, muted: false, watching: false, phrases: ["Hey Jarvis", "Cophyla"] };

describe("the desktop app's voice", () => {
  test("the hello says a microphone, a speaker, the codecs this web view speaks and played acks", async () => {
    const { voice } = fixture();
    // Bun has no WebCodecs: PCM alone.
    expect(await voice.helloAudio()).toEqual({ in: true, out: true, codecs: ["pcm"], played: true });
  });

  test("listening and speaking start from what was kept, and are kept when changed", () => {
    const { voice, store } = fixture({ stored: { [LISTEN_KEY]: "off", [SPEAK_KEY]: "off" } });
    expect(voice.state()).toMatchObject({ listening: false, speak: false });
    voice.setListening(true);
    voice.setSpeak(true);
    expect(voice.state()).toMatchObject({ listening: true, speak: true });
    expect(store.map.get(LISTEN_KEY)).toBe("on");
    expect(store.map.get(SPEAK_KEY)).toBe("on");
  });

  test("the talk key is the default until one is chosen; a refused one is said and not kept", async () => {
    const { voice, store, invoked, handlers } = fixture({ refuseKey: "Ctrl+X" });
    let changes = 0;
    voice.subscribe(() => changes++);
    await voice.start().catch(() => {});
    await Bun.sleep(0);
    expect(invoked[0]).toEqual({ cmd: "ptt_shortcut", args: { accelerator: DEFAULT_TALK_KEY } });
    expect(voice.state().talkKey).toBe(DEFAULT_TALK_KEY);
    expect(handlers.has("voice:ptt")).toBe(true);
    await expect(voice.setTalkKey("Ctrl+X")).rejects.toContain("another app may hold it");
    expect(store.map.get(TALK_KEY)).toBe(DEFAULT_TALK_KEY);
    // Empty turns it off, and off is kept as off rather than falling back to the default.
    expect(await voice.setTalkKey("")).toBe("");
    expect(store.map.get(TALK_KEY)).toBe("");
    expect(changes).toBeGreaterThan(0);
  });

  test("the talk key held and let go is push-to-talk on the node, once each way", async () => {
    const { voice, requests, handlers } = fixture();
    await voice.start().catch(() => {});
    const ptt = handlers.get("voice:ptt")!;
    ptt({ down: true });
    ptt({ down: true });
    ptt({ down: false });
    await Bun.sleep(0);
    expect(requests.filter((r) => r.method === "voice.ptt").map((r) => r.params)).toEqual([{ active: true }, { active: false }]);
  });

  test("the Voice section says what voice is doing", () => {
    expect(statusWords(VIEW, false)).toBe("Not connected to cophylad.");
    expect(statusWords({ ...VIEW, audioReady: false }, true)).toBe("Starting the microphone…");
    expect(statusWords(VIEW, true)).toBe("Listening for the wake words, here on this computer.");
    expect(statusWords({ ...VIEW, wake: "node" }, true)).toContain("the node, which hears the wake words");
    expect(statusWords({ ...VIEW, wake: "off" }, true)).toContain("off on this node");
    expect(statusWords({ ...VIEW, listening: false }, true)).toContain("Not listening");
    expect(statusWords({ ...VIEW, voice: "listening" }, true)).toBe("Listening to you…");
    expect(statusWords({ ...VIEW, voice: "thinking" }, true)).toBe("Thinking…");
    expect(statusWords({ ...VIEW, refused: "speech to text is loading" }, true)).toBe("Cophyla cannot listen: speech to text is loading");
  });
});
