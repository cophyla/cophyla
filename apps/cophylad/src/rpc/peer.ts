// JSON-RPC 2.0 over any text transport: requests out matched to responses by id, requests
// in answered from `onRequest`, notifications both ways. The owner feeds inbound text to
// `onText` and supplies `write`; `close` rejects everything in flight with `unavailable`.
// `StdioRpc` runs one over a child's stdio, `wsPeer` over a WebSocket, and the node link
// over both ends of `/ws/node`.

import { failure, protocolError, RpcError } from "@cophyla/protocol";
import type { ProtocolError, RpcId } from "@cophyla/protocol";
import type { Logger } from "../log.ts";

export interface RpcPeerOptions {
  /** Sends one frame; false when the transport is gone. */
  write: (text: string) => boolean;
  log: Logger;
  /** A request from the peer. Return the result; throw an `RpcError` to answer with a failure. */
  onRequest?: (method: string, params: unknown, id: RpcId) => Promise<unknown> | unknown;
  onNotification?: (method: string, params: unknown) => void;
  /** Names the peer in log lines. */
  label?: string;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Hears the id the request went out under, so a notice about it can be matched. */
  onSent?: (id: RpcId) => void;
}

interface Pending {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

/** A peer's JSON-RPC error, carried as a protocol error when it is one. */
export class ChildRpcError extends RpcError {
  readonly raw: { code: number; message: string; data?: unknown };
  constructor(raw: { code: number; message: string; data?: unknown }) {
    const data = raw.data as Partial<ProtocolError> | undefined;
    const code = data && typeof data === "object" && typeof data.code === "string" ? data.code : "unavailable";
    super(code as ProtocolError["code"], raw.message, data?.data);
    this.name = "ChildRpcError";
    this.raw = raw;
  }
}

export class RpcPeer {
  private opts: RpcPeerOptions;
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private closed = false;
  private closeReason = "closed";

  constructor(opts: RpcPeerOptions) {
    this.opts = opts;
  }

  get open(): boolean {
    return !this.closed;
  }

  /** Requests in flight to the peer. */
  get inflight(): number {
    return this.pending.size;
  }

  private label(): string {
    return this.opts.label ?? "peer";
  }

  /** Rejects everything in flight; later requests fail at once. Idempotent. */
  close(reason = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      this.settle(p);
      p.reject(new RpcError("unavailable", `${p.method}: ${reason}`));
    }
  }

  private settle(p: Pending): void {
    if (p.timer) clearTimeout(p.timer);
    if (p.onAbort) p.onAbort();
  }

  /** One inbound frame. Not JSON, or not JSON-RPC, is logged and dropped. */
  onText(text: string): void {
    if (!text.trim()) return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.opts.log.debug("non-JSON frame from peer", { peer: this.label(), text: text.slice(0, 200) });
      return;
    }
    if (m === null || typeof m !== "object") return;
    const id = m["id"];
    if (typeof m["method"] === "string") {
      const method = m["method"];
      if (id !== undefined && id !== null) {
        void this.serve(id as RpcId, method, m["params"]);
        return;
      }
      try {
        this.opts.onNotification?.(method, m["params"]);
      } catch (e) {
        this.opts.log.warn("notification handler failed", { peer: this.label(), method, error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (id === undefined || id === null) return;
    const p = this.pending.get(String(id));
    if (!p) return;
    this.pending.delete(String(id));
    this.settle(p);
    const err = m["error"];
    if (err !== undefined && err !== null) {
      const raw = err as { code?: number; message?: string; data?: unknown };
      p.reject(new ChildRpcError({ code: typeof raw.code === "number" ? raw.code : -32000, message: raw.message ?? "error", ...(raw.data !== undefined ? { data: raw.data } : {}) }));
    } else p.resolve(m["result"]);
  }

  private async serve(id: RpcId, method: string, params: unknown): Promise<void> {
    if (!this.opts.onRequest) {
      this.write(failure(id, protocolError("unsupported", `unsupported: ${method}`)));
      return;
    }
    try {
      const result = await this.opts.onRequest(method, params, id);
      this.write({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
    } catch (e) {
      if (e instanceof RpcError) {
        this.write(failure(id, e.error));
      } else {
        const message = e instanceof Error ? e.message : String(e);
        this.opts.log.warn("request handler failed", { peer: this.label(), method, error: message });
        this.write(failure(id, protocolError("unavailable", message)));
      }
    }
  }

  write(message: unknown): boolean {
    if (this.closed) return false;
    try {
      return this.opts.write(JSON.stringify(message));
    } catch (e) {
      this.opts.log.warn("write to peer failed", { peer: this.label(), error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  notify(method: string, params?: unknown): boolean {
    return this.write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  /** Sends a request. Rejects with `cancelled` on abort, `timeout` past `timeoutMs`, `unavailable` on close. */
  request(method: string, params?: unknown, opts: RequestOptions = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new RpcError("unavailable", `${method}: ${this.closeReason}`));
    if (opts.signal?.aborted) return Promise.reject(new RpcError("cancelled", `${method}: cancelled`));
    const id = this.nextId++;
    const key = String(id);
    return new Promise((resolve, reject) => {
      const p: Pending = { method, resolve, reject };
      if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
        p.timer = setTimeout(() => {
          if (this.pending.get(key) !== p) return;
          this.pending.delete(key);
          this.settle(p);
          reject(new RpcError("timeout", `${method}: no answer within ${opts.timeoutMs} ms`));
        }, opts.timeoutMs);
      }
      if (opts.signal) {
        const signal = opts.signal;
        const onAbort = () => {
          if (this.pending.get(key) !== p) return;
          this.pending.delete(key);
          if (p.timer) clearTimeout(p.timer);
          reject(new RpcError("cancelled", `${method}: cancelled`));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        p.onAbort = () => signal.removeEventListener("abort", onAbort);
      }
      this.pending.set(key, p);
      opts.onSent?.(id);
      if (!this.write(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params })) {
        this.pending.delete(key);
        this.settle(p);
        reject(new RpcError("unavailable", `${method}: ${this.closed ? this.closeReason : "write failed"}`));
      }
    });
  }
}
