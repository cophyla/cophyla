// Notes: what an agent marks for the user to read (`notify_user`), so a result, a finding or a
// question at the end of a long report is not lost under the agent's later output. Each note
// opens at its point in the session's chat, however far back. The Tracker follows what the user
// asked an agent; notes go the other way.
//
// A note may wait for the user's answer. The tool never blocks: the answer is the user's next
// message to that session, typed into its terminal, or sent or said from one of their apps (a
// note's reply box sends one). Another agent's message, a leader's, the brain's, a script's, a
// slash command or a notice the harness wrote never answers one: the tracker's rule for what is
// the user's own words.
//
// The primary keeps them, hearing every session's events, its linked nodes' too: a note is
// placed at the newest event of its session it has heard, then at the tool call itself once
// the session's log has it (Claude writes the call's row only around its result), matched by
// the harness's id for the call when it gave one, else by the title. Kept in kv under `notes`,
// one row per note by id, and the switch under `notes.settings`. A note goes 14 days after it
// was left, or when dismissed; past 500 the oldest finished go first.

import { newId, NOTE_ANSWER_MAX, NOTE_DETAIL_MAX, NOTE_TITLE_MAX, noteOpen, RpcError } from "@cophyla/protocol";
import type { Note, NotesState, SessionEvent } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import { NOTES_KV_NS, NOTES_SETTINGS_NS } from "../grants/namespaces.ts";
import type { Logger } from "../log.ts";
import type { Store } from "../store/index.ts";
import { NOT_ASKED, SENT_WAIT_MS, USERS } from "../tracker/index.ts";
import { plainPrompt } from "../tracker/judge.ts";

/** A note goes this long after it was left. */
export const NOTES_KEEP_MS = 14 * 24 * 60 * 60_000;
/** The most notes kept; past it the oldest finished go first, then the oldest. */
export const NOTES_MAX = 500;
/** The most notes one session may leave in an hour. */
export const NOTES_HOURLY = 10;
const HOUR_MS = 60 * 60_000;
/** The same title in a session is one note this long. */
export const SAME_TITLE_MS = 10 * 60_000;
/** A session's tool call, as its log names it: `notify_user`, or Claude's `mcp__cophyla-agents__notify_user`. */
export const NOTIFY_CALL = /(^|__)notify_user$/;
/** How long a session's `notify_user` call seen before its note came is kept to place it. */
const CALL_KEEP_MS = 2 * 60_000;
const CALLS_MAX = 20;
/** How long a send of the user's apps is remembered, and how many. */
const SENT_KEEP_MS = 3 * 60 * 60_000;
const SENT_MAX = 2000;
const SWEEP_MS = 60 * 60_000;
const SETTINGS_KEY = "settings";

/** What an agent's `notify_user` gave, read and checked. */
export interface NoteArgs {
  title: string;
  detail?: string;
  needsAnswer: boolean;
  urgent: boolean;
}

/** The arguments of a `notify_user` call, read; refused with words for the agent when they will not do. */
export function noteArgs(args: Record<string, unknown>): NoteArgs {
  const rawTitle = args["title"];
  if (typeof rawTitle !== "string" || rawTitle.trim() === "") throw new RpcError("invalid", "notify_user needs title: one line your user reads alone in their list of notes");
  const title = rawTitle.replace(/\s+/g, " ").trim();
  if (title.length > NOTE_TITLE_MAX) throw new RpcError("invalid", `the title is ${title.length} characters, and takes at most ${NOTE_TITLE_MAX}: keep it to one short line and put the rest in detail`);
  const rawDetail = args["detail"];
  if (rawDetail !== undefined && rawDetail !== null && typeof rawDetail !== "string") throw new RpcError("invalid", "detail is text: a few lines of markdown");
  const detail = typeof rawDetail === "string" ? rawDetail.trim() : "";
  if (detail.length > NOTE_DETAIL_MAX) throw new RpcError("invalid", `the detail is ${detail.length.toLocaleString("en-US")} characters, and takes at most ${NOTE_DETAIL_MAX.toLocaleString("en-US")}: say what your user needs in fewer words, and where to look for the rest`);
  const flag = (name: string): boolean => {
    const v = args[name];
    if (v === undefined || v === null) return false;
    if (typeof v !== "boolean") throw new RpcError("invalid", `${name} is true or false`);
    return v;
  };
  return { title, ...(detail ? { detail } : {}), needsAnswer: flag("needs_answer"), urgent: flag("urgent") };
}

/** What the agent is told once its note is left. */
export function noteAnswerText(n: Pick<Note, "needsAnswer">): string {
  return n.needsAnswer ? "Your user has the note, waiting for their answer: it comes as their next message to you." : "Your user has the note.";
}

