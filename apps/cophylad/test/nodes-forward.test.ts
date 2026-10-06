// Requests forwarded to the node that owns what they name. The brain's `session.spawn` in a
// workspace on the secondary runs there: the session appears on the primary's client, the
// audit row for the spawn is on the secondary under principal node, and `session.send` and
// `session.history` by id follow the session. A `[gate.rules] "node:session.send" = "ask"`
// on the secondary opens an ask that reaches the primary's client, whose answer settles it.
// A client's forwarded request is gated on the primary as the user and on the owner as the
// node, and a client's `session.stop` tells the owner the user asked. `cancel` propagates. A
// link that drops mid-forward answers `unavailable`.

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Ask, AuditEntry, Session, SessionEvent, Workspace } from "@cophyla/protocol";
import { brainFrames, isMethod, waitFor } from "./helpers.ts";
import type { TestClient } from "./helpers.ts";
import { client, linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
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

/** The brain: on "start" spawns in the named workspace; on "send" sends to the named session; on "history" reads it. */
const script = {
  on: [
    { event: "user.message", match: { text: "start" }, requests: [{ method: "session.spawn", params: { harness: "claude", workspace: "$text[1]", prompt: "say hi" } }, { method: "ui.say", params: { blocks: [{ type: "text", text: "started $last.id" }] } }] },
    { event: "user.message", match: { text: "send" }, requests: [{ method: "session.send", params: { id: "$text[1]", text: "again" } }] },
    { event: "user.message", match: { text: "history" }, requests: [{ method: "session.history", params: { id: "$text[1]", limit: 20 } }] },
    { event: "user.message", match: { text: "read" }, requests: [{ method: "tool.run", params: { name: "fs.read", args: { workspace: "$text[1]", path: "config.toml" } } }] },
  ],
};

describe("forwarding over the node link", () => {
  test("the brain's spawn in a workspace on the secondary runs there, audited there; send and history follow the session", async () => {
    primary = await startPrimary({ brain: { script } });
    secondary = await startSecondary(primary, { agent: true, gateRules: { "node:session.send": "allow", "node:session.spawn": "allow", "node:session.stop": "allow" } });
    await linked(secondary);
    await waitFor(() => primary!.d.brain?.state === "up");
    const c = await client(primary.d);
    clients.push(c);
    // The secondary's workspace is in the primary's merged list.
    const ws = secondary.workspaces.put({ node: secondary.identity.id, path: secondary.home, name: "second" });
    await waitFor(() => primary!.d.nodes.mirror.ownerOfWorkspace(ws.id) === secondary!.identity.id);
    const list = await c.request<{ workspaces: Workspace[] }>("workspace.list");
    expect(list.workspaces.find((w) => w.id === ws.id)?.node).toBe(secondary.identity.id);
    // The brain spawns there.
    await c.request("chat.send", { text: `start ${ws.id}` });
    const state = await c.next(isMethod("session.state", (p) => (p as Session).node === secondary!.identity.id && (p as Session).native.transport === "acp"), 10_000);
    const session = state.params as Session;
    expect(session.workspace).toBe(ws.id);
    // Audited on the secondary under principal node, and on the primary as the brain.
    const onSecondary = secondary.store.audit.list({ limit: 50 }).filter((e: AuditEntry) => e.action === "session.spawn");
    expect(onSecondary.length).toBe(1);
    expect(onSecondary[0]!.principal).toEqual({ kind: "node", id: primary.d.identity.id });
    expect(onSecondary[0]!.outcome).toBe("ok");
    const onPrimary = primary.d.store.audit.list({ limit: 50 }).filter((e: AuditEntry) => e.action === "session.spawn");
    expect(onPrimary.length).toBe(1);
    expect(onPrimary[0]!.principal).toEqual({ kind: "brain" });
    expect(onPrimary[0]!.outcome).toBe("ok");
    expect(primary.d.sessions.get(session.id)).toBeUndefined();
    // The primary's thread names the session.
    await waitFor(() => primary!.d.chat.peek()?.sessions.includes(session.id));
    // The agent's turn ran on the secondary; the primary's client saw its events.
    await c.next(isMethod("session.state", (p) => (p as Session).id === session.id && (p as Session).status === "idle"), 10_000);
    // `session.send` and `session.history` by id go to the owner: from the client and from the brain.
    const sent = await c.request<{ status: string }>("session.send", { id: session.id, text: "again" });
    expect(sent.status).toBe("queued");
    const history = await c.request<{ events: SessionEvent[] }>("session.history", { id: session.id, limit: 50 });
    expect(history.events.some((e) => e.kind === "user_turn")).toBe(true);
    await c.request("chat.send", { text: `history ${session.id}` });
    await waitFor(() => brainFrames(primary!.brainLog!).some((f) => f.dir === "in" && f.frame["result"] !== undefined && Array.isArray((f.frame["result"] as { events?: unknown[] }).events)));
    const sends = secondary.store.audit.list({ limit: 50 }).filter((e: AuditEntry) => e.action === "session.send" || e.action === "session.history");
    expect(sends.every((e) => e.principal.kind === "node")).toBe(true);
    expect(sends.map((e) => e.action).sort()).toEqual(["session.history", "session.history", "session.send"]);
    // The explorer's reads follow the session too: its folder on the secondary, audited there under principal node.
    const listed = await c.request<{ root: string; dirs: { dir: string; entries?: { name: string }[] }[] }>("session.files", { id: session.id });
    expect(listed.root).toBe(secondary.home);
    expect(listed.dirs[0]!.entries!.some((e) => e.name === "config.toml")).toBe(true);
    expect(await c.request<Record<string, unknown>>("session.git", { id: session.id })).toEqual({});
    const file = await c.request<{ path: string; text?: string }>("session.file", { id: session.id, path: "config.toml" });
    expect(file.path).toBe("config.toml");
    expect(file.text).toContain('role = "secondary"');
    const reads = secondary.store.audit.list({ limit: 80 }).filter((e: AuditEntry) => e.action === "session.files" || e.action === "session.git" || e.action === "session.file");
    expect(reads.map((e) => [e.action, e.principal.kind, e.outcome]).sort()).toEqual([
      ["session.file", "node", "ok"],
      ["session.files", "node", "ok"],
      ["session.git", "node", "ok"],
    ]);
    // A tool run in that workspace runs on the secondary, no node named: the file read is the secondary's.
    await c.request("chat.send", { text: `read ${ws.id}` });
    const read = await waitFor(() => brainFrames(primary!.brainLog!).find((f) => f.dir === "in" && f.frame["result"] !== undefined && (f.frame["result"] as { result?: { path?: string } }).result?.path !== undefined), 10_000);
    expect((read.frame["result"] as { result: { path: string } }).result.path).toBe(join(secondary.home, "config.toml"));
    const runs = secondary.store.audit.list({ limit: 50 }).filter((e: AuditEntry) => e.action === "tool.run");
    expect(runs.length).toBe(1);
    expect(runs[0]!.principal).toEqual({ kind: "node", id: primary.d.identity.id });
    expect(primary.d.store.audit.list({ limit: 50 }).filter((e: AuditEntry) => e.action === "tool.run")[0]!.principal).toEqual({ kind: "brain" });
    // The client's `session.stop` ends it on the secondary, which hears that the user asked.
    await c.request("session.stop", { id: session.id });
    await c.next(isMethod("session.state", (p) => (p as Session).id === session.id && (p as Session).status === "ended"), 10_000);
    const stops = secondary.store.audit.list({ limit: 50 }).filter((e: AuditEntry) => e.action === "session.stop");
    expect(stops.map((e) => [e.principal.kind, e.args, e.outcome])).toEqual([["node", { id: session.id, as: "user" }, "ok"]]);
    expect(primary.d.store.audit.list({ limit: 50 }).find((e: AuditEntry) => e.action === "session.stop")?.principal.kind).toBe("user");
  }, 30_000);

  test("an ask on the owner reaches the primary's client, whose answer settles it; a forwarded write is gated on both sides", async () => {
    primary = await startPrimary({ brain: { script } });
    secondary = await startSecondary(primary, { agent: true, gateRules: { "node:session.send": "ask", "node:session.spawn": "allow" } });
    await linked(secondary);
    const c = await client(primary.d);
    clients.push(c);
    const ws = secondary.workspaces.put({ node: secondary.identity.id, path: secondary.home, name: "second" });
    await waitFor(() => primary!.d.nodes.mirror.ownerOfWorkspace(ws.id) === secondary!.identity.id);
    // The brain spawns there: gated on the primary as the brain (allow by rule), on the secondary as the node (allow by rule).
    await c.request("chat.send", { text: `start ${ws.id}` });
    const state = await c.next(isMethod("session.state", (p) => (p as Session).node === secondary!.identity.id && (p as Session).native.transport === "acp"), 10_000);
    const session = state.params as Session;
    // The client's `session.send` is forwarded and held on the secondary's gate: the ask reaches this client.
    const pending = c.request<{ status: string }>("session.send", { id: session.id, text: "again" });
    const askState = await c.next(isMethod("ask.state", (p) => (p as Ask).source.kind === "gate" && (p as Ask).status === "open" && (p as Ask).node === secondary!.identity.id), 10_000);
    const ask = askState.params as Ask;
    expect(ask.source).toMatchObject({ kind: "gate", action: "session.send", principal: { kind: "node", id: primary.d.identity.id } });
    // Answered through the primary: `ask.answer` is forwarded to the owner of the ask.
    await c.request("ask.answer", { id: ask.id, option: "allow" });
    const result = await pending;
    expect(result.status).toBe("queued");
    expect(secondary.asks.get(ask.id)?.status).toBe("answered");
    const answered = await c.next(isMethod("ask.state", (p) => (p as Ask).id === ask.id && (p as Ask).status === "answered"));
    expect(answered).toBeDefined();
    // Both gates have their rows.
    const mine = primary.d.store.audit.list({ limit: 50 }).find((e: AuditEntry) => e.action === "session.send");
    expect(mine?.principal.kind).toBe("user");
    const theirs = secondary.store.audit.list({ limit: 50 }).find((e: AuditEntry) => e.action === "session.send");
    expect(theirs).toMatchObject({ principal: { kind: "node" }, decision: "ask", outcome: "ok" });
  }, 30_000);

  test("cancel propagates to the owner, and a link that drops mid-forward answers unavailable", async () => {
    primary = await startPrimary({ brain: { script } });
    secondary = await startSecondary(primary, { agent: true, gateRules: { "node:session.send": "ask", "node:session.spawn": "allow" } });
    await linked(secondary);
    const c = await client(primary.d);
    clients.push(c);
    const ws = secondary.workspaces.put({ node: secondary.identity.id, path: secondary.home, name: "second" });
    await waitFor(() => primary!.d.nodes.mirror.ownerOfWorkspace(ws.id) === secondary!.identity.id);
    await c.request("chat.send", { text: `start ${ws.id}` });
    const state = await c.next(isMethod("session.state", (p) => (p as Session).node === secondary!.identity.id && (p as Session).native.transport === "acp"), 10_000);
    const session = state.params as Session;
    // A forward held on the secondary's gate, then cancelled from this side: the ask is cancelled there.
    const held = primary.d.nodes.forwardHost.forward(secondary.identity.id, "session.send", { id: session.id, text: "x" }, { signal: AbortSignal.timeout(500) }).catch((e: unknown) => e);
    const askState = await c.next(isMethod("ask.state", (p) => (p as Ask).source.kind === "gate" && (p as Ask).status === "open"), 10_000);
    const outcome = await held;
    expect((outcome as { code?: string }).code).toBe("cancelled");
    await waitFor(() => secondary!.asks.get((askState.params as Ask).id)?.status === "cancelled");
    // A forward in flight when the link drops: unavailable, not a hang.
    const inflight = primary.d.nodes.forwardHost.forward(secondary.identity.id, "session.send", { id: session.id, text: "y" }, {}).catch((e: unknown) => e);
    await c.next(isMethod("ask.state", (p) => (p as Ask).source.kind === "gate" && (p as Ask).status === "open" && (p as Ask).id !== (askState.params as Ask).id), 10_000);
    await secondary.stop();
    const dropped = await inflight;
    expect((dropped as { code?: string }).code).toBe("unavailable");
    // And a forward to a node that is gone fails at once.
    const gone = await c.call("session.send", { id: session.id, text: "z" });
    expect("error" in gone && gone.error.data?.code).toBe("not_found");
  }, 30_000);

  test("a profile on the secondary is set from the primary's app, gated there as the node; its limits come by node or merged", async () => {
    primary = await startPrimary({});
    secondary = await startSecondary(primary, { gateRules: { "node:profile.update": "allow" } });
    await linked(secondary);
    const c = await client(primary.d);
    clients.push(c);
    const node = secondary.identity.id;
    // the primary forwards only over a link open on its own side, which the secondary's side being linked does not say
    await waitFor(() => primary!.d.nodes.linkedTo(node));
    const theirs = secondary.profiles.byHarness("claude")[0]!;
    const { profile } = await c.request<{ profile: { id: string; defaultBy?: string; launch?: { source: string; args: string[] } } }>("profile.update", { node, id: theirs.id, patch: { usual: true, launch: { args: ["--effort", "low"] } } });
    expect(profile).toMatchObject({ id: theirs.id, defaultBy: "you", launch: { source: "you", args: ["--effort", "low"] } });
    // Set on the secondary, in its own store, and audited there under principal node.
    expect(secondary.profiles.launch(theirs.id)).toEqual({ args: ["--effort", "low"], source: "you" });
    expect(secondary.store.audit.list({ limit: 50 }).find((e: AuditEntry) => e.action === "profile.update")?.principal).toEqual({ kind: "node", id: primary.d.identity.id });
    // A profile id the primary does not have is refused where it is looked up.
    const missing = await c.call("profile.update", { node: primary.d.identity.id, id: theirs.id, patch: { usual: true } });
    expect("error" in missing && missing.error.data?.code).toBe("not_found");
    expect(await c.request<{ limits: object }>("profile.limits", { node })).toEqual({ limits: {} });
    expect(await c.request<{ limits: object }>("profile.limits", {})).toEqual({ limits: {} });
  }, 30_000);
});
