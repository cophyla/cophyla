// Codex's questions to the user as asks, kept in step with the rollout: after each read, a
// question call the parser holds as waiting has its asks open, and one it no longer holds
// (answered in the terminal, or its turn over) has them closed, which takes their
// notifications down. The chat's own session is left alone: it answers its own.
//
// A `request_user_input` is asked one question at a time, as Claude's `AskUserQuestion` is,
// and the session needs input meanwhile. Once every question is answered the answers are
// typed into the dialog in the session's terminal, as the keys a person presses there: the
// dialog is read off the screen before each key and after it, and nothing is pressed into a
// screen that does not show it. A session with no terminal to type into shows the question
// and leaves it to its own window. An async question is asked as it comes, beside the others
// of its call, and its answer goes into the thread as the reply Codex's own clients send.
// A session outside the node's scope is left to its own window, as the chat's is.

import type { Ask, TerminalRef } from "@cophyla/protocol";
import type { Asks } from "../../gate/asks.ts";
import type { Logger } from "../../log.ts";
import type { ScreenLike } from "../claude/screen.ts";
import { askShown } from "../model.ts";
import type { SessionHost, SessionRecord } from "../model.ts";
import { askInputFromQuestion } from "../questions.ts";
import { ASK_TOOL, dialogOf, questionReply, replyAnswer, showsQuestion, typedAnswer } from "./questions.ts";
import type { CodexQuestion, CodexQuestionCall, DialogScreen, TypedAnswer } from "./questions.ts";

/** What the adapter types into a terminal with: tether. */
export interface QuestionTerminal {
  readonly available: boolean;
  screen(ref: TerminalRef, format?: "text" | "cells"): Promise<ScreenLike>;
  keys(ref: TerminalRef, keys: string[]): Promise<void>;
  paste(ref: TerminalRef, text: string): Promise<void>;
}

export interface DialogTiming {
  /** How long the dialog may take to be on the screen. */
  showMs: number;
  /** How long one key may take to show. */
  stepMs: number;
  pollMs: number;
  /** Between notes pasted and the Enter that submits them: a TUI that took the paste as keystrokes reads an Enter among them as a line break. */
  pasteMs: number;
}

export const DIALOG_TIMING: DialogTiming = { showMs: 4000, stepMs: 2000, pollMs: 60, pasteMs: 350 };

export interface CodexAskingOptions {
  host: SessionHost;
  asks: Asks;
  log: Logger;
  askTimeoutS: number;
  terminal?: QuestionTerminal;
  /** Sends a user's message into the thread: an async question's reply. */
  reply: (rec: SessionRecord, text: string, ref: string) => Promise<unknown>;
  timing?: Partial<DialogTiming>;
}

interface BlockingCall {
  kind: "blocking";
  call: CodexQuestionCall;
  /** `typed`: answered here, typed into the dialog; `shown`: no terminal to type into, so only shown. */
  mode: "typed" | "shown";
  /** The question the open ask is for. */
  index: number;
  ask?: Ask;
  answers: TypedAnswer[];
  /** `asking` until every question is answered; then the answers are typed, or could not be. */
  state: "asking" | "typing" | "typed" | "untyped";
}

interface AsyncCall {
  kind: "async";
  call: CodexQuestionCall;
  /** The open asks, by question index: one answered or let go here is never asked again while the call waits. */
  asks: Map<number, Ask>;
}

type OpenCall = BlockingCall | AsyncCall;

interface Tracked {
  rec: SessionRecord;
  calls: Map<string, OpenCall>;
}

export class CodexAsking {
  private opts: CodexAskingOptions;
  private host: SessionHost;
  private log: Logger;
  private timing: DialogTiming;
  /** By session id: the calls whose asks are open, or whose answers are being typed. */
  private tracked = new Map<string, Tracked>();

  constructor(opts: CodexAskingOptions) {
    this.opts = opts;
    this.host = opts.host;
    this.log = opts.log;
    this.timing = { ...DIALOG_TIMING, ...(opts.timing ?? {}) };
  }

