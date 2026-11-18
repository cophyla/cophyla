// The default view's notes, pure: the notes as the node says them (a refusal takes the bell
// away, a dismissed note goes), what is open, the bell's list and words, a session's strip,
// the card a `notify_user` call is in the timeline (never folded into the steps), and the tab
// shown far back: how a point is reached (here, a page back, or a window), a window's live
// events held and not drawn, its pages forward, and its meeting what streams.

import { describe, expect, test } from "bun:test";
import { ACCESS_PRESETS } from "@cophyla/protocol";
import type { Client, Note, Session, SessionEvent } from "@cophyla/protocol";
import { apply, chatDraw, forwardParams, initialState, newestSeq, reachOf, REACH_BACK, selectTimeline, timelinePosts, trimTimeline, WINDOW_HELD } from "../views/default/model.ts";
import type { HostReady, TimelinePost, ViewState } from "../views/default/model.ts";
import { bellNotes, bellWords, callNote, finishedNotes, isNotifyCall, noteAtCall, noteIsOpen, notesSummary, noteStateWords, noteWaits, openNoteCount, openNotesOf } from "../views/default/notemodel.ts";

const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const A = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB3";
const B = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB4";

function connected(): ViewState {
  const scopes = [...ACCESS_PRESETS.full.scopes];
  const client: Client = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7", kind: "ui", node: DESK, scopes, via: "direct", audio: { in: false, out: false }, connectedAt: 1 } as Client;
  const ready: HostReady = { client, node: DESK, protocolVersion: 1, platformVersion: "0.28.0", view: { id: "default", name: "Chat", entry: "index.html", default: true, source: "builtin" }, scopes };
  const state = initialState();
  apply(state, { type: "host.ready", params: ready });
  apply(state, { type: "host.state", params: { connected: true } });
  return state;
}

