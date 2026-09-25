// The node link between two daemons on one machine: a grant nobody minted, or one sealed
// with the wrong key, is refused with no audit row; an invited node's enrollment and join are
// audited under principal node (the key kept out of the row), raise `node.joined` in the fake
// brain's feed, merge `node.list` on both sides and reach the primary's client as
// `node.state`; a client that connects later hears the secondary's sessions; the link closing
// ends them and raises `node.left`; the secondary restarts and rejoins with its grant. A
// client of the primary hears a secondary's session events only while it watches that
// session. A session on the secondary reaches the brain once per event, announced by its own
// node's stream.

import { afterEach, describe, expect, test } from "bun:test";
import { newId, PROTOCOL_VERSION } from "@cophyla/protocol";
import type { AuditEntry, Node, Session, SessionEvent } from "@cophyla/protocol";
import type { Daemon } from "../src/daemon.ts";
import { readLinkFile } from "../src/grants/link-file.ts";
import { brainFrames, isMethod, waitFor } from "./helpers.ts";
import type { TestClient } from "./helpers.ts";
import { client, grantFor, linked, sealedLink, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

let primary: Primary | undefined;
let secondary: Started | undefined;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  await stopAll(secondary, primary?.d);
  primary = undefined;
  secondary = undefined;
});

const nodeRows = (d: Daemon) => d.store.audit.list({ limit: 100 }).filter((e: AuditEntry) => e.principal.kind === "node");