  /** Whether the session waits on a dialog: its status is the dialog's, whatever a listing reads underneath. */
  holds(rec: SessionRecord): boolean {
    for (const o of this.tracked.get(rec.session.id)?.calls.values() ?? []) if (o.kind === "blocking" && o.state !== "typed") return true;
    return false;
  }

  /** Brings the record's asks in step with the questions its rollout holds as waiting. */
  sync(rec: SessionRecord, pending: ReadonlyMap<string, CodexQuestionCall>, now = this.host.now()): void {
    if (rec.session.role === "assistant") return;
    // A session outside the scope asks in its own window: what was open here closes.
    const live = rec.session.status !== "ended" && this.host.connected(rec);
    let t = this.tracked.get(rec.session.id);
    if (!t && (!live || pending.size === 0)) return;
    if (!t) this.tracked.set(rec.session.id, (t = { rec, calls: new Map() }));
    t.rec = rec;
    for (const [id, o] of [...t.calls]) {
      const call = live ? pending.get(id) : undefined;
      if (!call) {
        t.calls.delete(id);
        this.closeCall(rec, o, live ? "terminal" : "stopped", now);
        continue;
      }
      if (o.kind === "async") {
        for (const [i, ask] of [...o.asks]) {
          if (call.open.includes(i)) continue;
          o.asks.delete(i);
          this.closeAsk(rec, ask, "terminal", now);
        }
      } else if (o.mode === "shown" && this.typable(rec)) {
        // A terminal came: the question can be answered here now.
        t.calls.delete(id);
        if (o.ask) this.closeAsk(rec, o.ask, "stopped", now);
      }
    }
    if (live) {
      for (const [id, call] of pending) {
        if (t.calls.has(id)) continue;
        const o = call.tool === ASK_TOOL ? this.openBlocking(rec, call, now) : this.openAsync(rec, call, now);
        t.calls.set(id, o);
      }
    }
    if (t.calls.size === 0) this.tracked.delete(rec.session.id);
    this.settleStatus(rec, now);
  }

  /** Ended sessions take their asks with them. */
  sweep(now = this.host.now()): void {
    for (const t of [...this.tracked.values()]) if (t.rec.session.status === "ended") this.sync(t.rec, new Map(), now);
  }

  /** The daemon stops: no ask it opened outlives it. */
  stop(): void {
    const now = this.host.now();
    for (const t of [...this.tracked.values()]) {
      for (const o of t.calls.values()) this.closeCall(t.rec, o, "daemon_stop", now);
      t.calls.clear();
    }
    this.tracked.clear();
  }

  private typable(rec: SessionRecord): boolean {
    return rec.session.native.terminal !== undefined && this.opts.terminal?.available === true;
  }

  private expiresAt(now: number): number {
    return now + this.opts.askTimeoutS * 1000;
  }

  // --- the dialog ---------------------------------------------------------------------------

  private openBlocking(rec: SessionRecord, call: CodexQuestionCall, now: number): BlockingCall {
    const o: BlockingCall = { kind: "blocking", call, mode: this.typable(rec) ? "typed" : "shown", index: 0, answers: [], state: "asking" };
    this.askBlocking(rec, o, now);
    return o;
  }

  /** The ask for the question at `o.index`: answerable while there is a terminal to type the answers into, shown only otherwise. */
  private askBlocking(rec: SessionRecord, o: BlockingCall, now: number): void {
    const q = o.call.questions[o.index]!;
    const input = askInputFromQuestion(q, { session: rec.session.id, index: o.index, count: o.call.questions.length, expiresAt: this.expiresAt(now) });
    if (o.mode === "shown") input.answerableBy = [];
    const ask = this.opts.asks.open(input, now);
    o.ask = ask;
    this.host.event(rec, "ask", { ask: ask.id, phase: "opened", tool: o.call.tool, question: o.index + 1, of: o.call.questions.length, ...(o.mode === "shown" ? { kind: "input" } : {}), ...askShown(ask) }, undefined, now);
    this.log.info("codex question asked", { session: rec.session.id, ask: ask.id, call: o.call.callId, question: o.index + 1, of: o.call.questions.length, mode: o.mode });
    if (o.mode === "shown") return;
    void this.opts.asks.wait(ask.id).then((settled) => this.blockingSettled(rec, o, ask, settled));
  }

