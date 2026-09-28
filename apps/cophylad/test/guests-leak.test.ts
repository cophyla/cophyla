// Nothing crosses between the partitions of one machine: a canary matrix. Machine M is a node
// of P1's cluster, with a limited phone on P1; it hosts two workspace nodes, G1 in P2's
// cluster and G2 in P3's. Each partition gets strings of its own (in a folder's name, a
// prompt, an intent, a file's text read through a tool) and its own ids, and each primary
// works on its own side: sessions started, an ask answered, an annotation, a tool run, a
// recall, a metrics watch. Then every notification and result each side's clients heard,
// each primary's mirrors, registry and whole store, each brain's feed, and what M's store
// announced for replication and backup are searched: each partition's strings are found on
// its own side and nowhere else, and M's id, name and home never reach P2 or P3.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSIONS } from "@cophyla/protocol";
import type { Ask, Session, Workspace } from "@cophyla/protocol";
import type { StoreWrite } from "../src/store/index.ts";
import { isMethod, TestClient, waitFor } from "./helpers.ts";
import { client, inviteOn, linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

const CM = "canarymachine";
const CG1 = "canaryguestone";
const CG2 = "canaryguesttwo";
const HOST = "canarymhost";

let p1: Primary;
let p2: Primary;
let p3: Primary;
let m: Started;
let root: string;
const clients: TestClient[] = [];
const writes: StoreWrite[] = [];
const machineBus: unknown[] = [];
const guestBus = { g1: [] as unknown[], g2: [] as unknown[] };
let phone: TestClient;
let c1: TestClient;
let c2: TestClient;
let c3: TestClient;
let cm: TestClient;
let g1: string;
let g2: string;
/** Ids that belong to each side, found as it works. */
const ids = { m: [] as string[], g1: [] as string[], g2: [] as string[] };

type Forward = { forward(node: string, method: string, params: unknown): Promise<unknown> };
const inboundOf = (p: Primary) => (p.d.nodes as unknown as { inbound: Forward }).inbound;

/** A primary's forward, with the ask the workspace node's gate raises for it answered by that primary's client. */
async function asked<T>(p: Primary, c: TestClient, node: string, method: string, params: unknown): Promise<T> {
  const seen = new Set(c.notifications.filter((n) => n.method === "ask.state").map((n) => (n.params as Ask).id));
  const call = inboundOf(p).forward(node, method, params) as Promise<T>;
  const done = await Promise.race([call.then((r) => ({ r })), waitFor(() => c.notifications.find((n) => n.method === "ask.state" && (n.params as Ask).node === node && (n.params as Ask).status === "open" && !seen.has((n.params as Ask).id)), 15_000).then((n) => ({ n }))]);
  if ("r" in done) return done.r;
  await c.request("ask.answer", { id: (done.n.params as Ask).id, option: "allow" });
  return call;
}

/** Everything a store holds, as text. */
function dump(p: Primary | Started): string {
  const d = "d" in p ? p.d : p;
  return d.store.tables().map((t) => JSON.stringify(d.store.db.query(`SELECT * FROM "${t}"`).all())).join("\n");
}

const heard = (c: TestClient) => JSON.stringify(c.notifications);
const brain = (p: Primary) => (p.brainLog ? require("node:fs").readFileSync(p.brainLog, "utf8") : "");
const mirror = (p: Primary) => JSON.stringify({ ...p.d.nodes.initial(), registry: p.d.nodes.registry.list() });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cophyla-leak-"));
  const script = { script: { on: [] } };
  p1 = await startPrimary({ brain: script, heartbeatMs: 1000 });
  p2 = await startPrimary({ brain: script, heartbeatMs: 1000 });
  p3 = await startPrimary({ brain: script, heartbeatMs: 1000 });
  // no gate rules: what the workspace nodes' primaries ask of them is asked of those primaries' users
  m = await startSecondary(p1, { agent: true, heartbeatMs: 1000, node: `name = "${HOST}"\n` });
  await linked(m, 10_000);
  m.store.onWrites((w) => void writes.push(w));
  // what every one of the machine's own consumers hears: its partition of the bus, and its event stream
  for (const name of ["ask.state", "audit.entry", "session.state", "session.event", "terminal.state", "workspace.state", "node.state", "node.joined", "node.left", "node.pressure", "remote.state", "direct.state", "update.state"] as const) {
    m.bus.on(name, (p) => void machineBus.push({ name, p }));
  }
  m.events.on((e) => void machineBus.push(e));
  // the phone: a limited client of M's cluster
  const { token } = p1.d.grants.createController("Work phone", { access: SESSIONS });
  phone = await TestClient.connect(`wss://127.0.0.1:${p1.d.controller!.port}/ws/client`, { insecure: true });
  clients.push(phone);
  await phone.request("hello", { token, kind: "controller", audio: { in: false, out: false } });
  for (const [p, c] of [
    [p1, "c1"],
    [p2, "c2"],
    [p3, "c3"],
  ] as const) {
    const x = await client(p.d, c);
    clients.push(x);
    if (c === "c1") c1 = x;
    else if (c === "c2") c2 = x;
    else c3 = x;
  }
  cm = await client(m, "machine desktop");
  clients.push(cm);
  // the two workspace nodes
  const folder = (name: string) => {
    const dir = join(root, name);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "notes.md"), `# ${name}\n\nthe notes of ${name}\n`);
    return dir;
  };
  g1 = (await m.guests.add({ folder: folder(`${CG1}-folder`), invite: await inviteOn(p2, { role: "hands" }) })).id;
  g2 = (await m.guests.add({ folder: folder(`${CG2}-folder`), invite: await inviteOn(p3, { role: "hands" }) })).id;
  await waitFor(() => m.guests.member(g1).linked() && m.guests.member(g2).linked(), 15_000);
  ids.g1.push(g1);
  ids.g2.push(g2);
  // what each workspace node's own link and stream hear: its partition
  for (const [g, into] of [
    [g1, guestBus.g1],
    [g2, guestBus.g2],
  ] as const) {
    for (const name of ["ask.state", "audit.entry", "session.state", "session.event", "terminal.state", "workspace.state", "node.state", "node.joined", "node.left", "node.pressure", "remote.state", "direct.state", "update.state"] as const) {
      m.bus.for(g).on(name, (p) => void into.push({ name, p }));
    }
  }

  // the machine's own work, as its cluster does it
  const mine = folder(`${CM}-work`);
  const mws = m.workspaces.put({ node: m.identity.id, path: mine, name: `${CM} work` });
  ids.m.push(mws.id);
  const ms = await m.sessions.spawn({ harness: "claude", workspace: mws.id, prompt: `${CM} prompt` }, { profiles: m.profiles });
  ids.m.push(ms.id);
  m.sessions.annotate(ms.id, { intent: `${CM} intent` });
  await waitFor(() => p1.d.nodes.mirrorSession(ms.id)?.intent === `${CM} intent`, 10_000);

  // each workspace node's, as its own primary does it
  for (const [p, c, g, canary, side] of [
    [p2, c2, g1, CG1, ids.g1],
    [p3, c3, g2, CG2, ids.g2],
  ] as const) {
    const ws = await waitFor(() => p.d.nodes.mirror.workspaces().find((w: Workspace) => w.node === g), 10_000);
    side.push(ws.id);
    const { id } = await asked<{ id: string }>(p, c, g, "session.spawn", { harness: "claude", workspace: ws.id, prompt: `${canary} prompt` });
    side.push(id);
    await waitFor(() => p.d.nodes.mirrorSession(id)?.status === "idle", 10_000);
    await asked(p, c, g, "annotate", { on: id, intent: `${canary} intent` });
    await asked(p, c, g, "tool.run", { name: "fs.read", args: { path: "src/notes.md", workspace: ws.id } });
    await asked(p, c, g, "recall", { query: canary, node: g });
    await asked(p, c, g, "session.list", {});
    await c.request("metrics.subscribe", { node: g, intervalMs: 1000 });
    await waitFor(() => p.d.nodes.mirrorSession(id)?.intent === `${canary} intent`, 10_000);
  }
  // a metrics watch of the machine from its own cluster, and a few samples
  await c1.request("metrics.subscribe", { node: m.identity.id, intervalMs: 1000 });
  await cm.request("metrics.subscribe", { intervalMs: 1000 });
  for (let i = 0; i < 3; i++) await m.metrics.tick();
  // lists as each side's apps load them
  for (const c of [c1, c2, c3, cm, phone]) {
    for (const method of ["session.list", "workspace.list", "node.list", "terminal.list"]) await c.call(method, {});
  }
  await Bun.sleep(500);
}, 120_000);

