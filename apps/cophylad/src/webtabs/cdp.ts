// The debugging-protocol proxy between one agent's Playwright and the browser that runs the
// desktop app's web tabs. Every tab of every session lives in that one browser, so each agent
// connection gets its own upstream socket to it and sees only its own session's tabs: the
// targets it is told of, the CDP sessions it may use and the commands that reach the browser
// are all filtered here.
//
// Every request the agent sends goes upstream under an id the proxy picks, and its reply comes
// back under the agent's own id; requests the proxy makes itself use the same counter and their
// replies are swallowed. A page the browser attaches at browser level is let through when it is
// one of the session's tabs, and released otherwise: the proxy resumes it if it waits for a
// debugger and detaches from it itself, so another session's new tab never stays paused on this
// agent's auto-attach. A page Cophyla does not know yet (the app has not reported its target) is
// held until it does or until the hold runs out. `Target.createTarget` never reaches the browser,
// where WebView2 would pop a bare window outside the app: it opens a tab beside the session's
// chat, and its reply waits until the new page has been attached for the agent, since
// Playwright looks the page up as soon as the reply comes.

import type { SessionId, WebTab, WebTabId } from "@cophyla/protocol";
import type { Logger } from "../log.ts";

/** What the proxy needs of the web tab registry. */
export interface TabsForProxy {
  /** The open tabs of a session. */
  of(session: SessionId): WebTab[];
  /** Opens a tab for the session's agent; resolves once the app reported its target, rejects with a message (no host, timeout, app error). */
  openForAgent(session: SessionId, url: string): Promise<WebTab & { target: string }>;
  close(id: WebTabId): void;
  /** The session a CDP target is a tab of, if Cophyla knows it as a tab. */
  ownerOf(target: string): SessionId | undefined;
  /** The browser's debugging port the app reported. */
  port(): number | undefined;
  /** Every change of a tab (opened, target known, moved, closed); answers the unsubscribe. */
  watch(fn: (tab: WebTab) => void): () => void;
}

/** The proxy's socket to the browser. */
export interface UpstreamSocket {
  send(text: string): void;
  close(): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: (reason: string) => void): void;
}

/** The agent's side of the connection, as the server hands it over. */
export interface CdpAgent {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

export interface CdpProxyDeps {
  tabs: TabsForProxy;
  session: SessionId;
  /** Opens the socket to the browser on its debugging port; `connectUpstream` by default. */
  upstream?: (port: number) => Promise<UpstreamSocket>;
  log?: Pick<Logger, "debug" | "info" | "warn">;
  /** How long a page Cophyla does not know yet is held before it is released. */
  holdMs?: number;
}

export const CDP_HOLD_MS = 5000;
export const NO_BROWSER = "Cophyla's desktop app has no web tab browser open";
const CONNECT_MS = 5000;

/** Not passed on: each would reach past the session's tabs (a context or a browser-wide session the proxy cannot filter, the protocol handed to a page) or end every session's tabs. */
const REFUSED = new Set([
  "Target.createBrowserContext",
  "Target.disposeBrowserContext",
  "Target.attachToBrowserTarget",
  "Target.exposeDevToolsProtocol",
  "Browser.crash",
  "Browser.crashGpuProcess",
]);

/** Commands whose `targetId` must name one of the session's targets. */
const TARGETED = new Set(["Target.attachToTarget", "Target.activateTarget", "Target.getTargetInfo", "Target.autoAttachRelated"]);

// The browser's own error codes and words, so a target or session of another session looks
// like one that does not exist.
const NO_SESSION = { code: -32001, message: "Session with given id not found." };
const NO_TARGET = { code: -32602, message: "No target with given id found" };
const SERVER_ERROR = -32000;

interface Msg {
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
  sessionId?: string;
}

interface TargetInfo {
  targetId: string;
  type: string;
  [k: string]: unknown;
}

/** A request waiting for its reply from the browser. */
type Pending =
  | { kind: "agent"; msg: Msg; filter?: (result: Record<string, unknown>) => Record<string, unknown>; attaching?: string }
  | { kind: "own"; done?: (reply: Msg) => void };

/** A CDP session the agent may use: a tab of its session, or a frame or worker under one. */
interface Through {
  target: string;
  parent?: string;
}

interface Held {
  msg: Msg;
  target: string;
  waiting: boolean;
  timer: ReturnType<typeof setTimeout>;
}

interface CreateWait {
  reply: () => void;
  fail: (message: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Opens a socket to the browser's debugging port on loopback, at the address its `/json/version` gives. */
export async function connectUpstream(port: number): Promise<UpstreamSocket> {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(CONNECT_MS) });
  if (!res.ok) throw new Error(`the web tab browser's port answered ${res.status}`);
  const version = (await res.json()) as { webSocketDebuggerUrl?: unknown };
  if (typeof version.webSocketDebuggerUrl !== "string") throw new Error("the web tab browser gave no debugging address");
  // Only the path is taken, so the socket goes to the same loopback port whatever host the browser names.
  const url = `ws://127.0.0.1:${port}${new URL(version.webSocketDebuggerUrl).pathname}`;
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("the web tab browser's socket did not open"));
      ws.close();
    }, CONNECT_MS);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("close", () => {
      clearTimeout(timer);
      reject(new Error("the web tab browser refused the socket"));
    });
  });
  return wrapSocket(ws);
}