  private blockingSettled(rec: SessionRecord, o: BlockingCall, ask: Ask, settled: Ask): void {
    // Closed here (the call went, or the session ended): nothing more to do.
    if (o.ask?.id !== ask.id || !this.isTracked(rec, o)) return;
    const now = this.host.now();
    o.ask = undefined;
    if (settled.status !== "answered" || !settled.answer) {
      // Let go unanswered: the dialog waits in the terminal still.
      o.state = "untyped";
      this.host.event(rec, "ask", { ask: ask.id, phase: "closed", reason: settled.status === "expired" ? "expired" : "aborted" }, undefined, now);
      this.settleStatus(rec, now);
      return;
    }
    this.host.event(rec, "ask", { ask: ask.id, phase: "answered", answer: settled.answer }, undefined, now);
    this.log.info("codex question answered", { session: rec.session.id, ask: ask.id, option: settled.answer.option, by: settled.answer.by.kind });
    o.answers.push(typedAnswer(o.call.questions[o.index]!, settled.answer));
    o.index += 1;
    if (o.index < o.call.questions.length) {
      this.askBlocking(rec, o, now);
      this.settleStatus(rec, now);
      return;
    }
    o.state = "typing";
    this.settleStatus(rec, now);
    void this.typeInto(rec, o);
  }

  private async typeInto(rec: SessionRecord, o: BlockingCall): Promise<void> {
    const term = rec.session.native.terminal;
    const terminal = this.opts.terminal;
    try {
      if (!term || !terminal?.available) throw new Error("the session has no terminal to type into");
      await typeAnswers({ screen: () => terminal.screen(term, "text"), keys: (k) => terminal.keys(term, k), paste: (text) => terminal.paste(term, text) }, o.call.questions, o.answers, this.timing);
      o.state = "typed";
      this.log.info("codex question's answers typed into its terminal", { session: rec.session.id, call: o.call.callId, terminal: term.id });
    } catch (e) {
      o.state = "untyped";
      const error = e instanceof Error ? e.message : String(e);
      this.log.warn("codex question's answers not typed", { session: rec.session.id, call: o.call.callId, error });
      if (this.isTracked(rec, o)) this.host.event(rec, "notification", { type: "question", message: `The answers could not be typed into the session's terminal (${error}): the question waits there` });
    }
    if (this.isTracked(rec, o)) this.settleStatus(rec, this.host.now());
  }

  // --- the async question --------------------------------------------------------------------

  private openAsync(rec: SessionRecord, call: CodexQuestionCall, now: number): AsyncCall {
    const o: AsyncCall = { kind: "async", call, asks: new Map() };
    for (const i of call.open) {
      const q = call.questions[i]!;
      const ask = this.opts.asks.open(askInputFromQuestion(q, { session: rec.session.id, index: i, count: call.questions.length, expiresAt: this.expiresAt(now) }), now);
      o.asks.set(i, ask);
      this.host.event(rec, "ask", { ask: ask.id, phase: "opened", tool: call.tool, question: i + 1, of: call.questions.length, ...askShown(ask) }, undefined, now);
      this.log.info("codex async question asked", { session: rec.session.id, ask: ask.id, call: call.callId, question: i + 1 });
      void this.opts.asks.wait(ask.id).then((settled) => this.asyncSettled(rec, o, i, q, ask, settled));
    }
    return o;
  }

