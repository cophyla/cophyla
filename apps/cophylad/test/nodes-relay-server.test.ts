// Two nodes that cannot see each other on any network — no endpoint, no discovery: the
// secondary redeems its invite through the server relay, as the invite's throwaway peer, and
// links as a relay peer of its own grant, the tunnel keyed from the grant's key, with no
// account of its own; the cluster behaves as on a LAN: the row says `via: relay`, the brain's
// spawn in a workspace on the secondary runs there, a backup takes a replica snapshot
// through the tunnel, and the server saw ciphertext only. With the relay off in config the
// node never links that way.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditEntry, Node, Session, Workspace } from "@cophyla/protocol";
import { paths } from "../src/config/load.ts";
import { FakeServer } from "./fakes/server.ts";
import { isMethod, tempHome, waitFor } from "./helpers.ts";
import type { TestClient } from "./helpers.ts";
import { client, linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

let primary: Primary | undefined;
let secondary: Started | undefined;
let fake: FakeServer | undefined;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  await stopAll(secondary, primary?.d);
  primary = undefined;
  secondary = undefined;
  await fake?.stop();
  fake = undefined;
});

/** A home signed in to the fake: the account token on disk, the cloud pointed at it. */
function signedInHome(f: FakeServer): { home: string; toml: string } {
  const home = tempHome();
  const p = paths(home);
  mkdirSync(p.data, { recursive: true });
  writeFileSync(p.accountToken, f.mintToken() + "\n", { mode: 0o600 });
  return { home, toml: `[cloud]\nenabled = true\nurl = "${f.url}"\nallow_insecure = true\nreconnect_ms = 20\nreconnect_max_ms = 100\nhello_timeout_ms = 3000\n\n` };
}

const script = {
  on: [{ event: "user.message", match: { text: "start" }, requests: [{ method: "session.spawn", params: { harness: "claude", workspace: "$text[1]", prompt: "say hi" } }] }],
};