export interface NotesDeps {
  store: Store;
  bus: Bus;
  log: Logger;
  /** Whether this node keeps the notes: the primary, or a node in no cluster. */
  routes: () => boolean;
  /** A session's newest events held on this node, to place a note when none of its events was heard yet; none for another node's. */
  history?: (id: string, opts: { limit?: number }) => SessionEvent[];
  now?: () => number;
  /** How long a turn cophylad typed waits to be told as the user's (`SENT_WAIT_MS`); a test shortens it. */
  sentWaitMs?: number;
}

/** A user's turn that may answer a session's notes. */
interface Turn {
  seq: number;
  at: number;
  text: string;
}

/** A session's `notify_user` call, heard in its log. */
interface Call {
  seq: number;
  id?: string;
  title?: string;
  at: number;
}

export class Notes {
  private d: NotesDeps;
  private now: () => number;
  private on: boolean;
  private notes = new Map<string, Note>();
  /** The newest event heard of each session. */
  private latest = new Map<string, number>();
  /** Notes not placed at their tool call yet. */
  private unplaced = new Set<string>();
  /** Each note's seq when it was left: a user's turn after it answers it, wherever the note is placed later. */
  private floor = new Map<string, number>();
  /** `notify_user` calls heard before their note came, by session. */
  private calls = new Map<string, Call[]>();
  /** Each session's notes in the last hour, with their titles, for the limits. */
  private recent = new Map<string, { at: number; title: string }[]>();
  /** The sends of the user's apps, by ref, with when each was told. */
  private sent = new Map<string, number>();
  /** Turns cophylad typed whose send is not told yet, by ref. */
  private waiting = new Map<string, { session: string; turn: Turn; timer: ReturnType<typeof setTimeout> }>();
  private offs: (() => void)[] = [];
  private sweepTimer?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(deps: NotesDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
    const s = deps.store.kv.get(NOTES_SETTINGS_NS, SETTINGS_KEY) as Partial<NotesState> | undefined;
    this.on = s?.on !== false;
    for (const key of deps.store.kv.list(NOTES_KV_NS)) {
      const n = deps.store.kv.get(NOTES_KV_NS, key) as Note | undefined;
      if (n && typeof n.id === "string" && typeof n.session === "string") this.notes.set(n.id, n);
    }
  }

  start(): void {
    this.offs.push(this.d.bus.on("session.event", (e) => this.onEvent(e)));
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
    (this.sweepTimer as { unref?: () => void }).unref?.();
    this.sweep();
  }

