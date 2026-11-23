// Web tabs in the desktop app: the host opens in the shell every tab cophylad keeps that is not
// closed and not open here, after each welcome and as they change, and tells cophylad where each
// is (its target and the browser's port) or that it could not open; a closed tab closes, and
// one closed while it opened goes once it has; what the shell says of a tab goes on to cophylad
// once per change, a window a page asked for opens as a tab of the same session, and a tab the
// shell lost is gone; a view places a tab inside its frame, hidden under the host's own layers
// and until the next document places it, and takes it to pages; the link going closes them all.

import { describe, expect, test } from "bun:test";
import type { WebTab } from "@cophyla/protocol";
import { WebTabs, webPage, webTabOf, webTabsHere } from "../host/webtabs.ts";

const SESSION = "sess_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const T1 = "wtb_01ARZ3NDEKTSV4RRFFQ69G5FB1";
const T2 = "wtb_01ARZ3NDEKTSV4RRFFQ69G5FB2";
const T3 = "wtb_01ARZ3NDEKTSV4RRFFQ69G5FB3";

const tab = (id: string, extra: Partial<WebTab> = {}): WebTab => ({ id, session: SESSION, url: "https://example.com/", by: "agent", at: 1, ...extra });
const state = (t: WebTab) => ({ jsonrpc: "2.0", method: "webtab.state", params: t });

/** A shell and a link that answer as told: `webtab_open` with a target per tab, or the error given. */
function make(opts: { list?: WebTab[]; failOpen?: string; hold?: boolean } = {}) {
  const invoked: [string, Record<string, unknown> | undefined][] = [];
  const requests: [string, unknown][] = [];
  const holds: (() => void)[] = [];
  const tabs = new WebTabs({
    invoke: async <T>(cmd: string, args?: Record<string, unknown>) => {
      invoked.push([cmd, args]);
      if (cmd === "webtab_open") {
        if (opts.hold) await new Promise<void>((resolve) => holds.push(resolve));
        if (opts.failOpen) throw new Error(opts.failOpen);
        return { port: 9333, target: `target-${String(args?.["tab"]).slice(-1)}` } as T;
      }
      return undefined as T;
    },
    request: async (method, params) => {
      requests.push([method, params]);
      if (method === "webtab.list") return { tabs: opts.list ?? [] };
      return {};
    },
    frame: () => ({ left: 0, top: 30, width: 1000, height: 700 }),
  });
  const of = (cmd: string) => invoked.filter(([c]) => c === cmd).map(([, a]) => a);
  const reports = () => requests.filter(([m]) => m === "webtab.report").map(([, p]) => p);
  return { tabs, invoked, requests, holds, of, reports };
}

const tick = () => Bun.sleep(0);

