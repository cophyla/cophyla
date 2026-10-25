// Focus: an agent that starts long work takes an hour or two out of reach (`focus`, one of the
// agents' tools), and until then nothing from other agents reaches it. A message to it (another
// of the user's agents', a connection's, a teammate's, a leader's) is held here, twenty at
// most, and its sender is told at once until when and why, so it never waits for an answer
// that is not coming yet; a group chat's notices and posts are not sent, only counted. Focus
// ends at its time, at the agent's next plain idle (its turn over, none of its own background
// shells running, no dialog open), when its session ends, or when the agent or the user ends
// it. What came is then handed over at once: a leader's words first, typed as the user's, one
// message per leader; then, once they have landed (or a while has passed), one message with a
// notice of what came and every other held message after it, each in its own envelope, in the
// order they came. A session that ended drops them, and the user's own agents that sent them
// are told.
//
// The primary keeps it, since every message and every group goes through the primary: one kv
// row per agent in focus, replicated to the backups, so a daemon restart or a change of
// primary keeps it. The user's own words, typed or from the app, the chat's sends for the
// user, and a leader's sent `past_focus` never pass through here, and reach an agent in focus
// as ever.

import { BUNDLE_MAX, newId, RpcError } from "@cophyla/protocol";
import type { AgentRef, Focus, Session } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import { FOCUS_KV_NS } from "../grants/namespaces.ts";
import type { Logger } from "../log.ts";
import type { Store } from "../store/index.ts";
import { droppedOf } from "./envelope.ts";
import type { DeliverOptions, EnvelopeInfo } from "./envelope.ts";

/** How long focus may be taken for, in minutes. */
export const FOCUS_MINUTES = [60, 120] as const;
/** How many messages wait for one agent in focus. */
export const HELD_MAX = 20;
/** How much text one message handed over at the end of a focus carries; what is more goes in another. */
export const BUNDLE_CHARS = 64_000;
const REASON_CHARS = 200;
const SWEEP_MS = 15_000;
/** How long the rest of what came waits for a leader's words typed before it to land. */
const LAND_MS = 20_000;

