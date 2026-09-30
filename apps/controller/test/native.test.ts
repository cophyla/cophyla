// The native app's own modules over fakes: the LAN transport over the socket plugin (the key
// learned at pairing, the pin refused and never retried), the push bridge (deep links,
// registration replayed until acknowledged, answers queued for the link and dropped when
// stale) and local view staging (files per version, the policy in the entry once, pruning,
// and a version written whole not fetched again); and the remote desktop in the app (where
// `host.open` sends what the view handed it, and a stream's lifetime around the plugin).

import { describe, expect, test } from "bun:test";
import type { ViewContent, ViewManifest } from "@cophyla/protocol";
import { DOC_FRAME_FILE, DOC_FRAME_META_CSP, docFramePage } from "@cophyla/protocol";
import { nativeTransport, PIN_MISMATCH, PIN_MISMATCH_MESSAGE } from "../src/native/native-io.ts";
import type { FrameEvent, CophylaSocketPlugin, StateEvent } from "../src/native/native-io.ts";
import { ANSWER_TTL_MS, parseAskLink, PushBridge } from "../src/native/push.ts";
import { STAGED_MARK, stageLocally, VIEW_CSP, withCsp } from "../src/native/stage.ts";
import type { FsLike } from "../src/native/stage.ts";
import { parseAddress } from "../src/pairing.ts";
import type { Credential } from "../src/pairing.ts";
import { AWAY_MESSAGE, PipeBridge, planOpen, Streams } from "../src/native/stream.ts";
import type { OpenPlan, CophylaStreamPlugin, PlanContext, StreamClosed } from "../src/native/stream.ts";

// --- the socket plugin, played ---------------------------------------------------------------

class FakePlugin implements CophylaSocketPlugin {
  readonly attached: { id: string; url: string; pin?: string }[] = [];
  readonly sent: { id: string; frame: string }[] = [];
  readonly closed: { id: string; code?: number; reason?: string }[] = [];
  private frameListeners = new Set<(e: FrameEvent) => void>();
  private stateListeners = new Set<(e: StateEvent) => void>();
  /** The SPKI the "node" presents. */
  spki = "AAAA=";
  async attach(options: { id: string; url: string; pin?: string }): Promise<void> {
    this.attached.push(options);
    // the handshake: a pin that does not match the node's key closes at once
    queueMicrotask(() => {
      if (options.pin !== undefined && options.pin !== this.spki) this.state({ id: options.id, state: "closed", code: 1006, reason: PIN_MISMATCH });
      else this.state({ id: options.id, state: "open", ...(options.pin === undefined ? { spki: this.spki } : {}) });
    });
  }
  async send(options: { id: string; frame: string }): Promise<void> {
    this.sent.push(options);
  }
  async close(options: { id: string; code?: number; reason?: string }): Promise<void> {
    this.closed.push(options);
    this.state({ id: options.id, state: "closed", code: options.code ?? 1000, reason: options.reason ?? "" });
  }
  async addListener(event: "frame" | "state", fn: ((e: FrameEvent) => void) | ((e: StateEvent) => void)): Promise<{ remove(): Promise<void> }> {
    if (event === "frame") {
      const f = fn as (e: FrameEvent) => void;
      this.frameListeners.add(f);
      return { remove: async () => void this.frameListeners.delete(f) };
    }
    const s = fn as (e: StateEvent) => void;
    this.stateListeners.add(s);
    return { remove: async () => void this.stateListeners.delete(s) };
  }
  frame(e: FrameEvent): void {
    for (const f of [...this.frameListeners]) f(e);
  }
  state(e: StateEvent): void {
    for (const s of [...this.stateListeners]) s(e);
  }
}

