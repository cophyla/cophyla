// The peer side of a relay tunnel: a phone's socket at the server's `/ws/relay`, or a
// node's own `relay.open` on its server link — anything that initiates. `PeerSession` is
// the phone's: it authenticates with the relay token, opens the tunnel with a fresh
// ephemeral, derives the keys, and from then on seals what it is given and opens what
// arrives. A phone pairing through the account authenticates with its sign-in's grant and
// verifier instead, learns the peer id the server gave this pairing, and opens the `pair`
// kind. The socket is a `WebSocket` by default and injectable for a test or a native
// shell. What the session hands back is the inner protocol's frames, verbatim.

import { derive, ephemeral, TunnelError } from "./tunnel.ts";
import type { Psk, RelayCurve, Tunnel, TunnelKind } from "./tunnel.ts";

/** The close code the session uses when the far end or the server ended the tunnel. */
export const PEER_GONE = 4409;
/** The close code for a token the server refused. */
export const PEER_UNAUTHORIZED = 4401;
/** The close code the session uses when a record failed to open: the keys do not match, or the stream was tampered with. */
export const PEER_BAD_RECORD = 4403;

export interface PeerSessionOptions {
  /** The server's origin: `https://orc.example` (or `wss://`, or `http://` for a fake). */
  url: string;
  /** The relay token from `RelayAccess`; a phone pairing through the account has `grant` instead. */
  token?: string;
  /** The sign-in's grant and the PKCE verifier the phone kept; spent at auth, once. */
  grant?: { grant: string; verifier: string };
  /** The peer id this session speaks as: the controller id from `RelayAccess`. A grant's session learns it from the server. */
  peer?: string;
  psk: Psk;
  kind?: TunnelKind;
  /** The node a pairing tunnel should reach; the server picks one when absent. */
  node?: string;
  curve?: RelayCurve;
  /** The socket factory; the global `WebSocket` by default. */
  ws?: (url: string) => WebSocket;
  /** How long the socket, the auth and the open may take together. */
  timeoutMs?: number;
}

export interface PeerSessionEvents {
  onText?: (text: string) => void;
  onClose?: (code: number, reason: string) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class PeerSessionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** `<origin>/ws/relay` as a WebSocket URL. */
export function relayUrl(origin: string): string {
  return `${origin.replace(/\/$/, "").replace(/^http/, "ws")}/ws/relay`;
}

export class PeerSession {
  private opts: PeerSessionOptions;
  private events: PeerSessionEvents;
  private ws?: WebSocket;
  private tunnel?: Tunnel;
  private pending = new Map<number, Pending>();
  private n = 0;
  private closed = false;
  /** Frames handed to `send` and not yet sealed, and the size of the last one on the wire, for `buffered`. */
  private sealing = 0;
  private lastFrame = 0;
  /** The records arriving, opened in order; a close from the server is applied after the last of them. */
  private inbound: Promise<void> = Promise.resolve();
  /** The node at the far end, once open. */
  node?: string;
  /** Its name, when the server said it (a pairing tunnel). */
  nodeName?: string;
  /** The peer id this session speaks as, once authenticated. */
  peer?: string;
  /** The account a grant signed in as. */
  account?: { subject: string; login: string };

  constructor(opts: PeerSessionOptions, events: PeerSessionEvents = {}) {
    this.opts = opts;
    this.events = events;
  }

  get open(): boolean {
    return this.tunnel !== undefined && !this.closed;
  }

  /** Bytes waiting to leave: what the socket has not sent, and the frames still being sealed at about the last one's size. */
  get buffered(): number {
    return (this.ws?.bufferedAmount ?? 0) + this.sealing * this.lastFrame;
  }

