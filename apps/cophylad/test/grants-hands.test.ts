// A hands node, and the ends of grants. On the primary a hands node relays no client, pairs
// no viewer, raises no custom event, is never a backup, and is sent only the primary's and
// the backups' rows; a machine on the primary's own account cannot join as hands. On the
// guest, its own clients stay its own, it takes no takeover, and only the audit rows the
// primary's requests made go up. A grant ends one way, revoked or run out: the node hears it
// inside its link and forgets the cluster, a phone's sockets close (on a backup too, when the
// replica loses its row), a pending invite goes with its relay peer. Removing a full node that
// held the replica re-keys every other node over its live link, and marks the offline ones to
// be invited again. A guest follows the backup that takes over.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { newId, parseInvite } from "@cophyla/protocol";
import type { AuditEntry, Client, NodeRecord } from "@cophyla/protocol";
import { paths } from "../src/config/load.ts";
import { readLinkFile } from "../src/grants/link-file.ts";
import { silentLogger } from "../src/log.ts";
import { redeemNodeInvite } from "../src/nodes/enroll.ts";
import { FakeServer } from "./fakes/server.ts";
import { tempHome, TestClient, waitFor } from "./helpers.ts";
import { client, grantFor, inviteOn, linked, rogueLink, sealedLink, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Rogue, Started } from "./nodes-helpers.ts";

const primaries: Primary[] = [];
const started: Started[] = [];
const clients: TestClient[] = [];
const rogues: Rogue[] = [];
let fake: FakeServer | undefined;

afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  for (const r of rogues) r.close();
  rogues.length = 0;
  await stopAll(...started, ...primaries.map((p) => p.d));
  started.length = 0;
  primaries.length = 0;
  await fake?.stop();
  fake = undefined;
});

async function primaryUp(opts: Parameters<typeof startPrimary>[0] = {}): Promise<Primary> {
  const p = await startPrimary(opts);
  primaries.push(p);
  return p;
}

async function secondaryOf(p: Primary, opts: Parameters<typeof startSecondary>[1] = {}): Promise<Started> {
  const s = await startSecondary(p, opts);
  started.push(s);
  await linked(s, 8000);
  return s;
}

const outcome = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => "ok",
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );

/** A phone paired on `d`, on its LAN listener. */
async function phoneOn(d: Started, token: string): Promise<TestClient> {
  const c = await TestClient.connect(`wss://127.0.0.1:${d.controller!.port}/ws/client`, { insecure: true });
  clients.push(c);
  await c.request<{ client: Client }>("hello", { token, kind: "controller", audio: { in: false, out: false } });
  return c;
}

describe("a hands node on the primary", () => {
  test("it relays no client, pairs no viewer, raises no custom event, is never a backup, and hears only the primary and the backups", async () => {
    const p = await primaryUp();
    const backup = await secondaryOf(p, { backup: true });
    const plain = await secondaryOf(p);
    const heard: string[] = [];
    p.d.events.on((e) => void heard.push(e.name));
    const rogue = await rogueLink(p, { hands: true, backup: true });
    rogues.push(rogue);
    // asked to be a backup, it is not; its row says hands
    expect(p.d.nodes.registry.get(rogue.id)).toMatchObject({ hands: true });
    expect(p.d.nodes.registry.get(rogue.id)?.backup).toBeUndefined();
    expect(await outcome(rogue.rpc.request("replicate.snapshot", {}))).toMatch(/not a backup/);
    expect(await outcome(rogue.rpc.request("relay.open", { peer: "p1", client: { kind: "ui", audio: { in: false, out: false } }, origin: "https://x" }))).toMatch(/clients are its own/);
    expect(await outcome(rogue.rpc.request("remote.pair", { node: backup.identity.id, pin: "123456" }))).toMatch(/pairs no viewer/);
    rogue.notify("event.custom", { name: "user.whatever", data: {} });
    await Bun.sleep(200);
    expect(heard).not.toContain("event.custom");
    // the registry it is sent: the primary and the backup, not the plain secondary
    p.d.nodes.registry.upsert({ ...p.d.nodes.registry.get(plain.identity.id)!, lastSeen: Date.now() });
    (p.d.nodes as unknown as { inbound: { broadcastRegistry(): void } }).inbound.broadcastRegistry();
    const update = await waitFor(() => rogue.frames.filter((f) => f.method === "registry.update").at(-1));
    const ids = (update.params as { nodes: NodeRecord[] }).nodes.map((n) => n.id);
    expect(ids).toContain(p.d.identity.id);
    expect(ids).toContain(backup.identity.id);
    expect(ids).not.toContain(plain.identity.id);
    expect(ids).not.toContain(rogue.id);
  }, 40_000);

  test("a machine signed in to the primary's own account cannot join as hands", async () => {
    fake = new FakeServer();
    const home = tempHome();
    const hp = paths(home);
    mkdirSync(hp.data, { recursive: true });
    writeFileSync(hp.accountToken, fake.mintToken() + "\n", { mode: 0o600 });
    const p = await primaryUp({ home, toml: `[cloud]\nenabled = true\nurl = "${fake.url}"\nallow_insecure = true\nreconnect_ms = 20\n\n`, daemon: { cloud: { keys: [fake.publicKey] } } });
    await waitFor(() => p.d.cloud.account !== undefined, 5000);
    const own = p.d.cloud.account!;
    const hands = parseInvite(await inviteOn(p, { role: "hands" }));
    expect(await outcome(redeemNodeInvite(hands, { id: newId("node"), name: "mine" }, { timeoutMs: 5000, log: silentLogger, account: own }))).toMatch(/joins as a full node/);
    // the invite is still open, for a machine that is not on the account
    expect((await redeemNodeInvite(hands, { id: newId("node"), name: "guest" }, { timeoutMs: 5000, log: silentLogger, account: "usr_someone_else" })).role).toBe("hands");
    // a full invite takes a machine on the account
    const full = parseInvite(await inviteOn(p, { role: "full" }));
    expect((await redeemNodeInvite(full, { id: newId("node"), name: "mine" }, { timeoutMs: 5000, log: silentLogger, account: own })).role).toBe("full");
  }, 30_000);
});

