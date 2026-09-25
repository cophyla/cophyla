// The view's line to its host: JSON-RPC over postMessage in the `cophyla.view/1` envelope. A
// view runs on an opaque origin with no network, so this is the only way out. Requests get
// ids in the `r<n>` namespace; the host remaps them before cophylad sees them; a signal has no
// id and gets no answer. Only messages from the parent window are read.

import type { ProtocolError, RpcMessage, RpcNotification } from "@cophyla/protocol";

export const ENVELOPE = "cophyla.view/1";

const TIMEOUT_MS = 30_000;

export class ViewRpcError extends Error {
  readonly code: ProtocolError["code"];
  readonly data: unknown;
  constructor(error: ProtocolError) {
    super(error.message);
    this.name = "ViewRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: ViewRpcError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HostRpc {
  private n = 0;
  private pending = new Map<string, Pending>();
  private handlers = new Set<(n: RpcNotification) => void>();

  constructor() {
    window.addEventListener("message", (ev) => this.onMessage(ev));
  }

  onNotification(handler: (n: RpcNotification) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** A signal: a notification the host forwards within the view's scopes, with no answer. */
  signal(method: string, params: unknown): void {
    const frame: RpcMessage = { jsonrpc: "2.0", method, params };
    window.parent.postMessage({ cophyla: ENVELOPE, frame }, "*");
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = `r${++this.n}`;
    const frame: RpcMessage = params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ViewRpcError({ code: "timeout", message: `${method} did not answer`, retryable: true }));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      window.parent.postMessage({ cophyla: ENVELOPE, frame }, "*");
    });
  }

  private onMessage(ev: MessageEvent): void {
    if (ev.source !== window.parent) return;
    const data = ev.data as { cophyla?: unknown; frame?: unknown } | null;
    if (!data || typeof data !== "object" || data.cophyla !== ENVELOPE || !data.frame || typeof data.frame !== "object") return;
    const frame = data.frame as RpcMessage;
    if ("method" in frame) {
      if ("id" in frame) return; // the host sends the view no requests
      for (const h of this.handlers) h(frame);
      return;
    }
    if (typeof frame.id !== "string") return;
    const p = this.pending.get(frame.id);
    if (!p) return;
    this.pending.delete(frame.id);
    clearTimeout(p.timer);
    if ("error" in frame) {
      p.reject(new ViewRpcError(frame.error.data ?? { code: "unavailable", message: frame.error.message, retryable: false }));
    } else {
      p.resolve(frame.result);
    }
  }
}
