// The account's machines. Every machine signed in to one account belongs together, in one
// cluster: the one the server's registry names in every answer, its lease's holders'. A
// machine in another one joins them on its own, through the server, with no invite typed:
// alone (a new install starts a cluster of its own), it asks for an invite for itself and
// joins with it; the primary of a cluster with others asks for one for each machine it
// reaches, hands it over that machine's link (`node.move`), then joins itself, and the server
// keeps that its cluster moved in, so a machine of it that was away then and is signed in
// joins on its own when it is back (`merged`). A secondary of another cluster waits for its
// primary to move it, or for `merged`. What the machine had as a primary (its chat, tasks,
// memory and tools) is saved to a file before its own is replaced by the account's.
//
// The account is the whole of the trust, as for a phone signing in: the account's primary
// lets in a machine the server says is the account's. A machine the user took out (it left,
// or was removed) stays out until the user asks again (`joinNow`); `[nodes] account_join`
// off keeps it to invites altogether. This module decides and retries; the nodes module does
// the joining and the moving, and answers the account's own `account.invite`.

import { RpcError } from "@cophyla/protocol";
import type { GrantRole, NodeAccount } from "@cophyla/protocol";
import type { Arbiter } from "../cloud/registry.ts";
import type { Logger } from "../log.ts";

/** The store meta key: `off` while the user keeps this machine apart, else the last join, shown for a day. */
export const ACCOUNT_META = "account_join";
/** How long a join is shown after it happened. */
export const JOINED_SHOWN_MS = 24 * 3_600_000;
/** The waits between tries while the account's primary cannot be reached, longest last. */
export const RETRY_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
/** The wait after a refusal that a retry soon will not change: an older primary, a switch off there. */
export const SLOW_RETRY_MS = 10 * 60_000;

/** A machine the primary leads, as a move sees it. */
export interface Member {
  node: string;
  name: string;
  role: GrantRole;
  linked: boolean;
}

/**
 * What this machine is, for joining: `alone` in no cluster or alone in one of its own;
 * `leads` other machines as their primary; `follows` a primary as its secondary; `hands`,
 * which never joins on its own; `busy` while the role or a join is changing.
 */
export type Stance = { kind: "alone" } | { kind: "leads"; members: Member[] } | { kind: "follows" } | { kind: "hands" } | { kind: "busy" };

export interface Joined {
  primary: { id: string; name: string };
  /** Where what the machine had was saved. */
  saved?: string;
}

export interface AccountJoinDeps {
  log: Logger;
  /** `[nodes] account_join`. */
  enabled: () => boolean;
  /** The registry, when the cloud module is built. */
  arbiter: () => Arbiter | undefined;
  self: () => { id: string; name: string };
  /** The cluster this machine is in; none in no cluster. */
  cluster: () => string | undefined;
  stance: () => Stance;
  /** Joins with an invite for this machine: as `alone` or `leads` the primary's data is saved first; as `follows` what it shares is kept. */
  joinSelf: (invite: string, how: "alone" | "leads" | "follows") => Promise<Joined>;
  /** Hands a machine this one leads its invite over its link; resolves once it is in. */
  move: (member: string, invite: string) => Promise<void>;
  meta: { get(key: string): string | undefined; set(key: string, value: string): void };
  /** The state changed: this machine's row goes out again. */
  changed: () => void;
  now?: () => number;
}

/** What the server said of the account's machines last. */
interface Heard {
  cluster: string;
  merged: boolean;
}

export class AccountJoin {
  private deps: AccountJoinDeps;
  private log: Logger;
  private heard?: Heard;
  private current?: NodeAccount;
  private timer?: ReturnType<typeof setTimeout>;
  private dueAt?: number;
  private tries = 0;
  private running = false;
  private stopped = false;
  /** The account's primary by name, once the server or an invite said it. */
  private primaryName?: string;

