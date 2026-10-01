// The door to the web viewer: a one-use ticket minted for a client by `remote.open`,
// claimed once at `GET /remote/?t=<ticket>` for a session cookie, then everything under
// `/remote/` with that cookie is proxied to the moonlight-web sidecar on loopback with the
// header it trusts as the login, bodies streamed and HTML told it may be framed by this
// origin only. The stream's WebSocket is bridged frame by frame to an upstream socket
// opened with the same header. The cookie is `Secure`, except for a ticket minted for a
// forwarder on the viewer's own loopback (`http://127.0.0.1`), claimed from there, since a
// browser drops a `Secure` cookie on plain HTTP. Each ticket says how the
// page carries its video (the transport it seeds, and for a low-latency one the renderer and
// codec that keep the video a few frames behind), and names the stream it opens, which
// its client ends with `remote.close`. A session is a `web` viewer in this node's
// `remote.state`: revoked by `remote.revoke`, and forgotten with its sockets when the client
// that opened it disconnects, like a view ticket.

import { randomBytes } from "node:crypto";
import type { RemoteViewer, StreamTransport } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import { WEB_USER, WEB_USER_HEADER } from "./web.ts";

export interface RemoteTarget {
  node: string;
  hostId: number;
  appId: number;
}

/**
 * How a ticket's page is served: the video's transport (the node's `[remote] web_transport`
 * without it), whether its cookie may be `Secure`, and whether the page is seeded with the
 * settings that keep the video a few frames behind: drawn on a canvas, HEVC where the browser
 * decodes it (measured: 67 ms against 167–183 with the viewer's defaults).
 */
export interface TicketOptions {
  name?: string;
  transport?: StreamTransport;
  secureCookie?: boolean;
  lowLatency?: boolean;
}

export interface RemoteSession {
  id: string;
  client: string;
  /** The stream this session is, as its client names it to `remote.close`. */
  stream: string;
  /** What the client is called, for the viewer list. */
  name?: string;
  target: RemoteTarget;
  transport?: StreamTransport;
  secureCookie?: boolean;
  lowLatency?: boolean;
  since: number;
  /** The bridged stream sockets open under this session. */
  bridges: Set<Bridge>;
}

interface Ticket extends TicketOptions {
  client: string;
  stream: string;
  target: RemoteTarget;
  expiresAt: number;
}

export const COOKIE = "cophyla_remote";
const TICKET_TTL_MS = 5 * 60_000;

export class RemoteTickets {
  private tickets = new Map<string, Ticket>();
  private sessions = new Map<string, RemoteSession>();
  private handlers = new Set<() => void>();
  private now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  onChange(handler: () => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private changed(): void {
    for (const h of this.handlers) h();
  }

  /** A ticket for `client` to open `target`: 16 random bytes, one use, five minutes; and the stream it opens. */
  mint(client: string, target: RemoteTarget, opts: TicketOptions = {}): { ticket: string; stream: string } {
    const ticket = randomBytes(16).toString("hex");
    const stream = `stream_${randomBytes(8).toString("hex")}`;
    this.tickets.set(ticket, { client, stream, target, expiresAt: this.now() + TICKET_TTL_MS, ...definedOf(opts) });
    return { ticket, stream };
  }

  /** Turns a live ticket into a session; the ticket is spent either way. */
  claim(ticket: string): RemoteSession | undefined {
    const t = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!t || t.expiresAt < this.now()) return undefined;
    const session: RemoteSession = { id: randomBytes(16).toString("hex"), client: t.client, stream: t.stream, target: t.target, since: this.now(), bridges: new Set(), ...definedOf(t) };
    this.sessions.set(session.id, session);
    this.changed();
    return session;
  }

  /** `client` ended its stream: the ticket, or the session it became, goes; another client's is left alone. */
  close(stream: string, client: string): boolean {
    let found = false;
    for (const [ticket, t] of [...this.tickets]) {
      if (t.stream !== stream || t.client !== client) continue;
      this.tickets.delete(ticket);
      found = true;
    }
    for (const s of [...this.sessions.values()]) if (s.stream === stream && s.client === client) found = this.revoke(s.id) || found;
    return found;
  }

  /** A bridge opened or closed under a session: the viewers changed. */
  touch(): void {
    this.changed();
  }

  session(id: string | undefined): RemoteSession | undefined {
    return id === undefined ? undefined : this.sessions.get(id);
  }

  list(): RemoteSession[] {
    return [...this.sessions.values()];
  }

  /** Ends a session: its sockets close, its cookie is dead. */
  revoke(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.sessions.delete(id);
    for (const b of [...s.bridges]) b.close();
    this.changed();
    return true;
  }