describe("node link", () => {
  test("a grant nobody minted, or the wrong key, is refused without an audit row; an invited node joins and both sides see each other", async () => {
    primary = await startPrimary({ brain: { script: { on: [] } } });
    const c = await client(primary.d);
    clients.push(c);
    await waitFor(() => primary!.d.brain?.state === "up");
    // A grant nobody minted is refused at the sealed hello, before a byte is sealed.
    const unknown = await sealedLink(primary, { grant: newId("grant"), key: "ab".repeat(32) }).then(
      () => "sealed",
      (e: unknown) => String(e),
    );
    expect(unknown).toMatch(/cannot link here/);
    // A real grant with the wrong key: the first record does not open, and the link closes.
    const held = grantFor(primary.d, newId("node"));
    const wrongKey = await sealedLink(primary, { grant: held.grant, key: "ab".repeat(32) });
    const hello = await wrongKey.rpc.request("node.hello", { protocolVersion: PROTOCOL_VERSION, platformVersion: "0.0.0", nodeId: newId("node"), cluster: primary.d.nodes.member()!.cluster }, { timeoutMs: 3000 }).then(
      () => "answered",
      (e: unknown) => String(e),
    );
    expect(hello).not.toBe("answered");
    wrongKey.close();
    expect(nodeRows(primary.d)).toEqual([]);

    secondary = await startSecondary(primary);
    await linked(secondary);
    // The audit rows on the primary: the invite redeemed, its key kept out of the row, then `hello`, both under principal node and allowed by structure.
    const rows = nodeRows(primary.d).sort((a, b) => a.at - b.at);
    expect(rows.map((r) => r.action)).toEqual(["node.enroll", "hello"]);
    expect(rows[0]).toMatchObject({ principal: { kind: "node", id: secondary.identity.id }, decision: "allow", outcome: "ok" });
    expect(JSON.stringify(rows[0])).toContain("[redacted]");
    expect(JSON.stringify(rows[0])).not.toContain(readLinkFile(secondary.paths.linkFile)!.key);
    expect(rows[1]).toMatchObject({ action: "hello", principal: { kind: "node", id: secondary.identity.id }, decision: "allow", outcome: "ok" });
    // The brain heard `node.joined`.
    const joined = await waitFor(() => brainFrames(primary!.brainLog!).find((f) => f.dir === "in" && f.frame["method"] === "node.joined"));
    expect((joined.frame["params"] as { node: Node }).node.id).toBe(secondary.identity.id);
    // `node.list` merges on both sides, this node first.
    const onPrimary = await c.request<{ nodes: Node[] }>("node.list");
    expect(onPrimary.nodes.map((n) => n.id)).toEqual([primary.d.identity.id, secondary.identity.id]);
    expect(onPrimary.nodes[1]).toMatchObject({ role: "secondary", status: "online", capabilities: { brain: false } });
    expect(onPrimary.nodes[0]).toMatchObject({ role: "primary", status: "online", capabilities: { brain: true } });
    expect(secondary.nodes.registry.list().map((n) => n.id)).toEqual([secondary.identity.id, primary.d.identity.id]);
    expect(secondary.nodes.registry.get(primary.d.identity.id)).toMatchObject({ role: "primary", endpoints: expect.arrayContaining([primary.endpoint]) });
    // The primary's client heard the secondary's row.
    const state = await c.next(isMethod("node.state", (p) => (p as Node).id === secondary!.identity.id));
    expect((state.params as Node).status).toBe("online");
  }, 20_000);

  test("a late client hears the secondary's sessions; the link closing ends them and raises node.left; the secondary rejoins", async () => {
    primary = await startPrimary({ brain: { script: { on: [] } } });
    secondary = await startSecondary(primary, { agent: true });
    await linked(secondary);
    // A session on the secondary: spawned there directly, so the primary learns of it upward.
    const ws = secondary.workspaces.put({ node: secondary.identity.id, path: secondary.home, name: "second" });
    const spawned = await secondary.sessions.spawn({ harness: "claude", workspace: ws.id, prompt: "hello" }, { profiles: secondary.profiles });
    await waitFor(() => primary!.d.nodes.mirrorSession(spawned.id) !== undefined);
    const c = await client(primary.d);
    clients.push(c);
    const initial = await c.next(isMethod("session.state", (p) => (p as Session).id === spawned.id));
    expect((initial.params as Session).node).toBe(secondary.identity.id);
    await c.next(isMethod("workspace.state", (p) => (p as { id: string }).id === ws.id));
    const merged = await c.request<{ sessions: Session[] }>("session.list");
    expect(merged.sessions.map((s) => s.id)).toContain(spawned.id);
    // The link goes: the mirrored session is announced ended, the node offline, and the brain hears `node.left`.
    await secondary.stop();
    const ended = await c.next(isMethod("session.state", (p) => (p as Session).id === spawned.id && (p as Session).status === "ended"));
    expect(ended).toBeDefined();
    const offline = await c.next(isMethod("node.state", (p) => (p as Node).id === secondary!.identity.id && (p as Node).status === "offline"));
    expect(offline).toBeDefined();
    await waitFor(() => brainFrames(primary!.brainLog!).some((f) => f.dir === "in" && f.frame["method"] === "node.left"));
    expect((await c.request<{ sessions: Session[] }>("session.list")).sessions.map((s) => s.id)).not.toContain(spawned.id);
    // Back: the same home rejoins with the same node id.
    const home = secondary.home;
    const { startDaemon } = await import("../src/daemon.ts");
    const { silentLogger } = await import("../src/log.ts");
    secondary = Object.assign(await startDaemon({ home, port: 0, log: silentLogger, brain: false, embedder: null }), { home });
    await linked(secondary);
    const online = await c.next(isMethod("node.state", (p) => (p as Node).id === secondary!.identity.id && (p as Node).status === "online" && (p as Node).lastSeen > (offline.params as Node).lastSeen));
    expect(online).toBeDefined();
    expect(nodeRows(primary.d).filter((e) => e.action === "hello").length).toBe(2);
  }, 30_000);

  test("a client of the primary hears a secondary's session events only while it watches that session", async () => {
    primary = await startPrimary({ brain: { script: { on: [] } } });
    secondary = await startSecondary(primary);
    await linked(secondary);
    const ws = secondary.workspaces.put({ node: secondary.identity.id, path: secondary.home, name: "second" });
    const row: Session = { id: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1", node: secondary.identity.id, harness: "claude", profile: "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8", native: { id: "n", transport: "pipe" }, origin: "user", workspace: ws.id, cwd: secondary.home, tags: [], status: "busy", startedAt: 1, lastActivity: 2 };
    secondary.bus.emit("session.state", row);
    await waitFor(() => primary!.d.nodes.mirrorSession(row.id) !== undefined);
    const tab = await client(primary.d, "tab");
    const idle = await client(primary.d, "idle");
    clients.push(tab, idle);
    await tab.request("session.watch", { ids: [row.id] });
    const event = (seq: number) => secondary!.bus.emit("session.event", { session: row.id, seq, at: 10 + seq, kind: "tool_call", payload: { name: "Read" } });
    const heard = (c: TestClient) => c.notifications.filter(isMethod("session.event")).map((n) => (n.params as SessionEvent).seq);
    event(1);
    await waitFor(() => heard(tab).length === 1);
    // Only its counters moved: the watcher hears the row, the other client does not.
    const rows = (c: TestClient) => c.notifications.filter(isMethod("session.state", (p) => (p as Session).id === row.id)).length;
    const idleRows = rows(idle);
    secondary.bus.emit("session.state", { ...row, lastActivity: 11 });
    await waitFor(() => tab.notifications.some(isMethod("session.state", (p) => (p as Session).id === row.id && (p as Session).lastActivity === 11)));
    // What it is doing changed: everyone hears it.
    secondary.bus.emit("session.state", { ...row, lastActivity: 12, status: "idle" });
    await waitFor(() => rows(idle) === idleRows + 1);
    await tab.request("session.watch", { ids: [] });
    event(2);
    await Bun.sleep(200);
    expect(heard(tab)).toEqual([1]);
    expect(heard(idle)).toEqual([]);
  }, 30_000);

  test("the listener going away drops the link on both sides; a plain secondary goes back to seeking", async () => {
    primary = await startPrimary();
    secondary = await startSecondary(primary, { heartbeatMs: 150 });
    await linked(secondary);
    expect(primary.d.nodes.linkedNodes()).toEqual([secondary.identity.id]);
    await primary.d.controller!.stop();
    await waitFor(() => !secondary!.nodes.linked(), 5000);
    expect(secondary.nodes.state()).toBe("seeking");
    await waitFor(() => primary!.d.nodes.linkedNodes().length === 0, 5000);
    expect(secondary.nodes.registry.get(primary.d.identity.id)?.status).toBe("offline");
  }, 20_000);

  test("a third node joining leaves every row its own: the registry echoed back from a secondary changes nothing", async () => {
    primary = await startPrimary();
    const backup = await startSecondary(primary, { backup: true });
    await linked(backup);
    secondary = await startSecondary(primary);
    await linked(secondary);
    // The primary told the backup about the plain secondary, and the backup announced the rows it was given; none of that is the backup's own state.
    await new Promise((r) => setTimeout(r, 300));
    const rows = primary.d.nodes.registry.list();
    expect(rows[0]!.id).toBe(primary.d.identity.id);
    expect(rows.map((r) => r.id).sort()).toEqual([primary.d.identity.id, backup.identity.id, secondary.identity.id].sort());
    expect(rows[0]!.backup).toBeUndefined();
    const b = rows.find((r) => r.id === backup.identity.id)!;
    const s = rows.find((r) => r.id === secondary!.identity.id)!;
    expect(b.backup).toBe(true);
    expect(s.backup).toBeUndefined();
    expect(b.endpoints).not.toEqual(s.endpoints);
    expect(primary.d.store.nodes.list().map((r) => r.id).sort()).toEqual([backup.identity.id, secondary.identity.id].sort());
    // The rows the secondaries hold are the primary's, not each other's.
    expect(secondary.nodes.registry.get(backup.identity.id)?.backup).toBe(true);
    expect(backup.nodes.registry.get(secondary.identity.id)?.backup).toBeUndefined();
    await backup.stop();
  }, 30_000);

  test("a session on the secondary reaches the brain once per event: its own stream announces it, the primary's does not", async () => {
    primary = await startPrimary({ brain: { script: { on: [] } } });
    secondary = await startSecondary(primary, { agent: true });
    await linked(secondary);
    await waitFor(() => primary!.d.brain?.state === "up");
    const c = await client(primary.d);
    clients.push(c);
    const ws = secondary.workspaces.put({ node: secondary.identity.id, path: secondary.home, name: "second" });
    const session = await secondary.sessions.spawn({ harness: "claude", workspace: ws.id, prompt: "say hi" }, { profiles: secondary.profiles });
    await c.next(isMethod("session.state", (p) => (p as Session).id === session.id && (p as Session).status === "idle"), 10_000);
    await secondary.sessions.stopSession(session.id);
    await c.next(isMethod("session.state", (p) => (p as Session).id === session.id && (p as Session).status === "ended"), 10_000);
    await waitFor(() => brainFrames(primary!.brainLog!).some((f) => f.dir === "in" && f.frame["method"] === "session.ended"));
    const frames = brainFrames(primary.brainLog!).filter((f) => f.dir === "in" && typeof f.frame["method"] === "string" && String(f.frame["method"]).startsWith("session."));
    const kinds = frames.map((f) => {
      const p = f.frame["params"] as { session?: { status?: string }; event?: { kind: string } };
      return `${f.frame["method"]}:${p.session?.status}${p.event ? `:${p.event.kind}` : ""}`;
    });
    expect(kinds.filter((k) => k.startsWith("session.discovered"))).toEqual(["session.discovered:idle"]);
    expect(kinds.filter((k) => k.startsWith("session.ended"))).toEqual(["session.ended:ended"]);
    // Every updated is one stored event of the session, none of them twice.
    const updated = frames.filter((f) => f.frame["method"] === "session.updated").map((f) => JSON.stringify({ ...(f.frame["params"] as object), eventId: undefined }));
    expect(new Set(updated).size).toBe(updated.length);
    expect(frames.every((f) => ((f.frame["params"] as { session: Session }).session.node === secondary!.identity.id))).toBe(true);
  }, 30_000);
});