/** A WebSocket as an `UpstreamSocket`; what arrives before a listener is set waits for it. */
function wrapSocket(ws: WebSocket): UpstreamSocket {
  let onMessage: ((text: string) => void) | undefined;
  let onClose: ((reason: string) => void) | undefined;
  const early: string[] = [];
  let closedWith: string | undefined;
  const decoder = new TextDecoder();
  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", (ev) => {
    const text = typeof ev.data === "string" ? ev.data : decoder.decode(ev.data as ArrayBuffer);
    if (onMessage) onMessage(text);
    else early.push(text);
  });
  ws.addEventListener("close", (ev) => {
    closedWith = ev.reason || `closed (${ev.code})`;
    onClose?.(closedWith);
  });
  return {
    send: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    },
    close: () => ws.close(),
    onMessage: (cb) => {
      onMessage = cb;
      for (const text of early.splice(0)) cb(text);
    },
    onClose: (cb) => {
      onClose = cb;
      if (closedWith !== undefined) cb(closedWith);
    },
  };
}

export class CdpProxy {
  private deps: CdpProxyDeps;
  private holdMs: number;
  private agent?: CdpAgent;
  private up?: UpstreamSocket;
  /** What the agent sent before the browser's socket opened. */
  private early: string[] = [];
  private ended = false;
  private unwatch?: () => void;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** The CDP sessions the agent may use. */
  private through = new Map<string, Through>();
  /** Each of the session's pages and the browser-level CDP session it was let through on, so the same page is never handed over twice. */
  private pages = new Map<string, string>();
  /** Browser-level attaches waiting for Cophyla to know their page, by CDP session. */
  private held = new Map<string, Held>();
  /** CDP sessions the proxy detached itself; their `detachedFromTarget` is not the agent's. */
  private released = new Set<string>();
  /** Pages released at browser level, attached again if they turn out to be the session's after all. */
  private dropped = new Set<string>();
  /** Targets ever let through as the session's, so their end is told even once the tab is gone. */
  private ownEver = new Set<string>();
  /** The agent's own `Target.attachToTarget` in flight, by target: their attach is the agent's even for a page it already has. */
  private explicit = new Map<string, number>();
  /** Pages the proxy is attaching itself. */
  private attaching = new Set<string>();
  /** `Target.createTarget` replies waiting for their page to be attached, by target. */
  private creates = new Map<string, CreateWait[]>();
  /** Whether the agent set browser-level auto-attach, so new pages reach it. */
  private autoAttach = false;

  constructor(deps: CdpProxyDeps) {
    this.deps = deps;
    this.holdMs = deps.holdMs ?? CDP_HOLD_MS;
  }

