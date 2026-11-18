// Notes: what an agent leaves its user to read (`notify_user`). Where a note is placed (the
// newest event heard, then its own tool call, by the harness's id for it or its title, in
// either order), what is refused and why (off, too long, too many in an hour, the same title
// again), what answers one that waits (the user's own next message: typed, met by a hook, or
// sent from one of their apps; never another agent's, a leader's, the brain's or a script's,
// nor a slash command or a notice), taking an answer back, dismissing, how long notes are kept,
// the switch, the methods and where the rows live.

import { describe, expect, test } from "bun:test";
import { actionDefinition, clientRequests, newId, noteOpen, notificationFilters, requestFilters, requestScopes } from "@cophyla/protocol";
import type { Note, NotesState, SessionEvent } from "@cophyla/protocol";
import { Bus } from "../src/bus.ts";
import { BACKUP_EXCLUDED_KV_NS } from "../src/cloud/backup.ts";
import { NOTES_KV_NS, NOTES_SETTINGS_NS, RESERVED_KV_NS } from "../src/grants/namespaces.ts";
import { silentLogger } from "../src/log.ts";
import { EXCLUDED_KV_NS } from "../src/nodes/replication.ts";
import { noteAnswerText, noteArgs, Notes, NOTES_HOURLY, NOTES_KEEP_MS, NOTES_MAX } from "../src/notes/index.ts";
import type { NoteArgs } from "../src/notes/index.ts";
import { notesMethods } from "../src/notes/methods.ts";
import { Store } from "../src/store/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Kit {
  notes: Notes;
  bus: Bus;
  store: Store;
  told: Note[];
  states: NotesState[];
  clock: { now: number };
  emit(id: string, kind: SessionEvent["kind"], payload: unknown): SessionEvent;
}

function kit(opts: { store?: Store; routes?: boolean; history?: Map<string, SessionEvent[]> } = {}): Kit {
  const store = opts.store ?? new Store(":memory:");
  if (!opts.store) store.migrate();
  const bus = new Bus();
  const told: Note[] = [];
  const states: NotesState[] = [];
  bus.on("note.state", (n) => told.push(n));
  bus.on("notes.state", (s) => states.push(s));
  const clock = { now: 1_758_196_700_000 };
  const seqs = new Map<string, number>();
  const notes = new Notes({
    store,
    bus,
    log: silentLogger,
    routes: () => opts.routes ?? true,
    ...(opts.history ? { history: (id: string, o: { limit?: number }) => (opts.history!.get(id) ?? []).slice(-(o.limit ?? 50)).reverse() } : {}),
    now: () => clock.now,
    sentWaitMs: 60,
  });
  notes.start();
  const emit = (id: string, kind: SessionEvent["kind"], payload: unknown): SessionEvent => {
    const seq = (seqs.get(id) ?? -1) + 1;
    seqs.set(id, seq);
    const e: SessionEvent = { session: id, seq, at: clock.now, kind, payload };
    bus.emit("session.event", e);
    return e;
  };
  return { notes, bus, store, told, states, clock, emit };
}

const S = newId("session");
const S2 = newId("session");
const args = (title: string, extra: Partial<NoteArgs> = {}): NoteArgs => ({ title, needsAnswer: false, urgent: false, ...extra });
/** Claude's own name for the tool, as its transcript writes the call. */
const TOOL = "mcp__cophyla-agents__notify_user";