  stop(): void {
    this.stopped = true;
    for (const off of this.offs) off();
    this.offs = [];
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const w of this.waiting.values()) clearTimeout(w.timer);
    this.waiting.clear();
  }

  // --- what clients ask -------------------------------------------------------------------

  /** The notes not dismissed, oldest first. */
  list(): Note[] {
    return [...this.notes.values()].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  }

  /** Marks a note read or not, answered or open again: an answer taken back waits for the user's next message. */
  mark(id: string, p: { read?: boolean; answered?: boolean }): Note {
    const n = this.notes.get(id);
    if (!n) throw new RpcError("not_found", `no note ${id}`);
    const next: Note = { ...n };
    const now = this.now();
    if (p.read === true && next.read === undefined) next.read = now;
    if (p.read === false) delete next.read;
    if (p.answered === true && !next.answered) next.answered = { at: now, seq: n.seq, text: "" };
    if (p.answered === false && next.answered) {
      delete next.answered;
      // opened again: what the user writes from now answers it, not what they wrote before
      this.floor.set(id, Math.max(n.seq, this.latest.get(n.session) ?? n.seq));
    }
    return this.save(next);
  }

  dismiss(ids: readonly string[]): void {
    for (const id of new Set(ids)) {
      const n = this.notes.get(id);
      if (!n) continue;
      this.drop(n);
    }
  }

  state(): NotesState {
    return { on: this.on };
  }

  set(p: { on: boolean }): NotesState {
    if (p.on !== this.on) {
      this.on = p.on;
      this.d.store.kv.put(NOTES_SETTINGS_NS, SETTINGS_KEY, { on: p.on }, this.now());
      this.d.bus.emit("notes.state", this.state());
    }
    return this.state();
  }

  // --- what agents do ---------------------------------------------------------------------

  /**
   * A note `session`'s agent leaves the user, placed at the newest of its events heard, or at
   * its `notify_user` call when that was heard already. Refused while notes are off, past
   * `NOTES_HOURLY` in an hour, or when the same title went in the last `SAME_TITLE_MS`.
   */
  add(session: string, a: NoteArgs, call?: string): Note {
    if (!this.d.routes()) throw new RpcError("unavailable", "notes are kept by the primary");
    if (!this.on) throw new RpcError("denied", "your user switched notes off in Cophyla, so none was left: say it in your reply instead");
    const now = this.now();
    const recent = (this.recent.get(session) ?? []).filter((r) => now - r.at < HOUR_MS);
    const same = recent.find((r) => r.title === a.title && now - r.at < SAME_TITLE_MS);
    if (same) throw new RpcError("conflict", `a note with this title went to your user ${minutes(now - same.at)} ago, so it was not left again: change the title if this is something new`);
    if (recent.length >= NOTES_HOURLY) {
      const next = recent[0]!.at + HOUR_MS;
      throw new RpcError("quota_exceeded", `your session left ${NOTES_HOURLY} notes in the last hour, the most it may; the next can go in ${minutes(next - now)}. Say it in your reply instead, or gather what is left into one note then`);
    }
    const at = this.anchor(session);
    const seq = Math.max(0, at);
    const note: Note = { id: newId("note", now), session, seq, ...(call ? { call } : {}), title: a.title, ...(a.detail ? { detail: a.detail } : {}), needsAnswer: a.needsAnswer, urgent: a.urgent, at: now };
    this.floor.set(note.id, at);
    const heard = this.claimCall(session, note);
    if (heard) {
      note.seq = heard.seq;
      if (heard.id) note.call = heard.id;
    } else this.unplaced.add(note.id);
    recent.push({ at: now, title: a.title });
    this.recent.set(session, recent);
    this.save(note);
    this.d.log.info("an agent left the user a note", { id: note.id, session, seq: note.seq, call: call ?? null, placed: heard !== undefined, needsAnswer: note.needsAnswer, urgent: note.urgent });
    this.trim();
    return note;
  }

  /**
   * A message one of the user's apps sent a session (the desktop app, the phone, a browser), by
   * the `ref` its send answered: the turn that carries it is the user's own, and answers what
   * of that session's notes waits for an answer.
   */
  noteSent(session: string, ref: string): void {
    const now = this.now();
    this.sent.set(ref, now);
    if (this.sent.size > SENT_MAX) for (const [r, at] of this.sent) if (now - at > SENT_KEEP_MS || this.sent.size > SENT_MAX) this.sent.delete(r);
    const w = this.waiting.get(ref);
    if (!w || w.session !== session) return;
    clearTimeout(w.timer);
    this.waiting.delete(ref);
    if (!this.stopped) this.answer(session, w.turn);
  }

  // --- what sessions do -------------------------------------------------------------------

  private onEvent(e: SessionEvent): void {
    if (this.stopped || !this.d.routes()) return;
    if ((this.latest.get(e.session) ?? -1) < e.seq) this.latest.set(e.session, e.seq);
    const p = (e.payload ?? {}) as { tool?: unknown; id?: unknown; args?: unknown; text?: unknown; source?: unknown; ref?: unknown };
    if (e.kind === "tool_call" && typeof p.tool === "string" && NOTIFY_CALL.test(p.tool)) {
      const args = (p.args ?? {}) as { title?: unknown };
      this.heard(e.session, { seq: e.seq, at: this.now(), ...(typeof p.id === "string" ? { id: p.id } : {}), ...(typeof args.title === "string" ? { title: args.title.replace(/\s+/g, " ").trim() } : {}) });
      return;
    }
    if (e.kind !== "user_turn" || !this.waits(e.session)) return;
    if (typeof p.source !== "string" || !USERS.has(p.source)) return;
    const text = typeof p.text === "string" ? plainPrompt(p.text) : "";
    if (text === "" || NOT_ASKED.test(text)) return;
    const turn: Turn = { seq: e.seq, at: e.at, text };
    const ref = typeof p.ref === "string" ? p.ref : undefined;
    // sent through cophylad: the user's only when one of their apps sent it, which may be told a moment after
    if (ref !== undefined && !this.sent.has(ref)) {
      if (this.waiting.has(ref)) return;
      const timer = setTimeout(() => this.waiting.delete(ref), this.d.sentWaitMs ?? SENT_WAIT_MS);
      (timer as { unref?: () => void }).unref?.();
      this.waiting.set(ref, { session: e.session, turn, timer });
      return;
    }
    this.answer(e.session, turn);
  }

  /** A `notify_user` call in a session's log: the note it carries is placed at it, or it is kept for the note to come. */
  private heard(session: string, c: Call): void {
    const mine = [...this.unplaced].map((id) => this.notes.get(id)).filter((n): n is Note => n !== undefined && n.session === session).sort((a, b) => a.at - b.at);
    const n = (c.id !== undefined ? mine.find((m) => m.call === c.id) : undefined) ?? (c.title !== undefined ? mine.find((m) => m.title === c.title) : undefined);
    if (!n) {
      const now = this.now();
      const kept = (this.calls.get(session) ?? []).filter((k) => now - k.at < CALL_KEEP_MS);
      kept.push(c);
      this.calls.set(session, kept.slice(-CALLS_MAX));
      return;
    }
    this.unplaced.delete(n.id);
    this.save({ ...n, seq: c.seq, ...(c.id ? { call: c.id } : {}) });
  }

  /**
   * A call heard before its note came: by the harness's id for it; by the title only for a note
   * without one, or among calls whose row carries none (another call of the same title, one
   * refused a moment ago, is not this note's).
   */
  private claimCall(session: string, n: Note): Call | undefined {
    const now = this.now();
    const kept = (this.calls.get(session) ?? []).filter((k) => now - k.at < CALL_KEEP_MS);
    const byId = n.call !== undefined ? kept.findIndex((k) => k.id === n.call) : -1;
    const i = byId >= 0 ? byId : kept.findIndex((k) => k.title === n.title && (n.call === undefined || k.id === undefined));
    if (i < 0) {
      this.calls.set(session, kept);
      return undefined;
    }
    const [c] = kept.splice(i, 1);
    this.calls.set(session, kept);
    return c;
  }

  /** Whether a session has a note waiting for the user's answer. */
  private waits(session: string): boolean {
    for (const n of this.notes.values()) if (n.session === session && n.needsAnswer && !n.answered) return true;
    return false;
  }

  /** The user's own message to a session: it answers what of its notes waits for one, left before it. */
  private answer(session: string, t: Turn): void {
    for (const n of [...this.notes.values()]) {
      if (n.session !== session || !n.needsAnswer || n.answered) continue;
      const from = Math.min(n.seq, this.floor.get(n.id) ?? n.seq);
      if (t.seq <= from) continue;
      this.save({ ...n, answered: { at: t.at, seq: t.seq, text: cut(t.text, NOTE_ANSWER_MAX) } });
      this.d.log.info("the user answered a note", { id: n.id, session, seq: t.seq });
    }
  }

  /** Where a note of `session`'s goes until its call is heard: the newest of its events heard, else held here; -1 before every event. */
  private anchor(session: string): number {
    const heard = this.latest.get(session);
    if (heard !== undefined) return heard;
    try {
      return this.d.history?.(session, { limit: 1 })[0]?.seq ?? -1;
    } catch {
      return -1;
    }
  }

  // --- the rows ---------------------------------------------------------------------------

  private save(n: Note): Note {
    this.notes.set(n.id, n);
    this.d.store.kv.put(NOTES_KV_NS, n.id, n, this.now());
    this.d.bus.emit("note.state", n);
    return n;
  }

  private drop(n: Note): void {
    this.notes.delete(n.id);
    this.unplaced.delete(n.id);
    this.floor.delete(n.id);
    this.d.store.kv.delete(NOTES_KV_NS, n.id);
    this.d.bus.emit("note.state", { ...n, dismissed: true });
  }

  /** Past `NOTES_MAX`: the oldest finished notes go first, then the oldest. */
  private trim(): void {
    if (this.notes.size <= NOTES_MAX) return;
    const all = this.list();
    const order = [...all.filter((n) => !noteOpen(n)), ...all.filter((n) => noteOpen(n))];
    for (const n of order.slice(0, this.notes.size - NOTES_MAX)) this.drop(n);
  }

  /** Notes left more than `NOTES_KEEP_MS` ago go, and what was kept to place or answer them. */
  private sweep(): void {
    if (!this.d.routes()) return;
    const now = this.now();
    for (const n of this.list()) if (now - n.at > NOTES_KEEP_MS) this.drop(n);
    this.trim();
    for (const [s, list] of this.recent) {
      const kept = list.filter((r) => now - r.at < HOUR_MS);
      if (kept.length === 0) this.recent.delete(s);
      else this.recent.set(s, kept);
    }
    for (const [s, list] of this.calls) {
      const kept = list.filter((k) => now - k.at < CALL_KEEP_MS);
      if (kept.length === 0) this.calls.delete(s);
      else this.calls.set(s, kept);
    }
  }
}

function cut(text: string, n: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

/** A wait in whole minutes, as an agent reads it. */
function minutes(ms: number): string {
  const m = Math.max(1, Math.ceil(ms / 60_000));
  return m === 1 ? "a minute" : `${m} minutes`;
}