describe("a node link through the server relay", () => {
  test("the secondary links via the relay, is listed with via relay, and a forwarded spawn lands on it", async () => {
    fake = new FakeServer();
    const ph = signedInHome(fake);
    primary = await startPrimary({ brain: { script }, noLan: true, home: ph.home, toml: ph.toml, daemon: { cloud: { keys: [fake.publicKey] } } });
    await waitFor(() => fake!.primaryOf()?.primary === primary!.d.identity.id, 5000);
    expect(primary.d.nodes.roleOf()).toBe("primary");
    // No account on the secondary: its grant's relay token is all it needs.
    secondary = await startSecondary(primary, { noEndpoint: true, relayOnly: true, agent: true, gateRules: { "node:session.spawn": "allow" } });
    await linked(secondary, 10_000);
    expect(secondary.cloud.signedIn).toBe(false);
    expect(secondary.nodes.via()).toBe("relay");
    expect(secondary.nodes.primaryId()).toBe(primary.d.identity.id);
    expect(fake.relayedNodes).toBe(1);
    // the invite's throwaway peer was let go once it was redeemed
    const invitePeers = [...fake.relayTokens.entries()].filter(([, v]) => v.kind === "node" && v.name?.startsWith("invite for"));
    expect(invitePeers.length).toBe(1);
    await waitFor(() => invitePeers[0]![1].revoked);
    // the primary's row for it says relay, and carries no address a viewer could use
    await waitFor(() => primary!.d.nodes.linkedNodes().includes(secondary!.identity.id));
    const c = await client(primary.d);
    clients.push(c);
    const nodes = await c.request<{ nodes: Node[] }>("node.list");
    const row = nodes.nodes.find((n) => n.id === secondary!.identity.id);
    expect(row?.via).toBe("relay");
    expect(row?.status).toBe("online");
    expect(primary.d.nodes.addressOf(secondary.identity.id)).toBeUndefined();
    // the secondary's own row says relay too
    expect(secondary.node().via).toBe("relay");
    // the brain's spawn in a workspace on the secondary runs there, through the tunnel
    await waitFor(() => primary!.d.brain?.state === "up");
    const ws = secondary.workspaces.put({ node: secondary.identity.id, path: secondary.home, name: "second" });
    await waitFor(() => primary!.d.nodes.mirror.ownerOfWorkspace(ws.id) === secondary!.identity.id);
    const list = await c.request<{ workspaces: Workspace[] }>("workspace.list");
    expect(list.workspaces.find((w) => w.id === ws.id)?.node).toBe(secondary.identity.id);
    await c.request("chat.send", { text: `start ${ws.id}` });
    const state = await c.next(isMethod("session.state", (p) => (p as Session).node === secondary!.identity.id && (p as Session).native.transport === "acp"), 10_000);
    const session = state.params as Session;
    expect(session.workspace).toBe(ws.id);
    const onSecondary = secondary.store.audit.list({ limit: 50 }).filter((e: AuditEntry) => e.action === "session.spawn");
    expect(onSecondary.length).toBe(1);
    expect(onSecondary[0]!.principal).toEqual({ kind: "node", id: primary.d.identity.id });
    await c.next(isMethod("session.state", (p) => (p as Session).id === session.id && (p as Session).status === "idle"), 10_000);
    // what crossed the server: relay frames only, none of them JSON
    const frames = fake.seen.filter((m) => m === "relay").length;
    expect(frames).toBeGreaterThan(10);
    expect(fake.used["relay_messages"]).toBe(frames);
    // the server's method surface for the run
    const surface = [...new Set(fake.seen)].sort();
    for (const m of surface) expect(["auth", "entitlement.refresh", "registry.register", "registry.heartbeat", "registry.claim", "relay.grant", "relay.revoke", "relay.auth", "relay.open", "relay", "relay.close", "backup.status"]).toContain(m);
    // the secondary leaves: the primary hears, the row goes offline, the tunnel is gone
    await stopAll(secondary);
    secondary = undefined;
    await waitFor(() => !primary!.d.nodes.linkedNodes().includes(row!.id));
    await waitFor(() => fake!.relayedNodes === 0);
  });

  test("a node revoked through the relay hears why before its token goes, and forgets the cluster", async () => {
    fake = new FakeServer();
    const ph = signedInHome(fake);
    primary = await startPrimary({ noLan: true, home: ph.home, toml: ph.toml, daemon: { cloud: { keys: [fake.publicKey] } } });
    await waitFor(() => fake!.primaryOf()?.primary === primary!.d.identity.id, 5000);
    secondary = await startSecondary(primary, { noEndpoint: true, relayOnly: true, hands: true });
    await linked(secondary, 10_000);
    expect(secondary.nodes.via()).toBe("relay");
    const grant = secondary.nodes.member()!.grant;
    const c = await client(primary.d);
    clients.push(c);
    await c.request("grant.revoke", { id: grant });
    // the leave came through the tunnel ahead of the token's revoke: the node knows it was revoked, and does not knock again
    await waitFor(() => secondary!.nodes.state() === "unlinked", 5000);
    expect(existsSync(secondary.paths.linkFile)).toBe(false);
    await waitFor(() => fake!.relayTokens.get(grant)?.revoked === true, 5000);
  }, 30_000);

  test("a backup through the relay takes the replica snapshot through the tunnel", async () => {
    fake = new FakeServer();
    const ph = signedInHome(fake);
    primary = await startPrimary({ noLan: true, home: ph.home, toml: ph.toml, daemon: { cloud: { keys: [fake.publicKey] } } });
    await waitFor(() => fake!.primaryOf()?.primary === primary!.d.identity.id, 5000);
    // something to replicate: a workspace and a kv row
    primary.d.workspaces.put({ node: primary.d.identity.id, path: primary.d.home, name: "home" });
    primary.d.store.kv.put("test", "k", { v: 1 }, Date.now());
    secondary = await startSecondary(primary, { noEndpoint: true, relayOnly: true, backup: true });
    await linked(secondary, 10_000);
    expect(secondary.nodes.via()).toBe("relay");
    await waitFor(() => (secondary!.nodes.replicaState?.snapshots ?? 0) >= 1, 10_000);
    await waitFor(() => secondary!.store.kv.get("test", "k") !== undefined);
    expect(secondary.store.kv.get("test", "k")).toEqual({ v: 1 });
    // a later write streams through the same tunnel
    primary.d.store.kv.put("test", "k2", { v: 2 }, Date.now());
    await waitFor(() => secondary!.store.kv.get("test", "k2") !== undefined, 5000);
    expect(primary.d.nodes.linkedNodes()).toContain(secondary.identity.id);
  });

  test("with the relay off in config, a node whose grant holds a relay token never links through it", async () => {
    fake = new FakeServer();
    const ph = signedInHome(fake);
    primary = await startPrimary({ noLan: true, home: ph.home, toml: ph.toml, daemon: { cloud: { keys: [fake.publicKey] } } });
    await waitFor(() => fake!.primaryOf()?.primary === primary!.d.identity.id, 5000);
    // joined through the relay, then restarted with the relay off: its grant's token is there, and unused
    const joined = await startSecondary(primary, { noEndpoint: true, relayOnly: true });
    await linked(joined, 10_000);
    await joined.stop();
    await waitFor(() => fake!.relayedNodes === 0);
    writeFileSync(join(joined.home, "config.toml"), readFileSync(join(joined.home, "config.toml"), "utf8").replace("[nodes]\n", "[nodes]\nrelay = false\n"));
    const { startDaemon } = await import("../src/daemon.ts");
    const { silentLogger } = await import("../src/log.ts");
    secondary = Object.assign(await startDaemon({ home: joined.home, port: 0, log: silentLogger, brain: false, embedder: null }), { home: joined.home });
    await new Promise((r) => setTimeout(r, 800));
    expect(secondary.nodes.linked()).toBe(false);
    expect(fake.relayedNodes).toBe(0);
  });
});