describe("a hands node, the guest's side", () => {
  test("its own clients stay its own, it takes no takeover, and only the primary's doings go up in the audit", async () => {
    const p = await primaryUp();
    const guest = await secondaryOf(p, { hands: true, gateRules: { "node:session.list": "allow" } });
    // a client of the guest is served there, not relayed to the primary
    const c = await client(guest);
    clients.push(c);
    const listed = await c.request<{ nodes: NodeRecord[] }>("node.list");
    expect(listed.nodes.map((n) => n.id)).toContain(guest.identity.id);
    expect(p.d.clients.list().some((cl) => cl.name === "test")).toBe(false);
    // the primary's takeover is refused
    const inbound = (p.d.nodes as unknown as { inbound: { forward(node: string, method: string, params: unknown): Promise<unknown> } }).inbound;
    expect(await outcome(inbound.forward(guest.identity.id, "node.takeover", { epoch: 99 }))).toMatch(/never takes the primary role/);
    expect(guest.nodes.roleOf()).toBe("secondary");
    // a request of the guest's own client is audited there and stays there; one the primary made goes up
    const up: AuditEntry[] = [];
    p.d.bus.on("audit.entry", (e) => {
      if ((e as AuditEntry).node === guest.identity.id) up.push(e as AuditEntry);
    });
    await c.request("view.list");
    await inbound.forward(guest.identity.id, "session.list", {});
    await waitFor(() => up.some((e) => e.principal.kind === "node" && e.action === "session.list"));
    await Bun.sleep(200);
    expect(up.every((e) => e.principal.kind === "node")).toBe(true);
    expect(guest.store.audit.list({ limit: 200 }).some((e: AuditEntry) => e.action === "view.list")).toBe(true);
  }, 30_000);
});

describe("the ends of grants", () => {
  test("a revoked node hears it inside its link and forgets the cluster", async () => {
    const p = await primaryUp();
    const guest = await secondaryOf(p, { hands: true });
    const c = await client(p.d);
    clients.push(c);
    await c.request("grant.revoke", { id: guest.nodes.member()!.grant });
    await waitFor(() => guest.nodes.state() === "unlinked", 5000);
    expect(guest.nodes.member()).toBeUndefined();
    expect(existsSync(guest.paths.linkFile)).toBe(false);
  }, 30_000);

  test("a node grant runs out on both sides; a pending invite runs out with its row", async () => {
    const p = await primaryUp();
    const s = await startSecondary(p, { unjoined: true });
    started.push(s);
    await s.nodes.join(await inviteOn(p, { role: "hands", expiresIn: 1500 }));
    await linked(s);
    const grant = s.nodes.member()!.grant;
    expect(readLinkFile(s.paths.linkFile)?.expiresAt).toBeDefined();
    await waitFor(() => s.nodes.state() === "unlinked", 6000);
    await waitFor(() => p.d.grants.get(grant) === undefined, 3000);
    expect(p.d.nodes.registry.get(s.identity.id)).toBeUndefined();
    // an invite nobody redeemed goes when it runs out
    const pending = parseInvite(await inviteOn(p, { inviteExpiresIn: 300 }));
    expect(p.d.grants.get(pending.grant)).toBeDefined();
    await waitFor(() => p.d.grants.get(pending.grant) === undefined, 3000);
  }, 30_000);

  test("a phone whose grant runs out is closed; a revoke on the primary closes its socket on a backup", async () => {
    const p = await primaryUp();
    const backup = await secondaryOf(p, { backup: true, controller: true });
    await waitFor(() => (backup.nodes.replicaState?.snapshots ?? 0) >= 1, 5000);
    // a phone of the primary, on the backup's own listener: the backup knows its grant from the replica
    const phone = p.d.grants.createController("travel phone");
    await waitFor(() => backup.grants.get(phone.controller.id) !== undefined, 5000);
    const onBackup = await phoneOn(backup, phone.token);
    const c = await client(p.d);
    clients.push(c);
    await c.request("grant.revoke", { id: phone.controller.id });
    // relayed to the primary, it is closed from there; the replica loses the row, and a socket the backup still held would go with it
    expect([1000, 4401]).toContain((await onBackup.closed).code);
    await waitFor(() => backup.grants.get(phone.controller.id) === undefined, 5000);
    // one that runs out on the primary
    const brief = p.d.grants.createController("brief phone", { expiresAt: Date.now() + 800 });
    const onPrimary = await phoneOn(p.d, brief.token);
    expect((await onPrimary.closed).code).toBe(4401);
    expect(p.d.grants.get(brief.controller.id)).toBeUndefined();
  }, 30_000);
});

