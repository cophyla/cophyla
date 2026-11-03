// The account's machines, with real daemons and the fake server: a machine signing in to an
// account whose machines are another cluster joins them on its own, as a full member, with no
// invite typed and what it had saved first; one that signs in while their primary is away
// waits, runs on its own, and joins once it is back; a primary with a machine of its own
// moves it in, then itself; a machine of that cluster that was away then joins on its own
// when it is back; and a machine the user took out stays out until asked.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { runCommand } from "../src/cli.ts";
import { paths } from "../src/config/load.ts";
import { readLinkFile } from "../src/grants/link-file.ts";
import { Store } from "../src/store/index.ts";
import { FakeServer } from "./fakes/server.ts";
import { sleep, tempHome, waitFor } from "./helpers.ts";
import type { TestClient } from "./helpers.ts";
import { client, linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

let fake: FakeServer | undefined;
const daemons: (Started | undefined)[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  await stopAll(...daemons.reverse());
  daemons.length = 0;
  await fake?.stop();
  fake = undefined;
});

/** A home that reaches the fake server; signed in already unless `signedIn` is false. */
function cloudHome(f: FakeServer, signedIn = true): { home: string; toml: string; nodes: string } {
  const home = tempHome();
  const p = paths(home);
  mkdirSync(p.data, { recursive: true });
  if (signedIn) writeFileSync(p.accountToken, f.mintToken() + "\n", { mode: 0o600 });
  return { home, toml: `[cloud]\nenabled = true\nurl = "${f.url}"\nallow_insecure = true\nreconnect_ms = 20\nreconnect_max_ms = 100\nhello_timeout_ms = 3000\n\n`, nodes: "registry_heartbeat_ms = 150\nreconnect_ms = 100\nreconnect_max_ms = 400\n" };
}

const cloudOf = (f: FakeServer) => ({ cloud: { keys: [f.publicKey] } });

async function machine(f: FakeServer, opts: { signedIn?: boolean; home?: ReturnType<typeof cloudHome>; nodes?: string } = {}): Promise<Primary> {
  const h = opts.home ?? cloudHome(f, opts.signedIn ?? true);
  const p = await startPrimary({ home: h.home, toml: h.toml, nodes: h.nodes + (opts.nodes ?? ""), daemon: cloudOf(f) });
  daemons.push(p.d);
  return p;
}

/** Signs a running machine in, as the user does in the account card: the code, the page, the link. */
async function signIn(f: FakeServer, d: Started): Promise<void> {
  const c = await client(d);
  clients.push(c);
  const r = await c.request<{ userCode: string }>("account.login");
  f.approve(r.userCode);
  await waitFor(() => f.linked(d.identity.id), 10_000);
}

