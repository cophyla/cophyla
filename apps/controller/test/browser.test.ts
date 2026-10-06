// The page as a browser on another computer shows it: pairing with a key someone typed, the
// credential a shared computer keeps in memory alone, where a stream's page goes (a frame from
// the node's stream port, over everything or beside the view) and what closing one does, the
// Voice section a wide window has, and what the page calls itself. No browser: the socket, the
// storage, the timers and the few DOM nodes are all faked.

import { describe, expect, test } from "bun:test";
import { deriveChrome } from "../src/chrome.ts";
import type { ChromeInput } from "../src/chrome.ts";
import { LinkCore } from "../src/link-core.ts";
import type { Timers } from "../src/link-core.ts";
import { browserStore, guessBrowser, memoryStore, readCredential, STORAGE_KEY, syncStore } from "../src/pairing.ts";
import type { Credential, Storage } from "../src/pairing.ts";
import { CLAIM_WAIT_MS, openTarget, STREAM_CLAIMED, StreamFrames } from "../src/remote.ts";
import type { Duplex, Transport, TransportKind } from "../src/transport.ts";
import { InstallOffer } from "../src/install.ts";
import { BrowserVoice, LISTEN_KEY, MIC_KEY, SPEAK_KEY } from "../src/voice.ts";

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

class FakeTimers implements Timers {
  private handlers = new Map<number, { at: number; fn: () => void }>();
  private next = 1;
  now = 0;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.handlers.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.handlers.delete(handle as number);
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, entry] of [...this.handlers].sort((a, b) => a[1].at - b[1].at)) {
      if (entry.at > this.now) continue;
      this.handlers.delete(id);
      entry.fn();
    }
  }
}

class FakeDuplex implements Duplex {
  readonly sent: Record<string, unknown>[] = [];
  closed?: { code: number; reason: string };
  onmessage: ((text: string) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.onclose?.(code, reason);
  }
  deliver(frame: unknown): void {
    this.onmessage?.(JSON.stringify(frame));
  }
  last(method: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((f) => f["method"] === method);
  }
}