describe("the native LAN transport", () => {
  test("pairing without a pin learns the node's key; a later socket carries the pin, frames flow both ways, and the close is reported", async () => {
    const plugin = new FakePlugin();
    let learned: string | undefined;
    const pairing = nativeTransport({ host: "192.168.1.44", port: 4818 }, plugin, { onSpki: (s) => (learned = s) });
    expect(pairing.label).toBe("wss://192.168.1.44:4818/ws/client");
    const d = await pairing.open();
    expect(learned).toBe("AAAA=");
    expect(plugin.attached[0]).toEqual({ id: expect.any(String), url: "wss://192.168.1.44:4818/ws/client" });
    const got: string[] = [];
    d.onmessage = (t) => got.push(t);
    plugin.frame({ id: plugin.attached[0]!.id, frame: "{\"x\":1}" });
    plugin.frame({ id: "other", frame: "not mine" });
    expect(got).toEqual(["{\"x\":1}"]);
    d.send("up");
    await Promise.resolve();
    expect(plugin.sent).toEqual([{ id: plugin.attached[0]!.id, frame: "up" }]);
    let closed: [number, string] | undefined;
    d.onclose = (code, reason) => (closed = [code, reason]);
    d.close(4401, "revoked");
    await Promise.resolve();
    expect(closed).toEqual([4401, "revoked"]);
    // with the pin
    const pinned = nativeTransport({ host: "192.168.1.44", port: 4818, spki: "AAAA=" }, plugin, { pin: "AAAA=" });
    await pinned.open();
    expect(plugin.attached[1]?.pin).toBe("AAAA=");
  });

  test("a changed key is refused with pin_mismatch and the transport never tries again on its own", async () => {
    const plugin = new FakePlugin();
    plugin.spki = "BBBB=";
    const pinned = nativeTransport({ host: "192.168.1.44", port: 4818, spki: "AAAA=" }, plugin, { pin: "AAAA=" });
    await expect(pinned.open()).rejects.toThrow(PIN_MISMATCH_MESSAGE);
    expect(pinned.mismatched).toBe(true);
    await expect(pinned.open()).rejects.toThrow(PIN_MISMATCH_MESSAGE);
    expect(plugin.attached).toHaveLength(1);
  });

  test("the address field takes host, host:port and a pasted URL", () => {
    expect(parseAddress("192.168.1.44")).toEqual({ host: "192.168.1.44", port: 4818 });
    expect(parseAddress(" desk.local:4900 ")).toEqual({ host: "desk.local", port: 4900 });
    expect(parseAddress("https://192.168.1.44:4818/?code=123456")).toEqual({ host: "192.168.1.44", port: 4818 });
    expect(parseAddress("[fe80::1]:4818")).toEqual({ host: "[fe80::1]", port: 4818 });
    expect(parseAddress("")).toBeUndefined();
    expect(parseAddress("host:99999")).toBeUndefined();
  });
});

// --- push ---------------------------------------------------------------------------------------

describe("push on the phone", () => {
  test("deep links parse, percent-encoded option ids included", () => {
    expect(parseAskLink("cophyla://ask/ask_1/allow")).toEqual({ ask: "ask_1", option: "allow" });
    expect(parseAskLink("cophyla://ask/ask_1")).toEqual({ ask: "ask_1" });
    expect(parseAskLink("cophyla://ask/ask_1/always%20allow%2Fwrite")).toEqual({ ask: "ask_1", option: "always allow/write" });
    expect(parseAskLink("cophyla://ask/ask_1/deny?x=1")).toEqual({ ask: "ask_1", option: "deny" });
    expect(parseAskLink("cophyla://other/ask_1")).toBeUndefined();
    expect(parseAskLink("https://orc.example/ask/1")).toBeUndefined();
    expect(parseAskLink("cophyla://ask/%E0%A4%A")).toBeUndefined();
  });

  test("the registration is sent on every connect until the node took it; a new token starts over", async () => {
    const calls: { method: string; params: unknown }[] = [];
    let connected = false;
    let refuse = true;
    const bridge = new PushBridge({
      request: async (method, params) => {
        calls.push({ method, params });
        if (refuse) throw new Error("unavailable");
        return {};
      },
      connected: () => connected,
      platform: "android",
    });
    bridge.onToken("fcm-1");
    expect(calls).toEqual([]);
    connected = true;
    bridge.onConnected();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([{ method: "push.register", params: { platform: "android", token: "fcm-1" } }]);
    expect(bridge.registered).toBe(false);
    refuse = false;
    bridge.onConnected();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(2);
    expect(bridge.registered).toBe(true);
    bridge.onConnected();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(2);
    bridge.onToken("fcm-2");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.at(-1)).toEqual({ method: "push.register", params: { platform: "android", token: "fcm-2" } });
  });

  test("an answer from a button waits for the link, lands once, and is dropped after a minute", async () => {
    const calls: { method: string; params: unknown }[] = [];
    let connected = false;
    let now = 1_000_000;
    const bridge = new PushBridge({ request: async (method, params) => void calls.push({ method, params }), connected: () => connected, platform: "android", now: () => now });
    expect(bridge.onLink("cophyla://ask/ask_1/allow")).toEqual({ ask: "ask_1", option: "allow" });
    expect(bridge.pending).toBe(1);
    // a second tap on the same ask replaces the first
    bridge.onLink("cophyla://ask/ask_1/deny");
    expect(bridge.pending).toBe(1);
    connected = true;
    bridge.onConnected();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([{ method: "ask.answer", params: { id: "ask_1", option: "deny" } }]);
    expect(bridge.pending).toBe(0);
    // stale: queued while offline, the link comes back too late
    connected = false;
    bridge.onLink("cophyla://ask/ask_2/allow");
    now += ANSWER_TTL_MS + 1;
    connected = true;
    bridge.onConnected();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(1);
    // a link without an option is the body tap: nothing to answer
    expect(bridge.onLink("cophyla://ask/ask_3")).toEqual({ ask: "ask_3" });
    expect(bridge.pending).toBe(0);
  });
});

