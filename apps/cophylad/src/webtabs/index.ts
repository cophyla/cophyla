// Web tabs: web pages open in tabs of the desktop app, beside an agent's chat, on the machine the
// agent runs on. The user opens one from the view (`webtab.open`), or the agent's Playwright does,
// through the debugging endpoint Cophyla gives the sessions it starts (`cdp.ts`); either way the
// tab is the session's, and that session's Playwright drives it. The tabs are kept here, in memory;
// the desktop app on this machine opens each in its browser and says how it is (`webtab.report`).
// That app is the client whose hello said `webTabs` on loopback: with none there is nowhere to
// open a tab, and when it goes every tab goes with it, since its browser held them. Only sessions
// of this machine have tabs for now: an agent elsewhere would want its own machine's localhost.

import { newId, RpcError } from "@cophyla/protocol";
import type { ClientId, SessionId, WebTab, WebTabId } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import type { Logger } from "../log.ts";
import type { TabsForProxy } from "./cdp.ts";

/** The most tabs one session keeps open, and all sessions together. */
export const TABS_PER_SESSION = 12;
export const TABS_MAX = 40;
/** How long an agent's new tab waits for the desktop app to open it. */
export const TARGET_WAIT_MS = 15_000;

/** What a page may be: http or https, or the blank page. */
export function webTabUrl(raw: string | undefined): string {
  const text = (raw ?? "").trim();
  if (text === "" || text === "about:blank") return "about:blank";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new RpcError("invalid", "a web tab opens an http or https address");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") throw new RpcError("invalid", "a web tab opens an http or https address");
  if (url.username !== "" || url.password !== "") throw new RpcError("invalid", "a web tab's address carries no password");
  return url.href;
}

export interface WebTabsDeps {
  bus: Pick<Bus, "emit">;
  /** Why a session cannot have a tab here, or undefined when it can: it runs on this machine. */
  refuse: (session: SessionId) => string | undefined;
  /** This machine's name, for what the user is told. */
  machine: () => string;
  log: Logger;
  now?: () => number;
  targetWaitMs?: number;
}

