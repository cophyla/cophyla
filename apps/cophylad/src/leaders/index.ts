// Leaders: an agent session, or the chat, that the user made a leader of a group of their own
// sessions (`all`, every one now and later but itself, or the ones named). A leader's message
// to one of its group reaches it as the user's own words, typed into a Claude session in a
// tether terminal, and the leader answers its asks as the user (`answer_ask`). Agents outside a
// leader's group are messaged as ever, as another agent's words.
//
// The primary keeps them, one kv row per leader in `leaders`, replicated to the backups like the
// groups and focus, never the brain's to read or write and never in the cloud backup. Only the
// user's clients change them (`lead.set`, `lead.remove`); every change is told to the clients
// (`lead.state`) and to the brain (`lead.updated`). A leader is keyed by the cophylad session id,
// which survives `/clear` and Reopen; a new process in the same terminal is a new session and
// starts unpromoted. A row whose leader or target ended lies dormant until a reopen, and goes
// seven days after the end. Once, on the primary, a config whose retired
// `[sessions].brain_sends` says `typed` becomes the chat leading every agent.

import { RpcError } from "@cophyla/protocol";
import type { Leader, LeaderSpeaker, NodeCapabilities, NodeScope, Session } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import { LEADERS_KV_NS } from "../grants/namespaces.ts";
import type { Logger } from "../log.ts";
import type { Store } from "../store/index.ts";

/** The key the migration from `brain_sends` leaves, so it runs once. */
export const MIGRATED_KEY = "~migrated";
/** How long a leader, or one of its group, may be ended or gone before its grant goes. */
export const PRUNE_MS = 7 * 24 * 60 * 60_000;
const SWEEP_MS = 10 * 60_000;

/** A leader as the primary keeps it: when each of its sessions was found ended or gone, so it can go a week later. */
interface LeaderRow extends Leader {
  gone?: Record<string, number>;
}

/** What a node's row says that decides whether its sessions take a leader's words. */
export interface LeadNode {
  name: string;
  scope: NodeScope;
  hands?: boolean;
  capabilities: Pick<NodeCapabilities, "lead">;
}

export interface LeadersDeps {
  store: Store;
  bus: Bus;
  log: Logger;
  /** Whether this node keeps the leaders: the primary, or a node in no cluster. */
  routes: () => boolean;
  /** Every session this node knows: its own and its linked nodes'. */
  sessions: () => Session[];
  /** A node's row, this one's own included. */
  node: (id: string) => LeadNode | undefined;
  /** Whether the config's retired `[sessions].brain_sends` says `typed`, read once to migrate. */
  legacyTyped?: () => boolean;
  now?: () => number;
  sweepMs?: number;
}

/** A workspace node: hands, lending folders of another person's machine. Its sessions are no one's to lead. */
function lent(n: LeadNode | undefined): boolean {
  return n?.hands === true && n.scope.kind === "workspaces";
}

/** Why a session cannot be typed into by cophylad, for the words of a leader's message that went as another agent's. */
export function untypeable(s: Pick<Session, "harness" | "native">): string | undefined {
  if (s.harness === "claude" && s.native.transport === "pipe" && s.native.terminal === undefined) return "it runs outside a Cophyla terminal, where nothing can be typed into it (Reopen it in Cophyla to include it)";
  return undefined;
}

export class Leaders {
  private deps: LeadersDeps;
  private log: Logger;
  private now: () => number;
  private timer?: ReturnType<typeof setInterval>;

