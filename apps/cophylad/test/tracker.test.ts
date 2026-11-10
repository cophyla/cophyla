// The tracker over a fake judge: what becomes an ask (the user's own words, not another
// agent's, the brain's, a slash command or a repeat), what the judge is shown and when (a
// request at once, the agent's messages at its turn's end, on a question, or every
// `busyEveryMs` while it works), how answers are kept (by seq, only after the ask, never back
// to open, never over the user's mark), the switches (on for all, one session's own over it),
// a usage limit that holds the judging and lifts, the catch-up after a restart, dismissing,
// and the judge's own run: its command line, its environment, and what its answers mean.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionDefinition, AGENT_TOOLS, capabilityRequests, clientRequests, newId, notificationFilters, requestFilters, requestScopes } from "@cophyla/protocol";
import type { HarnessProfile, Session, SessionEvent, Tracked, TrackerState } from "@cophyla/protocol";
import { Bus } from "../src/bus.ts";
import { BACKUP_EXCLUDED_KV_NS } from "../src/cloud/backup.ts";
import { RESERVED_KV_NS, TRACKER_KV_NS, TRACKER_SETTINGS_NS } from "../src/grants/namespaces.ts";
import { EXCLUDED_KV_NS } from "../src/nodes/replication.ts";
import { trackerMethods } from "../src/tracker/methods.ts";
import { silentLogger } from "../src/log.ts";
import { Store } from "../src/store/index.ts";
import { Tracker } from "../src/tracker/index.ts";
import { ClaudeJudge, cut, extractQuestion, firstObject, gradeQuestion, GRADE_CHARS, JudgeLimited, JudgeUnavailable, plainPrompt, readExtract, readGrade, retryAtOf } from "../src/tracker/judge.ts";
import type { ExtractInput, ExtractResult, GradeInput, GradeResult, Judge, Runner } from "../src/tracker/judge.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A judge that answers what the test says, and remembers what it was asked. */
class FakeJudge implements Judge {
  extracts: ExtractInput[] = [];
  grades: GradeInput[] = [];
  onExtract: (i: ExtractInput) => ExtractResult | Promise<ExtractResult> = (i) => ({ asks: [{ title: i.text.slice(0, 40) }], amend: [] });
  onGrade: (i: GradeInput) => GradeResult | Promise<GradeResult> = () => ({ results: [] });
  async extract(i: ExtractInput): Promise<ExtractResult> {
    this.extracts.push(i);
    return this.onExtract(i);
  }
  async grade(i: GradeInput): Promise<GradeResult> {
    this.grades.push(i);
    return this.onGrade(i);
  }
}

function session(id: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    harness: "claude",
    profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5PF1",
    native: { id: "n-" + id, transport: "pipe" },
    origin: "user",
    cwd: "/work",
    tags: [],
    status: "busy",
    startedAt: 1,
    lastActivity: 1,
    ...extra,
  } as Session;
}

interface Kit {
  tracker: Tracker;
  judge: FakeJudge;
  bus: Bus;
  store: Store;
  sessions: Map<string, Session>;
  told: Tracked[];
  states: TrackerState[];
  /** Events of a session, as its node records them. */
  events: Map<string, SessionEvent[]>;
  emit(id: string, kind: SessionEvent["kind"], payload: unknown): SessionEvent;
}

function kit(opts: { on?: boolean; busyEveryMs?: number; routes?: boolean; store?: Store; judge?: FakeJudge; history?: boolean } = {}): Kit {
  const store = opts.store ?? new Store(":memory:");
  if (!opts.store) store.migrate();
  const bus = new Bus();
  const sessions = new Map<string, Session>();
  const events = new Map<string, SessionEvent[]>();
  const judge = opts.judge ?? new FakeJudge();
  const told: Tracked[] = [];
  const states: TrackerState[] = [];
  bus.on("tracked.state", (t) => told.push(t));
  bus.on("tracker.state", (s) => states.push(s));
  const tracker = new Tracker({
    store,
    bus,
    log: silentLogger,
    routes: () => opts.routes ?? true,
    session: (id) => sessions.get(id),
    ...(opts.history === false ? {} : { history: (id: string, o: { before?: number; limit?: number }) => (events.get(id) ?? []).filter((e) => o.before === undefined || e.seq < o.before).slice(-(o.limit ?? 50)) }),
    judge,
    busyEveryMs: opts.busyEveryMs ?? 60_000,
    catchUpDelayMs: 20,
    minPauseMs: 50,
    soonMs: 30,
  });
  tracker.start();
  if (opts.on !== false) tracker.set({ on: true });
  let at = 1000;
  const emit = (id: string, kind: SessionEvent["kind"], payload: unknown): SessionEvent => {
    if (!sessions.has(id)) sessions.set(id, session(id));
    const list = events.get(id) ?? [];
    events.set(id, list);
    const e: SessionEvent = { session: id, seq: list.length, at: at++, kind, payload };
    list.push(e);
    bus.emit("session.event", e);
    return e;
  };
  return { tracker, judge, bus, store, sessions, told, states, events, emit };
}

