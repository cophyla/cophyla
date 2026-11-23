// The debugging-protocol proxy between one agent's Playwright and the web tab browser: the agent
// sees and drives only its session's tabs. Pages of other sessions and other targets are
// released by the proxy itself (resumed if they wait for a debugger, then detached), pages
// Cophyla does not know yet are held until it does or the hold runs out, CDP sessions the agent
// was not given are refused, `Target.createTarget` opens a tab beside the chat instead of a bare
// browser window and answers once the page is the agent's, and either side closing closes the
// other. Then the default upstream against a stand-in browser on loopback.

import { afterEach, describe, expect, test } from "bun:test";
import { newId } from "@cophyla/protocol";
import type { SessionId, WebTab, WebTabId } from "@cophyla/protocol";
import { CdpProxy, connectUpstream, NO_BROWSER } from "../src/webtabs/cdp.ts";
import type { TabsForProxy, UpstreamSocket } from "../src/webtabs/cdp.ts";

const A = newId("session") as SessionId;
const B = newId("session") as SessionId;

const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Sent {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { code: number; message: string };
  sessionId?: string;
}

class FakeUpstream implements UpstreamSocket {
  sent: Sent[] = [];
  closed = false;
  private onMsg?: (text: string) => void;
  private onEnd?: (reason: string) => void;
  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }
  close(): void {
    this.closed = true;
  }
  onMessage(cb: (text: string) => void): void {
    this.onMsg = cb;
  }
  onClose(cb: (reason: string) => void): void {
    this.onEnd = cb;
  }
  emit(msg: Sent): void {
    this.onMsg?.(JSON.stringify(msg));
  }
  end(reason = "gone"): void {
    this.onEnd?.(reason);
  }
  /** The requests of a method the proxy sent, in order. */
  of(method: string): Sent[] {
    return this.sent.filter((m) => m.method === method);
  }
  last(method: string): Sent {
    const all = this.of(method);
    const m = all[all.length - 1];
    if (!m) throw new Error(`nothing sent for ${method}`);
    return m;
  }
  private answered = new Set<number | undefined>();
  /** The browser answers every resume it was sent and has not answered yet. */
  resumed(): void {
    for (const m of this.of("Runtime.runIfWaitingForDebugger")) if (!this.answered.has(m.id)) this.answer(m);
  }
  answer(req: Sent, result: Record<string, unknown> = {}): void {
    this.answered.add(req.id);
    this.emit(req.sessionId === undefined ? { id: req.id, result } : { id: req.id, result, sessionId: req.sessionId });
  }
}

class FakeAgent {
  got: Sent[] = [];
  closed?: { code?: number; reason?: string };
  send(text: string): void {
    this.got.push(JSON.parse(text));
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  reply(id: number): Sent | undefined {
    return this.got.find((m) => m.id === id && m.method === undefined);
  }
  events(method: string): Sent[] {
    return this.got.filter((m) => m.method === method);
  }
}

class FakeTabs implements TabsForProxy {
  tabs: WebTab[] = [];
  portNo: number | undefined = 9333;
  closedIds: WebTabId[] = [];
  opened: { session: SessionId; url: string }[] = [];
  /** What `openForAgent` does; by default it rejects. */
  onOpen: (session: SessionId, url: string) => Promise<WebTab & { target: string }> = () => Promise.reject(new Error("no host"));
  private watchers = new Set<(tab: WebTab) => void>();
  add(session: SessionId, target: string | undefined, extra: Partial<WebTab> = {}): WebTab {
    const tab: WebTab = { id: newId("webTab") as WebTabId, session, url: "http://localhost:5180/", by: "user", at: Date.now(), ...(target ? { target } : {}), ...extra };
    this.tabs.push(tab);
    return tab;
  }
  /** Changes a tab and tells the watchers. */
  change(tab: WebTab, patch: Partial<WebTab>): void {
    Object.assign(tab, patch);
    for (const w of [...this.watchers]) w({ ...tab });
  }
  of(session: SessionId): WebTab[] {
    return this.tabs.filter((t) => t.session === session && !t.closed);
  }
  openForAgent(session: SessionId, url: string): Promise<WebTab & { target: string }> {
    this.opened.push({ session, url });
    return this.onOpen(session, url);
  }
  close(id: WebTabId): void {
    this.closedIds.push(id);
  }
  ownerOf(target: string): SessionId | undefined {
    return this.tabs.find((t) => t.target === target && !t.closed)?.session;
  }
  port(): number | undefined {
    return this.portNo;
  }
  watch(fn: (tab: WebTab) => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }
  get watching(): number {
    return this.watchers.size;
  }
}

const page = (targetId: string, extra: Record<string, unknown> = {}) => ({ targetId, type: "page", title: "", url: "http://localhost:5180/", attached: true, canAccessOpener: false, browserContextId: "CTX", ...extra });
const attachEvent = (sessionId: string, targetInfo: Record<string, unknown>, waitingForDebugger = false, parent?: string): Sent => ({
  method: "Target.attachedToTarget",
  params: { sessionId, targetInfo, waitingForDebugger },
  ...(parent ? { sessionId: parent } : {}),
});

let proxies: CdpProxy[] = [];
afterEach(() => {
  for (const p of proxies) p.close();
  proxies = [];
});

async function start(opts: { holdMs?: number; session?: SessionId; tabs?: FakeTabs } = {}) {
  const tabs = opts.tabs ?? new FakeTabs();
  const up = new FakeUpstream();
  const ports: number[] = [];
  const agent = new FakeAgent();
  const proxy = new CdpProxy({
    tabs,
    session: opts.session ?? A,
    upstream: async (port) => {
      ports.push(port);
      return up;
    },
    holdMs: opts.holdMs ?? 1000,
  });
  proxies.push(proxy);
  await proxy.open(agent);
  let n = 0;
  /** The agent sends a request; answers its id. */
  const ask = (method: string, params: Record<string, unknown> = {}, sessionId?: string): number => {
    const id = ++n;
    proxy.message(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }));
    return id;
  };
  return { tabs, up, agent, proxy, ports, ask };
}

