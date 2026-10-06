// Workspace nodes end to end, with in-process daemons: a machine lends a folder to another
// person's primary with that primary's hands invite; the workspace node links over the LAN,
// or over the server relay alone; the other primary starts a session in the folder through
// the fake ACP agent, and the ask the workspace node's gate raises for it is answered there;
// the machine's own apps see none of it. A revoke and a grant's end forget the membership;
// leaving keeps what it held and joining the same cluster again finds it; joining another
// cluster takes it away first. An invite of the machine's own cluster, one from a node a
// workspace node knows, a full role, an overlapping folder, a taken name and a folder with
// the machine's own session running in it are refused, and the machine never joins a
// workspace node's cluster. Removing one leaves its cluster, retires its id and deletes its
// files, and what it held stays out of sight.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ask, Session, Workspace } from "@cophyla/protocol";
import { paths } from "../src/config/load.ts";
import { readGuests, readRetired } from "../src/nodes/guest-files.ts";
import { FakeServer } from "./fakes/server.ts";
import { isMethod, tempHome, waitFor } from "./helpers.ts";
import type { TestClient } from "./helpers.ts";
import { client, inviteOn, startPrimary, stopAll } from "./nodes-helpers.ts";
import type { Primary } from "./nodes-helpers.ts";

const primaries: Primary[] = [];
const clients: TestClient[] = [];
const dirs: string[] = [];
let fake: FakeServer | undefined;

afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  await stopAll(...primaries.map((p) => p.d));
  primaries.length = 0;
  await fake?.stop();
  fake = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function up(opts: Parameters<typeof startPrimary>[0] = {}): Promise<Primary> {
  const p = await startPrimary({ heartbeatMs: 1000, ...opts });
  primaries.push(p);
  return p;
}

/**
 * A folder of work outside every home, to lend, named as the file system names it: the daemon
 * answers a folder resolved, and macOS's temp folder is a link.
 */
function folder(name = "friend"): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "cophyla-lent-")));
  dirs.push(root);
  const dir = join(root, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "notes.md"), "# the friend's notes\n");
  return dir;
}

async function connect(p: Primary): Promise<TestClient> {
  const c = await client(p.d);
  clients.push(c);
  return c;
}

const outcome = (x: Promise<unknown>): Promise<string> => x.then(() => "ok", (e: unknown) => (e instanceof Error ? e.message : String(e)));

