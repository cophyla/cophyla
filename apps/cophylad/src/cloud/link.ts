// The server link: one outbound WebSocket to `<url>/ws/link`, JSON-RPC on the daemon's own
// peer, `auth` first with the account token, reconnected with backoff for as long as there
// is a token. Requests on it are the hosted capabilities and the entitlement refresh; the
// notices about a request in flight (`llm.delta`, `tts.delta`) are routed to it by id, and
// `entitlement.updated`, `registry.primary` and the relay's frames go to the owner. The
// server asks one thing of the daemon, `relay.open`, served through `onRequest`. A refused
// `auth` keeps the link retrying at the slowest pace: the token may be revoked, or the
// server may be having a moment.

import { RpcError } from "@cophyla/protocol";
import type { RpcId } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import { RpcPeer } from "../rpc/peer.ts";
import { wsPeer } from "../rpc/ws.ts";

export interface ServerLinkDeps {
  /** The server's origin, `https://…` (or `http://` on loopback, or with `allowInsecure`). */
  url: string;
  token: () => string | undefined;
  node: string;
  log: Logger;
  reconnectMs: number;
  reconnectMaxMs: number;
  requestTimeoutMs: number;
  allowInsecure: boolean;
  /** How long the socket and the auth may take together. */
  helloTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onUp?: (auth: { subject: string; expiresAt: number }) => void;
  onDown?: (reason: string) => void;
  /** The server refused the token: a revoke, or an account that is gone. */
  onAuthRefused?: (message: string) => void;
  /** A frame that is not about a request in flight: `entitlement.updated`, `registry.primary`, the relay's `relay` and `relay.close`. */
  onFrame?: (method: string, params: unknown) => void;
  /** A request the server makes of this daemon: `relay.open` for a tunnel ending here. Absent, every one answers `unsupported`. */
  onRequest?: (method: string, params: unknown) => Promise<unknown>;
}

export interface LinkRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Hears every notice carrying this request's id. */
  onNotice?: (method: string, params: unknown) => void;
}

interface Active {
  ws: WebSocket;
  rpc: RpcPeer;
}

export type LinkState = "off" | "connecting" | "up" | "refused";

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True for `https:` anywhere and `http:` on loopback. */
export function serverUrlAllowed(url: string, allowInsecure: boolean): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  if (u.protocol !== "http:") return false;
  return allowInsecure || u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1" || u.hostname === "[::1]";
}

export class ServerLink {
  private deps: ServerLinkDeps;
  private log: Logger;
  private active?: Active;
  private stateValue: LinkState = "off";
  private closed = false;
  private loop?: Promise<void>;
  private wake?: () => void;
  /** Gives up the connect under way, for a close that must not wait out its timeout. */
  private abortOpen?: () => void;
  private notices = new Map<string, (method: string, params: unknown) => void>();
  private backoffMs: number;
  /** Sockets opened, for the tests. */
  attempts = 0;

  constructor(deps: ServerLinkDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.backoffMs = deps.reconnectMs;
  }

  get state(): LinkState {
    return this.stateValue;
  }

  get connected(): boolean {
    return this.stateValue === "up";
  }

  /** Starts the connect loop; a second call while it runs only wakes it. */
  connect(): void {
    this.closed = false;
    if (this.loop) {
      this.wake?.();
      return;
    }
    this.loop = this.run().finally(() => {
      this.loop = undefined;
    });
  }

  /** Closes the socket and stops reconnecting until `connect` is called again. */
  async close(reason = "closed"): Promise<void> {
    this.closed = true;
    this.dropActive(reason);
    this.abortOpen?.();
    this.wake?.();
    await this.loop;
    this.stateValue = "off";
  }

  /** Ends the backoff wait now, for a token that just arrived. */
  retryNow(): void {
    this.backoffMs = this.deps.reconnectMs;
    this.wake?.();
  }

  private dropActive(reason: string): void {
    const a = this.active;
    if (!a) return;
    this.active = undefined;
    a.rpc.close(reason);
    try {
      a.ws.close();
    } catch {
      // already closed
    }
  }

