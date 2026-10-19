// A connection as the primary keeps it: one `kv` row under `connections`, by its id, holding
// what the client row shows and what it never does: the pending invite's secret's hash and
// throwaway peer, the key the two ends' tunnels are keyed from, the relay peer this end minted
// for the other to reach it by, the far end's own peer and token, and the messages waiting
// either way. The rows replicate to the backups, so one that takes the primary role carries
// every connection on; they are reserved from the brain and kept out of the cloud backup
// (`grants/namespaces.ts`), since a restore on another install could not be reached by the
// other side anyway.

import type { Connection, ConnectionEndInfo, ConnectionPeer, ConnectionRelay, TerminalRef } from "@cophyla/protocol";
import { CONNECTIONS_KV_NS } from "../grants/namespaces.ts";
import type { Store } from "../store/index.ts";

export const CONNECTIONS_NS = CONNECTIONS_KV_NS;

/** A message waiting on one side: this end's for the far end to be reached, or the far end's for an agent to run here. */
export interface Queued {
  id: string;
  text: string;
  replyTo?: string;
  /** The end it is from as it was when sent. */
  from: ConnectionEndInfo;
  at: number;
  /** An outgoing one: the session that sent it, told if it never goes. */
  sender?: string;
}

export interface ConnectionRow {
  id: string;
  state: "pending" | "active";
  /** The machine the terminal is on. */
  node: string;
  terminal?: TerminalRef;
  /** Without a terminal, the session it lives with; with one, the last session seen there. */
  session?: string;
  by: "app" | "agent";
  createdAt: number;
  /** A pending one: until when its invite may be used, and the login alone that may use it. */
  expiresAt?: number;
  for?: string;
  invite?: { secretHash: string; peer: string };
  /** An active one: the key both ends key their tunnels from, 32 bytes as hex. */
  key?: string;
  /** The relay peer this end minted for the other to reach it by. */
  inbound?: string;
  /** How to reach the far end: its relay peer and the token it minted for this end. */
  outbound?: ConnectionRelay;
  /** The far end: the account and login the server vouched for, and its end as it last said. */
  peer?: ConnectionPeer & { subject: string };
  /** A session that runs without permission prompts may take its messages: the user said so. */
  bypassOk?: boolean;
  sent: number;
  received: number;
  lastAt?: number;
  outbox: Queued[];
  inbox: Queued[];
}

/** The row a client sees: no key, no token, no secret, no queued text. */
export function clientConnection(row: ConnectionRow, extra: { session?: string; name?: string } = {}): Connection {
  const queued = row.outbox.length + row.inbox.length;
  const session = extra.session ?? row.session;
  return {
    id: row.id,
    state: row.state,
    node: row.node,
    ...(row.terminal ? { terminal: row.terminal } : {}),
    ...(session ? { session } : {}),
    ...(extra.name ? { name: extra.name } : {}),
    ...(row.peer ? { peer: { user: row.peer.user, name: row.peer.name, ...(row.peer.harness ? { harness: row.peer.harness } : {}), ...(row.peer.live !== undefined ? { live: row.peer.live } : {}), ...(row.peer.seenAt !== undefined ? { seenAt: row.peer.seenAt } : {}) } } : {}),
    by: row.by,
    createdAt: row.createdAt,
    ...(row.state === "pending" && row.expiresAt !== undefined ? { expiresAt: row.expiresAt } : {}),
    ...(row.lastAt !== undefined ? { lastAt: row.lastAt } : {}),
    sent: row.sent,
    received: row.received,
    ...(queued > 0 ? { queued } : {}),
  };
}

/** The rows, read and written through the store's `kv`. */
export class ConnectionStore {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  get(id: string): ConnectionRow | undefined {
    const v = this.store.kv.get(CONNECTIONS_NS, id) as ConnectionRow | undefined;
    return v ? { ...v, outbox: v.outbox ?? [], inbox: v.inbox ?? [] } : undefined;
  }

  list(): ConnectionRow[] {
    const rows: ConnectionRow[] = [];
    for (const id of this.store.kv.list(CONNECTIONS_NS)) {
      const row = this.get(id);
      if (row) rows.push(row);
    }
    return rows;
  }

  put(row: ConnectionRow): void {
    this.store.kv.put(CONNECTIONS_NS, row.id, row);
  }

  delete(id: string): boolean {
    return this.store.kv.delete(CONNECTIONS_NS, id);
  }

  /** The active one the far end reaches by this relay peer. */
  byInbound(peer: string): ConnectionRow | undefined {
    return this.list().find((r) => r.state === "active" && r.inbound === peer);
  }

  /** The pending one whose invite is redeemed through this relay peer. */
  byInvitePeer(peer: string): ConnectionRow | undefined {
    return this.list().find((r) => r.state === "pending" && r.invite?.peer === peer);
  }
}
