// Web tabs (webtabs/index.ts, token.ts, endpoint.ts, methods.ts): the tabs kept per session, the
// desktop app that opens them and alone reports them, an agent's tab waiting for the app, the
// sealed endpoint a started session's Playwright is given, and the protocol's tables for them.

import { describe, expect, test } from "bun:test";
import { actionDefinition, notificationFilters, notificationScope, requestFilters, requestScopes, RpcError } from "@cophyla/protocol";
import type { ClientId, SessionId, WebTab } from "@cophyla/protocol";
import { Bus } from "../src/bus.ts";
import { silentLogger } from "../src/log.ts";
import { agentEndpoint } from "../src/webtabs/endpoint.ts";
import { TABS_PER_SESSION, WebTabs, webTabUrl } from "../src/webtabs/index.ts";
import { webTabsMethods } from "../src/webtabs/methods.ts";
import { cdpEndpoint, cdpToken, readCdpToken } from "../src/webtabs/token.ts";

const S1 = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1" as SessionId;
const S2 = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB2" as SessionId;
const ELSEWHERE = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB3" as SessionId;
const APP = "cli_01ARZ3NDEKTSV4RRFFQ69G5AP1" as ClientId;
const OTHER = "cli_01ARZ3NDEKTSV4RRFFQ69G5AP2" as ClientId;

function kit(o: { targetWaitMs?: number } = {}) {
  const bus = new Bus();
  const told: WebTab[] = [];
  bus.on("webtab.state", (t) => told.push(t));
  const tabs = new WebTabs({
    bus,
    refuse: (s) => (s === ELSEWHERE ? "a web tab opens on the machine the agent runs on" : undefined),
    machine: () => "Desk",
    log: silentLogger,
    ...(o.targetWaitMs !== undefined ? { targetWaitMs: o.targetWaitMs } : {}),
  });
  return { tabs, told };
}

const code = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return e instanceof RpcError ? e.error.code : "thrown";
  }
  return undefined;
};

