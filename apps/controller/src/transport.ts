// The ways a controller reaches its node, behind one shape the link core drives: a
// WebSocket to the node's LAN listener, and a tunnel through the server relay (the same
// `@cophyla/relay` session the daemon's tests use), opened with the access the node handed
// out at pairing. Either one yields a `Duplex` that carries the client protocol's frames
// as text; what differs is how it is opened and what its loss means. Two more, used once
// each: the pairing tunnel a phone opens with its account sign-in's grant, and the tunnel of
// an invite's own relay peer, each to be handed a token.

import { pairingPsk, PeerSession, pskFromHex, pskFromSecret } from "@cophyla/relay";
import type { InviteBody, RelayAccess } from "@cophyla/protocol";

/** The LAN socket, the server relay, or a direct data channel (`direct.ts`), which only the link core opens, over the connection it has. */
export type TransportKind = "lan" | "relay" | "p2p";

/** An open connection carrying frames as text. */
export interface Duplex {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  /** Bytes written and not yet on the wire, where the transport can tell; what the microphone sheds by. */
  buffered?(): number;
  onmessage: ((text: string) => void) | null;
  onclose: ((code: number, reason: string) => void) | null;
  /** Bytes sent and not yet on the wire, where the transport can tell. */
  buffered?(): number;
}

export interface Transport {
  kind: TransportKind;
  /** What the link snapshot's `url` says while this transport carries it. */
  label: string;
  /** Resolves once frames can flow; rejects when the far end cannot be reached. */
  open(): Promise<Duplex>;
}

export interface SocketLike {
  send(data: string): void;
  readonly bufferedAmount?: number;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

/** How long a LAN socket may take to open before the relay is tried instead. */
export const LAN_OPEN_MS = 4000;

const realSocket: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

/** A WebSocket to `url`, as a transport. */
export function lanTransport(url: string, makeSocket: SocketFactory = realSocket, timeoutMs = LAN_OPEN_MS, timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void } = globalTimers()): Transport {
  return {
    kind: "lan",
    label: url,
    open: () =>
      new Promise<Duplex>((resolve, reject) => {
        let socket: SocketLike;
        try {
          socket = makeSocket(url);
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        let settled = false;
        const timer = timers.setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            socket.close();
          } catch {
            // never opened
          }
          reject(new Error(`no answer from ${url} within ${timeoutMs} ms`));
        }, timeoutMs);
        const duplex: Duplex = {
          send: (text) => socket.send(text),
          close: (code, reason) => socket.close(code, reason),
          buffered: () => socket.bufferedAmount ?? 0,
          onmessage: null,
          onclose: null,
        };
        socket.onmessage = (ev) => duplex.onmessage?.(String(ev.data));
        socket.onerror = () => {
          // a browser gives no reason; the close that follows carries it
        };
        socket.onclose = (ev) => {
          if (!settled) {
            settled = true;
            timers.clearTimeout(timer);
            reject(new Error(ev?.reason || `closed ${ev?.code ?? ""}`.trim()));
            return;
          }
          duplex.onclose?.(ev?.code ?? 1006, ev?.reason ?? "");
        };
        socket.onopen = () => {
          if (settled) return;
          settled = true;
          timers.clearTimeout(timer);
          resolve(duplex);
        };
      }),
  };
}

export interface RelayTransportOptions {
  /** A socket factory for the relay's own WebSocket; the global one by default. */
  ws?: (url: string) => WebSocket;
  timeoutMs?: number;
}

/** A tunnel through the server relay, as a transport; the node's `relay.close` ends it with 4409. */
export function relayTransport(access: RelayAccess, opts: RelayTransportOptions = {}): Transport {
  return {
    kind: "relay",
    label: `${access.url.replace(/\/$/, "")}/ws/relay`,
    open: async () => {
      const duplex: Duplex = {
        send: (text) => session.send(text),
        close: (code, reason) => session.close(code, reason),
        buffered: () => session.buffered,
        onmessage: null,
        onclose: null,
      };
      const session = new PeerSession(
        { url: access.url, token: access.token, peer: access.peer, psk: pskFromHex(access.key), ...(opts.ws ? { ws: opts.ws } : {}), ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) },
        {
          onText: (text) => duplex.onmessage?.(text),
          onClose: (code, reason) => duplex.onclose?.(code, reason),
        },
      );
      await session.connect();
      return duplex;
    },
  };
}

/**
 * The tunnel a phone pairs through after signing in with the account: the grant spent at the
 * relay's auth with the verifier the phone kept, the `pair` kind, keyed from the public
 * pairing constant, to the node the server picks. One open only: the grant is spent by it.
 */
export function pairingTransport(server: string, grant: string, verifier: string, opts: RelayTransportOptions = {}): Transport {
  return {
    kind: "relay",
    label: `${server.replace(/\/$/, "")}/ws/relay`,
    open: async () => {
      const duplex: Duplex = {
        send: (text) => session.send(text),
        close: (code, reason) => session.close(code, reason),
        onmessage: null,
        onclose: null,
      };
      const session = new PeerSession(
        { url: server, grant: { grant, verifier }, psk: await pairingPsk(), ...(opts.ws ? { ws: opts.ws } : {}), ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) },
        {
          onText: (text) => duplex.onmessage?.(text),
          onClose: (code, reason) => duplex.onclose?.(code, reason),
        },
      );
      await session.connect();
      return duplex;
    },
  };
}

/**
 * The tunnel a phone redeems an invite through: the invite's own throwaway relay peer and its
 * token, keyed from the invite's secret as an enrollment is, to the node that minted it. One
 * open only: the invite is spent by what goes over it.
 */
export function inviteTransport(relay: NonNullable<InviteBody["relay"]>, secret: string, opts: RelayTransportOptions = {}): Transport {
  return {
    kind: "relay",
    label: `${relay.url.replace(/\/$/, "")}/ws/relay`,
    open: async () => {
      const duplex: Duplex = {
        send: (text) => session.send(text),
        close: (code, reason) => session.close(code, reason),
        onmessage: null,
        onclose: null,
      };
      const session = new PeerSession(
        { url: relay.url, token: relay.token, peer: relay.peer, psk: await pskFromSecret(secret), kind: "enroll", ...(opts.ws ? { ws: opts.ws } : {}), ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) },
        {
          onText: (text) => duplex.onmessage?.(text),
          onClose: (code, reason) => duplex.onclose?.(code, reason),
        },
      );
      await session.connect();
      return duplex;
    },
  };
}

function globalTimers() {
  return {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}