  /** The agent connected: opens the browser's socket, or closes the agent's when there is no browser. */
  async open(agent: CdpAgent): Promise<void> {
    if (this.ended || this.agent) return;
    this.agent = agent;
    const port = this.deps.tabs.port();
    if (port === undefined) {
      this.deps.log?.info("an agent's browser connection was refused: no web tab browser", { session: this.deps.session });
      this.end(1011, NO_BROWSER);
      return;
    }
    let up: UpstreamSocket;
    try {
      up = await (this.deps.upstream ?? connectUpstream)(port);
    } catch (e) {
      this.deps.log?.warn("the web tab browser did not answer", { session: this.deps.session, port, error: e instanceof Error ? e.message : String(e) });
      this.end(1011, "Cophyla's web tab browser did not answer");
      return;
    }
    if (this.ended) {
      up.close();
      return;
    }
    this.up = up;
    up.onMessage((text) => this.fromBrowser(text));
    up.onClose((reason) => {
      this.up = undefined;
      this.deps.log?.debug("the web tab browser closed an agent's connection", { session: this.deps.session, reason });
      this.end(1001, "Cophyla's web tab browser closed");
    });
    this.unwatch = this.deps.tabs.watch((tab) => this.tabChanged(tab));
    this.deps.log?.debug("an agent's browser connection opened", { session: this.deps.session, port });
    for (const text of this.early.splice(0)) this.fromAgent(text);
  }

  /** A message from the agent. */
  message(text: string): void {
    if (this.ended) return;
    if (!this.up) this.early.push(text);
    else this.fromAgent(text);
  }

  /** The agent's connection closed. */
  close(): void {
    if (this.ended) return;
    this.agent = undefined;
    this.end();
  }

  /** Ends both sides, the agent's with the code and reason given. */
  private end(code?: number, reason?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.unwatch?.();
    this.unwatch = undefined;
    for (const h of this.held.values()) clearTimeout(h.timer);
    this.held.clear();
    for (const waits of this.creates.values()) for (const w of waits) clearTimeout(w.timer);
    this.creates.clear();
    this.pending.clear();
    this.early = [];
    const up = this.up;
    this.up = undefined;
    up?.close();
    const agent = this.agent;
    this.agent = undefined;
    agent?.close(code, reason);
  }

  // Agent to browser.

  private fromAgent(text: string): void {
    let msg: Msg;
    try {
      msg = JSON.parse(text) as Msg;
    } catch {
      this.toAgent({ error: { code: -32700, message: "Message must be a valid JSON" } });
      return;
    }
    if (typeof msg !== "object" || msg === null || msg.id === undefined) {
      this.deps.log?.debug("an agent's message without an id was dropped", { session: this.deps.session });
      return;
    }
    if (typeof msg.method !== "string") {
      this.fail(msg, { code: -32600, message: "Message must have string 'method' property" });
      return;
    }
    if (msg.sessionId !== undefined && !this.through.has(msg.sessionId)) {
      this.fail(msg, NO_SESSION);
      return;
    }
    const params = msg.params ?? {};
    const method = msg.method;
    if (REFUSED.has(method)) {
      this.fail(msg, { code: SERVER_ERROR, message: `${method} is not supported in Cophyla's web tab` });
      return;
    }
    switch (method) {
      case "Target.createTarget":
        this.createTarget(msg, typeof params.url === "string" && params.url !== "" ? params.url : "about:blank");
        return;
      case "Target.closeTarget": {
        const tab = this.deps.tabs.of(this.deps.session).find((t) => t.target !== undefined && t.target === params.targetId && !t.closed);
        if (!tab) {
          this.fail(msg, NO_TARGET);
          return;
        }
        this.deps.tabs.close(tab.id);
        this.reply(msg, { success: true });
        return;
      }
      case "Target.getTargets":
        this.forward(msg, {
          filter: (result) => ({ ...result, targetInfos: Array.isArray(result.targetInfos) ? (result.targetInfos as TargetInfo[]).filter((t) => this.mine(t.targetId)) : [] }),
        });
        return;
      case "Target.detachFromTarget": {
        const ok = typeof params.sessionId === "string" ? this.through.has(params.sessionId) : typeof params.targetId === "string" && this.mine(params.targetId);
        if (!ok) {
          this.fail(msg, typeof params.sessionId === "string" ? NO_SESSION : NO_TARGET);
          return;
        }
        this.forward(msg);
        return;
      }
      case "Target.sendMessageToTarget":
        if (typeof params.sessionId !== "string" || !this.through.has(params.sessionId)) {
          this.fail(msg, NO_SESSION);
          return;
        }
        this.forward(msg);
        return;
      case "Browser.close":
        // The browser holds every session's tabs and the user's: only this agent goes.
        this.reply(msg, {});
        this.deps.log?.debug("an agent closed its browser connection with Browser.close", { session: this.deps.session });
        this.end(1000, "Browser.close: Cophyla's web tabs stay open");
        return;
    }
    if (TARGETED.has(method) && params.targetId !== undefined) {
      if (typeof params.targetId !== "string" || !this.mine(params.targetId)) {
        this.fail(msg, NO_TARGET);
        return;
      }
      if (method === "Target.attachToTarget" && msg.sessionId === undefined) {
        this.explicit.set(params.targetId, (this.explicit.get(params.targetId) ?? 0) + 1);
        this.forward(msg, { attaching: params.targetId });
        return;
      }
    }
    if (method === "Target.setAutoAttach" && msg.sessionId === undefined) this.autoAttach = params.autoAttach === true;
    this.forward(msg);
  }