describe("web tabs", () => {
  test("a page is http, https or blank", () => {
    expect(webTabUrl(undefined)).toBe("about:blank");
    expect(webTabUrl("  ")).toBe("about:blank");
    expect(webTabUrl("http://localhost:5173")).toBe("http://localhost:5173/");
    expect(webTabUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    for (const bad of ["file:///C:/x.html", "javascript:alert(1)", "localhost:3000", "http://u:p@localhost/", "chrome://settings"]) expect(code(() => webTabUrl(bad))).toBe("invalid");
  });

  test("with no desktop app there is nowhere to open one, and the user is told where to look", () => {
    const { tabs } = kit();
    try {
      tabs.open(S1, "http://localhost:3000", "user");
      throw new Error("opened");
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).error.code).toBe("unavailable");
      expect((e as RpcError).error.message).toContain("desktop app on Desk");
    }
  });

  test("a session of another machine has none here", () => {
    const { tabs } = kit();
    tabs.hostConnected(APP);
    expect(code(() => tabs.open(ELSEWHERE, undefined, "user"))).toBe("unsupported");
  });

  test("a tab opens, is told, follows what the app says of it, and closes once", () => {
    const { tabs, told } = kit();
    tabs.hostConnected(APP);
    const tab = tabs.open(S1, "http://localhost:3000", "user");
    expect(tab).toMatchObject({ session: S1, url: "http://localhost:3000/", by: "user" });
    expect(tab.id.startsWith("wtb_")).toBe(true);
    expect(told.at(-1)).toEqual(tab);
    tabs.report(APP, { id: tab.id, target: "T1", port: 9333 });
    expect(tabs.port()).toBe(9333);
    expect(tabs.ownerOf("T1")).toBe(S1);
    tabs.report(APP, { id: tab.id, url: "http://localhost:3000/login", title: "Log in", loading: false });
    expect(tabs.list()[0]).toMatchObject({ target: "T1", url: "http://localhost:3000/login", title: "Log in", loading: false });
    const before = told.length;
    tabs.report(APP, { id: tab.id, title: "Log in" });
    expect(told.length).toBe(before);
    tabs.close(tab.id);
    expect(told.at(-1)).toMatchObject({ id: tab.id, closed: true });
    tabs.close(tab.id);
    expect(told.at(-1)?.closed).toBe(true);
    expect(tabs.list()).toEqual([]);
    expect(tabs.ownerOf("T1")).toBeUndefined();
  });

  test("only the app that opens the tabs reports them", () => {
    const { tabs } = kit();
    tabs.hostConnected(APP);
    const tab = tabs.open(S1, undefined, "user");
    expect(code(() => tabs.report(OTHER, { id: tab.id, target: "T9" }))).toBe("denied");
    expect(tabs.list()[0]!.target).toBeUndefined();
    // a tab already gone is passed over
    tabs.report(APP, { id: "wtb_01ARZ3NDEKTSV4RRFFQ69G5ZZZ" as WebTab["id"], target: "T2" });
  });

  test("a tab the app could not open is closed", () => {
    const { tabs, told } = kit();
    tabs.hostConnected(APP);
    const tab = tabs.open(S1, undefined, "user");
    tabs.report(APP, { id: tab.id, gone: true, error: "no browser" });
    expect(tabs.list()).toEqual([]);
    expect(told.at(-1)).toMatchObject({ id: tab.id, closed: true });
  });

  test("a session keeps a bounded number of tabs", () => {
    const { tabs } = kit();
    tabs.hostConnected(APP);
    for (let i = 0; i < TABS_PER_SESSION; i++) tabs.open(S1, undefined, "user");
    expect(code(() => tabs.open(S1, undefined, "user"))).toBe("quota_exceeded");
    expect(code(() => tabs.open(S2, undefined, "user"))).toBeUndefined();
    expect(tabs.of(S1).length).toBe(TABS_PER_SESSION);
    expect(tabs.of(S2).length).toBe(1);
  });

  test("when the app goes, every tab goes with its browser, and what waited is told why", async () => {
    const { tabs, told } = kit();
    tabs.hostConnected(APP);
    tabs.open(S1, undefined, "user");
    const waiting = tabs.openForAgent(S2, "about:blank");
    tabs.clientGone(OTHER);
    expect(tabs.list().length).toBe(2);
    tabs.clientGone(APP);
    expect(tabs.list()).toEqual([]);
    expect(tabs.hosted).toBe(false);
    expect(tabs.port()).toBeUndefined();
    expect(told.filter((t) => t.closed).length).toBe(2);
    await expect(waiting).rejects.toThrow("desktop app closed");
  });

  test("an agent's tab waits for the app to open it", async () => {
    const { tabs } = kit();
    tabs.hostConnected(APP);
    const opening = tabs.openForAgent(S1, "http://localhost:5173");
    const tab = tabs.of(S1)[0]!;
    expect(tab.by).toBe("agent");
    tabs.report(APP, { id: tab.id, url: "http://localhost:5173/" });
    tabs.report(APP, { id: tab.id, target: "T7", port: 9444 });
    const opened = await opening;
    expect(opened.target).toBe("T7");
    // asked again once it is open, it answers at once
    expect((await tabs.target(tab.id)).target).toBe("T7");
  });

  test("an agent's tab the app never opens fails in time, and one refused fails at once", async () => {
    const { tabs } = kit({ targetWaitMs: 30 });
    await expect(tabs.openForAgent(S1, "about:blank")).rejects.toThrow("desktop app");
    tabs.hostConnected(APP);
    await expect(tabs.openForAgent(S1, "about:blank")).rejects.toThrow("did not open the web tab");
    await expect(tabs.openForAgent(S1, "file:///etc/passwd")).rejects.toThrow("http or https");
  });

  test("watchers hear every change, and stop when they let go", () => {
    const { tabs } = kit();
    tabs.hostConnected(APP);
    const heard: WebTab[] = [];
    const stop = tabs.watch((t) => heard.push(t));
    const tab = tabs.open(S1, undefined, "user");
    tabs.report(APP, { id: tab.id, target: "T1" });
    stop();
    tabs.close(tab.id);
    expect(heard.map((t) => t.target ?? "-")).toEqual(["-", "T1"]);
  });
});

describe("the debugging endpoint's token", () => {
  test("names the session and is sealed by this daemon's secret", () => {
    const native = "6f1c2d3e-0000-4000-8000-123456789abc";
    const token = cdpToken("secret-a", native);
    expect(readCdpToken("secret-a", token)).toBe(native);
    expect(readCdpToken("secret-b", token)).toBeUndefined();
    expect(readCdpToken("secret-a", `${native}.AAAAAAAAAAAAAAAAAAAAAA`)).toBeUndefined();
    expect(readCdpToken("secret-a", `other.${token.split(".")[1]}`)).toBeUndefined();
    expect(readCdpToken("secret-a", "nodot")).toBeUndefined();
    expect(readCdpToken("secret-a", `../x.${token.split(".")[1]}`)).toBeUndefined();
    expect(cdpEndpoint(4818, "secret-a", native)).toBe(`ws://127.0.0.1:4818/cdp/${token}`);
  });
});

