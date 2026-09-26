// A view's bridge: ids remapped and restored, out-of-scope and unknown methods refused
// without reaching cophylad, the host's own requests answered by the host, notifications
// filtered by scope, pending requests failed on disconnect, and two mounts that never share
// an id.

import { describe, expect, test } from "bun:test";
import type { Client, RpcMessage, RpcNotification, RpcRequest, ViewManifest } from "@cophyla/protocol";
import { Bridge, envelope, isEnvelope, PREFS_MAX } from "../src/bridge.ts";
import { prefsStore } from "../src/viewhost.ts";
import type { HelloResult } from "../src/connection.ts";

const MANIFEST: ViewManifest = { id: "default", name: "Chat", entry: "index.html", default: true, source: "builtin", scopes: ["sessions:read", "sessions:write", "asks:answer", "audit:read"] };
const CLIENT: Client = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7", kind: "ui", scopes: ["sessions:read", "sessions:write", "asks:answer", "audit:read", "views", "nodes", "chat"], via: "direct", audio: { in: false, out: false }, connectedAt: 1 };
const HELLO: HelloResult = { client: CLIENT, node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV", protocolVersion: 1, platformVersion: "0.1.0" };

function make(manifest = MANIFEST, instance = 1, menu = false) {
  const toCophylad: (RpcRequest & { id: string })[] = [];
  const signals: RpcNotification[] = [];
  const toView: RpcMessage[] = [];
  const bridge = new Bridge({ manifest, clientScopes: CLIENT.scopes, instance, ...(menu ? { menu: true } : {}) }, { toCophylad: (f) => ("id" in f ? toCophylad.push(f as RpcRequest & { id: string }) : signals.push(f)), toView: (f) => toView.push(f) });
  return { bridge, toCophylad, signals, toView };
}

const req = (id: string | number, method: string, params?: unknown) => envelope({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });

describe("bridge", () => {
  test("scopes are the manifest's ∩ the client's", () => {
    const { bridge } = make();
    expect(bridge.scopes).toEqual(["sessions:read", "sessions:write", "asks:answer", "audit:read"]);
    const wide = make({ ...MANIFEST, scopes: ["sessions:read", "voice", "metrics:read"] });
    expect(wide.bridge.scopes).toEqual(["sessions:read"]);
    const none = make({ ...MANIFEST, scopes: undefined } as ViewManifest);
    expect(none.bridge.scopes).toEqual([]);
  });

  test("a request is forwarded with a remapped id and its response comes back with the view's id", () => {
    const { bridge, toCophylad, toView } = make();
    bridge.fromView(req("r1", "session.list", {}));
    expect(toCophylad).toHaveLength(1);
    expect(toCophylad[0]!.id).toBe("v1-1");
    expect(toCophylad[0]!.method).toBe("session.list");
    expect(bridge.pendingCount).toBe(1);
    bridge.fromCophylad({ jsonrpc: "2.0", id: "v1-1", result: { sessions: [] } });
    expect(toView).toEqual([{ jsonrpc: "2.0", id: "r1", result: { sessions: [] } }]);
    expect(bridge.pendingCount).toBe(0);
    // A numeric id round-trips too.
    bridge.fromView(req(7, "session.list"));
    bridge.fromCophylad({ jsonrpc: "2.0", id: "v1-2", error: { code: -32004, message: "no", data: { code: "not_found", message: "no", retryable: false } } });
    expect(toView[1]).toMatchObject({ id: 7, error: { data: { code: "not_found" } } });
  });

  test("an out-of-scope method is denied, naming the view and the scope, and nothing is forwarded", () => {
    const { bridge, toCophylad, toView } = make();
    bridge.fromView(req("r1", "chat.send", { text: "hi" }));
    expect(toCophylad).toEqual([]);
    expect(toView).toHaveLength(1);
    const f = toView[0] as { id: unknown; error: { data: { code: string; message: string } } };
    expect(f.id).toBe("r1");
    expect(f.error.data.code).toBe("denied");
    expect(f.error.data.message).toBe("view default lacks scope chat");
    // A view with no scopes may send nothing at all.
    const none = make({ ...MANIFEST, scopes: [] });
    none.bridge.fromView(req("r1", "session.list"));
    expect(none.toCophylad).toEqual([]);
    expect((none.toView[0] as { error: { data: { code: string } } }).error.data.code).toBe("denied");
  });

  test("host.open is the host's own: allowed with the remote scope where the host has the seam, never sent to cophylad", async () => {
    const opened: unknown[] = [];
    const host = async (method: string, params: unknown) => {
      if ((params as { url: string }).url === "javascript:alert(1)") throw new Error("that link cannot be opened");
      opened.push({ method, params });
      return {};
    };
    const client = [...CLIENT.scopes, "remote" as const];
    const toCophylad: unknown[] = [];
    const toView: RpcMessage[] = [];
    const bridge = new Bridge({ manifest: { ...MANIFEST, scopes: [...MANIFEST.scopes!, "remote"] }, clientScopes: client, instance: 1, host }, { toCophylad: (f) => toCophylad.push(f), toView: (f) => toView.push(f) });
    bridge.fromView(req("r1", "host.open", { url: "https://h/remote/?t=abc" }));
    bridge.fromView(req("r2", "host.open", { url: "javascript:alert(1)" }));
    bridge.fromView(req("r3", "host.close", {}));
    await Bun.sleep(0);
    expect(toCophylad).toEqual([]);
    expect(opened).toEqual([{ method: "host.open", params: { url: "https://h/remote/?t=abc" } }]);
    expect(toView.find((f) => (f as { id: unknown }).id === "r1")).toEqual({ jsonrpc: "2.0", id: "r1", result: {} });
    expect(toView.find((f) => (f as { id: unknown }).id === "r2")).toMatchObject({ error: { data: { code: "invalid", message: "that link cannot be opened" } } });
    expect(toView.find((f) => (f as { id: unknown }).id === "r3")).toMatchObject({ error: { data: { code: "unsupported" } } });
    // without the remote scope it is denied; without the seam, unsupported
    const narrow = new Bridge({ manifest: MANIFEST, clientScopes: client, instance: 2, host }, { toCophylad: () => {}, toView: (f) => toView.push(f) });
    narrow.fromView(req("r4", "host.open", { url: "https://h/" }));
    const bare = make({ ...MANIFEST, scopes: [...MANIFEST.scopes!, "remote"] });
    bare.bridge.fromView(req("r5", "host.open", { url: "https://h/" }));
    expect(toView.find((f) => (f as { id: unknown }).id === "r4")).toMatchObject({ error: { data: { code: "denied" } } });
    expect(bare.toView[0]).toMatchObject({ id: "r5", error: { data: { code: "unsupported" } } });
    expect(opened).toHaveLength(1);
  });

  test("host.chooseView shows the host's picker to any view, even one with no scopes, and never reaches cophylad; a host without a picker says unsupported", async () => {
    let shown = 0;
    const toCophylad: unknown[] = [];
    const toView: RpcMessage[] = [];
    const bridge = new Bridge({ manifest: { ...MANIFEST, scopes: [] }, clientScopes: CLIENT.scopes, instance: 1, chooseView: () => shown++ }, { toCophylad: (f) => toCophylad.push(f), toView: (f) => toView.push(f) });
    bridge.fromView(req("r1", "host.chooseView", {}));
    bridge.fromView(req("r2", "host.chooseView"));
    await Bun.sleep(0);
    expect(shown).toBe(2);
    expect(toCophylad).toEqual([]);
    expect(toView).toEqual([
      { jsonrpc: "2.0", id: "r1", result: {} },
      { jsonrpc: "2.0", id: "r2", result: {} },
    ]);
    // the picker is not host.open's seam: a host with one and not the other answers each apart
    const opened: string[] = [];
    const openOnly = new Bridge({ manifest: { ...MANIFEST, scopes: [...MANIFEST.scopes!, "remote"] }, clientScopes: [...CLIENT.scopes, "remote"], instance: 2, host: async (m) => opened.push(m) }, { toCophylad: () => {}, toView: (f) => toView.push(f) });
    openOnly.fromView(req("r3", "host.chooseView", {}));
    const bare = make();
    bare.bridge.fromView(req("r4", "host.chooseView", {}));
    await Bun.sleep(0);
    expect(opened).toEqual([]);
    expect(toView.find((f) => (f as { id: unknown }).id === "r3")).toMatchObject({ error: { data: { code: "unsupported" } } });
    expect(bare.toView[0]).toMatchObject({ id: "r4", error: { data: { code: "unsupported" } } });
  });

  test("host.settings shows the host's settings to any view and never reaches cophylad; a host without them says unsupported", async () => {
    let settings = 0;
    let picker = 0;
    const toCophylad: unknown[] = [];
    const toView: RpcMessage[] = [];
    const bridge = new Bridge(
      { manifest: { ...MANIFEST, scopes: [] }, clientScopes: CLIENT.scopes, instance: 1, openSettings: () => settings++, chooseView: () => picker++ },
      { toCophylad: (f) => toCophylad.push(f), toView: (f) => toView.push(f) },
    );
    bridge.fromView(req("r1", "host.settings", {}));
    await Bun.sleep(0);
    expect([settings, picker]).toEqual([1, 0]);
    expect(toCophylad).toEqual([]);
    expect(toView).toEqual([{ jsonrpc: "2.0", id: "r1", result: {} }]);
    // A host with a picker and no settings answers the settings apart.
    const pickerOnly = new Bridge({ manifest: MANIFEST, clientScopes: CLIENT.scopes, instance: 2, chooseView: () => picker++ }, { toCophylad: () => {}, toView: (f) => toView.push(f) });
    pickerOnly.fromView(req("r2", "host.settings", {}));
    await Bun.sleep(0);
    expect(picker).toBe(0);
    expect(toView.find((f) => (f as { id: unknown }).id === "r2")).toMatchObject({ error: { data: { code: "unsupported" } } });
  });

  test("host.openLink opens a web page for any view where the host has the seam, never reaches cophylad, and refuses anything but http and https", async () => {
    const opened: string[] = [];
    const toCophylad: unknown[] = [];
    const toView: RpcMessage[] = [];
    const answer = (id: string) => toView.find((f) => (f as { id: unknown }).id === id);
    const bridge = new Bridge(
      { manifest: { ...MANIFEST, scopes: [] }, clientScopes: CLIENT.scopes, instance: 1, openLink: async (url) => void opened.push(url) },
      { toCophylad: (f) => toCophylad.push(f), toView: (f) => toView.push(f) },
    );
    bridge.fromView(req("r1", "host.openLink", { url: "https://example.com/a b?x=1&y=2" }));
    bridge.fromView(req("r2", "host.openLink", { url: "javascript:alert(1)" }));
    bridge.fromView(req("r3", "host.openLink", { url: "file:///C:/Windows/notepad.exe" }));
    bridge.fromView(req("r4", "host.openLink", { url: "https://user:pw@example.com/" }));
    bridge.fromView(req("r5", "host.openLink", {}));
    await Bun.sleep(0);
    expect(opened).toEqual(["https://example.com/a%20b?x=1&y=2"]);
    expect(toCophylad).toEqual([]);
    expect(answer("r1")).toEqual({ jsonrpc: "2.0", id: "r1", result: {} });
    for (const id of ["r2", "r3", "r4", "r5"]) expect(answer(id)).toMatchObject({ error: { data: { code: "invalid" } } });
    // not host.open's seam: a host without it says unsupported, whatever else it has
    const openOnly = new Bridge({ manifest: MANIFEST, clientScopes: [...CLIENT.scopes, "remote"], instance: 2, host: async (m) => opened.push(m) }, { toCophylad: () => {}, toView: (f) => toView.push(f) });
    openOnly.fromView(req("r6", "host.openLink", { url: "https://example.com/" }));
    await Bun.sleep(0);
    expect(opened).toHaveLength(1);
    expect(answer("r6")).toMatchObject({ error: { data: { code: "unsupported" } } });
  });

  test("host.savePrefs keeps a view's own record for any view, host.ready hands it back, and anything but a small object is refused", async () => {
    const store = new Map<string, string>();
    const toCophylad: unknown[] = [];
    const toView: RpcMessage[] = [];
    const answer = (id: string) => toView.find((f) => (f as { id: unknown }).id === id);
    const bridge = new Bridge(
      { manifest: { ...MANIFEST, scopes: [] }, clientScopes: CLIENT.scopes, instance: 1, prefs: prefsStore({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) }, MANIFEST.id) },
      { toCophylad: (f) => toCophylad.push(f), toView: (f) => toView.push(f) },
    );
    bridge.ready(HELLO);
    expect((toView[0] as RpcNotification).params).not.toHaveProperty("prefs");
    bridge.fromView(req("r1", "host.savePrefs", { prefs: { railSplit: 40 } }));
    bridge.fromView(req("r2", "host.savePrefs", { prefs: [1] }));
    bridge.fromView(req("r3", "host.savePrefs", { prefs: { big: "x".repeat(PREFS_MAX) } }));
    bridge.fromView(req("r4", "host.savePrefs", {}));
    await Bun.sleep(0);
    expect(toCophylad).toEqual([]);
    expect(answer("r1")).toEqual({ jsonrpc: "2.0", id: "r1", result: {} });
    for (const id of ["r2", "r3", "r4"]) expect(answer(id)).toMatchObject({ error: { data: { code: "invalid" } } });
    expect([...store.keys()]).toEqual(["cophyla.view-prefs.default"]);
    toView.length = 0;
    bridge.ready(HELLO);
    expect((toView[0] as RpcNotification).params).toMatchObject({ prefs: { railSplit: 40 } });
    // a host that keeps none says so
    const { bridge: bare, toView: bareOut } = make();
    bare.fromView(req("r5", "host.savePrefs", { prefs: {} }));
    await Bun.sleep(0);
    expect(bareOut[0]).toMatchObject({ error: { data: { code: "unsupported" } } });
  });

  test("hello, the other scope-less requests and unknown methods are unsupported; malformed frames get invalid or nothing", () => {
    const { bridge, toCophylad, toView } = make();
    bridge.fromView(req("r1", "hello", { token: "x" }));
    bridge.fromView(req("r2", "nope.method"));
    bridge.fromView(req("r6", "pair.claim", { code: "123456", name: "x" }));
    bridge.fromView(req("r7", "relay.info", {}));
    bridge.fromView(envelope({ jsonrpc: "2.0", id: "r3" } as unknown as RpcMessage));
    bridge.fromView({ cophyla: "cophyla.view/1", frame: { id: "r4", method: "session.list" } });
    bridge.fromView({ cophyla: "other/1", frame: { jsonrpc: "2.0", id: "r5", method: "session.list" } });
    bridge.fromView("not an object");
    bridge.fromView(envelope({ jsonrpc: "2.0", method: "chat.typing", params: { active: true } }));
    expect(toCophylad).toEqual([]);
    const codes = toView.map((f) => [(f as { id: unknown }).id, (f as { error: { data: { code: string } } }).error.data.code]);
    expect(codes).toEqual([
      ["r1", "unsupported"],
      ["r2", "unsupported"],
      ["r6", "unsupported"],
      ["r7", "unsupported"],
      ["r3", "invalid"],
      ["r4", "invalid"],
    ]);
  });

  test("a signal is forwarded unchanged within the view's scopes and dropped outside them", () => {
    const chat = make({ ...MANIFEST, scopes: [...MANIFEST.scopes!, "chat"] });
    chat.bridge.fromView(envelope({ jsonrpc: "2.0", method: "chat.typing", params: { active: true } }));
    expect(chat.signals).toEqual([{ jsonrpc: "2.0", method: "chat.typing", params: { active: true } }]);
    expect(chat.toCophylad).toEqual([]);
    expect(chat.toView).toEqual([]);
    expect(chat.bridge.pendingCount).toBe(0);
    // Without the scope, or for a signal that is not one, nothing goes anywhere.
    const { bridge, signals, toCophylad, toView } = make();
    bridge.fromView(envelope({ jsonrpc: "2.0", method: "chat.typing", params: { active: true } }));
    chat.bridge.fromView(envelope({ jsonrpc: "2.0", method: "session.state", params: {} }));
    chat.bridge.fromView(envelope({ jsonrpc: "2.0", method: "voice.audio", params: {} }));
    expect(signals).toEqual([]);
    expect(toCophylad).toEqual([]);
    expect(toView).toEqual([]);
    expect(chat.signals).toHaveLength(1);
  });

  test("a data channel's signalling and a stream's pipes are the host's alone, whatever the view's scopes", () => {
    const all = make({ ...MANIFEST, scopes: CLIENT.scopes.concat(["account", "remote"]) } as ViewManifest);
    for (const method of ["direct.candidate", "remote.pipe.data", "remote.pipe.ack", "remote.pipe.close"]) {
      all.bridge.fromView(envelope({ jsonrpc: "2.0", method, params: { peer: "p", pipe: "p", candidate: null, data: "", bytes: 1 } }));
      all.bridge.fromCophylad({ jsonrpc: "2.0", method, params: { peer: "p", pipe: "p", candidate: null, data: "", bytes: 1 } });
    }
    for (const method of ["direct.offer", "direct.info", "remote.pipe.open"]) all.bridge.fromView(req(method, method, {}));
    expect(all.signals).toEqual([]);
    expect(all.toCophylad).toEqual([]);
    expect(all.toView.map((f) => (f as { error?: { data: { code: string } } }).error?.data.code)).toEqual(["unsupported", "unsupported", "unsupported"]);
  });

  test("direct.state reaches a view with the account scope, and the switch is a request within it", () => {
    const toCophylad: (RpcRequest & { id: string })[] = [];
    const toView: RpcMessage[] = [];
    const wide = new Bridge({ manifest: { ...MANIFEST, scopes: ["account"] }, clientScopes: [...CLIENT.scopes, "account"], instance: 3 }, { toCophylad: (f) => toCophylad.push(f as RpcRequest & { id: string }), toView: (f) => toView.push(f) });
    wide.fromCophylad({ jsonrpc: "2.0", method: "direct.state", params: { node: "node_1", state: "ready", peers: [] } });
    wide.fromView(req("r1", "direct.enable", {}));
    expect(toView.map((f) => (f as { method?: string }).method)).toEqual(["direct.state"]);
    expect(toCophylad.map((f) => f.method)).toEqual(["direct.enable"]);
  });

  test("notifications reach the view within its scopes only; foreign responses are ignored", () => {
    const { bridge, toView } = make({ ...MANIFEST, scopes: ["sessions:read"] });
    bridge.fromCophylad({ jsonrpc: "2.0", method: "session.state", params: { id: "sess_1" } });
    bridge.fromCophylad({ jsonrpc: "2.0", method: "ask.state", params: { id: "ask_1" } });
    bridge.fromCophylad({ jsonrpc: "2.0", method: "audit.entry", params: { id: "aud_1" } });
    bridge.fromCophylad({ jsonrpc: "2.0", method: "session.event", params: { session: "sess_1", seq: 1 } });
    bridge.fromCophylad({ jsonrpc: "2.0", method: "made.up", params: {} });
    bridge.fromCophylad({ jsonrpc: "2.0", id: "h3", result: {} });
    bridge.fromCophylad({ jsonrpc: "2.0", id: "v2-1", result: {} });
    expect(toView.map((f) => (f as { method: string }).method)).toEqual(["session.state", "session.event"]);
  });

  test("ready tells the view who it is and that the line is open; disconnected fails pending with unavailable", () => {
    const { bridge, toView } = make();
    bridge.ready(HELLO);
    expect(toView[0]).toMatchObject({ method: "host.ready", params: { client: CLIENT, node: HELLO.node, protocolVersion: 1, platformVersion: "0.1.0", view: MANIFEST, scopes: bridge.scopes } });
    expect(toView[1]).toEqual({ jsonrpc: "2.0", method: "host.state", params: { connected: true } });
    bridge.fromView(req("r9", "session.history", { id: "sess_1" }));
    bridge.disconnected();
    const failed = toView[2] as { id: unknown; error: { data: { code: string; message: string } } };
    expect(failed.id).toBe("r9");
    expect(failed.error.data.code).toBe("unavailable");
    expect(failed.error.data.message).toContain("session.history");
    expect(toView[3]).toEqual({ jsonrpc: "2.0", method: "host.state", params: { connected: false } });
    expect(bridge.pendingCount).toBe(0);
    // A late response for the failed request is dropped.
    bridge.fromCophylad({ jsonrpc: "2.0", id: "v1-1", result: {} });
    expect(toView).toHaveLength(4);
  });

  test("a host with a menu button says so in host.ready and passes each press on; one without says neither", () => {
    const withMenu = make(MANIFEST, 1, true);
    withMenu.bridge.ready(HELLO);
    expect(withMenu.toView[0]).toMatchObject({ method: "host.ready", params: { menu: true } });
    withMenu.bridge.menu();
    expect(withMenu.toView[2]).toEqual({ jsonrpc: "2.0", method: "host.menu", params: {} });
    const without = make();
    without.bridge.ready(HELLO);
    expect((without.toView[0] as { params: object }).params).not.toHaveProperty("menu");
    without.bridge.menu();
    expect(without.toView).toHaveLength(2);
  });

  test("a host with a microphone and no talk button says talk in host.ready", () => {
    const toView: RpcMessage[] = [];
    const bridge = new Bridge({ manifest: MANIFEST, clientScopes: CLIENT.scopes, instance: 1, talk: true }, { toCophylad: () => {}, toView: (f) => toView.push(f) });
    bridge.ready(HELLO);
    expect(toView[0]).toMatchObject({ method: "host.ready", params: { talk: true } });
    const without = make();
    without.bridge.ready(HELLO);
    expect((without.toView[0] as { params: object }).params).not.toHaveProperty("talk");
  });

  test("two instances never share a wire id", () => {
    const a = make(MANIFEST, 1);
    const b = make(MANIFEST, 2);
    a.bridge.fromView(req("r1", "session.list"));
    b.bridge.fromView(req("r1", "session.list"));
    expect(a.toCophylad[0]!.id).toBe("v1-1");
    expect(b.toCophylad[0]!.id).toBe("v2-1");
    // Each answers only its own.
    a.bridge.fromCophylad({ jsonrpc: "2.0", id: "v2-1", result: {} });
    expect(a.toView).toEqual([]);
    b.bridge.fromCophylad({ jsonrpc: "2.0", id: "v2-1", result: {} });
    expect(b.toView).toHaveLength(1);
  });

  test("envelope helpers", () => {
    const e = envelope({ jsonrpc: "2.0", method: "x" });
    expect(isEnvelope(e)).toBe(true);
    expect(isEnvelope({ cophyla: "cophyla.view/1" })).toBe(false);
    expect(isEnvelope(null)).toBe(false);
  });
});