type Waiter = { resolve: (tab: WebTab & { target: string }) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

/** What the desktop app says of a tab (`webtab.report`). */
export interface TabReport {
  id: WebTabId;
  target?: string;
  port?: number;
  url?: string;
  title?: string;
  loading?: boolean;
  gone?: true;
  error?: string;
}

export class WebTabs implements TabsForProxy {
  private deps: WebTabsDeps;
  private tabs = new Map<WebTabId, WebTab>();
  private host?: ClientId;
  private debugPort?: number;
  private waiting = new Map<WebTabId, Waiter[]>();
  private watchers = new Set<(tab: WebTab) => void>();

  constructor(deps: WebTabsDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The desktop app that opens the tabs connected (its hello said `webTabs`). */
  hostConnected(client: ClientId): void {
    this.host = client;
    this.deps.log.info("web tabs: the desktop app opens them", { client });
  }

  /** Whether a desktop app here opens tabs. */
  get hosted(): boolean {
    return this.host !== undefined;
  }

  /** A client went: if it was the app that opened the tabs, every tab is gone with its browser. */
  clientGone(client: ClientId): void {
    if (client !== this.host) return;
    this.host = undefined;
    this.debugPort = undefined;
    for (const id of [...this.tabs.keys()]) this.drop(id, "Cophyla's desktop app closed");
  }

  /** The open tabs, every session's, oldest first. */
  list(): WebTab[] {
    return [...this.tabs.values()];
  }

  of(session: SessionId): WebTab[] {
    return this.list().filter((t) => t.session === session);
  }

  /** Opens a tab for a session: the desktop app hears of it and opens it in its browser. */
  open(session: SessionId, rawUrl: string | undefined, by: WebTab["by"]): WebTab {
    const why = this.deps.refuse(session);
    if (why) throw new RpcError("unsupported", why);
    if (!this.host) throw new RpcError("unavailable", `open Cophyla's desktop app on ${this.deps.machine()}: web tabs open in it`);
    const url = webTabUrl(rawUrl);
    if (this.of(session).length >= TABS_PER_SESSION) throw new RpcError("quota_exceeded", `a session keeps at most ${TABS_PER_SESSION} web tabs open: close one first`);
    if (this.tabs.size >= TABS_MAX) throw new RpcError("quota_exceeded", `at most ${TABS_MAX} web tabs are open at once: close one first`);
    const tab: WebTab = { id: newId("webTab", this.now()) as WebTabId, session, url, by, at: this.now() };
    this.tabs.set(tab.id, tab);
    this.changed(tab);
    return tab;
  }

  openForAgent(session: SessionId, url: string): Promise<WebTab & { target: string }> {
    let tab: WebTab;
    try {
      tab = this.open(session, url, "agent");
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    return this.target(tab.id);
  }

  /** The tab once the desktop app has opened it, with its id in the browser's debugging protocol. */
  target(id: WebTabId): Promise<WebTab & { target: string }> {
    const tab = this.tabs.get(id);
    if (!tab) return Promise.reject(new Error("that web tab is closed"));
    if (tab.target !== undefined) return Promise.resolve(tab as WebTab & { target: string });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.unwait(id, waiter);
        reject(new Error(`Cophyla's desktop app did not open the web tab within ${Math.round((this.deps.targetWaitMs ?? TARGET_WAIT_MS) / 1000)} s`));
      }, this.deps.targetWaitMs ?? TARGET_WAIT_MS);
      const waiter: Waiter = { resolve, reject, timer };
      this.waiting.set(id, [...(this.waiting.get(id) ?? []), waiter]);
    });
  }

  private unwait(id: WebTabId, waiter: Waiter): void {
    const rest = (this.waiting.get(id) ?? []).filter((w) => w !== waiter);
    if (rest.length > 0) this.waiting.set(id, rest);
    else this.waiting.delete(id);
  }

  close(id: WebTabId): void {
    this.drop(id, "the web tab was closed");
  }

  private drop(id: WebTabId, why: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.tabs.delete(id);
    for (const w of this.waiting.get(id) ?? []) {
      clearTimeout(w.timer);
      w.reject(new Error(why));
    }
    this.waiting.delete(id);
    this.changed({ ...tab, closed: true });
  }

  /** What the desktop app says of a tab; only that app may say it. */
  report(client: ClientId, r: TabReport): void {
    if (client !== this.host) throw new RpcError("denied", "only the desktop app that opens the web tabs reports them");
    if (r.port !== undefined) this.debugPort = r.port;
    const tab = this.tabs.get(r.id);
    if (!tab) return;
    if (r.gone) {
      if (r.error) this.deps.log.warn("web tabs: the app could not keep a tab", { tab: r.id, error: r.error });
      this.drop(r.id, r.error ? `the web tab could not open: ${r.error}` : "the web tab was closed");
      return;
    }
    const next: WebTab = {
      ...tab,
      ...(r.target !== undefined ? { target: r.target } : {}),
      ...(r.url !== undefined ? { url: r.url } : {}),
      ...(r.title !== undefined ? { title: r.title } : {}),
      ...(r.loading !== undefined ? { loading: r.loading } : {}),
    };
    if (JSON.stringify(next) === JSON.stringify(tab)) return;
    this.tabs.set(r.id, next);
    this.changed(next);
    if (next.target !== undefined) {
      for (const w of this.waiting.get(r.id) ?? []) {
        clearTimeout(w.timer);
        w.resolve(next as WebTab & { target: string });
      }
      this.waiting.delete(r.id);
    }
  }

  ownerOf(target: string): SessionId | undefined {
    for (const t of this.tabs.values()) if (t.target === target) return t.session;
    return undefined;
  }

  port(): number | undefined {
    return this.debugPort;
  }

  watch(fn: (tab: WebTab) => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  private changed(tab: WebTab): void {
    this.deps.bus.emit("webtab.state", tab);
    for (const fn of this.watchers) {
      try {
        fn(tab);
      } catch (e) {
        this.deps.log.warn("web tabs: a watcher failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
}