describe("the account's machines", () => {
  test("a machine signing in where the account's machines are another cluster joins them, as a full member; what it had is saved first", async () => {
    fake = new FakeServer({ leaseMs: 5000, closeGraceMs: 300 });
    const desk = await machine(fake);
    await waitFor(() => fake!.primaryOf()?.primary === desk.d.identity.id, 5000);
    const deskCluster = desk.d.nodes.member()!.cluster;
    expect(fake.lease?.cluster).toBe(deskCluster);
    // a new install runs on its own, a cluster of its own, until the user signs in there
    const laptop = await machine(fake, { signedIn: false });
    expect(laptop.d.nodes.roleOf()).toBe("primary");
    expect(laptop.d.nodes.member()?.cluster).not.toBe(deskCluster);
    await signIn(fake, laptop.d);
    await waitFor(() => laptop.d.nodes.linked(), 15_000);
    expect(laptop.d.nodes.primaryId()).toBe(desk.d.identity.id);
    expect(laptop.d.nodes.member()).toMatchObject({ cluster: deskCluster, role: "full", via: "join" });
    expect(desk.d.nodes.linkedNodes()).toContain(laptop.d.identity.id);
    expect(desk.d.grants.forNode(laptop.d.identity.id)?.role).toBe("full");
    // the desk kept the role: one primary, one brain
    expect(desk.d.nodes.roleOf()).toBe("primary");
    expect(fake.primaryOf()?.primary).toBe(desk.d.identity.id);
    expect(fake.joins).toEqual([{ by: laptop.d.identity.id, node: laptop.d.identity.id, role: "full", ok: true }]);
    // the laptop says what happened, where what it had went, and that file holds no cluster's keys
    const account = laptop.d.nodes.self().account!;
    expect(account).toMatchObject({ state: "joined", primary: desk.d.identity.name });
    expect(existsSync(account.saved!)).toBe(true);
    const copy = JSON.parse(readFileSync(account.saved!, "utf8")) as { v: number; node: { id: string }; tables: { kv: { ns: string }[]; threads: unknown[] } };
    expect(copy).toMatchObject({ v: 1, node: { id: laptop.d.identity.id } });
    expect(copy.tables.kv.some((r) => r.ns === "grants" || r.ns === "cluster")).toBe(false);
    // the desk's card for it carries the note too, once the row came up
    await waitFor(() => desk.d.nodes.registry.get(laptop.d.identity.id)?.account?.state === "joined", 5000);
  }, 40_000);

  test("signed in while the account's primary is away: it keeps its own role, says it waits, and joins once the primary is back", async () => {
    fake = new FakeServer({ leaseMs: 5000, closeGraceMs: 300 });
    const dh = cloudHome(fake);
    let desk = await machine(fake, { home: dh });
    await waitFor(() => fake!.primaryOf()?.primary === desk.d.identity.id, 5000);
    const deskId = desk.d.identity.id;
    const deskName = desk.d.identity.name;
    await desk.d.stop();
    daemons.splice(daemons.indexOf(desk.d), 1);
    await sleep(500);
    expect(fake.primaryOf()).toBeUndefined();
    const laptop = await machine(fake);
    // refused the lease (the desk registered a moment ago), never stepped down to it: its own primary still
    await waitFor(() => laptop.d.nodes.self().account?.state === "waiting", 15_000);
    expect(laptop.d.nodes.roleOf()).toBe("primary");
    expect(laptop.d.nodes.self().account).toMatchObject({ state: "waiting", primary: deskName, detail: `${deskName}, the account's primary, is not connected` });
    expect(fake.primaryOf()).toBeUndefined();
    // a primary apart from the account's machines holds no lease, so it renews none
    await sleep(600);
    expect(fake.registryLog.some((r) => r.method === "registry.heartbeat" && r.node === laptop.d.identity.id)).toBe(false);
    expect(fake.primaryOf()).toBeUndefined();
    // the desk comes back: it takes the role again, the laptop hears of it and joins
    desk = await machine(fake, { home: dh });
    expect(desk.d.identity.id).toBe(deskId);
    await waitFor(() => laptop.d.nodes.linked(), 20_000);
    expect(laptop.d.nodes.primaryId()).toBe(deskId);
    expect(laptop.d.nodes.self().account).toMatchObject({ state: "joined", primary: deskName });
  }, 60_000);

  test("a primary with a machine of its own moves it in, then itself: one cluster, the machines it shares kept to what they share", async () => {
    fake = new FakeServer({ leaseMs: 5000, closeGraceMs: 300 });
    const desk = await machine(fake);
    await waitFor(() => fake!.primaryOf()?.primary === desk.d.identity.id, 5000);
    const deskCluster = desk.d.nodes.member()!.cluster;
    // another cluster, set up before its primary was signed in: a primary and a hands machine sharing one folder
    const lab = await machine(fake, { signedIn: false });
    const shared = tempHome();
    const borrowed = await startSecondary(lab, { hands: true, paths: [shared] });
    daemons.push(borrowed);
    await linked(borrowed);
    const labCluster = lab.d.nodes.member()!.cluster;
    expect(borrowed.nodes.member()?.cluster).toBe(labCluster);
    const oldGrant = lab.d.grants.forNode(borrowed.identity.id)!.id;
    await signIn(fake, lab.d);
    await waitFor(() => lab.d.nodes.linked() && borrowed.nodes.linked() && borrowed.nodes.primaryId() === desk.d.identity.id, 25_000);
    expect(lab.d.nodes.primaryId()).toBe(desk.d.identity.id);
    expect(lab.d.nodes.member()).toMatchObject({ cluster: deskCluster, role: "full" });
    expect(borrowed.nodes.member()).toMatchObject({ cluster: deskCluster, role: "hands" });
    expect(readLinkFile(paths(borrowed.home).linkFile)?.paths).toEqual([shared]);
    expect(desk.d.grants.forNode(borrowed.identity.id)?.role).toBe("hands");
    expect(desk.d.nodes.linkedNodes().sort()).toEqual([lab.d.identity.id, borrowed.identity.id].sort());
    expect(fake.joins.map((j) => ({ node: j.node, role: j.role, ok: j.ok }))).toEqual([
      { node: borrowed.identity.id, role: "hands", ok: true },
      { node: lab.d.identity.id, role: "full", ok: true },
    ]);
    expect(fake.merges.get(labCluster)).toBe(deskCluster);
    expect(lab.d.nodes.self().account).toMatchObject({ state: "joined", primary: desk.d.identity.name });
    expect(lab.d.nodes.self().account?.left).toBeUndefined();
    // the old cluster's grants are gone from the lab, which leads no one now: what it holds is the desk's replica
    expect(lab.d.grants.get(oldGrant)).toBeUndefined();
    expect(lab.d.nodes.roleOf()).toBe("secondary");
  }, 60_000);

  test("a machine of a cluster moved in while it was away joins on its own when it is back, signed in", async () => {
    fake = new FakeServer({ leaseMs: 5000, closeGraceMs: 300 });
    const desk = await machine(fake);
    await waitFor(() => fake!.primaryOf()?.primary === desk.d.identity.id, 5000);
    const deskCluster = desk.d.nodes.member()!.cluster;
    const lab = await machine(fake, { signedIn: false });
    // a full member of the lab's, signed in to the same account; kept to its invite this first time, so it is the lab's
    const mh = cloudHome(fake);
    const memberNodes = "registry_heartbeat_ms = 150\n";
    const member = await startSecondary(lab, { home: mh.home, toml: mh.toml, nodes: memberNodes + "account_join = false\n", daemon: cloudOf(fake) });
    daemons.push(member);
    await linked(member);
    const memberId = member.identity.id;
    const memberName = member.identity.name;
    await waitFor(() => fake!.linked(memberId), 10_000);
    // it is away when the lab moves
    await member.stop();
    daemons.splice(daemons.indexOf(member), 1);
    await signIn(fake, lab.d);
    await waitFor(() => lab.d.nodes.linked() && lab.d.nodes.primaryId() === desk.d.identity.id, 25_000);
    expect(lab.d.nodes.self().account?.left).toEqual([memberName]);
    // back: its cluster is gone into the account's, so it joins on its own, keeping its name
    const back = await startSecondary(lab, { home: mh.home, toml: mh.toml, nodes: memberNodes, daemon: cloudOf(fake), unjoined: true });
    daemons.push(back);
    expect(back.identity.id).toBe(memberId);
    await waitFor(() => back.nodes.linked() && back.nodes.primaryId() === desk.d.identity.id, 25_000);
    expect(back.nodes.member()).toMatchObject({ cluster: deskCluster, role: "full" });
    expect(back.nodes.self().account).toMatchObject({ state: "joined" });
    expect(fake.joins.at(-1)).toMatchObject({ by: memberId, node: memberId, ok: true });
  }, 60_000);

  test("a machine an older version left stuck (it chose the account's primary, which never gave it a grant) joins once it runs this one", async () => {
    fake = new FakeServer({ leaseMs: 5000, closeGraceMs: 300 });
    const desk = await machine(fake);
    await waitFor(() => fake!.primaryOf()?.primary === desk.d.identity.id, 5000);
    // a machine of its own cluster, signed out, with a word of its own in its chat
    const lh = cloudHome(fake, false);
    const first = await machine(fake, { home: lh });
    const laptopId = first.d.identity.id;
    const ownCluster = first.d.nodes.member()!.cluster;
    await first.d.stop();
    daemons.splice(daemons.indexOf(first.d), 1);
    // what the older version left: the account's primary kept as its choice, and an account token
    const store = new Store(paths(lh.home).db);
    store.migrate();
    store.meta.set("chosen_primary", desk.d.identity.id);
    store.close();
    writeFileSync(paths(lh.home).accountToken, fake.mintToken() + "\n", { mode: 0o600 });
    const laptop = await machine(fake, { home: lh });
    expect(laptop.d.identity.id).toBe(laptopId);
    expect(laptop.d.nodes.member()).toMatchObject({ cluster: ownCluster, via: "self" });
    // it starts seeking the desk, as it did (never claiming a role of its own), and joins it this time
    expect(laptop.d.nodes.transitions.some((t) => t.from === "claiming")).toBe(false);
    await waitFor(() => laptop.d.nodes.linked() && laptop.d.nodes.primaryId() === desk.d.identity.id, 20_000);
    expect(laptop.d.nodes.member()).toMatchObject({ cluster: desk.d.nodes.member()!.cluster, via: "join", role: "full" });
    expect(laptop.d.nodes.self().account).toMatchObject({ state: "joined", primary: desk.d.identity.name });
    expect(existsSync(laptop.d.nodes.self().account!.saved!)).toBe(true);
  }, 40_000);

  test("a machine the user took out stays out: it left, and the account does not pull it back until Join them", async () => {
    fake = new FakeServer({ leaseMs: 5000, closeGraceMs: 300 });
    const desk = await machine(fake);
    await waitFor(() => fake!.primaryOf()?.primary === desk.d.identity.id, 5000);
    const laptop = await machine(fake);
    await waitFor(() => laptop.d.nodes.linked(), 15_000);
    const c = await client(laptop.d);
    clients.push(c);
    await c.request("node.leave", {});
    await waitFor(() => !laptop.d.nodes.linked() && laptop.d.nodes.member() === undefined, 5000);
    expect(laptop.d.nodes.self().account).toMatchObject({ state: "off" });
    // the cluster's machines are no longer its to show
    expect(laptop.d.nodes.registry.peers()).toEqual([]);
    // the desk let its grant go; the server keeps naming the account's machines, and nothing is asked
    await waitFor(() => desk.d.grants.forNode(laptop.d.identity.id) === undefined, 5000);
    const joins = fake.joins.length;
    await sleep(1500);
    expect(fake.joins.length).toBe(joins);
    // Join them, on the machine itself: `cophylad join --account`, as the card's button asks it
    const write = process.stdout.write.bind(process.stdout);
    const out: string[] = [];
    process.stdout.write = ((s: string) => (out.push(String(s)), true)) as never;
    let code: number;
    try {
      code = await runCommand("join", ["--account", "--home", laptop.d.home, "--port", String(laptop.d.api.port)]);
    } finally {
      process.stdout.write = write;
    }
    expect(code).toBe(0);
    expect(out.join("")).toMatch(/Joining your account's machines/);
    await waitFor(() => laptop.d.nodes.linked(), 15_000);
    expect(laptop.d.nodes.primaryId()).toBe(desk.d.identity.id);
    expect(laptop.d.nodes.self().account).toMatchObject({ state: "joined" });
  }, 60_000);

  test("the account's primary with account_join off lets no one in: the machine says so and keeps its own role", async () => {
    fake = new FakeServer({ leaseMs: 5000, closeGraceMs: 300 });
    const desk = await machine(fake, { nodes: "account_join = false\n" });
    await waitFor(() => fake!.primaryOf()?.primary === desk.d.identity.id, 5000);
    const laptop = await machine(fake);
    await waitFor(() => laptop.d.nodes.self().account?.state === "failed", 15_000);
    expect(laptop.d.nodes.self().account?.detail).toMatch(/lets no machine in through the account/);
    expect(laptop.d.nodes.roleOf()).toBe("primary");
    expect(desk.d.nodes.linkedNodes()).toEqual([]);
  }, 30_000);
});