const S = newId("session");
const S2 = newId("session");

describe("what becomes an ask", () => {
  test("off by default: nothing is followed until the user switches it on", async () => {
    const k = kit({ on: false });
    k.emit(S, "user_turn", { text: "Why does the relay drop big frames?", source: "typed" });
    await k.tracker.settled();
    expect(k.judge.extracts).toHaveLength(0);
    expect(k.tracker.list()).toEqual([]);
    expect(k.tracker.state()).toEqual({ on: false, sessions: {} });
    k.tracker.stop();
  });

  test("the user's message is read at once, with the agent's message before it, and each thing in it is an open ask", async () => {
    const k = kit();
    k.emit(S, "assistant_text", { text: "Shall I also rename the script?" });
    k.judge.onExtract = () => ({ asks: [{ title: "Rename the build script" }, { title: "Why does the relay drop big frames?" }], amend: [] });
    const turn = k.emit(S, "user_turn", { text: "<pasted_content id=\"x\">yes, rename it\nand why does the relay drop big frames?</pasted_content>", source: "typed" });
    await k.tracker.settled();
    expect(k.judge.extracts).toEqual([{ text: "yes, rename it\nand why does the relay drop big frames?", before: "Shall I also rename the script?", asks: [] }]);
    const list = k.tracker.list(S);
    expect(list.map((t) => [t.title, t.status, t.seq, t.answers])).toEqual([
      ["Rename the build script", "open", turn.seq, []],
      ["Why does the relay drop big frames?", "open", turn.seq, []],
    ]);
    expect(k.told.map((t) => t.title)).toEqual(["Rename the build script", "Why does the relay drop big frames?"]);
    // what the user wrote stays with the tracker for the judge; no client is sent it
    expect(JSON.stringify(k.told)).not.toContain("pasted_content");
    expect(Object.keys(list[0]!)).not.toContain("words");
    k.tracker.stop();
  });

  test("a reply with nothing in it to follow makes no ask; a change to one renames it", async () => {
    const k = kit();
    k.judge.onExtract = () => ({ asks: [{ title: "Make the button blue" }], amend: [] });
    k.emit(S, "user_turn", { text: "make the button blue", source: "sent" });
    await k.tracker.settled();
    k.judge.onExtract = () => ({ asks: [], amend: [] });
    k.emit(S, "user_turn", { text: "yes", source: "typed" });
    await k.tracker.settled();
    k.judge.onExtract = (i) => ({ asks: [], amend: [{ ask: i.asks.length, title: "Make the button dark blue" }] });
    k.emit(S, "user_turn", { text: "actually dark blue", source: "typed" });
    await k.tracker.settled();
    expect(k.judge.extracts[2]!.asks).toEqual([{ n: 1, title: "Make the button blue" }]);
    expect(k.tracker.list(S).map((t) => t.title)).toEqual(["Make the button dark blue"]);
    k.tracker.stop();
  });

  test("only the user's own words count: never another agent's, the brain's, a slash command, a harness notice or the same words twice", async () => {
    const k = kit();
    k.emit(S, "user_turn", { text: "from another agent", source: "agent" });
    k.emit(S, "user_turn", { text: "from a peer", source: "peer" });
    k.emit(S, "user_turn", { text: "the brain's task", source: "orchestrator" });
    k.emit(S, "user_turn", { text: "/clear", source: "typed" });
    k.emit(S, "user_turn", { text: "<task-notification><task-id>b1</task-id></task-notification>", source: "typed" });
    k.emit(S, "user_turn", { text: "   ", source: "typed" });
    k.emit(S, "user_turn", { text: "a leader's words", source: "lead" });
    k.emit(S, "user_turn", { text: "check the logs", source: "typed" });
    k.emit(S, "user_turn", { text: "check the logs", source: "hook" });
    await k.tracker.settled();
    expect(k.judge.extracts.map((e) => e.text)).toEqual(["a leader's words", "check the logs"]);
    k.tracker.stop();
  });

  test("the chat's own session is never followed, and nothing is followed off the primary", async () => {
    const k = kit();
    k.sessions.set(S, session(S, { role: "assistant" }));
    k.emit(S, "user_turn", { text: "what are my agents doing?", source: "sent" });
    await k.tracker.settled();
    expect(k.judge.extracts).toHaveLength(0);
    k.tracker.stop();
    const off = kit({ routes: false });
    off.emit(S, "user_turn", { text: "what are my agents doing?", source: "sent" });
    await off.tracker.settled();
    expect(off.judge.extracts).toHaveLength(0);
    off.tracker.stop();
  });

  test("a message the judge cannot read twice is still followed under its first words; a short one is let go", async () => {
    const k = kit();
    k.judge.onExtract = () => {
      throw new Error("the judge's answer was not JSON: sure!");
    };
    k.emit(S, "user_turn", { text: "please look into why the nightly build\nfails on Windows", source: "typed" });
    await k.tracker.settled();
    // tried twice, then followed under its first words; a short one is tried twice and let go
    k.emit(S, "user_turn", { text: "ok", source: "typed" });
    await k.tracker.settled();
    k.emit(S, "assistant_text", { text: "On it." });
    k.emit(S, "status", { status: "idle" });
    await k.tracker.settled();
    expect(k.tracker.list(S).map((t) => t.title)).toEqual(["please look into why the nightly build"]);
    k.tracker.stop();
  });
});

