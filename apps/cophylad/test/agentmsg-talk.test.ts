// Agents' conversations, the log alone: each session's messages numbered as they came, a page
// back at a time, the user's read point that never runs past the end or back, the count every
// client is told and the message only those watching, a copy that settles in both
// conversations, what is kept and what is dropped, and the one import from the audit log.

import { describe, expect, test } from "bun:test";
import type { AuditEntry, TalkMessage, TalkSummary } from "@cophyla/protocol";
import { capTalk, peerParty, TalkLog } from "../src/agentmsg/talk.ts";
import { Bus } from "../src/bus.ts";
import { silentLogger } from "../src/log.ts";
import { Store } from "../src/store/index.ts";

const A = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1";
const B = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB2";
const C = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB3";
const TM = "tm_01ARZ3NDEKTSV4RRFFQ69G5TM1";
const CON = "con_01ARZ3NDEKTSV4RRFFQ69G5CN1";
const DAY = 24 * 60 * 60_000;

function rig(opts: { keep?: number; now?: () => number } = {}) {
  const store = new Store(":memory:");
  store.migrate();
  const bus = new Bus();
  const said: TalkMessage[] = [];
  const states: TalkSummary[] = [];
  bus.on("talk.said", (s) => said.push(s.message));
  bus.on("talk.state", (s) => states.push(s));
  const talk = new TalkLog({ store, bus, log: silentLogger, ...opts });
  return { store, bus, talk, said, states };
}

let seq = 0;
const msg = (over: Partial<Parameters<TalkLog["add"]>[1]> = {}) => ({ id: `pmsg_${String(++seq).padStart(26, "0")}`, dir: "out" as const, with: { session: B, name: "api-codex" }, text: "hi", ...over });

describe("a conversation", () => {
  test("numbers each session's messages as they come, and tells the message and the count", () => {
    const r = rig({ now: () => 5_000 });
    const m1 = r.talk.add(A, msg({ text: "first" }))!;
    const m2 = r.talk.add(A, msg({ text: "second", dir: "in" }))!;
    const other = r.talk.add(B, msg({ text: "elsewhere" }))!;
    expect([m1.n, m2.n, other.n]).toEqual([1, 2, 1]);
    expect(m1).toMatchObject({ session: A, at: 5_000, text: "first" });
    expect(r.said.map((m) => m.text)).toEqual(["first", "second", "elsewhere"]);
    expect(r.states.at(-1)).toEqual({ session: B, n: 1, readTo: 0, unread: 1, lastAt: 5_000 });
    expect(r.talk.list()).toEqual([
      { session: A, n: 2, readTo: 0, unread: 2, lastAt: 5_000 },
      { session: B, n: 1, readTo: 0, unread: 1, lastAt: 5_000 },
    ]);
  });

  test("a message it holds already is left as it is", () => {
    const r = rig();
    const m = msg();
    r.talk.add(A, m);
    expect(r.talk.add(A, m)).toBeUndefined();
    expect(r.talk.summary(A)!.n).toBe(1);
    // the same id is the other end's copy in another conversation
    expect(r.talk.add(B, { ...m, dir: "in" })!.n).toBe(1);
  });

  test("pages back from the latest, oldest first, and says when there are more", () => {
    const r = rig();
    for (let i = 1; i <= 7; i++) r.talk.add(A, msg({ text: `m${i}` }));
    const last = r.talk.page(A, 3);
    expect(last.messages.map((m) => m.n)).toEqual([5, 6, 7]);
    expect(last.more).toBe(true);
    expect(r.talk.page(A, 3, 5).messages.map((m) => m.n)).toEqual([2, 3, 4]);
    const first = r.talk.page(A, 3, 2);
    expect(first).toEqual({ messages: [expect.objectContaining({ n: 1 })], more: false });
    expect(r.talk.page(C, 3)).toEqual({ messages: [], more: false });
  });

  test("the read point never runs past the last message or back, and its count is told", () => {
    const r = rig();
    for (let i = 0; i < 4; i++) r.talk.add(A, msg());
    r.states.length = 0;
    r.talk.read(A, 2);
    expect(r.talk.summary(A)).toMatchObject({ readTo: 2, unread: 2 });
    r.talk.read(A, 1);
    r.talk.read(A, 99);
    expect(r.talk.summary(A)).toMatchObject({ readTo: 4, unread: 0 });
    r.talk.read(A, 99);
    r.talk.read(C, 3);
    expect(r.states.map((s) => s.readTo)).toEqual([2, 4]);
  });

  test("a message's standing settles in every conversation that holds it, a failed one with why", () => {
    const r = rig();
    const m = msg({ status: "pending" });
    r.talk.between({ session: A, name: "web" }, { session: B, name: "api-codex" }, { id: m.id, text: "go", status: "pending" });
    r.said.length = 0;
    r.talk.settle(m.id, "failed", "the user did not allow it");
    expect(r.said.map((s) => [s.session, s.status, s.why])).toEqual([
      [A, "failed", "the user did not allow it"],
      [B, "failed", "the user did not allow it"],
    ]);
    r.talk.settle(m.id, "sent");
    expect(r.talk.page(A, 5).messages[0]).toMatchObject({ dir: "out", status: "sent", with: { name: "api-codex" } });
    expect(r.talk.page(A, 5).messages[0]!.why).toBeUndefined();
    expect(r.talk.page(B, 5).messages[0]).toMatchObject({ dir: "in", status: "sent", with: { name: "web" } });
  });

  test("keeps the last of each session's, cuts a long text, and drops a conversation quiet for a month", () => {
    let now = 10 * DAY;
    const r = rig({ keep: 3, now: () => now });
    for (let i = 1; i <= 5; i++) r.talk.add(A, msg({ text: `m${i}` }));
    expect(r.talk.page(A, 10).messages.map((m) => m.text)).toEqual(["m3", "m4", "m5"]);
    expect(r.talk.summary(A)!.n).toBe(5);
    const long = "x".repeat(20_000);
    expect(r.talk.add(B, msg({ text: long }))!.text).toBe(capTalk(long));
    expect(capTalk(long)).toHaveLength(16_000);
    now += 31 * DAY;
    r.talk.add(C, msg());
    expect(r.talk.prune()).toBe(2);
    expect(r.talk.list().map((s) => s.session)).toEqual([C]);
    expect(r.store.kv.list("talk", `${A}/`)).toEqual([]);
  });

  test("another person's agent is named login/name, with the teammate or connection it came on", () => {
    expect(peerParty("bob/web", { teammate: TM }, "claude")).toEqual({ name: "bob/web", harness: "claude", user: "bob", teammate: TM });
    expect(peerParty("carol/api", { connection: CON })).toEqual({ name: "carol/api", user: "carol", connection: CON });
  });
});

