// Web tabs in the desktop app: web pages beside agents' chats, which the agents' Playwright
// drives, on Windows for now. cophylad keeps the tabs (`webtab.*`) and this host, the one that
// said `webTabs` in its hello, opens them in the shell (webtab.rs): it reads them after each
// welcome (`webtab.list`) and as they change (`webtab.state`); a tab not closed and not open
// here opens, and cophylad hears where (`webtab.report` with its id in the browser's debugging
// protocol and the browser's port), or that it could not (`gone`, with why); a tab cophylad
// closed closes. What the shell says of a tab goes on to cophylad as it changes: its address,
// title and whether it loads, and that it went (the page closed itself, or its browser ended); a
// window its page asked for opens as another tab of the same session (`webtab.open`). The view
// shows a tab over a box it keeps for it (`host.webtab {op: "place"}`, in the frame's
// coordinates, kept inside the frame, or hidden), and takes it to a page, back, forward,
// reloads it or opens its DevTools. Nothing of the host page can be drawn over a tab, so the
// tabs hide while the host's own layers are open (the picker, the settings) and come back where
// they were; when the view's document goes they hide until it places them again, since they are
// the sessions', not the view's. When the link to cophylad goes every tab closes, as cophylad
// closes them.

import { WEB_TAB_URL_MAX, WebTab, WebTabId } from "@cophyla/protocol";
import { windowPlace } from "@cophyla/viewhost";
import type { Box, Place } from "@cophyla/viewhost";

/** What the host needs of the shell and the link. */
export interface WebTabsDeps {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  request: (method: string, params: unknown) => Promise<unknown>;
  /** Where the view's frame is in the host page, which a place is given relative to. */
  frame?: () => Box | undefined;
  log?: (message: string) => void;
}

/** Whether this host opens web tabs: the desktop app on Windows, whose shell has them. */
export function webTabsHere(platform: string = globalThis.navigator?.platform ?? ""): boolean {
  return /^Win/.test(platform);
}

/** What the shell says of a tab (`webtab:state`). */
export interface ShellState {
  tab: string;
  url?: string;
  title?: string;
  loading?: boolean;
}

/** What `webtab_open` answers: where the tabs' browser listens, and the tab's id there. */
interface Opened {
  port: number;
  target: string;
}

/** The longest title cophylad takes. */
const TITLE_MAX = 500;
/** The longest error cophylad takes. */
const ERROR_MAX = 300;
/** How many closed tabs are remembered, so a list a moment old does not open one again. */
const GONE_KEPT = 500;

export type WebTabOp = "place" | "go" | "back" | "forward" | "reload" | "devtools";
const OPS: readonly WebTabOp[] = ["place", "go", "back", "forward", "reload", "devtools"];

/** What a view's `host.webtab` asks, once it is well formed. */
export type WebTabAsk = { op: "place"; tab: string; rect: Place | null } | { op: "go"; tab: string; url: string } | { op: "back" | "forward" | "reload" | "devtools"; tab: string };

/** The page a tab may go to: an http or https one with a host, or the blank page. */
export function webPage(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > WEB_TAB_URL_MAX) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.href === "about:blank") return url.href;
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") return undefined;
  return url.href.length <= WEB_TAB_URL_MAX ? url.href : undefined;
}

/** What a view's `host.webtab` asks, or why it is refused. */
export function webTabOf(params: unknown): WebTabAsk | { refuse: string } {
  const p = (params ?? {}) as { op?: unknown; tab?: unknown; rect?: unknown; url?: unknown };
  if (typeof p.op !== "string" || !(OPS as readonly string[]).includes(p.op)) return { refuse: `host.webtab needs an op: ${OPS.join(", ")}` };
  if (!WebTabId.safeParse(p.tab).success) return { refuse: "host.webtab needs a tab" };
  const tab = p.tab as string;
  const op = p.op as WebTabOp;
  if (op === "place") {
    if (p.rect === null) return { op, tab, rect: null };
    const r = (p.rect ?? {}) as Record<string, unknown>;
    const n = [r["x"], r["y"], r["width"], r["height"]];
    if (!n.every((v) => typeof v === "number" && Number.isFinite(v))) return { refuse: "a place needs a rect, or null" };
    const [x, y, width, height] = n as number[];
    return { op, tab, rect: { x: x!, y: y!, width: width!, height: height! } };
  }
  if (op === "go") {
    const url = webPage(p.url);
    if (!url) return { refuse: "only a web page opens in a web tab" };
    return { op, tab, url };
  }
  return { op, tab };
}

