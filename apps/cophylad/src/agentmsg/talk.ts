// Agents' conversations: every message the router carries between agents, kept under each of
// the user's agent sessions it concerns, so an app shows one agent's talk with the others the
// way a group chat shows its posts. The primary keeps them, since it routes every message: one
// `kv` row per message under `talk` (`<session>/<number>`, numbered in that session's
// conversation as it came), and each session's last number, the user's read point and when
// the last came under `talk.sessions`. A message between two of the user's own agents is in
// both conversations, out in one and in in the other, under one id; one to or from another
// person's agent is in the user's agent's alone.
//
// What is kept: the last KEEP messages of a session, its whole conversation until PRUNE_MS
// after its last message. A message's text is cut at TALK_TEXT_MAX. The first start that keeps
// conversations takes the messages the audit log still holds, as read, so a session's history
// is there without a count of what was never news.

import { TALK_TEXT_MAX } from "@cophyla/protocol";
import type { AuditEntry, HarnessKind, TalkMessage, TalkParty, TalkStatus, TalkSummary } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import { TALK_KV_NS, TALK_SESSIONS_NS } from "../grants/namespaces.ts";
import type { Logger } from "../log.ts";
import type { Store } from "../store/index.ts";

/** A session's conversation as the store keeps it. */
interface SessionRow {
  n: number;
  readTo: number;
  lastAt?: number;
}

/** A message as a caller hands it in: the conversation numbers it, and stamps it now unless `at` says when. */
export type TalkInput = Omit<TalkMessage, "session" | "n" | "at"> & { at?: number };

/** What the import needs to know of a session the audit names: its harness, machine and folder, and its name now when it has one. */
export type Describe = (session: string) => { name?: string; harness?: HarnessKind; machine?: string; folder?: string } | undefined;

export interface TalkDeps {
  store: Store;
  bus: Bus;
  log: Logger;
  now?: () => number;
  /** How many messages a session keeps. */
  keep?: number;
}

/** The actions whose audit rows are messages between agents. */
export const TALK_ACTIONS = ["agent.send", "agent.lead", "teammate.send", "teammate.deliver", "connection.send", "connection.deliver"] as const;

export const KEEP = 2_000;
export const PRUNE_MS = 30 * 24 * 60 * 60_000;
/** How far back the import reads the audit log. */
const IMPORT_MS = 60 * 24 * 60 * 60_000;
/** The key in `talk.sessions` that says the import ran: no session's id starts with `~`. */
const IMPORTED_KEY = "~imported";
/** The message ids whose copies the log can find again to settle them, newest kept. */
const INDEX = 4_000;

const pad = (n: number) => String(n).padStart(9, "0");
const key = (session: string, n: number) => `${session}/${pad(n)}`;

export function capTalk(text: string): string {
  return text.length > TALK_TEXT_MAX ? text.slice(0, TALK_TEXT_MAX - 1) + "…" : text;
}

/** The party a message to or from another person's agent names: `<login>/<name>`, with the teammate or connection it came on. */
export function peerParty(alias: string, via: { teammate?: string; connection?: string }, harness?: HarnessKind): TalkParty {
  const slash = alias.indexOf("/");
  const user = slash > 0 ? alias.slice(0, slash) : undefined;
  return { name: alias, ...(harness ? { harness } : {}), ...(user ? { user } : {}), ...(via.teammate ? { teammate: via.teammate } : {}), ...(via.connection ? { connection: via.connection } : {}) };
}

export class TalkLog {
  private d: TalkDeps;
  private now: () => number;
  private keep: number;
  /** Where each recent message's copies are, by its id. */
  private index = new Map<string, { session: string; n: number }[]>();

  constructor(deps: TalkDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
    this.keep = deps.keep ?? KEEP;
  }

  private row(session: string): SessionRow | undefined {
    return this.d.store.kv.get(TALK_SESSIONS_NS, session) as SessionRow | undefined;
  }

  private summaryOf(session: string, r: SessionRow): TalkSummary {
    return { session, n: r.n, readTo: r.readTo, unread: Math.max(0, r.n - r.readTo), ...(r.lastAt !== undefined ? { lastAt: r.lastAt } : {}) };
  }

  private remember(id: string, session: string, n: number): void {
    const at = this.index.get(id);
    if (at) {
      this.index.delete(id);
      at.push({ session, n });
      this.index.set(id, at);
    } else this.index.set(id, [{ session, n }]);
    while (this.index.size > INDEX) this.index.delete(this.index.keys().next().value!);
  }

