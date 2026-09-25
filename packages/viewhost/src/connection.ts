// The host page's side of the link to cophylad. The shell owns the socket and the credential;
// this module receives frames and link state as Tauri events, sends frames through the
// `cophylad_send` command, and gives the host page a request/response API with ids in the
// `h<n>` namespace. DOM-free: `invoke` and `listen` are injected so the tests can fake them.

import { RpcError, RpcMessage } from "@cophyla/protocol";
import type { ClientResult, ProtocolError, RpcNotification, RpcResponse } from "@cophyla/protocol";

export type LinkState = "starting" | "connecting" | "connected" | "disconnected" | "unauthorized";

export type HelloResult = ClientResult<"hello">;

export interface LinkSnapshot {
  state: LinkState;
  hello?: HelloResult;
  since: number;
  error?: string;
  url?: string;
}

export interface TauriIo {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void>;
}

export const EVENT_FRAME = "cophylad:frame";
export const EVENT_STATE = "cophylad:state";

const DEFAULT_TIMEOUT_MS = 30_000;

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: RpcError) => void;
  timer: ReturnType<typeof setTimeout>;
}

type FrameHandler = (frame: RpcMessage) => void;
type StateHandler = (snapshot: LinkSnapshot) => void;

/** A `unavailable`/`timeout`/`invalid` error the way cophylad would word it, thrown to a caller. */
function rpcError(code: ProtocolError["code"], message: string): RpcError {
  return new RpcError(code, message);
}

export class Connection {
  state: LinkSnapshot = { state: "connecting", since: 0 };
  private io: TauriIo;
  private timeoutMs: number;
  private pending = new Map<string, Pending>();
  private n = 0;
  private frameHandlers = new Set<FrameHandler>();
  private stateHandlers = new Set<StateHandler>();
  private attached = false;

  constructor(io: TauriIo, opts: { timeoutMs?: number } = {}) {
    this.io = io;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get connected(): boolean {
    return this.state.state === "connected";
  }

  /**
   * Subscribes to the shell's events, then asks for the link's state. Idempotent. `args` go
   * to the shell with it: the desktop app says there what its page has for audio.
   */
  async attach(args?: Record<string, unknown>): Promise<LinkSnapshot> {
    if (!this.attached) {
      this.attached = true;
      await this.io.listen<string>(EVENT_FRAME, (text) => this.handleFrame(text));
      await this.io.listen<LinkSnapshot>(EVENT_STATE, (snapshot) => this.handleState(snapshot));
    }
    const snapshot = await this.io.invoke<LinkSnapshot>("cophylad_attach", args);
    this.handleState(snapshot);
    return snapshot;
  }

  /** Every frame from cophylad that is not a response to one of this module's requests. */
  onFrame(handler: FrameHandler): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  onState(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  /** Sends a frame as is; the shell refuses anything that is not an object or that says hello. */
  async send(frame: object): Promise<void> {
    try {
      await this.io.invoke<void>("cophylad_send", { frame });
    } catch (e) {
      throw rpcError(codeOf(e), messageOf(e));
    }
  }

  /** A request on the host's own connection, answered or failed within the timeout. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.connected) return Promise.reject(rpcError("unavailable", "not connected to cophylad"));
    const id = `h${++this.n}`;
    const frame = params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(rpcError("timeout", `${method} did not answer within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      this.send(frame).catch((e: RpcError) => {
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  private handleFrame(text: string): void {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return;
    }
    const parsed = RpcMessage.safeParse(value);
    if (!parsed.success) return;
    const msg = parsed.data;
    if (!("method" in msg) && msg.id !== null && typeof msg.id === "string" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      settle(p, msg);
      return;
    }
    for (const h of this.frameHandlers) h(msg);
  }

  private handleState(snapshot: LinkSnapshot): void {
    this.state = snapshot;
    if (snapshot.state !== "connected") this.failPending(`link ${snapshot.state}${snapshot.error ? `: ${snapshot.error}` : ""}`);
    for (const h of this.stateHandlers) h(snapshot);
  }

  private failPending(reason: string): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(rpcError("unavailable", `${p.method}: ${reason}`));
    }
  }
}

function settle(p: Pending, msg: RpcResponse): void {
  if ("error" in msg) {
    const data = msg.error.data;
    p.reject(data ? new RpcError(data.code, data.message, data.data) : rpcError("unavailable", msg.error.message));
    return;
  }
  p.resolve(msg.result);
}

/** The shell's command errors are `"<code>: <message>"` strings. */
function codeOf(e: unknown): ProtocolError["code"] {
  const text = messageOf(e);
  const head = text.split(":")[0]?.trim();
  return head === "denied" || head === "invalid" || head === "unavailable" ? head : "unavailable";
}

function messageOf(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

export type { RpcMessage, RpcNotification };
