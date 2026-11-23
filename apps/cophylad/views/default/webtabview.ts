// A session's web tabs beside its pane (or over it on a narrow window), in the desktop app, whose
// host lays each tab's page over the view where this panel says: the view draws the panel, its
// strip of tabs, the bar (back, forward, reload, the address, DevTools) and an empty slot under
// it, and tells the host the slot's rectangle for the tab that shows (`host.webtab {op: "place"}`)
// whenever it may have moved, once a frame at most, and `null` for every other tab, or for that
// one while something of the view lies over the slot (`remotePlace`), since nothing of the view
// can be drawn over the host's page. The panel is the file viewer's kind of `aside`, styled the
// same. Its buttons act through `deps`; nothing here changes the tabs themselves.

import type { WebTab } from "@cophyla/protocol";
import { remotePlace, samePlace } from "./model.ts";
import type { RemotePlace, ViewerDock } from "./model.ts";
import type { RemoteCover } from "./remoteview.ts";
import { addressUrl, tabLabel } from "./webtabmodel.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(className: string, text: string, title: string): HTMLButtonElement {
  const b = el("button", className, text);
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  return b;
}

function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export interface WebPanelDeps {
  /** The host's `host.webtab`. */
  host: (params: Record<string, unknown>) => Promise<unknown>;
  /** Opens a tab for the session (`webtab.open`). */
  open: (session: string, url?: string) => void;
  /** Closes a tab (`webtab.close`). */
  close: (tab: WebTab) => void;
  /** The user picked a tab of the session's strip. */
  choose: (tab: WebTab) => void;
  /** The user put the panel away. */
  putAway: (session: string) => void;
  cover: () => RemoteCover;
  /** Something went wrong the user should see. */
  fail: (words: string) => void;
}

export interface WebPanelOptions {
  dock: ViewerDock;
  width: number;
  /** Something of the view takes the pane the panel lies over: the panel waits under it, the page hidden. */
  concealed?: boolean;
}

export class WebPanel {
  readonly el: HTMLElement;
  private deps: WebPanelDeps;
  private strip: HTMLElement;
  private address: HTMLInputElement;
  private back: HTMLButtonElement;
  private forward: HTMLButtonElement;
  private reload: HTMLButtonElement;
  private devtools: HTMLButtonElement;
  private slot: HTMLElement;
  private note: HTMLElement;
  private session?: string;
  private tabs: WebTab[] = [];
  private shownTab?: WebTab;
  /** What the host was last told for each tab, so an unchanged place is not sent again. */
  private placed = new Map<string, RemotePlace | null>();
  private frame = 0;
  /** The address the user is typing: a draw leaves it as it is. */
  private typing = false;