  private asyncSettled(rec: SessionRecord, o: AsyncCall, i: number, q: CodexQuestion, ask: Ask, settled: Ask): void {
    if (o.asks.get(i)?.id !== ask.id || !this.isTracked(rec, o)) return;
    o.asks.delete(i);
    const now = this.host.now();
    if (settled.status !== "answered" || !settled.answer) {
      this.host.event(rec, "ask", { ask: ask.id, phase: "closed", reason: settled.status === "expired" ? "expired" : "aborted" }, undefined, now);
      return;
    }
    this.host.event(rec, "ask", { ask: ask.id, phase: "answered", answer: settled.answer }, undefined, now);
    const ref = `cophylad-answer-${ask.id}`;
    this.opts
      .reply(rec, questionReply(q, replyAnswer(q, settled.answer)), ref)
      .then(() => this.log.info("codex async question answered", { session: rec.session.id, ask: ask.id, ref, by: settled.answer!.by.kind }))
      .catch((e: unknown) => {
        const error = e instanceof Error ? e.message : String(e);
        this.log.warn("codex async question's answer not sent", { session: rec.session.id, ask: ask.id, error });
        this.host.event(rec, "notification", { type: "question", message: `The answer could not be sent to the session (${error})` });
      });
  }

  // --- closing, and the session's status ---------------------------------------------------------

  private isTracked(rec: SessionRecord, o: OpenCall): boolean {
    return this.tracked.get(rec.session.id)?.calls.get(o.call.callId) === o;
  }

  private closeCall(rec: SessionRecord, o: OpenCall, reason: string, now: number): void {
    if (o.kind === "blocking") {
      const ask = o.ask;
      o.ask = undefined;
      if (ask) this.closeAsk(rec, ask, reason, now);
      return;
    }
    for (const ask of o.asks.values()) this.closeAsk(rec, ask, reason, now);
    o.asks.clear();
  }

  private closeAsk(rec: SessionRecord, ask: Ask, reason: string, now: number): void {
    if (this.opts.asks.getAny(ask.id)?.status === "open") this.opts.asks.cancel(ask.id);
    if (rec.session.status !== "ended") this.host.event(rec, "ask", { ask: ask.id, phase: "closed", reason }, undefined, now);
    this.log.info("codex question closed", { session: rec.session.id, ask: ask.id, reason });
  }

  /**
   * A dialog waiting makes the session need input, its open ask the session's; once none waits
   * (answered, typed, or gone) the session works again. An ask that is not one of these (a
   * permission the hooks hold) is never touched.
   */
  private settleStatus(rec: SessionRecord, now: number): void {
    if (rec.session.status === "ended") return;
    const calls = [...(this.tracked.get(rec.session.id)?.calls.values() ?? [])];
    const waiting = calls.find((o): o is BlockingCall => o.kind === "blocking" && o.state !== "typed");
    const want = waiting?.ask?.id;
    const current = rec.session.ask;
    const mine = current === undefined || this.wasMine(current);
    if (mine && current !== want) this.host.patch(rec, { ask: want }, now);
    if (waiting && rec.session.status !== "needs_input" && rec.session.status !== "needs_permission") this.host.setStatus(rec, "needs_input", now);
    else if (!waiting && rec.session.status === "needs_input" && mine) this.host.setStatus(rec, "busy", now);
  }

  /** An ask a Codex question opened: a harness ask of a tool these calls are. */
  private wasMine(id: string): boolean {
    for (const t of this.tracked.values()) {
      for (const o of t.calls.values()) {
        if (o.kind === "blocking" && o.ask?.id === id) return true;
        if (o.kind === "async" && [...o.asks.values()].some((a) => a.id === id)) return true;
      }
    }
    // One closed since: it is no longer open, so no hook holds it either.
    return this.opts.asks.getAny(id)?.status !== "open";
  }
}

// --- typing the answers --------------------------------------------------------------------------