/** A tab cophylad keeps that this host holds: opening, or open in the shell. */
interface Held {
  tab: WebTab;
  /** Whether the shell opened it, once it said. */
  opened: Promise<boolean>;
  open: boolean;
  /** Where the view placed it (`null`: hidden, as it opens). */
  rect: Place | null;
  /** What cophylad was last told of it, so the shell saying the same again is not told on. */
  told: { url?: string; title?: string; loading?: boolean };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The web tabs this host holds, in step with cophylad's. */
export class WebTabs {
  private deps: WebTabsDeps;
  private tabs = new Map<string, Held>();
  /** Tabs cophylad closed, or this host could not keep, newest last. */
  private gone = new Set<string>();
  /** The host's own layers are open: every tab is hidden meanwhile. */
  private covered = false;
  /** Counts the link's losses, so a list asked before one is passed over. */
  private links = 0;

  constructor(deps: WebTabsDeps) {
    this.deps = deps;
  }

  /** The tabs open here, or opening. */
  get ids(): string[] {
    return [...this.tabs.keys()];
  }

  /** A view's `host.webtab`. */
  readonly host = async (method: string, params: unknown): Promise<unknown> => {
    if (method !== "host.webtab") throw new Error(`no ${method}`);
    const ask = webTabOf(params);
    if ("refuse" in ask) throw new Error(ask.refuse);
    const held = this.tabs.get(ask.tab);
    if (!held) throw new Error("no such web tab here");
    if (ask.op === "place") {
      held.rect = ask.rect;
      if (held.open) await this.apply(ask.tab, held);
      return {};
    }
    if (!(await held.opened)) throw new Error("the web tab did not open");
    await this.deps.invoke("webtab_go", ask.op === "go" ? { tab: ask.tab, url: ask.url } : { tab: ask.tab, action: ask.op });
    return {};
  };

  /** A notification from cophylad: a tab's `webtab.state`. */
  onNotification(frame: { method: string; params?: unknown }): void {
    if (frame.method !== "webtab.state") return;
    const tab = WebTab.safeParse(frame.params);
    if (tab.success) this.follow(tab.data);
  }

  /** The link is up again, on a new client: the tabs as cophylad keeps them now. */
  async welcome(): Promise<void> {
    const at = this.links;
    let tabs: WebTab[];
    try {
      tabs = ((await this.deps.request("webtab.list", {})) as { tabs: WebTab[] }).tabs;
    } catch (e) {
      this.deps.log?.(`web tabs: ${message(e)}`);
      return;
    }
    if (at !== this.links) return;
    for (const t of tabs) {
      const tab = WebTab.safeParse(t);
      if (tab.success) this.follow(tab.data);
    }
  }

  /** A tab as cophylad says it is: opened here when it is not, closed when cophylad closed it. */
  private follow(tab: WebTab): void {
    const held = this.tabs.get(tab.id);
    if (tab.closed) {
      this.forget(tab.id);
      if (held?.open) this.close(tab.id);
      return;
    }
    if (held) {
      held.tab = tab;
      return;
    }
    if (this.gone.has(tab.id)) return;
    this.open(tab);
  }

