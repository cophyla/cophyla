// A teammate as the primary keeps it: one `kv` row under `teammates`, by its id, holding what
// the client row shows and what it never does: the pending invite's secret's hash and
// throwaway peer, the key the two sides' tunnels are keyed from, the relay peer this side
// minted for the other to reach it by, the far side's own peer and token, the places shared
// when it was made (for an exclude share, so a workspace that appears later is told apart),
// and the messages waiting for the far side to be reached. The rows replicate to the backups;
// they are reserved from the brain and kept out of the cloud backup (`grants/namespaces.ts`).

import type { ConnectionRelay, Teammate, TeammateShare, TeammateTheirs } from "@cophyla/protocol";
import { TEAMMATES_KV_NS } from "../grants/namespaces.ts";
import type { Store } from "../store/index.ts";

/** A message of this side's waiting for the far side to be reached. */
export interface TeamQueued {
  id: string;
  to: string;
  text: string;
  replyTo?: string;
  from: { name: string; harness?: string };
  at: number;
  /** The session that sent it, told if it never goes. */
  sender: string;
}

export interface TeammateRow {
  id: string;
  state: "pending" | "active";
  createdAt: number;
  expiresAt?: number;
  acceptedAt?: number;
  share: TeammateShare;
  /** An exclude share: the places there were when it was made, by key; any other is new, and shared closed. */
  known?: string[];
  theirs?: TeammateTheirs;
  invite?: { secretHash: string; peer: string };
  key?: string;
  inbound?: string;
  outbound?: ConnectionRelay;
  /** The far side: the account and login the server vouched for. */
  peer?: { user: string; subject: string };
  sent: number;
  received: number;
  lastAt?: number;
  seenAt?: number;
  outbox: TeamQueued[];
}

/** The row a client sees: no key, no token, no secret, no queued text. */
export function clientTeammate(row: TeammateRow): Teammate {
  return {
    id: row.id,
    state: row.state,
    ...(row.peer ? { user: row.peer.user } : {}),
    share: row.share,
    ...(row.theirs ? { theirs: row.theirs } : {}),
    createdAt: row.createdAt,
    ...(row.state === "pending" && row.expiresAt !== undefined ? { expiresAt: row.expiresAt } : {}),
    ...(row.acceptedAt !== undefined ? { acceptedAt: row.acceptedAt } : {}),
    ...(row.lastAt !== undefined ? { lastAt: row.lastAt } : {}),
    ...(row.seenAt !== undefined ? { seenAt: row.seenAt } : {}),
    sent: row.sent,
    received: row.received,
    ...(row.outbox.length > 0 ? { queued: row.outbox.length } : {}),
  };
}

const SELF = "self";

export class TeammateStore {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  get(id: string): TeammateRow | undefined {
    if (id === SELF) return undefined;
    const v = this.store.kv.get(TEAMMATES_KV_NS, id) as TeammateRow | undefined;
    return v ? { ...v, outbox: v.outbox ?? [] } : undefined;
  }

  list(): TeammateRow[] {
    const rows: TeammateRow[] = [];
    for (const id of this.store.kv.list(TEAMMATES_KV_NS)) {
      const row = this.get(id);
      if (row) rows.push(row);
    }
    return rows;
  }

  put(row: TeammateRow): void {
    this.store.kv.put(TEAMMATES_KV_NS, row.id, row);
  }

  delete(id: string): boolean {
    return this.store.kv.delete(TEAMMATES_KV_NS, id);
  }

  byInbound(peer: string): TeammateRow | undefined {
    return this.list().find((r) => r.state === "active" && r.inbound === peer);
  }

  byInvitePeer(peer: string): TeammateRow | undefined {
    return this.list().find((r) => r.state === "pending" && r.invite?.peer === peer);
  }

  bySubject(subject: string): TeammateRow | undefined {
    return this.list().find((r) => r.state === "active" && r.peer?.subject === subject);
  }

  byLogin(login: string): TeammateRow | undefined {
    const l = login.toLowerCase();
    return this.list().find((r) => r.state === "active" && r.peer?.user.toLowerCase() === l);
  }
}
