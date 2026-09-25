// The summary and tags the archive writes are the brain's: `annotate` (the brain's capability
// request, called here as the brain link does) stores them whole, and no client hears them,
// in a `*.state`, a list or a chat page; the client protocol has no `annotate`. A session that
// ended before this run is annotated from its row; a bad prefix is `invalid`, an unknown id
// `not_found`. And `session.history` windows around a seq.

import { afterEach, describe, expect, test } from "bun:test";
import type { RpcError, Session, SessionEvent, Thread, Workspace } from "@cophyla/protocol";
import { annotate } from "../src/annotate.ts";
import type { AnnotateInput } from "../src/annotate.ts";
import type { Daemon } from "../src/daemon.ts";
import { ensureDirs, paths } from "../src/config/load.ts";
import { Store } from "../src/store/index.ts";
import { isMethod, sleep, stopDaemon, tempHome, TestClient, testDaemon } from "./helpers.ts";

let d: (Daemon & { home: string }) | undefined;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  if (d) await stopDaemon(d);
  d = undefined;
});

async function connect(daemon: Daemon): Promise<TestClient> {
  const c = await TestClient.connect(daemon.api.url);
  await c.hello(daemon.token, { name: `c${clients.length}` });
  clients.push(c);
  return c;
}

/** What the brain's `annotate` runs, on this daemon's modules. */
const brainAnnotate = (daemon: Daemon, p: AnnotateInput) => annotate({ sessions: daemon.sessions, chat: daemon.chat, workspaces: daemon.workspaces }, p);

const ENDED = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1";

