// Media streamed to a view's player. A video or a sound plays in the document frame from a URL
// the host's native side serves (the desktop shell's server on this computer's loopback, the
// phone app's own path),
// which answers the media element's byte ranges as it plays and seeks, so nothing waits for the
// whole file. The bytes still come over the host's connection, the only way to a file on
// another computer, read with the view's own read (`session.file` or `terminal.file`, with
// `whole`, `stream` and `at`): by the native side itself where it holds the connection (the
// desktop shell, told the read and the file's time when a stream opens, so no piece passes
// through the page), else by this (the phone, whose link may be the relay's, in the page): the
// native side asks for each piece it lacks (`need`), and this reads it, joining the node's
// answers into the piece, and hands it back. The native side keeps the
// pieces on the device (a file on this computer only in memory), so a file played again plays
// from there. A view opens a stream with `host.media {op: "open"}` once it knows the file's size
// and when it last changed, and gets the URL to play; a piece read after the file changed fails,
// and the view reads it again. `{op: "stats"}` says how many requests the native side answered,
// so a view whose player found nothing to play can tell an engine that never reached the URL
// (and read the file whole instead) from a file it cannot play. DOM-free.

import type { FileText } from "@cophyla/protocol";

/** Bytes per piece: the node's whole-read piece (WHOLE_CHUNK), so a piece is one answer. */
export const MEDIA_PIECE = 1572864;

/** The reads a stream may make, as the view would make them. */
export const MEDIA_READS = ["session.file", "terminal.file"] as const;
export type MediaRead = (typeof MEDIA_READS)[number];

/** A stream as the native side keeps it. */
export interface MediaStream {
  id: string;
  /** Names the file's version (where it is, its path, size and time): the same key finds the same pieces. */
  key: string;
  size: number;
  mime: string;
  /** Kept on the device's disk: the file is on another computer. */
  keep: boolean;
}

/** The native side lacks a piece of a stream. */
export interface MediaNeed {
  req: number;
  id: string;
  index: number;
  at: number;
  len: number;
}

export interface MediaStats {
  requests: number;
  fetched: number;
  cached: number;
  /** Why the last piece that failed did, as `host.media {op: "stats"}` tells the view. */
  error?: string;
}

/** The native side of the host: its commands; a stream opened says where the player finds it. */
export interface MediaNative {
  /** `read` and `modified` are for a native side that reads the pieces itself. */
  open(stream: MediaStream & { name: string; read: MediaOpen["read"]; modified: number }): Promise<{ url: string }>;
  /** A piece's bytes as base64, or why there are none. */
  piece(answer: { req: number; data?: string; error?: string }): Promise<void>;
  close(id: string): Promise<void>;
  stats(id: string): Promise<MediaStats>;
}

export interface MediaHostDeps {
  native: MediaNative;
  /** A request over the host's connection. */
  request: (method: string, params: unknown) => Promise<unknown>;
  /**
   * The node this host's computer is, where the host is a desktop app on one: a file there is
   * kept in memory alone. Undefined (the phone), every file is kept on the device.
   */
  here?: () => string | undefined;
  log?: (message: string) => void;
}

/** What a view's `host.media {op: "open"}` asks, once it is well formed. */
export interface MediaOpen {
  op: "open";
  read: { method: MediaRead; params: { id?: string; terminal?: string; node?: string; path: string } };
  size: number;
  modified: number;
  mime: string;
  name: string;
  /** The node the file is on, when the view knows it. */
  node?: string;
}

/** Streams open per host, at most: a viewer opens one at a time. */
export const MEDIA_OPEN_MAX = 8;

const STRING_MAX = 4096;
const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

const short = (v: unknown, max = STRING_MAX): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** What a view's `host.media {op: "open"}` asks, or why it is refused. */
export function mediaOpen(params: unknown): MediaOpen | { refuse: string } {
  const p = (params ?? {}) as Record<string, unknown>;
  const read = (p.read ?? {}) as { method?: unknown; params?: unknown };
  if (!(MEDIA_READS as readonly unknown[]).includes(read.method)) return { refuse: `host.media reads with ${MEDIA_READS.join(" or ")}` };
  const rp = (read.params ?? {}) as Record<string, unknown>;
  // the read's own fields alone: what the host adds (whole, stream, at) is never the view's
  for (const k of Object.keys(rp)) if (!["id", "terminal", "node", "path"].includes(k)) return { refuse: `host.media: a read takes no ${k}` };
  if (!short(rp.path)) return { refuse: "host.media needs the file's path" };
  for (const k of ["id", "terminal", "node"] as const) if (rp[k] !== undefined && !short(rp[k], 256)) return { refuse: `host.media: a bad ${k}` };
  if (read.method === "session.file" && rp.id === undefined) return { refuse: "host.media: session.file needs the session" };
  if (!count(p.size) || !count(p.modified)) return { refuse: "host.media needs the file's size and when it changed" };
  if (!short(p.mime, 128) || !/^(audio|video)\/[\w.+-]+$/.test(p.mime)) return { refuse: "host.media plays a video or a sound" };
  if (!short(p.name, 1024)) return { refuse: "host.media needs the file's name" };
  if (p.node !== undefined && !short(p.node, 256)) return { refuse: "host.media: a bad node" };
  const params2: MediaOpen["read"]["params"] = { path: rp.path };
  for (const k of ["id", "terminal", "node"] as const) if (typeof rp[k] === "string") params2[k] = rp[k];
  return { op: "open", read: { method: read.method as MediaRead, params: params2 }, size: p.size, modified: p.modified, mime: p.mime, name: p.name, ...(typeof p.node === "string" ? { node: p.node } : {}) };
}