describe("what a note is", () => {
  test("a note is left at the newest event heard of its session, open until read, and the agent is told it has it", () => {
    const k = kit();
    k.emit(S, "user_turn", { text: "migrate the tables", source: "typed" });
    k.emit(S, "assistant_text", { text: "Migrating." });
    const n = k.notes.add(S, args("Migration done: 3 tables moved", { detail: "**orders** kept on the old schema." }));
    expect(n).toMatchObject({ session: S, seq: 1, title: "Migration done: 3 tables moved", detail: "**orders** kept on the old schema.", needsAnswer: false, urgent: false, at: k.clock.now });
    expect(n.id.startsWith("nte_")).toBe(true);
    expect(noteOpen(n)).toBe(true);
    expect(k.notes.list()).toEqual([n]);
    expect(k.told).toEqual([n]);
    expect(noteAnswerText(n)).toBe("Your user has the note.");
    expect(noteAnswerText({ needsAnswer: true })).toBe("Your user has the note, waiting for their answer: it comes as their next message to you.");
    k.notes.stop();
  });

  test("a session none of whose events was heard yet is placed at its newest event held here, else at the start", () => {
    const history = new Map<string, SessionEvent[]>([[S, [{ session: S, seq: 0, at: 1, kind: "user_turn", payload: {} }, { session: S, seq: 41, at: 2, kind: "assistant_text", payload: {} }]]]);
    const k = kit({ history });
    expect(k.notes.add(S, args("From history")).seq).toBe(41);
    expect(k.notes.add(S2, args("Nothing held")).seq).toBe(0);
    k.notes.stop();
  });

  test("a read note is finished; one that waits stays open until it is answered, read or not", () => {
    const k = kit();
    const fyi = k.notes.add(S, args("FYI"));
    const ask = k.notes.add(S, args("Deploy now?", { needsAnswer: true, urgent: true }));
    const read = k.notes.mark(fyi.id, { read: true });
    expect(read.read).toBe(k.clock.now);
    expect(noteOpen(read)).toBe(false);
    expect(noteOpen(k.notes.mark(ask.id, { read: true }))).toBe(true);
    expect(noteOpen(k.notes.mark(fyi.id, { read: false }))).toBe(true);
    // answered by hand: the user answered somewhere Cophyla does not see
    const done = k.notes.mark(ask.id, { answered: true });
    expect(done.answered).toEqual({ at: k.clock.now, seq: ask.seq, text: "" });
    expect(noteOpen(done)).toBe(false);
    expect(() => k.notes.mark(newId("note"), { read: true })).toThrow("no note");
    k.notes.stop();
  });

  test("the arguments are read for the agent: a title of one line, a short detail, flags true or false", () => {
    expect(noteArgs({ title: "  Done:\n the  migration ", detail: "  see `0042.sql`  ", needs_answer: true })).toEqual({ title: "Done: the migration", detail: "see `0042.sql`", needsAnswer: true, urgent: false });
    expect(noteArgs({ title: "x", detail: "   " })).toEqual({ title: "x", needsAnswer: false, urgent: false });
    expect(() => noteArgs({})).toThrow("notify_user needs title");
    expect(() => noteArgs({ title: "   " })).toThrow("notify_user needs title");
    expect(() => noteArgs({ title: "a".repeat(81) })).toThrow("the title is 81 characters, and takes at most 80: keep it to one short line and put the rest in detail");
    expect(() => noteArgs({ title: "ok", detail: "d".repeat(1001) })).toThrow("takes at most 1,000");
    expect(() => noteArgs({ title: "ok", urgent: "yes" })).toThrow("urgent is true or false");
    expect(() => noteArgs({ title: "ok", detail: 3 })).toThrow("detail is text");
  });
});

describe("what is refused", () => {
  test("notes off: none is left, and the agent is told to say it in its reply", () => {
    const k = kit();
    expect(k.notes.state()).toEqual({ on: true });
    expect(k.notes.set({ on: false })).toEqual({ on: false });
    expect(k.states).toEqual([{ on: false }]);
    expect(() => k.notes.add(S, args("Done"))).toThrow("your user switched notes off in Cophyla, so none was left: say it in your reply instead");
    expect(k.notes.list()).toEqual([]);
    // the switch is kept
    const again = new Notes({ store: k.store, bus: new Bus(), log: silentLogger, routes: () => true });
    expect(again.state()).toEqual({ on: false });
    k.notes.set({ on: true });
    expect(k.states).toEqual([{ on: false }, { on: true }]);
    k.notes.stop();
  });

  test("the same title in a session goes once in ten minutes; another session's is its own", () => {
    const k = kit();
    k.notes.add(S, args("Tests pass"));
    k.clock.now += 3 * 60_000;
    expect(() => k.notes.add(S, args("Tests pass"))).toThrow("a note with this title went to your user 3 minutes ago, so it was not left again");
    expect(k.notes.add(S2, args("Tests pass")).session).toBe(S2);
    k.clock.now += 8 * 60_000;
    expect(k.notes.add(S, args("Tests pass")).title).toBe("Tests pass");
    k.notes.stop();
  });

  test("at most ten an hour in a session: the agent is told when the next can go", () => {
    const k = kit();
    for (let i = 0; i < NOTES_HOURLY; i++) {
      k.notes.add(S, args(`Finding ${i}`));
      k.clock.now += 60_000;
    }
    expect(() => k.notes.add(S, args("One more"))).toThrow("your session left 10 notes in the last hour, the most it may; the next can go in 50 minutes");
    k.clock.now += 50 * 60_000;
    expect(k.notes.add(S, args("One more")).title).toBe("One more");
    k.notes.stop();
  });

  test("a node that does not keep the notes leaves none", () => {
    const k = kit({ routes: false });
    expect(() => k.notes.add(S, args("Done"))).toThrow("notes are kept by the primary");
    k.notes.stop();
  });
});