  constructor(deps: LeadersDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.migrate();
    this.timer = setInterval(() => this.sweep(), this.deps.sweepMs ?? SWEEP_MS);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // --- rows ------------------------------------------------------------------------------------

  private row(speaker: string): LeaderRow | undefined {
    if (speaker === MIGRATED_KEY) return undefined;
    return this.deps.store.kv.get(LEADERS_KV_NS, speaker) as LeaderRow | undefined;
  }

  private rows(): LeaderRow[] {
    const out: LeaderRow[] = [];
    for (const k of this.deps.store.kv.list(LEADERS_KV_NS)) {
      const r = this.row(k);
      if (r) out.push(r);
    }
    return out;
  }

  private put(row: LeaderRow): void {
    this.deps.store.kv.put(LEADERS_KV_NS, row.speaker, row, this.now());
  }

  private changed(): void {
    this.deps.bus.emit("lead.state", { leaders: this.list() });
  }

  /** Every leader, the chat first, then the oldest first. */
  list(): Leader[] {
    if (!this.deps.routes()) return [];
    return this.rows()
      .map(({ speaker, targets, since }) => ({ speaker, targets, since }))
      .sort((a, b) => (a.speaker === "chat" ? -1 : b.speaker === "chat" ? 1 : a.since - b.since || (a.speaker < b.speaker ? -1 : 1)));
  }

  /** A leader's group, or undefined when `speaker` leads no one. */
  get(speaker: string): Leader | undefined {
    if (!this.deps.routes()) return undefined;
    const r = this.row(speaker);
    return r ? { speaker: r.speaker, targets: r.targets, since: r.since } : undefined;
  }

  // --- who leads whom --------------------------------------------------------------------------

  private known(id: string): Session | undefined {
    return this.deps.sessions().find((s) => s.id === id);
  }

  /** One of the user's own sessions: never the chat's own, nor one a workspace node runs on another person's machine. */
  private own(s: Session | undefined): s is Session {
    return s !== undefined && s.role !== "assistant" && !lent(this.deps.node(s.node));
  }

  /**
   * Whether `speaker` leads `target`: the user made it a leader of a group `target` is in.
   * `all` takes every one of the user's own sessions but the leader itself.
   */
  leads(speaker: string, target: string): boolean {
    if (speaker === target || target === "chat") return false;
    const r = this.get(speaker);
    if (!r) return false;
    if (r.targets === "all") return this.own(this.known(target));
    return r.targets.includes(target);
  }

  /** The leaders of `target`: the chat, and the agent sessions, whose words reach it as the user's. */
  leadersOf(target: string): LeaderSpeaker[] {
    return this.list()
      .filter((l) => this.leads(l.speaker, target))
      .map((l) => l.speaker);
  }

  /**
   * Why a leader's message to `s` goes as another agent's after all, or undefined when it can go
   * as the user's: a Claude session cophylad cannot type into, a machine that shares some
   * folders alone, or one whose Cophyla is older than leaders.
   */
  fallback(s: Session): string | undefined {
    const n = this.deps.node(s.node);
    if (n && n.scope.kind === "workspaces") return `${n.name} shares some folders alone, and takes no leader's words as its user's`;
    if (n && n.capabilities.lead !== true) return `${n.name} runs an older Cophyla`;
    return untypeable(s);
  }

  /**
   * How a message from `speaker` reaches `s`: as the user's words, as another agent's with why
   * (it is led, but cannot take them), or undefined when `speaker` does not lead it.
   */
  route(speaker: string, s: Session): { lead: true } | { fallback: string } | undefined {
    if (!this.leads(speaker, s.id)) return undefined;
    const why = this.fallback(s);
    return why ? { fallback: why } : { lead: true };
  }

  // --- the user's word -------------------------------------------------------------------------

  /** Why `id` may not lead or be led, or undefined when it may: a live session of the user's own. */
  private refuse(id: string, as: "leader" | "target"): string | undefined {
    const s = this.known(id);
    if (!s) return `no session ${id} is known`;
    if (s.status === "ended") return `${id} has ended`;
    if (!this.own(s)) return `${id} is not one of your own sessions`;
    if (as === "target") return untypeable(s);
    return undefined;
  }

  /**
   * Makes `speaker` a leader of `targets`, or changes its group: the user's word, from a client.
   * Only the user's own live sessions lead or are led, never the chat as a target, never the
   * leader itself, never a session cophylad cannot type into.
   */
  set(speaker: LeaderSpeaker, targets: "all" | string[]): Leader {
    if (!this.deps.routes()) throw new RpcError("unavailable", "the leaders are kept by the primary");
    if (speaker !== "chat") {
      const why = this.refuse(speaker, "leader");
      if (why) throw new RpcError("invalid", `${why}: it cannot lead`);
    }
    let group: "all" | string[] = "all";
    if (targets !== "all") {
      group = [...new Set(targets)];
      if (group.length === 0) throw new RpcError("invalid", "a leader leads every agent or at least one");
      for (const id of group) {
        if (id === speaker) throw new RpcError("invalid", "a leader does not lead itself");
        const why = this.refuse(id, "target");
        if (why) throw new RpcError("invalid", `${why}: it cannot be led`);
      }
    }
    const prev = this.row(speaker);
    const row: LeaderRow = { speaker, targets: group, since: prev?.since ?? this.now() };
    this.put(row);
    this.log.info("a leader set", { speaker, targets: group === "all" ? "all" : group.length });
    this.changed();
    return { speaker: row.speaker, targets: row.targets, since: row.since };
  }

  /** `speaker` leads no one any more; false when it led no one. */
  remove(speaker: LeaderSpeaker): boolean {
    if (!this.deps.routes()) throw new RpcError("unavailable", "the leaders are kept by the primary");
    if (!this.row(speaker)) return false;
    this.deps.store.kv.delete(LEADERS_KV_NS, speaker);
    this.log.info("a leader removed", { speaker });
    this.changed();
    return true;
  }

  // --- once, and over time ------------------------------------------------------------------------

  /** The retired `brain_sends = "typed"`, once, on the primary: the chat leads every agent. */
  migrate(): void {
    if (!this.deps.routes() || !this.deps.legacyTyped?.()) return;
    if (this.deps.store.kv.get(LEADERS_KV_NS, MIGRATED_KEY) !== undefined) return;
    const had = this.row("chat") !== undefined;
    if (!had) this.put({ speaker: "chat", targets: "all", since: this.now() });
    this.deps.store.kv.put(LEADERS_KV_NS, MIGRATED_KEY, { from: "brain_sends", at: this.now() }, this.now());
    this.log.info("brain_sends = typed is now the chat leading every agent", { kept: had });
    if (!had) this.changed();
  }

  /**
   * Notes which of the leaders' sessions are ended or gone, forgets the note of one that came
   * back (a reopen), and drops what has been away a week: a leader's row with it, a target from
   * its group, and a group left empty.
   */
  sweep(): void {
    if (!this.deps.routes()) return;
    this.migrate();
    const now = this.now();
    let pruned = false;
    for (const row of this.rows()) {
      const gone = { ...(row.gone ?? {}) };
      const ids = [...(row.speaker === "chat" ? [] : [row.speaker]), ...(row.targets === "all" ? [] : row.targets)];
      for (const id of ids) {
        const s = this.known(id);
        if (s && s.status !== "ended") delete gone[id];
        else gone[id] ??= s?.endedAt ?? now;
      }
      for (const id of Object.keys(gone)) if (!ids.includes(id)) delete gone[id];
      const expired = (id: string) => gone[id] !== undefined && now - gone[id] >= PRUNE_MS;
      if (row.speaker !== "chat" && expired(row.speaker)) {
        this.deps.store.kv.delete(LEADERS_KV_NS, row.speaker);
        this.log.info("a leader went: its session ended a week ago", { speaker: row.speaker });
        pruned = true;
        continue;
      }
      let targets = row.targets;
      if (targets !== "all") {
        const kept = targets.filter((id) => !expired(id));
        if (kept.length !== targets.length) {
          for (const id of targets) if (!kept.includes(id)) delete gone[id];
          this.log.info("sessions that ended a week ago left a leader's group", { speaker: row.speaker, left: targets.length - kept.length });
          pruned = true;
          if (kept.length === 0) {
            this.deps.store.kv.delete(LEADERS_KV_NS, row.speaker);
            continue;
          }
          targets = kept;
        }
      }
      const next: LeaderRow = { speaker: row.speaker, targets, since: row.since, ...(Object.keys(gone).length > 0 ? { gone } : {}) };
      if (JSON.stringify(next) !== JSON.stringify(row)) this.put(next);
    }
    if (pruned) this.changed();
  }
}