  /** Opens a tab beside the session's chat for the agent; the reply waits until its page is the agent's. */
  private createTarget(msg: Msg, url: string): void {
    this.deps.tabs.openForAgent(this.deps.session, url).then(
      (tab) => {
        if (this.ended) return;
        const target = tab.target;
        this.ownEver.add(target);
        if (!this.autoAttach || this.pages.has(target)) {
          this.reply(msg, { targetId: target });
          return;
        }
        const wait: CreateWait = {
          reply: () => this.reply(msg, { targetId: target }),
          fail: (message) => this.fail(msg, { code: SERVER_ERROR, message }),
          timer: setTimeout(() => this.settleCreates(target, "the new web tab did not reach the browser in time"), this.holdMs),
        };
        const waits = this.creates.get(target) ?? [];
        waits.push(wait);
        this.creates.set(target, waits);
        // Its attach may be held, waiting for Cophyla to know it: now it does.
        for (const [sid, h] of [...this.held]) if (h.target === target) this.settle(sid, false);
        if (this.pages.has(target)) return;
        // Its attach was released before the app reported it, or never came: attach it here.
        if (!this.isHeld(target)) this.attachOwn(target);
      },
      (e: unknown) => {
        if (this.ended) return;
        this.fail(msg, { code: SERVER_ERROR, message: e instanceof Error ? e.message : String(e) });
      },
    );
  }

  /** Answers the `Target.createTarget` replies waiting on a page: done, or failed with the message. */
  private settleCreates(target: string, failure?: string): void {
    const waits = this.creates.get(target);
    if (!waits) return;
    this.creates.delete(target);
    for (const w of waits) {
      clearTimeout(w.timer);
      if (failure === undefined) w.reply();
      else w.fail(failure);
    }
  }

  /** Attaches a page of the session's at browser level for the agent, as auto-attach would have. */
  private attachOwn(target: string): void {
    if (this.attaching.has(target) || this.pages.has(target)) return;
    this.attaching.add(target);
    this.sendOwn("Target.attachToTarget", { targetId: target, flatten: true }, undefined, (reply) => {
      this.attaching.delete(target);
      if (reply.error) this.settleCreates(target, reply.error.message ?? "the new web tab could not be attached");
      else if (!this.pages.has(target)) this.settleCreates(target, "the new web tab is not this session's");
    });
  }

  private forward(msg: Msg, extra: { filter?: (result: Record<string, unknown>) => Record<string, unknown>; attaching?: string } = {}): void {
    const id = this.nextId++;
    this.pending.set(id, { kind: "agent", msg, ...extra });
    this.up?.send(JSON.stringify({ ...msg, id }));
  }