// --- staging ----------------------------------------------------------------------------------------

class FakeFs implements FsLike {
  readonly files = new Map<string, string>();
  async writeFile(o: { path: string; data: string; directory: string; encoding?: "utf8"; recursive?: boolean }): Promise<void> {
    this.files.set(`${o.directory}/${o.path}`, (o.encoding ? "text:" : "b64:") + o.data);
  }
  async readFile(o: { path: string; directory: string; encoding: "utf8" }): Promise<{ data: unknown }> {
    const stored = this.files.get(`${o.directory}/${o.path}`);
    if (stored === undefined) throw new Error("no such file");
    return { data: stored.replace(/^text:/, "") };
  }
  async readdir(o: { path: string; directory: string }): Promise<{ files: { name: string; type: string }[] }> {
    const prefix = `${o.directory}/${o.path}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0]!);
    if (names.size === 0) throw new Error("no such directory");
    return { files: [...names].map((name) => ({ name, type: "directory" })) };
  }
  async rmdir(o: { path: string; directory: string }): Promise<void> {
    const prefix = `${o.directory}/${o.path}/`;
    for (const key of [...this.files.keys()]) if (key.startsWith(prefix)) this.files.delete(key);
  }
  async getUri(o: { path: string; directory: string }): Promise<{ uri: string }> {
    return { uri: `file:///data/app/${o.directory.toLowerCase()}/${o.path}` };
  }
}

const MANIFEST: ViewManifest = { id: "default", name: "Chat", entry: "index.html", default: true, source: "builtin", scopes: ["chat"] };