class FakeTransport implements Transport {
  readonly opened: FakeDuplex[] = [];
  readonly kind: TransportKind = "lan";
  label = "wss://192.168.1.44:4818/ws/client";
  async open(): Promise<Duplex> {
    const d = new FakeDuplex();
    this.opened.push(d);
    return d;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const helloOk = (id: unknown) => ({ jsonrpc: "2.0", id, result: { client: { id: "cli_1", kind: "controller", scopes: ["chat"], via: "direct", audio: { in: true, out: true }, connectedAt: 1 }, node: "node_1", protocolVersion: 1, platformVersion: "0.13.0" } });

async function core(storage = new FakeStorage()) {
  const timers = new FakeTimers();
  const lan = new FakeTransport();
  const link = new LinkCore({ store: browserStore(storage), name: "Firefox on Linux", lan: () => [lan], timers, now: () => timers.now, random: () => 0.5 });
  const states: { state: string; error?: string }[] = [];
  await link.listen<{ state: string; error?: string }>("cophylad:state", (s) => states.push(s));
  await link.load();
  return { link, lan, storage, timers, states };
}

// --- pairing with a key -----------------------------------------------------------------------

describe("a browser's key", () => {
  test("is spent with browser.pair on the page's own socket, then hello on the same one; the credential keeps when its access ends", async () => {
    const { link, lan, storage, states } = await core();
    const paired = link.pairKey("7kq2 m9xf 3zta b6wd", "Firefox on Linux");
    await tick();
    const d = lan.opened[0]!;
    const claim = d.last("browser.pair")!;
    // as it was typed: the node reads it its own way
    expect(claim["params"]).toEqual({ key: "7kq2 m9xf 3zta b6wd", name: "Firefox on Linux" });
    d.deliver({ jsonrpc: "2.0", id: claim["id"], result: { token: "tok", client: { id: "ctl_1", name: "Laptop", pairedAt: 1, connected: false, form: "browser", expiresAt: 5000 } } });
    expect((await paired).id).toBe("ctl_1");
    await tick();
    expect(readCredential(storage)).toEqual({ token: "tok", controller: "ctl_1", name: "Firefox on Linux", lan: ["wss://192.168.1.44:4818/ws/client"], expiresAt: 5000 });
    const hello = d.last("hello")!;
    expect(hello["params"]).toMatchObject({ token: "tok", kind: "controller" });
    d.deliver(helloOk(hello["id"]));
    expect(states.at(-1)?.state).toBe("connected");
  });

  test("a refused key rejects in the node's words, keeps nothing, and a view may not send one", async () => {
    const { link, lan, storage, states } = await core();
    const paired = link.pairKey("0000-0000-0000-0000", "x");
    await tick();
    const d = lan.opened[0]!;
    d.deliver({ jsonrpc: "2.0", id: d.last("browser.pair")!["id"], error: { code: -32000, message: "that key is not open", data: { code: "denied", message: "that key is not open", retryable: false } } });
    await expect(paired).rejects.toThrow("that key is not open");
    expect(storage.map.size).toBe(0);
    expect(states.at(-1)).toMatchObject({ state: "unauthorized", error: "that key is not open" });
    await expect(link.invoke("cophylad_send", { frame: { jsonrpc: "2.0", id: 1, method: "browser.pair", params: { key: "x", name: "y" } } })).rejects.toThrow(/the controller's own/);
  });

  test("a second pairing while one is under way is refused, and a key cut off before its answer says to type it again", async () => {
    const { link, lan } = await core();
    const first = link.pairKey("7KQ2-M9XF-3ZTA-B6WD", "x");
    await tick();
    await expect(link.pair("482913", "x")).rejects.toThrow(/already under way/);
    lan.opened[0]!.close(1006, "");
    await expect(first).rejects.toThrow(/type the key again/);
  });
});

// --- a shared computer -------------------------------------------------------------------------

describe("a shared computer", () => {
  test("says keep: false with the key, the code and the invite, and its credential is never written", async () => {
    for (const how of ["key", "code", "invite"] as const) {
      const { link, lan, storage } = await core();
      const paired =
        how === "key"
          ? link.pairKey("7KQ2-M9XF-3ZTA-B6WD", "Library", { keep: false })
          : how === "code"
            ? link.pair("482913", "Library", undefined, { keep: false })
            : link.redeem({ grant: "ctl_1", secret: "ab".repeat(32) }, "Library", { lans: [lan] }, { keep: false });
      await tick();
      const d = lan.opened[0]!;
      const claim = d.last(how === "key" ? "browser.pair" : how === "code" ? "pair.claim" : "invite.redeem")!;
      expect((claim["params"] as { keep?: boolean }).keep).toBe(false);
      d.deliver({ jsonrpc: "2.0", id: claim["id"], result: { token: "tok", client: { id: "ctl_1", name: "Library", pairedAt: 1, connected: false, form: "browser", session: true, expiresAt: 9000 } } });
      await paired;
      await tick();
      expect(link.credential).toMatchObject({ token: "tok", session: true, expiresAt: 9000 });
      // nothing of it in the page's storage, under any key
      expect(storage.map.size).toBe(0);
      expect(JSON.stringify([...storage.map])).not.toContain("tok");
    }
  });

  test("a kept pairing leaves no shared one behind, and a shared one takes a kept one's place", async () => {
    const storage = new FakeStorage();
    const store = browserStore(storage);
    const kept: Credential = { token: "kept", controller: "ctl_1", name: "Firefox" };
    const shared: Credential = { token: "shared", controller: "ctl_2", name: "Library", session: true };
    await store.write(kept);
    expect(storage.map.has(STORAGE_KEY)).toBe(true);
    await store.write(shared);
    expect(storage.map.size).toBe(0);
    expect(await store.read()).toEqual(shared);
    // the page reloaded: memory is gone, and there is nothing to read
    expect(await browserStore(storage).read()).toBeUndefined();
    await store.write(kept);
    expect(await store.read()).toEqual(kept);
    expect(await syncStore(storage).read()).toEqual(kept);
    await store.forget();
    expect(await store.read()).toBeUndefined();
    expect(storage.map.size).toBe(0);
    const mem = memoryStore();
    await mem.write(shared);
    expect(await mem.read()).toEqual(shared);
    await mem.forget();
    expect(await mem.read()).toBeUndefined();
  });

  test("a page going away asks the node to end its own grant, and waits for no answer", async () => {
    const { link, lan } = await core();
    // nothing to say before it is paired and connected
    link.revokeSelf();
    const paired = link.pairKey("7KQ2-M9XF-3ZTA-B6WD", "Library", { keep: false });
    await tick();
    const d = lan.opened[0]!;
    d.deliver({ jsonrpc: "2.0", id: d.last("browser.pair")!["id"], result: { token: "tok", client: { id: "ctl_9", name: "Library", pairedAt: 1, connected: false, session: true } } });
    await paired;
    await tick();
    link.revokeSelf();
    expect(d.last("controller.revoke")).toBeUndefined();
    d.deliver(helloOk(d.last("hello")!["id"]));
    link.revokeSelf();
    expect(d.last("controller.revoke")!["params"]).toEqual({ id: "ctl_9" });
  });

  test("a hello the node refuses drops the credential: the session ended there", async () => {
    const { link, lan, states } = await core();
    const paired = link.pairKey("7KQ2-M9XF-3ZTA-B6WD", "Library", { keep: false });
    await tick();
    const d = lan.opened[0]!;
    d.deliver({ jsonrpc: "2.0", id: d.last("browser.pair")!["id"], result: { token: "tok", client: { id: "ctl_9", name: "Library", pairedAt: 1, connected: false, session: true } } });
    await paired;
    await tick();
    d.deliver({ jsonrpc: "2.0", id: d.last("hello")!["id"], error: { code: -32000, message: "bad token", data: { code: "denied", message: "bad token", retryable: false } } });
    await tick();
    expect(link.credential).toBeUndefined();
    expect(states.at(-1)?.state).toBe("unauthorized");
  });
});

// --- what the page calls itself, and its form ---------------------------------------------------

describe("the page in a wide window", () => {
  const base: ChromeInput = { link: "connected", paired: true, audioReady: false, sttReady: true, listening: false, wake: "node", pending: false, talking: false, muted: false };

  test("there is no Start screen: the audio starts at the first click, wherever it lands", () => {
    expect(deriveChrome(base).screen).toBe("gate");
    expect(deriveChrome({ ...base, desk: true }).screen).toBe("main");
    expect(deriveChrome({ ...base, desk: true, paired: false }).screen).toBe("pair");
  });

  test("a browser on a computer is named by the browser and what it runs on", () => {
    expect(guessBrowser("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("Firefox on Linux");
    expect(guessBrowser("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")).toBe("Chrome on Windows");
    expect(guessBrowser("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0")).toBe("Edge on Windows");
    expect(guessBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15")).toBe("Safari on a Mac");
    expect(guessBrowser("")).toBe("A browser");
  });
});

// --- host.open --------------------------------------------------------------------------------

describe("where a stream's page goes", () => {
  const origin = "https://192.168.1.44:4818";
  const stream = "https://192.168.1.44:4820/remote/?t=abc";

  test("a page under /remote/ on this host's other port is framed; this page's own origin frames nothing; anywhere else is a window", () => {
    expect(openTarget(stream, origin)).toEqual({ kind: "frame", url: stream });
    expect(openTarget("https://example.com/help", origin)).toEqual({ kind: "window", url: "https://example.com/help" });
    // another host, plain http, or not a stream page: never a frame
    expect(openTarget("https://192.168.1.45:4820/remote/?t=abc", origin).kind).toBe("window");
    expect(openTarget("http://192.168.1.44:4820/remote/?t=abc", origin).kind).toBe("window");
    expect(openTarget("https://192.168.1.44:4820/other", origin).kind).toBe("window");
    expect(openTarget("https://user:pw@192.168.1.44:4820/remote/", origin).kind).toBe("window");
    expect(openTarget("art://192.168.1.44:47989?pin=1234", origin).kind).toBe("app");
    for (const bad of [`${origin}/remote/?t=abc`, `${origin}/`, `${origin}/view/abc/index.html`, "javascript:alert(1)", "data:text/html,x", 42, undefined]) expect(() => openTarget(bad, origin)).toThrow();
  });

  /** A document of just what the frames touch. */
  function page() {
    type El = {
      tag: string;
      id?: string;
      className: string;
      hidden: boolean;
      src?: string;
      textContent?: string;
      style: Record<string, string>;
      children: El[];
      parent?: El;
      listeners: Map<string, () => void>;
      contentWindow: object;
      append(...kids: El[]): void;
      remove(): void;
      setAttribute(k: string, v: string): void;
      addEventListener(name: string, fn: () => void): void;
    };
    const make = (tag: string): El => {
      const el: El = {
        tag,
        className: "",
        hidden: false,
        style: {},
        children: [],
        listeners: new Map(),
        contentWindow: {},
        append: (...kids) => {
          for (const k of kids) {
            k.parent = el;
            el.children.push(k);
          }
        },
        remove: () => {
          if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el);
          delete el.parent;
        },
        setAttribute: () => {},
        addEventListener: (name, fn) => void el.listeners.set(name, fn),
      };
      return el;
    };
    const body = make("body");
    let onMessage: ((ev: { data: unknown; source: unknown; origin: string }) => void) | undefined;
    const opened: string[] = [];
    const doc = {
      body,
      createElement: make,
      defaultView: { addEventListener: (_n: string, fn: typeof onMessage) => void (onMessage = fn), open: (url: string) => void opened.push(url), location: { href: "" } },
    };
    const all = (tag: string): El[] => {
      const out: El[] = [];
      const walk = (el: El) => {
        if (el.tag === tag) out.push(el);
        el.children.forEach(walk);
      };
      walk(body);
      return out;
    };
    return { doc: doc as unknown as Document, body, all, opened, message: (ev: { data: unknown; source: unknown; origin: string }) => onMessage?.(ev) };
  }

  function frames(opts: { embed?: boolean } = {}) {
    const p = page();
    const timers = new FakeTimers();
    const requests: { method: string; params: unknown }[] = [];
    const closed: string[] = [];
    const covers: boolean[] = [];
    const f = new StreamFrames({
      doc: p.doc,
      origin,
      request: async (method, params) => void requests.push({ method, params }),
      frame: () => ({ left: 300, top: 40, width: 900, height: 700 }),
      ...(opts.embed ? { embed: true } : {}),
      onClosed: (s) => void closed.push(s),
      onCover: (c) => void covers.push(c),
      timers: { setTimeout: (h, ms) => timers.setTimeout(h, ms), clearTimeout: (h) => timers.clearTimeout(h) },
    });
    return { ...p, f, timers, requests, closed, covers };
  }

  test("on a phone a stream covers the page until Close, which ends its session on the node and tells the view", async () => {
    const { f, all, requests, closed, covers } = frames();
    expect(await f.host("host.open", { url: stream, stream: "stream_01" })).toEqual({});
    const [frame] = all("iframe");
    expect(frame!.src).toBe(stream);
    expect(frame!.parent!.className).toBe("remote-layer");
    expect(covers).toEqual([true]);
    // the view asked for it beside itself, where this page lays none there: still over everything
    expect(await f.host("host.open", { url: stream, stream: "stream_02", embed: true })).toEqual({});
    expect(all("iframe").length).toBe(1);
    expect(requests).toEqual([{ method: "remote.close", params: { stream: "stream_01" } }]);
    expect(closed).toEqual(["stream_01"]);
    all("button").find((b) => b.textContent === "Close")!.listeners.get("click")!();
    expect(all("iframe").length).toBe(0);
    expect(requests.at(-1)).toEqual({ method: "remote.close", params: { stream: "stream_02" } });
    expect(closed).toEqual(["stream_01", "stream_02"]);
    expect(covers.at(-1)).toBe(false);
  });

  test("in a wide window it lies beside the view where the view places it, inside the view's frame, and hides under the page's own layers", async () => {
    const { f, all, requests, closed } = frames({ embed: true });
    expect(await f.host("host.open", { url: stream, stream: "stream_01", embed: true })).toEqual({ embedded: true });
    const [frame] = all("iframe");
    expect(frame!.className).toBe("stream-frame");
    expect(frame!.hidden).toBe(true);
    await f.host("host.place", { stream: "stream_01", rect: { x: 400, y: 10, width: 480, height: 300 } });
    expect(frame!.hidden).toBe(false);
    expect(frame!.style).toMatchObject({ left: "700px", top: "50px", width: "480px", height: "300px" });
    // past the frame's edge: cut to it
    await f.host("host.place", { stream: "stream_01", rect: { x: 800, y: 600, width: 480, height: 300 } });
    expect(frame!.style).toMatchObject({ left: "1100px", top: "640px", width: "100px", height: "100px" });
    f.overlay(true);
    expect(frame!.hidden).toBe(true);
    f.overlay(false);
    expect(frame!.hidden).toBe(false);
    await f.host("host.place", { stream: "stream_01", rect: null });
    expect(frame!.hidden).toBe(true);
    await expect(f.host("host.place", { stream: "stream_99", rect: null })).rejects.toThrow(/no such stream/);
    await f.host("host.close", { stream: "stream_01" });
    expect(all("iframe").length).toBe(0);
    expect(requests).toEqual([{ method: "remote.close", params: { stream: "stream_01" } }]);
    expect(closed).toEqual(["stream_01"]);
    // closing what is not there is nothing
    await f.host("host.close", { stream: "stream_01" });
    expect(requests.length).toBe(1);
  });

  test("the view's document going closes what it laid beside itself; the link going takes the frames and asks the node nothing", async () => {
    const a = frames({ embed: true });
    await a.f.host("host.open", { url: stream, stream: "stream_01", embed: true });
    a.f.unmounted();
    expect(a.all("iframe").length).toBe(0);
    expect(a.requests).toEqual([{ method: "remote.close", params: { stream: "stream_01" } }]);
    const b = frames({ embed: true });
    await b.f.host("host.open", { url: stream, stream: "stream_01", embed: true });
    b.f.linkLost();
    expect(b.all("iframe").length).toBe(0);
    expect(b.requests).toEqual([]);
    expect(b.closed).toEqual(["stream_01"]);
  });

  test("a frame that never says it loaded gets the stream's address to open once; one that does, never", async () => {
    const a = frames({ embed: true });
    await a.f.host("host.open", { url: stream, stream: "stream_01", embed: true });
    await a.f.host("host.place", { stream: "stream_01", rect: { x: 0, y: 0, width: 400, height: 300 } });
    a.timers.advance(CLAIM_WAIT_MS);
    const [link] = a.all("a") as unknown as { href: string }[];
    expect(link!.href).toBe("https://192.168.1.44:4820/remote/ready");
    // the frame loads after all (the certificate was accepted and the view asked again): the note goes
    const [frame] = a.all("iframe");
    a.message({ data: { cophyla: STREAM_CLAIMED }, source: frame!.contentWindow, origin: "https://192.168.1.44:4820" });
    expect(a.all("a").length).toBe(0);

    const b = frames({ embed: true });
    await b.f.host("host.open", { url: stream, stream: "stream_01", embed: true });
    const [loaded] = b.all("iframe");
    // only the frame itself, on the stream's own origin, is believed
    b.message({ data: { cophyla: STREAM_CLAIMED }, source: {}, origin: "https://192.168.1.44:4820" });
    b.message({ data: { cophyla: STREAM_CLAIMED }, source: loaded!.contentWindow, origin: "https://evil.example" });
    b.message({ data: { cophyla: STREAM_CLAIMED }, source: loaded!.contentWindow, origin: "https://192.168.1.44:4820" });
    b.timers.advance(CLAIM_WAIT_MS);
    expect(b.all("a").length).toBe(0);
  });

  test("another page opens in a window, an older view's stream with no id is shown and closed without a word to the node", async () => {
    const { f, all, opened, requests, closed } = frames();
    await f.host("host.open", { url: "https://example.com/help" });
    expect(opened).toEqual(["https://example.com/help"]);
    await f.host("host.open", { url: stream });
    expect(all("iframe").length).toBe(1);
    all("button").find((b) => b.textContent === "Close")!.listeners.get("click")!();
    expect(requests).toEqual([]);
    expect(closed).toEqual([]);
    await expect(f.host("host.open", { url: `${origin}/remote/?t=abc` })).rejects.toThrow(/only a stream page/);
    await expect(f.host("host.nothing", {})).rejects.toThrow(/no host.nothing/);
  });
});

// --- voice ----------------------------------------------------------------------------------

// --- installing the page as an app -----------------------------------------------------------

describe("the browser's offer to install the page", () => {
  /** A window as far as the offer goes: what listens, and how an event is raised. */
  function fakeWindow() {
    const listeners = new Map<string, ((ev: unknown) => void)[]>();
    return {
      addEventListener: (type: string, listener: (ev: unknown) => void) => void listeners.set(type, [...(listeners.get(type) ?? []), listener]),
      raise: (type: string, ev: unknown = {}) => {
        for (const l of listeners.get(type) ?? []) l(ev);
      },
    };
  }
  function prompt(outcome: "accepted" | "dismissed" = "accepted") {
    const p = { held: 0, asked: 0, preventDefault: () => void p.held++, prompt: async () => void p.asked++, userChoice: Promise.resolve({ outcome }) };
    return p;
  }

  test("in a wide window the offer is held back from the browser's banner and kept for the settings; it asks once", async () => {
    const win = fakeWindow();
    const offer = new InstallOffer(win, { hold: true });
    let changes = 0;
    offer.subscribe(() => changes++);
    expect(offer.available).toBe(false);
    expect(await offer.prompt()).toBe("unavailable");
    const p = prompt();
    win.raise("beforeinstallprompt", p);
    expect(p.held).toBe(1);
    expect(offer.available).toBe(true);
    expect(changes).toBe(1);
    expect(await offer.prompt()).toBe("accepted");
    expect(p.asked).toBe(1);
    // spent, whatever the answer: a second press asks nothing
    expect(offer.available).toBe(false);
    expect(await offer.prompt()).toBe("unavailable");
    expect(p.asked).toBe(1);
    // the browser offers again when it will, and a no is a no
    const again = prompt("dismissed");
    win.raise("beforeinstallprompt", again);
    expect(offer.available).toBe(true);
    expect(await offer.prompt()).toBe("dismissed");
  });

  test("a phone's browser keeps its own way of offering it; installed, the offer is gone", () => {
    const win = fakeWindow();
    const offer = new InstallOffer(win, { hold: false });
    const p = prompt();
    win.raise("beforeinstallprompt", p);
    expect(p.held).toBe(0);
    expect(offer.available).toBe(true);
    let changes = 0;
    const stop = offer.subscribe(() => changes++);
    win.raise("appinstalled");
    expect(offer.available).toBe(false);
    expect(offer.installed).toBe(true);
    expect(changes).toBe(1);
    stop();
    win.raise("beforeinstallprompt", prompt());
    expect(changes).toBe(1);
  });
});

describe("voice in a wide window", () => {
  class MapStore {
    readonly map = new Map<string, string>();
    getItem(key: string): string | null {
      return this.map.get(key) ?? null;
    }
    setItem(key: string, value: string): void {
      this.map.set(key, value);
    }
  }

  function fixture(stored: Record<string, string> = {}) {
    const store = new MapStore();
    for (const [k, v] of Object.entries(stored)) store.setItem(k, v);
    const link = { connected: true, state: {}, request: async <T>(): Promise<T> => ({}) as T, send: async () => {} };
    return { voice: new BrowserVoice({ link, store, log: () => {} }), store };
  }

  test("it says nothing while it is being made: the page that makes it has nothing to paint it with yet", () => {
    const store = new MapStore();
    store.setItem(SPEAK_KEY, "off");
    const link = { connected: true, state: {}, request: async <T>(): Promise<T> => ({}) as T, send: async () => {} };
    let changes = 0;
    let made: BrowserVoice | undefined;
    // as the page does: the callback reads what the constructor has not returned yet
    const voice: BrowserVoice = new BrowserVoice({
      link,
      store,
      log: () => {},
      onChange: () => {
        changes++;
        void made!.state();
      },
    });
    made = voice;
    expect(changes).toBe(0);
    expect(voice.state().speak).toBe(false);
    // and it speaks up from then on
    void voice.setSpeak(true);
    expect(changes).toBeGreaterThan(0);
  });

  test("listening for the wake words is off until it is switched on, and stays as it was left; speaking is on", () => {
    const fresh = fixture();
    expect(fresh.voice.state()).toMatchObject({ listening: false, speak: true, talkKey: "" });
    fresh.voice.setListening(true);
    fresh.voice.setSpeak(false);
    expect(fresh.voice.state()).toMatchObject({ listening: true, speak: false });
    expect(fresh.store.map.get(LISTEN_KEY)).toBe("on");
    expect(fresh.store.map.get(SPEAK_KEY)).toBe("off");
    expect(fixture({ [LISTEN_KEY]: "on" }).voice.state().listening).toBe(true);
    expect(fixture({ [LISTEN_KEY]: "off", [SPEAK_KEY]: "off" }).voice.state()).toMatchObject({ listening: false, speak: false });
  });

  test("there is no talk key to set, and the section says the microphone waits for a click", () => {
    const { voice } = fixture();
    expect("setTalkKey" in voice).toBe(false);
    expect(voice.state().status).toBe("The microphone starts at the first click on this page.");
  });

  test("the microphone picked is kept, and what is kept is read back", () => {
    const { voice } = fixture({ [MIC_KEY]: JSON.stringify({ id: "mic-2", label: "Desk microphone" }) });
    expect(voice.state().micChoice).toEqual({ id: "mic-2", label: "Desk microphone" });
    let changed = 0;
    const off = voice.subscribe(() => changed++);
    voice.setListening(true);
    expect(changed).toBeGreaterThan(0);
    off();
  });
});
