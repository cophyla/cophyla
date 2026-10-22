// Focus: an agent that starts long work takes an hour or two out of reach (`focus`, one of the
// agents' tools), and until then nothing from other agents reaches it. A message to it (another
// of the user's agents', a connection's, a teammate's) is held here, twenty at most, and its
// sender is told at once until when and why, so it never waits for an answer that is not
// coming yet; a group chat's notices and posts are not sent, only counted. Focus ends at its
// time, at the agent's next plain idle (its turn over, none of its own background shells
// running, no dialog open), when its session ends, or when the agent or the user ends it. The
// agent then gets one notice of what came, and the held messages after it in the order they
// came; a session that ended drops them, and the user's own agents that sent them are told.
//
// The primary keeps it, since every message and every group goes through the primary: one kv
// row per agent in focus, replicated to the backups, so a daemon restart or a change of
// primary keeps it. The user's own words, typed or from the app, and the chat's sends for the
// user never pass through here, and reach an agent in focus as ever.

import { newId, RpcError } from "@cophyla/protocol";
import type { Focus, Session } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import { FOCUS_KV_NS } from "../grants/namespaces.ts";
import type { Logger } from "../log.ts";
import type { Store } from "../store/index.ts";
import type { EnvelopeInfo } from "./envelope.ts";

/** How long focus may be taken for, in minutes. */
export const FOCUS_MINUTES = [60, 120] as const;
/** How many messages wait for one agent in focus. */
export const HELD_MAX = 20;
const REASON_CHARS = 200;
const SWEEP_MS = 15_000;

/** A message held for an agent in focus: what reaches it once focus ends. */
export interface HeldMessage {
  text: string;
  info: EnvelopeInfo;
  at: number;
  /** Who it is from, for the notice: an alias, or another person's agent's `<login>/<name>`. */
  label: string;
  /** One of the user's own agents that sent it, told if it never arrives. */
  sender?: string;
}

/** An agent in focus as the primary keeps it. */
export interface FocusRow {
  session: string;
  since: number;
  until: number;
  reason: string;
  held: HeldMessage[];
  /** Per group, what came meanwhile: tags of the agent and posts, by the group's name. */
  groups: Record<string, { name: string; tags: number; posts: number }>;
}

/** Why focus ended, in the words the agent is told. */
export type FocusEnd = "time" | "idle" | "ended" | "agent" | "user";

export interface FocusDeps {
  store: Store;
  bus: Bus;
  log: Logger;
  /** Whether this node keeps focus: the primary, or a node in no cluster. */
  routes: () => boolean;
  /** Every session this node knows, its own and its linked nodes'. */
  sessions: () => Session[];
  /** Delivers into a session wherever it is, past focus: here, or forwarded to its node. */
  deliver: (s: Session, text: string, info: EnvelopeInfo) => Promise<unknown>;
  /** Whether a node can be reached now. */
  linked: (node: string) => boolean;
  /** The groups, told when an agent comes out of focus, so what it was told stands for their notices. */
  ended?: (session: string, told: boolean) => void;
  now?: () => number;
  sweepMs?: number;
}

/** Whether a session is done with its turn: idle, with no background shell of its own running and no dialog open. */
export function plainIdle(s: Pick<Session, "status" | "waiting">): boolean {
  return s.status === "idle" && s.waiting === undefined;
}

