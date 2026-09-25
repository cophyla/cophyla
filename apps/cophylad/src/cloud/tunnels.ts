// The tunnels this daemon ends. Three kinds arrive through the server (`relay.open`, the one
// request the server makes): a paired phone's, keyed from that phone's pairing secret and
// served by the api exactly like a socket on the LAN listener (or, for the throwaway peer of
// a phone's invite, keyed from the invite's secret as an enrollment is, and served as a
// socket that answers `invite.redeem` alone); a node's, keyed from its own grant's key (or,
// for a throwaway invite peer, from the invite's secret) and handed to the nodes module as
// a link sealed already; and, since 12.1, a phone pairing through the
// account, which the server says signed in to this node's own account: keyed from the
// public pairing constant, since the two ends share nothing yet, and served by the api as a
// socket that answers `pair.account` alone. A node's own tunnel to its primary is not opened
// here: it is a relay peer of its own grant (`nodes/sealed-link.ts`), on a socket of its own,
// needing no account. Each tunnel is a `SealedSocket` over the server link: the daemon is the
// only decryptor, what reaches the api or the nodes module is the inner protocol's text,
// what reaches the link is a record, and the server sees nothing else. A record that fails
// to open ends its tunnel: the far end lacks the secret, or the stream was tampered with.
//
// What leaves a tunnel marked urgent (a phone's speech and voice state) goes ahead of the
// rest queued in its sealed socket.

import { RpcError } from "@cophyla/protocol";
import type { RelayCurve } from "@cophyla/protocol";
import { derive, ephemeral, pairingPsk, pskFromHex, SEALED_BAD_RECORD, SealedSocket } from "@cophyla/relay";
import type { Psk, SealedKind } from "@cophyla/relay";
import type { Logger } from "../log.ts";
import type { NodeSocket, NodeSocketHandler } from "../api/server.ts";

/** The close code a tunnel's inner socket gets when the tunnel ends under it. */
export const TUNNEL_CLOSED = 4409;

export interface TunnelLink {
  notify(method: string, params: unknown): boolean;
  request(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
}

/** A phone redeeming its invite on the invite's own peer: the tunnel is keyed from the invite's secret, as an enrollment. */
export interface InviteTunnel {
  psk: Psk;
  accept: (sock: NodeSocket) => NodeSocketHandler;
}

/** A relayed node link this node takes: how it is sealed, and who serves it. */
export interface NodeTunnel {
  kind: SealedKind;
  psk: Psk;
  accept: (sock: NodeSocket) => NodeSocketHandler;
}

export interface TunnelsDeps {
  log: Logger;
  link: TunnelLink;
  /** The pairing secret of one of this node's controllers, or nothing when the id is not one of ours. */
  controllerKey: (peer: string) => string | undefined;
  /** Serves a relayed phone like a socket on a listener; absent until the api is up. */
  acceptClient: () => ((sock: NodeSocket) => NodeSocketHandler) | undefined;
  /** A relayed node link for the peer, a grant's or an invite's; throws `denied` when this node takes none for it. */
  acceptNode: (peer: string) => NodeTunnel;
  /** A phone's invite redeemed through its throwaway peer; nothing when the peer is no open invite's. */
  acceptInvite?: (peer: string) => InviteTunnel | undefined;
  /** Serves a phone pairing through the account; absent while the api is down or `[controller] account_pairing` is off. */
  acceptPairing: () => ((sock: NodeSocket, pairing: { login: string }) => NodeSocketHandler) | undefined;
  /** The account this node is signed in to: a pairing must name it. */
  subject: () => string | undefined;
}

type OpenKind = "controller" | "pair" | SealedKind;

interface Open {
  peer: string;
  kind: OpenKind;
  sealed: SealedSocket;
  handler?: NodeSocketHandler;
}

export class Tunnels {
  private deps: TunnelsDeps;
  private open = new Map<string, Open>();

  constructor(deps: TunnelsDeps) {
    this.deps = deps;
  }

  get size(): number {
    return this.open.size;
  }

  /** The peers with a tunnel open, for the tests and the status line. */
  peers(): { peer: string; kind: OpenKind }[] {
    return [...this.open.values()].map((o) => ({ peer: o.peer, kind: o.kind }));
  }

  // --- the responder: the server asks this node to accept a tunnel ---------------------------