/** One terminal's screen and keys. */
export interface DialogKeys {
  screen(): Promise<ScreenLike>;
  keys(keys: string[]): Promise<void>;
  paste(text: string): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isDialog(d: DialogScreen | { confirm: true } | undefined): d is DialogScreen {
  return d !== undefined && !("confirm" in d);
}

/**
 * Answers the `request_user_input` dialog on a terminal's screen, as a person would: back to
 * its first question, then each answer in turn. An option alone is its digit, which chooses it
 * and moves on (the last submits them all); with notes, the pointer is moved onto the option,
 * Tab opens its notes, the notes are pasted and Enter moves on. Notes the terminal held are
 * cleared first: Esc clears an open notes field, where with it shut Esc would interrupt the turn.
 * Throws, having pressed nothing more, when the screen does not show what the next key needs.
 */
export async function typeAnswers(t: DialogKeys, questions: CodexQuestion[], answers: TypedAnswer[], timing: DialogTiming = DIALOG_TIMING): Promise<void> {
  const n = questions.length;
  type Seen = DialogScreen | { confirm: true } | undefined;
  const read = async (): Promise<Seen> => dialogOf(await t.screen());
  /** The screen once it passes `test`, as `{ seen }`; undefined when it never does within `ms`. */
  const until = async (test: (d: Seen) => boolean, ms: number): Promise<{ seen: Seen } | undefined> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const seen = await read();
      if (test(seen)) return { seen };
      if (Date.now() >= deadline) return undefined;
      await sleep(timing.pollMs);
    }
  };
  const at = async (index: number, also: (d: DialogScreen) => boolean, what: string): Promise<DialogScreen> => {
    const r = await until((d) => isDialog(d) && d.total === n && d.index === index && also(d), timing.stepMs);
    if (!r) throw new Error(what);
    return r.seen as DialogScreen;
  };

  let first = await until((d) => d !== undefined, timing.showMs);
  if (!first) throw new Error("the question is not on the terminal's screen");
  if (!isDialog(first.seen)) {
    // Asking whether to submit with questions unanswered: back to the questions.
    await t.keys(["Escape"]);
    first = await until(isDialog, timing.stepMs);
    if (!first) throw new Error("the dialog stayed on its confirmation");
  }
  let d = first.seen as DialogScreen;
  if (d.total !== n) throw new Error(`the terminal shows a dialog of ${d.total} questions, not ${n}`);
  while (d.index > 1) {
    const from = d.index;
    await t.keys(["PageUp"]);
    d = await at(from - 1, () => true, "the dialog did not go back to its first question");
  }
  if (!showsQuestion(d, questions[0]!)) throw new Error("the terminal shows another question");

  for (let k = 0; k < n; k++) {
    const q = questions[k]!;
    const a = answers[k]!;
    let cur = await at(k + 1, () => true, `question ${k + 1} did not come up`);
    if (!showsQuestion(cur, q)) throw new Error(`the terminal shows another question in place of question ${k + 1}`);
    if (cur.notes) {
      await t.keys(["Escape"]);
      cur = await at(k + 1, (x) => !x.notes, "the notes field did not close");
    }
    if (a.notes === undefined && a.row < 9) {
      await t.keys([String(a.row + 1)]);
    } else {
      for (let moves = 0; cur.selected !== a.row; moves++) {
        if (cur.selected === undefined || moves > q.other + 1) throw new Error("the option could not be pointed at");
        const from = cur.selected;
        await t.keys([from < a.row ? "Down" : "Up"]);
        cur = await at(k + 1, (x) => x.selected !== from, "the dialog's pointer did not move");
      }
      if (a.notes === undefined) await t.keys(["Enter"]);
      else {
        await t.keys(["Tab"]);
        await at(k + 1, (x) => x.notes, "the notes field did not open");
        await t.paste(a.notes);
        await sleep(timing.pasteMs);
        await t.keys(["Enter"]);
      }
    }
    // On to the next question, or, after the last, the dialog gone (or another's in its place).
    const movedOn = (x: Seen) => (k + 1 < n ? isDialog(x) && x.index === k + 2 : !isDialog(x) || x.total !== n || !showsQuestion(x, questions[x.index - 1]!));
    let moved = await until(movedOn, timing.stepMs);
    if (!moved && a.notes !== undefined) {
      // The Enter went into the notes as a line break, with the paste: once more submits them.
      await t.keys(["Enter"]);
      moved = await until(movedOn, timing.stepMs);
    }
    if (!moved) throw new Error(`the answer to question ${k + 1} was not taken`);
    if (moved.seen !== undefined && !isDialog(moved.seen)) throw new Error("the terminal asks whether to submit with questions unanswered");
  }
}