describe("an agent's Playwright before its proxy starts", () => {
  const agent = () => {
    const closed: [number | undefined, string | undefined][] = [];
    return { closed, socket: { send: () => undefined, close: (c?: number, r?: string) => void closed.push([c, r]) } };
  };
  const fakeProxy = () => {
    const got: string[] = [];
    let opened = false;
    return { got, get opened() { return opened; }, socket: { open: () => void (opened = true), message: (t: string) => void got.push(t), close: () => undefined } };
  };

  test("a session with no tab gets a blank one first; what Playwright sent meanwhile follows in order", async () => {
    const { tabs } = kit();
    tabs.hostConnected(APP);
    const p = fakeProxy();
    const ep = agentEndpoint(tabs, S1, () => p.socket, silentLogger);
    const a = agent();
    ep.open(a.socket);
    ep.message("1");
    ep.message("2");
    expect(p.opened).toBe(false);
    const tab = tabs.of(S1)[0]!;
    expect(tab).toMatchObject({ url: "about:blank", by: "agent" });
    tabs.report(APP, { id: tab.id, target: "T1", port: 9333 });
    await Bun.sleep(1);
    expect(p.opened).toBe(true);
    ep.message("3");
    expect(p.got).toEqual(["1", "2", "3"]);
  });

  test("a session with a tab starts at once", async () => {
    const { tabs } = kit();
    tabs.hostConnected(APP);
    const tab = tabs.open(S1, undefined, "user");
    tabs.report(APP, { id: tab.id, target: "T1", port: 9333 });
    const p = fakeProxy();
    const ep = agentEndpoint(tabs, S1, () => p.socket, silentLogger);
    ep.open(agent().socket);
    await Bun.sleep(1);
    expect(p.opened).toBe(true);
    expect(tabs.of(S1).length).toBe(1);
  });

  test("no tab to open: Playwright is closed with why", async () => {
    const { tabs } = kit({ targetWaitMs: 20 });
    tabs.hostConnected(APP);
    const ep = agentEndpoint(tabs, S1, () => fakeProxy().socket, silentLogger);
    const a = agent();
    ep.open(a.socket);
    await Bun.sleep(60);
    expect(a.closed[0]?.[0]).toBe(1011);
    expect(a.closed[0]?.[1]).toContain("no web tab");
    expect((a.closed[0]?.[1] ?? "").length).toBeLessThanOrEqual(120);
  });
});

describe("the methods and the protocol's tables", () => {
  test("list, open and close; report only from the app", () => {
    const { tabs } = kit();
    tabs.hostConnected(APP);
    const m = webTabsMethods({ tabs });
    const ctx = (id: ClientId) => ({ client: { id } }) as never;
    const { tab } = m["webtab.open"]!.handler({ session: S1, url: "http://localhost:8080" }, ctx(OTHER)) as { tab: WebTab };
    expect(tab.by).toBe("user");
    expect((m["webtab.list"]!.handler({}, ctx(OTHER)) as { tabs: WebTab[] }).tabs.length).toBe(1);
    expect(code(() => m["webtab.report"]!.handler({ id: tab.id, target: "T" }, ctx(OTHER)))).toBe("denied");
    m["webtab.report"]!.handler({ id: tab.id, target: "T" }, ctx(APP));
    m["webtab.close"]!.handler({ id: tab.id }, ctx(OTHER));
    expect(tabs.list()).toEqual([]);
  });

  test("scopes: reading needs sessions:read, opening sessions:write, and no view may report", () => {
    expect(requestScopes["webtab.list"]).toBe("sessions:read");
    expect(requestScopes["webtab.open"]).toBe("sessions:write");
    expect(requestScopes["webtab.close"]).toBe("sessions:write");
    expect(requestScopes["webtab.report"]).toBeNull();
    expect(notificationScope("webtab.state")).toBe("sessions:read");
    expect(actionDefinition("webtab.open")?.risk).toBe("write");
  });

  test("limited access sees and opens only the sessions it may reach", () => {
    const keep = (n: { session?: string }) => n.session === S1;
    const list = requestFilters["webtab.list"]!;
    const tabsOf = (list as { result: (r: { tabs: WebTab[] }, k: typeof keep) => { tabs: WebTab[] } }).result({ tabs: [{ id: "wtb_1", session: S1 } as unknown as WebTab, { id: "wtb_2", session: S2 } as unknown as WebTab] }, keep);
    expect(tabsOf.tabs.map((t) => t.session)).toEqual([S1]);
    const open = requestFilters["webtab.open"] as { names: (p: { session: SessionId }) => { session: string }[] };
    expect(open.names({ session: S2 })).toEqual([{ session: S2 }]);
    expect((notificationFilters["webtab.state"] as (p: { session: string }) => { session: string })({ session: S2 })).toEqual({ session: S2 });
  });
});