  /** The client went: every session it opened goes with it. */
  forgetClient(client: string): void {
    this.forgetWhere((c) => c === client);
  }

  /** Forgets the tickets and ends the sessions `which` picks, by their client and the desktop they show. */
  forgetWhere(which: (client: string, target: RemoteTarget) => boolean): void {
    for (const t of [...this.tickets]) if (which(t[1].client, t[1].target)) this.tickets.delete(t[0]);
    for (const s of [...this.sessions.values()]) if (which(s.client, s.target)) this.revoke(s.id);
  }

  /** The sessions as viewers: the phone's name, the moment it claimed, streaming while a socket is bridged. */
  viewers(): RemoteViewer[] {
    return this.list().map((s) => ({ id: `web_${s.id.slice(0, 8)}`, kind: "web", since: s.since, connected: s.bridges.size > 0, ...(s.name !== undefined ? { name: s.name } : {}) }));
  }

  /** The session behind a viewer id from `viewers()`. */
  byViewer(viewer: string): RemoteSession | undefined {
    return this.list().find((s) => `web_${s.id.slice(0, 8)}` === viewer);
  }
}

/** A stream socket bridged to the sidecar: frames buffered each way until that side is open, binary both ways. */
export interface Bridge {
  session: RemoteSession;
  upstream?: WebSocket;
  /** Frames from the browser waiting for the upstream socket. */
  pending: (string | Uint8Array)[];
  open: boolean;
  /** Writes to the browser's socket; set when the server opens it. */
  down?: (data: string | Uint8Array) => void;
  /** Frames from the sidecar that came before the browser's socket opened. */
  downPending: (string | Uint8Array)[];
  /** The bridge ended before the browser's socket opened: it is closed as soon as it does. */
  ended: boolean;
  close: () => void;
}

export interface RemoteProxyDeps {
  tickets: RemoteTickets;
  /** The sidecar's base, `http://127.0.0.1:<port>`, while it runs. */
  upstream: () => string | undefined;
  transport: () => "websocket" | "webrtc";
  log: Logger;
  fetch?: typeof fetch;
  /** Opens the upstream socket; the real one carries the login header. */
  connect?: (url: string) => WebSocket;
}

/** The options that were given, so an absent one stays absent. */
function definedOf(opts: TicketOptions): TicketOptions {
  const out: TicketOptions = {};
  if (opts.name !== undefined) out.name = opts.name;
  if (opts.transport !== undefined) out.transport = opts.transport;
  if (opts.secureCookie !== undefined) out.secureCookie = opts.secureCookie;
  if (opts.lowLatency !== undefined) out.lowLatency = opts.lowLatency;
  return out;
}

/**
 * What the claim page sets in the stream page's settings: the ticket's transport, and for a
 * low-latency one the canvas renderer and HEVC where the browser decodes it (H.264 where it
 * does not; AV1 shows no picture in moonlight-web 2.10.0).
 */
export function seedScript(transport: StreamTransport, lowLatency: boolean): string {
  const low = lowLatency ? `s.canvasRenderer=true;s.videoCodec=MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"')?"h265":"h264";` : "";
  return `try{var k="mlSettings",s=JSON.parse(localStorage.getItem(k)||"{}");s.dataTransport=${JSON.stringify(transport)};${low}localStorage.setItem(k,JSON.stringify(s))}catch(e){}`;
}

/** A `Host` on this machine's loopback: the page came through a forwarder here, over plain HTTP. */
export function loopbackHost(host: string | null): boolean {
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]!;
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}

const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "cookie", "content-length", WEB_USER_HEADER]);