describe("re-keying", () => {
  test("removing a full node that held the replica re-keys the linked nodes and marks the others to be invited again", async () => {
    const p = await primaryUp();
    const backup = await secondaryOf(p, { backup: true });
    await waitFor(() => (backup.nodes.replicaState?.snapshots ?? 0) >= 1, 5000);
    const full = await secondaryOf(p);
    const guest = await secondaryOf(p, { hands: true });
    const offline = newId("node");
    const offlineGrant = grantFor(p.d, offline);
    const before = { full: readLinkFile(full.paths.linkFile)!.key, guest: readLinkFile(guest.paths.linkFile)!.key, self: readLinkFile(p.d.paths.linkFile)!.key };
    expect(p.d.grants.get(backup.nodes.member()!.grant)?.replica).toBe(true);
    const c = await client(p.d);
    clients.push(c);
    await c.request("grant.revoke", { id: backup.nodes.member()!.grant });
    await waitFor(() => readLinkFile(full.paths.linkFile)!.key !== before.full && readLinkFile(guest.paths.linkFile)!.key !== before.guest, 5000);
    // the primary keeps the same new keys, its own too
    expect(p.d.grants.get(full.nodes.member()!.grant)?.key).toBe(readLinkFile(full.paths.linkFile)!.key);
    expect(p.d.grants.get(guest.nodes.member()!.grant)?.key).toBe(readLinkFile(guest.paths.linkFile)!.key);
    expect(readLinkFile(p.d.paths.linkFile)!.key).not.toBe(before.self);
    expect(p.d.grants.status(p.d.grants.get(offlineGrant.grant)!)).toBe("reinvite");
    // the old key opens nothing now; the new one links after a restart
    const old = await sealedLink(p, { grant: full.nodes.member()!.grant, key: before.full });
    expect(await outcome(old.rpc.request("node.hello", { protocolVersion: 1, platformVersion: "0", nodeId: full.identity.id, cluster: p.d.nodes.member()!.cluster }, { timeoutMs: 3000 }))).not.toBe("ok");
    old.close();
    expect(await outcome(sealedLink(p, { grant: offlineGrant.grant, key: offlineGrant.key }))).toMatch(/cannot link here/);
    const home = full.home;
    await full.stop();
    started.splice(started.indexOf(full), 1);
    const { startDaemon } = await import("../src/daemon.ts");
    const again = Object.assign(await startDaemon({ home, port: 0, log: silentLogger, brain: false, embedder: null }), { home });
    started.push(again);
    await linked(again, 8000);
  }, 40_000);
});

describe("failover with grants", () => {
  test("a guest follows the backup that takes over", async () => {
    const p = await primaryUp();
    const backup = await secondaryOf(p, { backup: true, failoverMs: 300 });
    await waitFor(() => (backup.nodes.replicaState?.snapshots ?? 0) >= 1, 5000);
    const guest = await secondaryOf(p, { hands: true });
    // the guest was told where the backup is
    await waitFor(() => guest.nodes.registry.get(backup.identity.id) !== undefined, 5000);
    await p.d.stop();
    primaries.length = 0;
    await waitFor(() => backup.nodes.roleOf() === "primary", 10_000);
    await waitFor(() => guest.nodes.linked() && guest.nodes.primaryId() === backup.identity.id, 10_000);
    expect(guest.nodes.roleOf()).toBe("secondary");
    expect(backup.nodes.linkedNodes()).toContain(guest.identity.id);
  }, 40_000);
});