/** A proxy with browser-level auto-attach on, as Playwright sets it. */
async function attached(opts: { holdMs?: number; tabs?: FakeTabs } = {}) {
  const s = await start(opts);
  const id = s.ask("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  return { ...s, autoAttachReq: s.up.last("Target.setAutoAttach"), autoAttachId: id };
}

describe("opening the connection", () => {
  test("with no web tab browser the agent's connection is closed, saying so", async () => {
    const tabs = new FakeTabs();
    tabs.portNo = undefined;
    const { agent, ports } = await start({ tabs });
    expect(agent.closed).toEqual({ code: 1011, reason: NO_BROWSER });
    expect(NO_BROWSER).toBe("Cophyla's desktop app has no web tab browser open");
    expect(ports).toEqual([]);
  });

  test("a browser that does not answer closes the agent's connection", async () => {
    const agent = new FakeAgent();
    const proxy = new CdpProxy({ tabs: new FakeTabs(), session: A, upstream: () => Promise.reject(new Error("refused")) });
    await proxy.open(agent);
    expect(agent.closed?.code).toBe(1011);
    expect(agent.closed?.reason).toContain("did not answer");
  });

  test("the browser's socket opens on the port the app reported, and what the agent sent first goes once it is open", async () => {
    const up = new FakeUpstream();
    let open!: (u: UpstreamSocket) => void;
    const tabs = new FakeTabs();
    tabs.portNo = 9444;
    const ports: number[] = [];
    const proxy = new CdpProxy({ tabs, session: A, upstream: (port) => (ports.push(port), new Promise((r) => (open = r))) });
    proxies.push(proxy);
    const agent = new FakeAgent();
    const opening = proxy.open(agent);
    proxy.message(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    expect(up.sent).toEqual([]);
    open(up);
    await opening;
    expect(ports).toEqual([9444]);
    expect(up.of("Browser.getVersion")).toHaveLength(1);
  });

  test("an agent gone before the browser's socket opened closes it at once", async () => {
    const up = new FakeUpstream();
    let open!: (u: UpstreamSocket) => void;
    const proxy = new CdpProxy({ tabs: new FakeTabs(), session: A, upstream: () => new Promise((r) => (open = r)) });
    const opening = proxy.open(new FakeAgent());
    proxy.close();
    open(up);
    await opening;
    expect(up.closed).toBe(true);
  });
});

describe("requests and replies", () => {
  test("everything else is forwarded as is under the proxy's own id, and the reply comes back under the agent's", async () => {
    const { up, agent, proxy } = await start();
    proxy.message(JSON.stringify({ id: -9999, method: "Browser.getVersion", params: {} }));
    proxy.message(JSON.stringify({ id: 7, method: "Target.getBrowserContexts" }));
    const v = up.last("Browser.getVersion");
    expect(v.params).toEqual({});
    up.emit({ id: up.last("Target.getBrowserContexts").id, result: { browserContextIds: ["CTX"] } });
    up.answer(v, { product: "Edg/157.0.4341.60" });
    expect(agent.got).toEqual([
      { id: 7, result: { browserContextIds: ["CTX"] } },
      { id: -9999, result: { product: "Edg/157.0.4341.60" } },
    ]);
  });

  test("a browser error comes back as the agent's error", async () => {
    const { up, agent, ask } = await start();
    const id = ask("Page.navigate", { url: "x" });
    up.emit({ id: up.last("Page.navigate").id, error: { code: -32602, message: "Invalid parameters" } });
    expect(agent.reply(id)).toEqual({ id, error: { code: -32602, message: "Invalid parameters" } });
  });

  test("replies the browser sends to no request of the agent's are dropped", async () => {
    const { up, agent } = await start();
    up.emit({ id: 424242, result: {} });
    expect(agent.got).toEqual([]);
  });

  test("a message that is not JSON gets the browser's parse error", async () => {
    const { up, agent, proxy } = await start();
    proxy.message("{nope");
    expect(agent.got[0]?.error?.code).toBe(-32700);
    expect(up.sent).toEqual([]);
  });
});

describe("pages attached at browser level", () => {
  test("the session's tab is let through; another session's is released by the proxy and never shown", async () => {
    const tabs = new FakeTabs();
    tabs.add(A, "T-A");
    tabs.add(B, "T-B");
    const { up, agent, autoAttachReq, autoAttachId } = await attached({ tabs });
    expect(autoAttachReq.params).toEqual({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    up.emit(attachEvent("S-A", page("T-A")));
    up.emit(attachEvent("S-B", page("T-B")));
    up.answer(autoAttachReq);
    expect(agent.events("Target.attachedToTarget").map((e) => e.params?.sessionId)).toEqual(["S-A"]);
    expect(agent.reply(autoAttachId)).toEqual({ id: autoAttachId, result: {} });
    // An already running page does not wait: only the detach.
    expect(up.of("Runtime.runIfWaitingForDebugger")).toEqual([]);
    const detach = up.last("Target.detachFromTarget");
    expect(detach.params).toEqual({ sessionId: "S-B" });
    expect(detach.sessionId).toBeUndefined();
    // Its reply and the browser's word that it detached are the proxy's, not the agent's.
    const before = agent.got.length;
    up.answer(detach);
    up.emit({ method: "Target.detachedFromTarget", params: { sessionId: "S-B", targetId: "T-B" } });
    expect(agent.got.length).toBe(before);
  });

  test("another session's new page waiting for a debugger is resumed, then detached once the resume is answered, so it never stays paused", async () => {
    const tabs = new FakeTabs();
    tabs.add(B, "T-B");
    const { up, agent } = await attached({ tabs });
    up.emit(attachEvent("S-B", page("T-B"), true));
    const run = up.last("Runtime.runIfWaitingForDebugger");
    expect(run.sessionId).toBe("S-B");
    // A detach sent before the resume is answered drops the resume (a shared worker stays paused).
    expect(up.of("Target.detachFromTarget")).toEqual([]);
    up.answer(run);
    const detach = up.last("Target.detachFromTarget");
    expect(detach.params).toEqual({ sessionId: "S-B" });
    expect(agent.events("Target.attachedToTarget")).toEqual([]);
    up.answer(detach);
    expect(agent.got).toEqual([]);
  });

  test("a resume the browser refuses still ends in the detach", async () => {
    const tabs = new FakeTabs();
    tabs.add(B, "T-B");
    const { up } = await attached({ tabs });
    up.emit(attachEvent("S-B", page("T-B"), true));
    up.emit({ id: up.last("Runtime.runIfWaitingForDebugger").id, error: { code: -32001, message: "Session with given id not found." }, sessionId: "S-B" });
    expect(up.last("Target.detachFromTarget").params).toEqual({ sessionId: "S-B" });
  });

  test("targets that are not pages (popup windows aside: workers, service workers, devtools) are released even when waiting", async () => {
    const { up, agent } = await attached();
    up.emit(attachEvent("S-SW", { targetId: "SW", type: "service_worker", url: "http://localhost:5180/sw.js" }, true));
    up.emit(attachEvent("S-SH", { targetId: "SH", type: "shared_worker", url: "http://localhost:5180/w.js" }, true));
    up.emit(attachEvent("S-DT", { targetId: "DT", type: "other", url: "devtools://devtools/x" }));
    expect(agent.events("Target.attachedToTarget")).toEqual([]);
    expect(up.of("Runtime.runIfWaitingForDebugger").map((m) => m.sessionId)).toEqual(["S-SW", "S-SH"]);
    expect(up.of("Target.detachFromTarget").map((m) => m.params?.sessionId)).toEqual(["S-DT"]);
    up.resumed();
    expect(up.of("Target.detachFromTarget").map((m) => m.params?.sessionId)).toEqual(["S-DT", "S-SW", "S-SH"]);
    expect(agent.got.filter((m) => m.id !== 1)).toEqual([]);
  });

  test("a page Cophyla does not know yet is held, and released when the hold runs out", async () => {
    const { up, agent } = await attached({ holdMs: 40 });
    up.emit(attachEvent("S-X", page("T-X"), true));
    expect(up.of("Target.detachFromTarget")).toEqual([]);
    expect(up.of("Runtime.runIfWaitingForDebugger")).toEqual([]);
    expect(agent.events("Target.attachedToTarget")).toEqual([]);
    await sleep(70);
    expect(up.last("Runtime.runIfWaitingForDebugger").sessionId).toBe("S-X");
    up.resumed();
    expect(up.last("Target.detachFromTarget").params).toEqual({ sessionId: "S-X" });
    expect(agent.events("Target.attachedToTarget")).toEqual([]);
  });

  test("a held page is let through as soon as the app reports it as the session's tab", async () => {
    const tabs = new FakeTabs();
    const tab = tabs.add(A, undefined);
    const { up, agent, ask } = await attached({ tabs, holdMs: 1000 });
    up.emit(attachEvent("S-N", page("T-N"), true));
    expect(agent.events("Target.attachedToTarget")).toEqual([]);
    tabs.change(tab, { target: "T-N" });
    expect(agent.events("Target.attachedToTarget").map((e) => e.params)).toEqual([{ sessionId: "S-N", targetInfo: page("T-N"), waitingForDebugger: true }]);
    // The agent resumes it itself, on the session that is now open to it.
    ask("Runtime.runIfWaitingForDebugger", {}, "S-N");
    expect(up.last("Runtime.runIfWaitingForDebugger").sessionId).toBe("S-N");
    expect(up.of("Target.detachFromTarget")).toEqual([]);
  });

  test("a held page reported as another session's is released at once, resumed first", async () => {
    const tabs = new FakeTabs();
    const tab = tabs.add(B, undefined);
    const { up, agent } = await attached({ tabs, holdMs: 1000 });
    up.emit(attachEvent("S-N", page("T-N"), true));
    tabs.change(tab, { target: "T-N" });
    expect(up.last("Runtime.runIfWaitingForDebugger").sessionId).toBe("S-N");
    up.resumed();
    expect(up.last("Target.detachFromTarget").params).toEqual({ sessionId: "S-N" });
    expect(agent.events("Target.attachedToTarget")).toEqual([]);
  });

  test("a held page that goes away is forgotten, and its end is not the agent's", async () => {
    const { up, agent } = await attached({ holdMs: 40 });
    up.emit(attachEvent("S-X", page("T-X"), true));
    up.emit({ method: "Target.detachedFromTarget", params: { sessionId: "S-X", targetId: "T-X" } });
    await sleep(70);
    expect(up.of("Target.detachFromTarget")).toEqual([]);
    expect(agent.got.filter((m) => m.method !== undefined)).toEqual([]);
  });

  test("a page released before the app reported it is attached again by the proxy once it is the session's", async () => {
    const tabs = new FakeTabs();
    const tab = tabs.add(A, undefined);
    const { up, agent } = await attached({ tabs, holdMs: 20 });
    up.emit(attachEvent("S-1", page("T-L"), true));
    await sleep(50);
    up.resumed();
    expect(up.last("Target.detachFromTarget").params).toEqual({ sessionId: "S-1" });
    tabs.change(tab, { target: "T-L" });
    const again = up.last("Target.attachToTarget");
    expect(again.params).toEqual({ targetId: "T-L", flatten: true });
    up.emit(attachEvent("S-2", page("T-L")));
    up.answer(again, { sessionId: "S-2" });
    expect(agent.events("Target.attachedToTarget").map((e) => e.params?.sessionId)).toEqual(["S-2"]);
    expect(agent.got.some((m) => m.result?.sessionId === "S-2")).toBe(false);
  });

  test("the same page attached twice reaches the agent once; the second session is released", async () => {
    const tabs = new FakeTabs();
    tabs.add(A, "T-A");
    const { up, agent } = await attached({ tabs });
    up.emit(attachEvent("S-1", page("T-A")));
    up.emit(attachEvent("S-2", page("T-A"), true));
    expect(agent.events("Target.attachedToTarget").map((e) => e.params?.sessionId)).toEqual(["S-1"]);
    expect(up.last("Runtime.runIfWaitingForDebugger").sessionId).toBe("S-2");
    up.resumed();
    expect(up.last("Target.detachFromTarget").params).toEqual({ sessionId: "S-2" });
  });

  test("a tab moved to another session is taken from the agent, and given back when it moves back", async () => {
    const tabs = new FakeTabs();
    const tab = tabs.add(A, "T-A");
    const { up, agent, ask } = await attached({ tabs });
    up.emit(attachEvent("S-A", page("T-A")));
    tabs.change(tab, { session: B });
    expect(up.last("Target.detachFromTarget").params).toEqual({ sessionId: "S-A" });
    up.emit({ method: "Target.detachedFromTarget", params: { sessionId: "S-A", targetId: "T-A" } });
    expect(agent.events("Target.detachedFromTarget").map((e) => e.params?.sessionId)).toEqual(["S-A"]);
    const id = ask("Runtime.evaluate", { expression: "1" }, "S-A");
    expect(agent.reply(id)?.error?.code).toBe(-32001);
    tabs.change(tab, { session: A });
    expect(up.last("Target.attachToTarget").params).toEqual({ targetId: "T-A", flatten: true });
  });
});

describe("CDP sessions", () => {
  test("commands on a session the agent was given go through, and their replies carry it", async () => {
    const tabs = new FakeTabs();
    tabs.add(A, "T-A");
    const { up, agent, ask } = await attached({ tabs });
    up.emit(attachEvent("S-A", page("T-A"), true));
    const id = ask("Runtime.runIfWaitingForDebugger", {}, "S-A");
    const sent = up.last("Runtime.runIfWaitingForDebugger");
    expect(sent.sessionId).toBe("S-A");
    up.answer(sent);
    expect(agent.reply(id)).toEqual({ id, result: {}, sessionId: "S-A" });
  });

  test("commands on any other session are refused without reaching the browser: unknown, released, held", async () => {
    const tabs = new FakeTabs();
    tabs.add(B, "T-B");
    const { up, agent, ask } = await attached({ tabs });
    up.emit(attachEvent("S-B", page("T-B")));
    up.emit(attachEvent("S-H", page("T-H")));
    const before = up.sent.length;
    for (const sid of ["S-NOPE", "S-B", "S-H"]) {
      const id = ask("Runtime.evaluate", { expression: "document.title" }, sid);
      expect(agent.reply(id)).toEqual({ id, error: { code: -32001, message: "Session with given id not found." }, sessionId: sid });
    }
    const id = ask("Target.sendMessageToTarget", { sessionId: "S-B", message: "{}" });
    expect(agent.reply(id)?.error?.code).toBe(-32001);
    expect(up.sent.length).toBe(before);
  });

  test("events on a session reach the agent only for sessions it was given", async () => {
    const tabs = new FakeTabs();
    tabs.add(A, "T-A");
    tabs.add(B, "T-B");
    const { up, agent } = await attached({ tabs });
    up.emit(attachEvent("S-A", page("T-A")));
    up.emit(attachEvent("S-B", page("T-B")));
    up.emit({ method: "Page.frameNavigated", params: { frame: { id: "T-A" } }, sessionId: "S-A" });
    up.emit({ method: "Page.frameNavigated", params: { frame: { id: "T-B" } }, sessionId: "S-B" });
    up.emit({ method: "Page.frameNavigated", params: { frame: { id: "?" } }, sessionId: "S-OTHER" });
    expect(agent.events("Page.frameNavigated").map((e) => e.sessionId)).toEqual(["S-A"]);
  });

  test("an iframe or worker of the agent's own page joins its sessions, and leaves with it", async () => {
    const tabs = new FakeTabs();
    tabs.add(A, "T-A");
    const { up, agent, ask } = await attached({ tabs });
    up.emit(attachEvent("S-A", page("T-A")));
    up.emit(attachEvent("S-IF", { targetId: "IF", type: "iframe", url: "https://other.example/" }, true, "S-A"));
    up.emit(attachEvent("S-W", { targetId: "W", type: "worker", url: "" }, true, "S-IF"));
    expect(agent.events("Target.attachedToTarget").map((e) => e.params?.sessionId)).toEqual(["S-A", "S-IF", "S-W"]);
    // Nothing of the proxy's: the agent resumes and keeps them.
    expect(up.of("Target.detachFromTarget")).toEqual([]);
    ask("Runtime.runIfWaitingForDebugger", {}, "S-IF");
    ask("Runtime.runIfWaitingForDebugger", {}, "S-W");
    expect(up.of("Runtime.runIfWaitingForDebugger").map((m) => m.sessionId)).toEqual(["S-IF", "S-W"]);
    up.emit({ method: "Runtime.consoleAPICalled", params: {}, sessionId: "S-W" });
    expect(agent.events("Runtime.consoleAPICalled")).toHaveLength(1);
    // The iframe detaches on its parent's session; then its sessions are refused.
    up.emit({ method: "Target.detachedFromTarget", params: { sessionId: "S-IF", targetId: "IF" }, sessionId: "S-A" });
    expect(agent.events("Target.detachedFromTarget")).toHaveLength(1);
    for (const sid of ["S-IF", "S-W"]) {
      const id = ask("Runtime.evaluate", {}, sid);
      expect(agent.reply(id)?.error?.code).toBe(-32001);
    }
  });

  test("the page going takes its frames' sessions with it", async () => {
    const tabs = new FakeTabs();
    tabs.add(A, "T-A");
    const { up, agent, ask } = await attached({ tabs });
    up.emit(attachEvent("S-A", page("T-A")));
    up.emit(attachEvent("S-IF", { targetId: "IF", type: "iframe", url: "" }, false, "S-A"));
    up.emit({ method: "Target.detachedFromTarget", params: { sessionId: "S-A", targetId: "T-A" } });
    expect(agent.events("Target.detachedFromTarget").map((e) => e.params?.sessionId)).toEqual(["S-A"]);
    const id = ask("Runtime.evaluate", {}, "S-IF");
    expect(agent.reply(id)?.error?.code).toBe(-32001);
  });
});

describe("Target commands", () => {
  test("Target.getTargets answers only the session's targets", async () => {
    const tabs = new FakeTabs();
    tabs.add(A, "T-A");
    tabs.add(B, "T-B");
    const { up, agent, ask } = await attached({ tabs });
    up.emit(attachEvent("S-A", page("T-A")));
    up.emit(attachEvent("S-IF", { targetId: "IF", type: "iframe", url: "" }, false, "S-A"));
    const id = ask("Target.getTargets");
    up.answer(up.last("Target.getTargets"), {
      targetInfos: [page("T-A"), page("T-B"), page("T-UNKNOWN"), { targetId: "IF", type: "iframe" }, { targetId: "SW", type: "service_worker" }, { targetId: "BR", type: "browser" }],
    });
    expect(agent.reply(id)?.result?.targetInfos.map((t: { targetId: string }) => t.targetId)).toEqual(["T-A", "IF"]);
  });

  test("attaching to, activating or asking about another session's target is refused as no such target", async () => {
    const tabs = new FakeTabs();
    tabs.add(B, "T-B");
    const { up, agent, ask } = await attached({ tabs });
    const before = up.sent.length;
    for (const method of ["Target.attachToTarget", "Target.activateTarget", "Target.getTargetInfo", "Target.autoAttachRelated"]) {
      const id = ask(method, { targetId: "T-B", flatten: true });
      expect(agent.reply(id)).toEqual({ id, error: { code: -32602, message: "No target with given id found" } });
    }
    const id = ask("Target.detachFromTarget", { targetId: "T-B" });
    expect(agent.reply(id)?.error?.code).toBe(-32602);
    expect(up.sent.length).toBe(before);
  });

  test("the same commands for the session's own tab go to the browser; Target.getTargetInfo without a target is the browser's own", async () => {
    const tabs = new FakeTabs();
    tabs.add(A, "T-A");
    const { up, ask } = await attached({ tabs });
    ask("Target.activateTarget", { targetId: "T-A" });
    ask("Target.getTargetInfo", { targetId: "T-A" });
    ask("Target.getTargetInfo");
    expect(up.of("Target.activateTarget")).toHaveLength(1);
    expect(up.of("Target.getTargetInfo").map((m) => m.params)).toEqual([{ targetId: "T-A" }, {}]);
  });

  test("the agent's own attach to its tab gets a session of its own, even for a page it already has", async () => {
    const tabs = new FakeTabs();
    tabs.add(A, "T-A");
    const { up, agent, ask } = await attached({ tabs });
    up.emit(attachEvent("S-1", page("T-A")));
    const id = ask("Target.attachToTarget", { targetId: "T-A", flatten: true });
    const req = up.last("Target.attachToTarget");
    up.emit(attachEvent("S-2", page("T-A")));
    up.answer(req, { sessionId: "S-2" });
    expect(agent.events("Target.attachedToTarget").map((e) => e.params?.sessionId)).toEqual(["S-1", "S-2"]);
    expect(agent.reply(id)).toEqual({ id, result: { sessionId: "S-2" } });
    expect(up.of("Target.detachFromTarget")).toEqual([]);
    ask("DOM.enable", {}, "S-2");
    expect(up.last("DOM.enable").sessionId).toBe("S-2");
  });

  test("Target.closeTarget closes the session's tab in Cophyla and never reaches the browser; another's is refused", async () => {
    const tabs = new FakeTabs();
    const mine = tabs.add(A, "T-A");
    tabs.add(B, "T-B");
    const { up, agent, ask } = await attached({ tabs });
    const id = ask("Target.closeTarget", { targetId: "T-A" });
    expect(tabs.closedIds).toEqual([mine.id]);
    expect(agent.reply(id)).toEqual({ id, result: { success: true } });
    const other = ask("Target.closeTarget", { targetId: "T-B" });
    expect(agent.reply(other)?.error?.message).toBe("No target with given id found");
    expect(tabs.closedIds).toEqual([mine.id]);
    expect(up.of("Target.closeTarget")).toEqual([]);
  });

  test("browser contexts and browser-wide sessions are not supported", async () => {
    const { up, agent, ask } = await attached();
    const before = up.sent.length;
    for (const method of ["Target.createBrowserContext", "Target.disposeBrowserContext", "Target.attachToBrowserTarget", "Target.exposeDevToolsProtocol", "Browser.crash"]) {
      const id = ask(method, { browserContextId: "CTX", disposeOnDetach: true });
      const reply = agent.reply(id);
      expect(reply?.error?.code).toBe(-32000);
      expect(reply?.error?.message).toBe(`${method} is not supported in Cophyla's web tab`);
    }
    expect(up.sent.length).toBe(before);
  });

  test("Browser.close answers, then closes only the agent's connection; the browser is never told", async () => {
    const { up, agent, ask } = await attached();
    const id = ask("Browser.close");
    expect(agent.reply(id)).toEqual({ id, result: {} });
    expect(agent.closed?.code).toBe(1000);
    expect(up.closed).toBe(true);
    expect(up.of("Browser.close")).toEqual([]);
  });

  test("target events reach the agent only for its own targets", async () => {
    const tabs = new FakeTabs();
    tabs.add(A, "T-A");
    tabs.add(B, "T-B");
    const { up, agent, ask } = await attached({ tabs });
    ask("Target.setDiscoverTargets", { discover: true });
    for (const t of ["T-A", "T-B", "T-U"]) {
      up.emit({ method: "Target.targetCreated", params: { targetInfo: page(t) } });
      up.emit({ method: "Target.targetInfoChanged", params: { targetInfo: page(t, { title: "x" }) } });
      up.emit({ method: "Target.targetCrashed", params: { targetId: t, status: "crashed", errorCode: 1 } });
    }
    up.emit(attachEvent("S-A", page("T-A")));
    // The tab closes in Cophyla before the browser says the page is gone: its end is still the agent's.
    tabs.tabs[0]!.closed = true;
    for (const t of ["T-A", "T-B", "T-U"]) up.emit({ method: "Target.targetDestroyed", params: { targetId: t } });
    const seen = (m: string) => agent.events(m).map((e) => e.params?.targetInfo?.targetId ?? e.params?.targetId);
    expect(seen("Target.targetCreated")).toEqual(["T-A"]);
    expect(seen("Target.targetInfoChanged")).toEqual(["T-A"]);
    expect(seen("Target.targetCrashed")).toEqual(["T-A"]);
    expect(seen("Target.targetDestroyed")).toEqual(["T-A"]);
  });

  test("browser-level events of no target pass as they are", async () => {
    const { up, agent } = await attached();
    up.emit({ method: "Browser.downloadProgress", params: { guid: "g", state: "completed" } });
    expect(agent.events("Browser.downloadProgress")).toHaveLength(1);
  });
});

describe("Target.createTarget opens a tab beside the chat", () => {
  test("it never reaches the browser; the reply comes after the new page has been handed to the agent", async () => {
    const tabs = new FakeTabs();
    const { up, agent, ask } = await attached({ tabs });
    let report!: () => void;
    tabs.onOpen = (session, url) =>
      new Promise((resolve) => {
        const tab = tabs.add(session, undefined, { url, by: "agent" });
        report = () => {
          tabs.change(tab, { target: "T-NEW" });
          resolve(tab as WebTab & { target: string });
        };
      });
    const id = ask("Target.createTarget", { url: "about:blank", browserContextId: undefined });
    expect(tabs.opened).toEqual([{ session: A, url: "about:blank" }]);
    // The browser attaches the new page before the app has reported its target: held.
    up.emit(attachEvent("S-NEW", page("T-NEW", { url: "about:blank" }), true));
    expect(agent.events("Target.attachedToTarget")).toEqual([]);
    report();
    await tick();
    const attachAt = agent.got.findIndex((m) => m.method === "Target.attachedToTarget");
    const replyAt = agent.got.findIndex((m) => m.id === id);
    expect(attachAt).toBeGreaterThanOrEqual(0);
    expect(replyAt).toBeGreaterThan(attachAt);
    expect(agent.reply(id)).toEqual({ id, result: { targetId: "T-NEW" } });
    expect(up.of("Target.createTarget")).toEqual([]);
    expect(up.of("Target.detachFromTarget")).toEqual([]);
  });

  test("an empty address opens a blank tab", async () => {
    const tabs = new FakeTabs();
    const { ask } = await attached({ tabs });
    ask("Target.createTarget", { url: "" });
    ask("Target.createTarget", {});
    await tick();
    expect(tabs.opened.map((o) => o.url)).toEqual(["about:blank", "about:blank"]);
  });

  test("when Cophyla cannot open the tab, the agent gets its reason and nothing reaches the browser", async () => {
    const tabs = new FakeTabs();
    tabs.onOpen = () => Promise.reject(new Error("open Cophyla's desktop app on Desk"));
    const { up, agent, ask } = await attached({ tabs });
    const before = up.sent.length;
    const id = ask("Target.createTarget", { url: "http://localhost:5180/" });
    await tick();
    expect(agent.reply(id)).toEqual({ id, error: { code: -32000, message: "open Cophyla's desktop app on Desk" } });
    expect(up.sent.length).toBe(before);
  });

  test("when the new page's attach was let go before the app reported it, the proxy attaches it and then replies", async () => {
    const tabs = new FakeTabs();
    const { up, agent, ask } = await attached({ tabs, holdMs: 20 });
    let report!: () => void;
    tabs.onOpen = (session) =>
      new Promise((resolve) => {
        const tab = tabs.add(session, undefined, { by: "agent" });
        report = () => {
          tab.target = "T-SLOW";
          resolve(tab as WebTab & { target: string });
        };
      });
    const id = ask("Target.createTarget", { url: "about:blank" });
    up.emit(attachEvent("S-1", page("T-SLOW"), true));
    await sleep(50);
    up.resumed();
    expect(up.last("Target.detachFromTarget").params).toEqual({ sessionId: "S-1" });
    report();
    await tick();
    const own = up.last("Target.attachToTarget");
    expect(own.params).toEqual({ targetId: "T-SLOW", flatten: true });
    expect(agent.reply(id)).toBeUndefined();
    up.emit(attachEvent("S-2", page("T-SLOW")));
    up.answer(own, { sessionId: "S-2" });
    expect(agent.events("Target.attachedToTarget").map((e) => e.params?.sessionId)).toEqual(["S-2"]);
    expect(agent.reply(id)).toEqual({ id, result: { targetId: "T-SLOW" } });
  });

  test("a new page that never reaches the browser fails the request instead of answering a page Playwright cannot find", async () => {
    const tabs = new FakeTabs();
    const { up, agent, ask } = await attached({ tabs, holdMs: 30 });
    tabs.onOpen = async (session) => tabs.add(session, "T-LOST", { by: "agent" }) as WebTab & { target: string };
    const id = ask("Target.createTarget", { url: "about:blank" });
    await tick();
    const own = up.last("Target.attachToTarget");
    up.emit({ id: own.id, error: { code: -32602, message: "No target with given id found" } });
    expect(agent.reply(id)?.error?.message).toBe("No target with given id found");
  });

  test("without browser-level auto-attach the reply is the target at once", async () => {
    const tabs = new FakeTabs();
    tabs.onOpen = async (session) => tabs.add(session, "T-NOW", { by: "agent" }) as WebTab & { target: string };
    const { agent, ask } = await start({ tabs });
    const id = ask("Target.createTarget", { url: "about:blank" });
    await tick();
    expect(agent.reply(id)).toEqual({ id, result: { targetId: "T-NOW" } });
  });

  test("on a session the agent was not given it is refused before any tab opens", async () => {
    const tabs = new FakeTabs();
    const { agent, ask } = await attached({ tabs });
    const id = ask("Target.createTarget", { url: "about:blank" }, "S-NOPE");
    expect(agent.reply(id)?.error?.code).toBe(-32001);
    expect(tabs.opened).toEqual([]);
  });
});

describe("closing", () => {
  test("the agent going closes the browser's socket and stops watching the tabs", async () => {
    const { up, proxy, tabs } = await start();
    expect(tabs.watching).toBe(1);
    proxy.close();
    expect(up.closed).toBe(true);
    expect(tabs.watching).toBe(0);
  });

  test("the browser's socket closing closes the agent's connection", async () => {
    const { up, agent, proxy } = await start();
    up.end("browser gone");
    expect(agent.closed?.code).toBe(1001);
    expect(agent.closed?.reason).toContain("closed");
    proxy.message(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    expect(up.sent).toEqual([]);
  });

  test("held pages are not released after the agent went (the socket's close lets them go)", async () => {
    const { up, proxy } = await attached({ holdMs: 20 });
    up.emit(attachEvent("S-X", page("T-X"), true));
    proxy.close();
    const before = up.sent.length;
    await sleep(40);
    expect(up.sent.length).toBe(before);
  });
});

describe("the default upstream", () => {
  test("connects to the address /json/version gives, on loopback, and carries messages and the close", async () => {
    const got: string[] = [];
    let serverSide: { send(t: string): void; close(): void } | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/json/version") return Response.json({ Browser: "Edg/157", webSocketDebuggerUrl: `ws://localhost:${srv.port}/devtools/browser/abc` });
        if (url.pathname === "/devtools/browser/abc" && srv.upgrade(req)) return undefined;
        return new Response("no", { status: 404 });
      },
      websocket: {
        open(ws) {
          serverSide = ws;
          ws.send(JSON.stringify({ method: "Target.targetCreated", params: {} }));
        },
        message(_ws, m) {
          got.push(String(m));
        },
      },
    });
    try {
      const up = await connectUpstream(server.port!);
      const received: string[] = [];
      let closed: string | undefined;
      await sleep(30);
      up.onMessage((t) => received.push(t));
      up.onClose((r) => (closed = r));
      up.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
      for (let i = 0; i < 100 && got.length === 0; i++) await sleep(10);
      expect(got).toEqual([JSON.stringify({ id: 1, method: "Browser.getVersion" })]);
      expect(received).toEqual([JSON.stringify({ method: "Target.targetCreated", params: {} })]);
      serverSide?.close();
      for (let i = 0; i < 100 && closed === undefined; i++) await sleep(10);
      expect(closed).toBeDefined();
    } finally {
      server.stop(true);
    }
  });

  test("a port with no browser fails", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("no", { status: 404 }) });
    try {
      await expect(connectUpstream(server.port!)).rejects.toThrow("answered 404");
    } finally {
      server.stop(true);
    }
  });
});
