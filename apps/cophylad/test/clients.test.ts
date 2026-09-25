// The client registry's session traffic, over fake sockets: an event reaches the clients
// watching its session and no other; a row reaches everyone when the session starts, ends
// or changes what it is doing, and its watchers alone when only its counters moved; a
// watch list replaces the one before; scopes and relayed sockets hold as for any broadcast;
// a workspace row that moved only its activity reaches no one.

import { describe, expect, test } from "bun:test";
import { FULL, SESSIONS } from "@cophyla/protocol";
import type { Access, Client, MetricsSample, Scope, Session, SessionEvent } from "@cophyla/protocol";
import { ClientRegistry } from "../src/api/clients.ts";
import type { ListenerKind } from "../src/api/clients.ts";

const SESSION = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1";
const OTHER = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB2";

function connect(registry: ClientRegistry, id: string, opts: { scopes?: Scope[]; listener?: ListenerKind } = {}): { method: string; params: unknown }[] {
  const heard: { method: string; params: unknown }[] = [];
  const client: Client = { id, kind: "ui", scopes: opts.scopes ?? ["sessions:read"], via: "direct", audio: { in: false, out: false }, connectedAt: 1 };
  registry.add(client, { send: (data) => heard.push(JSON.parse(data) as { method: string; params: unknown }), close: () => {} }, opts.listener ?? "loopback");
  return heard;
}

const session = (patch: Partial<Session> = {}): Session => ({
  id: SESSION,
  node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  harness: "claude",
  profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8",
  native: { id: "n", transport: "pipe" },
  origin: "user",
  cwd: "/w",
  tags: [],
  status: "busy",
  startedAt: 1,
  lastActivity: 2,
  ...patch,
});

const event = (s: string, seq: number): SessionEvent => ({ session: s, seq, at: seq, kind: "tool_call", payload: { name: "Read" } });

