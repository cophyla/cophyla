// What a linked node can make the primary believe. A node that holds a grant still sends
// only its own rows: one forged row per upward kind (a row naming another node,
// or claiming a session, ask or workspace the primary holds itself, a session event of a
// session it does not own) is dropped, and a node's own row cannot move its role, backup
// rank, epoch or endpoints. The join's lists pass the same test. What the primary holds
// itself is routed here whatever a mirror says. A datagram is believed in no role state
// until a probe of the endpoint it names completes a handshake sealed with this node's grant.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { newId } from "@cophyla/protocol";
import { writeLinkFile } from "../src/grants/link-file.ts";
import type { Ask, AuditEntry, Session, SessionEvent, Workspace } from "@cophyla/protocol";
import { MemoryLan } from "../src/nodes/discovery.ts";
import { routeOf } from "../src/nodes/forward.ts";
import type { Datagram, DiscoverySocket } from "../src/nodes/discovery.ts";
import { tempHome, waitFor } from "./helpers.ts";
import { linked, rogueLink, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Rogue, Started } from "./nodes-helpers.ts";

let primaries: Primary[] = [];
const started: Started[] = [];
const rogues: Rogue[] = [];
const sockets: DiscoverySocket[] = [];

afterEach(async () => {
  for (const r of rogues) r.close();
  rogues.length = 0;
  for (const s of sockets) s.close();
  sockets.length = 0;
  await stopAll(...started, ...primaries.map((p) => p.d));
  started.length = 0;
  primaries = [];
});

const now = () => Date.now();

function session(node: string, over: Partial<Session> = {}): Session {
  return { id: newId("session"), node, harness: "claude", profile: newId("profile"), native: { id: "native", transport: "acp" }, origin: "user", cwd: "/x", tags: [], status: "idle", startedAt: now(), lastActivity: now(), ...over };
}

function ask(node: string, over: Partial<Ask> = {}): Ask {
  return { id: newId("ask"), node, type: "permission", source: { kind: "brain" }, title: "forged", options: [{ id: "a", label: "A" }], answerableBy: ["user"], status: "open", createdAt: now(), ...over };
}

function workspace(node: string, over: Partial<Workspace> = {}): Workspace {
  return { id: newId("workspace"), node, path: "/forged", name: "forged", origin: "user", tags: [], lastActivity: now(), ...over };
}

/** A primary with a session, an ask and a workspace of its own, and everything it announces recorded. */
async function primaryWithRows() {
  const primary = await startPrimary();
  primaries.push(primary);
  const d = primary.d;
  const ws = d.workspaces.put({ node: d.identity.id, path: primary.scratch, name: "local" });
  const local = await d.sessions.spawn({ harness: "claude", workspace: ws.id, prompt: "hello" }, { profiles: d.profiles });
  const localAsk = d.asks.open({ type: "permission", source: { kind: "brain" }, title: "local", options: [{ id: "a", label: "A" }], answerableBy: ["user"] });
  const heard: { method: string; params: unknown }[] = [];
  for (const name of ["session.state", "session.event", "ask.state", "workspace.state", "audit.entry", "update.state", "remote.state"] as const) {
    d.bus.on(name, (params: unknown) => void heard.push({ method: name, params }));
  }
  const events: { name: string; params: unknown }[] = [];
  d.events.on((e) => void events.push({ name: e.name, params: e.params }));
  return { primary, d, ws, local, localAsk, heard, events };
}