describe("web tabs in the desktop app", () => {
  test("only Windows opens them", () => {
    expect(webTabsHere("Win32")).toBe(true);
    expect(webTabsHere("MacIntel")).toBe(false);
    expect(webTabsHere("Linux x86_64")).toBe(false);
    expect(webTabsHere("")).toBe(false);
  });

  test("a view asks for a tab by its id, an op, and a rect, a web page or nothing; anything else says why not", () => {
    expect(webTabOf({ op: "place", tab: T1, rect: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({ op: "place", tab: T1, rect: { x: 1, y: 2, width: 3, height: 4 } });
    expect(webTabOf({ op: "place", tab: T1, rect: null })).toEqual({ op: "place", tab: T1, rect: null });
    expect(webTabOf({ op: "go", tab: T1, url: "https://example.com/a b" })).toEqual({ op: "go", tab: T1, url: "https://example.com/a%20b" });
    expect(webTabOf({ op: "go", tab: T1, url: "about:blank" })).toEqual({ op: "go", tab: T1, url: "about:blank" });
    for (const op of ["back", "forward", "reload", "devtools"]) expect(webTabOf({ op, tab: T1 })).toEqual({ op, tab: T1 } as never);
    const refused: [unknown, string][] = [
      [{}, "host.webtab needs an op: place, go, back, forward, reload, devtools"],
      [{ op: "close", tab: T1 }, "host.webtab needs an op: place, go, back, forward, reload, devtools"],
      [{ op: "place" }, "host.webtab needs a tab"],
      [{ op: "place", tab: "wtb_x" }, "host.webtab needs a tab"],
      [{ op: "place", tab: "stream_1", rect: null }, "host.webtab needs a tab"],
      [{ op: "place", tab: T1 }, "a place needs a rect, or null"],
      [{ op: "place", tab: T1, rect: { x: 1, y: 2, width: Number.NaN, height: 4 } }, "a place needs a rect, or null"],
      [{ op: "go", tab: T1 }, "only a web page opens in a web tab"],
      [{ op: "go", tab: T1, url: "file:///C:/Windows/notepad.exe" }, "only a web page opens in a web tab"],
      [{ op: "go", tab: T1, url: "javascript:alert(1)" }, "only a web page opens in a web tab"],
      [{ op: "go", tab: T1, url: "about:settings" }, "only a web page opens in a web tab"],
      [{ op: "go", tab: T1, url: `https://example.com/${"a".repeat(8192)}` }, "only a web page opens in a web tab"],
    ];
    for (const [params, why] of refused) expect(webTabOf(params)).toEqual({ refuse: why });
    expect(webPage("http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5173/");
    for (const bad of ["data:text/html,hi", "edge://settings", "view-source:https://example.com/", "ws://127.0.0.1/", 7, "not a url"]) expect(webPage(bad)).toBeUndefined();
  });

  test("after a welcome every tab not closed opens, and cophylad hears where; one listed after it closed does not", async () => {
    const t = make({ list: [tab(T1), tab(T2, { closed: true }), tab(T3, { url: "about:blank", by: "user" })] });
    await t.tabs.welcome();
    await tick();
    expect(t.of("webtab_open")).toEqual([
      { tab: T1, url: "https://example.com/" },
      { tab: T3, url: "about:blank" },
    ]);
    expect(t.reports()).toEqual([
      { id: T1, target: "target-1", port: 9333 },
      { id: T3, target: "target-3", port: 9333 },
    ]);
    expect(t.tabs.ids).toEqual([T1, T3]);
    // the same tab told again, as its page or target changes, opens nothing more
    t.tabs.onNotification(state(tab(T1, { target: "target-1", title: "Example" })));
    await t.tabs.welcome();
    await tick();
    expect(t.of("webtab_open")).toHaveLength(2);
    // closed: it closes, once; a list a moment old does not open it again
    t.tabs.onNotification(state(tab(T1, { closed: true })));
    t.tabs.onNotification(state(tab(T1, { closed: true })));
    expect(t.of("webtab_close")).toEqual([{ tab: T1 }]);
    t.tabs.onNotification(state(tab(T1)));
    await tick();
    expect(t.of("webtab_open")).toHaveLength(2);
    expect(t.tabs.ids).toEqual([T3]);
    // something that is not a tab is passed over
    t.tabs.onNotification({ method: "webtab.state", params: { id: "wtb_x" } });
    t.tabs.onNotification({ method: "note.state", params: tab(T2) });
    await tick();
    expect(t.of("webtab_open")).toHaveLength(2);
  });

  test("a tab the shell cannot open is gone, with why, and is not opened again", async () => {
    const t = make({ failOpen: "unsupported: web tabs open in the Windows app for now" });
    t.tabs.onNotification(state(tab(T1)));
    await tick();
    expect(t.reports()).toEqual([{ id: T1, gone: true, error: "unsupported: web tabs open in the Windows app for now" }]);
    expect(t.tabs.ids).toEqual([]);
    t.tabs.onNotification(state(tab(T1)));
    await tick();
    expect(t.of("webtab_open")).toHaveLength(1);
    await expect(t.tabs.host("host.webtab", { op: "reload", tab: T1 })).rejects.toThrow("no such web tab here");
  });

  test("a tab closed, or the link lost, while it opens goes once it has, and cophylad hears nothing of it", async () => {
    const t = make({ hold: true });
    t.tabs.onNotification(state(tab(T1)));
    t.tabs.onNotification(state(tab(T2)));
    await tick();
    t.tabs.onNotification(state(tab(T1, { closed: true })));
    expect(t.of("webtab_close")).toEqual([]);
    t.tabs.linkLost();
    expect(t.of("webtab_close")).toEqual([]);
    for (const go of t.holds) go();
    await tick();
    await tick();
    expect(t.of("webtab_close")).toEqual([{ tab: T1 }, { tab: T2 }]);
    expect(t.reports()).toEqual([]);
  });

  test("what the shell says of a tab goes on to cophylad once per change; a window it asked for opens beside it; a tab the shell lost is gone", async () => {
    const t = make();
    t.tabs.onNotification(state(tab(T1)));
    await tick();
    t.requests.length = 0;
    t.tabs.shellState({ tab: T1, url: "https://example.com/next", loading: true });
    t.tabs.shellState({ tab: T1, url: "https://example.com/next", loading: true });
    t.tabs.shellState({ tab: T1, url: "https://example.com/next", loading: false });
    t.tabs.shellState({ tab: T1, title: "x".repeat(600) });
    t.tabs.shellState({ tab: T1, url: `https://example.com/${"a".repeat(8192)}` });
    t.tabs.shellState({ tab: T2, title: "not a tab of this host" });
    expect(t.reports()).toEqual([
      { id: T1, url: "https://example.com/next", loading: true },
      { id: T1, loading: false },
      { id: T1, title: "x".repeat(500) },
    ]);
    t.requests.length = 0;
    t.tabs.newWindow({ tab: T1, url: "https://example.com/popup" });
    t.tabs.newWindow({ tab: T1, url: "file:///C:/x" });
    t.tabs.newWindow({ tab: T2, url: "https://example.com/" });
    expect(t.requests).toEqual([["webtab.open", { session: SESSION, url: "https://example.com/popup" }]]);
    t.requests.length = 0;
    t.tabs.shellClosed({ tab: T1 });
    t.tabs.shellClosed({ tab: T1 });
    expect(t.requests).toEqual([["webtab.report", { id: T1, gone: true }]]);
    expect(t.tabs.ids).toEqual([]);
    // cophylad's word that it closed closes nothing more in the shell
    t.tabs.onNotification(state(tab(T1, { closed: true })));
    expect(t.of("webtab_close")).toEqual([]);
  });

  test("a view places a tab inside its frame, hides it, and it hides under the host's layers and with the view's document", async () => {
    const t = make({ hold: true });
    t.tabs.onNotification(state(tab(T1)));
    await tick();
    // placed while it opens: shown once it has
    expect(await t.tabs.host("host.webtab", { op: "place", tab: T1, rect: { x: 500, y: 0, width: 500, height: 700 } })).toEqual({});
    expect(t.of("webtab_place")).toEqual([]);
    t.holds[0]!();
    await tick();
    await tick();
    expect(t.of("webtab_place")).toEqual([{ tab: T1, x: 500, y: 30, width: 500, height: 700 }]);
    // cut to the frame
    await t.tabs.host("host.webtab", { op: "place", tab: T1, rect: { x: 600, y: -10, width: 900, height: 900 } });
    expect(t.of("webtab_place").at(-1)).toEqual({ tab: T1, x: 600, y: 30, width: 400, height: 700 });
    await t.tabs.host("host.webtab", { op: "place", tab: T1, rect: null });
    expect(t.of("webtab_place").at(-1)).toEqual({ tab: T1, hidden: true });
    await t.tabs.host("host.webtab", { op: "place", tab: T1, rect: { x: 400, y: 0, width: 600, height: 700 } });

    // under the picker, and back where it was; a place meanwhile is kept for later
    t.tabs.overlay(true);
    await tick();
    expect(t.of("webtab_place").at(-1)).toEqual({ tab: T1, hidden: true });
    await t.tabs.host("host.webtab", { op: "place", tab: T1, rect: { x: 300, y: 0, width: 700, height: 700 } });
    expect(t.of("webtab_place").at(-1)).toEqual({ tab: T1, hidden: true });
    t.tabs.overlay(false);
    await tick();
    expect(t.of("webtab_place").at(-1)).toEqual({ tab: T1, x: 300, y: 30, width: 700, height: 700 });

    // the view's document went: the tab stays open, hidden, until the next one places it
    t.tabs.unmounted();
    await tick();
    expect(t.of("webtab_place").at(-1)).toEqual({ tab: T1, hidden: true });
    t.tabs.overlay(true);
    t.tabs.overlay(false);
    await tick();
    expect(t.of("webtab_place").at(-1)).toEqual({ tab: T1, hidden: true });
    expect(t.of("webtab_close")).toEqual([]);
    expect(t.tabs.ids).toEqual([T1]);
  });

  test("a view takes a tab to a page, back, forward, reloads it or opens its DevTools; nothing else, and only a tab of this host", async () => {
    const t = make();
    t.tabs.onNotification(state(tab(T1)));
    await t.tabs.host("host.webtab", { op: "go", tab: T1, url: "https://example.com/b" });
    for (const op of ["back", "forward", "reload", "devtools"]) await t.tabs.host("host.webtab", { op, tab: T1 });
    expect(t.of("webtab_go")).toEqual([
      { tab: T1, url: "https://example.com/b" },
      { tab: T1, action: "back" },
      { tab: T1, action: "forward" },
      { tab: T1, action: "reload" },
      { tab: T1, action: "devtools" },
    ]);
    await expect(t.tabs.host("host.webtab", { op: "go", tab: T1, url: "file:///C:/x" })).rejects.toThrow("only a web page opens in a web tab");
    await expect(t.tabs.host("host.webtab", { op: "reload", tab: T2 })).rejects.toThrow("no such web tab here");
    await expect(t.tabs.host("host.open", {})).rejects.toThrow("no host.open");
    expect(t.of("webtab_go")).toHaveLength(5);
  });

  test("the link going closes every tab; a list asked before it is passed over, and the next welcome opens what cophylad keeps", async () => {
    let answer!: (v: unknown) => void;
    const requests: string[] = [];
    const invoked: [string, unknown][] = [];
    const tabs = new WebTabs({
      invoke: async <T>(cmd: string, args?: Record<string, unknown>) => {
        invoked.push([cmd, args]);
        return (cmd === "webtab_open" ? { port: 9333, target: "t" } : undefined) as T;
      },
      request: (method) => {
        requests.push(method);
        return method === "webtab.list" ? new Promise((resolve) => (answer = resolve)) : Promise.resolve({});
      },
    });
    tabs.onNotification(state(tab(T1)));
    tabs.onNotification(state(tab(T2)));
    await tick();
    const late = tabs.welcome();
    tabs.linkLost();
    expect(invoked.filter(([c]) => c === "webtab_close")).toEqual([
      ["webtab_close", { tab: T1 }],
      ["webtab_close", { tab: T2 }],
    ]);
    expect(tabs.ids).toEqual([]);
    answer({ tabs: [tab(T3)] });
    await late;
    await tick();
    expect(invoked.filter(([c]) => c === "webtab_open")).toHaveLength(2);
    const next = tabs.welcome();
    answer({ tabs: [tab(T1), tab(T3)] });
    await next;
    await tick();
    expect(invoked.filter(([c]) => c === "webtab_open").map(([, a]) => (a as { tab: string }).tab)).toEqual([T1, T2, T1, T3]);
    expect(tabs.ids).toEqual([T1, T3]);
  });
});