  constructor(deps: WebPanelDeps) {
    this.deps = deps;
    this.el = el("aside", "viewer web-view");
    this.el.hidden = true;
    const split = el("div", "viewer-split");
    split.setAttribute("role", "separator");
    split.setAttribute("aria-orientation", "vertical");
    split.setAttribute("aria-label", "The web page's width beside the pane");
    split.title = "Drag to widen the page or the pane";
    split.tabIndex = 0;
    const head = el("header", "viewer-head web-view-head");
    this.strip = el("div", "web-view-strip");
    this.strip.setAttribute("role", "tablist");
    const add = button("web-view-add viewer-tool", "", "Open a new tab");
    const away = button("web-view-away viewer-tool viewer-close", "", "Put the web page away; its tabs stay open");
    head.append(el("span", "viewer-mark web-view-mark"), this.strip, add, away);
    const bar = el("form", "web-view-bar");
    this.back = button("web-view-back viewer-tool", "", "Back");
    this.forward = button("web-view-forward viewer-tool", "", "Forward");
    this.reload = button("web-view-reload viewer-tool", "", "Reload");
    this.address = el("input", "web-view-address");
    this.address.type = "text";
    this.address.spellcheck = false;
    this.address.autocomplete = "off";
    this.address.placeholder = "localhost:3000 or an address";
    this.address.setAttribute("aria-label", "Address");
    this.devtools = button("web-view-devtools viewer-tool", "", "Open the page's DevTools in a window of their own");
    bar.append(this.back, this.forward, this.reload, this.address, this.devtools);
    this.slot = el("div", "web-view-slot");
    this.note = el("p", "web-view-note");
    this.slot.append(this.note);
    this.el.append(split, head, bar, this.slot);

    add.addEventListener("click", () => {
      if (this.session) this.deps.open(this.session);
    });
    away.addEventListener("click", () => {
      if (this.session) this.deps.putAway(this.session);
    });
    this.back.addEventListener("click", () => this.op("back"));
    this.forward.addEventListener("click", () => this.op("forward"));
    this.reload.addEventListener("click", () => this.op("reload"));
    this.devtools.addEventListener("click", () => this.op("devtools"));
    this.address.addEventListener("focus", () => {
      this.typing = true;
      this.address.select();
    });
    this.address.addEventListener("blur", () => {
      this.typing = false;
      this.showAddress();
    });
    bar.addEventListener("submit", (e) => {
      e.preventDefault();
      const tab = this.shownTab;
      if (!tab) return;
      const url = addressUrl(this.address.value);
      if (!url) {
        this.deps.fail("A web tab opens an http or https address, such as localhost:3000");
        return;
      }
      this.address.blur();
      void this.deps.host({ op: "go", tab: tab.id, url }).catch((err: unknown) => this.deps.fail(`The page did not open: ${err instanceof Error ? err.message : String(err)}`));
    });
    this.strip.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const item = target.closest<HTMLElement>(".web-view-tab");
      const tab = item ? this.tabs.find((t) => t.id === item.dataset["tab"]) : undefined;
      if (!tab) return;
      if (target.closest(".web-view-tab-close")) this.deps.close(tab);
      else this.deps.choose(tab);
    });
    // The slot resized: the window, the divider, the rail, a dock moved it.
    new ResizeObserver(() => this.schedule()).observe(this.slot);
    window.addEventListener("resize", () => this.schedule());
  }

  get shown(): boolean {
    return !this.el.hidden && this.session !== undefined;
  }

  /** The session whose tabs the panel shows. */
  get shownSession(): string | undefined {
    return this.el.hidden ? undefined : this.session;
  }

  private op(op: "back" | "forward" | "reload" | "devtools"): void {
    const tab = this.shownTab;
    if (!tab) return;
    void this.deps.host({ op, tab: tab.id }).catch((err: unknown) => this.deps.fail(`The page did not answer: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** Shows a session's tabs, `active` on top, in `parent`; the host is told where its page goes once a frame. */
  show(session: string, tabs: WebTab[], active: WebTab, parent: HTMLElement, opts: WebPanelOptions): void {
    if (this.el.parentElement !== parent) parent.append(this.el);
    this.el.hidden = opts.concealed === true;
    const switched = this.session !== session || this.shownTab?.id !== active.id;
    this.session = session;
    this.tabs = tabs;
    this.shownTab = active;
    if (this.el.dataset["dock"] !== opts.dock) this.el.dataset["dock"] = opts.dock;
    this.setWidth(opts.width);
    this.drawStrip();
    if (switched) this.typing = false;
    this.showAddress();
    const words = active.target === undefined ? "Opening the page…" : "";
    setText(this.note, words);
    this.note.hidden = words === "";
    this.reload.dataset["loading"] = active.loading ? "1" : "0";
    if (switched && active.url === "about:blank" && active.by === "user" && !opts.concealed) queueMicrotask(() => this.address.focus());
    this.schedule();
  }

  private showAddress(): void {
    if (this.typing) return;
    const url = this.shownTab?.url ?? "";
    const value = url === "about:blank" ? "" : url;
    if (this.address.value !== value) this.address.value = value;
  }

  private drawStrip(): void {
    const items = new Map(Array.from(this.strip.children as HTMLCollectionOf<HTMLElement>).map((c) => [c.dataset["tab"] ?? "", c]));
    const want = this.tabs.map((t) => t.id);
    for (const [id, node] of items) if (!want.includes(id)) node.remove();
    this.tabs.forEach((tab, i) => {
      let item = items.get(tab.id);
      if (!item) {
        item = el("div", "web-view-tab");
        item.dataset["tab"] = tab.id;
        item.setAttribute("role", "tab");
        const label = el("span", "web-view-tab-label");
        const close = button("web-view-tab-close", "×", "Close this tab");
        item.append(label, close);
      }
      if (this.strip.children[i] !== item) this.strip.insertBefore(item, this.strip.children[i] ?? null);
      const words = tabLabel(tab);
      setText(item.querySelector(".web-view-tab-label")!, words);
      item.title = `${words}${tab.by === "agent" ? " (opened by the agent)" : ""}`;
      item.setAttribute("aria-selected", tab.id === this.shownTab?.id ? "true" : "false");
      item.dataset["by"] = tab.by;
    });
  }

  /** Puts the panel away: every page it placed is hidden. */
  hide(): void {
    if (this.el.hidden && this.session === undefined) return;
    this.el.hidden = true;
    this.session = undefined;
    this.shownTab = undefined;
    this.schedule();
  }

  /** Its share of the width beside the pane, in percent. */
  setWidth(width: number): void {
    const value = `${width}%`;
    if (this.el.style.getPropertyValue("--viewer-width") !== value) this.el.style.setProperty("--viewer-width", value);
    this.schedule();
  }

  /** A tab is gone: what the host was told of it is forgotten. */
  forget(tab: string): void {
    this.placed.delete(tab);
  }

  /** Tells the host where the page goes, at the next frame: once, however many asked. */
  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.place();
    });
  }

  private place(): void {
    const shown = !this.el.hidden && this.shownTab?.target !== undefined ? this.shownTab : undefined;
    let rect: RemotePlace | null = null;
    if (shown) {
      const cover = this.deps.cover();
      const r = this.slot.getBoundingClientRect();
      rect = remotePlace({ left: r.left, top: r.top, width: r.width, height: r.height }, { shown: true, covered: cover.covered, menus: cover.menus, ...(cover.pinned ? { pinned: cover.pinned } : {}) }) ?? null;
    }
    const tell = (tab: string, at: RemotePlace | null) => {
      if (this.placed.has(tab) && samePlace(this.placed.get(tab), at)) return;
      this.placed.set(tab, at);
      void this.deps.host({ op: "place", tab, rect: at }).catch(() => {
        // told again at the next change
        this.placed.delete(tab);
      });
    };
    for (const [tab, at] of this.placed) if (tab !== shown?.id && at !== null) tell(tab, null);
    if (shown) tell(shown.id, rect);
  }
}