function session(id: string): Session {
  return { id, node: DESK, harness: "claude", profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8", native: { id: `n-${id}`, transport: "pipe" }, origin: "user", cwd: "C:\\src", status: "idle", startedAt: 1, lastActivity: 1 } as Session;
}

/** A session whose tab is open, holding events `from`..`to`. */
function opened(s: ViewState, id: string, from: number, to: number): void {
  apply(s, { type: "session.state", params: session(id) });
  apply(s, { type: "tab.open", session: id });
  const events = [];
  for (let seq = from; seq <= to; seq++) events.push(ev(id, seq));
  apply(s, { type: "history", session: id, opened: s.sessions.get(id)!.opened, events, limit: 50 });
}

const ev = (session: string, seq: number, kind: SessionEvent["kind"] = "assistant_text", payload: unknown = { text: `m${seq}` }): SessionEvent => ({ session, seq, at: 1000 + seq, kind, payload });

let n = 0;
const note = (over: Partial<Note> = {}): Note => {
  n++;
  return { id: `nte_01ARZ3NDEKTSV4RRFFQ69G5N${String(n).padStart(2, "0").replace(/0/g, "A")}`, session: A, seq: n * 10, title: `note ${n}`, needsAnswer: false, urgent: false, at: 1000 + n, ...over };
};

describe("the notes as the node says them", () => {
  test("note.list turns the bell on, its refusal off; a note comes, changes and goes when dismissed", () => {
    const s = connected();
    expect(s.notesOn).toBeUndefined();
    expect(openNoteCount(s)).toBe(0);
    const a = note();
    apply(s, { type: "notes", notes: [a] });
    expect(s.notesOn).toBe(true);
    expect(openNoteCount(s)).toBe(1);
    apply(s, { type: "note.state", params: { ...a, read: 5000 } });
    expect(openNoteCount(s)).toBe(0);
    apply(s, { type: "note.state", params: { ...a, dismissed: true } });
    expect(s.notes.size).toBe(0);
    apply(s, { type: "notes" });
    expect(s.notesOn).toBe(false);
    apply(s, { type: "notes.setting", setting: { on: false } });
    expect(s.notesSetting).toEqual({ on: false });
    apply(s, { type: "notes.state", params: { on: true } });
    expect(s.notesSetting).toEqual({ on: true });
    // none of it redraws the chat's items
    for (const type of ["notes", "note.state", "notes.setting", "notes.state", "window.opening", "window.opened", "window.loading", "window.page"] as const) expect(chatDraw({ type } as never)).toBe("none");
  });

  test("a note is open until read, one that waits until it is answered; the bell lists the open on top, newest first", () => {
    const s = connected();
    const fyi = note({ at: 100 });
    const waits = note({ at: 200, needsAnswer: true, read: 250 });
    const read = note({ at: 300, read: 310 });
    const answered = note({ at: 400, needsAnswer: true, answered: { at: 410, seq: 99, text: "yes" } });
    const other = note({ at: 500, session: B, urgent: true });
    apply(s, { type: "notes", notes: [fyi, waits, read, answered, other] });
    expect([fyi, waits, read, answered, other].map(noteIsOpen)).toEqual([true, true, false, false, true]);
    expect(noteWaits(waits)).toBe(true);
    expect(noteWaits(answered)).toBe(false);
    expect(bellNotes(s).map((x) => x.id)).toEqual([other.id, waits.id, fyi.id, answered.id, read.id]);
    expect(openNoteCount(s)).toBe(3);
    expect(openNotesOf(s, A).map((x) => x.id)).toEqual([fyi.id, waits.id]);
    expect(finishedNotes(s).map((x) => x.id).sort()).toEqual([read.id, answered.id].sort());
    expect(bellWords(s)).toBe("Notes: 3 new, 1 waiting for your answer");
    expect(notesSummary(openNotesOf(s, A))).toBe("2 notes · 1 waiting for you");
    expect(notesSummary([fyi])).toBe("1 note");
    expect([fyi, waits, read, answered].map(noteStateWords)).toEqual(["new", "waiting for you", "read", "answered"]);
  });

  test("a notify_user call finds its note by the call's id, else at its seq; its own words stand in for a note not known here", () => {
    const s = connected();
    const byCall = note({ seq: 40, call: "toolu_A" });
    const bySeq = note({ seq: 52 });
    apply(s, { type: "notes", notes: [byCall, bySeq] });
    expect(noteAtCall(s, A, { id: "toolu_A", seq: 41 })?.id).toBe(byCall.id);
    expect(noteAtCall(s, A, { id: "toolu_X", seq: 52 })?.id).toBe(bySeq.id);
    expect(noteAtCall(s, B, { seq: 52 })).toBeUndefined();
    expect(isNotifyCall("mcp__cophyla-agents__notify_user")).toBe(true);
    expect(isNotifyCall("notify_user")).toBe(true);
    expect(isNotifyCall("notify_users")).toBe(false);
    expect(callNote({ title: "Deploy?", detail: "  ", needs_answer: true })).toEqual({ title: "Deploy?", needsAnswer: true, urgent: false });
    expect(callNote({})).toEqual({ title: "A note", needsAnswer: false, urgent: false });
  });
});

describe("the card a note is in the timeline", () => {
  test("a notify_user call is its own part, never folded into the steps around it, and takes its result", () => {
    const s = connected();
    apply(s, { type: "session.state", params: session(A) });
    apply(s, { type: "tab.open", session: A });
    const tool = "mcp__cophyla-agents__notify_user";
    const events = [
      ev(A, 1, "tool_call", { tool: "Read", id: "r1", args: { file_path: "a.ts" } }),
      ev(A, 2, "tool_result", { tool: "Read", id: "r1", result: "x" }),
      ev(A, 3, "tool_call", { tool, id: "toolu_N", args: { title: "Found it", needs_answer: true } }),
      ev(A, 4, "tool_call", { tool: "Bash", id: "b1", args: { command: "ls" } }),
      ev(A, 5, "tool_result", { tool, id: "toolu_N", result: "Your user has the note." }),
    ];
    apply(s, { type: "history", session: A, opened: s.sessions.get(A)!.opened, events, limit: 50 });
    const posts = timelinePosts(selectTimeline(s, s.sessions.get(A)!));
    const turn = posts.find((p): p is Extract<TimelinePost, { kind: "turn" }> => p.kind === "turn")!;
    expect(turn.parts.map((p) => p.kind)).toEqual(["steps", "notify", "steps"]);
    const card = turn.parts[1]!;
    if (card.kind !== "notify") throw new Error("not a notify part");
    expect(card).toMatchObject({ key: "e3", seq: 3, step: { id: "toolu_N", tool } });
    expect(card.step.result).toMatchObject({ value: "Your user has the note.", error: false });
  });
});

describe("a point in a tab's history", () => {
  test("held, a page back, or a window: as far back as it is", () => {
    const s = connected();
    opened(s, A, 1000, 1049);
    const c = s.sessions.get(A)!;
    expect(reachOf(c, 1020)).toEqual({ how: "here" });
    expect(reachOf(c, 1049)).toEqual({ how: "here" });
    expect(reachOf(c, 1000 - REACH_BACK)).toEqual({ how: "back", before: 1000, limit: REACH_BACK + 20 });
    expect(reachOf(c, 400)).toEqual({ how: "back", before: 1000, limit: 620 });
    expect(reachOf(c, 10)).toEqual({ how: "window" });
    // a tab whose start is loaded has every earlier point
    c.exhausted = true;
    expect(reachOf(c, 10)).toEqual({ how: "here" });
    // nothing loaded yet: a window
    const empty = { events: new Map(), exhausted: false };
    expect(reachOf(empty, 5)).toEqual({ how: "window" });
  });

  test("a window opens around the point: what the tab showed goes, what streams is held and never drawn, and a trim never takes it", () => {
    const s = connected();
    opened(s, A, 3000, 3049);
    apply(s, { type: "window.opening", session: A, at: 200 });
    const c = s.sessions.get(A)!;
    expect(c.events.size).toBe(0);
    expect(c.window).toMatchObject({ at: 200, opening: true });
    // a page asked for before the window is dropped
    apply(s, { type: "history", session: A, opened: c.opened - 1, events: [ev(A, 2999)], limit: 50 });
    expect(c.events.size).toBe(0);
    const around = Array.from({ length: 100 }, (_, i) => ev(A, 150 + i));
    apply(s, { type: "window.opened", session: A, opened: c.opened, at: 200, events: around, limit: 100 });
    expect(c.window?.opening).toBe(false);
    expect(c.oldestSeq).toBe(150);
    expect(newestSeq(c)).toBe(249);
    expect(c.exhausted).toBe(false);
    // what streams now is held
    apply(s, { type: "session.event", params: ev(A, 3050) });
    expect(c.events.has(3050)).toBe(false);
    expect(c.window?.held.map((e) => e.seq)).toEqual([3050]);
    for (let i = 0; i < 10; i++) apply(s, { type: "session.event", params: ev(A, 3051 + i) });
    expect(trimTimeline(c, 10, 0)).toBe(0);
    // a point past the window's newest is reached by a window around it
    expect(reachOf(c, 2000)).toEqual({ how: "window" });
    expect(reachOf(c, 200)).toEqual({ how: "here" });
    // the held let go of their oldest past the bound
    for (let i = 0; i < WINDOW_HELD + 5; i++) apply(s, { type: "session.event", params: ev(A, 4000 + i) });
    expect(c.window?.held).toHaveLength(WINDOW_HELD);
    expect(c.window?.held[0]!.seq).toBe(4005);
  });

  test("a window pages forward around its newest, and a page short of what was asked meets what streams: the held come in and it is a tab at its newest again", () => {
    const s = connected();
    opened(s, A, 500, 549);
    apply(s, { type: "window.opening", session: A, at: 100 });
    const c = s.sessions.get(A)!;
    apply(s, { type: "window.opened", session: A, opened: c.opened, at: 100, events: Array.from({ length: 100 }, (_, i) => ev(A, 50 + i)), limit: 100 });
    expect(forwardParams(c, 50)).toEqual({ around: 149, limit: 100 });
    apply(s, { type: "window.loading", session: A });
    expect(forwardParams(c, 50)).toBeUndefined();
    // a full page: half it held, half new
    apply(s, { type: "window.page", session: A, opened: c.opened, newest: 149, events: Array.from({ length: 100 }, (_, i) => ev(A, 100 + i)), limit: 100 });
    expect(c.window).toBeDefined();
    expect(newestSeq(c)).toBe(199);
    // meanwhile the session went on
    apply(s, { type: "session.event", params: ev(A, 550) });
    apply(s, { type: "session.event", params: ev(A, 551) });
    // a page that failed changes nothing
    apply(s, { type: "window.page", session: A, opened: c.opened, newest: 199, events: [], limit: 0 });
    expect(c.window).toBeDefined();
    // the last page comes short: it met what streams
    apply(s, { type: "window.page", session: A, opened: c.opened, newest: 199, events: Array.from({ length: 50 + 352 }, (_, i) => ev(A, 150 + i)).filter((e) => e.seq <= 549), limit: 800 });
    expect(c.window).toBeUndefined();
    expect(newestSeq(c)).toBe(551);
    expect(c.events.has(550)).toBe(true);
    // and what streams is drawn again
    apply(s, { type: "session.event", params: ev(A, 552) });
    expect(c.events.has(552)).toBe(true);
  });

  test("a window around a point near the newest is no window: it opens at the newest with what was held", () => {
    const s = connected();
    opened(s, A, 900, 949);
    apply(s, { type: "window.opening", session: A, at: 930 });
    const c = s.sessions.get(A)!;
    apply(s, { type: "session.event", params: ev(A, 950) });
    apply(s, { type: "window.opened", session: A, opened: c.opened, at: 930, events: Array.from({ length: 70 }, (_, i) => ev(A, 880 + i)), limit: 100 });
    expect(c.window).toBeUndefined();
    expect(newestSeq(c)).toBe(950);
    // and one at the start says so: 4 before it, the rest after
    apply(s, { type: "window.opening", session: A, at: 3 });
    apply(s, { type: "window.opened", session: A, opened: c.opened, at: 3, events: Array.from({ length: 100 }, (_, i) => ev(A, i)), limit: 100 });
    expect(c.exhausted).toBe(true);
    expect(c.window).toBeDefined();
  });

  test("opening the tab again leaves the window: what it held is dropped, and the tab loads its newest", () => {
    const s = connected();
    opened(s, A, 900, 949);
    apply(s, { type: "window.opening", session: A, at: 10 });
    apply(s, { type: "session.event", params: ev(A, 950) });
    apply(s, { type: "tab.open", session: A });
    const c = s.sessions.get(A)!;
    expect(c.window).toBeUndefined();
    expect(c.events.size).toBe(0);
  });
});
