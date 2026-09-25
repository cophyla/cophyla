// The LAN leg of the native app: a socket the Kotlin plugin holds, because the web view's
// own `WebSocket` cannot pin a self-signed certificate. At pairing the plugin accepts any
// self-signed leaf and reports the SPKI hash of its key; the credential keeps that hash and
// every later socket is opened with it as the pin, so a node whose key changed is refused
// (`pin_mismatch`) and never accepted on the quiet: the user pairs again. The node keeps its
// key across certificates made again for a new address, so the pin outlives those.

import type { NodeAddress } from "../pairing.ts";
import type { Duplex, Transport } from "../transport.ts";

/** What the Kotlin plugin exposes, as the JS side sees it. Several sockets may be open at once, told apart by `id`. */
export interface CophylaSocketPlugin {
  attach(options: { id: string; url: string; pin?: string }): Promise<void>;
  send(options: { id: string; frame: string }): Promise<void>;
  close(options: { id: string; code?: number; reason?: string }): Promise<void>;
  addListener(event: "frame", fn: (e: FrameEvent) => void): Promise<{ remove(): Promise<void> }>;
  addListener(event: "state", fn: (e: StateEvent) => void): Promise<{ remove(): Promise<void> }>;
}

export interface FrameEvent {
  id: string;
  frame: string;
}

export interface StateEvent {
  id: string;
  state: "open" | "closed" | "error";
  /** On `open` without a pin: the SPKI SHA-256 (base64) of the leaf the socket accepted. */
  spki?: string;
  code?: number;
  reason?: string;
}

export const PIN_MISMATCH = "pin_mismatch";
export const PIN_MISMATCH_MESSAGE = "the node's certificate changed — pair again";

export interface NativeTransportOptions {
  /** The pin, when the credential has one; absent at pairing. */
  pin?: string;
  /** The key learned at pairing, once the socket opened without a pin. */
  onSpki?: (spki: string) => void;
  timeoutMs?: number;
  ids?: () => string;
}

export function lanUrl(node: NodeAddress): string {
  return `wss://${node.host}:${node.port}/ws/client`;
}

let seq = 0;

/**
 * A transport over the plugin. A `pin_mismatch` is remembered: every later open on this
 * transport fails at once without a socket, since retrying a changed certificate is not a
 * decision the app may make for the user.
 */
export function nativeTransport(node: NodeAddress, plugin: CophylaSocketPlugin, opts: NativeTransportOptions = {}): Transport & { mismatched: boolean } {
  const url = lanUrl(node);
  const self = {
    kind: "lan" as const,
    label: url,
    mismatched: false,
    open: (): Promise<Duplex> =>
      new Promise<Duplex>((resolve, reject) => {
        if (self.mismatched) {
          reject(new Error(PIN_MISMATCH_MESSAGE));
          return;
        }
        const id = opts.ids ? opts.ids() : `s${++seq}`;
        const timeoutMs = opts.timeoutMs ?? 4000;
        let settled = false;
        let frameHandle: { remove(): Promise<void> } | undefined;
        let stateHandle: { remove(): Promise<void> } | undefined;
        const duplex: Duplex = {
          send: (text) => void plugin.send({ id, frame: text }).catch(() => undefined),
          // the plugin's socket does not say what it holds
          buffered: () => 0,
          close: (code, reason) => void plugin.close({ id, ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) }).catch(() => undefined),
          onmessage: null,
          onclose: null,
        };
        const cleanup = () => {
          void frameHandle?.remove();
          void stateHandle?.remove();
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          void plugin.close({ id, code: 1000, reason: "timeout" }).catch(() => undefined);
          reject(new Error(`no answer from ${url} within ${timeoutMs} ms`));
        }, timeoutMs);
        void (async () => {
          frameHandle = await plugin.addListener("frame", (e) => {
            if (e.id === id) duplex.onmessage?.(e.frame);
          });
          stateHandle = await plugin.addListener("state", (e) => {
            if (e.id !== id) return;
            if (e.state === "open") {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (!opts.pin && e.spki) opts.onSpki?.(e.spki);
              resolve(duplex);
              return;
            }
            // closed or error
            const reason = e.reason ?? "";
            if (reason === PIN_MISMATCH) self.mismatched = true;
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              cleanup();
              reject(new Error(reason === PIN_MISMATCH ? PIN_MISMATCH_MESSAGE : reason || `closed ${e.code ?? ""}`.trim()));
              return;
            }
            cleanup();
            duplex.onclose?.(e.code ?? 1006, reason);
          });
          try {
            await plugin.attach({ id, url, ...(opts.pin ? { pin: opts.pin } : {}) });
          } catch (e) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cleanup();
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        })();
      }),
  };
  return self;
}