  constructor(deps: AccountJoinDeps) {
    this.deps = deps;
    this.log = deps.log;
    const kept = deps.meta.get(ACCOUNT_META);
    if (kept === "off") this.current = { state: "off", since: this.now() };
    else if (kept) {
      try {
        const v = JSON.parse(kept) as NodeAccount;
        if (v.state === "joined" && typeof v.since === "number") this.current = v;
      } catch {
        // a value from elsewhere: nothing to show
      }
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** What this machine's row says of it: nothing while it is one of the account's machines and joined more than a day ago. */
  state(): NodeAccount | undefined {
    const c = this.current;
    if (c?.state === "joined" && this.now() - c.since > JOINED_SHOWN_MS) return undefined;
    return c;
  }

  /** Whether the user keeps this machine apart. */
  off(): boolean {
    return this.deps.meta.get(ACCOUNT_META) === "off";
  }

  private set(next: NodeAccount | undefined): void {
    const before = JSON.stringify(this.current ?? null);
    this.current = next;
    if (JSON.stringify(next ?? null) !== before) this.deps.changed();
  }

  /** Clears a passing state (joining, waiting, failed): this machine is one of the account's, or nothing is to be done. */
  private settle(): void {
    if (this.current && this.current.state !== "joined" && this.current.state !== "off") this.set(undefined);
  }

  /**
   * A registry answer or push: the account's cluster, and whether this machine's cluster was
   * moved into it. Another cluster than this machine's starts a join soon.
   */
  hear(answer: { cluster?: string; merged?: boolean }): void {
    if (this.stopped || answer.cluster === undefined) return;
    this.heard = { cluster: answer.cluster, merged: answer.merged === true || (this.heard?.cluster === answer.cluster && this.heard.merged) };
    if (answer.cluster === this.deps.cluster()) {
      this.tries = 0;
      this.clearTimer();
      // one of them again (an invite the user redeemed): kept apart no more
      if (this.off()) {
        this.deps.meta.set(ACCOUNT_META, "{}");
        this.set(undefined);
      }
      this.settle();
      return;
    }
    this.schedule(0);
  }

  /** The account's primary took the role (again): a machine waiting for it tries now. */
  kick(): void {
    if (this.stopped || !this.heard || this.heard.cluster === this.deps.cluster()) return;
    this.tries = 0;
    this.schedule(0);
  }

  /** Its primary moved this machine into the account's machines (`node.move`). */
  moved(primary: { id: string; name: string }): void {
    this.done({ primary }, [], 0);
  }

  /** The user took this machine out (it left, or was removed): it stays out until asked again. */
  keepApart(why: string): void {
    this.deps.meta.set(ACCOUNT_META, "off");
    this.clearTimer();
    this.log.info("this machine stays apart from the account's machines until asked", { why });
    this.set({ state: "off", since: this.now() });
  }

  /**
   * `node.accountJoin`: the user asks this machine to join the account's machines now. The
   * switch must be on and the server must have named another cluster than this one.
   */
  async joinNow(): Promise<void> {
    if (!this.deps.enabled()) throw new RpcError("denied", "joining through the account is off here: [nodes] account_join");
    if (this.deps.arbiter()?.active() !== true) throw new RpcError("unavailable", "not signed in, or the server cannot be reached now");
    if (this.deps.meta.get(ACCOUNT_META) === "off") this.deps.meta.set(ACCOUNT_META, "{}");
    if (this.current?.state === "off") this.set(undefined);
    if (this.heard && this.heard.cluster === this.deps.cluster()) throw new RpcError("conflict", "this machine is one of the account's machines already");
    this.tries = 0;
    this.clearTimer();
    await this.run(true);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.dueAt = undefined;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    const at = this.now() + ms;
    if (this.timer && this.dueAt !== undefined && this.dueAt <= at) return;
    this.clearTimer();
    this.dueAt = at;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.dueAt = undefined;
      void this.run(false);
    }, ms);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  private retry(slow: boolean): void {
    const ms = slow ? SLOW_RETRY_MS : RETRY_MS[Math.min(this.tries, RETRY_MS.length - 1)]!;
    this.tries++;
    this.schedule(ms);
  }

  /** One try, by what this machine is now. `asked`: the user's, which throws what it hit. */
  private async run(asked: boolean): Promise<void> {
    if (this.running || this.stopped) return;
    if (!this.deps.enabled() || (this.off() && !asked)) return;
    const arb = this.deps.arbiter();
    const heard = this.heard;
    if (!arb?.active() || !heard) return;
    const mine = this.deps.cluster();
    if (heard.cluster === mine) {
      this.settle();
      return;
    }
    const stance = this.deps.stance();
    if (stance.kind === "hands") return;
    if (stance.kind === "busy") {
      this.retry(false);
      return;
    }
    // a secondary is moved by its primary; on its own only once that primary moved without it
    if (stance.kind === "follows" && !heard.merged) {
      if (asked) throw new RpcError("conflict", "this machine is another primary's: it joins your account's machines when that primary does");
      return;
    }
    this.running = true;
    try {
      const self = this.deps.self();
      if (stance.kind === "leads") {
        this.set({ state: "moving", ...this.named(), since: this.now() });
        const left: string[] = [];
        let moved = 0;
        for (const m of stance.members) {
          if (!m.linked) {
            left.push(m.name);
            continue;
          }
          // the account's primary refusing one refuses them all: nothing has moved yet but what did, and the rest wait for the next try
          const invite = await arb.join({ id: m.node, name: m.name }, m.role);
          try {
            await this.deps.move(m.node, invite);
            moved++;
            this.log.info("a machine moved into the account's machines", { node: m.node, name: m.name, role: m.role });
          } catch (e) {
            this.log.warn("a machine could not be moved into the account's machines", { node: m.node, name: m.name, error: e instanceof Error ? e.message : String(e) });
            left.push(m.name);
          }
        }
        const invite = await arb.join(self, "full", mine);
        const r = await this.deps.joinSelf(invite, "leads");
        this.done(r, left, moved);
        return;
      }
      this.set({ state: "joining", ...this.named(), since: this.now() });
      const invite = await arb.join(self);
      const r = await this.deps.joinSelf(invite, stance.kind);
      this.done(r, [], 0);
    } catch (e) {
      this.failed(e);
      if (asked) throw e;
    } finally {
      this.running = false;
    }
  }

  private named(): { primary?: string } {
    return this.primaryName ? { primary: this.primaryName } : {};
  }

  private done(r: Joined, left: string[], moved: number): void {
    this.tries = 0;
    this.primaryName = r.primary.name;
    const state: NodeAccount = { state: "joined", primary: r.primary.name, since: this.now(), ...(r.saved ? { saved: r.saved } : {}), ...(left.length > 0 ? { left } : {}) };
    this.deps.meta.set(ACCOUNT_META, JSON.stringify(state));
    this.log.info("joined the account's machines", { primary: r.primary.id, name: r.primary.name, moved, left, saved: r.saved ?? null });
    this.set(state);
  }

  /** A try that failed, by why: the primary away waits and tries again soon; an older primary or a refusal, later. */
  private failed(e: unknown): void {
    const err = e instanceof RpcError ? e : new RpcError("unavailable", e instanceof Error ? e.message : String(e));
    const data = (err.error.data ?? {}) as { primary?: { name?: unknown }; from?: unknown };
    if (typeof data.primary?.name === "string") this.primaryName = data.primary.name;
    const primary = this.primaryName ?? "your account's primary";
    const fromPrimary = data.from === "primary";
    if (err.code === "conflict" && /one of (the account's|these) machines already/.test(err.message)) {
      this.settle();
      return;
    }
    let state: NodeAccount["state"] = "failed";
    let detail = err.message;
    let slow = false;
    if (err.code === "unsupported") {
      state = "waiting";
      slow = true;
      detail = fromPrimary ? `${primary} needs a newer Cophyla to let machines in through the account` : "the server lets no machine join through the account yet";
    } else if (err.code === "unavailable" || err.code === "timeout") {
      state = "waiting";
    } else if (err.code === "denied") {
      slow = true;
    }
    this.log.warn("joining the account's machines did not happen", { code: err.code, message: err.message, fromPrimary, state });
    this.set({ state, ...this.named(), detail: detail.slice(0, 500), since: this.current?.state === state ? this.current.since : this.now() });
    this.retry(slow);
  }
}
