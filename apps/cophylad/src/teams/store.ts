// The teams as the primary keeps them, under kv namespace `teams`: this account's team keys
// (`keys`), each team's chain as this side checked it with what this side shares with it
// (`team:<id>`), and the invites waiting for the user (`offer:<invite>`). The rows replicate to
// the backups; they are reserved from the brain and kept out of the cloud backup
// (`grants/namespaces.ts`): the private keys are the account's alone.

import type { TeamEntry, TeamInviteCode, TeamKeyPair, TeammateShare, TeamOffer } from "@cophyla/protocol";
import { TEAMS_KV_NS } from "../grants/namespaces.ts";
import type { Store } from "../store/index.ts";

/** This account's team keys: made once for the account they name, on its primary. */
export interface TeamKeysRow {
  subject: string;
  kp: TeamKeyPair;
  at: number;
}

export interface TeamRow {
  id: string;
  /** The chain as this side took it, every change checked. */
  entries: TeamEntry[];
  /** What this side shares with the team. */
  share: TeammateShare;
  /** An exclude share: the places there were when it was set, by key; any other is new, and shared closed. */
  known?: string[];
  joinedAt: number;
  /** Why the chain could not be read further, or where another member's copy disagrees. */
  warning?: string;
  /** The members this side told how to reach it, by account: the relay peer told. */
  told?: Record<string, string>;
  /** The members this side handed the team's chat to, by account. */
  handed?: Record<string, true>;
  /** A teammate pair made a team: the other's account, made admin once they joined. */
  pair?: string;
  /** When each member's side was last asked where the chain stands, by account. */
  heads?: Record<string, number>;
}

/** An invite the user may take or turn down: the offer as the apps see it, and the code behind it. */
export interface OfferRow {
  offer: TeamOffer;
  code: TeamInviteCode;
  /** A teammate pair's own team: taken at once, with what this side shares with them now. */
  carry?: boolean;
  /** The teammate whose Cophyla handed it over. */
  from?: string;
}

/** A teammate pair this side moved into a team, and when it last tried: the far side may be older than teams. */
export interface PairMove {
  teammate: string;
  team?: string;
  at: number;
}

const KEYS = "keys";
const team = (id: string) => `team:${id}`;
const offer = (id: string) => `offer:${id}`;
const pair = (id: string) => `pair:${id}`;

export class TeamStore {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  keys(): TeamKeysRow | undefined {
    return this.store.kv.get(TEAMS_KV_NS, KEYS) as TeamKeysRow | undefined;
  }

  putKeys(row: TeamKeysRow): void {
    this.store.kv.put(TEAMS_KV_NS, KEYS, row);
  }

  get(id: string): TeamRow | undefined {
    return this.store.kv.get(TEAMS_KV_NS, team(id)) as TeamRow | undefined;
  }

  list(): TeamRow[] {
    const out: TeamRow[] = [];
    for (const k of this.store.kv.list(TEAMS_KV_NS)) {
      if (!k.startsWith("team:")) continue;
      const r = this.store.kv.get(TEAMS_KV_NS, k) as TeamRow | undefined;
      if (r) out.push(r);
    }
    return out;
  }

  put(row: TeamRow): void {
    this.store.kv.put(TEAMS_KV_NS, team(row.id), row);
  }

  delete(id: string): void {
    this.store.kv.delete(TEAMS_KV_NS, team(id));
  }

  offer(id: string): OfferRow | undefined {
    return this.store.kv.get(TEAMS_KV_NS, offer(id)) as OfferRow | undefined;
  }

  offers(): OfferRow[] {
    const out: OfferRow[] = [];
    for (const k of this.store.kv.list(TEAMS_KV_NS)) {
      if (!k.startsWith("offer:")) continue;
      const r = this.store.kv.get(TEAMS_KV_NS, k) as OfferRow | undefined;
      if (r) out.push(r);
    }
    return out;
  }

  putOffer(row: OfferRow): void {
    this.store.kv.put(TEAMS_KV_NS, offer(row.offer.id), row);
  }

  dropOffer(id: string): void {
    this.store.kv.delete(TEAMS_KV_NS, offer(id));
  }

  pairMove(teammate: string): PairMove | undefined {
    return this.store.kv.get(TEAMS_KV_NS, pair(teammate)) as PairMove | undefined;
  }

  putPairMove(row: PairMove): void {
    this.store.kv.put(TEAMS_KV_NS, pair(row.teammate), row);
  }
}