  private open(tab: WebTab): void {
    const id = tab.id;
    let settle!: (open: boolean) => void;
    const held: Held = { tab, opened: new Promise<boolean>((resolve) => (settle = resolve)), open: false, rect: null, told: {} };
    this.tabs.set(id, held);
    this.deps.invoke<Opened>("webtab_open", { tab: id, url: tab.url }).then(
      (o) => {
        // closed, or the link lost, while it opened: it goes again
        if (this.tabs.get(id) !== held) {
          this.close(id);
          settle(false);
          return;
        }
        held.open = true;
        settle(true);
        this.report({ id, target: o.target, port: o.port });
        if (held.rect) void this.apply(id, held).catch((e: unknown) => this.deps.log?.(`the web tab did not show: ${message(e)}`));
      },
      (e: unknown) => {
        settle(false);
        if (this.tabs.get(id) !== held) return;
        this.forget(id);
        this.report({ id, gone: true, error: message(e).slice(0, ERROR_MAX) });
      },
    );
  }

  /** A tab this host no longer holds, and does not open again. */
  private forget(id: string): void {
    this.tabs.delete(id);
    this.gone.delete(id);
    this.gone.add(id);
    if (this.gone.size > GONE_KEPT) this.gone.delete(this.gone.values().next().value!);
  }

  private close(id: string): void {
    void this.deps.invoke("webtab_close", { tab: id }).catch((e: unknown) => this.deps.log?.(`the web tab did not close: ${message(e)}`));
  }

  private report(params: Record<string, unknown>): void {
    this.deps.request("webtab.report", params).catch((e: unknown) => this.deps.log?.(`cophylad did not hear of the web tab: ${message(e)}`));
  }

  /** Puts a tab where the view placed it, or hides it. */
  private async apply(id: string, held: Held): Promise<void> {
    const frame = this.deps.frame?.();
    const at = held.rect && !this.covered && frame ? windowPlace(held.rect, frame) : undefined;
    await this.deps.invoke("webtab_place", at ? { tab: id, ...at } : { tab: id, hidden: true });
  }

  private applyAll(why: string): void {
    for (const [id, held] of this.tabs) {
      if (held.open) void this.apply(id, held).catch((e: unknown) => this.deps.log?.(`the web tab did not ${why}: ${message(e)}`));
    }
  }

  /** The shell's word on a tab (`webtab:state`): what changed goes on to cophylad. */
  shellState(s: ShellState): void {
    const held = this.tabs.get(s.tab);
    if (!held) return;
    const told = held.told;
    const params: Record<string, unknown> = {};
    if (typeof s.url === "string" && s.url.length <= WEB_TAB_URL_MAX && s.url !== told.url) params["url"] = told.url = s.url;
    if (typeof s.title === "string") {
      const title = s.title.slice(0, TITLE_MAX);
      if (title !== told.title) params["title"] = told.title = title;
    }
    if (typeof s.loading === "boolean" && s.loading !== told.loading) params["loading"] = told.loading = s.loading;
    if (Object.keys(params).length > 0) this.report({ id: s.tab, ...params });
  }

  /** A tab's page asked for a window (`webtab:newwindow`): it opens as another tab of the same session. */
  newWindow(e: { tab: string; url: string }): void {
    const held = this.tabs.get(e.tab);
    const url = webPage(e.url);
    if (!held || !url) return;
    this.deps.request("webtab.open", { session: held.tab.session, url }).catch((err: unknown) => this.deps.log?.(`the window did not open as a web tab: ${message(err)}`));
  }

  /** The shell lost a tab without being asked (`webtab:closed`): cophylad hears it is gone. */
  shellClosed(e: { tab: string }): void {
    if (!this.tabs.has(e.tab)) return;
    this.forget(e.tab);
    this.report({ id: e.tab, gone: true });
  }

  /** The host's picker or settings opened or closed: the tabs go under them, and come back. */
  overlay(open: boolean): void {
    if (open === this.covered) return;
    this.covered = open;
    this.applyAll(open ? "hide" : "come back");
  }

  /** The view's document went: its places go with it, and the tabs hide until it places them again. */
  unmounted(): void {
    for (const held of this.tabs.values()) held.rect = null;
    this.applyAll("hide");
  }

  /** The link to cophylad went, and cophylad closes every tab with it: so does the host. */
  linkLost(): void {
    this.links++;
    for (const [id, held] of this.tabs) {
      if (held.open) this.close(id);
    }
    this.tabs.clear();
  }
}
