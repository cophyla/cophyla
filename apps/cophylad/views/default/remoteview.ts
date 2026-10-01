// Another node's desktop beside the pane (or over it), in the desktop app, whose host lays the
// stream's page over the view where this panel says: the view draws the panel, its head (whose
// desktop, Open in Moonlight, the dock toggle, Close) and an empty slot under it, and tells the
// host the slot's rectangle (`host.place`) whenever it may have moved, once a frame at most, or
// `null` while the stream must hide: nothing of the view can be drawn over the host's page, so
// it hides while something of the view lies over the slot (`remotePlace`). The stream takes the
// slot's width at its top in the picture's own shape (`fitPlace`), so the page draws no bands;
// the panel shows below it. While the stream is opening, or failed, the slot says so itself.
// The panel is the file viewer's kind of `aside`, its dock and divider styled the same.

import { fitPlace, remotePlace, samePlace } from "./model.ts";
import type { Box, RemotePlace, RemoteView, ViewerDock } from "./model.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(className: string, text: string, title: string): HTMLButtonElement {
  const b = el("button", className, text);
  b.type = "button";
  b.dataset["action"] = className.split(" ")[0]!;
  b.title = title;
  b.setAttribute("aria-label", title);
  return b;
}

function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

/** What lies over the slot now, as the view knows it. */
export interface RemoteCover {
  /** Something of the view lies over the whole panel: the stream hides. */
  covered: boolean;
  /** Menus open now: the stream hides while one crosses it. */
  menus: Box[];
  /** The pinned prompts, when they show: the stream starts below them where they cross its top. */
  pinned?: Box;
}

export interface RemotePanelDeps {
  /** Tells the host where the stream goes, or `null` to hide it. */
  place: (stream: string, rect: RemotePlace | null) => Promise<unknown>;
  cover: () => RemoteCover;
}

export interface RemotePanelOptions {
  dock: ViewerDock;
  width: number;
  /** The window is wide enough for the panel to sit beside the pane. */
  dockable: boolean;
  connected: boolean;
  /** Something of the view takes the pane the panel lies over (a file, the context): the panel waits under it, the stream hidden. */
  concealed?: boolean;
}

export class RemotePanel {
  readonly el: HTMLElement;
  private deps: RemotePanelDeps;
  private title: HTMLElement;
  private slot: HTMLElement;
  private note: HTMLElement;
  private dock: HTMLButtonElement;
  private moonlight: HTMLButtonElement;
  private view?: RemoteView;
  /** What the host was last told for the stream, so an unchanged place is not sent again. */
  private placed?: RemotePlace | null;
  private placedFor?: string;
  private frame = 0;

  constructor(deps: RemotePanelDeps) {
    this.deps = deps;
    this.el = el("aside", "viewer remote-view");
    this.el.hidden = true;
    const split = el("div", "viewer-split");
    split.setAttribute("role", "separator");
    split.setAttribute("aria-orientation", "vertical");
    split.setAttribute("aria-label", "The desktop's width beside the pane");
    split.setAttribute("aria-valuemin", "0");
    split.setAttribute("aria-valuemax", "100");
    split.title = "Drag to widen the desktop or the pane; double-click for the usual width";
    split.tabIndex = 0;
    const head = el("header", "viewer-head remote-view-head");
    this.title = el("span", "viewer-title remote-view-title");
    this.moonlight = button("remote-view-moonlight", "Open in Moonlight", "Show this desktop in Moonlight's own window instead: the quickest it can be");
    this.dock = button("remote-view-dock viewer-tool viewer-dock", "", "Lay over the pane");
    const tools = el("span", "viewer-tools");
    tools.append(this.moonlight, this.dock, button("remote-view-close viewer-tool viewer-close", "", "Close the desktop"));
    head.append(el("span", "viewer-mark remote-view-mark"), this.title, tools);
    this.slot = el("div", "remote-view-slot");
    this.note = el("p", "remote-view-note");
    this.slot.append(this.note);
    this.el.append(split, head, this.slot);
    // The slot resized: the window, the divider, the rail, a dock moved it.
    new ResizeObserver(() => this.schedule()).observe(this.slot);
    window.addEventListener("resize", () => this.schedule());
  }

  get shown(): boolean {
    return !this.el.hidden;
  }

  /** The node whose desktop the panel shows. */
  get node(): string | undefined {
    return this.view?.node;
  }

  /** Shows `view` in `parent`, docked as asked; the host is told where the stream goes once a frame. */
  show(view: RemoteView, parent: HTMLElement, opts: RemotePanelOptions): void {
    if (this.el.parentElement !== parent) parent.append(this.el);
    this.el.hidden = opts.concealed === true;
    this.view = view;
    this.setWidth(opts.width);
    if (this.el.dataset["dock"] !== opts.dock) this.el.dataset["dock"] = opts.dock;
    this.el.setAttribute("aria-label", `${view.name}'s desktop`);
    setText(this.title, `${view.name} desktop`);
    this.title.title = `${view.name}'s desktop, as its host streams it here`;
    this.dock.hidden = !opts.dockable;
    this.dock.dataset["dock"] = opts.dock;
    const dockWords = opts.dock === "over" ? "Dock beside the pane" : "Lay over the pane";
    if (this.dock.title !== dockWords) {
      this.dock.title = dockWords;
      this.dock.setAttribute("aria-label", dockWords);
    }
    this.moonlight.disabled = !opts.connected;
    this.moonlight.dataset["node"] = view.node;
    const words = view.phase === "opening" ? `Opening ${view.name}'s desktop… the first time, ${view.name} asks to pair this app.` : view.phase === "failed" ? (view.error ?? "The desktop did not open.") : "";
    setText(this.note, words);
    this.note.hidden = words === "";
    this.note.dataset["error"] = view.phase === "failed" ? "1" : "0";
    this.schedule();
  }

  /** Puts the panel away; the host's page is the caller's to close. */
  hide(): void {
    if (this.el.hidden && !this.view) return;
    this.el.hidden = true;
    this.view = undefined;
    this.placed = undefined;
    this.placedFor = undefined;
  }

  /** Its share of the width beside the pane, in percent: its divider moves it without a draw. */
  setWidth(width: number): void {
    const value = `${width}%`;
    if (this.el.style.getPropertyValue("--viewer-width") !== value) {
      this.el.style.setProperty("--viewer-width", value);
      this.el.querySelector(".viewer-split")!.setAttribute("aria-valuenow", String(Math.round(width)));
    }
    this.schedule();
  }

  /** Tells the host where the stream goes, at the next frame: once, however many asked. */
  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.place();
    });
  }

  private place(): void {
    const stream = this.view?.phase === "open" ? this.view.stream : undefined;
    if (!stream) return;
    const cover = this.deps.cover();
    const r = this.slot.getBoundingClientRect();
    const slot = remotePlace(
      this.el.hidden ? undefined : { left: r.left, top: r.top, width: r.width, height: r.height },
      { shown: !this.el.hidden, covered: cover.covered, menus: cover.menus, ...(cover.pinned ? { pinned: cover.pinned } : {}) },
    );
    const video = this.view?.video;
    const rect = slot && fitPlace(slot, video ? video.width / video.height : undefined);
    if (this.placedFor === stream && samePlace(this.placed, rect)) return;
    this.placed = rect;
    this.placedFor = stream;
    void this.deps.place(stream, rect).catch(() => {
      // told again at the next change
      this.placed = undefined;
    });
  }
}