afterAll(async () => {
  for (const c of clients) c.close();
  await stopAll(m, p1.d, p2.d, p3.d);
  rmSync(root, { recursive: true, force: true });
});

const lower = (s: string) => s.toLowerCase().replace(/\\\\/g, "\\");

/** Every string of a side: its canary and its ids. */
function marks(side: "m" | "g1" | "g2"): string[] {
  return [side === "m" ? CM : side === "g1" ? CG1 : CG2, ...ids[side]];
}

function expectNone(where: string, text: string, side: "m" | "g1" | "g2"): void {
  const found = marks(side).filter((x) => text.includes(x));
  expect({ where, side, found }).toEqual({ where, side, found: [] });
}

function expectSome(where: string, text: string, side: "m" | "g1" | "g2"): void {
  expect({ where, side, has: text.includes(side === "m" ? CM : side === "g1" ? CG1 : CG2) }).toEqual({ where, side, has: true });
}

describe("the canary matrix", () => {
  test("each side's strings are on its own side", () => {
    expectSome("P1's client", heard(c1), "m");
    expectSome("M's client", heard(cm), "m");
    expectSome("P1's mirror", mirror(p1), "m");
    expectSome("P1's brain", brain(p1), "m");
    expectSome("P2's client", heard(c2), "g1");
    expectSome("P2's mirror", mirror(p2), "g1");
    expectSome("P2's brain", brain(p2), "g1");
    expectSome("P3's client", heard(c3), "g2");
    expectSome("P3's mirror", mirror(p3), "g2");
  });

  test("the machine's side never hears a workspace node's", () => {
    expectSome("M's bus", JSON.stringify(machineBus), "m");
    for (const side of ["g1", "g2"] as const) {
      expectNone("M's bus and event stream", JSON.stringify(machineBus), side);
      expectNone("M's client", heard(cm), side);
      expectNone("the phone", heard(phone), side);
      expectNone("P1's client", heard(c1), side);
      expectNone("P1's mirror and registry", mirror(p1), side);
      expectNone("P1's store", dump(p1), side);
      expectNone("P1's brain", brain(p1), side);
      expectNone("M's store writes", JSON.stringify(writes), side);
      expectNone("M's replica set", JSON.stringify(m.store.replicaSnapshot([])), side);
    }
  });

  test("a workspace node's cluster never hears the machine's, nor the other workspace node's", () => {
    for (const [p, c, own, other, bus] of [
      [p2, c2, "P2", "g2", guestBus.g1],
      [p3, c3, "P3", "g1", guestBus.g2],
    ] as const) {
      expectSome(`${own}'s workspace node's partition`, JSON.stringify(bus), other === "g2" ? "g1" : "g2");
      for (const side of ["m", other] as const) {
        expectNone(`${own}'s workspace node's partition`, JSON.stringify(bus), side);
        expectNone(`${own}'s client`, heard(c), side);
        expectNone(`${own}'s mirror and registry`, mirror(p), side);
        expectNone(`${own}'s store`, dump(p), side);
        expectNone(`${own}'s brain`, brain(p), side);
      }
      // nor the machine's id, name or home
      const everything = lower([heard(c), mirror(p), dump(p), brain(p)].join("\n"));
      for (const x of [m.identity.id, HOST, lower(m.home), lower(m.home.replace(/\\/g, "/"))]) expect({ where: own, x, found: everything.includes(x.toLowerCase()) }).toEqual({ where: own, x, found: false });
    }
  });

  test("the rows that went up carry no transcript, terminal or job, and the samples no counts of the owner's", () => {
    for (const [c, g] of [
      [c2, g1],
      [c3, g2],
    ] as const) {
      const rows = c.notifications.filter((n) => n.method === "session.state" && (n.params as Session).node === g).map((n) => n.params as Session);
      expect(rows.length).toBeGreaterThan(0);
      for (const s of rows) {
        expect(s.transcript).toBeUndefined();
        expect(s.native.terminal).toBeUndefined();
        expect(s.native.job).toBeUndefined();
      }
      const samples = c.notifications.filter((n) => n.method === "metrics.sample" && (n.params as { node: string }).node === g);
      for (const s of samples) expect(s.params).toMatchObject({ llm: {} });
      for (const s of samples) expect((s.params as { profiles?: unknown; limits?: unknown }).profiles ?? (s.params as { limits?: unknown }).limits).toBeUndefined();
    }
  });
});
