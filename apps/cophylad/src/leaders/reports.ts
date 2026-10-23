// What a session a leader messaged does next, told to the leader: each message a leader sends
// as the user opens a watch on that session, or adds to the one open, holding the message's
// ref. The primary's bus hears every node's session events, so the watch lives there. The watch
// opens before the message goes, since a session can take it before its send is answered (one
// over ACP, one on another machine): what it does meanwhile is kept, and heard once the ref is.
//
// The message lands when the session records it (a `user_turn`, or a `notification` that it was
// delivered, with its ref); one that was withdrawn is told to the leader as not delivered, with
// why. While the watch is open, an ask the session raises (its permission prompt, question or
// plan) reaches the leader as a notice from cophyla with the ask's id and options, which it may
// answer as the user (`answer_ask`). Once the message landed and the session settles idle, as a
// listener hears an idle (it holds for a few seconds and nothing else comes, the last words kept
// across a second idle), its last words reach the leader as a message from it, in its envelope:
// information, never the user's. A harness whose idle says no words (ACP) gives the last text it
// wrote. The session ending is told too. A watch closes with its report, with the session's end,
// with the leader's, when the leader leads it no more, or after a day. Watches are kept in
// memory alone: a daemon restart drops the open ones.
// The chat is no agent: its own route (the brain's work listeners) tells it what it needs.

import type { Ask, Session, SessionEvent } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import { carryLastWords } from "../listeners/index.ts";
import type { Logger } from "../log.ts";

/** How long a watch stays open with nothing heard. */
const STALE_MS = 24 * 60 * 60_000;
const SWEEP_MS = 10 * 60_000;
/** How much of an ask's detail a notice carries. */
const DETAIL_CHARS = 1500;

export interface ReportsDeps {
  bus: Bus;
  log: Logger;
  /** Whether this node routes agents' messages: the primary, or a node in no cluster. */
  routes: () => boolean;
  /** Whether a node can be reached now: a machine whose link dropped lists its sessions as ended. */
  linked: (node: string) => boolean;
  /** Whether `leader` still leads `target`. */
  leads: (leader: string, target: string) => boolean;
  /** A session's alias, as the directory gives it. */
  alias: (session: string) => string;
  /** Tells the leader: a notice from cophyla, or `from`'s words in its envelope. */
  tell: (leader: string, text: string, from?: { session: string; replyTo?: string }) => Promise<void>;
  /** How long an idle must hold before it is heard (the listeners' settle). */
  settleMs: number;
  now?: () => number;
}

interface Watch {
  leader: string;
  target: string;
  /** The messages sent, by ref: their ids, and whether each has landed. */
  sent: Map<string, { id: string; landed: boolean }>;
  /** The id of the last message that landed, which the report answers. */
  last?: string;
  /** The asks already told. */
  asked: Set<string>;
  /** What it said last since the message landed: the words of a harness whose idle carries none (ACP). */
  said?: string;
  /** An idle held while it settles, with the last words heard. */
  settling?: { timer: ReturnType<typeof setTimeout>; event: { name: string; params: Record<string, unknown> } };
  /** Messages on their way, whose refs are not known yet, and what the session did meanwhile. */
  going: number;
  early: SessionEvent[];
  touched: number;
}

/** A leader's message on its way: its ref once the send answers, or that it failed. */
export interface Going {
  sent(ref: string, id: string): void;
  failed(): void;
}

/** How many of a session's events are kept while a message to it is on its way. */
const EARLY_MAX = 200;