describe("upward rows are the sender's own", () => {
  test("one forged row per kind is dropped; the sender's own row passes; a node's row keeps what its join settled", async () => {
    const { primary, d, ws, local, localAsk, heard, events } = await primaryWithRows();
    const rogue = await rogueLink(primary);
    rogues.push(rogue);
    await waitFor(() => d.nodes.linkedTo(rogue.id));
    const other = newId("node");
    const forged: { method: string; params: unknown; id?: string }[] = [
      { method: "session.state", params: session(other), id: "other-node session" },
      { method: "session.state", params: session(rogue.id, { id: local.id }), id: "local session" },
      { method: "session.event", params: { session: local.id, seq: 999, at: now(), kind: "assistant_text", payload: { text: "forged" } } satisfies SessionEvent },
      { method: "session.event", params: { session: newId("session"), seq: 1, at: now(), kind: "assistant_text", payload: { text: "forged" } } satisfies SessionEvent },
      { method: "ask.state", params: ask(other) },
      { method: "ask.state", params: ask(rogue.id, { id: localAsk.id, title: "hijacked" }) },
      { method: "workspace.state", params: workspace(other) },
      { method: "workspace.state", params: workspace(rogue.id, { id: ws.id, path: "/hijacked" }) },
      { method: "audit.entry", params: { id: newId("audit"), node: other, at: now(), principal: { kind: "system" }, action: "hello", args: {}, decision: "allow" } satisfies AuditEntry },
      { method: "update.state", params: { node: other, component: "platform", current: "9.9.9" } },
      { method: "remote.state", params: { node: other, host: { kind: "none", status: "off" }, viewers: [], streaming: false } },
      { method: "metrics.sample", params: { node: other, at: now(), cpu: 0, memory: { used: 0, total: 1 }, processes: [], llm: {} } },
      // events into the brain's stream
      { method: "session.discovered", params: { session: session(other) } },
      { method: "session.ended", params: { session: { ...local, node: rogue.id, status: "ended" } } },
      { method: "session.ask", params: { session: local.id, ask: ask(rogue.id) } },
      { method: "workspace.updated", params: { id: ws.id } },
      { method: "node.pressure", params: { node: other, resource: "memory", level: "high" } },
    ];
    for (const f of forged) rogue.notify(f.method, f.params);
    // The node's own row, trying to move what the join settled.
    const before = d.nodes.registry.get(rogue.id)!;
    rogue.notify("node.state", { ...before, role: "primary", backup: true, rank: 1, epoch: 99, endpoints: ["6.6.6.6:1"], name: "renamed" });
    // Then one row that is the sender's own: once it is in, everything before it was read.
    const own = session(rogue.id);
    rogue.notify("session.state", own);
    await waitFor(() => d.nodes.mirrorSession(own.id) !== undefined);
    await waitFor(() => d.nodes.registry.get(rogue.id)?.name === "renamed");

    // Nothing forged reached the mirror, the bus or the event stream.
    const mirrored = d.nodes.mirror.sessions().map((s) => s.id);
    expect(mirrored).toEqual([own.id]);
    expect(d.nodes.mirror.asks()).toEqual([]);
    expect(d.nodes.mirror.workspaces()).toEqual([]);
    expect(d.nodes.mirror.updates()).toEqual([]);
    const fromRogue = heard.filter((h) => JSON.stringify(h.params).includes("forged") || JSON.stringify(h.params).includes(other) || JSON.stringify(h.params).includes("hijacked") || JSON.stringify(h.params).includes("9.9.9"));
    expect(fromRogue).toEqual([]);
    expect(heard.filter((h) => h.method === "session.event" && (h.params as SessionEvent).seq === 999)).toEqual([]);
    // The primary's own workspace row may come a second after the spawn touched it, echoed as workspace.updated.
    const echo = (e: { name: string; params: unknown }) =>
      e.name === "workspace.updated" &&
      heard.some((h) => h.method === "workspace.state" && (h.params as Workspace).id === (e.params as { id: string }).id && (h.params as Workspace).lastActivity === (e.params as { at: number }).at);
    expect(events.filter((e) => ["session.discovered", "session.ended", "session.ask", "workspace.updated", "node.pressure"].includes(e.name) && !echo(e))).toEqual([]);
    // The primary's own rows are untouched.
    expect(d.sessions.get(local.id)?.status).not.toBe("ended");
    expect(d.asks.get(localAsk.id)?.title).toBe("local");
    expect(d.workspaces.get(ws.id)?.path).toBe(primary.scratch);
    // No forged sample was kept for a watcher.
    expect((d.nodes as unknown as { inbound: { recentSamples: Map<string, unknown> } }).inbound.recentSamples.get(rogue.id)).toBeUndefined();
    // The node's row took the name, not the role, backup, rank, epoch or endpoints.
    const row = d.nodes.registry.get(rogue.id)!;
    expect(row).toMatchObject({ role: "secondary", epoch: 1, endpoints: [], status: "online" });
    expect(row.backup).toBeUndefined();
    expect(row.rank).toBeUndefined();
  }, 30_000);

  test("the join's lists pass the same test: another node's rows and the primary's own ids are left out", async () => {
    const { primary, d, ws, local } = await primaryWithRows();
    const other = newId("node");
    const mine = session("placeholder");
    const rogueId = newId("node");
    const ownSession = { ...mine, node: rogueId };
    const rogue = await rogueLink(primary, {
      id: rogueId,
      sessions: [session(other), session(rogueId, { id: local.id }), ownSession],
      workspaces: [workspace(other), workspace(rogueId, { id: ws.id, path: "/hijacked" })],
      asks: [ask(other)],
    });
    rogues.push(rogue);
    await waitFor(() => d.nodes.linkedTo(rogue.id));
    expect(d.nodes.mirror.sessions().map((s) => s.id)).toEqual([ownSession.id]);
    expect(d.nodes.mirror.workspaces()).toEqual([]);
    expect(d.nodes.mirror.asks()).toEqual([]);
  }, 30_000);

  test("what the primary holds itself is routed here, whatever a mirror claims", async () => {
    const { d, ws, local, localAsk } = await primaryWithRows();
    const other = newId("node");
    // A mirror that claims the primary's own ids, as a forged join would have made before the check.
    d.nodes.mirror.fill(other, { sessions: [{ ...local, node: other }], workspaces: [{ ...ws, node: other }], asks: [{ ...localAsk, node: other }] });
    const host = d.nodes.forwardHost;
    expect(routeOf("session.send", { id: local.id, text: "x" }, host)).toEqual({ kind: "local" });
    expect(routeOf("ask.answer", { id: localAsk.id, option: "a" }, host)).toEqual({ kind: "local" });
    expect(routeOf("session.spawn", { workspace: ws.id, harness: "claude" }, host)).toEqual({ kind: "local" });
    // And the mirror still routes what is not here.
    const theirs = session(other);
    d.nodes.mirror.apply(other, "session.state", theirs);
    expect(routeOf("session.send", { id: theirs.id, text: "x" }, host)).toEqual({ kind: "node", node: other });
  }, 30_000);
});