describe("what answers an ask", () => {
  test("the agent's messages are judged together at its turn's end, and the ones that answer are kept by seq", async () => {
    const k = kit();
    k.judge.onExtract = () => ({ asks: [{ title: "Why does the relay drop big frames?" }, { title: "Rename the build script" }], amend: [] });
    k.emit(S, "user_turn", { text: "why does the relay drop big frames, and rename the build script", source: "typed" });
    await k.tracker.settled();
    const m1 = k.emit(S, "assistant_text", { text: "Let me look." });
    const m2 = k.emit(S, "assistant_text", { text: "The relay caps each message at 4 MiB." });
    const m3 = k.emit(S, "assistant_text", { text: "Renaming is half done: the file moved, the imports not yet." });
    k.emit(S, "tool_call", { tool: "Bash" });
    expect(k.judge.grades).toHaveLength(0);
    k.judge.onGrade = () => ({ results: [{ ask: 1, status: "answered", messages: [2] }, { ask: 2, status: "partial", messages: [3] }] });
    k.emit(S, "status", { status: "idle" });
    await k.tracker.settled();
    expect(k.judge.grades).toHaveLength(1);
    expect(k.judge.grades[0]!.messages.map((m) => m.text)).toEqual([m1, m2, m3].map((e) => (e.payload as { text: string }).text));
    expect(k.judge.grades[0]!.asks.map((a) => [a.n, a.title])).toEqual([[1, "Why does the relay drop big frames?"], [2, "Rename the build script"]]);
    expect(k.judge.grades[0]!.asks[0]!.words).toBe("why does the relay drop big frames, and rename the build script");
    const [a, b] = k.tracker.list(S);
    expect([a!.status, a!.answers]).toEqual(["answered", [{ seq: m2.seq, at: m2.at, status: "answered" }]]);
    expect([b!.status, b!.answers]).toEqual(["partial", [{ seq: m3.seq, at: m3.at, status: "partial" }]]);
    // an answered ask is not put to the judge again; a partial one is, and goes on
    const m4 = k.emit(S, "assistant_text", { text: "The imports are renamed too." });
    k.judge.onGrade = (i) => ({ results: [{ ask: 1, status: "answered" as const, messages: [1] }].filter(() => i.asks.length === 1) });
    k.emit(S, "status", { status: "idle" });
    await k.tracker.settled();
    expect(k.judge.grades[1]!.asks.map((x) => x.title)).toEqual(["Rename the build script"]);
    const b2 = k.tracker.list(S)[1]!;
    expect(b2.status).toBe("answered");
    expect(b2.answers.map((x) => [x.seq, x.status])).toEqual([[m3.seq, "partial"], [m4.seq, "answered"]]);
    k.tracker.stop();
  });

  test("nothing open, nothing judged; a message from before the ask answers none of it", async () => {
    const k = kit();
    k.emit(S, "assistant_text", { text: "Earlier work." });
    k.emit(S, "status", { status: "idle" });
    await k.tracker.settled();
    expect(k.judge.grades).toHaveLength(0);
    const early = k.emit(S, "assistant_text", { text: "A message before the ask." });
    k.emit(S, "user_turn", { text: "what is the port?", source: "typed" });
    await k.tracker.settled();
    k.judge.onGrade = (i) => ({ results: [{ ask: 1, status: "answered", messages: i.messages.map((m) => m.n) }] });
    const late = k.emit(S, "assistant_text", { text: "It is 4817." });
    k.emit(S, "status", { status: "idle" });
    await k.tracker.settled();
    expect(k.judge.grades[0]!.messages.map((m) => m.text)).toEqual(["It is 4817."]);
    expect(k.tracker.list(S)[0]!.answers.map((a) => a.seq)).toEqual([late.seq]);
    expect(early.seq).toBeLessThan(late.seq);
    k.tracker.stop();
  });

  test("a question to the user judges at once; a long turn is judged every busyEveryMs while it goes on", async () => {
    const k = kit({ busyEveryMs: 80 });
    k.emit(S, "user_turn", { text: "deploy it", source: "typed" });
    await k.tracker.settled();
    k.emit(S, "assistant_text", { text: "Deploying now." });
    k.emit(S, "ask", { kind: "permission" });
    await k.tracker.settled();
    expect(k.judge.grades).toHaveLength(1);
    k.emit(S, "assistant_text", { text: "Step one done." });
    await sleep(30);
    expect(k.judge.grades).toHaveLength(1);
    await sleep(120);
    await k.tracker.settled();
    expect(k.judge.grades).toHaveLength(2);
    expect(k.judge.grades[1]!.messages.map((m) => m.text)).toEqual(["Step one done."]);
    k.tracker.stop();
  });

  test("a message read after its turn's end (the end can be told first) is judged a moment later, not at the next turn", async () => {
    const k = kit({ busyEveryMs: 60_000 });
    k.emit(S, "user_turn", { text: "what is the port?", source: "typed" });
    await k.tracker.settled();
    k.emit(S, "status", { status: "idle" });
    k.sessions.set(S, session(S, { status: "idle" }));
    k.judge.onGrade = () => ({ results: [{ ask: 1, status: "answered", messages: [1] }] });
    k.emit(S, "assistant_text", { text: "It is 4817." });
    await sleep(120);
    await k.tracker.settled();
    expect(k.judge.grades).toHaveLength(1);
    expect(k.tracker.list(S)[0]!.status).toBe("answered");
    k.tracker.stop();
  });

  test("an ask never goes back on its own, and the user's mark is left alone", async () => {
    const k = kit();
    k.emit(S, "user_turn", { text: "fix the tests", source: "typed" });
    await k.tracker.settled();
    k.judge.onGrade = () => ({ results: [{ ask: 1, status: "partial", messages: [1] }] });
    k.emit(S, "assistant_text", { text: "Two of three pass." });
    k.emit(S, "status", { status: "idle" });
    await k.tracker.settled();
    k.judge.onGrade = () => ({ results: [{ ask: 1, status: "open", messages: [] }] });
    k.emit(S, "assistant_text", { text: "Looking at the third." });
    k.emit(S, "status", { status: "idle" });
    await k.tracker.settled();
    const t = k.tracker.list(S)[0]!;
    expect(t.status).toBe("partial");
    const marked = k.tracker.mark(t.id, "answered");
    expect([marked.status, marked.marked]).toEqual(["answered", true]);
    k.emit(S, "assistant_text", { text: "All pass." });
    k.emit(S, "status", { status: "idle" });
    await k.tracker.settled();
    // marked: not put to the judge again
    expect(k.judge.grades).toHaveLength(2);
    expect(() => k.tracker.mark(newId("tracked"), "open")).toThrow("no ask");
    k.tracker.stop();
  });

  test("a long turn is put to the judge in more than one question, each short enough", async () => {
    const k = kit();
    k.emit(S, "user_turn", { text: "write the report", source: "typed" });
    await k.tracker.settled();
    const big = "x".repeat(5000);
    for (let i = 0; i < 12; i++) k.emit(S, "assistant_text", { text: `${i} ${big}` });
    k.emit(S, "status", { status: "idle" });
    await k.tracker.settled();
    expect(k.judge.grades.length).toBeGreaterThan(1);
    expect(k.judge.grades.flatMap((g) => g.messages).length).toBe(12);
    for (const g of k.judge.grades) expect(gradeQuestion(g).length).toBeLessThan(GRADE_CHARS + 2000);
    k.tracker.stop();
  });
});