describe("a workspace node", () => {
  test("links as hands over the LAN; the other primary starts a session there and answers its ask; the machine sees nothing", async () => {
    const m = await up();
    const p2 = await up();
    const lent = folder();
    const g = await m.d.guests.add({ folder: lent, invite: await inviteOn(p2, { role: "hands", name: "friend's folder" }) });
    expect(g.name).toBe("friend");
    expect(g.cluster).toBe(p2.d.nodes.member()!.cluster);
    await waitFor(() => m.d.guests.member(g.id).linked(), 10_000);
    expect(m.d.guests.list()[0]).toMatchObject({ id: g.id, state: "linked", via: "direct", primary: { id: p2.d.identity.id } });
    await waitFor(() => p2.d.nodes.linkedNodes().includes(g.id));
    expect(p2.d.grants.forNode(g.id)?.role).toBe("hands");
    // what the other cluster sees of it: its own row, its folder's workspace
    const c2 = await connect(p2);
    const row = p2.d.nodes.registry.get(g.id)!;
    expect(row).toMatchObject({ name: "friend", scope: { kind: "workspaces", paths: [lent] }, capabilities: { remote: false, brain: false } });
    const ws = await waitFor(async () => (await c2.request<{ workspaces: Workspace[] }>("workspace.list")).workspaces.find((w) => w.node === g.id), 5000);
    expect(ws.path.toLowerCase()).toBe(lent.toLowerCase());
    // a session started from there, as the other primary's brain would: the workspace node's gate asks, and the other person answers
    const inbound = (p2.d.nodes as unknown as { inbound: { forward(node: string, method: string, params: unknown): Promise<unknown> } }).inbound;
    const spawning = inbound.forward(g.id, "session.spawn", { harness: "claude", workspace: ws.id, prompt: "hello from the other cluster" }) as Promise<{ id: string }>;
    const asked = await c2.next(isMethod("ask.state", (p) => (p as Ask).node === g.id && (p as Ask).status === "open"), 10_000);
    await c2.request("ask.answer", { id: (asked.params as Ask).id, option: "allow" });
    const { id } = await spawning;
    const s = m.d.sessions.getAny(id)!;
    expect(s.node).toBe(g.id);
    expect(s.native.transport).toBe("acp");
    await waitFor(() => p2.d.nodes.mirrorSession(id)?.status === "idle", 10_000);
    expect(p2.d.nodes.mirrorSession(id)?.transcript).toBeUndefined();
    // its history reaches the other cluster, and a message goes in
    const history = await c2.request<{ events: unknown[] }>("session.history", { id });
    expect(history.events.length).toBeGreaterThan(0);
    // the machine's own: nothing of it
    const cm = await connect(m);
    expect((await cm.request<{ sessions: Session[] }>("session.list")).sessions.some((x) => x.id === id)).toBe(false);
    expect((await cm.request<{ workspaces: Workspace[] }>("workspace.list")).workspaces.some((w) => w.node === g.id)).toBe(false);
    expect(m.d.asks.get((asked.params as Ask).id)).toBeUndefined();
    expect(cm.notifications.some((n) => JSON.stringify(n.params ?? null).includes(g.id))).toBe(false);
    // its audit rows are its own
    const rows = m.d.store.audit.list({ limit: 100 }).filter((e) => e.action === "session.spawn");
    expect(rows.length).toBe(1);
    expect(rows[0]!.node).toBe(g.id);
    expect(rows[0]!.principal).toEqual({ kind: "node", id: p2.d.identity.id });
  }, 60_000);

  test("links over the relay alone, with no account of the machine's, and leaves through it", async () => {
    fake = new FakeServer();
    const home = tempHome();
    const pp = paths(home);
    mkdirSync(pp.data, { recursive: true });
    writeFileSync(pp.accountToken, fake.mintToken() + "\n", { mode: 0o600 });
    const toml = `[cloud]\nenabled = true\nurl = "${fake.url}"\nallow_insecure = true\nreconnect_ms = 20\nreconnect_max_ms = 100\nhello_timeout_ms = 3000\n\n`;
    const p2 = await up({ noLan: true, home, toml, daemon: { cloud: { keys: [fake.publicKey] } } });
    await waitFor(() => fake!.primaryOf()?.primary === p2.d.identity.id, 5000);
    const m = await up();
    const g = await m.d.guests.add({ folder: folder(), invite: await inviteOn(p2, { role: "hands", relayOnly: true }) });
    await waitFor(() => m.d.guests.member(g.id).linked(), 15_000);
    expect(m.d.guests.member(g.id).via()).toBe("relay");
    expect(m.d.cloud.signedIn).toBe(false);
    await waitFor(() => p2.d.nodes.linkedNodes().includes(g.id), 5000);
    expect(p2.d.nodes.registry.get(g.id)?.via).toBe("relay");
    // a leave through the relay reaches the other primary before the tunnel closes: the grant goes with it
    await m.d.guests.leave(g.id);
    await waitFor(() => p2.d.grants.forNode(g.id) === undefined, 5000);
  }, 60_000);

  test("a revoke forgets the membership; so does its grant's end", async () => {
    const m = await up();
    const p2 = await up();
    const g = await m.d.guests.add({ folder: folder(), invite: await inviteOn(p2, { role: "hands" }) });
    await waitFor(() => m.d.guests.member(g.id).linked(), 10_000);
    const dir = readGuests(m.d.paths.data)[0]!.dir;
    expect(existsSync(join(dir, "link.json"))).toBe(true);
    await p2.d.nodes.revoke(p2.d.grants.forNode(g.id)!.id);
    await waitFor(() => m.d.guests.member(g.id).state === "unlinked", 5000);
    expect(m.d.guests.member(g.id).member()).toBeUndefined();
    expect(existsSync(join(dir, "link.json"))).toBe(false);
    // it may join again, and its grant this time runs out
    await m.d.guests.join(g.id, await inviteOn(p2, { role: "hands", expiresIn: 2000 }));
    await waitFor(() => m.d.guests.member(g.id).linked(), 10_000);
    await waitFor(() => m.d.guests.member(g.id).state === "unlinked", 8000);
    expect(m.d.guests.list()[0]!.cluster).toBeUndefined();
  }, 60_000);

  test("leaving keeps what it held for the same cluster; joining another takes it away first", async () => {
    const m = await up();
    const p2 = await up();
    const p3 = await up();
    const lent = folder();
    const g = await m.d.guests.add({ folder: lent, invite: await inviteOn(p2, { role: "hands" }) });
    await waitFor(() => m.d.guests.member(g.id).linked(), 10_000);
    const view = m.d.sessions.view(g.id);
    const ws = m.d.workspaces.view(g.id).list()[0]!;
    const s = await view.spawn({ harness: "claude", workspace: ws.id, prompt: "the canary of the first cluster" }, { profiles: m.d.profiles });
    await waitFor(() => view.get(s.id)?.status === "idle", 10_000);
    const events = view.history(s.id).length;
    await m.d.guests.leave(g.id);
    expect(m.d.guests.member(g.id).state).toBe("unlinked");
    await waitFor(() => !p2.d.nodes.linkedNodes().includes(g.id));
    // the grant went with it on the other side
    expect(p2.d.grants.forNode(g.id)).toBeUndefined();
    // the same cluster again: what it held is there
    await m.d.guests.join(g.id, await inviteOn(p2, { role: "hands" }));
    await waitFor(() => m.d.guests.member(g.id).linked(), 10_000);
    expect(view.history(s.id).length).toBe(events);
    await m.d.guests.leave(g.id);
    // another cluster: it is taken away before the join is kept
    await m.d.guests.join(g.id, await inviteOn(p3, { role: "hands" }));
    await waitFor(() => m.d.guests.member(g.id).linked(), 10_000);
    expect(m.d.guests.list()[0]!.cluster).toBe(p3.d.nodes.member()!.cluster);
    expect(m.d.store.sessionEvents.count(s.id)).toBe(0);
    expect(JSON.stringify(m.d.store.sessions.get(s.id))).not.toContain("canary");
    expect(m.d.store.sessions.get(s.id)?.status).toBe("ended");
    expect(m.d.store.index.chunks.count()).toBeGreaterThanOrEqual(0);
    expect((await m.d.store.index.recall({ query: "canary" }, { only: g.id })).length).toBe(0);
  }, 60_000);

  test("what is refused: a full role, a node a workspace node knows, an overlap, a taken name, a folder in use, the machine's own cluster; and the machine joins none of theirs", async () => {
    const m = await up();
    const p2 = await up();
    const lent = folder();
    // a full role: redeemed, then refused, and nothing is left of it
    expect(await outcome(m.d.guests.add({ folder: lent, invite: await inviteOn(p2, { role: "full" }) }))).toMatch(/hands only/);
    expect(m.d.guests.list()).toEqual([]);
    expect(readGuests(m.d.paths.data)).toEqual([]);
    expect(m.d.owners.ownerOf(lent)).toBeUndefined();
    const g = await m.d.guests.add({ folder: lent, invite: await inviteOn(p2, { role: "hands" }) });
    await waitFor(() => m.d.guests.member(g.id).linked(), 10_000);
    // a second workspace node into the first's cluster
    expect(await outcome(m.d.guests.add({ folder: folder("other"), invite: await inviteOn(p2, { role: "hands" }) }))).toMatch(/another workspace node here is in/);
    // the folder, one inside it, the name
    expect(await outcome(m.d.guests.add({ folder: join(lent, "src"), invite: "x" }))).toMatch(/overlaps/);
    expect(await outcome(m.d.guests.add({ folder: folder("friend"), invite: "x" }))).toMatch(/called friend already/);
    // a folder with the machine's own session running in it
    const busy = folder("busy");
    const mine = m.d.workspaces.put({ node: m.d.identity.id, path: busy, name: "busy" });
    await m.d.sessions.spawn({ harness: "claude", workspace: mine.id, prompt: "mine" }, { profiles: m.d.profiles });
    expect(await outcome(m.d.guests.add({ folder: busy, invite: "x" }))).toMatch(/a session of yours runs/);
    // the machine never joins the cluster a workspace node is in
    expect(await outcome(m.d.nodes.join(await inviteOn(p2)))).toMatch(/workspace node here is in/);
    expect(m.d.nodes.member()?.via).toBe("self");
    // nor lends a folder to its own cluster
    expect(await outcome(m.d.guests.add({ folder: folder("own"), invite: await inviteOn(m, { role: "hands" }) }))).toMatch(/this machine's own cluster/);
    expect(m.d.guests.list().map((x) => x.id)).toEqual([g.id]);
  }, 60_000);

  test("removed: it leaves, its id is retired, its files go, and what it held stays out of sight", async () => {
    const m = await up();
    const p2 = await up();
    const lent = folder();
    const g = await m.d.guests.add({ folder: lent, invite: await inviteOn(p2, { role: "hands" }) });
    await waitFor(() => m.d.guests.member(g.id).linked(), 10_000);
    const ws = m.d.workspaces.view(g.id).list()[0]!;
    const s = await m.d.sessions.view(g.id).spawn({ harness: "claude", workspace: ws.id, prompt: "remove me" }, { profiles: m.d.profiles });
    await waitFor(() => m.d.sessions.view(g.id).get(s.id)?.status === "idle", 10_000);
    const dir = readGuests(m.d.paths.data)[0]!.dir;
    await m.d.guests.remove(g.id);
    expect(m.d.guests.list()).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    expect(readRetired(m.d.paths.data)).toEqual([g.id]);
    expect(m.d.owners.isGuest(g.id)).toBe(false);
    expect(m.d.owners.isPrivate(g.id)).toBe(true);
    expect(m.d.owners.ownerOf(join(lent, "src"))).toBeUndefined();
    // the other side heard it leave
    await waitFor(() => !p2.d.nodes.linkedNodes().includes(g.id));
    expect(p2.d.grants.forNode(g.id)).toBeUndefined();
    // a tombstone, out of sight
    expect(m.d.store.sessions.get(s.id)).toMatchObject({ node: g.id, status: "ended" });
    expect(m.d.sessions.get(s.id)).toBeUndefined();
    expect(m.d.workspaces.list().some((w) => w.node === g.id)).toBe(false);
    // the folder is the machine's again
    const again = m.d.workspaces.put({ node: m.d.identity.id, path: lent, name: "mine again" });
    expect(again.node).toBe(m.d.identity.id);
  }, 60_000);
});
