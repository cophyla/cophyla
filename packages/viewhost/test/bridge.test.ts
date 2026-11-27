// A view's bridge: ids remapped and restored, out-of-scope and unknown methods refused
// without reaching cophylad, the host's own requests answered by the host, notifications
// filtered by scope, pending requests failed on disconnect, two mounts that never share
// an id, and the view's talk button taken by the host's voice.

import { describe, expect, test } from "bun:test";
import { RpcError } from "@cophyla/protocol";
import type { Client, RpcMessage, RpcNotification, RpcRequest, ViewManifest } from "@cophyla/protocol";
import { Bridge, envelope, HELD_MAX, isEnvelope, PREFS_MAX } from "../src/bridge.ts";
import type { HostPtt } from "../src/bridge.ts";
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
    bridge.fromView(req("r3", "host.frobnicate", {}));
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

  test("host.settings passes on the page a view names, and nothing for one that is not text", async () => {
    const pages: (string | undefined)[] = [];
    const toView: RpcMessage[] = [];
    const bridge = new Bridge({ manifest: MANIFEST, clientScopes: CLIENT.scopes, instance: 3, openSettings: (page) => pages.push(page) }, { toCophylad: () => {}, toView: (f) => toView.push(f) });
    bridge.fromView(req("p1", "host.settings", { page: "usage" }));
    bridge.fromView(req("p2", "host.settings", { page: 7 }));
    bridge.fromView(req("p3", "host.settings", {}));
    await Bun.sleep(0);
    expect(pages).toEqual(["usage", undefined, undefined]);
    expect(toView.map((f) => (f as { result?: unknown }).result)).toEqual([{}, {}, {}]);
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

  test("host.filePaths says where files dropped on a view are, by their names or with none, for any view where the host has the seam, and never reaches cophylad", async () => {
    const asked: (string[] | undefined)[] = [];
    const toCophylad: unknown[] = [];
    const toView: RpcMessage[] = [];
    const answer = (id: string) => toView.find((f) => (f as { id: unknown }).id === id);
    const bridge = new Bridge(
      {
        manifest: { ...MANIFEST, scopes: [] },
        clientScopes: CLIENT.scopes,
        instance: 1,
        filePaths: async (names) => {
          asked.push(names);
          // with no names, the whole drop (the Linux shell's answer)
          if (!names) return ["/home/u/drop me/a.txt", "/home/u/drop me/sub folder"];
          if (names.includes("gone.txt")) throw new Error("unavailable: no files were dropped just now");
          return names.map((n) => `/home/u/drop me/${n}`);
        },
      },
      { toCophylad: (f) => toCophylad.push(f), toView: (f) => toView.push(f) },
    );
    bridge.ready(HELLO);
    expect((toView[0] as RpcNotification).params).toMatchObject({ filePaths: true });
    bridge.fromView(req("r1", "host.filePaths", { names: ["a.txt", "b c.txt", "café"] }));
    bridge.fromView(req("r2", "host.filePaths", { names: ["gone.txt"] }));
    for (const [id, names] of [["r3", []], ["r4", ["../a"]], ["r5", ["a\0b"]], ["r6", [""]], ["r7", [7]], ["r8", "a.txt"], ["r9", ["x".repeat(1025)]], ["r10", Array(4097).fill("a")]] as const) {
      bridge.fromView(req(id, "host.filePaths", { names }));
    }
    bridge.fromView(req("r11", "host.filePaths", { names: null }));
    bridge.fromView(req("r13", "host.filePaths", {}));
    bridge.fromView(req("r14", "host.filePaths"));
    await Bun.sleep(0);
    expect(answer("r1")).toEqual({ jsonrpc: "2.0", id: "r1", result: { paths: ["/home/u/drop me/a.txt", "/home/u/drop me/b c.txt", "/home/u/drop me/café"] } });
    expect(answer("r2")).toMatchObject({ error: { data: { code: "invalid", message: expect.stringContaining("no files were dropped") } } });
    for (const id of ["r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10", "r11"]) expect(answer(id)).toMatchObject({ error: { data: { code: "invalid" } } });
    for (const id of ["r13", "r14"]) expect(answer(id)).toMatchObject({ result: { paths: ["/home/u/drop me/a.txt", "/home/u/drop me/sub folder"] } });
    // only well-formed names, or none, reach the shell
    expect(asked).toEqual([["a.txt", "b c.txt", "café"], ["gone.txt"], undefined, undefined]);
    expect(toCophylad).toEqual([]);
    // a host without the seam says nothing of it and answers unsupported
    const { bridge: bare, toView: bareOut } = make();
    bare.ready(HELLO);
    expect((bareOut[0] as RpcNotification).params).not.toHaveProperty("filePaths");
    bare.fromView(req("r12", "host.filePaths", { names: ["a.txt"] }));
    expect(bareOut.at(-1)).toMatchObject({ id: "r12", error: { data: { code: "unsupported" } } });
  });

  test("a host that lays stream pages over the view says embed in host.ready; host.place and host.close are its, for the remote scope; host.streamClosed reaches that scope alone", async () => {
    const calls: { method: string; params: unknown }[] = [];
    const host = async (method: string, params: unknown) => {
      calls.push({ method, params });
      return method === "host.open" ? { embedded: true } : {};
    };
    const scopes = [...MANIFEST.scopes!, "remote" as const];
    const toCophylad: unknown[] = [];
    const toView: RpcMessage[] = [];
    const bridge = new Bridge({ manifest: { ...MANIFEST, scopes }, clientScopes: [...CLIENT.scopes, "remote"], instance: 1, host, embed: true }, { toCophylad: (f) => toCophylad.push(f), toView: (f) => toView.push(f) });
    bridge.ready(HELLO);
    expect((toView[0] as RpcNotification).params).toMatchObject({ embed: true });
    bridge.fromView(req("p1", "host.open", { url: "http://127.0.0.1:5000/remote/?t=abc", stream: "stream_1", embed: true }));
    bridge.fromView(req("p2", "host.place", { stream: "stream_1", rect: { x: 10, y: 20, width: 300, height: 200 } }));
    bridge.fromView(req("p3", "host.place", { stream: "stream_1", rect: null }));
    bridge.fromView(req("p4", "host.close", { stream: "stream_1" }));
    await Bun.sleep(0);
    expect(toCophylad).toEqual([]);
    expect(calls.map((c) => c.method)).toEqual(["host.open", "host.place", "host.place", "host.close"]);
    expect(toView.find((f) => (f as { id: unknown }).id === "p1")).toEqual({ jsonrpc: "2.0", id: "p1", result: { embedded: true } });
    bridge.streamClosed("stream_1");
    expect(toView.at(-1)).toEqual({ jsonrpc: "2.0", method: "host.streamClosed", params: { stream: "stream_1" } });

    // without the remote scope: denied, and told nothing
    const narrowOut: RpcMessage[] = [];
    const narrow = new Bridge({ manifest: MANIFEST, clientScopes: [...CLIENT.scopes, "remote"], instance: 2, host, embed: true }, { toCophylad: () => {}, toView: (f) => narrowOut.push(f) });
    narrow.fromView(req("n1", "host.place", { stream: "stream_1", rect: null }));
    narrow.fromView(req("n2", "host.close", { stream: "stream_1" }));
    narrow.streamClosed("stream_1");
    expect(narrowOut.map((f) => (f as { error?: { data: { code: string } } }).error?.data.code)).toEqual(["denied", "denied"]);
    expect(calls).toHaveLength(4);
    // a host that lays nothing over the view says no embed
    const { bridge: bare, toView: bareOut } = make();
    bare.ready(HELLO);
    expect((bareOut[0] as RpcNotification).params).not.toHaveProperty("embed");
  });

  test("a host that streams media says media in host.ready; host.media opens a stream only with a read the view's scopes take", async () => {
    const calls: unknown[] = [];
    const host = async (_method: string, params: unknown) => {
      calls.push(params);
      return { id: "m1", url: "http://doc.localhost/media/m1/a.mp3" };
    };
    const toView: RpcMessage[] = [];
    const answer = (id: string) => toView.find((f) => (f as { id: unknown }).id === id);
    const open = (method: string) => ({ op: "open", read: { method, params: { id: "ses_1", path: "a.mp3" } }, size: 10, modified: 1, mime: "audio/mpeg", name: "a.mp3" });
    const bridge = new Bridge({ manifest: MANIFEST, clientScopes: CLIENT.scopes, instance: 1, host, media: true }, { toCophylad: () => {}, toView: (f) => toView.push(f) });
    bridge.ready(HELLO);
    expect((toView[0] as RpcNotification).params).toMatchObject({ media: true });
    bridge.fromView(req("m1", "host.media", open("session.file")));
    // the view holds no terminal scope, so a terminal's file is not its to stream
    bridge.fromView(req("m2", "host.media", open("terminal.file")));
    bridge.fromView(req("m3", "host.media", open("chat.send")));
    bridge.fromView(req("m4", "host.media", { op: "close", id: "m1" }));
    await Bun.sleep(0);
    expect(answer("m1")).toEqual({ jsonrpc: "2.0", id: "m1", result: { id: "m1", url: "http://doc.localhost/media/m1/a.mp3" } });
    expect(answer("m2")).toMatchObject({ error: { data: { code: "denied" } } });
    expect(answer("m3")).toMatchObject({ error: { data: { code: "denied" } } });
    expect(calls).toEqual([open("session.file"), { op: "close", id: "m1" }]);
    // no media from the host: unsupported, and none said
    const plain: RpcMessage[] = [];
    const none = new Bridge({ manifest: MANIFEST, clientScopes: CLIENT.scopes, instance: 2, host }, { toCophylad: () => {}, toView: (f) => plain.push(f) });
    none.ready(HELLO);
    expect((plain[0] as RpcNotification).params).not.toHaveProperty("media");
    none.fromView(req("p1", "host.media", open("session.file")));
    await Bun.sleep(0);
    expect(plain.find((f) => (f as { id: unknown }).id === "p1")).toMatchObject({ error: { data: { code: "unsupported" } } });
  });

  test("a host that opens web tabs says webTabs in host.ready; host.webtab is its, for the sessions:write scope, and nowhere else", async () => {
    const calls: { method: string; params: unknown }[] = [];
    const host = async (method: string, params: unknown) => {
      calls.push({ method, params });
      if ((params as { op?: unknown }).op === "frobnicate") throw new Error("host.webtab needs an op");
      return {};
    };
    const toCophylad: unknown[] = [];
    const toView: RpcMessage[] = [];
    const answer = (out: RpcMessage[], id: string) => out.find((f) => (f as { id: unknown }).id === id);
    const tab = "wtb_01ARZ3NDEKTSV4RRFFQ69G5FB1";
    const bridge = new Bridge({ manifest: MANIFEST, clientScopes: CLIENT.scopes, instance: 1, host, webTabs: true }, { toCophylad: (f) => toCophylad.push(f), toView: (f) => toView.push(f) });
    bridge.ready(HELLO);
    expect((toView[0] as RpcNotification).params).toMatchObject({ webTabs: true });
    bridge.fromView(req("w1", "host.webtab", { op: "place", tab, rect: { x: 10, y: 20, width: 300, height: 200 } }));
    bridge.fromView(req("w2", "host.webtab", { op: "go", tab, url: "https://example.com/" }));
    bridge.fromView(req("w3", "host.webtab", { op: "frobnicate", tab }));
    await Bun.sleep(0);
    expect(toCophylad).toEqual([]);
    expect(calls.map((c) => c.method)).toEqual(["host.webtab", "host.webtab", "host.webtab"]);
    expect(calls[0]!.params).toEqual({ op: "place", tab, rect: { x: 10, y: 20, width: 300, height: 200 } });
    expect(answer(toView, "w1")).toEqual({ jsonrpc: "2.0", id: "w1", result: {} });
    expect(answer(toView, "w3")).toMatchObject({ error: { data: { code: "invalid", message: "host.webtab needs an op" } } });

    // a view that may not change sessions: denied, the host not asked
    const readOnly: RpcMessage[] = [];
    const narrow = new Bridge({ manifest: { ...MANIFEST, scopes: ["sessions:read"] }, clientScopes: CLIENT.scopes, instance: 2, host, webTabs: true }, { toCophylad: () => {}, toView: (f) => readOnly.push(f) });
    narrow.fromView(req("n1", "host.webtab", { op: "reload", tab }));
    expect(answer(readOnly, "n1")).toMatchObject({ error: { data: { code: "denied", message: "view default lacks scope sessions:write" } } });
    // a host with requests of its own but no web tabs (the desktop app elsewhere, the controller): unsupported, and no webTabs in host.ready
    const elsewhere: RpcMessage[] = [];
    const noTabs = new Bridge({ manifest: MANIFEST, clientScopes: CLIENT.scopes, instance: 3, host, embed: true }, { toCophylad: () => {}, toView: (f) => elsewhere.push(f) });
    noTabs.ready(HELLO);
    expect((elsewhere[0] as RpcNotification).params).not.toHaveProperty("webTabs");
    noTabs.fromView(req("e1", "host.webtab", { op: "reload", tab }));
    expect(answer(elsewhere, "e1")).toMatchObject({ error: { data: { code: "unsupported" } } });
    // webTabs with no requests to answer them says none either
    const bare: RpcMessage[] = [];
    const noHost = new Bridge({ manifest: MANIFEST, clientScopes: CLIENT.scopes, instance: 4, webTabs: true }, { toCophylad: () => {}, toView: (f) => bare.push(f) });
    noHost.ready(HELLO);
    expect((bare[0] as RpcNotification).params).not.toHaveProperty("webTabs");
    noHost.fromView(req("b1", "host.webtab", { op: "reload", tab }));
    expect(answer(bare, "b1")).toMatchObject({ error: { data: { code: "unsupported" } } });
    expect(calls).toHaveLength(3);
  });

  test("host.ready names where the host serves the document frame, when it serves one", () => {
    const toView: RpcMessage[] = [];
    const bridge = new Bridge({ manifest: MANIFEST, clientScopes: CLIENT.scopes, instance: 1, docFrame: "http://doc.localhost/doc/frame.html" }, { toCophylad: () => {}, toView: (f) => toView.push(f) });
    bridge.ready(HELLO);
    expect((toView[0] as RpcNotification).params).toMatchObject({ docFrame: "http://doc.localhost/doc/frame.html" });
    const { bridge: bare, toView: bareOut } = make();
    bare.ready(HELLO);
    expect((bareOut[0] as RpcNotification).params).not.toHaveProperty("docFrame");
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

  test("a machine's ports are the remote scope's: listed, opened and closed by a view that holds it, and what it opened told it; refused to one that does not", () => {
    const toCophylad: (RpcRequest & { id: string })[] = [];
    const toView: RpcMessage[] = [];
    const remote = new Bridge({ manifest: { ...MANIFEST, scopes: ["remote"] }, clientScopes: [...CLIENT.scopes, "remote"], instance: 4 }, { toCophylad: (f) => toCophylad.push(f as RpcRequest & { id: string }), toView: (f) => toView.push(f) });
    remote.fromView(req("r1", "ports.list", { node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAW" }));
    remote.fromView(req("r2", "port.open", { node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAW", port: 3000 }));
    remote.fromView(req("r3", "port.close", { id: "prt_01ARZ3NDEKTSV4RRFFQ69G5FP1" }));
    remote.fromCophylad({ jsonrpc: "2.0", method: "port.state", params: { forwards: [] } });
    expect(toCophylad.map((f) => f.method)).toEqual(["ports.list", "port.open", "port.close"]);
    expect(toView.map((f) => (f as { method?: string }).method)).toEqual(["port.state"]);
    const none = make();
    for (const method of ["ports.list", "port.open", "port.close"]) none.bridge.fromView(req(method, method, {}));
    none.bridge.fromCophylad({ jsonrpc: "2.0", method: "port.state", params: { forwards: [] } });
    expect(none.toCophylad).toEqual([]);
    expect(none.toView.map((f) => (f as { error?: { data: { message: string } } }).error?.data.message)).toEqual(["view default lacks scope remote", "view default lacks scope remote", "view default lacks scope remote"]);
  });

  test("notifications reach the view within its scopes only; foreign responses are ignored", () => {
    const { bridge, toView } = make({ ...MANIFEST, scopes: ["sessions:read"] });
    bridge.fromCophylad({ jsonrpc: "2.0", method: "session.state", params: { id: "sess_1" } });
    bridge.fromCophylad({ jsonrpc: "2.0", method: "ask.state", params: { id: "ask_1" } });
    bridge.fromCophylad({ jsonrpc: "2.0", method: "audit.entry", params: { id: "aud_1" } });
    bridge.fromCophylad({ jsonrpc: "2.0", method: "session.event", params: { session: "sess_1", seq: 1 } });
    // The words heard of an utterance are the voice scope's, as its state is.
    bridge.fromCophylad({ jsonrpc: "2.0", method: "voice.partial", params: { text: "what is" } });
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

  test("held while the host is away: what the view sends waits, in order, and goes once the same client is back", () => {
    const { bridge, toCophylad, signals, toView } = make({ ...MANIFEST, scopes: [...(MANIFEST.scopes ?? []), "chat"] });
    bridge.ready(HELLO);
    toView.length = 0;
    bridge.hold();
    bridge.fromView(req("r1", "session.list", {}));
    bridge.fromView(envelope({ jsonrpc: "2.0", method: "chat.typing", params: {} }));
    bridge.fromView(req("r2", "session.history", { id: "sess_1" }));
    expect(toCophylad).toEqual([]);
    expect(signals).toEqual([]);
    expect(toView).toEqual([]);
    bridge.resume();
    expect(toCophylad.map((f) => f.id)).toEqual(["v1-1", "v1-2"]);
    expect(signals.map((f) => f.method)).toEqual(["chat.typing"]);
    bridge.fromCophylad({ jsonrpc: "2.0", id: "v1-1", result: { sessions: [] } });
    expect(toView).toEqual([{ jsonrpc: "2.0", id: "r1", result: { sessions: [] } }]);
    // the view heard nothing of the pause
    expect(toView.some((f) => (f as { method?: string }).method === "host.state")).toBe(false);
  });

  test("held, then the link comes back as a new client: what waited fails with the gap, and nothing of it is sent", () => {
    const { bridge, toCophylad, toView } = make();
    bridge.ready(HELLO);
    toView.length = 0;
    bridge.hold();
    bridge.fromView(req("r1", "session.list", {}));
    bridge.disconnected();
    expect(toView[0]).toMatchObject({ id: "r1", error: { data: { code: "unavailable" } } });
    expect(toView[1]).toEqual({ jsonrpc: "2.0", method: "host.state", params: { connected: false } });
    bridge.ready(HELLO);
    expect(toCophylad).toEqual([]);
  });

  test("held past what is kept, the oldest request is given up", () => {
    const { bridge, toCophylad, toView } = make();
    bridge.ready(HELLO);
    toView.length = 0;
    bridge.hold();
    for (let i = 0; i <= HELD_MAX; i++) bridge.fromView(req(`r${i}`, "session.list", {}));
    expect(toView).toEqual([expect.objectContaining({ id: "r0", error: expect.objectContaining({ data: expect.objectContaining({ code: "unavailable" }) }) })]);
    bridge.resume();
    expect(toCophylad).toHaveLength(HELD_MAX);
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

  test("a toast's point in a session goes to a view that reads sessions, and to none other", () => {
    const reads = make();
    reads.bridge.ready(HELLO);
    reads.bridge.reveal({ session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1", seq: 212, note: "nte_01ARZ3NDEKTSV4RRFFQ69G5NT1" });
    expect(reads.toView.at(-1)).toEqual({ jsonrpc: "2.0", method: "host.reveal", params: { session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1", seq: 212, note: "nte_01ARZ3NDEKTSV4RRFFQ69G5NT1" } });
    const blind = make({ ...MANIFEST, scopes: ["chat"] });
    blind.bridge.ready(HELLO);
    const before = blind.toView.length;
    blind.bridge.reveal({ session: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1", seq: 212 });
    expect(blind.toView).toHaveLength(before);
  });

  test("a wide window with a pointer on a computer says desk in host.ready; any other host leaves it out", () => {
    const toView: RpcMessage[] = [];
    const bridge = new Bridge({ manifest: MANIFEST, clientScopes: CLIENT.scopes, instance: 1, desk: true }, { toCophylad: () => {}, toView: (f) => toView.push(f) });
    bridge.ready(HELLO);
    expect(toView[0]).toMatchObject({ method: "host.ready", params: { desk: true } });
    const without = make();
    without.bridge.ready(HELLO);
    expect((without.toView[0] as { params: object }).params).not.toHaveProperty("desk");
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

  test("a host that draws no talk button says when its microphone goes off and comes back, and again after ready while it is off", () => {
    const toView: RpcMessage[] = [];
    const bridge = new Bridge({ manifest: MANIFEST, clientScopes: CLIENT.scopes, instance: 1, talk: true }, { toCophylad: () => {}, toView: (f) => toView.push(f) });
    const mics = () => toView.filter((f) => (f as { method?: string }).method === "host.mic").map((f) => (f as { params: unknown }).params);
    bridge.ready(HELLO);
    expect(mics()).toEqual([]);
    bridge.mic({ error: "Microphone (USB) went away" });
    bridge.mic({ error: "Microphone (USB) went away" });
    expect(mics()).toEqual([{ error: "Microphone (USB) went away" }]);
    // A view loaded again while it is off hears it after its ready.
    bridge.ready(HELLO);
    expect(mics()).toHaveLength(2);
    expect(toView.at(-1)).toEqual({ jsonrpc: "2.0", method: "host.mic", params: { error: "Microphone (USB) went away" } });
    bridge.mic({});
    expect(mics().at(-1)).toEqual({});
    // A host with its own talk button keeps its microphone to itself.
    const without = make();
    without.bridge.mic({ error: "off" });
    expect(without.toView).toEqual([]);
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

describe("the view's talk button, taken by the host's voice", () => {
  const VOICE: ViewManifest = { ...MANIFEST, scopes: [...MANIFEST.scopes!, "voice"] };
  const SCOPES = [...CLIENT.scopes, "voice" as const];

  function voiced(ptt?: (params: HostPtt) => Promise<unknown>, manifest = VOICE) {
    const toCophylad: unknown[] = [];
    const toView: RpcMessage[] = [];
    const bridge = new Bridge({ manifest, clientScopes: SCOPES, instance: 1, talk: true, ...(ptt ? { ptt } : {}) }, { toCophylad: (f) => toCophylad.push(f), toView: (f) => toView.push(f) });
    return { bridge, toCophylad, toView };
  }

  test("press, release and cancel go to the host with the pointer's time, never to cophylad, and are answered as the host answers", async () => {
    const asked: HostPtt[] = [];
    const { bridge, toCophylad, toView } = voiced(async (p) => void asked.push(p));
    bridge.fromView(req("p", "voice.ptt", { active: true, dictate: true, at: 1764230400000 }));
    bridge.fromView(req("r", "voice.ptt", { active: false, at: 1764230402000 }));
    bridge.fromView(req("c", "voice.ptt", { active: false, cancel: true, at: 1764230403000 }));
    await Bun.sleep(0);
    expect(asked).toEqual([
      { active: true, dictate: true, at: 1764230400000 },
      { active: false, at: 1764230402000 },
      { active: false, cancel: true, at: 1764230403000 },
    ]);
    expect(toCophylad).toEqual([]);
    expect(toView).toEqual([
      { jsonrpc: "2.0", id: "p", result: {} },
      { jsonrpc: "2.0", id: "r", result: {} },
      { jsonrpc: "2.0", id: "c", result: {} },
    ]);
  });

  test("an old view that says no time is stamped when the bridge takes its press; a frame number of its own is not passed on", async () => {
    const asked: HostPtt[] = [];
    const { bridge } = voiced(async (p) => void asked.push(p));
    const before = Date.now();
    bridge.fromView(req("p", "voice.ptt", { active: true }));
    bridge.fromView(req("r", "voice.ptt", { active: false, upTo: 12 }));
    await Bun.sleep(0);
    expect(asked[0]!.at).toBeGreaterThanOrEqual(before);
    expect(asked[0]!.at).toBeLessThanOrEqual(Date.now());
    expect(asked[1]).not.toHaveProperty("upTo");
  });

  test("the node's refusal reaches the view as the node said it, and a plain failure as unavailable", async () => {
    const refusing = voiced(async () => {
      throw new RpcError("unavailable", "speech to text is loading");
    });
    refusing.bridge.fromView(req("p", "voice.ptt", { active: true }));
    await Bun.sleep(0);
    expect(refusing.toView[0]).toMatchObject({ id: "p", error: { message: "speech to text is loading", data: { code: "unavailable" } } });
    const coded = voiced(async () => {
      throw Object.assign(new Error("this client has no microphone"), { code: "invalid" });
    });
    coded.bridge.fromView(req("p", "voice.ptt", { active: true }));
    await Bun.sleep(0);
    expect(coded.toView[0]).toMatchObject({ id: "p", error: { data: { code: "invalid", message: "this client has no microphone" } } });
  });

  test("bad params are refused by the bridge, and a view without the voice scope is denied before the host hears of it", async () => {
    const asked: HostPtt[] = [];
    const { bridge, toView } = voiced(async (p) => void asked.push(p));
    bridge.fromView(req("p", "voice.ptt", { active: false, cancel: false }));
    const deaf = voiced(async (p) => void asked.push(p), MANIFEST);
    deaf.bridge.fromView(req("p", "voice.ptt", { active: true }));
    await Bun.sleep(0);
    expect(asked).toEqual([]);
    expect(toView[0]).toMatchObject({ id: "p", error: { data: { code: "invalid" } } });
    expect(deaf.toView[0]).toMatchObject({ id: "p", error: { data: { code: "denied" } } });
  });

  test("without a host voice to take it, voice.ptt goes on to cophylad as it is", () => {
    const { bridge, toCophylad } = voiced();
    bridge.fromView(req("p", "voice.ptt", { active: true, dictate: true, at: 1764230400000 }));
    expect(toCophylad).toEqual([{ jsonrpc: "2.0", id: "v1-1", method: "voice.ptt", params: { active: true, dictate: true, at: 1764230400000 } }]);
  });
});