describe("the switches, dismissing and the judge's health", () => {
  test("one session's own switch is over the tracker's, either way; switching follows from now", async () => {
    const k = kit({ on: false });
    k.tracker.set({ session: { id: S, on: true } });
    k.emit(S, "user_turn", { text: "first", source: "typed" });
    k.emit(S2, "user_turn", { text: "second", source: "typed" });
    await k.tracker.settled();
    expect(k.judge.extracts.map((e) => e.text)).toEqual(["first"]);
    const st = k.tracker.set({ on: true, session: { id: S2, on: false } });
    expect([st.on, st.sessions, st.health?.state]).toEqual([true, { [S]: true, [S2]: false }, "ok"]);
    k.emit(S2, "user_turn", { text: "third", source: "typed" });
    await k.tracker.settled();
    expect(k.judge.extracts.map((e) => e.text)).toEqual(["first"]);
    k.tracker.set({ session: { id: S2, on: null } });
    k.emit(S2, "user_turn", { text: "fourth", source: "typed" });
    await k.tracker.settled();
    expect(k.judge.extracts.map((e) => e.text)).toEqual(["first", "fourth"]);
    expect([k.states.at(-1)?.on, k.states.at(-1)?.sessions]).toEqual([true, { [S]: true }]);
    k.tracker.stop();
  });

  test("dismissing takes asks out of every list and tells it once; an id already gone is passed over", async () => {
    const k = kit();
    k.judge.onExtract = () => ({ asks: [{ title: "one" }, { title: "two" }], amend: [] });
    k.emit(S, "user_turn", { text: "one and two", source: "typed" });
    await k.tracker.settled();
    const [one, two] = k.tracker.list();
    k.tracker.dismiss([one!.id, newId("tracked")]);
    expect(k.tracker.list().map((t) => t.title)).toEqual(["two"]);
    expect(k.told.at(-1)).toMatchObject({ id: one!.id, dismissed: true });
    k.tracker.dismiss([two!.id]);
    expect(k.tracker.list()).toEqual([]);
    k.tracker.stop();
  });

  test("a usage limit holds the judging, says so, and lifts; what waited is judged then", async () => {
    const k = kit();
    let limited = true;
    k.judge.onExtract = () => {
      if (limited) throw new JudgeLimited("You've hit your usage limit", Date.now() + 60);
      return { asks: [{ title: "Summarise the logs" }], amend: [] };
    };
    k.emit(S, "user_turn", { text: "summarise the logs", source: "typed" });
    await k.tracker.settled();
    expect(k.tracker.state().health?.state).toBe("limited");
    expect(k.states.at(-1)?.health?.detail).toContain("usage limit");
    limited = false;
    await sleep(150);
    await k.tracker.settled();
    expect(k.tracker.list(S).map((t) => t.title)).toEqual(["Summarise the logs"]);
    expect(k.tracker.state().health?.state).toBe("ok");
    k.tracker.stop();
  });

  test("no account to judge with: unavailable, and a new account in the settings tries again at once", async () => {
    const k = kit();
    let none = true;
    k.judge.onExtract = () => {
      if (none) throw new JudgeUnavailable("no Claude account is signed in on this machine to judge with");
      return { asks: [{ title: "Plan the release" }], amend: [] };
    };
    k.emit(S, "user_turn", { text: "plan the release", source: "typed" });
    await k.tracker.settled();
    expect(k.tracker.state().health).toMatchObject({ state: "unavailable" });
    none = false;
    k.tracker.set({ profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5PF2" });
    expect(k.tracker.state().health).toBeUndefined();
    await sleep(80);
    k.emit(S, "assistant_text", { text: "Planning." });
    k.emit(S, "status", { status: "idle" });
    await k.tracker.settled();
    expect(k.tracker.list(S).map((t) => t.title)).toEqual(["Plan the release"]);
    k.tracker.stop();
  });
});

describe("after a restart", () => {
  test("a session of this machine's catches up from its own events on what came while the tracker was away", async () => {
    const store = new Store(":memory:");
    store.migrate();
    const first = kit({ store });
    first.judge.onExtract = () => ({ asks: [{ title: "Find the leak" }], amend: [] });
    first.emit(S, "user_turn", { text: "find the leak", source: "typed" });
    await first.tracker.settled();
    first.tracker.stop();
    expect(store.kv.get(TRACKER_KV_NS, `~seen/${S}`)).toEqual({ seq: 0, prompts: 0 });

    // the daemon was down while the agent answered and finished its turn
    const judge = new FakeJudge();
    judge.onGrade = (i) => ({ results: [{ ask: 1, status: "answered", messages: [i.messages.length] }] });
    const second = kit({ store, judge });
    second.events.set(S, [...first.events.get(S)!]);
    second.sessions.set(S, session(S, { status: "idle" }));
    const log = second.events.get(S)!;
    const missed = (kind: SessionEvent["kind"], payload: unknown) => log.push({ session: S, seq: log.length, at: 5000 + log.length, kind, payload });
    missed("assistant_text", { text: "Looking." });
    // a turn's end in the middle of what is caught up on: still one question, with all of it
    missed("status", { status: "idle" });
    missed("assistant_text", { text: "The leak is the unclosed tail in recorder.ts." });
    missed("status", { status: "idle" });
    await sleep(60);
    await second.tracker.settled();
    expect(judge.grades.map((g) => g.messages.map((m) => m.text))).toEqual([["Looking.", "The leak is the unclosed tail in recorder.ts."]]);
    const t = second.tracker.list(S)[0]!;
    expect([t.status, t.answers.map((a) => a.seq)]).toEqual(["answered", [3]]);
    second.tracker.stop();
  });

  test("a stop loses no message still waiting for the judge, and reads no request twice", async () => {
    const store = new Store(":memory:");
    store.migrate();
    const first = kit({ store, busyEveryMs: 60_000 });
    first.judge.onExtract = () => ({ asks: [{ title: "Find the leak" }], amend: [] });
    first.emit(S, "user_turn", { text: "find the leak", source: "typed" });
    await first.tracker.settled();
    // the answer came, but the turn goes on: it waits for the judge, and the daemon stops
    const answer = first.emit(S, "assistant_text", { text: "The leak is the unclosed tail." });
    first.emit(S, "tool_call", { tool: "Bash" });
    first.tracker.stop();
    expect(store.kv.get(TRACKER_KV_NS, `~seen/${S}`)).toEqual({ seq: answer.seq - 1, prompts: 0 });

    const judge = new FakeJudge();
    judge.onGrade = () => ({ results: [{ ask: 1, status: "answered", messages: [1] }] });
    const second = kit({ store, judge });
    second.events.set(S, [...first.events.get(S)!]);
    second.sessions.set(S, session(S, { status: "idle" }));
    await sleep(60);
    await second.tracker.settled();
    expect(judge.extracts).toHaveLength(0);
    expect(judge.grades.map((g) => g.messages.map((m) => m.text))).toEqual([["The leak is the unclosed tail."]]);
    expect(second.tracker.list(S).map((t) => [t.status, t.answers.map((a) => a.seq)])).toEqual([["answered", [answer.seq]]]);
    second.tracker.stop();
  });

  test("a session followed afresh starts from now: what it said while it was not followed is not caught up on", async () => {
    const store = new Store(":memory:");
    store.migrate();
    const k = kit({ store });
    k.emit(S, "user_turn", { text: "first ask", source: "typed" });
    await k.tracker.settled();
    k.tracker.stop();
    expect(store.kv.get(TRACKER_KV_NS, `~seen/${S}`)).toEqual({ seq: 0, prompts: 0 });
    const again = kit({ store });
    again.tracker.set({ session: { id: S, on: false } });
    again.tracker.set({ session: { id: S, on: true } });
    expect(store.kv.get(TRACKER_KV_NS, `~seen/${S}`)).toBeUndefined();
    // the whole tracker switched off and on: every session starts from now
    again.tracker.set({ session: { id: S, on: null } });
    store.kv.put(TRACKER_KV_NS, `~seen/${S2}`, 7);
    again.tracker.set({ on: false });
    again.tracker.set({ on: true });
    expect(store.kv.list(TRACKER_KV_NS, "~seen/")).toEqual([]);
    again.tracker.stop();
  });
});

describe("the judge's run", () => {
  const cleanup: string[] = [];
  afterAll(() => {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
  });
  const profile = (configDir: string, extra: Partial<HarnessProfile> = {}): HarnessProfile => ({ id: "prof_01ARZ3NDEKTSV4RRFFQ69G5PF1", node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV", harness: "claude", name: "work", configDir, env: {}, origin: "user", status: "ok", ...extra }) as HarnessProfile;
  const reply = (result: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result, usage: { input_tokens: 2, cache_creation_input_tokens: 800, output_tokens: 40 }, ...extra });

  test("a bare `claude -p` in cophylad's folder, signed in as the profile, the question on stdin, no harness markers", async () => {
    const calls: { argv: string[]; cwd: string; env: Record<string, string>; stdin: string }[] = [];
    const run: Runner = async (argv, o) => {
      calls.push({ argv, cwd: o.cwd, env: o.env, stdin: o.stdin });
      return { code: 0, stdout: reply('```json\n{"asks":[{"title":"Rename the script."}],"amend":[]}\n```'), stderr: "" };
    };
    const dir = join(tmpdir(), `cophyla-test-tracker-${Date.now()}`);
    cleanup.push(dir);
    const judge = new ClaudeJudge({ profile: () => profile("/elsewhere/claude-work"), cwd: dir, model: "haiku", effort: "low", timeoutMs: 5000, command: ["fake-claude", "--first"], env: { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CONFIG_DIR: "/inherited" }, log: silentLogger, run });
    const r = await judge.extract({ text: "rename the script", asks: [] });
    expect(r).toEqual({ asks: [{ title: "Rename the script" }], amend: [] });
    const c = calls[0]!;
    expect(c.argv.slice(0, 2)).toEqual(["fake-claude", "--first"]);
    expect(c.argv).toContain("-p");
    for (const [flag, value] of [["--model", "haiku"], ["--effort", "low"], ["--setting-sources", "project,local"], ["--tools", ""], ["--output-format", "json"]] as const) expect(c.argv[c.argv.indexOf(flag) + 1]).toBe(value);
    for (const flag of ["--strict-mcp-config", "--no-session-persistence", "--system-prompt"]) expect(c.argv).toContain(flag);
    expect(c.argv.join(" ")).not.toContain("rename the script");
    expect(c.stdin).toContain("rename the script");
    expect(c.cwd).toBe(dir);
    expect(c.env["CLAUDE_CONFIG_DIR"]).toBe("/elsewhere/claude-work");
    expect(c.env["CLAUDECODE"]).toBeUndefined();
    expect(c.env["CLAUDE_CODE_ENTRYPOINT"]).toBeUndefined();
    expect(c.env["PATH"]).toBe("/bin");
  });

  test("a usage limit, a signed-out account and no account at all say so; any other failure is an error", async () => {
    const answer = (out: { code: number; stdout: string; stderr?: string }): Runner => async () => ({ stderr: "", ...out });
    const runDir = join(tmpdir(), `cophyla-test-tracker-run-${Date.now()}`);
    cleanup.push(runDir);
    const make = (run: Runner, p: HarnessProfile | null = profile("/x")) => new ClaudeJudge({ profile: () => p ?? undefined, cwd: runDir, model: "haiku", effort: "low", timeoutMs: 5000, command: ["c"], env: {}, log: silentLogger, run });
    await expect(make(answer({ code: 1, stdout: reply("Claude AI usage limit reached|1762790400", { is_error: true }) })).grade({ asks: [{ n: 1, title: "a" }], messages: [{ n: 1, text: "b" }] })).rejects.toBeInstanceOf(JudgeLimited);
    await expect(make(answer({ code: 1, stdout: reply("Not logged in · Please run /login", { is_error: true }) })).extract({ text: "x", asks: [] })).rejects.toBeInstanceOf(JudgeUnavailable);
    await expect(make(answer({ code: 0, stdout: reply("{}") }), null).extract({ text: "x", asks: [] })).rejects.toBeInstanceOf(JudgeUnavailable);
    await expect(make(answer({ code: 2, stdout: "", stderr: "boom" })).extract({ text: "x", asks: [] })).rejects.toThrow("boom");
    await expect(make(answer({ code: 0, stdout: reply("I think the answer is yes") })).extract({ text: "x", asks: [] })).rejects.toThrow("not JSON");
  });

  test("what its answers mean: only known asks and messages, statuses as given, open ones citing nothing", () => {
    expect(readGrade('{"results":[{"ask":1,"status":"answered","messages":[2,2,9,1]},{"ask":3,"status":"partial","messages":[1]},{"ask":2,"status":"done"},{"ask":2,"status":"open","messages":[1]}]}', 2, 2)).toEqual({
      results: [
        { ask: 1, status: "answered", messages: [1, 2] },
        { ask: 2, status: "open", messages: [] },
      ],
    });
    expect(readExtract('Here: {"asks":[{"title":"  a\\nb.  "},{"title":""},{"title":"c"},{"title":"d"},{"title":"e"}],"amend":[{"ask":2,"title":"x"},{"ask":7,"title":"y"}]}', 2)).toEqual({ asks: [{ title: "a b" }, { title: "c" }], amend: [{ ask: 2, title: "x" }] });
    expect(firstObject('text {"a":"}{"} more')).toEqual({ a: "}{" });
    expect(firstObject("none")).toBeUndefined();
    expect(plainPrompt('<pasted_content id="1">hi</pasted_content>\n<system-reminder>x</system-reminder>')).toBe("hi");
    expect(cut("abcdefghij", 5)).toBe("abcd…");
    expect(cut("a".repeat(100) + "END", 40, true)).toEndWith("END");
    expect(retryAtOf("try again in 20 minutes", 0)).toBe(1_200_000);
    expect(retryAtOf("limit reached", 0)).toBe(900_000);
    const q = extractQuestion({ text: "go", before: "Shall I?", asks: [{ n: 1, title: "t" }] });
    expect(q).toContain("1. t");
    expect(q).toContain("Shall I?");
  });
});

describe("the tracker's place", () => {
  test("its kv is the daemon's own: never the brain's, replicated to the backups, never in the cloud backup", () => {
    for (const ns of [TRACKER_KV_NS, TRACKER_SETTINGS_NS]) {
      expect(RESERVED_KV_NS).toContain(ns);
      expect(EXCLUDED_KV_NS).not.toContain(ns);
      expect(BACKUP_EXCLUDED_KV_NS).toContain(ns);
    }
  });

  test("clients alone reach it: no brain request and no agent tool; reading needs sessions:read, changing sessions:write", () => {
    const names = ["tracked.list", "tracked.dismiss", "tracked.mark", "tracker.get", "tracker.set"] as const;
    for (const name of names) {
      expect(Object.keys(clientRequests)).toContain(name);
      expect(Object.keys(capabilityRequests)).not.toContain(name);
    }
    expect(AGENT_TOOLS.map((t) => t.name).filter((n) => /track/.test(n))).toEqual([]);
    expect(names.map((n) => requestScopes[n])).toEqual(["sessions:read", "sessions:write", "sessions:write", "sessions:read", "sessions:write"]);
    expect(names.map((n) => actionDefinition(n)?.risk)).toEqual(["read", "write", "write", "read", "write"]);
  });

  test("limited access lists the asks of the sessions it reaches and is told only of those; it changes nothing", () => {
    const a: Tracked = { id: newId("tracked"), session: S, seq: 1, title: "a", status: "open", answers: [], createdAt: 1, updatedAt: 1 };
    const b: Tracked = { ...a, id: newId("tracked"), session: S2, title: "b" };
    const keep = (t: { session?: string }) => t.session === S;
    const list = requestFilters["tracked.list"];
    expect(list.names).toBe("open");
    expect(list.result!({ tracked: [a, b] }, keep).tracked.map((t) => t.title)).toEqual(["a"]);
    expect(notificationFilters["tracked.state"]).toBeInstanceOf(Function);
    expect((notificationFilters["tracked.state"] as (p: Tracked) => unknown)(b)).toEqual({ session: S2 });
    for (const n of ["tracked.dismiss", "tracked.mark", "tracker.get", "tracker.set"] as const) expect(requestFilters[n].names).toBe("global");
  });

  test("the methods answer from the primary's tracker, and are refused, not empty, where there is none yet", async () => {
    const k = kit();
    k.judge.onExtract = () => ({ asks: [{ title: "Ship it" }], amend: [] });
    k.emit(S, "user_turn", { text: "ship it", source: "typed" });
    await k.tracker.settled();
    const m = trackerMethods({ tracker: () => k.tracker }) as Record<string, { handler: (p: unknown) => unknown }>;
    const listed = (m["tracked.list"]!.handler({ session: S }) as { tracked: Tracked[] }).tracked;
    expect(listed.map((t) => t.title)).toEqual(["Ship it"]);
    expect((m["tracked.list"]!.handler({}) as { tracked: Tracked[] }).tracked).toHaveLength(1);
    expect((m["tracked.mark"]!.handler({ id: listed[0]!.id, status: "answered" }) as { tracked: Tracked }).tracked.status).toBe("answered");
    expect((m["tracker.set"]!.handler({ session: { id: S, on: false } }) as TrackerState).sessions).toEqual({ [S]: false });
    expect((m["tracker.get"]!.handler({}) as TrackerState).on).toBe(true);
    expect(m["tracked.dismiss"]!.handler({ ids: [listed[0]!.id] })).toEqual({});
    expect((m["tracked.list"]!.handler({}) as { tracked: Tracked[] }).tracked).toEqual([]);
    const off = trackerMethods({ tracker: () => undefined }) as Record<string, { handler: (p: unknown) => unknown }>;
    expect(() => off["tracked.list"]!.handler({})).toThrow("kept by the primary");
    k.tracker.stop();
  });
});