describe("local staging", () => {
  test("writes each file under the view's version, puts the policy into the entry once, prunes older versions, and answers the base URL", async () => {
    const fs = new FakeFs();
    const versions: Record<string, ViewContent> = {
      v1: { id: "default", version: "v1", files: [{ path: "index.html", mime: "text/html", text: "<!doctype html><html><head><title>x</title></head><body></body></html>" }, { path: "app.js", mime: "text/javascript", text: "console.log(1)" }] },
      v2: { id: "default", version: "v2", files: [{ path: "index.html", mime: "text/html", text: "<html><head></head></html>" }, { path: "img/logo.png", mime: "image/png", base64: "iVBORw0KGgo=" }] },
    };
    let current = "v1";
    const deps = { fs, fileUrl: (p: string) => `https://localhost/_capacitor_file_${p.replace("file://", "")}`, get: async () => versions[current]! };
    const first = await stageLocally(deps, MANIFEST);
    expect(first).toEqual({ base: "https://localhost/_capacitor_file_/data/app/data/views/default/v1/", version: "v1", docFrame: "https://localhost/_capacitor_file_/data/app/data/views/default/v1/docframe.html" });
    // The document frame beside it, its policy in its head, sandboxing left to the frame's attribute.
    expect(fs.files.get(`DATA/views/default/v1/${DOC_FRAME_FILE}`)).toBe(`text:${docFramePage()}`);
    expect(docFramePage()).toContain(`<meta http-equiv="Content-Security-Policy" content="${DOC_FRAME_META_CSP}">`);
    expect(DOC_FRAME_META_CSP).not.toContain("sandbox");
    expect(DOC_FRAME_META_CSP).toContain("connect-src 'none'");
    expect(fs.files.get("DATA/views/default/v1/index.html")).toBe(`text:<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${VIEW_CSP}"><title>x</title></head><body></body></html>`);
    expect(fs.files.get("DATA/views/default/v1/app.js")).toBe("text:console.log(1)");
    current = "v2";
    const second = await stageLocally(deps, MANIFEST);
    expect(second.version).toBe("v2");
    expect(fs.files.get("DATA/views/default/v2/img/logo.png")).toBe("b64:iVBORw0KGgo=");
    expect([...fs.files.keys()].some((k) => k.includes("/v1/"))).toBe(false);
    // the policy goes in once
    expect(withCsp(withCsp("<head></head>"))).toBe(withCsp("<head></head>"));
    expect(withCsp("no head at all")).toStartWith("<meta http-equiv");
  });

  test("a version written whole is loaded from storage without view.get; one cut off, or served by another platform, is fetched again", async () => {
    const fs = new FakeFs();
    const content: ViewContent = { id: "default", version: "v1", files: [{ path: "index.html", mime: "text/html", text: "<html><head></head></html>" }, { path: "app.js", mime: "text/javascript", text: "console.log(1)" }] };
    let gets = 0;
    const deps = { fs, fileUrl: (p: string) => `https://localhost/_capacitor_file_${p.replace("file://", "")}`, get: async () => (gets++, content), platform: "0.8.0" };
    const listed: ViewManifest = { ...MANIFEST, version: "v1" };
    const first = await stageLocally(deps, listed);
    expect(gets).toBe(1);
    // the mark goes in after the view's last file, naming the platform; the document frame is the app's own, written every time
    expect([...fs.files.keys()].filter((k) => !k.endsWith(DOC_FRAME_FILE)).at(-1)).toBe(`DATA/views/default/v1/${STAGED_MARK}`);
    expect(fs.files.get(`DATA/views/default/v1/${STAGED_MARK}`)).toBe("text:0.8.0");
    // the next launch: the same version from view.list, nothing asked of the node
    expect(await stageLocally(deps, listed)).toEqual(first);
    expect(gets).toBe(1);
    // a list without a version always fetches
    await stageLocally(deps, MANIFEST);
    expect(gets).toBe(2);
    // a node on another platform may transpile the same sources otherwise
    await stageLocally({ ...deps, platform: "0.9.0" }, listed);
    expect(gets).toBe(3);
    expect(fs.files.get(`DATA/views/default/v1/${STAGED_MARK}`)).toBe("text:0.9.0");
    // the app killed mid-write left no mark: written again
    fs.files.delete(`DATA/views/default/v1/${STAGED_MARK}`);
    await stageLocally({ ...deps, platform: "0.9.0" }, listed);
    expect(gets).toBe(4);
  });
});

// --- the remote desktop in the app -----------------------------------------------------------

const APP_ORIGIN = "https://localhost";
const PAIRED: Credential = { token: "t", controller: "controller_1", name: "Pixel", node: { host: "192.168.1.44", port: 4818, spki: "AAAA=" } };