  private sendOwn(method: string, params: Record<string, unknown>, sessionId?: string, done?: (reply: Msg) => void): void {
    const id = this.nextId++;
    this.pending.set(id, { kind: "own", done });
    this.up?.send(JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }));
  }

  private reply(msg: Msg, result: Record<string, unknown>): void {
    this.toAgent(msg.sessionId === undefined ? { id: msg.id, result } : { id: msg.id, result, sessionId: msg.sessionId });
  }

  private fail(msg: Msg, error: { code: number; message: string }): void {
    this.toAgent(msg.sessionId === undefined ? { id: msg.id, error } : { id: msg.id, error, sessionId: msg.sessionId });
  }

  private toAgent(msg: Msg): void {
    this.agent?.send(JSON.stringify(msg));
  }

  // Browser to agent.

  private fromBrowser(text: string): void {
    if (this.ended) return;
    let msg: Msg;
    try {
      msg = JSON.parse(text) as Msg;
    } catch {
      return;
    }
    if (typeof msg.id === "number" && msg.method === undefined) {
      this.replyFromBrowser(msg.id, msg);
      return;
    }
    if (typeof msg.method !== "string") return;
    const params = msg.params ?? {};
    if (msg.sessionId !== undefined) {
      if (!this.through.has(msg.sessionId)) return;
      if (msg.method === "Target.attachedToTarget" && typeof params.sessionId === "string") {
        // A frame or worker of the agent's own page.
        this.through.set(params.sessionId, { target: (params.targetInfo as TargetInfo | undefined)?.targetId ?? "", parent: msg.sessionId });
      } else if (msg.method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
        this.forget(params.sessionId);
      }
      this.toAgent(msg);
      return;
    }
    switch (msg.method) {
      case "Target.attachedToTarget":
        this.attached(msg);
        return;
      case "Target.detachedFromTarget": {
        const sid = typeof params.sessionId === "string" ? params.sessionId : "";
        const h = this.held.get(sid);
        if (h) {
          clearTimeout(h.timer);
          this.held.delete(sid);
          return;
        }
        if (this.released.delete(sid)) return;
        if (!this.through.has(sid)) return;
        this.forget(sid);
        this.toAgent(msg);
        return;
      }
      case "Target.targetCreated":
      case "Target.targetInfoChanged": {
        const info = params.targetInfo as TargetInfo | undefined;
        if (info && (this.mine(info.targetId) || this.ownEver.has(info.targetId))) this.toAgent(msg);
        return;
      }
      case "Target.targetDestroyed":
      case "Target.targetCrashed": {
        const target = typeof params.targetId === "string" ? params.targetId : "";
        if (this.mine(target) || this.ownEver.has(target)) this.toAgent(msg);
        if (msg.method === "Target.targetDestroyed") {
          this.ownEver.delete(target);
          this.dropped.delete(target);
        }
        return;
      }
      case "Target.receivedMessageFromTarget":
        if (typeof params.sessionId === "string" && this.through.has(params.sessionId)) this.toAgent(msg);
        return;
    }
    this.toAgent(msg);
  }

  private replyFromBrowser(id: number, msg: Msg): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (p.kind === "own") {
      p.done?.(msg);
      return;
    }
    if (p.attaching !== undefined && msg.error) this.unexplicit(p.attaching);
    const out: Msg = { id: p.msg.id };
    if (msg.error) out.error = msg.error;
    else out.result = p.filter && msg.result ? p.filter(msg.result) : (msg.result ?? {});
    if (msg.sessionId !== undefined) out.sessionId = msg.sessionId;
    this.toAgent(out);
  }

  /** A target the browser attached at browser level. */
  private attached(msg: Msg): void {
    const params = msg.params ?? {};
    const sid = params.sessionId;
    const info = params.targetInfo as TargetInfo | undefined;
    if (typeof sid !== "string" || !info || typeof info.targetId !== "string") return;
    const waiting = params.waitingForDebugger === true;
    // The agent's own Target.attachToTarget, for a target it was allowed to name.
    if ((this.explicit.get(info.targetId) ?? 0) > 0) {
      this.letThrough(msg, sid, info.targetId);
      return;
    }
    if (info.type !== "page") {
      this.release(sid, info.targetId, waiting, false);
      return;
    }
    const owner = this.deps.tabs.ownerOf(info.targetId);
    if (owner === this.deps.session) this.letThrough(msg, sid, info.targetId);
    else if (owner !== undefined) this.release(sid, info.targetId, waiting, true);
    else {
      this.deps.log?.debug("a page Cophyla does not know yet is held", { session: this.deps.session, target: info.targetId });
      this.held.set(sid, { msg, target: info.targetId, waiting, timer: setTimeout(() => this.settle(sid, true), this.holdMs) });
    }
  }

  /** Looks again at a held attach: let through once Cophyla knows the page as the session's, released once it knows it as another's or the hold ran out. */
  private settle(sid: string, final: boolean): void {
    const h = this.held.get(sid);
    if (!h) return;
    const owner = this.deps.tabs.ownerOf(h.target);
    if (owner === undefined && !final) return;
    clearTimeout(h.timer);
    this.held.delete(sid);
    if (owner === this.deps.session) this.letThrough(h.msg, sid, h.target);
    else this.release(sid, h.target, h.waiting, true);
  }

  private letThrough(msg: Msg, sid: string, target: string): void {
    const asked = (this.explicit.get(target) ?? 0) > 0;
    if (asked) this.unexplicit(target);
    else if (this.pages.has(target)) {
      // The same page attached again (auto-attach and the proxy's own attach crossing): Playwright takes a page once.
      this.release(sid, target, msg.params?.waitingForDebugger === true, false);
      return;
    }
    if (!this.pages.has(target)) this.pages.set(target, sid);
    this.through.set(sid, { target });
    this.ownEver.add(target);
    this.dropped.delete(target);
    this.toAgent(msg);
    this.settleCreates(target);
  }

  /**
   * Lets a target go that is not the agent's: resumed if it waits for a debugger, then detached,
   * by the proxy itself. The detach waits for the resume's reply: a shared worker detached right
   * after the resume was sent drops the resume and stays paused (seen in WebView2).
   */
  private release(sid: string, target: string, waiting: boolean, page: boolean): void {
    this.deps.log?.debug("a target that is not the session's was released", { session: this.deps.session, target });
    this.released.add(sid);
    if (page && !this.pages.has(target)) this.dropped.add(target);
    const detach = () => this.sendOwn("Target.detachFromTarget", { sessionId: sid });
    if (waiting) this.sendOwn("Runtime.runIfWaitingForDebugger", {}, sid, detach);
    else detach();
  }

  private unexplicit(target: string): void {
    const n = (this.explicit.get(target) ?? 0) - 1;
    if (n > 0) this.explicit.set(target, n);
    else this.explicit.delete(target);
  }

  /** Forgets a CDP session and the ones under it. */
  private forget(sid: string): void {
    const t = this.through.get(sid);
    if (!t) return;
    this.through.delete(sid);
    if (this.pages.get(t.target) === sid) this.pages.delete(t.target);
    for (const [child, c] of [...this.through]) if (c.parent === sid) this.forget(child);
  }

  private isHeld(target: string): boolean {
    for (const h of this.held.values()) if (h.target === target) return true;
    return false;
  }

  /** Whether a target is the session's: one of its tabs, or a frame or worker the agent is attached to under one. */
  private mine(target: string): boolean {
    if (this.deps.tabs.ownerOf(target) === this.deps.session) return true;
    for (const t of this.through.values()) if (t.target === target) return true;
    return false;
  }

  /** A tab changed: held attaches are looked at again, a page that moved to another session is taken from the agent, and one of the session's it was not given is attached. */
  private tabChanged(tab: WebTab): void {
    if (this.ended) return;
    for (const sid of [...this.held.keys()]) this.settle(sid, false);
    const target = tab.target;
    if (target === undefined || tab.closed) return;
    if (tab.session !== this.deps.session) {
      const sid = this.pages.get(target);
      if (sid !== undefined) {
        this.deps.log?.debug("a page moved to another session and was taken from the agent", { session: this.deps.session, target });
        this.dropped.add(target);
        this.sendOwn("Target.detachFromTarget", { sessionId: sid });
      }
      return;
    }
    if (this.autoAttach && this.dropped.has(target) && !this.pages.has(target) && !this.isHeld(target)) {
      this.dropped.delete(target);
      this.attachOwn(target);
    }
  }
}