const row = (action: string, over: Partial<AuditEntry>): AuditEntry => ({ id: `aud_${String(++seq).padStart(26, "0")}`, node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV", at: 1_000 + seq, principal: { kind: "system" }, action, args: {}, decision: "allow", outcome: "ok", ...over });

describe("the import from the audit log", () => {
  test("takes each kind of message into the conversations it concerns, read, with the names the messages used", () => {
    const r = rig();
    const rows = [
      row("agent.send", { principal: { kind: "harness", session: A }, target: B, args: { to: "api-codex", text: "rebase", id: "pmsg_1" } }),
      row("agent.send", { principal: { kind: "harness", session: B }, target: A, args: { to: "web", text: "done", id: "pmsg_2", replyTo: "pmsg_1" } }),
      row("agent.lead", { principal: { kind: "harness", session: A }, target: C, args: { to: "docs", text: "write it", id: "pmsg_3" } }),
      row("teammate.send", { principal: { kind: "harness", session: A }, target: TM, args: { to: "bob/web", text: "ping", id: "pmsg_4" } }),
      row("teammate.deliver", { target: A, args: { teammate: TM, from: "bob/web", text: "pong", id: "pmsg_5" } }),
      row("connection.send", { principal: { kind: "harness", session: C }, target: CON, args: { to: "carol/api", user: "carol", text: "up?", id: "pmsg_6" } }),
      row("connection.deliver", { target: C, args: { connection: CON, from: "carol/api", text: "yes", id: "pmsg_7" } }),
      // not a message between agents: the brain's, or one to itself
      row("agent.send", { principal: { kind: "brain" }, target: B, args: { to: "api-codex", text: "x", id: "pmsg_8" } }),
      row("agent.send", { principal: { kind: "harness", session: A }, target: A, args: { to: "web", text: "x", id: "pmsg_9" } }),
    ];
    const n = r.talk.importRows(rows, (id) => (id === B ? { harness: "codex", machine: "Desk", folder: "api" } : undefined));
    // two copies of each between the user's own agents, one of each to or from another person's
    expect(n).toBe(10);
    expect(r.said).toEqual([]);
    const a = r.talk.page(A, 50).messages;
    expect(a.map((m) => [m.dir, m.with.name, m.text, m.lead ?? false])).toEqual([
      ["out", "api-codex", "rebase", false],
      ["in", "api-codex", "done", false],
      ["out", "docs", "write it", true],
      ["out", "bob/web", "ping", false],
      ["in", "bob/web", "pong", false],
    ]);
    expect(a[0]!.with).toEqual({ session: B, name: "api-codex", harness: "codex", machine: "Desk", folder: "api" });
    expect(a[1]).toMatchObject({ replyTo: "pmsg_1", at: rows[1]!.at });
    expect(a[3]!.with).toEqual({ name: "bob/web", user: "bob", teammate: TM });
    expect(r.talk.page(B, 50).messages.map((m) => [m.dir, m.with.name])).toEqual([
      ["in", "web"],
      ["out", "web"],
    ]);
    expect(r.talk.page(C, 50).messages.map((m) => [m.dir, m.with.name, m.lead ?? false])).toEqual([
      ["in", "web", true],
      ["out", "carol/api", false],
      ["in", "carol/api", false],
    ]);
    expect(r.talk.list().every((s) => s.unread === 0)).toBe(true);
  });

  test("runs once, from the rows that ended ok", () => {
    const r = rig();
    r.store.audit.insert(row("agent.send", { principal: { kind: "harness", session: A }, target: B, args: { to: "api-codex", text: "kept", id: "pmsg_a" }, at: Date.now() }));
    r.store.audit.insert(row("agent.send", { principal: { kind: "harness", session: A }, target: B, args: { to: "api-codex", text: "denied", id: "pmsg_b" }, at: Date.now(), outcome: "denied" }));
    expect(r.talk.importOnce(() => undefined)).toBe(2);
    expect(r.talk.page(A, 5).messages.map((m) => m.text)).toEqual(["kept"]);
    expect(r.talk.list().map((s) => s.session)).toEqual([A, B]);
    r.store.audit.insert(row("agent.send", { principal: { kind: "harness", session: A }, target: B, args: { to: "api-codex", text: "later", id: "pmsg_c" }, at: Date.now() }));
    expect(r.talk.importOnce(() => undefined)).toBe(0);
    expect(r.talk.summary(A)!.n).toBe(1);
  });
});