describe("planOpen", () => {
  const onLan = { via: "lan" as const, credential: PAIRED, canForward: true, origin: APP_ORIGIN };
  const cases: [string, unknown, Partial<PlanContext>, OpenPlan][] = [
    ["a path on the LAN: the pinned node", { path: "/remote/?t=abc", transport: "websocket", node: "node_a", stream: "stream_1" }, {}, { kind: "lan", host: "192.168.1.44", port: 4818, pin: "AAAA=", path: "/remote/?t=abc", stream: "stream_1" }],
    ["an older node's URL: only its path", { url: "https://192.168.1.44:4818/remote/?t=abc" }, {}, { kind: "lan", host: "192.168.1.44", port: 4818, pin: "AAAA=", path: "/remote/?t=abc" }],
    ["a URL naming another host still goes to the pinned node", { url: "https://evil.example/remote/?t=abc" }, {}, { kind: "lan", host: "192.168.1.44", port: 4818, pin: "AAAA=", path: "/remote/?t=abc" }],
    ["WebRTC: pipes over the link to the host", { path: "/remote/?t=abc", transport: "webrtc", node: "node_b", stream: "stream_2" }, { via: "relay" }, { kind: "link", node: "node_b", path: "/remote/?t=abc", stream: "stream_2" }],
    ["WebRTC without its node", { path: "/remote/?t=abc", transport: "webrtc" }, {}, { kind: "refuse", reason: "the stream did not say which node it is on" }],
    ["the LAN's transport over the relay", { path: "/remote/?t=abc", transport: "websocket" }, { via: "relay" }, { kind: "refuse", reason: AWAY_MESSAGE }],
    ["no key for the node", { path: "/remote/?t=abc" }, { credential: { ...PAIRED, node: { host: "192.168.1.44", port: 4818 } } }, { kind: "refuse", reason: "this phone does not know the node's key: pair it again" }],
    ["a shell without the plugin", { path: "/remote/?t=abc" }, { canForward: false }, { kind: "refuse", reason: "this app cannot show the remote desktop" }],
    ["a path outside /remote/", { path: "/ws/client" }, {}, { kind: "refuse", reason: "that stream page cannot be opened" }],
    ["a path climbing out", { path: "/remote/../ws/client" }, {}, { kind: "refuse", reason: "that stream page cannot be opened" }],
    ["a path that would break the request line", { path: "/remote/ HTTP/1.1\r\nHost: x" }, {}, { kind: "refuse", reason: "that stream page cannot be opened" }],
    ["a page elsewhere: the browser", { url: "https://github.com/login/device" }, {}, { kind: "window", url: "https://github.com/login/device" }],
    ["an invite: the app it names", { url: "art://192.168.1.44:47989?pin=1234" }, {}, { kind: "app", url: "art://192.168.1.44:47989?pin=1234" }],
    ["this app's own origin serves no stream", { url: "https://localhost/remote/?t=abc" }, {}, { kind: "refuse", reason: "that stream page cannot be opened" }],
  ];
  for (const [name, params, ctx, want] of cases) test(name, () => expect(planOpen(params, { ...onLan, ...ctx })).toEqual(want));

  test("what can never be opened throws, as host.open did", () => {
    expect(() => planOpen({ url: "javascript:alert(1)" }, onLan)).toThrow("that link cannot be opened");
    expect(() => planOpen({}, onLan)).toThrow("host.open needs a url");
  });
});

type OpenOptions = Parameters<CophylaStreamPlugin["open"]>[0];

class FakeStreamPlugin implements CophylaStreamPlugin {
  readonly opened: OpenOptions[] = [];
  readonly closes: string[] = [];
  /** Every pipe call the bridge made, as `[method, options]`. */
  readonly calls: [string, unknown][] = [];
  fail?: string;
  /** What `pipeOpened` answers. */
  stillOpen = true;
  private listeners = new Map<string, Set<(e: never) => void>>();
  async open(options: OpenOptions): Promise<void> {
    this.opened.push(options);
    if (this.fail) throw new Error(this.fail);
  }
  async close(options: { stream: string }): Promise<void> {
    this.closes.push(options.stream);
    this.emit({ stream: options.stream, reason: "closed" });
  }
  async addListener(event: string, fn: (e: never) => void): Promise<{ remove(): Promise<void> }> {
    const set = this.listeners.get(event) ?? new Set();
    this.listeners.set(event, set);
    set.add(fn);
    return { remove: async () => void set.delete(fn) };
  }
  emit(e: StreamClosed): void {
    this.fire("closed", e);
  }
  fire(event: string, e: unknown): void {
    for (const l of [...(this.listeners.get(event) ?? [])]) l(e as never);
  }
  async pipeOpened(options: { conn: string; window: number }): Promise<{ open: boolean }> {
    this.calls.push(["pipeOpened", options]);
    return { open: this.stillOpen };
  }
  async pipeFailed(options: { conn: string }): Promise<void> {
    this.calls.push(["pipeFailed", options]);
  }
  async pipeWrite(options: { conn: string; data: string }): Promise<void> {
    this.calls.push(["pipeWrite", options]);
  }
  async pipeAck(options: { conn: string; bytes: number }): Promise<void> {
    this.calls.push(["pipeAck", options]);
  }
  async pipeClose(options: { conn: string }): Promise<void> {
    this.calls.push(["pipeClose", options]);
  }
}

