// `host.open`: what the view asks the page to show for the remote desktop. A stream page is
// served by the node on a port of its own, so it never runs on this page's origin: one there,
// under `/remote/`, goes in a frame, full-screen over the view with a bar to close it, or, in
// a wide window on a computer, beside the view where the view places it (`host.place`), hidden
// under the page's own layers and closed with `host.close`. A page elsewhere opens in a window
// of its own; an `art:` link (an invite for the Artemis app) is handed to the phone to open.
// Anything else is refused: the view is untrusted, and a `javascript:` or `data:` URL must
// never reach a navigation. A stream that closes, however it came about, ends its session on
// the node (`remote.close`) and the view is told (`host.streamClosed`).
//
// A browser keeps a certificate it was asked to accept per port, so the stream's address may
// still be waiting for its own. The claim page says when it has loaded; when it never does, the
// place where the picture would be says to open that address once.

import { placeOf, STREAM_ID, windowPlace } from "@cophyla/viewhost";
import type { Box, Place } from "@cophyla/viewhost";

export type OpenTarget = { kind: "frame"; url: string } | { kind: "window"; url: string } | { kind: "app"; url: string };

/**
 * Where a URL from the view goes, or why it may not; `origin` is this page's. A stream page is
 * on this host under another port: the node's stream listener, which the page's policy names.
 */
export function openTarget(raw: unknown, origin: string): OpenTarget {
  if (typeof raw !== "string" || raw.length > 4096) throw new Error("host.open needs a url");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("that link cannot be opened");
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    // this page's own origin serves no stream page, and nothing else of it opens over the view
    if (url.origin === origin) throw new Error("only a stream page opens over the view");
    let own: URL | undefined;
    try {
      own = new URL(origin);
    } catch {
      own = undefined;
    }
    if (own && url.protocol === own.protocol && url.hostname === own.hostname && url.pathname.startsWith("/remote/") && url.username === "" && url.password === "") return { kind: "frame", url: url.href };
    return { kind: "window", url: url.href };
  }
  if (url.protocol === "art:") return { kind: "app", url: url.href };
  throw new Error("that link cannot be opened");
}

/** What the claim page of a stream posts to the page that framed it, once it has loaded. */
export const STREAM_CLAIMED = "cophyla.stream.claimed";
/** How long a stream's frame has to say it loaded before the page says its address may need opening once. */
export const CLAIM_WAIT_MS = 4000;