describe("where a note is placed", () => {
  test("at its tool call once the session's log has it, by the harness's id for the call", () => {
    const k = kit();
    k.emit(S, "assistant_text", { text: "Working." });
    const n = k.notes.add(S, args("Found the leak", { needsAnswer: true }), "toolu_A");
    expect(n.seq).toBe(0);
    k.emit(S, "assistant_text", { text: "Still going." });
    // another call to the tool with the same title but another id is not this note's
    k.emit(S, "tool_call", { tool: TOOL, id: "toolu_B", args: { title: "Something else" } });
    const call = k.emit(S, "tool_call", { tool: TOOL, id: "toolu_A", args: { title: "Found the leak" } });
    const placed = k.notes.list()[0]!;
    expect(placed).toMatchObject({ id: n.id, seq: call.seq, call: "toolu_A" });
    expect(k.told.at(-1)).toEqual(placed);
    k.notes.stop();
  });

  test("by its title when the harness gave no id, and a call heard before its note came places it too", () => {
    const k = kit();
    k.emit(S, "assistant_text", { text: "Working." });
    const n = k.notes.add(S, args("Review the plan"));
    const call = k.emit(S, "tool_call", { tool: "notify_user", id: "call_9", args: { title: "Review  the plan" } });
    expect(k.notes.list()[0]).toMatchObject({ id: n.id, seq: call.seq, call: "call_9" });
    // Codex's log has the call first
    const early = k.emit(S2, "tool_call", { tool: "mcp__cophyla-agents__notify_user", id: "call_7", args: { title: "Blocked on the API key" } });
    k.emit(S2, "assistant_text", { text: "Waiting." });
    const m = k.notes.add(S2, args("Blocked on the API key", { needsAnswer: true }));
    expect(m).toMatchObject({ seq: early.seq, call: "call_7" });
    // another tool's call places nothing
    k.emit(S, "tool_call", { tool: "mcp__other__notify_users", id: "x", args: { title: "Review the plan" } });
    expect(k.notes.list().find((x) => x.id === n.id)!.seq).toBe(call.seq);
    k.notes.stop();
  });

  test("a note the harness gave an id for is never placed at another call of the same title, one refused a moment before", () => {
    const k = kit();
    k.notes.set({ on: false });
    const refused = k.emit(S, "tool_call", { tool: TOOL, id: "toolu_OLD", args: { title: "Tests pass" } });
    k.notes.set({ on: true });
    k.emit(S, "assistant_text", { text: "Again." });
    const n = k.notes.add(S, args("Tests pass"), "toolu_NEW");
    expect(n.seq).toBeGreaterThan(refused.seq);
    const own = k.emit(S, "tool_call", { tool: TOOL, id: "toolu_NEW", args: { title: "Tests pass" } });
    expect(k.notes.list()[0]).toMatchObject({ seq: own.seq, call: "toolu_NEW" });
    k.notes.stop();
  });
});