describe("a stream's lifetime", () => {
  const plan = { kind: "lan" as const, host: "192.168.1.44", port: 4818, pin: "AAAA=", path: "/remote/?t=abc", stream: "stream_1" };

  function harness() {
    const plugin = new FakeStreamPlugin();
    const requests: [string, unknown][] = [];
    const watching: boolean[] = [];
    const streams = new Streams({ plugin, request: async (m, p) => void requests.push([m, p]), watching: (on) => watching.push(on) });
    return { plugin, requests, watching, streams };
  }

  test("shown: the app stands down; closed by the user: it comes back and the node is told, once", async () => {
    const { plugin, requests, watching, streams } = harness();
    await streams.show(plan);
    expect(plugin.opened).toEqual([{ stream: "stream_1", host: "192.168.1.44", port: 4818, pin: "AAAA=", path: "/remote/?t=abc" }]);
    expect(streams.open).toBe(true);
    expect(watching).toEqual([true]);
    plugin.emit({ stream: "other", reason: "closed" });
    expect(streams.open).toBe(true);
    plugin.emit({ stream: "stream_1", reason: "closed" });
    plugin.emit({ stream: "stream_1", reason: "closed" });
    expect(streams.open).toBe(false);
    expect(watching).toEqual([true, false]);
    expect(requests).toEqual([["remote.close", { stream: "stream_1" }]]);
  });

  test("a second stream closes the first; the app going away closes it; an older node's has no id to tell", async () => {
    const { plugin, requests, watching, streams } = harness();
    await streams.show(plan);
    await streams.show({ ...plan, stream: "stream_2" });
    expect(plugin.closes).toEqual(["stream_1"]);
    expect(requests).toEqual([["remote.close", { stream: "stream_1" }]]);
    await streams.close();
    expect(plugin.closes).toEqual(["stream_1", "stream_2"]);
    expect(watching).toEqual([true, false, true, false]);
    const { stream: _gone, ...old } = plan;
    await streams.show(old);
    expect(plugin.opened.at(-1)!.stream).toMatch(/^local_\d+$/);
    await streams.close();
    expect(requests).toHaveLength(2);
  });

  test("a changed key ends it at once in the pairing's words; the app comes back", async () => {
    const { plugin, requests, watching, streams } = harness();
    plugin.fail = PIN_MISMATCH;
    await expect(streams.show(plan)).rejects.toThrow(PIN_MISMATCH_MESSAGE);
    expect(streams.open).toBe(false);
    expect(watching).toEqual([true, false]);
    expect(requests).toEqual([["remote.close", { stream: "stream_1" }]]);
  });
});

