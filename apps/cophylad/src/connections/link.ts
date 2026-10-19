// A connection's tunnels. Each end sends on a tunnel it opens itself: a relay peer socket
// holding the token the other end minted it, through the server to the other user's
// primary, sealed with the key the two share (the invite's secret, while it is redeemed).
// What arrives is served from one table each, the invite's or the live connection's, and
// nothing else is answered on it. A tunnel opened to send closes after a little while idle,
// so an idle connection holds nothing open on the relay.

import { PeerSession } from "@cophyla/relay";
import type { Psk } from "@cophyla/relay";
import { RpcError } from "@cophyla/protocol";
import type { ConnectionRelay } from "@cophyla/protocol";
import type { NodeSocket, NodeSocketHandler } from "../api/server.ts";
import type { Logger } from "../log.ts";
import type { LinkSocket } from "../nodes/outbound.ts";
import { RpcPeer } from "../rpc/peer.ts";

/** Opens a tunnel to the far end of a connection: a relay peer socket holding its token, keyed from `psk`. */
export type Dial = (relay: ConnectionRelay, psk: Psk) => Promise<LinkSocket>;

/** How long a tunnel this end opened stays up with nothing on it. */
export const IDLE_MS = 2 * 60_000;
/** How long the far end may take to answer one request. */
export const REQUEST_MS = 20_000;

/** The relay, as a connection's end dials it. */
export const dialRelay: Dial = async (relay, psk) => {
  const texts: string[] = [];
  let listener: ((t: string) => void) | undefined;
  const closers: ((code: number, reason: string) => void)[] = [];
  let ended: { code: number; reason: string } | undefined;
  const session = new PeerSession(
    { url: relay.url, token: relay.token, peer: relay.peer, psk, kind: "connection" },
    {
      onText: (t) => (listener ? listener(t) : void texts.push(t)),
      onClose: (code, reason) => {
        if (ended) return;
        ended = { code, reason };
        for (const fn of closers.splice(0)) fn(code, reason);
      },
    },
  );
  try {
    await session.connect();
  } catch (e) {
    const code = (e as { code?: string }).code;
    throw new RpcError(code === "denied" ? "denied" : "unavailable", e instanceof Error ? e.message : String(e), { provider: "server" });
  }
  return {
    send: (text) => {
      if (!session.open) return false;
      session.send(text);
      return true;
    },
    close: (code = 1000, reason = "closed") => session.close(code, reason),
    onMessage: (fn) => {
      listener = fn;
      for (const t of texts.splice(0)) fn(t);
    },
    onClose: (fn) => {
      if (ended) fn(ended.code, ended.reason);
      else closers.push(fn);
    },
    remote: "relay:connection",
  };
};

/**
 * Whether a failed dial says the far end no longer has the connection: its token revoked, or
 * its Cophyla refusing the tunnel. Anything else is the far end out of reach for now.
 */
export function farEnded(e: unknown): boolean {
  if (!(e instanceof RpcError) || e.code !== "denied") return false;
  return /unknown or revoked|no such connection/i.test(e.message);
}

/** An `RpcPeer` over a tunnel this end opened: requests out, nothing served. */
export function clientOver(sock: LinkSocket, log: Logger, label: string): RpcPeer {
  const rpc = new RpcPeer({
    write: (text) => sock.send(text),
    log,
    label,
    onRequest: (method) => {
      throw new RpcError("unsupported", `unsupported: ${method}`);
    },
  });
  sock.onMessage((t) => rpc.onText(t));
  sock.onClose((code, reason) => rpc.close(`the tunnel closed (${code} ${reason})`));
  return rpc;
}

/** Serves a tunnel the far end opened, from `serve` alone; `closed` hears its end. */
export function serveOver(sock: NodeSocket, log: Logger, label: string, serve: (method: string, params: unknown) => Promise<unknown>, closed: () => void): NodeSocketHandler {
  const rpc = new RpcPeer({
    write: (text) => {
      sock.send(text);
      return true;
    },
    log,
    label,
    onRequest: (method, params) => serve(method, params),
    // nothing on a connection's tunnel is a notification
    onNotification: () => undefined,
  });
  let done = false;
  return {
    message: (text) => rpc.onText(text),
    close: () => {
      if (done) return;
      done = true;
      rpc.close("the tunnel closed");
      closed();
    },
  };
}
