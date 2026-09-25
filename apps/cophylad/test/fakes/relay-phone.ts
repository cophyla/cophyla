// A paired phone on the server relay, played in the tests: JSON-RPC inside the end-to-end
// tunnel, keyed from the phone's pairing secret, its signals, and every notification heard.

import type { RelayAccess } from "@cophyla/protocol";
import { PeerSession, pskFromHex } from "@cophyla/relay";

export type Reply = { result?: unknown; error?: { message?: string; data?: { code: string; message: string } } };

export class RelayPhone {
  readonly notifications: { method: string; params: unknown }[] = [];
  /** Hears every notification as it comes, beside the list. */
  onNotification?: (method: string, params: unknown) => void;
  private session: PeerSession;
  private pending = new Map<number, (m: Reply) => void>();
  private n = 0;

  constructor(access: RelayAccess) {
    this.session = new PeerSession(
      { url: access.url, token: access.token, peer: access.peer, psk: pskFromHex(access.key) },
      {
        onText: (text) => {
          const m = JSON.parse(text) as { id?: number; method?: string; params?: unknown } & Reply;
          if (m.method !== undefined) {
            this.notifications.push({ method: m.method, params: m.params });
            this.onNotification?.(m.method, m.params);
          } else if (typeof m.id === "number") this.pending.get(m.id)?.(m);
        },
        onClose: () => undefined,
      },
    );
  }

  connect(): Promise<unknown> {
    return this.session.connect();
  }

  call(method: string, params: unknown = {}): Promise<Reply> {
    const id = ++this.n;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.session.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /** The result, or the error thrown. */
  async request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const r = await this.call(method, params);
    if (r.error) throw new Error(r.error.data?.message ?? r.error.message ?? "failed");
    return r.result as T;
  }

  signal(method: string, params: unknown): void {
    this.session.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  close(): void {
    this.session.close();
  }
}