describe("client registry: a session's traffic goes to who looks at it", () => {
  test("an event reaches the clients watching its session, and a watch list replaces the one before", () => {
    const registry = new ClientRegistry();
    const tab = connect(registry, "cli_tab");
    const idle = connect(registry, "cli_idle");
    const unscoped = connect(registry, "cli_unscoped", { scopes: ["chat"] });
    const relayed = connect(registry, "cli_relayed", { listener: "relayed" });
    registry.watch("cli_tab", [SESSION]);
    registry.watch("cli_unscoped", [SESSION]);
    registry.watch("cli_relayed", [SESSION]);
    registry.broadcastEvent(event(SESSION, 1));
    registry.broadcastEvent(event(OTHER, 2));
    expect(tab.map((n) => (n.params as SessionEvent).seq)).toEqual([1]);
    expect(idle).toHaveLength(0);
    expect(unscoped).toHaveLength(0);
    expect(relayed).toHaveLength(0);
    registry.watch("cli_tab", [OTHER]);
    registry.broadcastEvent(event(SESSION, 3));
    registry.broadcastEvent(event(OTHER, 4));
    expect(tab.map((n) => (n.params as SessionEvent).seq)).toEqual([1, 4]);
    registry.watch("cli_tab", []);
    registry.broadcastEvent(event(OTHER, 5));
    expect(tab).toHaveLength(2);
    // A client that is gone is no one's concern.
    registry.watch("cli_gone", [SESSION]);
  });

  test("a row reaches everyone when what the session is doing changed, and its watchers alone when only its counters moved", () => {
    const registry = new ClientRegistry();
    const tab = connect(registry, "cli_tab");
    const idle = connect(registry, "cli_idle");
    registry.watch("cli_tab", [SESSION]);
    const rows = (heard: { method: string; params: unknown }[]) => heard.filter((n) => n.method === "session.state").map((n) => n.params as Session);
    registry.broadcastSession(session());
    // Only the counters: the watcher alone.
    registry.broadcastSession(session({ lastActivity: 3 }));
    registry.broadcastSession(session({ lastActivity: 4, stats: { turns: 1, cost: 0.1, tokens: { in: 5, out: 1 } } }));
    expect(rows(tab)).toHaveLength(3);
    expect(rows(idle)).toHaveLength(1);
    // What it is doing: everyone, with the counters as they are.
    registry.broadcastSession(session({ lastActivity: 5, status: "idle" }));
    registry.broadcastSession(session({ lastActivity: 6, status: "idle", title: "a title" }));
    expect(rows(idle).map((s) => [s.status, s.lastActivity])).toEqual([
      ["busy", 2],
      ["idle", 5],
      ["idle", 6],
    ]);
    // The archive's summary and tags are the brain's: a row never carries them, and a change to them alone is a counter's.
    const heard = rows(idle).length;
    registry.broadcastSession(session({ lastActivity: 6, status: "idle", title: "a title", summary: "what it did", tags: ["x"] }));
    expect(rows(idle)).toHaveLength(heard);
    for (const row of [...rows(tab), ...rows(idle)]) {
      expect(Object.keys(row)).not.toContain("summary");
      expect(Object.keys(row)).not.toContain("tags");
    }
    // Its end reaches everyone; an ended session is forgotten, so an end told twice reaches everyone twice.
    registry.broadcastSession(session({ lastActivity: 7, status: "ended", endedAt: 7 }));
    registry.broadcastSession(session({ lastActivity: 8, status: "ended", endedAt: 7 }));
    expect(rows(idle).filter((s) => s.status === "ended")).toHaveLength(2);
    // The archive writing on the ended session sends nothing: the row a client would get is the one it has.
    const tabHeard = rows(tab).length;
    registry.broadcastSession(session({ lastActivity: 8, status: "ended", endedAt: 7, summary: "what it did", tags: ["x"] }));
    expect(rows(tab)).toHaveLength(tabHeard);
    // Another session's counters reach no one who does not watch it.
    registry.broadcastSession(session({ id: OTHER }));
    registry.broadcastSession(session({ id: OTHER, lastActivity: 9 }));
    expect(rows(tab).filter((s) => s.id === OTHER)).toHaveLength(1);
  });

  test("a workspace row reaches everyone when it is new or changed, and no one when only its activity or what a client never sees moved", () => {
    const registry = new ClientRegistry();
    const a = connect(registry, "cli_a");
    const workspace = { id: "wsp_01ARZ3NDEKTSV4RRFFQ69G5FB3", node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV", path: "/w", name: "w", origin: "user" as const, tags: [], lastActivity: 1 };
    registry.broadcastWorkspace(workspace);
    registry.broadcastWorkspace({ ...workspace, lastActivity: 2 });
    registry.broadcastWorkspace({ ...workspace, lastActivity: 3 });
    registry.broadcastWorkspace({ ...workspace, lastActivity: 4, name: "renamed" });
    registry.broadcastWorkspace({ ...workspace, lastActivity: 5, name: "renamed", summary: "what it is", tags: ["w"] });
    expect(a.map((n) => (n.params as { name: string; lastActivity: number }).lastActivity)).toEqual([1, 4]);
    for (const n of a) expect(Object.keys(n.params as object)).not.toContain("tags");
  });

  test("a thread row reaches every client with chat when it is new or changed, and no one when only its summary and tags moved", () => {
    const registry = new ClientRegistry();
    const a = connect(registry, "cli_a", { scopes: ["chat"] });
    const thread = { id: "thr_01ARZ3NDEKTSV4RRFFQ69G5FB3", startedAt: 1, tags: [], sessions: [] };
    registry.broadcastThread(thread);
    registry.broadcastThread({ ...thread, topic: "the gate" });
    registry.broadcastThread({ ...thread, topic: "the gate", endedAt: 2 });
    registry.broadcastThread({ ...thread, topic: "the gate", endedAt: 2, summary: "fixed", tags: ["gate"] });
    const told = a.filter((n) => n.method === "thread.state").map((n) => n.params as { topic?: string; endedAt?: number });
    expect(told.map((t) => [t.topic ?? null, t.endedAt ?? null])).toEqual([
      [null, null],
      ["the gate", null],
      ["the gate", 2],
    ]);
    for (const t of told) {
      expect(Object.keys(t)).not.toContain("summary");
      expect(Object.keys(t)).not.toContain("tags");
    }
  });
});

describe("client registry: the desktop app", () => {
  test("is the shell's ui client named desktop on the loopback listener, and no other", () => {
    const registry = new ClientRegistry();
    const add = (id: string, kind: "ui" | "controller", name: string, listener: ListenerKind) =>
      registry.add({ id, kind, name, scopes: [], via: "direct", audio: { in: false, out: false }, connectedAt: 1 }, { send: () => {}, close: () => {} }, listener);
    add("cli_talk", "ui", "talk", "loopback");
    add("cli_phone", "controller", "desktop", "cloud");
    add("cli_relayed", "ui", "desktop", "relay");
    expect(registry.desktopAttached()).toBe(false);
    add("cli_shell", "ui", "desktop", "loopback");
    expect(registry.desktopAttached()).toBe(true);
    registry.remove("cli_shell");
    expect(registry.desktopAttached()).toBe(false);
  });
});

describe("client registry: a limited client hears what its access reaches", () => {
  const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const WS = "ws_01ARZ3NDEKTSV4RRFFQ69G5FB3";
  function limited(registry: ClientRegistry, id: string, access: Access): { method: string; params: unknown }[] {
    const heard: { method: string; params: unknown }[] = [];
    const client: Client = { id, kind: "controller", scopes: access.scopes, access, via: "direct", audio: { in: false, out: false }, connectedAt: 1 };
    registry.add(client, { send: (data) => heard.push(JSON.parse(data) as { method: string; params: unknown }), close: () => {} }, "controller");
    return heard;
  }

  test("rows out of reach are not sent; a sample's other sessions are summed away; a full client hears everything", () => {
    const registry = new ClientRegistry();
    registry.look = {
      self: NODE,
      session: (id) => (id === SESSION ? { node: NODE, workspace: WS, path: "/w" } : id === OTHER ? { node: NODE, path: "/elsewhere" } : undefined),
      ask: () => undefined,
      workspace: (id) => (id === WS ? { node: NODE, path: "/w" } : undefined),
    };
    const phone = limited(registry, "cli_01ARZ3NDEKTSV4RRFFQ69G5FC1", { ...SESSIONS, workspaces: [WS] });
    const desk = connect(registry, "cli_01ARZ3NDEKTSV4RRFFQ69G5FC2", { scopes: [...FULL.scopes] });
    registry.broadcastSession(session({ workspace: WS }));
    registry.broadcastSession(session({ id: OTHER, cwd: "/elsewhere" }));
    registry.broadcast("chat.retract", { message: "msg_01ARZ3NDEKTSV4RRFFQ69G5FB4" });
    expect(phone.map((h) => (h.params as { id?: string }).id ?? h.method)).toEqual([SESSION]);
    expect(desk.map((h) => h.method)).toEqual(["session.state", "session.state", "chat.retract"]);
    const sample: MetricsSample = {
      node: NODE,
      at: 1,
      cpu: 0.4,
      memory: { used: 1, total: 2 },
      processes: [
        { pid: 1, parent: 0, name: "claude", cpu: 0.1, memory: 1, owner: { kind: "session", session: SESSION } },
        { pid: 2, parent: 0, name: "claude", cpu: 0.2, memory: 2, owner: { kind: "session", session: OTHER } },
      ],
      llm: {},
    };
    expect(registry.send("cli_01ARZ3NDEKTSV4RRFFQ69G5FC1", "metrics.sample", sample)).toBe(true);
    const got = phone.at(-1)!.params as MetricsSample;
    expect(got.processes.map((p) => p.pid)).toEqual([1, 0]);
    expect(registry.send("cli_01ARZ3NDEKTSV4RRFFQ69G5FC2", "metrics.sample", sample)).toBe(true);
    expect((desk.at(-1)!.params as MetricsSample).processes).toHaveLength(2);
    // A notification about something out of reach is not sent, and `send` says so.
    expect(registry.send("cli_01ARZ3NDEKTSV4RRFFQ69G5FC1", "remote.state", { node: NODE, host: { kind: "none", status: "off" }, viewers: [], streaming: false })).toBe(false);
  });
});
