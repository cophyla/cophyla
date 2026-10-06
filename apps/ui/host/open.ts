// `host.open` in the desktop app, and the streams it shows. Another node's desktop comes as a
// stream page cophylad serves on this machine's loopback; the view hands it here, and the
// shell shows it in a window of its own, or, asked to embed it, beside the view: a web view
// laid over the host window where the view's `host.place` says, in the frame's coordinates,
// kept inside the frame and hidden when the view says so. Nothing of the host page can be
// drawn over that web view, so it hides while the host's own layers are open (the picker, the
// settings) and comes back where it was; it closes with `host.close`, when the view's document
// goes (replaced, or reloaded) and when the link to cophylad goes, since the pages read through
// it. Nothing else opens: the viewer for a desktop with a route is moonlight, which cophylad
// starts itself. When the shell says a stream's window or page closed, the node ends the
// session and the view is told.

import { placeOf, STREAM_ID, windowPlace } from "@cophyla/viewhost";
import type { Box, Place } from "@cophyla/viewhost";

// The view's rectangles and where they land in the window are viewhost's, shared with the page a browser shows.
export { placeOf, windowPlace };
export type { Box, Place };

/** What the host needs of the shell and the link. */
export interface StreamDeps {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  request: (method: string, params: unknown) => Promise<unknown>;
  /** Where the view's frame is in the host page, which a place is given relative to. */
  frame?: () => Box | undefined;
  /** A stream the host showed is gone: the view hears it. */
  onClosed?: (stream: string) => void;
  log?: (message: string) => void;
}


/** The stream page and its id from what the view handed `host.open`, or why it does not open. */
export function streamOf(params: unknown): { url: string; stream: string; embed: boolean } | { refuse: string } {
  const p = (params ?? {}) as { url?: unknown; stream?: unknown; embed?: unknown };
  if (typeof p.url !== "string") return { refuse: "host.open needs a url" };
  let url: URL;
  try {
    url = new URL(p.url);
  } catch {
    return { refuse: "that link cannot be opened" };
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "http:" || !loopback || url.port === "" || !url.pathname.startsWith("/remote/") || url.username !== "" || url.password !== "") {
    return { refuse: "this app opens only a stream page from its own node" };
  }
  if (typeof p.stream !== "string" || !STREAM_ID.test(p.stream)) return { refuse: "the stream did not say which it is" };
  return { url: url.href, stream: p.stream, embed: p.embed === true };
}

/** The streams the host shows, in their windows or beside the view, and their ends. */
export class StreamWindows {
  private deps: StreamDeps;
  private windows = new Set<string>();
  /** The streams beside the view, and where the view last placed each (`null`: hidden). */
  private embeds = new Map<string, Place | null>();
  /** The host's own layers are open: every stream beside the view is hidden meanwhile. */
  private covered = false;

  constructor(deps: StreamDeps) {
    this.deps = deps;
  }

  /** Streams whose window is open or whose page is beside the view. */
  get count(): number {
    return this.windows.size + this.embeds.size;
  }

  /** The host's own requests a view may make: `host.open`, `host.place`, `host.close`. */
  readonly host = async (method: string, params: unknown): Promise<unknown> => {
    switch (method) {
      case "host.open": {
        const s = streamOf(params);
        if ("refuse" in s) throw new Error(s.refuse);
        if (s.embed) {
          await this.deps.invoke("stream_embed", { url: s.url, stream: s.stream });
          if (!this.embeds.has(s.stream)) this.embeds.set(s.stream, null);
          return { embedded: true };
        }
        await this.deps.invoke("stream_open", { url: s.url, stream: s.stream });
        this.windows.add(s.stream);
        return {};
      }
      case "host.place": {
        const p = placeOf(params);
        if ("refuse" in p) throw new Error(p.refuse);
        if (!this.embeds.has(p.stream)) throw new Error("no such stream beside the view");
        this.embeds.set(p.stream, p.rect);
        await this.apply(p.stream);
        return {};
      }
      case "host.close": {
        const stream = (params as { stream?: unknown } | null)?.stream;
        if (typeof stream !== "string" || !STREAM_ID.test(stream)) throw new Error("host.close needs a stream");
        if (this.windows.has(stream) || this.embeds.has(stream)) await this.deps.invoke("stream_close", { stream });
        return {};
      }
      default:
        throw new Error(`no ${method}`);
    }
  };

  /** Puts a stream beside the view where the view placed it, or hides it. */
  private async apply(stream: string): Promise<void> {
    const rect = this.embeds.get(stream);
    const frame = this.deps.frame?.();
    const at = rect && !this.covered && frame ? windowPlace(rect, frame) : undefined;
    await this.deps.invoke("stream_place", at ? { stream, ...at } : { stream, hidden: true });
  }

  /** The host's picker or settings opened or closed: the streams beside the view go under them, and come back. */
  overlay(open: boolean): void {
    if (open === this.covered) return;
    this.covered = open;
    for (const stream of this.embeds.keys()) void this.apply(stream).catch((e: unknown) => this.deps.log?.(`the stream did not ${open ? "hide" : "come back"}: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** The view's document went: what it laid beside itself goes with it. */
  unmounted(): void {
    for (const stream of this.embeds.keys()) void this.deps.invoke("stream_close", { stream }).catch(() => undefined);
  }

  /** The shell closed a stream's window or its page beside the view: the node ends its session, and the view is told. */
  closed(stream: string): void {
    if (!this.windows.delete(stream) && !this.embeds.delete(stream)) return;
    this.deps.request("remote.close", { stream }).catch((e: unknown) => this.deps.log?.(`the node did not hear the stream close: ${e instanceof Error ? e.message : String(e)}`));
    this.deps.onClosed?.(stream);
  }

  /** The link to cophylad went, and the pages the streams read through with it. */
  linkLost(): void {
    for (const stream of [...this.windows, ...this.embeds.keys()]) void this.deps.invoke("stream_close", { stream }).catch(() => undefined);
  }
}