function cookieOf(req: Request): string | undefined {
  const raw = req.headers.get("cookie") ?? "";
  return new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]{32})`).exec(raw)?.[1];
}

export class RemoteProxy {
  private deps: RemoteProxyDeps;
  private log: Logger;

  constructor(deps: RemoteProxyDeps) {
    this.deps = deps;
    this.log = deps.log;
  }

  /** Whether `path` is this proxy's to answer. */
  static owns(path: string): boolean {
    return path === "/remote" || path.startsWith("/remote/");
  }

  /**
   * Answers a request under `/remote`. `upgrade` is called for a WebSocket upgrade with
   * the bridge to attach to the socket's data; it returns whether the server took it, and
   * then there is no response to send.
   */
  async handle(req: Request, upgrade: (bridge: Bridge) => boolean): Promise<Response | undefined> {
    const url = new URL(req.url);
    const ticket = url.searchParams.get("t");
    if (ticket !== null) return this.claim(ticket, req.headers.get("host"));
    const session = this.deps.tickets.session(cookieOf(req));
    if (!session) return new Response("no session", { status: 403, headers: { "cache-control": "no-store" } });
    const base = this.deps.upstream();
    if (!base) return new Response("the web viewer is not running", { status: 503, headers: { "cache-control": "no-store" } });

    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const target = base.replace(/^http/, "ws") + url.pathname + url.search;
      const bridge: Bridge = { session, pending: [], open: false, downPending: [], ended: false, close: () => undefined };
      bridge.close = () => {
        bridge.ended = true;
        if (session.bridges.delete(bridge)) this.deps.tickets.touch();
        try {
          bridge.upstream?.close();
        } catch {
          // already closed
        }
      };
      if (!upgrade(bridge)) return new Response("upgrade failed", { status: 500 });
      session.bridges.add(bridge);
      this.deps.tickets.touch();
      this.openUpstream(bridge, target);
      return undefined;
    }

    const headers = new Headers();
    for (const [k, v] of req.headers) if (!HOP.has(k)) headers.set(k, v);
    headers.set(WEB_USER_HEADER, WEB_USER);
    const doFetch = this.deps.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(base + url.pathname + url.search, {
        method: req.method,
        headers,
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
        redirect: "manual",
      });
    } catch (e) {
      this.log.warn("web viewer unreachable", { error: e instanceof Error ? e.message : String(e) });
      return new Response("the web viewer did not answer", { status: 502, headers: { "cache-control": "no-store" } });
    }
    const out = new Headers();
    for (const [k, v] of res.headers) if (!HOP.has(k)) out.set(k, v);
    if ((res.headers.get("content-type") ?? "").includes("text/html")) out.set("content-security-policy", "frame-ancestors 'self'");
    out.set("x-content-type-options", "nosniff");
    return new Response(res.body, { status: res.status, headers: out });
  }

  /** The ticket page: the cookie, the ticket's settings into the page's storage, then the stream page. */
  private claim(ticket: string, host: string | null): Response {
    const session = this.deps.tickets.claim(ticket);
    if (!session) return new Response("that ticket is not open", { status: 403, headers: { "cache-control": "no-store" } });
    // Without `Secure` only for a ticket minted for a forwarder, and only as its loopback asks: anywhere else it stays
    const secure = !(session.secureCookie === false && loopbackHost(host));
    const nonce = randomBytes(12).toString("base64");
    const path = `/remote/stream.html?hostId=${session.target.hostId}&appId=${session.target.appId}`;
    const html =
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Connecting…</title></head><body>` +
      `<script nonce="${nonce}">${seedScript(session.transport ?? this.deps.transport(), session.lowLatency === true)}` +
      `location.replace(${JSON.stringify(path)})</script></body></html>`;
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": `${COOKIE}=${session.id}; Path=/remote;${secure ? " Secure;" : ""} HttpOnly; SameSite=Strict`,
        "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'self'`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  private openUpstream(bridge: Bridge, target: string): void {
    const ws = this.deps.connect ? this.deps.connect(target) : new WebSocket(target, { headers: { [WEB_USER_HEADER]: WEB_USER } } as never);
    ws.binaryType = "arraybuffer";
    bridge.upstream = ws;
    ws.onopen = () => {
      bridge.open = true;
      for (const m of bridge.pending) ws.send(m);
      bridge.pending = [];
    };
    ws.onmessage = (ev) => {
      const data = typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data as ArrayBuffer);
      if (bridge.down) bridge.down(data);
      else bridge.downPending.push(data);
    };
    ws.onclose = () => bridge.close();
    ws.onerror = () => {
      this.log.debug("upstream stream socket failed");
      bridge.close();
    };
  }

  /** The browser's side of a bridge: what the listener calls for its socket. */
  readonly ws = {
    open: (bridge: Bridge, down: (data: string | Uint8Array) => void, closeDown: () => void) => {
      if (bridge.ended) {
        closeDown();
        return;
      }
      for (const m of bridge.downPending) down(m);
      bridge.downPending = [];
      bridge.down = down;
      const upstreamClose = bridge.close;
      bridge.close = () => {
        upstreamClose();
        closeDown();
      };
    },
    message: (bridge: Bridge, msg: string | ArrayBuffer | Uint8Array) => {
      const data = typeof msg === "string" ? msg : msg instanceof Uint8Array ? msg : new Uint8Array(msg);
      if (bridge.open && bridge.upstream) bridge.upstream.send(data);
      else bridge.pending.push(data);
    },
    close: (bridge: Bridge) => {
      if (bridge.session.bridges.delete(bridge)) this.deps.tickets.touch();
      try {
        bridge.upstream?.close();
      } catch {
        // already closed
      }
    },
  };
}