/** A message held for an agent in focus: what reaches it once focus ends. */
export interface HeldMessage {
  text: string;
  info: EnvelopeInfo;
  at: number;
  /** Who it is from, for the notice: an alias, or another person's agent's `<login>/<name>`. */
  label: string;
  /** One of the user's own agents that sent it, told if it never arrives. */
  sender?: string;
  /** A leader's words (`info.from` the leader), typed as the user's once focus ends, before the rest. */
  lead?: true;
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
  /** Focus has ended and what was held is being handed over: what comes meanwhile queues behind it. */
  draining?: boolean;
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
  /**
   * Delivers into a session wherever it is, past focus: here, or forwarded to its node. `more`:
   * handed over with it as one message, each in its own envelope; any left out is named.
   */
  deliver: (s: Session, text: string, info: EnvelopeInfo, opts?: DeliverOptions) => Promise<unknown>;
  /**
   * Types a leader's held words into a session as the user's, as one message, with the ref its
   * landing is recorded under; false when the leader no longer speaks to it as the user, and
   * they go as its message with the rest.
   */
  lead?: (s: Session, text: string, by: AgentRef, ids: string[]) => Promise<{ ref?: string } | false>;
  /** How long the rest waits for a leader's words to land; `LAND_MS` when absent. */
  landMs?: number;
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
    if (!r || r.draining || r.until <= this.now()) return undefined;
    return { since: r.since, until: r.until, reason: r.reason };
  }

  /** Whether what comes for an agent waits here now: it is in focus, or what was held for it is still being handed over. */
  holding(session: string): boolean {
    if (!this.deps.routes()) return false;
    const r = this.row(session);
    return r !== undefined && (r.draining === true || r.until > this.now());
  }

  /** Every agent in focus now. */
  list(): { session: string; focus: Focus }[] {
    if (!this.deps.routes()) return [];
    const now = this.now();
    return this.rows()
      .filter((r) => !r.draining && r.until > now)
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
    if (prev?.draining) throw new RpcError("conflict", "your last focus is still handing over what came meanwhile; take focus again in a moment");
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
   * Ends `session`'s focus and hands over what came: a leader's words typed as the user's, then
   * one message of the notice and the rest. A session that ended drops what was held, and the
   * user's own agents that sent it are told.
   */
  async end(session: string, why: FocusEnd): Promise<boolean> {
    const row = this.row(session);
    if (!row || row.draining || this.ending.has(session)) return false;
    this.ending.add(session);
    try {
      const s = this.deps.sessions().find((x) => x.id === session);
      const live = s !== undefined && s.status !== "ended" && this.deps.linked(s.node);
      this.log.info("an agent's focus ended", { session, why, held: row.held.length });
      if (!live) {
        this.deps.store.kv.delete(FOCUS_KV_NS, session);
        this.deps.bus.emit("focus.state", { session });
        for (const h of row.held) await this.dropped(h, session);
        this.deps.ended?.(session, false);
        return true;
      }
      // out of focus from here, but what comes now queues behind what was held, so nothing overtakes
      // it, and goes the same way once that is handed over
      row.draining = true;
      this.put(row);
      this.deps.bus.emit("focus.state", { session });
      for (let first = true; ; first = false) {
        const cur = this.row(session);
        if (!cur) break;
        const held = cur.held.splice(0);
        if (!first && held.length === 0) break;
        if (held.length > 0) this.put(cur);
        const rest = await this.typeLeads(s, held);
        const notice = first ? catchUp({ ...row, held: rest }, why) : undefined;
        await this.handOver(s, notice, rest);
        if (first) this.deps.ended?.(session, notice !== undefined);
      }
      // nothing waits between the last look and this: what comes after goes straight in
      if (this.row(session)?.draining) this.deps.store.kv.delete(FOCUS_KV_NS, session);
      return true;
    } finally {
      this.ending.delete(session);
    }
  }

  /** Ends `session`'s focus without waiting for what was held to be handed over: for a tool or a request that must answer now. */
  release(session: string, why: FocusEnd): boolean {
    if (!this.holding(session) || this.row(session)?.draining) return false;
    void this.end(session, why).catch((e: unknown) => this.log.warn("an agent's focus did not end cleanly", { session, error: e instanceof Error ? e.message : String(e) }));
    return true;
  }

  /**
   * A leader's held words, typed into `s` as the user's: one message per leader, a slash command
   * alone, and the last of them awaited until it lands, so what follows comes after it. What is
   * left, in the order it came: the rest, and a leader's that no longer goes as the user's. A
   * sender of words that could not be typed is told.
   */
  private async typeLeads(s: Session, held: HeldMessage[]): Promise<HeldMessage[]> {
    const lead = this.deps.lead;
    const leads = held.filter((h) => h.lead === true && h.info.from !== undefined);
    if (!lead || leads.length === 0) return held;
    // heard from before the first is typed: a session can record one before its send answers
    const landing = this.landings(s.id);
    const done = new Set<HeldMessage>();
    let last: string | undefined;
    try {
      for (const run of leadRuns(leads)) {
        const by = run[0]!.info.from!;
        try {
          const typed = await lead(s, run.map((h) => h.text).join("\n\n"), by, run.map((h) => h.info.messageId));
          if (!typed) continue;
          if (typed.ref) last = typed.ref;
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          this.log.warn("a leader's words held for focus could not be typed", { session: s.id, leader: by.session, error: why });
          for (const h of run) await this.dropped(h, s.id, why);
        }
        for (const h of run) done.add(h);
      }
      if (last) await landing.until(last);
    } finally {
      landing.off();
    }
    return held.filter((h) => !done.has(h));
  }

  /** The messages sent into `session` that landed or were withdrawn from now on, by ref, as its events say; `until` waits for one, `LAND_MS` at most. */
  private landings(session: string): { until: (ref: string) => Promise<void>; off: () => void } {
    const seen = new Set<string>();
    let want: { ref: string; done: () => void } | undefined;
    const off = this.deps.bus.on("session.event", (e) => {
      if (e.session !== session) return;
      const p = (e.payload ?? {}) as Record<string, unknown>;
      if (typeof p["ref"] !== "string" || !(e.kind === "user_turn" || (e.kind === "notification" && p["type"] === "message"))) return;
      seen.add(p["ref"]);
      if (want?.ref === p["ref"]) want.done();
    });
    const until = (ref: string) =>
      seen.has(ref)
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              this.log.info("a leader's words held for focus did not land in time; the rest goes now", { session, ref });
              resolve();
            }, this.deps.landMs ?? LAND_MS);
            want = {
              ref,
              done: () => {
                clearTimeout(timer);
                resolve();
              },
            };
          });
    return { until, off };
  }

  /** The notice of what came and the messages held, handed over in as few messages as they fit; a sender of one that did not land is told. */
  private async handOver(s: Session, notice: string | undefined, held: HeldMessage[]): Promise<void> {
    const parts: { text: string; info: EnvelopeInfo; held?: HeldMessage }[] = [...(notice ? [{ text: notice, info: { messageId: newId("agentMessage") } }] : []), ...held.map((h) => ({ text: h.text, info: h.info, held: h }))];
    for (const sent of bundles(parts)) {
      const [first, ...more] = sent;
      try {
        const r = await this.deps.deliver(s, first!.text, first!.info, more.length > 0 ? { more: more.map((m) => ({ ...m.info, text: m.text })) } : undefined);
        for (const d of droppedOf(r)) {
          const h = sent.find((p) => p.info.messageId === d.messageId)?.held;
          if (h) await this.dropped(h, s.id, d.why);
        }
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        this.log.warn("what came during focus could not be handed over", { session: s.id, messages: sent.length, error: why });
        for (const p of sent) if (p.held) await this.dropped(p.held, s.id, why);
      }
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
   * in focus. Refused when twenty already wait. `lead`: a leader's words, typed as the user's
   * when focus ends.
   */
  hold(s: Session, text: string, info: EnvelopeInfo, label: string, sender?: string, lead = false): boolean {
    if (!this.deps.routes()) return false;
    const row = this.row(s.id);
    if (!row || (!row.draining && row.until <= this.now())) return false;
    if (row.held.length >= (row.draining ? HELD_MAX * 2 : HELD_MAX)) throw new RpcError("unavailable", row.draining ? "it is still being handed what came while it was in focus; send again in a minute" : `it is in focus until ${clockTime(row.until)} and already holds ${HELD_MAX} messages; not sent`);
    row.held.push({ text, info, at: this.now(), label, ...(sender ? { sender } : {}), ...(lead ? { lead: true as const } : {}) });
    this.put(row);
    this.log.info("a message held for an agent in focus", { session: s.id, id: info.messageId, held: row.held.length });
    return true;
  }

  /** Counts a group's tag or post for an agent in focus, for the notice it gets when focus ends; false when it is not in focus. */
  noteGroup(session: string, group: { id: string; name: string }, kind: "tag" | "post"): boolean {
    if (!this.deps.routes()) return false;
    const row = this.row(session);
    if (!row || row.draining || row.until <= this.now()) return false;
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
    if (!row || row.draining) return;
    // a machine whose link dropped lists its sessions as ended: focus waits for it to come back, or for its time
    if (s.status === "ended") {
      if (this.deps.linked(s.node)) void this.end(s.id, "ended");
    } else if (plainIdle(s)) void this.end(s.id, "idle");
  }

  /** Ends what ran out of time and what belongs to a session that ended; hands over again what a restart cut short. */
  async sweep(): Promise<void> {
    if (!this.deps.routes()) return;
    const now = this.now();
    for (const row of this.rows()) {
      if (row.draining) {
        if (this.ending.has(row.session)) continue;
        row.draining = false;
        this.put(row);
        await this.end(row.session, "time");
        continue;
      }
      const s = this.deps.sessions().find((x) => x.id === row.session);
      if (row.until <= now) await this.end(row.session, "time");
      else if (s && s.status === "ended" && this.deps.linked(s.node)) await this.end(row.session, "ended");
    }
  }
}

/**
 * A leader's held words as the messages they are typed in: one per leader, in the order each
 * first spoke, a slash command alone since it must be the whole prompt, and none past
 * `BUNDLE_CHARS` but one that is alone.
 */
export function leadRuns(held: readonly HeldMessage[]): HeldMessage[][] {
  const by = new Map<string, HeldMessage[]>();
  for (const h of held) {
    const k = h.info.from?.session ?? "";
    by.set(k, [...(by.get(k) ?? []), h]);
  }
  const runs: HeldMessage[][] = [];
  for (const words of by.values()) {
    let run: HeldMessage[] = [];
    let chars = 0;
    const close = () => {
      if (run.length > 0) runs.push(run);
      run = [];
      chars = 0;
    };
    for (const h of words) {
      const slash = h.text.trimStart().startsWith("/");
      if (slash || chars + h.text.length > BUNDLE_CHARS) close();
      run.push(h);
      chars += h.text.length + 2;
      if (slash) close();
    }
    close();
  }
  return runs;
}

/** Messages split into as few handed over as one as they fit: at most `BUNDLE_MAX` and `BUNDLE_CHARS` of text each, but one that is alone. */
export function bundles<T extends { text: string }>(parts: readonly T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let chars = 0;
  for (const p of parts) {
    if (cur.length > 0 && (cur.length >= BUNDLE_MAX || chars + p.text.length > BUNDLE_CHARS)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(p);
    chars += p.text.length;
  }
  if (cur.length > 0) out.push(cur);
  return out;
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
    parts.push(`${row.held.length} ${row.held.length === 1 ? "message" : "messages"} (from ${from.join(", ")}), below`);
  }
  if (parts.length === 0) return `${ended}; nothing came meanwhile.`;
  const read = groups.length > 0 ? " Read a group with read_group when it suits your work." : "";
  return `${ended}. While you were in focus: ${parts.join("; ")}.${read}`;
}