describe("a datagram is believed only after a probe", () => {
  /** A primary of another cluster: a listener that knows no grant of this one, so its answer never opens. */
  async function impostor(lan: MemoryLan) {
    const p = await startPrimary({ discovery: lan });
    primaries.push(p);
    return p;
  }

  /** A socket on the LAN that beacons and answers queries as a primary of `epoch` at `port`, with `cluster`. */
  async function forger(lan: MemoryLan, cluster: string, port: number, epoch = 99): Promise<(t?: Datagram["t"]) => void> {
    let sock: DiscoverySocket | undefined;
    const datagram = (t: Datagram["t"]): Datagram => ({ cophyla: 1, t, cluster, nodeId: newId("node"), name: "forger", port, epoch, role: "primary" });
    sock = await lan.open({
      port: 4819,
      onMessage: (msg) => {
        if (msg.t === "q") sock?.broadcast(datagram("a"), 4819);
      },
    });
    sockets.push(sock);
    return (t = "b") => sock!.broadcast(datagram(t), 4819);
  }

  test("a primary does not step down, and a seeker does not aim, at an endpoint that fails its probe", async () => {
    const lan = new MemoryLan();
    const primary = await startPrimary({ discovery: lan });
    primaries.push(primary);
    const fake = await impostor(lan);
    const beacon = await forger(lan, primary.d.nodes.member()!.cluster, fake.d.controller!.port);
    for (let i = 0; i < 5; i++) {
      beacon();
      await Bun.sleep(100);
    }
    await Bun.sleep(600);
    expect(primary.d.nodes.state()).toBe("primary");
    expect(primary.d.nodes.transitions.some((t) => t.to === "stepping_down")).toBe(false);
    // A seeker hears the same beacon and keeps it out of its candidates.
    const seeker = await startSecondary(primary, { discovery: lan, noEndpoint: true });
    started.push(seeker);
    await linked(seeker, 8000);
    const heard = (seeker.nodes as unknown as { heard: { endpoint: string }[] }).heard.map((c) => c.endpoint);
    expect(heard).not.toContain(`127.0.0.1:${fake.d.controller!.port}`);
    expect(seeker.nodes.primaryId()).toBe(primary.d.identity.id);
  }, 30_000);

  test("a claiming primary does not yield to a datagram alone", async () => {
    const lan = new MemoryLan();
    const fake = await impostor(lan);
    // The cluster is known before the primary starts: its home carries its membership already.
    const home = tempHome();
    const cluster = "5".repeat(16);
    mkdirSync(join(home, "data"), { recursive: true });
    writeLinkFile(join(home, "data", "link.json"), { v: 1, grant: newId("grant"), key: "5".repeat(64), cluster, role: "full", via: "self" });
    await forger(lan, cluster, fake.d.controller!.port);
    const claimer = await startPrimary({ discovery: lan, home });
    primaries.push(claimer);
    expect(claimer.d.nodes.member()?.cluster).toBe(cluster);
    expect(claimer.d.nodes.transitions[0]).toMatchObject({ from: "claiming", to: "primary" });
    expect(claimer.d.nodes.roleOf()).toBe("primary");
  }, 30_000);

  test("a primary keeps the role against a higher epoch the user did not choose, and steps down to one the user did", async () => {
    const lan = new MemoryLan();
    const primary = await startPrimary({ discovery: lan });
    primaries.push(primary);
    const fake = await impostor(lan);
    const endpoint = `127.0.0.1:${fake.d.controller!.port}`;
    const beacon = await forger(lan, primary.d.nodes.member()!.cluster, fake.d.controller!.port);
    // The probe opens and answers as an older node does once it promoted itself while cut off: a higher epoch, not chosen.
    let chosen = false;
    const outbound = (primary.d.nodes as unknown as { outbound: { probe: (e: string) => Promise<unknown> } }).outbound;
    outbound.probe = async (e) => {
      if (e !== endpoint) throw new Error("not there");
      return { nodeId: newId("node"), role: "primary", epoch: primary.d.nodes.epoch() + 5, ...(chosen ? { chosen: true } : {}) };
    };
    beacon();
    await Bun.sleep(600);
    expect(primary.d.nodes.state()).toBe("primary");
    expect(primary.d.nodes.transitions.some((t) => t.to === "stepping_down")).toBe(false);
    // The same epoch, chosen by the user there: this primary steps down to it (one probe per endpoint a second).
    chosen = true;
    await Bun.sleep(1100);
    beacon();
    await waitFor(() => primary.d.nodes.transitions.some((t) => t.to === "stepping_down"), 5000);
  }, 30_000);
});