function cap(text: string, n: number): string {
  return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

/** An ask, as a leader reads it: what it asks, its options by id, and how to answer it. */
export function askNotice(alias: string, ask: Ask): string {
  const options = ask.options.map((o) => `${o.id} (${o.label}${o.description ? `: ${o.description}` : ""})`).join(", ");
  const text = ask.allowsText ? `${options ? ", or " : ""}text with your written answer` : "";
  const several = ask.multiple ? " Several may be chosen: options lists them, option first." : "";
  return `${alias} asks: ${ask.title}${ask.detail ? `\n${cap(ask.detail, DETAIL_CHARS)}` : ""}\nOptions: ${options}${text}.${several}\nAnswer it as your user with answer_ask (ask ${ask.id}), or leave it to them: they see it too, and the first answer settles it.`;
}

export class Reports {
  private deps: ReportsDeps;
  private log: Logger;
  private now: () => number;
  private watches = new Map<string, Watch>();
  private offs: (() => void)[] = [];
  private timer?: ReturnType<typeof setInterval>;

  constructor(deps: ReportsDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.offs.push(
      this.deps.bus.on("session.event", (e) => this.onEvent(e)),
      this.deps.bus.on("session.state", (s) => this.onSession(s)),
      this.deps.bus.on("ask.state", (a) => this.onAsk(a)),
      this.deps.bus.on("lead.state", () => this.onLeaders()),
    );
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    if (this.timer) clearInterval(this.timer);
    for (const w of this.watches.values()) if (w.settling) clearTimeout(w.settling.timer);
    this.watches.clear();
  }

  /** A leader's message to `target` is about to go: the watch opens now, and hears the message by its ref once the send answers. */
  begin(leader: string, target: string): Going {
    if (!this.deps.routes()) return { sent: () => undefined, failed: () => undefined };
    const key = `${leader} ${target}`;
    let w = this.watches.get(key);
    if (!w) this.watches.set(key, (w = { leader, target, sent: new Map(), asked: new Set(), going: 0, early: [], touched: this.now() }));
    const watch = w;
    watch.going++;
    watch.touched = this.now();
    let done = false;
    const settle = (ref?: string, id?: string) => {
      if (done) return;
      done = true;
      watch.going = Math.max(0, watch.going - 1);
      if (this.watches.get(key) !== watch) return;
      if (ref !== undefined && id !== undefined) watch.sent.set(ref, { id, landed: false });
      if (watch.going > 0) return;
      for (const e of watch.early.splice(0)) this.handle(watch, e);
      if (watch.sent.size === 0) this.close(watch);
    };
    return { sent: (ref, id) => settle(ref, id), failed: () => settle() };
  }

  /** A leader's message `id`, sent to `target` under `ref`: watched until the session settles after it. */
  open(leader: string, target: string, ref: string, id: string): void {
    this.begin(leader, target).sent(ref, id);
  }

  /** The watches open now: leader, target, and the refs not reported yet. */
  list(): { leader: string; target: string; refs: string[] }[] {
    return [...this.watches.values()].map((w) => ({ leader: w.leader, target: w.target, refs: [...w.sent.keys()] }));
  }

  private on(target: string): Watch[] {
    return [...this.watches.values()].filter((w) => w.target === target);
  }

  private close(w: Watch): void {
    if (w.settling) clearTimeout(w.settling.timer);
    this.watches.delete(`${w.leader} ${w.target}`);
  }

  private tell(w: Watch, text: string, from?: { session: string; replyTo?: string }): void {
    this.deps.tell(w.leader, text, from).catch((e: unknown) => this.log.info("a report to a leader could not be delivered", { leader: w.leader, target: w.target, error: e instanceof Error ? e.message : String(e) }));
  }

  // --- what the session does ---------------------------------------------------------------------

  private onEvent(e: SessionEvent): void {
    for (const w of this.on(e.session)) {
      // a message on its way: kept until its ref is known, and heard in order then
      if (w.going > 0) {
        if (w.early.length < EARLY_MAX) w.early.push(e);
        continue;
      }
      this.handle(w, e);
    }
  }

  private handle(w: Watch, e: SessionEvent): void {
    if (this.watches.get(`${w.leader} ${w.target}`) !== w) return;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.kind === "user_turn" || (e.kind === "notification" && p["type"] === "message")) {
      const ref = typeof p["ref"] === "string" ? p["ref"] : undefined;
      const sent = ref !== undefined ? w.sent.get(ref) : undefined;
      if (!ref || !sent) return;
      w.touched = this.now();
      if (e.kind === "notification" && p["state"] === "withdrawn") {
        w.sent.delete(ref);
        const why = typeof p["message"] === "string" && p["message"] ? p["message"] : "it could not be typed into the session";
        this.tell(w, `Your message ${sent.id} to ${this.deps.alias(w.target)} was not delivered: ${why}.`);
        if (w.sent.size === 0 && w.going === 0) this.close(w);
        return;
      }
      if (e.kind === "user_turn" || p["state"] === "delivered") {
        sent.landed = true;
        w.last = sent.id;
      }
      return;
    }
    if (e.kind === "assistant_text" && typeof p["text"] === "string" && [...w.sent.values()].some((m) => m.landed)) w.said = p["text"];
    if (e.kind === "status") this.onStatus(w, e);
  }

  /** A status of a watched session: a plain idle after a message landed settles; anything else means it went on. */
  private onStatus(w: Watch, e: SessionEvent): void {
    const p = (e.payload ?? {}) as { status?: unknown; waiting?: unknown };
    const landed = [...w.sent.values()].some((m) => m.landed);
    const idle = p.status === "idle" && (p.waiting === undefined || p.waiting === null);
    if (!idle || !landed) {
      if (w.settling) {
        clearTimeout(w.settling.timer);
        w.settling = undefined;
      }
      return;
    }
    w.touched = this.now();
    let event = { name: "session.updated", params: { event: e } as Record<string, unknown> };
    if (w.settling) {
      clearTimeout(w.settling.timer);
      event = carryLastWords(w.settling.event, event);
    }
    const timer = setTimeout(() => this.settled(w), this.deps.settleMs);
    w.settling = { timer, event };
  }

  /** The session settled after the leader's message: its last words go to the leader, and what landed is reported. */
  private settled(w: Watch): void {
    const held = w.settling;
    w.settling = undefined;
    if (!held || this.watches.get(`${w.leader} ${w.target}`) !== w) return;
    const ev = held.event.params["event"] as SessionEvent | undefined;
    const payload = (ev?.payload ?? {}) as { lastAssistantMessage?: unknown; failed?: unknown };
    const words = (typeof payload.lastAssistantMessage === "string" ? payload.lastAssistantMessage : (w.said ?? "")).trim();
    const alias = this.deps.alias(w.target);
    if (words) this.tell(w, words, { session: w.target, ...(w.last ? { replyTo: w.last } : {}) });
    else if (typeof payload.failed === "string") this.tell(w, `${alias} stopped after your message${w.last ? ` ${w.last}` : ""}: its turn failed (${payload.failed}).`);
    else this.tell(w, `${alias} finished its turn after your message${w.last ? ` ${w.last}` : ""}, with no closing words.`);
    this.log.info("a led session settled: its leader told", { leader: w.leader, target: w.target, words: words.length });
    for (const [ref, m] of [...w.sent]) if (m.landed) w.sent.delete(ref);
    w.last = undefined;
    w.said = undefined;
    if (w.sent.size === 0 && w.going === 0) this.close(w);
  }

  private onAsk(a: Ask): void {
    if (a.status !== "open" || a.source.kind !== "harness" || !a.answerableBy.includes("user")) return;
    for (const w of this.on(a.source.session)) {
      if (w.asked.has(a.id)) continue;
      w.asked.add(a.id);
      w.touched = this.now();
      this.tell(w, askNotice(this.deps.alias(w.target), a));
    }
  }

  private onSession(s: Session): void {
    if (s.status !== "ended") return;
    for (const w of [...this.watches.values()]) {
      if (w.leader === s.id) {
        this.close(w);
        continue;
      }
      // a machine whose link dropped lists its sessions as ended: the watch waits for it, or for its day
      if (w.target === s.id && this.deps.linked(s.node)) {
        this.tell(w, `${this.deps.alias(w.target)} ended.`);
        this.close(w);
      }
    }
  }

  private onLeaders(): void {
    for (const w of [...this.watches.values()]) if (!this.deps.leads(w.leader, w.target)) this.close(w);
  }

  private sweep(): void {
    const now = this.now();
    for (const w of [...this.watches.values()]) if (now - w.touched > STALE_MS) this.close(w);
  }
}
