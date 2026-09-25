// The controller's own modules over fakes: the credential and the code, the invite, what the
// page shows and which way each frame goes, and host.open. Voice's own modules — the audio,
// the wake word — are tested in packages/voicehost. No browser: the socket, the storage and
// the timers are all injected.

import { describe, expect, test } from "bun:test";
import { deriveChrome } from "../src/chrome.ts";
import type { ChromeInput } from "../src/chrome.ts";
import { inviteLink, inviteText } from "@cophyla/protocol";
import type { InviteBody } from "@cophyla/protocol";
import { codeFromUrl, guessName, INVITE_CLOCK_SLACK_MS, inviteLanNodes, isInviteLink, LISTEN_KEY, parseCode, parseInviteLink, parsePairLink, pkcePair, readCredential, readListen, signInUrl, STORAGE_KEY, writeCredential, writeListen } from "../src/pairing.ts";
import type { Storage } from "../src/pairing.ts";
import { openTarget } from "../src/remote.ts";

// --- fakes ---------------------------------------------------------------------------------

class FakeStorage implements Storage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

// --- pairing ---------------------------------------------------------------------------------

describe("the sign-in with the account", () => {
  test("PKCE: a 43-character verifier and its S256 challenge, as RFC 7636 computes it", async () => {
    // RFC 7636, appendix B: these 32 bytes give this verifier and this challenge
    const bytes = new Uint8Array([116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121]);
    const p = await pkcePair(() => bytes);
    expect(p.verifier).toBe("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(p.challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    const fresh = await pkcePair();
    expect(fresh.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fresh.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signInUrl("https://orc.test/", p.challenge)).toBe("https://orc.test/pair?challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("the grant from cophyla://pair, and nothing from any other link", () => {
    expect(parsePairLink("cophyla://pair?grant=prg_Zk3uQ0cV8yT1mN4b")).toBe("prg_Zk3uQ0cV8yT1mN4b");
    expect(parsePairLink("cophyla://pair/?grant=prg_Zk3uQ0cV8yT1mN4b&x=1")).toBe("prg_Zk3uQ0cV8yT1mN4b");
    expect(parsePairLink("cophyla://ask/ask_1/y")).toBeUndefined();
    expect(parsePairLink("cophyla://pair?grant=")).toBeUndefined();
    expect(parsePairLink("cophyla://pair?grant=<script>")).toBeUndefined();
    expect(parsePairLink("https://evil.test/pair?grant=prg_Zk3uQ0cV8yT1mN4b")).toBeUndefined();
  });
});

describe("an invite from the desktop", () => {
  const NOW = 1_758_196_800_000;
  const body: InviteBody = {
    v: 1,
    kind: "controller",
    grant: "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC5",
    secret: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    expiresAt: NOW + 900_000,
    node: { id: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "Studio PC" },
    lan: { hosts: ["192.168.1.44", "fe80::1", "127.0.0.1"], port: 4818, spki: "q2f0y5Hk9u1m3C1vJb0pZ6oQnqQ8yWm3rX4vA1Rk2tE=" },
    relay: { url: "https://orc.test", peer: "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC6", token: "rly_x" },
  };

  test("its text and its link read back, with what a paste brings along", () => {
    expect(parseInviteLink(inviteText(body), NOW)).toEqual(body);
    expect(parseInviteLink(inviteLink(body), NOW)).toEqual(body);
    expect(parseInviteLink(`  ${inviteText(body).replace(/(.{40})/g, "$1\n")}  `, NOW)).toEqual(body);
    expect(isInviteLink(inviteLink(body))).toBe(true);
    expect(isInviteLink("cophyla://invited")).toBe(false);
    expect(isInviteLink("cophyla://pair?grant=x")).toBe(false);
  });

  test("what it cannot be used for says so", () => {
    expect(() => parseInviteLink("482913", NOW)).toThrow(/not a Cophyla invite/);
    expect(() => parseInviteLink(inviteText(body).slice(0, 40), NOW)).toThrow(/copy it again/);
    expect(() => parseInviteLink(inviteText({ ...body, kind: "node", grant: "grt_01ARZ3NDEKTSV4RRFFQ69G5FC5" }), NOW)).toThrow(/cophylad join/);
    expect(() => parseInviteLink(inviteText(body), body.expiresAt + INVITE_CLOCK_SLACK_MS)).toThrow(/run out/);
    // a phone clock a little ahead still reads it
    expect(parseInviteLink(inviteText(body), body.expiresAt + 60_000).grant).toBe(body.grant);
    const { lan: _lan, relay: _relay, ...bare } = body;
    expect(() => parseInviteLink(inviteText(bare), NOW)).toThrow(/no way/);
  });

  test("its LAN addresses, each pinned, the node's loopback left out", () => {
    expect(inviteLanNodes(body)).toEqual([
      { host: "192.168.1.44", port: 4818, spki: body.lan!.spki },
      { host: "[fe80::1]", port: 4818, spki: body.lan!.spki },
    ]);
    expect(inviteLanNodes({})).toEqual([]);
  });
});

describe("the credential", () => {
  test("round-trips, and rubbish is no credential at all", () => {
    const storage = new FakeStorage();
    expect(readCredential(storage)).toBeUndefined();
    writeCredential(storage, { token: "t", controller: "ctl_1", name: "Pixel" });
    expect(readCredential(storage)).toEqual({ token: "t", controller: "ctl_1", name: "Pixel" });
    storage.map.set(STORAGE_KEY, "{not json");
    expect(readCredential(storage)).toBeUndefined();
    storage.map.set(STORAGE_KEY, JSON.stringify({ token: 1 }));
    expect(readCredential(storage)).toBeUndefined();
  });

  test("listening is on unless the user turned it off, and the off is remembered", () => {
    const storage = new FakeStorage();
    expect(readListen(storage)).toBe(true);
    writeListen(storage, false);
    expect(storage.map.get(LISTEN_KEY)).toBe("off");
    expect(readListen(storage)).toBe(false);
    writeListen(storage, true);
    expect(storage.map.has(LISTEN_KEY)).toBe(false);
    expect(readListen(storage)).toBe(true);
    // a page with no storage listens
    expect(readListen(undefined)).toBe(true);
  });

  test("a code is six digits, however the user types it", () => {
    expect(parseCode("482913")).toBe("482913");
    expect(parseCode("482 913")).toBe("482913");
    expect(parseCode("482-913")).toBe("482913");
    // A pasted code often carries spaces around it; they are the user's, not an error.
    expect(parseCode(" 482913 ")).toBe("482913");
    expect(parseCode("48291")).toBeUndefined();
    expect(parseCode("4829134")).toBeUndefined();
    expect(parseCode("abcdef")).toBeUndefined();
    expect(codeFromUrl("?code=482913")).toBe("482913");
    expect(codeFromUrl("?code=nope")).toBeUndefined();
    expect(codeFromUrl("")).toBeUndefined();
  });

  test("the name guessed from a user agent is one a person would recognise", () => {
    expect(guessName("Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A) AppleWebKit")).toBe("Pixel 8");
    expect(guessName("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("iPhone");
    expect(guessName("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows PC");
    expect(guessName("")).toBe("a browser");
  });
});

// --- audio ------------------------------------------------------------------------------------

describe("chrome", () => {
  const base: ChromeInput = { link: "connected", paired: true, audioReady: true, sttReady: true, listening: false, wake: "node", pending: false, talking: false, muted: false };

  test("the three screens follow the credential and the start gesture", () => {
    expect(deriveChrome({ ...base, paired: false }).screen).toBe("pair");
    expect(deriveChrome({ ...base, audioReady: false }).screen).toBe("gate");
    expect(deriveChrome(base).screen).toBe("main");
  });

  test("the app starts on its own: no gate while it does, the gate once it failed", () => {
    expect(deriveChrome({ ...base, audioReady: false, autoStart: true })).toMatchObject({ screen: "main", status: "starting the microphone…", pttEnabled: false, streaming: false });
    expect(deriveChrome({ ...base, audioReady: false, autoStart: false })).toMatchObject({ screen: "gate", status: "tap to start" });
    expect(deriveChrome({ ...base, audioReady: false, autoStart: true, paired: false }).screen).toBe("pair");
  });

  test("which way frames go, across where the word is detected, the button, a word just heard and the node's state", () => {
    const problems: string[] = [];
    const check = (what: string, got: boolean, want: boolean, input: object) => {
      if (got !== want) problems.push(`${what} is ${got} for ${JSON.stringify(input)}`);
    };
    for (const wake of ["phone", "node", "off"] as const) {
      for (const voice of [undefined, "idle", "listening", "transcribing", "thinking", "speaking"] as const) {
        for (const talking of [false, true]) {
          for (const pending of [false, true]) {
            for (const listening of [false, true]) {
              const input: ChromeInput = { ...base, wake, talking, pending, listening, ...(voice ? { voice } : {}) };
              const c = deriveChrome(input);
              // Whenever the node listens to this phone, audio goes up; with the node detecting, the toggle alone sends it.
              check("streaming", c.streaming, talking || voice === "listening" || pending || (listening && wake === "node"), input);
              // The phone's word runs in phone mode with the toggle on, outside an utterance and the button — through a reply too.
              check("detecting", c.detecting, wake === "phone" && listening && !talking && !pending && voice !== "listening" && voice !== "transcribing", input);
              check("awakeLock", c.awakeLock, talking || voice === "listening" || (listening && wake !== "off"), input);
              check("both ways", c.streaming && c.detecting, false, input);
              // Offline, or before the microphone, nothing at all.
              for (const gone of [{ link: "disconnected" as const }, { audioReady: false }]) {
                const o = deriveChrome({ ...input, ...gone });
                check("anything offline", o.streaming || o.detecting || o.awakeLock, false, { ...input, ...gone });
              }
            }
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test("a remote desktop on the screen: nothing goes up, nothing listens, whatever the node or the button says", () => {
    for (const wake of ["node", "phone"] as const) {
      const input: ChromeInput = { ...base, listening: true, wake, watching: true };
      expect(deriveChrome(input)).toMatchObject({ streaming: false, detecting: false, awakeLock: false });
      expect(deriveChrome({ ...input, voice: "listening", talking: true, pending: true })).toMatchObject({ streaming: false, detecting: false });
      expect(deriveChrome({ ...input, watching: false }).awakeLock).toBe(true);
    }
  });

  test("in phone mode nothing goes up until the word is heard, and then everything until the utterance ends", () => {
    const phone: ChromeInput = { ...base, listening: true, wake: "phone" };
    expect(deriveChrome(phone)).toMatchObject({ streaming: false, detecting: true, awakeLock: true, status: "listening for the wake word" });
    // Heard: frames go up before the node has said a word, and the phone stops listening for another.
    expect(deriveChrome({ ...phone, pending: true })).toMatchObject({ streaming: true, detecting: false });
    expect(deriveChrome({ ...phone, voice: "listening" })).toMatchObject({ streaming: true, detecting: false });
    expect(deriveChrome({ ...phone, voice: "transcribing" })).toMatchObject({ streaming: false, detecting: false });
    // A word over the reply interrupts it.
    expect(deriveChrome({ ...phone, voice: "speaking" })).toMatchObject({ streaming: false, detecting: true });
    // The toggle off stops the word, not an utterance already under way.
    expect(deriveChrome({ ...phone, listening: false })).toMatchObject({ streaming: false, detecting: false, awakeLock: false });
    expect(deriveChrome({ ...phone, listening: false, voice: "listening" })).toMatchObject({ streaming: true, awakeLock: true });
  });

  test("with the node detecting, the phone streams while it listens, as it always did", () => {
    expect(deriveChrome({ ...base, listening: true })).toMatchObject({ streaming: true, detecting: false, awakeLock: true });
    expect(deriveChrome({ ...base, talking: true })).toMatchObject({ streaming: true, detecting: false });
  });

  test("with the wake word off on the node, only the button sends audio, and the status says why", () => {
    const off: ChromeInput = { ...base, listening: true, wake: "off" };
    expect(deriveChrome(off)).toMatchObject({ streaming: false, detecting: false, awakeLock: false, status: "ready — the wake word is off on the node" });
    expect(deriveChrome({ ...off, talking: true })).toMatchObject({ streaming: true, awakeLock: true });
  });

  test("the controls are live only when the node can hear", () => {
    expect(deriveChrome(base).pttEnabled).toBe(true);
    expect(deriveChrome({ ...base, sttReady: false }).pttEnabled).toBe(false);
    expect(deriveChrome({ ...base, sttReady: false }).status).toContain("cannot transcribe");
    expect(deriveChrome({ ...base, link: "connecting" }).pttEnabled).toBe(false);
  });

  test("the dot and the words follow the conversation", () => {
    expect(deriveChrome({ ...base, voice: "listening" })).toMatchObject({ dot: "listening", voiceWord: "listening", status: "listening" });
    expect(deriveChrome({ ...base, voice: "thinking" }).dot).toBe("thinking");
    expect(deriveChrome({ ...base, voice: "speaking" }).dot).toBe("speaking");
    expect(deriveChrome({ ...base, voice: "idle" })).toMatchObject({ dot: "idle", voiceWord: "", status: "ready" });
    expect(deriveChrome({ ...base, link: "disconnected", error: "gone" })).toMatchObject({ dot: "offline", status: "offline — gone" });
  });

  test("the talk button says Hold to talk when it is live, else what it waits on or what the conversation is doing", () => {
    expect(deriveChrome(base).pttLabel).toBe("Hold to talk");
    expect(deriveChrome({ ...base, talking: true }).pttLabel).toBe("listening");
    expect(deriveChrome({ ...base, voice: "thinking" }).pttLabel).toBe("thinking");
    expect(deriveChrome({ ...base, voice: "speaking", via: "relay" }).pttLabel).toBe("speaking");
    expect(deriveChrome({ ...base, sttReady: false }).pttLabel).toBe("cannot transcribe");
    expect(deriveChrome({ ...base, audioReady: false, autoStart: true }).pttLabel).toBe("starting…");
    expect(deriveChrome({ ...base, link: "connecting" }).pttLabel).toBe("connecting…");
    expect(deriveChrome({ ...base, link: "disconnected", error: "gone" }).pttLabel).toBe("offline");
    expect(deriveChrome({ ...base, link: "unauthorized" }).pttLabel).toBe("refused");
  });

  test("an overlay is what the status line shows when there is one", () => {
    expect(deriveChrome({ ...base, overlay: "allow the microphone" }).overlay).toBe("allow the microphone");
  });
});

describe("host.open", () => {
  const origin = "https://192.168.1.44:4818";

  test("a stream page on this origin goes over the view; another page to a window; an invite to its app", () => {
    expect(openTarget(`${origin}/remote/?t=abc`, origin)).toEqual({ kind: "frame", url: `${origin}/remote/?t=abc` });
    expect(openTarget("https://example.com/help", origin)).toEqual({ kind: "window", url: "https://example.com/help" });
    expect(openTarget("https://192.168.1.44:4819/remote/?t=abc", origin).kind).toBe("window");
    expect(openTarget("art://192.168.1.44:47989?pin=1234&passphrase=x&name=study", origin)).toEqual({ kind: "app", url: "art://192.168.1.44:47989?pin=1234&passphrase=x&name=study" });
  });

  test("anything else is refused before it can reach a navigation", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "file:///C:/Windows", "blob:https://x/1", "not a url", 42, undefined, `${origin}/`, `${origin}/view/abc/index.html`]) {
      expect(() => openTarget(bad, origin)).toThrow();
    }
  });
});

// --- the wake word on the phone ------------------------------------------------------------------