  /** Whether a session's conversation holds this message already, as far as this process met it. */
  private holds(id: string, session: string): boolean {
    return this.index.get(id)?.some((c) => c.session === session) ?? false;
  }

  /**
   * A message into a session's conversation, numbered after its last, and the clients told: the
   * message to those watching the session, its count to every one. `read`: the user has seen it
   * (the import's). A message the conversation holds already is left as it is.
   */
  add(session: string, input: TalkInput, opts: { read?: boolean; quiet?: boolean } = {}): TalkMessage | undefined {
    // a conversation that cannot be written never stops the message it records
    try {
      return this.write(session, input, opts);
    } catch (e) {
      this.d.log.warn("a message was not kept in its conversation", { session, message: input.id, error: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  }

  private write(session: string, input: TalkInput, opts: { read?: boolean; quiet?: boolean }): TalkMessage | undefined {
    if (this.holds(input.id, session)) return undefined;
    const r = this.row(session) ?? { n: 0, readTo: 0 };
    const n = r.n + 1;
    const at = input.at ?? this.now();
    const { at: _at, text, ...rest } = input;
    const m: TalkMessage = { session, n, ...rest, text: capTalk(text), at };
    this.d.store.kv.put(TALK_KV_NS, key(session, n), m);
    const next: SessionRow = { n, readTo: opts.read ? n : r.readTo, lastAt: at };
    this.d.store.kv.put(TALK_SESSIONS_NS, session, next);
    if (n > this.keep) this.d.store.kv.delete(TALK_KV_NS, key(session, n - this.keep));
    this.remember(m.id, session, n);
    if (!opts.quiet) {
      this.d.bus.emit("talk.said", { message: m });
      this.d.bus.emit("talk.state", this.summaryOf(session, next));
    }
    return m;
  }

  /** A message between two of the user's own agents: out in the sender's conversation, in in the receiver's. */
  between(from: TalkParty & { session: string }, to: TalkParty & { session: string }, m: Omit<TalkInput, "dir" | "with">): void {
    this.add(from.session, { ...m, dir: "out", with: to });
    this.add(to.session, { ...m, dir: "in", with: from });
  }

  /** Where a message stands now, in every conversation that holds it; a `failed` one with why. */
  settle(id: string, status: TalkStatus, why?: string): void {
    for (const c of this.index.get(id) ?? []) {
      try {
        const m = this.d.store.kv.get(TALK_KV_NS, key(c.session, c.n)) as TalkMessage | undefined;
        if (!m || m.id !== id || (m.status === status && m.why === why)) continue;
        const { why: _why, ...rest } = m;
        const next: TalkMessage = { ...rest, status, ...(why ? { why: why.slice(0, 300) } : {}) };
        this.d.store.kv.put(TALK_KV_NS, key(c.session, c.n), next);
        this.d.bus.emit("talk.said", { message: next });
      } catch (e) {
        this.d.log.warn("a message's standing was not kept", { session: c.session, message: id, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  /** Every session with a conversation, at a glance. */
  list(): TalkSummary[] {
    const out: TalkSummary[] = [];
    for (const k of this.d.store.kv.list(TALK_SESSIONS_NS)) {
      if (k.startsWith("~")) continue;
      const r = this.row(k);
      if (r) out.push(this.summaryOf(k, r));
    }
    return out;
  }

  summary(session: string): TalkSummary | undefined {
    const r = this.row(session);
    return r ? this.summaryOf(session, r) : undefined;
  }

  /** The numbers of a session's messages kept, oldest first. */
  private numbers(session: string): number[] {
    return this.d.store.kv.list(TALK_KV_NS, `${session}/`).map((k) => Number(k.slice(session.length + 1)));
  }

  /** The `limit` messages before number `before` (the latest without it), oldest first, and whether there are more. */
  page(session: string, limit: number, before?: number): { messages: TalkMessage[]; more: boolean } {
    const ns = this.numbers(session).filter((n) => before === undefined || n < before);
    const take = ns.slice(Math.max(0, ns.length - limit));
    const messages = take.flatMap((n) => {
      const m = this.d.store.kv.get(TALK_KV_NS, key(session, n)) as TalkMessage | undefined;
      return m ? [m] : [];
    });
    return { messages, more: ns.length > take.length };
  }

  /** The user read a session's conversation up to `upTo`: never past its last, never back. */
  read(session: string, upTo: number): void {
    const r = this.row(session);
    if (!r) return;
    const to = Math.min(upTo, r.n);
    if (to <= r.readTo) return;
    const next = { ...r, readTo: to };
    this.d.store.kv.put(TALK_SESSIONS_NS, session, next);
    this.d.bus.emit("talk.state", this.summaryOf(session, next));
  }

  /** Drops the conversations whose last message is older than PRUNE_MS. */
  prune(): number {
    const cut = this.now() - PRUNE_MS;
    let dropped = 0;
    for (const s of this.d.store.kv.list(TALK_SESSIONS_NS)) {
      if (s.startsWith("~")) continue;
      const r = this.row(s);
      if (!r || (r.lastAt ?? 0) >= cut) continue;
      for (const k of this.d.store.kv.list(TALK_KV_NS, `${s}/`)) this.d.store.kv.delete(TALK_KV_NS, k);
      this.d.store.kv.delete(TALK_SESSIONS_NS, s);
      dropped++;
    }
    return dropped;
  }

  /** Once, on the first start that keeps conversations: the messages the audit log holds, as read. */
  importOnce(describe: Describe): number {
    if (this.d.store.kv.get(TALK_SESSIONS_NS, IMPORTED_KEY) !== undefined) return 0;
    const rows = this.d.store.audit.succeeded(TALK_ACTIONS, this.now() - IMPORT_MS);
    // thousands of rows at once: one transaction, not one write each
    const n = this.d.store.db.transaction(() => this.importRows(rows, describe))();
    this.d.store.kv.put(TALK_SESSIONS_NS, IMPORTED_KEY, { at: this.now(), messages: n });
    if (n > 0) this.d.log.info("agents' conversations taken from the audit log", { messages: n, rows: rows.length });
    return n;
  }

  /** The audit rows of messages, oldest first, as conversations: the clients are told nothing, a page asked for shows them. */
  importRows(rows: readonly AuditEntry[], describe: Describe): number {
    // the name each session went by, as the messages to it named it: the latest
    const named = new Map<string, string>();
    for (const e of rows) {
      const to = str(args(e)["to"]);
      if ((e.action === "agent.send" || e.action === "agent.lead") && e.target && to) named.set(e.target, to);
    }
    // each session described once: a row names two, and thousands of rows the same few
    const parties = new Map<string, TalkParty & { session: string }>();
    const party = (session: string): TalkParty & { session: string } => {
      const had = parties.get(session);
      if (had) return had;
      const d = describe(session);
      const name = d?.name ?? named.get(session) ?? session.slice(-6).toLowerCase();
      const p = { session, name, ...(d?.harness ? { harness: d.harness } : {}), ...(d?.machine ? { machine: d.machine } : {}), ...(d?.folder ? { folder: d.folder } : {}) };
      parties.set(session, p);
      return p;
    };
    let added = 0;
    const put = (session: string, input: TalkInput) => {
      if (this.add(session, input, { read: true, quiet: true })) added++;
    };
    for (const e of rows) {
      const a = args(e);
      const id = str(a["id"]);
      const text = str(a["text"]);
      if (!id || text === undefined) continue;
      const replyTo = str(a["replyTo"]);
      const base = { id, text, at: e.at, ...(replyTo ? { replyTo } : {}) };
      const sender = e.principal.kind === "harness" ? e.principal.session : undefined;
      switch (e.action) {
        case "agent.send":
        case "agent.lead": {
          if (!sender || !e.target || e.target === sender) break;
          const from = party(sender);
          const to = party(e.target);
          const lead = e.action === "agent.lead" ? { lead: true as const } : {};
          put(sender, { ...base, ...lead, dir: "out", with: to });
          put(e.target, { ...base, ...lead, dir: "in", with: from });
          break;
        }
        case "teammate.send":
        case "connection.send": {
          const to = str(a["to"]);
          if (!sender || !to || !e.target) break;
          put(sender, { ...base, dir: "out", with: peerParty(to, e.action === "teammate.send" ? { teammate: e.target } : { connection: e.target }) });
          break;
        }
        case "teammate.deliver":
        case "connection.deliver": {
          const from = str(a["from"]);
          if (!from || !e.target) break;
          const via = e.action === "teammate.deliver" ? { teammate: str(a["teammate"]) } : { connection: str(a["connection"]) };
          put(e.target, { ...base, dir: "in", with: peerParty(from, { ...(via.teammate ? { teammate: via.teammate } : {}), ...(via.connection ? { connection: via.connection } : {}) }) });
          break;
        }
      }
    }
    return added;
  }
}

function args(e: AuditEntry): Record<string, unknown> {
  return e.args !== null && typeof e.args === "object" ? (e.args as Record<string, unknown>) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