  /** `relay.open` from the server: derives the keys and serves the far end; answers this node's ephemeral key. */
  async accept(params: unknown): Promise<{ epk: string }> {
    const p = (params ?? {}) as { peer?: unknown; kind?: unknown; epk?: unknown; curve?: unknown; subject?: unknown; login?: unknown };
    if (typeof p.peer !== "string" || typeof p.epk !== "string" || (p.kind !== "controller" && p.kind !== "node" && p.kind !== "pair")) throw new RpcError("invalid", "relay.open: peer, kind and epk required");
    if (p.curve !== undefined && p.curve !== "x25519" && p.curve !== "p256") throw new RpcError("invalid", "relay.open: unknown curve");
    const curve = p.curve as RelayCurve | undefined;
    const peer = p.peer;
    let kind: OpenKind;
    let psk: Psk;
    let accept: (sock: NodeSocket) => NodeSocketHandler;
    if (p.kind === "controller") {
      const key = this.deps.controllerKey(peer);
      const invite = key ? undefined : this.deps.acceptInvite?.(peer);
      if (key) {
        const client = this.deps.acceptClient();
        if (!client) throw new RpcError("unavailable", "the api is not up", { provider: "node" });
        kind = "controller";
        psk = pskFromHex(key);
        accept = client;
      } else if (invite) {
        kind = "enroll";
        psk = invite.psk;
        accept = invite.accept;
      } else {
        throw new RpcError("denied", "no such controller on this node");
      }
    } else if (p.kind === "pair") {
      if (typeof p.subject !== "string" || typeof p.login !== "string") throw new RpcError("invalid", "relay.open: a pairing names the account");
      const own = this.deps.subject();
      if (!own || p.subject !== own) throw new RpcError("denied", "the phone signed in to another account");
      const pairing = this.deps.acceptPairing();
      if (!pairing) throw new RpcError("denied", "this node does not pair through the account");
      const login = p.login;
      kind = "pair";
      psk = await pairingPsk();
      accept = (sock) => pairing(sock, { login });
    } else {
      // A node's grant, or the throwaway peer of an invite it is redeeming: the nodes module says which, and whether it is taken here.
      const node = this.deps.acceptNode(peer);
      kind = node.kind;
      psk = node.psk;
      accept = node.accept;
    }
    const existing = this.open.get(peer);
    if (existing) existing.sealed.transportClosed(TUNNEL_CLOSED, "replaced");
    const eph = await ephemeral(curve);
    const tunnel = await derive("responder", eph, p.epk, psk, { kind, peer });
    const entry = { peer, kind } as Open;
    entry.sealed = new SealedSocket(
      tunnel,
      {
        send: (frame) => void this.deps.link.notify("relay", { peer, frame }),
        // This side ended it: the server is told, after the last record. A record that did not open says no more than that.
        close: (code, reason) => void this.deps.link.notify("relay.close", { peer, reason: code === SEALED_BAD_RECORD ? "unauthorized" : reason }),
      },
      {
        onText: (text) => entry.handler?.message(text),
        onClose: (code, reason) => this.ended(entry, code, reason),
      },
    );
    this.open.set(peer, entry);
    entry.handler = accept({
      send: (text, o) => void entry.sealed.send(text, o),
      close: (code, reason) => entry.sealed.close(code, reason),
      remote: `relay:${peer}`,
    });
    this.deps.log.info("tunnel accepted", { peer, kind, curve: eph.curve, ...(kind === "pair" ? { account: p.login } : {}) });
    return { epk: eph.publicKey };
  }

  // --- frames -----------------------------------------------------------------------------------

  /** A `relay {peer, frame}` from the server. */
  frame(peer: string, frame: string): void {
    this.open.get(peer)?.sealed.receive(frame);
  }

  /** A `relay.close {peer}` from the server: the far end or the server ended it. */
  close(peer: string, reason = "closed"): void {
    this.open.get(peer)?.sealed.transportClosed(TUNNEL_CLOSED, reason);
  }

  /** The link went down: every tunnel is over. */
  closeAll(reason: string): void {
    for (const entry of [...this.open.values()]) entry.sealed.transportClosed(TUNNEL_CLOSED, reason);
  }

  /** A tunnel is over, whichever side ended it: the inner side hears it once. */
  private ended(entry: Open, code: number, reason: string): void {
    if (this.open.get(entry.peer) === entry) this.open.delete(entry.peer);
    if (code === SEALED_BAD_RECORD) this.deps.log.warn("a relay record failed to open; the tunnel is closed", { peer: entry.peer, kind: entry.kind, error: reason });
    this.deps.log.info("tunnel closed", { peer: entry.peer, kind: entry.kind, reason, in: entry.sealed.in, out: entry.sealed.out });
    try {
      entry.handler?.close(code, reason);
    } catch (e) {
      this.deps.log.warn("tunnel close handler failed", { peer: entry.peer, error: e instanceof Error ? e.message : String(e) });
    }
  }
}