/** Bytes a piece of base64 holds. */
function base64Bytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

interface Open {
  stream: MediaStream;
  read: MediaOpen["read"];
  size: number;
  modified: number;
}

export class MediaHost {
  private deps: MediaHostDeps;
  private open = new Map<string, Open>();
  /** Why each stream's last piece failed. */
  private failed = new Map<string, string>();
  private n = 0;

  constructor(deps: MediaHostDeps) {
    this.deps = deps;
  }

  /** A view's `host.media`. */
  async host(method: string, params: unknown): Promise<unknown> {
    if (method !== "host.media") throw new Error(`no ${method}`);
    const op = (params as { op?: unknown } | null)?.op;
    if (op === "open") return this.start(params);
    const id = (params as { id?: unknown }).id;
    if (op === "close") {
      if (typeof id === "string" && this.open.delete(id)) {
        this.failed.delete(id);
        await this.deps.native.close(id);
      }
      return {};
    }
    if (op === "stats") {
      if (typeof id !== "string" || !this.open.has(id)) throw new Error("host.media: no such stream");
      const stats = await this.deps.native.stats(id);
      const error = this.failed.get(id);
      return { requests: stats.requests, fetched: stats.fetched, cached: stats.cached, ...(error !== undefined ? { error } : {}) };
    }
    throw new Error("host.media needs an op: open, close or stats");
  }

  private async start(params: unknown): Promise<{ id: string; url: string }> {
    const ask = mediaOpen(params);
    if ("refuse" in ask) throw new Error(ask.refuse);
    // the oldest goes, should a view never close what it opened
    while (this.open.size >= MEDIA_OPEN_MAX) {
      const oldest = this.open.keys().next().value as string;
      this.open.delete(oldest);
      this.failed.delete(oldest);
      await this.deps.native.close(oldest).catch(() => undefined);
    }
    const id = this.newId();
    const here = this.deps.here?.();
    const where = ask.node ?? ask.read.params.node ?? "";
    const keep = here === undefined || where === "" || where !== here;
    const key = JSON.stringify([where, ask.read.method, ask.read.params.id ?? ask.read.params.terminal ?? "", ask.read.params.path, ask.size, ask.modified]);
    const stream: MediaStream = { id, key, size: ask.size, mime: ask.mime, keep };
    const { url } = await this.deps.native.open({ ...stream, name: ask.name, read: ask.read, modified: ask.modified });
    this.open.set(id, { stream, read: ask.read, size: ask.size, modified: ask.modified });
    return { id, url };
  }

  private newId(): string {
    let s = "m" + (++this.n).toString(36) + "-";
    for (let i = 0; i < 12; i++) s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
    return s;
  }

  /** The native side lacks a piece: it is read and handed over, or why it cannot be. */
  need(need: MediaNeed): void {
    void this.fetch(need).then(
      (data) => this.deps.native.piece({ req: need.req, data }),
      (e: unknown) => {
        const error = e instanceof Error ? e.message : String(e);
        if (this.open.has(need.id)) this.failed.set(need.id, error);
        this.deps.log?.(`media ${need.id} piece ${need.index}: ${error}`);
        return this.deps.native.piece({ req: need.req, error });
      },
    ).catch((e: unknown) => this.deps.log?.(`media ${need.id}: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** The piece's bytes, as base64: one answer or more, joined. */
  private async fetch(need: MediaNeed): Promise<string> {
    const s = this.open.get(need.id);
    if (!s) throw new Error("the stream is closed");
    if (!count(need.at) || !count(need.len) || need.len === 0 || need.at + need.len > s.size) throw new Error("past the file's end");
    const parts: { b64: string; n: number }[] = [];
    let at = need.at;
    const end = need.at + need.len;
    while (at < end) {
      const got = (await this.deps.request(s.read.method, { ...s.read.params, whole: true, image: true, stream: true, at })) as FileText;
      if (got.modified !== s.modified || got.size !== s.size) throw new Error("the file changed");
      if (got.base64 === undefined) throw new Error(got.note ?? (got.binary ? "that computer sends none of it: update Cophyla there" : "nothing came"));
      const n = base64Bytes(got.base64);
      if (n === 0) throw new Error("nothing came");
      parts.push({ b64: got.base64, n });
      at += n;
    }
    // Base64 joins as it is when every part but the last is a whole number of its groups (the
    // node's pieces are) and nothing runs past the piece; else the bytes are joined.
    const joins = parts.every((p, i) => i === parts.length - 1 || p.n % 3 === 0) && at === end;
    if (joins) return parts.map((p) => p.b64).join("");
    return btoa(parts.map((p) => atob(p.b64)).join("").slice(0, need.len));
  }
}