describe("what answers a note", () => {
  test("the user's next message typed, or met by a hook, answers what waits in that session, and only there", () => {
    const k = kit();
    k.emit(S, "assistant_text", { text: "Working." });
    const ask = k.notes.add(S, args("Deploy to staging?", { needsAnswer: true }));
    const fyi = k.notes.add(S, args("Tests pass"));
    const other = k.notes.add(S2, args("Which region?", { needsAnswer: true }));
    const turn = k.emit(S, "user_turn", { text: "<pasted_content id=\"p\">yes, deploy</pasted_content>", source: "typed" });
    const byId = new Map(k.notes.list().map((n) => [n.id, n]));
    expect(byId.get(ask.id)!.answered).toEqual({ at: turn.at, seq: turn.seq, text: "yes, deploy" });
    expect(noteOpen(byId.get(ask.id)!)).toBe(false);
    // a note that waits for nothing is not answered, and another session's still waits
    expect(byId.get(fyi.id)!.answered).toBeUndefined();
    expect(byId.get(other.id)!.answered).toBeUndefined();
    k.emit(S2, "user_turn", { text: "eu-west", source: "hook" });
    expect(k.notes.list().find((n) => n.id === other.id)!.answered?.text).toBe("eu-west");
    k.notes.stop();
  });

  test("never another agent's message, a leader's, the brain's or a script's, nor a slash command or a harness's notice", async () => {
    const k = kit();
    k.emit(S, "assistant_text", { text: "Working." });
    const ask = k.notes.add(S, args("Deploy?", { needsAnswer: true }));
    k.emit(S, "user_turn", { text: "<cophyla-message from=\"web\">deploy it</cophyla-message>", source: "agent" });
    k.emit(S, "user_turn", { text: "from bob's agent", source: "peer" });
    k.emit(S, "user_turn", { text: "/compact", source: "typed" });
    k.emit(S, "user_turn", { text: "<task-notification>job done</task-notification>", source: "typed" });
    // a leader's, the brain's or a script's send through cophylad: a ref no app of the user's told
    k.emit(S, "user_turn", { text: "yes deploy", source: "sent", ref: "ref-script" });
    await sleep(120);
    k.notes.noteSent(S, "ref-script");
    expect(k.notes.list()[0]!.answered).toBeUndefined();
    expect(noteOpen(k.notes.list().find((n) => n.id === ask.id)!)).toBe(true);
    k.notes.stop();
  });

  test("a message sent from one of the user's apps answers it, whether the send is told before its turn is read or after", async () => {
    const k = kit();
    k.emit(S, "assistant_text", { text: "Working." });
    k.notes.add(S, args("Deploy?", { needsAnswer: true }));
    k.notes.add(S2, args("Region?", { needsAnswer: true }));
    // told first: the reply box's send answers before its turn is read
    k.notes.noteSent(S, "ref-app");
    const t1 = k.emit(S, "user_turn", { text: "go ahead", source: "sent", ref: "ref-app" });
    expect(k.notes.list()[0]!.answered).toEqual({ at: t1.at, seq: t1.seq, text: "go ahead" });
    // read first: it waits a moment for the send to be told
    const t2 = k.emit(S2, "user_turn", { text: "eu-west", source: "queued", ref: "ref-phone" });
    expect(k.notes.list()[1]!.answered).toBeUndefined();
    k.notes.noteSent(S2, "ref-phone");
    expect(k.notes.list()[1]!.answered).toEqual({ at: t2.at, seq: t2.seq, text: "eu-west" });
    k.notes.stop();
  });

  test("a message from before the note answers nothing, and an answer taken back waits for the next message", () => {
    const k = kit();
    k.emit(S, "user_turn", { text: "start", source: "typed" });
    const ask = k.notes.add(S, args("Deploy?", { needsAnswer: true }), "toolu_A");
    // the call is written after a message the user typed while the tool ran: it still answers, being after the note was left
    const typed = k.emit(S, "user_turn", { text: "wait, not yet", source: "typed" });
    expect(k.notes.list()[0]!.answered?.seq).toBe(typed.seq);
    k.emit(S, "tool_call", { tool: TOOL, id: "toolu_A", args: { title: "Deploy?" } });
    const reopened = k.notes.mark(ask.id, { answered: false });
    expect(reopened.answered).toBeUndefined();
    expect(noteOpen(reopened)).toBe(true);
    const next = k.emit(S, "user_turn", { text: "now deploy", source: "typed" });
    expect(k.notes.list()[0]!.answered).toMatchObject({ seq: next.seq, text: "now deploy" });
    k.notes.stop();
  });

  test("a long answer is kept in a line, cut", () => {
    const k = kit();
    k.notes.add(S, args("Deploy?", { needsAnswer: true }));
    k.emit(S, "user_turn", { text: "yes\n\n" + "x".repeat(400), source: "typed" });
    const text = k.notes.list()[0]!.answered!.text;
    expect(text.length).toBe(300);
    expect(text.startsWith("yes x")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
    k.notes.stop();
  });
});

describe("keeping and dismissing", () => {
  test("a dismissed note goes from every list, told once more as dismissed; an id already gone is passed over", () => {
    const k = kit();
    const a = k.notes.add(S, args("A"));
    const b = k.notes.add(S, args("B"));
    k.told.length = 0;
    k.notes.dismiss([a.id, a.id, newId("note")]);
    expect(k.notes.list()).toEqual([b]);
    expect(k.told).toEqual([{ ...a, dismissed: true }]);
    expect(k.store.kv.get(NOTES_KV_NS, a.id)).toBeUndefined();
    k.notes.stop();
  });

  test("notes are kept across a restart, and go 14 days after they were left", () => {
    const k = kit();
    const a = k.notes.add(S, args("Old", { needsAnswer: true }));
    k.clock.now += NOTES_KEEP_MS - 1000;
    const b = k.notes.add(S, args("New"));
    k.notes.stop();
    const clock = { now: k.clock.now + 2000 };
    const told: Note[] = [];
    const bus = new Bus();
    bus.on("note.state", (n) => told.push(n));
    const again = new Notes({ store: k.store, bus, log: silentLogger, routes: () => true, now: () => clock.now });
    expect(again.list().map((n) => n.id)).toEqual([a.id, b.id]);
    again.start();
    expect(again.list().map((n) => n.id)).toEqual([b.id]);
    expect(told).toEqual([{ ...a, dismissed: true }]);
    again.stop();
  });

  test("past 500, the oldest finished notes go first, then the oldest", () => {
    const k = kit();
    const first = k.notes.add(S, args("Open 0", { needsAnswer: true }));
    const read = k.notes.add(S, args("Read 1"));
    k.notes.mark(read.id, { read: true });
    for (let i = 2; i < NOTES_MAX; i++) {
      k.clock.now += 1;
      k.notes.add(newId("session"), args(`Note ${i}`));
    }
    expect(k.notes.list()).toHaveLength(NOTES_MAX);
    k.clock.now += 1;
    k.notes.add(newId("session"), args("Over"));
    const ids = new Set(k.notes.list().map((n) => n.id));
    expect(ids.size).toBe(NOTES_MAX);
    expect(ids.has(read.id)).toBe(false);
    expect(ids.has(first.id)).toBe(true);
    k.clock.now += 1;
    k.notes.add(newId("session"), args("Over again"));
    expect(new Set(k.notes.list().map((n) => n.id)).has(first.id)).toBe(false);
    k.notes.stop();
  });

  test("the rows are the primary's own: never the brain's, carried to the backups, never in the cloud backup", () => {
    for (const ns of [NOTES_KV_NS, NOTES_SETTINGS_NS]) {
      expect(RESERVED_KV_NS).toContain(ns);
      expect(EXCLUDED_KV_NS).not.toContain(ns);
      expect(BACKUP_EXCLUDED_KV_NS).toContain(ns);
    }
  });
});

describe("the methods", () => {
  test("list, mark, dismiss and the switch, answered by the primary alone", async () => {
    const k = kit();
    const m = notesMethods({ notes: () => k.notes });
    const ctx = {} as never;
    const n = k.notes.add(S, args("Done"));
    expect(await m["note.list"]!.handler({}, ctx)).toEqual({ notes: [n] });
    expect(((await m["note.mark"]!.handler({ id: n.id, read: true }, ctx)) as { note: Note }).note.read).toBe(k.clock.now);
    expect(m["note.mark"]!.target!({ id: n.id })).toBe(n.id);
    expect(await m["notes.set"]!.handler({ on: false }, ctx)).toEqual({ on: false });
    expect(await m["notes.get"]!.handler({}, ctx)).toEqual({ on: false });
    expect(await m["note.dismiss"]!.handler({ ids: [n.id] }, ctx)).toEqual({});
    expect(k.notes.list()).toEqual([]);
    const none = notesMethods({ notes: () => undefined });
    expect(() => none["note.list"]!.handler({}, ctx)).toThrow("notes are kept by the primary");
    k.notes.stop();
  });

  test("each method has its scope, its risk and its filter: limited access lists its sessions' notes and changes none", () => {
    for (const name of ["note.list", "note.mark", "note.dismiss", "notes.get", "notes.set"] as const) {
      expect(clientRequests[name]).toBeDefined();
      expect(requestScopes[name]).toBe(name === "note.list" || name === "notes.get" ? "sessions:read" : "sessions:write");
      expect(actionDefinition(name)).toBeDefined();
      expect(requestFilters[name].names).toBe(name === "note.list" ? "open" : "global");
    }
    expect(actionDefinition("agent.notify")).toMatchObject({ risk: "write" });
    const keep = (t: { session?: string }) => t.session === S;
    const n = { session: S } as Note;
    const other = { session: S2 } as Note;
    const filter = requestFilters["note.list"] as { result: (r: { notes: Note[] }, keep: (t: { session?: string }) => boolean) => { notes: Note[] } };
    expect(filter.result({ notes: [n, other] }, keep)).toEqual({ notes: [n] });
    expect((notificationFilters["note.state"] as (p: Note) => unknown)(n)).toEqual({ session: S });
    expect(notificationFilters["notes.state"]).toBe("global");
  });
});