describe("a link stream's pipes", () => {
  const plan = { kind: "link" as const, node: "node_b", path: "/remote/?t=abc", stream: "stream_9" };

  function harness(opts: { refuse?: boolean } = {}) {
    const plugin = new FakeStreamPlugin();
    const requests: [string, unknown][] = [];
    const signals: [string, unknown][] = [];
    let hear: ((method: string, params: unknown) => void) | undefined;
    let n = 0;
    const link = {
      open: async (node: string) => {
        requests.push(["remote.pipe.open", { node }]);
        if (opts.refuse) throw new Error("no link toward node_b");
        return { pipe: `p_${++n}`, window: 262_144 };
      },
      signal: (method: string, params: unknown) => void signals.push([method, params]),
      onPipe: (fn: (method: string, params: unknown) => void) => {
        hear = fn;
        return () => undefined;
      },
    };
    const pipes = new PipeBridge({ plugin, link });
    const request = async (method: string, params: unknown) => void requests.push([method, params]);
    const streams = new Streams({ plugin, request, watching: () => undefined, pipes });
    const fromNode = (method: string, params: unknown) => hear!(method, params);
    return { plugin, requests, signals, pipes, streams, fromNode };
  }

  const settle = () => new Promise((r) => setTimeout(r, 0));

  test("a pipe per connection on the node shown; bytes both ways, acked as taken; an end on either side closes the other", async () => {
    const { plugin, requests, signals, pipes, streams, fromNode } = harness();
    await streams.show(plan);
    expect(plugin.opened).toEqual([{ stream: "stream_9", path: "/remote/?t=abc", link: true }]);
    plugin.fire("pipe", { stream: "stream_9", conn: "k1" });
    await settle();
    expect(requests).toEqual([["remote.pipe.open", { node: "node_b" }]]);
    expect(plugin.calls).toEqual([["pipeOpened", { conn: "k1", window: 262_144 }]]);
    // the page's bytes up, the node's down, each side's take acknowledged to the other
    plugin.fire("pipeData", { conn: "k1", data: "R0VU" });
    fromNode("remote.pipe.data", { pipe: "p_1", data: "SFRUUA==" });
    plugin.fire("written", { conn: "k1", bytes: 4 });
    fromNode("remote.pipe.ack", { pipe: "p_1", bytes: 3 });
    fromNode("remote.pipe.data", { pipe: "p_unknown", data: "eA==" });
    await settle();
    expect(signals).toEqual([
      ["remote.pipe.data", { pipe: "p_1", data: "R0VU" }],
      ["remote.pipe.ack", { pipe: "p_1", bytes: 4 }],
    ]);
    expect(plugin.calls.slice(1)).toEqual([
      ["pipeWrite", { conn: "k1", data: "SFRUUA==" }],
      ["pipeAck", { conn: "k1", bytes: 3 }],
    ]);
    // the node closes one, the page the other
    plugin.fire("pipe", { stream: "stream_9", conn: "k2" });
    await settle();
    fromNode("remote.pipe.close", { pipe: "p_2" });
    await settle();
    expect(plugin.calls.at(-1)).toEqual(["pipeClose", { conn: "k2" }]);
    expect(pipes.count).toBe(1);
    plugin.fire("pipeEnd", { conn: "k1", reason: "the page closed it" });
    expect(signals.at(-1)).toEqual(["remote.pipe.close", { pipe: "p_1", reason: "the page closed it" }]);
    expect(pipes.count).toBe(0);
  });

  test("a pipe that cannot open fails its connection; one whose connection went is closed; the stream closing closes the rest", async () => {
    const refused = harness({ refuse: true });
    await refused.streams.show(plan);
    refused.plugin.fire("pipe", { stream: "stream_9", conn: "k1" });
    await settle();
    expect(refused.plugin.calls).toEqual([["pipeFailed", { conn: "k1" }]]);

    const { plugin, requests, signals, pipes, streams } = harness();
    await streams.show(plan);
    plugin.stillOpen = false;
    plugin.fire("pipe", { stream: "stream_9", conn: "k1" });
    await settle();
    await settle();
    expect(signals).toEqual([["remote.pipe.close", { pipe: "p_1", reason: "the page closed it" }]]);
    plugin.stillOpen = true;
    plugin.fire("pipe", { stream: "stream_9", conn: "k2" });
    await settle();
    expect(pipes.count).toBe(1);
    await streams.close();
    expect(signals.at(-1)).toEqual(["remote.pipe.close", { pipe: "p_2", reason: "the stream closed" }]);
    expect(requests.at(-1)).toEqual(["remote.close", { stream: "stream_9" }]);
    expect(pipes.count).toBe(0);
    // a connection after the stream closed gets no pipe
    plugin.fire("pipe", { stream: "stream_9", conn: "k3" });
    await settle();
    expect(plugin.calls.at(-1)).toEqual(["pipeFailed", { conn: "k3" }]);
  });
});