/** A clock time on this machine, for an agent's words: 14:30. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** How long until `ms`, for an agent's words: 47 min, 1 h 12 min. */
export function minutesLeft(ms: number, now: number): string {
  const m = Math.max(1, Math.round((ms - now) / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

export class Focuses {
  private deps: FocusDeps;
  private log: Logger;
  private now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private offs: (() => void)[] = [];
  private ending = new Set<string>();

  constructor(deps: FocusDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.timer = setInterval(() => void this.sweep(), this.deps.sweepMs ?? SWEEP_MS);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
    this.offs.push(this.deps.bus.on("session.state", (s) => this.onSession(s)));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const off of this.offs.splice(0)) off();
  }

  // --- rows ----------------------------------------------------------------------------------------

  private row(session: string): FocusRow | undefined {
    const v = this.deps.store.kv.get(FOCUS_KV_NS, session) as FocusRow | undefined;
    return v ? { ...v, held: v.held ?? [], groups: v.groups ?? {} } : undefined;
  }

  private put(row: FocusRow): void {
    this.deps.store.kv.put(FOCUS_KV_NS, row.session, row);
  }

  private rows(): FocusRow[] {
    const out: FocusRow[] = [];
    for (const k of this.deps.store.kv.list(FOCUS_KV_NS)) {
      const r = this.row(k);
      if (r) out.push(r);
    }
    return out;
  }

  /** An agent's focus now, or undefined. */
  get(session: string): Focus | undefined {
    if (!this.deps.routes()) return undefined;
    const r = this.row(session);
    if (!r || r.until <= this.now()) return undefined;
    return { since: r.since, until: r.until, reason: r.reason };
  }

  /** Every agent in focus now. */
  list(): { session: string; focus: Focus }[] {
    if (!this.deps.routes()) return [];
    const now = this.now();
    return this.rows()
      .filter((r) => r.until > now)
      .map((r) => ({ session: r.session, focus: { since: r.since, until: r.until, reason: r.reason } }));
  }

  // --- taking and ending -----------------------------------------------------------------------------

  /** `s` takes focus for `minutes`: what it held before stays held, its time and reason are new. */
  take(s: Session, minutes: number, reason: string): Focus {
    if (!(FOCUS_MINUTES as readonly number[]).includes(minutes)) throw new RpcError("invalid", "focus lasts 60 or 120 minutes");
    const why = reason.replace(/\s+/g, " ").trim();
    if (!why) throw new RpcError("invalid", "focus needs reason: one line on the work you are on, which the others are shown");
    const now = this.now();
    const prev = this.row(s.id);
    const row: FocusRow = {
      session: s.id,
      since: prev?.since ?? now,
      until: now + minutes * 60_000,
      reason: why.length > REASON_CHARS ? why.slice(0, REASON_CHARS - 1) + "…" : why,
      held: prev?.held ?? [],
      groups: prev?.groups ?? {},
    };
    this.put(row);
    const focus = { since: row.since, until: row.until, reason: row.reason };
    this.deps.bus.emit("focus.state", { session: s.id, focus });
    this.log.info("an agent took focus", { session: s.id, minutes, until: row.until });
    return focus;
  }

  /**
   * Ends `session`'s focus: one notice of what came, then what was held, in order. A session
   * that ended drops what was held, and the user's own agents that sent it are told.
   */
  async end(session: string, why: FocusEnd): Promise<boolean> {
    const row = this.row(session);
    if (!row || this.ending.has(session)) return false;
    this.ending.add(session);
    try {
      this.deps.store.kv.delete(FOCUS_KV_NS, session);
      this.deps.bus.emit("focus.state", { session });
      this.log.info("an agent's focus ended", { session, why, held: row.held.length });
      const s = this.deps.sessions().find((x) => x.id === session);
      const live = s !== undefined && s.status !== "ended" && this.deps.linked(s.node);
      if (!live) {
        for (const h of row.held) await this.dropped(h, session);
        this.deps.ended?.(session, false);
        return true;
      }
      const text = catchUp(row, why);
      if (text) {
        try {
          await this.deps.deliver(s, text, { messageId: newId("agentMessage") });
        } catch (e) {
          this.log.warn("an agent's focus notice could not be delivered", { session, error: e instanceof Error ? e.message : String(e) });
        }
      }
      this.deps.ended?.(session, text !== undefined);
      for (const h of row.held) {
        try {
          await this.deps.deliver(s, h.text, h.info);
        } catch (e) {
          this.log.warn("a message held for focus could not be delivered", { session, id: h.info.messageId, error: e instanceof Error ? e.message : String(e) });
          await this.dropped(h, session, e instanceof Error ? e.message : String(e));
        }
      }
      return true;
    } finally {
      this.ending.delete(session);
    }
  }

  /** Tells the agent that sent a held message, when it is one of the user's own, that it never arrived. */
  private async dropped(h: HeldMessage, to: string, why = "its session ended while it was in focus"): Promise<void> {
    if (!h.sender) return;
    const s = this.deps.sessions().find((x) => x.id === h.sender && x.status !== "ended");
    if (!s || !this.deps.linked(s.node)) return;
    try {
      await this.deps.deliver(s, `Your message ${h.info.messageId} was not delivered: ${why}.`, { messageId: newId("agentMessage"), replyTo: h.info.messageId });
    } catch {
      this.log.info("a held message's sender could not be told", { to, id: h.info.messageId });
    }
  }

  // --- what comes meanwhile ------------------------------------------------------------------------

  /**
   * Holds a message for `s` while it is in focus: true when it was held, false when `s` is not
   * in focus. Refused when twenty already wait.
   */
  hold(s: Session, text: string, info: EnvelopeInfo, label: string, sender?: string): boolean {
    if (!this.deps.routes()) return false;
    const row = this.row(s.id);
    if (!row || row.until <= this.now()) return false;
    if (row.held.length >= HELD_MAX) throw new RpcError("unavailable", `it is in focus until ${clockTime(row.until)} and already holds ${HELD_MAX} messages; not sent`);
    row.held.push({ text, info, at: this.now(), label, ...(sender ? { sender } : {}) });
    this.put(row);
    this.log.info("a message held for an agent in focus", { session: s.id, id: info.messageId, held: row.held.length });
    return true;
  }

  /** Counts a group's tag or post for an agent in focus, for the notice it gets when focus ends; false when it is not in focus. */
  noteGroup(session: string, group: { id: string; name: string }, kind: "tag" | "post"): boolean {
    if (!this.deps.routes()) return false;
    const row = this.row(session);
    if (!row || row.until <= this.now()) return false;
    const g = (row.groups[group.id] ??= { name: group.name, tags: 0, posts: 0 });
    g.name = group.name;
    if (kind === "tag") g.tags++;
    else g.posts++;
    this.put(row);
    return true;
  }

  // --- its end, noticed --------------------------------------------------------------------------------

  private onSession(s: Session): void {
    if (!this.deps.routes()) return;
    const row = this.row(s.id);
    if (!row) return;
    if (s.status === "ended") void this.end(s.id, "ended");
    else if (plainIdle(s)) void this.end(s.id, "idle");
  }

  /** Ends what ran out of time, and what belongs to a session gone from every list. */
  async sweep(): Promise<void> {
    if (!this.deps.routes()) return;
    const now = this.now();
    for (const row of this.rows()) {
      if (row.until <= now) await this.end(row.session, "time");
    }
  }
}

/** The words for the end of a focus, and what came meanwhile; undefined when nothing came and its own turn ended it. */
export function catchUp(row: FocusRow, why: FocusEnd): string | undefined {
  const groups = Object.values(row.groups).filter((g) => g.tags > 0 || g.posts > 0);
  if (groups.length === 0 && row.held.length === 0 && why === "idle") return undefined;
  const ended =
    why === "time" ? "Your focus ran its time" : why === "idle" ? "Your focus ended with your turn" : why === "agent" ? "You ended your focus" : why === "user" ? "Your user ended your focus" : "Your focus ended";
  const parts: string[] = [];
  for (const g of groups) {
    const bits: string[] = [];
    if (g.tags > 0) bits.push(`${g.tags} ${g.tags === 1 ? "tag" : "tags"} of you`);
    if (g.posts > 0) bits.push(`${g.posts} ${g.posts === 1 ? "post" : "posts"}`);
    parts.push(`${bits.join(" and ")} in #${g.name}`);
  }
  if (row.held.length > 0) {
    const from = [...new Set(row.held.map((h) => h.label))];
    parts.push(`${row.held.length} ${row.held.length === 1 ? "message" : "messages"} (from ${from.join(", ")}), which follow`);
  }
  if (parts.length === 0) return `${ended}; nothing came meanwhile.`;
  const read = groups.length > 0 ? " Read a group with read_group when it suits your work." : "";
  return `${ended}. While you were in focus: ${parts.join("; ")}.${read}`;
}
