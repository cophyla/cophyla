// The tracker: what the user asked each of their agents, followed until the agent's own words
// answer it, so an answer that came hours ago under other work is still one click away. The
// app calls each followed thing an ask; here it is a `Tracked`.
//
// It hears every session's events on the primary, which carries its linked nodes' too, and
// follows the sessions the user switched it on for: every one while it is on, less those
// switched off, or only those switched on while it is off. A message of the user's own (typed
// into its terminal, or sent or said from one of their apps; never another agent's, a
// leader's, the brain's, or what a script or tool sent through cophylad) is put to the
// judge (`judge.ts`) at once, which says what in it is worth following: each such thing
// becomes an open ask, in a line. The agent's messages (what it writes for the user to read,
// not its tool calls) in a turn the user started are gathered and put to the judge in one
// question with the asks still open (a turn another agent's message, a leader's, the brain's
// or a script's started is not the user's, and is never judged; one the agent starts itself to
// go on, a background job's notice, is the turn before's): at its turn's end, when it stops to ask the user something, and at most every
// `busyEveryMs` while a long turn goes on. Each answer it finds is kept with the ask, by the
// message's seq, and the ask goes partial or answered; it never goes back on its own. The user
// can set where an ask stands by hand, which the judging then leaves, and dismiss it.
//
// One judge runs at a time on the machine, the sessions taking turns. A usage limit stops the
// judging until it lifts and keeps what waits; the app is told (`tracker.state`'s health).
//
// The primary keeps it in kv: one row per ask under `tracker` (`<session>/<id>`), how far each
// followed session's events were read (`~seen/<session>`: up to its oldest message or request
// not yet judged, and the last request read), and the settings under `tracker.settings`. A
// restart catches up on a session of this machine's from its own events after that, a request
// already read passed over. An ask goes a week after its session ended, or when dismissed.

import { newId, TRACKED_ANSWERS_MAX, TRACKED_TITLE_MAX } from "@cophyla/protocol";
import type { Session, SessionEvent, Tracked, TrackedAnswer, TrackedStatus, TrackerHealth, TrackerState } from "@cophyla/protocol";
import { RpcError } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import { TRACKER_KV_NS, TRACKER_SETTINGS_NS } from "../grants/namespaces.ts";
import type { Logger } from "../log.ts";
import type { Store } from "../store/index.ts";
import { cut, GRADE_CHARS, JudgeLimited, JudgeUnavailable, MESSAGE_CHARS, plainPrompt, WORDS_CHARS } from "./judge.ts";
import type { Judge, JudgeAsk } from "./judge.ts";

/**
 * The sources of a user turn that can be the user's own words: typed, sent from an app, given
 * to a busy Codex, met by its hook. Never another agent's (`agent`, `peer`), a leader's (an
 * agent speaking as the user), or the brain's.
 */
const USERS = new Set(["typed", "sent", "queued", "hook"]);
/**
 * A user turn cophylad typed or gave (it carries the send's `ref`) is the user's own only when
 * the send came from one of their apps (`noteSent`): a script or a tool sends the same way. Its
 * turn can be read before the send's answer is back: it waits this long for it.
 */