  /** Opens the socket, authenticates, opens the tunnel; resolves with the node's id. */
  async connect(): Promise<{ peer: string }> {
    const url = relayUrl(this.opts.url);
    const ws = (this.opts.ws ?? ((u: string) => new WebSocket(u)))(url);
    this.ws = ws;
    const timeoutMs = this.opts.timeoutMs ?? 15_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PeerSessionError("timeout", `relay: no tunnel within ${timeoutMs} ms`)), timeoutMs);
    });
    ws.addEventListener("message", (ev) => this.onMessage(typeof ev.data === "string" ? ev.data : ""));
    // The socket closing lands after the records that came before it are opened and handed on,
    // as `relay.close` does: a server that ends the tunnel and drops the socket at once must not
    // lose its last words (a node's `node.leave {reason: revoked}`).
    ws.addEventListener("close", (ev) => {
      this.inbound = this.inbound.then(() => this.onClosed(ev.code, ev.reason));
    });
    ws.addEventListener("error", () => {
      if (!this.tunnel) this.onClosed(1006, "relay: connection failed");
    });
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          ws.addEventListener("open", () => resolve(), { once: true });
          ws.addEventListener("close", (ev) => reject(new PeerSessionError("unavailable", `relay: closed before auth (${ev.code} ${ev.reason})`)), { once: true });
          ws.addEventListener("error", () => reject(new PeerSessionError("unavailable", "relay: connection failed")), { once: true });
        }),
        timeout,
      ]);
      const grant = this.opts.grant;
      if (!grant && this.opts.token === undefined) throw new PeerSessionError("invalid", "relay: a token or a grant is needed");
      const authParams = grant ? { grant: grant.grant, verifier: grant.verifier } : { token: this.opts.token };
      const auth = (await Promise.race([this.request("relay.auth", authParams), timeout])) as { peer?: unknown; subject?: unknown; login?: unknown };
      if (typeof auth?.peer !== "string" || !auth.peer) throw new PeerSessionError("invalid", "relay: a malformed auth answer");
      if (!grant && auth.peer !== this.opts.peer) throw new PeerSessionError("denied", "relay: the token names another peer");
      const peer = auth.peer;
      this.peer = peer;
      if (typeof auth.subject === "string" && typeof auth.login === "string") this.account = { subject: auth.subject, login: auth.login };
      const eph = await ephemeral(this.opts.curve);
      const openParams = { epk: eph.publicKey, ...(this.opts.curve ? { curve: this.opts.curve } : {}), ...(this.opts.node ? { node: this.opts.node } : {}) };
      const opened = (await Promise.race([this.request("relay.open", openParams), timeout])) as { peer?: unknown; epk?: unknown; name?: unknown };
      if (typeof opened?.peer !== "string" || typeof opened.epk !== "string") throw new PeerSessionError("invalid", "relay: a malformed open answer");
      this.tunnel = await derive("initiator", eph, opened.epk, this.opts.psk, { kind: this.opts.kind ?? (grant ? "pair" : "controller"), peer });
      this.node = opened.peer;
      if (typeof opened.name === "string") this.nodeName = opened.name;
      return { peer: opened.peer };
    } catch (e) {
      this.close(1000, "setup failed");
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.n;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  private onMessage(text: string): void {
    let m: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    try {
      m = JSON.parse(text) as typeof m;
    } catch {
      return;
    }
    if (typeof m.method === "string") {
      const p = (m.params ?? {}) as { peer?: unknown; frame?: unknown; reason?: unknown };
      if (m.method === "relay" && typeof p.frame === "string" && this.tunnel) {
        const t = this.tunnel;
        const frame = p.frame;
        this.inbound = this.inbound
          .then(() => t.open(frame))
          .then((inner) => {
            this.events.onText?.(inner);
          })
          .catch((e: unknown) => {
            this.close(PEER_BAD_RECORD, e instanceof TunnelError ? e.message : "a record failed to open");
          });
        return;
      }
      if (m.method === "relay.close") {
        const reason = typeof p.reason === "string" ? p.reason : "tunnel closed";
        this.inbound = this.inbound.then(() => this.close(PEER_GONE, reason));
      }
      return;
    }
    if (typeof m.id === "number") {
      const pending = this.pending.get(m.id);
      if (!pending) return;
      this.pending.delete(m.id);
      if (m.error !== undefined && m.error !== null) {
        const err = m.error as { message?: string; data?: { code?: string; message?: string } };
        pending.reject(new PeerSessionError(err.data?.code ?? "error", err.data?.message ?? err.message ?? "relay request failed"));
      } else pending.resolve(m.result);
    }
  }

  /** Seals one frame of the inner protocol and sends it; the order of calls is the order on the wire. */
  send(text: string): void {
    const t = this.tunnel;
    if (!t || this.closed || !this.node) return;
    const peer = this.node;
    this.sealing++;
    void t
      .seal(text)
      .then((frame) => {
        this.sealing--;
        if (this.closed) return;
        const wire = JSON.stringify({ jsonrpc: "2.0", method: "relay", params: { peer, frame } });
        this.lastFrame = wire.length;
        this.ws?.send(wire);
      })
      .catch((e: unknown) => {
        this.sealing--;
        this.close(1000, e instanceof TunnelError ? e.message : "seal failed");
      });
  }

  private onClosed(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new PeerSessionError("unavailable", `relay: closed (${code} ${reason})`));
    this.pending.clear();
    this.events.onClose?.(code, reason);
  }

  close(code = 1000, reason = "closed"): void {
    const ws = this.ws;
    const wasOpen = !this.closed;
    this.onClosed(code, reason);
    if (ws && wasOpen) {
      try {
        ws.close(code >= 3000 && code < 5000 ? code : 1000, reason.slice(0, 120));
      } catch {
        // already gone
      }
    }
  }
}