  private async run(): Promise<void> {
    const sleep = this.deps.sleep ?? defaultSleep;
    while (!this.closed) {
      const token = this.deps.token();
      if (!token) {
        this.stateValue = "off";
        return;
      }
      this.stateValue = "connecting";
      let refused = false;
      try {
        const auth = await this.open(token).finally(() => (this.abortOpen = undefined));
        this.backoffMs = this.deps.reconnectMs;
        this.stateValue = "up";
        this.log.info("server link up", { subject: auth.subject, url: this.deps.url });
        this.deps.onUp?.(auth);
        const reason = await this.waitClosed();
        if (this.stateValue === "up") this.stateValue = "connecting";
        this.log.info("server link down", { reason });
        this.deps.onDown?.(reason);
      } catch (e) {
        const err = e instanceof RpcError ? e : new RpcError("unavailable", e instanceof Error ? e.message : String(e));
        this.dropActive(err.message);
        if (err.code === "denied") {
          refused = true;
          this.stateValue = "refused";
          this.log.warn("server link refused the token", { message: err.message });
          this.deps.onAuthRefused?.(err.message);
        } else {
          this.log.info("server link not up", { code: err.code, message: err.message });
        }
        this.deps.onDown?.(err.message);
      }
      if (this.closed) break;
      const wait = refused ? this.deps.reconnectMaxMs : this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, this.deps.reconnectMaxMs);
      await Promise.race([sleep(wait), new Promise<void>((r) => (this.wake = r))]);
      this.wake = undefined;
    }
    this.stateValue = "off";
  }

  private waitClosed(): Promise<string> {
    return new Promise((resolve) => {
      const a = this.active;
      if (!a) return resolve("no socket");
      a.ws.addEventListener("close", (ev) => resolve(`link closed (${ev.code} ${ev.reason})`), { once: true });
    });
  }

  private open(token: string): Promise<{ subject: string; expiresAt: number }> {
    const url = `${this.deps.url.replace(/^http/, "ws").replace(/\/$/, "")}/ws/link`;
    const timeoutMs = this.deps.helloTimeoutMs ?? 15_000;
    this.attempts++;
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        reject(new RpcError("unavailable", `${url}: ${e instanceof Error ? e.message : String(e)}`));
        return;
      }
      let settled = false;
      const giveUp = (err: RpcError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
        try {
          ws.close();
        } catch {
          // already closed
        }
      };
      const timer = setTimeout(() => giveUp(new RpcError("timeout", `${url}: no answer within ${timeoutMs} ms`)), timeoutMs);
      // A socket that never answers its upgrade fires nothing until the timeout: close() ends it now.
      this.abortOpen = () => giveUp(new RpcError("unavailable", `${url}: closed while connecting`));
      const rpc = wsPeer(ws, {
        log: this.log,
        label: "server",
        onNotification: (method, params) => this.onNotice(method, params),
        ...(this.deps.onRequest ? { onRequest: (method, params) => this.deps.onRequest!(method, params) } : {}),
      });
      ws.addEventListener("message", (ev) => rpc.onText(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8")));
      ws.addEventListener("close", (ev) => {
        rpc.close(`link closed (${ev.code} ${ev.reason})`);
        if (this.active?.rpc === rpc) this.active = undefined;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new RpcError("unavailable", `${url}: closed before auth (${ev.code} ${ev.reason})`));
        }
      });
      ws.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new RpcError("unavailable", `${url}: connection failed`));
      });
      ws.addEventListener("open", () => {
        this.active = { ws, rpc };
        rpc
          .request("auth", { token, node: this.deps.node }, { timeoutMs })
          .then((r) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const a = r as { subject?: unknown; expiresAt?: unknown };
            resolve({ subject: typeof a?.subject === "string" ? a.subject : "", expiresAt: typeof a?.expiresAt === "number" ? a.expiresAt : 0 });
          })
          .catch((e: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(e instanceof RpcError ? e : new RpcError("unavailable", e instanceof Error ? e.message : String(e)));
          });
      });
    });
  }

  private onNotice(method: string, params: unknown): void {
    const id = params !== null && typeof params === "object" ? (params as { id?: RpcId }).id : undefined;
    if (id !== undefined) {
      const h = this.notices.get(String(id));
      if (h) {
        h(method, params);
        return;
      }
    }
    this.deps.onFrame?.(method, params);
  }

  /** A request over the link; `unavailable` when it is down. */
  async request(method: string, params: unknown, opts: LinkRequestOptions = {}): Promise<unknown> {
    const a = this.active;
    if (!a || this.stateValue !== "up") throw new RpcError("unavailable", `${method}: the server link is down`, { provider: "server" });
    let key: string | undefined;
    try {
      return await a.rpc.request(method, params, {
        timeoutMs: opts.timeoutMs ?? this.deps.requestTimeoutMs,
        ...(opts.signal ? { signal: opts.signal } : {}),
        onSent: (id) => {
          key = String(id);
          if (opts.onNotice) this.notices.set(key, opts.onNotice);
        },
      });
    } finally {
      if (key !== undefined) this.notices.delete(key);
    }
  }

  /** A notification to the server: the relay's frames. False when the link is down. */
  notify(method: string, params: unknown): boolean {
    const a = this.active;
    if (!a || this.stateValue !== "up") return false;
    return a.rpc.notify(method, params);
  }

  /** The id-less send of `cancel {id}` for a request that was just aborted; best effort. */
  cancel(id: RpcId): void {
    const a = this.active;
    if (!a || this.stateValue !== "up") return;
    void a.rpc.request("cancel", { id }, { timeoutMs: 5000 }).catch(() => {});
  }

  /** Sends a request and remembers its id, so an abort can name it to the server. */
  requestCancellable(method: string, params: unknown, opts: LinkRequestOptions = {}): Promise<unknown> {
    let sentId: RpcId | undefined;
    const signal = opts.signal;
    const onAbort = () => {
      if (sentId !== undefined) this.cancel(sentId);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const a = this.active;
    if (!a || this.stateValue !== "up") {
      signal?.removeEventListener("abort", onAbort);
      return Promise.reject(new RpcError("unavailable", `${method}: the server link is down`, { provider: "server" }));
    }
    let key: string | undefined;
    return a.rpc
      .request(method, params, {
        timeoutMs: opts.timeoutMs ?? this.deps.requestTimeoutMs,
        ...(signal ? { signal } : {}),
        onSent: (id) => {
          sentId = id;
          key = String(id);
          if (opts.onNotice) this.notices.set(key, opts.onNotice);
        },
      })
      .finally(() => {
        signal?.removeEventListener("abort", onAbort);
        if (key !== undefined) this.notices.delete(key);
      });
  }
}