const SENT_WAIT_MS = 15_000;
/** How long a send of the user's is remembered: a held one (focus) is typed up to two hours later. */
const SENT_KEEP_MS = 3 * 60 * 60_000;
const SENT_MAX = 2000;
/** A user turn that is no request: a slash command, or a notice the harness wrote in the user's place. */
const NOT_ASKED = /^\s*(\/|<task-notification|<command-|<local-command|<bash-|<user-prompt-submit-hook|\[Request interrupted)/;
/** A user turn the harness wrote to go on with the turn before: a background job's or a sub-agent's notice. */
const NOTICE = /^\s*(<task-notification|<local-command|<user-prompt-submit-hook)/;
/** The same words met twice this soon (a hook and the transcript) are one message. */
const SAME_PROMPT_MS = 60_000;

/** How many asks of a session the judge is shown when it reads a new message: the newest. */
const EXTRACT_ASKS = 20;
/** The most asks a session keeps; past it the oldest go. */
export const SESSION_ASKS_MAX = 100;
/** The most of the agent's messages waiting to be judged a session holds; past it the oldest go. */
const PENDING_MAX = 200;
/** The most of a user's message kept beside an ask, for the judge. */
const WORDS_KEPT = 2000;
/** An ask goes this long after its session ended. */
export const PRUNE_MS = 7 * 24 * 60 * 60_000;
/** An ask of a session this node knows nothing of any more goes after this long unchanged. */
const ORPHAN_MS = 30 * 24 * 60 * 60_000;
const SWEEP_MS = 60 * 60_000;
/** How often how far each session was read is written down. */
const SEEN_FLUSH_MS = 10_000;
/** After a start, how long the tracker waits for sessions to be met before catching up on them. */
const CATCH_UP_DELAY_MS = 5_000;
/** The most of a session's own events a catch-up reads. */
const CATCH_UP_EVENTS = 400;
/** How many times one question may fail for no reason the judge gives before it is let go. */
const TRIES = 2;
/** Failed questions in a row after which the judge is told as unavailable. */
const FAILURES_UNWELL = 4;
export const BUSY_EVERY_MS = 120_000;
/** A message that comes once its turn is over is judged this soon, with what else comes now. */
const SOON_MS = 1500;
/** The least a stop of the judging lasts. */
const MIN_PAUSE_MS = 30_000;
/** How long the judging stops when no account can judge. */
const UNAVAILABLE_PAUSE_MS = 5 * 60_000;

const SETTINGS_KEY = "settings";
const SEEN = "~seen/";

/** An ask as kv keeps it: with the start of what the user wrote, which only the judge reads. */
interface Row extends Tracked {
  words?: string;
}

interface Settings {
  on: boolean;
  sessions: Record<string, boolean>;
  profile?: string;
}

/** How far a session was read, as kv keeps it: every event to `seq` judged or let go, and the last request read. */
interface Mark {
  seq: number;
  prompts: number;
}

interface Prompt {
  seq: number;
  at: number;
  text: string;
  before?: string;
  tries: number;
}

interface Said {
  seq: number;
  at: number;
  text: string;
}

/** What waits for the judge in a followed session. */
interface Track {
  prompts: Prompt[];
  said: Said[];
  /** The agent's last message, which a short reply of the user's answers. */
  lastText?: string;
  lastPrompt?: { text: string; at: number };
  timer?: ReturnType<typeof setTimeout>;
  queued: boolean;
  lastGradeAt: number;
  gradeTries: number;
  /** The last request of the user's put to the judge, or let go: a catch-up reads none again. */
  prompted: number;
  /** Its events since the last start were checked against how far it was read before. */
  caughtUp: boolean;
  /** Its missed events are being taken in: the judging waits for the last of them. */
  catching?: boolean;
  /** A turn is under way: a turn's first message was met since it last came to rest. */
  inTurn: boolean;
  /** Who started the turn under way: the user, or anyone else (whose turn is never judged); unknown after a start. */
  owner?: "user" | "other";
  /** Who started the turn before, which a turn the agent starts itself to go on (a job's notice) is. */
  lastOwner?: "user" | "other";
  /** The turn under way was started by a message cophylad typed whose send is not told yet as the user's. */
  pendingStart?: { ref: string; seq: number };
}

export interface TrackerDeps {
  store: Store;
  bus: Bus;
  log: Logger;
  /** Whether this node keeps the tracker: the primary, or a node in no cluster. */
  routes: () => boolean;
  /** A session this node knows, live or ended: its own or a linked node's. */
  session: (id: string) => Session | undefined;
  /** A session's events held on this node, for a catch-up; none for another node's. */
  history?: (id: string, opts: { before?: number; limit?: number }) => SessionEvent[];
  judge: Judge;
  busyEveryMs?: number;
  now?: () => number;
  catchUpDelayMs?: number;
  /** The least a stop of the judging lasts (`MIN_PAUSE_MS`); a test shortens it. */
  minPauseMs?: number;
  /** How soon a message after its turn's end is judged (`SOON_MS`); a test shortens it. */
  soonMs?: number;
  /** How long a turn cophylad typed waits to be told as the user's (`SENT_WAIT_MS`); a test shortens it. */
  sentWaitMs?: number;
}

const RANK: Record<TrackedStatus, number> = { open: 0, partial: 1, answered: 2 };

const keyOf = (session: string, id: string) => `${session}/${id}`;

function view(row: Row): Tracked {
  const { words: _words, ...t } = row;
  return t;
}

export class Tracker {
  private d: TrackerDeps;
  private now: () => number;
  private busyEveryMs: number;
  private settings: Settings;
  private health?: TrackerHealth;
  private tracks = new Map<string, Track>();
  private queue: string[] = [];
  private working = false;
  private pausedUntil = 0;
  private resume?: ReturnType<typeof setTimeout>;
  /** The latest event heard of each followed session. */
  private seen = new Map<string, number>();
  private dirtySeen = new Set<string>();
  /** The marks last written, so an unchanged one is not written again. */
  private written = new Map<string, string>();
  /** The sends of the user's apps, by ref, with when each was told. */
  private sent = new Map<string, number>();
  /** Turns cophylad typed whose send is not told yet, by ref. */
  private waiting = new Map<string, { session: string; prompt: Prompt; timer: ReturnType<typeof setTimeout> }>();
  private offs: (() => void)[] = [];
  private timers: ReturnType<typeof setInterval | typeof setTimeout>[] = [];
  private idleWaiters: (() => void)[] = [];
  private stopped = false;
  /** Questions in a row the judge gave no usable answer to. */
  private failures = 0;

  constructor(deps: TrackerDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
    this.busyEveryMs = deps.busyEveryMs ?? BUSY_EVERY_MS;
    this.settings = this.readSettings();
  }

  start(): void {
    this.offs.push(
      this.d.bus.on("session.event", (e) => this.onEvent(e)),
      this.d.bus.on("session.state", (s) => {
        // a turn that ended with its process: what it said is judged now
        if (s.status === "ended" && this.tracks.has(s.id)) this.due(s.id);
      }),
    );
    const sweep = setInterval(() => this.sweep(), SWEEP_MS);
    const flush = setInterval(() => this.flushSeen(), SEEN_FLUSH_MS);
    const catchUp = setTimeout(() => this.catchUpAll(), this.d.catchUpDelayMs ?? CATCH_UP_DELAY_MS);
    for (const t of [sweep, flush, catchUp]) (t as { unref?: () => void }).unref?.();
    this.timers.push(sweep, flush, catchUp);
  }

  stop(): void {
    this.stopped = true;
    for (const off of this.offs) off();
    this.offs = [];
    for (const t of this.timers) clearTimeout(t as ReturnType<typeof setTimeout>);
    this.timers = [];
    if (this.resume) clearTimeout(this.resume);
    for (const t of this.tracks.values()) if (t.timer) clearTimeout(t.timer);
    for (const w of this.waiting.values()) clearTimeout(w.timer);
    this.waiting.clear();
    this.flushSeen();
  }

  // --- what clients ask -------------------------------------------------------------------

  list(session?: string): Tracked[] {
    return this.rows(session)
      .filter((r) => !r.dismissed)
      .sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq)
      .map(view);
  }

  dismiss(ids: readonly string[]): void {
    const wanted = new Set(ids);
    for (const key of this.d.store.kv.list(TRACKER_KV_NS)) {
      if (key.startsWith(SEEN)) continue;
      const id = key.slice(key.indexOf("/") + 1);
      if (!wanted.has(id)) continue;
      const row = this.d.store.kv.get(TRACKER_KV_NS, key) as Row | undefined;
      this.d.store.kv.delete(TRACKER_KV_NS, key);
      if (row) this.d.bus.emit("tracked.state", { ...view(row), dismissed: true, updatedAt: this.now() });
    }
  }

  mark(id: string, status: TrackedStatus): Tracked {
    const row = this.find(id);
    if (!row) throw new RpcError("not_found", `no ask ${id}`);
    return view(this.save({ ...row, status, marked: true, updatedAt: this.now() }));
  }

  state(): TrackerState {
    return { on: this.settings.on, sessions: { ...this.settings.sessions }, ...(this.settings.profile ? { profile: this.settings.profile } : {}), ...(this.health ? { health: this.health } : {}) };
  }

  /** The account the judge runs under, as the user set it; the usual one when undefined. */
  profile(): string | undefined {
    return this.settings.profile;
  }

  set(patch: { on?: boolean; session?: { id: string; on: boolean | null }; profile?: string | null }): TrackerState {
    const before = new Map<string, boolean>();
    const known = new Set([...this.tracks.keys(), ...Object.keys(this.settings.sessions)]);
    if (patch.session) known.add(patch.session.id);
    for (const id of known) before.set(id, this.follows(id));
    const next: Settings = { on: this.settings.on, sessions: { ...this.settings.sessions }, ...(this.settings.profile ? { profile: this.settings.profile } : {}) };
    if (patch.on !== undefined) next.on = patch.on;
    if (patch.session) {
      if (patch.session.on === null) delete next.sessions[patch.session.id];
      else next.sessions[patch.session.id] = patch.session.on;
    }
    if (patch.profile === null) delete next.profile;
    else if (patch.profile !== undefined) next.profile = patch.profile;
    const flipped = patch.on !== undefined && patch.on !== this.settings.on;
    this.settings = next;
    this.d.store.kv.put(TRACKER_SETTINGS_NS, SETTINGS_KEY, next, this.now());
    // a session followed afresh starts from now: what it said while it was not followed is not caught up on
    if (flipped) {
      for (const key of this.d.store.kv.list(TRACKER_KV_NS, SEEN)) this.d.store.kv.delete(TRACKER_KV_NS, key);
      this.written.clear();
    }
    for (const id of known) {
      const now = this.follows(id);
      if (now === before.get(id)) continue;
      this.forget(id);
      if (now) {
        this.d.store.kv.delete(TRACKER_KV_NS, SEEN + id);
        this.seen.delete(id);
        this.dirtySeen.delete(id);
        this.written.delete(id);
      }
    }
    if (patch.profile !== undefined && this.health?.state === "unavailable") {
      delete this.health;
      this.pausedUntil = 0;
      this.failures = 0;
    }
    this.told();
    void this.work();
    return this.state();
  }

  /** Resolves once nothing waits for the judge and none runs: for tests and kits. */
  settled(): Promise<void> {
    if (!this.working && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  // --- what sessions do -------------------------------------------------------------------

  /** Whether the tracker follows a session: its own switch, else the tracker's. */
  follows(id: string): boolean {
    const own = this.settings.sessions[id];
    return own ?? this.settings.on;
  }

  private onEvent(e: SessionEvent): void {
    if (this.stopped || !this.d.routes()) return;
    if (!this.follows(e.session)) return;
    const s = this.d.session(e.session);
    if (!s || s.role === "assistant") return;
    const t = this.trackOf(e.session);
    if (!t.caughtUp) {
      t.caughtUp = true;
      this.catchUp(e.session, t, e.seq);
    }
    this.take(e.session, t, e);
    this.read(e.session, e.seq);
  }

  private trackOf(id: string): Track {
    let t = this.tracks.get(id);
    if (!t) {
      t = { prompts: [], said: [], queued: false, lastGradeAt: 0, gradeTries: 0, prompted: -1, caughtUp: false, inTurn: false };
      this.tracks.set(id, t);
    }
    return t;
  }

  private forget(id: string): void {
    const t = this.tracks.get(id);
    if (t?.timer) clearTimeout(t.timer);
    this.tracks.delete(id);
    this.queue = this.queue.filter((q) => q !== id);
  }

  /** One event of a followed session: a request, a message to judge, or a moment to judge. */
  private take(id: string, t: Track, e: SessionEvent): void {
    const p = (e.payload ?? {}) as { text?: unknown; source?: unknown; status?: unknown };
    switch (e.kind) {
      case "user_turn": {
        const text = typeof p.text === "string" ? plainPrompt(p.text) : "";
        const ref = typeof (p as { ref?: unknown }).ref === "string" ? ((p as { ref: string }).ref) : undefined;
        const users = typeof p.source === "string" && USERS.has(p.source);
        // whose the turn is: the user's own words, anyone else's, or the harness going on with the turn before
        const by = !users ? "other" : NOTICE.test(text) ? "continue" : ref !== undefined && !this.sent.has(ref) ? "pending" : "user";
        this.ownTurn(t, by, ref, e.seq);
        if (!users || text === "" || NOT_ASKED.test(text)) return;
        const prompt: Prompt = { seq: e.seq, at: e.at, text, ...(t.lastText !== undefined ? { before: t.lastText } : {}), tries: 0 };
        // sent through cophylad: the user's only when one of their apps sent it, which may be told a moment after
        if (by === "pending") this.hold(id, ref!, prompt);
        else this.ask(id, t, prompt);
        return;
      }
      case "assistant_text": {
        if (typeof p.text !== "string" || p.text.trim() === "") return;
        t.lastText = p.text;
        // a turn someone else started answers nothing of the user's, and costs no judging
        if (t.owner === "other") return;
        t.said.push({ seq: e.seq, at: e.at, text: p.text });
        if (t.said.length > PENDING_MAX) t.said.splice(0, t.said.length - PENDING_MAX);
        if (t.queued) return;
        // the turn is over (its end can be told before its last words are read): judged in a
        // moment, with whatever else of it comes now; while it goes on, every busyEveryMs
        const over = this.d.session(id)?.status !== "busy";
        if (over && t.timer) clearTimeout(t.timer);
        else if (t.timer) return;
        const wait = over ? (this.d.soonMs ?? SOON_MS) : Math.max(0, t.lastGradeAt + this.busyEveryMs - this.now()) || this.busyEveryMs;
        t.timer = setTimeout(() => {
          t.timer = undefined;
          this.due(id);
        }, wait);
        (t.timer as { unref?: () => void }).unref?.();
        return;
      }
      case "status":
        // at rest: the turn is over, and the next message starts the next one
        if (p.status === "idle" || p.status === "ended") {
          t.inTurn = false;
          if (t.owner !== undefined) t.lastOwner = t.owner;
        }
        // the turn is over, or the session waits on the user: what it said is judged now
        if (p.status !== "busy" && t.said.length > 0) this.due(id);
        return;
      case "ask":
        if (t.said.length > 0) this.due(id);
        return;
      default:
        return;
    }
  }

  /** A request of the user's, to be read for what it asks. */
  private ask(id: string, t: Track, p: Prompt): void {
    if (t.lastPrompt && t.lastPrompt.text === p.text && p.at - t.lastPrompt.at < SAME_PROMPT_MS) return;
    t.lastPrompt = { text: p.text, at: p.at };
    t.prompts.push(p);
    this.due(id);
  }

  /**
   * Whose the turn is, as each of its user turns comes: the first after the session came to rest
   * starts it (anyone else's message makes it theirs, a notice the harness wrote goes on with
   * the turn before's owner), and the user's own words make it the user's wherever they come.
   * A message cophylad typed whose send is not told yet starts a turn as the user's, until it
   * is let go.
   */
  private ownTurn(t: Track, by: "user" | "other" | "continue" | "pending", ref: string | undefined, seq: number): void {
    const starts = !t.inTurn;
    t.inTurn = true;
    if (by === "user") {
      t.owner = "user";
      return;
    }
    if (!starts) return;
    if (by === "other") t.owner = "other";
    else if (by === "continue") t.owner = t.lastOwner ?? t.owner;
    else {
      t.owner = "user";
      t.pendingStart = { ref: ref!, seq };
    }
  }

  /** A turn cophylad typed, kept until its send is told as one of the user's apps', and let go after `SENT_WAIT_MS`. */
  private hold(id: string, ref: string, p: Prompt): void {
    if (this.waiting.has(ref)) return;
    const timer = setTimeout(() => {
      this.waiting.delete(ref);
      // never told: a script's or a tool's message, so a turn it started is none of the user's
      const t = this.tracks.get(id);
      if (t?.pendingStart?.ref !== ref) return;
      const from = t.pendingStart.seq;
      delete t.pendingStart;
      if (t.inTurn) t.owner = "other";
      else t.lastOwner = "other";
      t.said = t.said.filter((m) => m.seq < from);
    }, this.d.sentWaitMs ?? SENT_WAIT_MS);
    (timer as { unref?: () => void }).unref?.();
    this.waiting.set(ref, { session: id, prompt: p, timer });
  }

  /**
   * A message one of the user's apps sent a session (the desktop app, the phone, a browser),
   * by the `ref` its send answered: the turn that carries it is the user's own. One a script or
   * a tool sent through cophylad is never told, and its turn is no ask.
   */
  noteSent(session: string, ref: string): void {
    const now = this.now();
    this.sent.set(ref, now);
    if (this.sent.size > SENT_MAX) for (const [r, at] of this.sent) if (now - at > SENT_KEEP_MS || this.sent.size > SENT_MAX) this.sent.delete(r);
    const w = this.waiting.get(ref);
    if (!w || w.session !== session) return;
    clearTimeout(w.timer);
    this.waiting.delete(ref);
    if (this.stopped || !this.follows(session)) return;
    const t = this.trackOf(session);
    // the user's own words: the turn they are in is the user's, and what it said waited for this
    if (t.pendingStart?.ref === ref) delete t.pendingStart;
    if (t.inTurn) t.owner = "user";
    this.ask(session, t, w.prompt);
    if (t.said.length > 0) this.due(session);
  }

  private due(id: string): void {
    const t = this.tracks.get(id);
    if (!t || t.catching) return;
    if (t.timer) {
      clearTimeout(t.timer);
      t.timer = undefined;
    }
    if (!t.queued) {
      t.queued = true;
      this.queue.push(id);
    }
    void this.work();
  }

  private async work(): Promise<void> {
    if (this.working || this.stopped) return;
    this.working = true;
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const wait = this.pausedUntil - this.now();
        if (wait > 0) {
          if (!this.resume) {
            this.resume = setTimeout(() => {
              this.resume = undefined;
              void this.work();
            }, wait);
            (this.resume as { unref?: () => void }).unref?.();
          }
          break;
        }
        const id = this.queue.shift()!;
        const t = this.tracks.get(id);
        if (!t) continue;
        t.queued = false;
        const held = await this.judgeSession(id, t);
        if (held) {
          // the judging stopped (a limit, no account): it waits at the front for its turn again
          if (!t.queued) {
            t.queued = true;
            this.queue.unshift(id);
          }
        }
      }
    } finally {
      this.working = false;
      if (this.queue.length === 0 || this.pausedUntil > this.now()) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const w of waiters) w();
      }
    }
  }

  /** What waits in one session, put to the judge: its new requests first, then its messages. True when the judging had to stop. */
  private async judgeSession(id: string, t: Track): Promise<boolean> {
    while (t.prompts.length > 0) {
      const p = t.prompts[0]!;
      const asks = this.rows(id)
        .filter((r) => !r.dismissed)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-EXTRACT_ASKS);
      try {
        const r = await this.d.judge.extract({ text: p.text, ...(p.before !== undefined ? { before: p.before } : {}), asks: asks.map((a, i) => ({ n: i + 1, title: a.title })) });
        this.judged();
        t.prompts.shift();
        t.prompted = Math.max(t.prompted, p.seq);
        for (const a of r.amend) {
          const row = asks[a.ask - 1];
          if (row && row.title !== a.title) this.save({ ...row, title: a.title.slice(0, TRACKED_TITLE_MAX), updatedAt: this.now() });
        }
        for (const a of r.asks) this.add(id, p, a.title);
      } catch (e) {
        if (this.stoppedBy(e)) return true;
        if (++p.tries >= TRIES) {
          t.prompts.shift();
          t.prompted = Math.max(t.prompted, p.seq);
          // what the judge could not read is still followed, under its first words
          if (p.text.split(/\s+/).length >= 4) this.add(id, p, firstLine(p.text));
        }
        this.failed(e);
      }
    }
    return this.grade(id, t);
  }

  private async grade(id: string, t: Track): Promise<boolean> {
    if (t.said.length === 0) return false;
    let open = this.openRows(id);
    if (open.length === 0) {
      t.said = [];
      return false;
    }
    // a message before every open ask was asked answers none of them
    const first = Math.min(...open.map((r) => r.seq));
    t.said = t.said.filter((m) => m.seq > first);
    // what came since a message cophylad typed whose send is not told yet waits for it
    const ready = (): Said[] => (t.pendingStart ? t.said.filter((m) => m.seq < t.pendingStart!.seq) : t.said);
    while (ready().length > 0) {
      const batch = takeBatch(ready());
      open = this.openRows(id);
      if (open.length === 0) {
        t.said = [];
        break;
      }
      const asks: JudgeAsk[] = open.map((r, i) => ({ n: i + 1, title: r.title, ...(r.words ? { words: cut(r.words, WORDS_CHARS) } : {}) }));
      try {
        const r = await this.d.judge.grade({ asks, messages: batch.map((m, i) => ({ n: i + 1, text: m.text })) });
        this.judged();
        t.said.splice(0, batch.length);
        t.gradeTries = 0;
        for (const res of r.results) {
          const row = open[res.ask - 1];
          if (!row || res.status === "open") continue;
          const said = res.messages.map((n) => batch[n - 1]).filter((m): m is Said => m !== undefined && m.seq > row.seq);
          if (said.length === 0) continue;
          this.answer(row, res.status, said);
        }
      } catch (e) {
        if (this.stoppedBy(e)) return true;
        this.failed(e);
        if (++t.gradeTries >= TRIES) {
          t.said.splice(0, batch.length);
          t.gradeTries = 0;
        } else break;
      }
    }
    t.lastGradeAt = this.now();
    return false;
  }

  private answer(row: Row, status: "partial" | "answered", said: Said[]): void {
    const answers: TrackedAnswer[] = [...row.answers];
    for (const m of said) {
      const had = answers.findIndex((a) => a.seq === m.seq);
      if (had >= 0) {
        if (RANK[status] > RANK[answers[had]!.status]) answers[had] = { ...answers[had]!, status };
      } else if (answers.length < TRACKED_ANSWERS_MAX) answers.push({ seq: m.seq, at: m.at, status });
    }
    answers.sort((a, b) => a.seq - b.seq);
    const next = row.marked || RANK[status] <= RANK[row.status] ? row.status : status;
    this.save({ ...row, status: next, answers, updatedAt: this.now() });
  }

  private add(session: string, p: Prompt, title: string): void {
    const row: Row = {
      id: newId("tracked", this.now()),
      session,
      seq: p.seq,
      title: title.slice(0, TRACKED_TITLE_MAX),
      status: "open",
      answers: [],
      createdAt: p.at,
      updatedAt: this.now(),
      words: p.text.slice(0, WORDS_KEPT),
    };
    this.save(row);
    const kept = this.rows(session).sort((a, b) => a.createdAt - b.createdAt);
    for (const old of kept.slice(0, Math.max(0, kept.length - SESSION_ASKS_MAX))) this.d.store.kv.delete(TRACKER_KV_NS, keyOf(session, old.id));
  }

  // --- the judge's health -----------------------------------------------------------------

  /** A question answered: the judging is well again if it was not. */
  private judged(): void {
    this.failures = 0;
    if (this.health?.state === "ok") return;
    this.health = { state: "ok", at: this.now() };
    this.told();
  }

  /** Whether a failure stops the judging for now: a limit until it lifts, no account until the settings change or the next request. */
  private stoppedBy(e: unknown): boolean {
    if (e instanceof JudgeLimited) {
      this.pausedUntil = Math.max(e.retryAt ?? this.now() + 15 * 60_000, this.now() + (this.d.minPauseMs ?? MIN_PAUSE_MS));
      this.setHealth({ state: "limited", detail: cut(e.message, 300), at: this.now() });
      this.d.log.info("the tracker waits for the account's usage limit to lift", { until: new Date(this.pausedUntil).toISOString() });
      return true;
    }
    if (e instanceof JudgeUnavailable) {
      // no account to judge with: tried again in a while, or at once when the settings change
      this.pausedUntil = this.now() + (this.d.minPauseMs ?? UNAVAILABLE_PAUSE_MS);
      this.setHealth({ state: "unavailable", detail: cut(e.message, 300), at: this.now() });
      return true;
    }
    return false;
  }

  private failed(e: unknown): void {
    const why = e instanceof Error ? e.message : String(e);
    this.d.log.warn("the tracker's judge gave no usable answer", { error: why });
    // one bad answer is the model's; several in a row, the judge's
    if (++this.failures >= FAILURES_UNWELL) this.setHealth({ state: "unavailable", detail: cut(`the judge keeps failing: ${why}`, 300), at: this.now() });
  }

  private setHealth(h: TrackerHealth): void {
    const same = this.health?.state === h.state && this.health.detail === h.detail;
    this.health = h;
    if (!same) this.told();
  }

  private told(): void {
    this.d.bus.emit("tracker.state", this.state());
  }

  // --- the rows ---------------------------------------------------------------------------

  private rows(session?: string): Row[] {
    const keys = this.d.store.kv.list(TRACKER_KV_NS, session !== undefined ? `${session}/` : "");
    const out: Row[] = [];
    for (const key of keys) {
      if (key.startsWith(SEEN)) continue;
      const row = this.d.store.kv.get(TRACKER_KV_NS, key) as Row | undefined;
      if (row) out.push(row);
    }
    return out;
  }

  private openRows(session: string): Row[] {
    return this.rows(session)
      .filter((r) => !r.dismissed && !r.marked && r.status !== "answered")
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  private find(id: string): Row | undefined {
    for (const key of this.d.store.kv.list(TRACKER_KV_NS)) {
      if (!key.startsWith(SEEN) && key.endsWith(`/${id}`)) return this.d.store.kv.get(TRACKER_KV_NS, key) as Row | undefined;
    }
    return undefined;
  }

  private save(row: Row): Row {
    this.d.store.kv.put(TRACKER_KV_NS, keyOf(row.session, row.id), row, this.now());
    this.d.bus.emit("tracked.state", view(row));
    return row;
  }

  private readSettings(): Settings {
    const v = this.d.store.kv.get(TRACKER_SETTINGS_NS, SETTINGS_KEY) as Partial<Settings> | undefined;
    return { on: v?.on === true, sessions: v?.sessions && typeof v.sessions === "object" ? { ...v.sessions } : {}, ...(typeof v?.profile === "string" ? { profile: v.profile } : {}) };
  }

  // --- reading on after a start -------------------------------------------------------------

  private read(id: string, seq: number): void {
    if ((this.seen.get(id) ?? -1) >= seq) return;
    this.seen.set(id, seq);
    this.dirtySeen.add(id);
  }

  /**
   * Writes down how far each followed session was read: up to its oldest message or request
   * still waiting for the judge, so a stop loses none of them, with the last request read.
   */
  private flushSeen(): void {
    for (const id of new Set([...this.dirtySeen, ...this.tracks.keys()])) {
      const latest = this.seen.get(id);
      if (latest === undefined || !this.follows(id)) continue;
      const t = this.tracks.get(id);
      const waiting = Math.min(t?.said[0]?.seq ?? Infinity, t?.prompts[0]?.seq ?? Infinity);
      const mark: Mark = { seq: Math.min(latest, waiting - 1), prompts: t?.prompted ?? -1 };
      const json = JSON.stringify(mark);
      if (this.written.get(id) === json) continue;
      this.written.set(id, json);
      this.d.store.kv.put(TRACKER_KV_NS, SEEN + id, mark, this.now());
    }
    this.dirtySeen.clear();
  }

  /** A session's mark as written; none for one not followed since it was last switched on. */
  private markOf(id: string): Mark | undefined {
    const v = this.d.store.kv.get(TRACKER_KV_NS, SEEN + id) as Partial<Mark> | undefined;
    if (!v || typeof v.seq !== "number") return undefined;
    return { seq: v.seq, prompts: typeof v.prompts === "number" ? v.prompts : -1 };
  }

  /** A session's events between where it was read to before the start and `upTo`, taken as if they had just come, a request read already passed over: only a session of this node's has them. */
  private catchUp(id: string, t: Track, upTo: number): void {
    const mark = this.markOf(id);
    if (!mark) return;
    t.prompted = Math.max(t.prompted, mark.prompts);
    if (upTo <= mark.seq + 1 || !this.d.history) return;
    let missed: SessionEvent[];
    try {
      missed = this.d.history(id, { before: upTo, limit: CATCH_UP_EVENTS }).filter((e) => e.seq > mark.seq && e.seq < upTo && !(e.kind === "user_turn" && e.seq <= mark.prompts));
    } catch {
      return;
    }
    if (missed.length === 0) return;
    this.d.log.info("the tracker caught up on a session", { session: id, from: mark.seq + 1, to: upTo - 1, events: missed.length });
    t.catching = true;
    try {
      for (const e of missed.sort((a, b) => a.seq - b.seq)) this.take(id, t, e);
    } finally {
      t.catching = false;
    }
    // what came while it was away is judged now, not at the next turn's end
    if (t.said.length > 0 || t.prompts.length > 0) this.due(id);
  }

  /** After a start: every followed session of this node's with asks still open catches up on what it said meanwhile. */
  private catchUpAll(): void {
    if (this.stopped || !this.d.routes()) return;
    const sessions = new Set(this.rows().filter((r) => !r.dismissed && !r.marked && r.status !== "answered").map((r) => r.session));
    for (const id of sessions) {
      if (!this.follows(id) || this.tracks.get(id)?.caughtUp) continue;
      const s = this.d.session(id);
      if (!s) continue;
      const latest = this.d.history?.(id, { limit: 1 })[0];
      if (!latest) continue;
      const t = this.trackOf(id);
      t.caughtUp = true;
      this.catchUp(id, t, latest.seq + 1);
      this.read(id, latest.seq);
    }
  }

  // --- going ------------------------------------------------------------------------------

  private sweep(): void {
    if (!this.d.routes()) return;
    const now = this.now();
    const ended = (id: string): boolean => {
      const s = this.d.session(id);
      if (!s) return false;
      return s.status === "ended" && now - (s.endedAt ?? s.lastActivity) > PRUNE_MS;
    };
    for (const row of this.rows()) {
      const s = this.d.session(row.session);
      if (ended(row.session) || (!s && now - row.updatedAt > ORPHAN_MS)) this.d.store.kv.delete(TRACKER_KV_NS, keyOf(row.session, row.id));
    }
    for (const key of this.d.store.kv.list(TRACKER_KV_NS, SEEN)) if (ended(key.slice(SEEN.length))) this.d.store.kv.delete(TRACKER_KV_NS, key);
    const gone = Object.keys(this.settings.sessions).filter(ended);
    if (gone.length > 0) {
      const sessions = { ...this.settings.sessions };
      for (const id of gone) delete sessions[id];
      this.settings = { ...this.settings, sessions };
      this.d.store.kv.put(TRACKER_SETTINGS_NS, SETTINGS_KEY, this.settings, now);
    }
  }
}

/** The first line of what the user wrote, as an ask's line when the judge could not give one. */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? text;
  return cut(line.replace(/\s+/g, " ").trim(), 80);
}

/** The oldest messages that fit one question: at least one, however long. */
function takeBatch(said: Said[]): Said[] {
  const out: Said[] = [];
  let size = 0;
  for (const m of said) {
    const len = Math.min(m.text.length, MESSAGE_CHARS) + 8;
    if (out.length > 0 && size + len > GRADE_CHARS) break;
    out.push(m);
    size += len;
  }
  return out;
}