/** What the frames need of the page and the link. */
export interface StreamFramesDeps {
  doc: Document;
  /** This page's origin. */
  origin: string;
  request: (method: string, params: unknown) => Promise<unknown>;
  /** Where the view's frame is in the page, which a place is given relative to. */
  frame?: () => Box | undefined;
  /** The page lays a stream beside the view (`host.open {embed}`): a wide window on a computer. */
  embed?: boolean;
  /** A stream the page showed is gone: the view hears it. */
  onClosed?: (stream: string) => void;
  /** A stream covers the page, or no longer does. */
  onCover?: (covered: boolean) => void;
  open?: (url: string) => void;
  navigate?: (url: string) => void;
  timers?: { setTimeout(handler: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  claimWaitMs?: number;
  log?: (message: string) => void;
}

interface Shown {
  stream: string;
  /** Whether the node knows it by this id: one a view gave no id for is the page's own name for it. */
  known: boolean;
  url: string;
  frame: HTMLIFrameElement;
  /** The whole layer, for a stream over everything. */
  layer?: HTMLElement;
  /** Where the view last placed a stream beside it (`null`: hidden). */
  place?: Place | null;
  note?: HTMLElement;
  claimed: boolean;
  timer?: unknown;
}

const ALLOW = "fullscreen; gamepad; keyboard-map; autoplay; clipboard-read; clipboard-write";

/** The streams the page shows, over everything or beside the view, and their ends. */
export class StreamFrames {
  private deps: StreamFramesDeps;
  private shown = new Map<string, Shown>();
  /** The page's own layers are open: every stream beside the view is hidden meanwhile. */
  private covered = false;
  private seq = 0;

  constructor(deps: StreamFramesDeps) {
    this.deps = deps;
    // The claim page says it loaded: from that frame, on its own origin, and nothing else is heard.
    deps.doc.defaultView?.addEventListener("message", (ev) => {
      const data = ev.data as { cophyla?: unknown } | null;
      if (!data || typeof data !== "object" || data.cophyla !== STREAM_CLAIMED) return;
      for (const s of this.shown.values()) {
        if (ev.source !== s.frame.contentWindow) continue;
        try {
          if (ev.origin !== new URL(s.url).origin) return;
        } catch {
          return;
        }
        this.claimed(s);
      }
    });
  }

  get count(): number {
    return this.shown.size;
  }

  /** The page's own requests a view may make: `host.open`, `host.place`, `host.close`. */
  readonly host = async (method: string, params: unknown): Promise<unknown> => {
    switch (method) {
      case "host.open": {
        const p = (params ?? {}) as { url?: unknown; stream?: unknown; embed?: unknown };
        const target = openTarget(p.url, this.deps.origin);
        if (target.kind === "window") {
          (this.deps.open ?? ((url) => void this.deps.doc.defaultView?.open(url, "_blank", "noopener,noreferrer")))(target.url);
          return {};
        }
        if (target.kind === "app") {
          (this.deps.navigate ?? ((url) => void (this.deps.doc.defaultView!.location.href = url)))(target.url);
          return {};
        }
        const known = typeof p.stream === "string" && STREAM_ID.test(p.stream);
        const stream = known ? (p.stream as string) : `local_${++this.seq}`;
        if (this.shown.has(stream)) this.remove(stream);
        if (p.embed === true && this.deps.embed) {
          this.show({ stream, known, url: target.url, beside: true });
          return { embedded: true };
        }
        // one over everything at a time
        for (const s of [...this.shown.values()]) if (s.layer) this.end(s.stream);
        this.show({ stream, known, url: target.url, beside: false });
        return {};
      }
      case "host.place": {
        const p = placeOf(params);
        if ("refuse" in p) throw new Error(p.refuse);
        const s = this.shown.get(p.stream);
        if (!s || s.layer) throw new Error("no such stream beside the view");
        s.place = p.rect;
        this.apply(s);
        return {};
      }
      case "host.close": {
        const stream = (params as { stream?: unknown } | null)?.stream;
        if (typeof stream !== "string" || !STREAM_ID.test(stream)) throw new Error("host.close needs a stream");
        this.end(stream);
        return {};
      }
      default:
        throw new Error(`no ${method}`);
    }
  };

  private show(o: { stream: string; known: boolean; url: string; beside: boolean }): void {
    const doc = this.deps.doc;
    const frame = doc.createElement("iframe");
    frame.title = "Remote desktop";
    frame.setAttribute("allow", ALLOW);
    const s: Shown = { stream: o.stream, known: o.known, url: o.url, frame, claimed: false };
    if (o.beside) {
      frame.className = "stream-frame";
      frame.hidden = true;
      s.place = null;
      doc.body.append(frame);
    } else {
      const layer = doc.createElement("div");
      layer.id = "remote-layer";
      layer.className = "remote-layer";
      const bar = doc.createElement("div");
      bar.className = "remote-bar";
      const title = doc.createElement("span");
      title.textContent = "Remote desktop";
      const close = doc.createElement("button");
      close.type = "button";
      close.textContent = "Close";
      close.addEventListener("click", () => this.end(o.stream));
      bar.append(title, close);
      layer.append(bar, frame);
      doc.body.append(layer);
      s.layer = layer;
      this.deps.onCover?.(true);
    }
    this.shown.set(o.stream, s);
    frame.src = o.url;
    const timers = this.deps.timers ?? { setTimeout: (h: () => void, ms: number) => setTimeout(h, ms), clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
    s.timer = timers.setTimeout(() => {
      s.timer = undefined;
      if (!s.claimed && this.shown.get(o.stream) === s) this.unclaimed(s);
    }, this.deps.claimWaitMs ?? CLAIM_WAIT_MS);
  }

  /** The stream's page loaded: its address is one the browser accepts. */
  private claimed(s: Shown): void {
    s.claimed = true;
    this.clearTimer(s);
    s.note?.remove();
    delete s.note;
    this.apply(s);
  }

  /** Nothing came from the frame: the browser may be holding the stream's address back for its certificate. */
  private unclaimed(s: Shown): void {
    const doc = this.deps.doc;
    let address: string;
    try {
      address = `${new URL(s.url).origin}/remote/ready`;
    } catch {
      return;
    }
    const note = doc.createElement("div");
    note.className = "stream-note";
    const line = doc.createElement("p");
    line.textContent = "The desktop's picture comes from another address of this node, which this browser has not accepted yet.";
    const link = doc.createElement("a");
    link.href = address;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open it once, accept its certificate, and come back";
    const again = doc.createElement("button");
    again.type = "button";
    again.textContent = "Close";
    again.addEventListener("click", () => this.end(s.stream));
    note.append(line, link, again);
    s.note = note;
    if (s.layer) {
      note.style.position = "absolute";
      note.style.inset = "0";
      s.layer.style.position = "fixed";
      s.layer.append(note);
    } else doc.body.append(note);
    this.apply(s);
  }

  /** Puts a stream beside the view where the view placed it, or hides it. */
  private apply(s: Shown): void {
    if (s.layer) return;
    const box = this.deps.frame?.();
    const at = s.place && !this.covered && box ? windowPlace(s.place, box) : undefined;
    for (const el of [s.frame, ...(s.note ? [s.note] : [])]) {
      if (!at) {
        el.hidden = true;
        continue;
      }
      el.hidden = false;
      el.style.left = `${at.x}px`;
      el.style.top = `${at.y}px`;
      el.style.width = `${at.width}px`;
      el.style.height = `${at.height}px`;
    }
  }

  private clearTimer(s: Shown): void {
    if (s.timer === undefined) return;
    (this.deps.timers ?? { clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) }).clearTimeout(s.timer);
    s.timer = undefined;
  }

  /** Takes a stream's frame off the page, and says nothing. */
  private remove(stream: string): Shown | undefined {
    const s = this.shown.get(stream);
    if (!s) return undefined;
    this.shown.delete(stream);
    this.clearTimer(s);
    s.note?.remove();
    (s.layer ?? s.frame).remove();
    if (s.layer && ![...this.shown.values()].some((x) => x.layer)) this.deps.onCover?.(false);
    return s;
  }

  /** A stream the page showed ends: its frame goes, the node ends its session, and the view is told. */
  private end(stream: string): void {
    const s = this.remove(stream);
    if (!s) return;
    if (s.known) {
      this.deps.request("remote.close", { stream }).catch((e: unknown) => this.deps.log?.(`the node did not hear the stream close: ${e instanceof Error ? e.message : String(e)}`));
      this.deps.onClosed?.(stream);
    }
  }

  /** The page's picker or settings opened or closed: the streams beside the view go under them, and come back. */
  overlay(open: boolean): void {
    if (open === this.covered) return;
    this.covered = open;
    for (const s of this.shown.values()) this.apply(s);
  }

  /** The window changed size, or the view moved: the streams beside it follow its frame. */
  replace(): void {
    for (const s of this.shown.values()) this.apply(s);
  }

  /** The view's document went: what it laid beside itself goes with it. */
  unmounted(): void {
    for (const s of [...this.shown.values()]) if (!s.layer) this.end(s.stream);
  }

  /** The link to the node went: the sessions went with the client, so the frames go and nothing more is asked. */
  linkLost(): void {
    for (const s of [...this.shown.values()]) {
      this.remove(s.stream);
      if (s.known) this.deps.onClosed?.(s.stream);
    }
  }
}
