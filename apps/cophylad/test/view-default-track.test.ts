// The default view's tracker, pure: the asks and settings as the node says them (a refusal
// takes the strip and the switch away, a dismissed ask goes), whether a session is followed
// (its own switch over the tracker's), a session's asks in order, the strip's line, what a
// mark says and sets, the answer's words, and the line for asks that cannot be checked.

import { describe, expect, test } from "bun:test";
import { ACCESS_PRESETS } from "@cophyla/protocol";
import type { Client, Tracked, TrackerState } from "@cophyla/protocol";
import { apply, chatDraw, initialState } from "../views/default/model.ts";
import type { HostReady, ViewState } from "../views/default/model.ts";
import { answerWords, follows, latestAnswer, nextMark, SEEN_KEPT, seenFrom, seenPrefs, statusWords, tabAsks, trackedCounts, trackedOf, trackedSummary, trackerTrouble } from "../views/default/trackmodel.ts";

const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const A = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB3";
const B = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB4";

function connected(): ViewState {
  const scopes = [...ACCESS_PRESETS.full.scopes];
  const client: Client = { id: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7", kind: "ui", node: DESK, scopes, via: "direct", audio: { in: false, out: false }, connectedAt: 1 } as Client;
  const ready: HostReady = { client, node: DESK, protocolVersion: 1, platformVersion: "0.27.0", view: { id: "default", name: "Chat", entry: "index.html", default: true, source: "builtin" }, scopes };
  const state = initialState();
  apply(state, { type: "host.ready", params: ready });
  apply(state, { type: "host.state", params: { connected: true } });
  return state;
}

let n = 0;
const ask = (over: Partial<Tracked> = {}): Tracked => {
  n++;
  return { id: `trk_01ARZ3NDEKTSV4RRFFQ69G5T${String(n).padStart(2, "0").replace(/0/g, "A")}`, session: A, seq: n * 10, title: `ask ${n}`, status: "open", answers: [], createdAt: 1000 + n, updatedAt: 1000 + n, ...over };
};

describe("the tracker as the node says it", () => {
  test("tracked.list turns the strip on, its refusal off; an ask comes, changes and goes when dismissed", () => {
    const s = connected();
    expect(s.trackOn).toBeUndefined();
    const a = ask();
    apply(s, { type: "tracked", tracked: [a] });
    expect(s.trackOn).toBe(true);
    expect([...s.tracked.keys()]).toEqual([a.id]);
    apply(s, { type: "tracked.state", params: { ...a, status: "answered", answers: [{ seq: 12, at: 2000, status: "answered" }] } });
    expect(s.tracked.get(a.id)?.status).toBe("answered");
    apply(s, { type: "tracked.state", params: { ...a, dismissed: true } });
    expect(s.tracked.size).toBe(0);
    apply(s, { type: "tracked" });
    expect(s.trackOn).toBe(false);
    // nothing of the chat's items changes with them
    for (const type of ["tracked", "tracked.state", "tracker", "tracker.state"] as const) expect(chatDraw({ type } as never)).toBe("none");
  });

  test("a session is followed by its own switch, else the tracker's; never before the settings are known", () => {
    const s = connected();
    expect(follows(s, A)).toBe(false);
    const on: TrackerState = { on: true, sessions: { [B]: false } };
    apply(s, { type: "tracker", tracker: on });
    expect([follows(s, A), follows(s, B)]).toEqual([true, false]);
    apply(s, { type: "tracker.state", params: { on: false, sessions: { [A]: true } } });
    expect([follows(s, A), follows(s, B)]).toEqual([true, false]);
    apply(s, { type: "tracker" });
    expect(s.tracker).toBeUndefined();
    expect(follows(s, A)).toBe(false);
  });

  test("a session's asks oldest first, and the strip's line counts them", () => {
    const s = connected();
    const late = ask({ createdAt: 5000, status: "answered" });
    const early = ask({ createdAt: 100, status: "partial" });
    const other = ask({ session: B });
    const third = ask({ createdAt: 200 });
    apply(s, { type: "tracked", tracked: [late, other, early, third] });
    const list = trackedOf(s, A);
    expect(list.map((t) => t.id)).toEqual([early.id, third.id, late.id]);
    expect(trackedCounts(list)).toEqual({ open: 1, partial: 1, answered: 1 });
    expect(trackedSummary(list)).toBe("3 asks · 1 answered · 1 in part");
    expect(trackedSummary([third])).toBe("1 ask");
  });

  test("a mark says where an ask stands, and a press marks it answered, or open again", () => {
    expect(statusWords("open")).toBe("Not answered yet");
    expect(statusWords("partial")).toBe("Answered in part");
    expect(statusWords("answered", true)).toBe("Answered, as you marked it");
    expect([nextMark("open"), nextMark("partial"), nextMark("answered")]).toEqual(["answered", "answered", "open"]);
    expect(answerWords(2, 3, "partial")).toBe("Answer 2 of 3, in part");
    expect(answerWords(1, 1, "answered")).toBe("Answer 1 of 1");
  });

  test("a line says when asks cannot be checked: a usage limit, or no account", () => {
    const s = connected();
    expect(trackerTrouble(s)).toBeUndefined();
    apply(s, { type: "tracker", tracker: { on: true, sessions: {}, health: { state: "ok", at: 1 } } });
    expect(trackerTrouble(s)).toBeUndefined();
    apply(s, { type: "tracker.state", params: { on: true, sessions: {}, health: { state: "limited", detail: "usage limit", at: 1 } } });
    expect(trackerTrouble(s)).toContain("usage limit");
    apply(s, { type: "tracker.state", params: { on: true, sessions: {}, health: { state: "unavailable", detail: "no Claude account is signed in on this machine to judge with", at: 1 } } });
    expect(trackerTrouble(s)).toBe("Asks are not being checked: no Claude account is signed in on this machine to judge with.");
  });
});

describe("the tab of a followed session", () => {
  test("its asks answered of all, and whether one has an answer this device has not shown", () => {
    const s = connected();
    const a = ask({ status: "answered", answers: [{ seq: 15, at: 2, status: "answered" }] });
    const b = ask({ status: "partial", answers: [{ seq: 25, at: 3, status: "partial" }] });
    const c = ask();
    apply(s, { type: "tracked", tracked: [a, b, c] });
    // not before the settings say it is followed
    expect(tabAsks(s, A, undefined)).toBeUndefined();
    apply(s, { type: "tracker", tracker: { on: true, sessions: {} } });
    expect(latestAnswer(trackedOf(s, A))).toBe(25);
    expect(tabAsks(s, A, undefined)).toEqual({ answered: 1, total: 3, unread: true });
    expect(tabAsks(s, A, 15)?.unread).toBe(true);
    expect(tabAsks(s, A, 25)?.unread).toBe(false);
    // a new answer is to read again; one dismissed goes from the count
    apply(s, { type: "tracked.state", params: { ...c, status: "answered", answers: [{ seq: 40, at: 4, status: "answered" }] } });
    expect(tabAsks(s, A, 25)).toEqual({ answered: 2, total: 3, unread: true });
    apply(s, { type: "tracked.state", params: { ...b, dismissed: true } });
    expect(tabAsks(s, A, 40)).toEqual({ answered: 2, total: 2, unread: false });
    // switched off, or with no asks: no count
    apply(s, { type: "tracker.state", params: { on: true, sessions: { [A]: false } } });
    expect(tabAsks(s, A, 40)).toBeUndefined();
    expect(tabAsks(s, B, undefined)).toBeUndefined();
  });

  test("what this device read is kept in its prefs: back as it was, only for sessions with asks, the latest read kept", () => {
    expect(seenFrom({ [A]: 12, [B]: "x", c: 1.5 })).toEqual(new Map([[A, 12]]));
    expect(seenFrom(undefined).size).toBe(0);
    const s = connected();
    apply(s, { type: "tracked", tracked: [ask({ session: A }), ask({ session: B })] });
    const seen = new Map<string, number>([["gone", 3], [A, 7], [B, 9]]);
    expect(seenPrefs(seen, s)).toEqual({ [A]: 7, [B]: 9 });
    const many = new Map<string, number>();
    const asks: Tracked[] = [];
    for (let i = 0; i < SEEN_KEPT + 5; i++) {
      const id = `sess_${String(i).padStart(26, "0")}`;
      many.set(id, i);
      asks.push(ask({ session: id }));
    }
    apply(s, { type: "tracked", tracked: asks });
    const kept = seenPrefs(many, s);
    expect(Object.keys(kept)).toHaveLength(SEEN_KEPT);
    expect(kept[`sess_${String(SEEN_KEPT + 4).padStart(26, "0")}`]).toBe(SEEN_KEPT + 4);
    expect(JSON.stringify(kept).length).toBeLessThan(2500);
  });
});