describe("annotate", () => {
  test("a thread: stored whole, told to clients and paged to them without its summary and tags", async () => {
    d = await testDaemon();
    const a = await connect(d);
    const thread = d.chat.startThread({ topic: "the gate tests" });
    await a.next(isMethod("thread.state", (p) => (p as Thread).id === thread.id));
    brainAnnotate(d, { on: thread.id, topic: "the gate", summary: "fixed by mocking the clock", tags: ["gate", "tests"] });
    const n = await a.next(isMethod("thread.state", (p) => (p as Thread).id === thread.id && (p as Thread).topic === "the gate"));
    expect(n.params).not.toHaveProperty("summary");
    expect(n.params).not.toHaveProperty("tags");
    expect(d.store.threads.get(thread.id)).toMatchObject({ topic: "the gate", summary: "fixed by mocking the clock", tags: ["gate", "tests"] });
    const page = await a.request<{ threads: Thread[] }>("chat.load", {});
    expect(page.threads.map((t) => t.id)).toEqual([thread.id]);
    expect(page.threads[0]).toMatchObject({ id: thread.id, topic: "the gate" });
    expect(page.threads[0]).not.toHaveProperty("summary");
    expect(page.threads[0]).not.toHaveProperty("tags");
    // The summary alone again: the row a client would get is the one it has, so nothing is sent.
    const heard = a.notifications.filter(isMethod("thread.state", (p) => (p as Thread).id === thread.id)).length;
    brainAnnotate(d, { on: thread.id, summary: "fixed by a fake clock" });
    await sleep(100);
    expect(a.notifications.filter(isMethod("thread.state", (p) => (p as Thread).id === thread.id))).toHaveLength(heard);
  });

  test("a workspace: stored whole; nothing a client sees moved, so no one is told, and its list row has neither", async () => {
    d = await testDaemon();
    const a = await connect(d);
    // The home is a scope workspace already: the put names it.
    const ws = d.workspaces.put({ node: d.identity.id, path: d.home, name: "work" });
    const named = await a.next(isMethod("workspace.state", (p) => (p as Workspace).id === ws.id && (p as Workspace).name === "work"));
    expect(named.params).not.toHaveProperty("tags");
    const heard = () => a.notifications.filter(isMethod("workspace.state", (p) => (p as Workspace).id === ws.id)).length;
    const before = heard();
    brainAnnotate(d, { on: ws.id, summary: "the day job", tags: ["work"] });
    expect(d.workspaces.get(ws.id)).toMatchObject({ summary: "the day job", tags: ["work"] });
    await sleep(100);
    expect(heard()).toBe(before);
    const list = await a.request<{ workspaces: Workspace[] }>("workspace.list", {});
    const row = list.workspaces.find((w) => w.id === ws.id)!;
    expect(row.name).toBe("work");
    expect(row).not.toHaveProperty("summary");
    expect(row).not.toHaveProperty("tags");
  });

  test("a session that ended before this run is annotated from its row; clients get the row without its summary and tags", async () => {
    const home = tempHome();
    // A previous run's store: one ended session with a few events.
    const p = paths(home);
    ensureDirs(p);
    const s = new Store(p.db);
    s.migrate();
    const ended: Session = {
      id: ENDED,
      node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      harness: "claude",
      profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8",
      native: { id: "old", transport: "pipe" },
      origin: "user",
      cwd: "C:\\work",
      tags: [],
      status: "ended",
      startedAt: 1,
      lastActivity: 2,
      endedAt: 2,
    };
    s.sessions.insert(ended);
    for (let i = 0; i < 6; i++) s.sessionEvents.append({ session: ENDED, at: 1 + i, kind: i % 2 ? "assistant_text" : "user_turn", payload: { text: `turn ${i}` } });
    s.close();
    d = await testDaemon("", { home });
    const a = await connect(d);
    expect(d.sessions.get(ENDED)?.status).toBe("ended");
    brainAnnotate(d, { on: ENDED, summary: "an old one", tags: ["old"] });
    expect(d.store.sessions.get(ENDED)).toMatchObject({ summary: "an old one", tags: ["old"] });
    // Its row was never sent in this run: the first annotate sends it once, without them; the next sends nothing.
    const n = await a.next(isMethod("session.state", (p) => (p as Session).id === ENDED));
    expect(n.params).toMatchObject({ id: ENDED, status: "ended", lastActivity: 2 });
    expect(n.params).not.toHaveProperty("summary");
    expect(n.params).not.toHaveProperty("tags");
    brainAnnotate(d, { on: ENDED, summary: "an old one, again" });
    await sleep(100);
    expect(a.notifications.filter(isMethod("session.state", (p) => (p as Session).id === ENDED))).toHaveLength(1);
    const list = await a.request<{ sessions: Session[] }>("session.list", {});
    for (const row of list.sessions) {
      expect(row).not.toHaveProperty("summary");
      expect(row).not.toHaveProperty("tags");
    }
    // Its history still windows around a seq.
    const around = await a.request<{ events: SessionEvent[] }>("session.history", { id: ENDED, around: 3, limit: 4 });
    expect(around.events.map((e) => e.seq)).toEqual([2, 3, 4, 5]);
    const before = await a.request<{ events: SessionEvent[] }>("session.history", { id: ENDED, before: 3, limit: 2 });
    expect(before.events.map((e) => e.seq)).toEqual([1, 2]);
  });

  test("a client cannot annotate; the brain's request is invalid on a bad prefix and not_found on an unknown id", async () => {
    d = await testDaemon();
    const a = await connect(d);
    const r = await a.call("annotate", { on: "thr_01ARZ3NDEKTSV4RRFFQ69G5FB3", summary: "x" });
    expect("error" in r && (r.error.data as { code: string }).code).toBe("unsupported");
    const code = (params: AnnotateInput) => {
      try {
        brainAnnotate(d!, params);
        return "ok";
      } catch (e) {
        return (e as RpcError).code;
      }
    };
    expect(code({ on: "task_01ARZ3NDEKTSV4RRFFQ69G5FB2", summary: "x" })).toBe("invalid");
    expect(code({ on: "thr_01ARZ3NDEKTSV4RRFFQ69G5FB3", summary: "x" })).toBe("not_found");
    expect(code({ on: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB9", tags: ["x"] })).toBe("not_found");
    expect(code({ on: "ws_01ARZ3NDEKTSV4RRFFQ69G5FB0", summary: "x" })).toBe("not_found");
    const h = await a.call("session.history", { id: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB9", around: -1 });
    expect("error" in h && (h.error.data as { code: string }).code).toBe("invalid");
  });
});
