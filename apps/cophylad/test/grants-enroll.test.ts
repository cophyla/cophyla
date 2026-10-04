// Node grants on the wire. An invite is redeemed once, by one node, before it expires on
// either clock; a link's kind and its grant must agree (an invite's link enrolls and nothing
// else, a grant's link says hello as its own node alone, a phone's key opens no node link);
// no node takes the primary's id or another grant's. The link is sealed from its first record:
// a record injected or replayed on the LAN ends it, a node from before grants is told to be
// invited again, and a recording of an enrollment gives nothing to whoever reads the invite
// later. A node joins and leaves through the client methods on this machine alone, a node
// alone in a cluster of its own may give it up to join another, a revoked grant's link
// closes for good, and the shared token from before grants goes at start.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inviteText, newId, parseInvite, PROTOCOL_VERSION } from "@cophyla/protocol";
import type { InviteBody, Node } from "@cophyla/protocol";
import { derive, ephemeral, pskFromHex, pskFromSecret } from "@cophyla/relay";
import type { SealedKind } from "@cophyla/relay";
import { parseDuration, trustsPrimary } from "../src/cli.ts";
import type { Questions } from "../src/cli.ts";
import { paths } from "../src/config/load.ts";
import { readLinkFile } from "../src/grants/link-file.ts";
import { grantMethods } from "../src/grants/methods.ts";
import type { GrantMethodDeps } from "../src/grants/methods.ts";
import { silentLogger } from "../src/log.ts";
import { redeemNodeInvite } from "../src/nodes/enroll.ts";
import { BEFORE_GRANTS } from "../src/nodes/inbound.ts";
import { openDirect } from "../src/nodes/outbound.ts";
import type { LinkSocket } from "../src/nodes/outbound.ts";
import { sealLan } from "../src/nodes/sealed-link.ts";
import { RpcPeer } from "../src/rpc/peer.ts";
import { tempHome, TestClient, waitFor } from "./helpers.ts";
import { client, grantFor, inviteOn, linked, rogueNode, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

const primaries: Primary[] = [];
const started: Started[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  await stopAll(...started, ...primaries.map((p) => p.d));
  started.length = 0;
  primaries.length = 0;
});

async function primaryUp(): Promise<Primary> {
  const p = await startPrimary();
  primaries.push(p);
  return p;
}

async function body(p: Primary, opts: Parameters<typeof inviteOn>[1] = {}): Promise<InviteBody> {
  return parseInvite(await inviteOn(p, opts));
}

const outcome = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => "ok",
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );

/** A raw LAN socket to the primary whose frames both ways are recorded. */
async function recorded(p: Primary): Promise<{ raw: LinkSocket; sent: string[]; received: string[] }> {
  const raw = await openDirect(p.endpoint, 5000);
  const sent: string[] = [];
  const received: string[] = [];
  const send = raw.send.bind(raw);
  raw.send = (text) => {
    sent.push(text);
    return send(text);
  };
  raw.onMessage((text) => void received.push(text));
  return { raw, sent, received };
}

/** An RPC peer on a sealed link, and a promise of how the link closed. */
function rpcOn(sock: LinkSocket): { rpc: RpcPeer; closed: Promise<{ code: number; reason: string }> } {
  const rpc = new RpcPeer({ write: (text) => sock.send(text), log: silentLogger, label: "test", onRequest: () => ({}) });
  sock.onMessage((text) => rpc.onText(text));
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    sock.onClose((code, reason) => {
      rpc.close("closed");
      resolve({ code, reason });
    }),
  );
  return { rpc, closed };
}

async function seal(p: Primary, grant: string, kind: SealedKind, psk: Uint8Array<ArrayBuffer>): Promise<LinkSocket> {
  return sealLan(await openDirect(p.endpoint, 5000), { grant, kind, psk, timeoutMs: 5000 });
}

describe("an invite is redeemed once", () => {
  test("a second redemption finds it spent, and of two at once exactly one wins", async () => {
    const p = await primaryUp();
    const invite = await body(p);
    const first = await redeemNodeInvite(invite, { id: newId("node"), name: "first" }, { timeoutMs: 5000, log: silentLogger });
    expect(first.grant).toBe(invite.grant);
    expect(first.cluster).toBe(p.d.nodes.member()!.cluster);
    expect(await outcome(redeemNodeInvite(invite, { id: newId("node"), name: "second" }, { timeoutMs: 5000, log: silentLogger }))).toMatch(/cannot link here/);
    // two at once: the check and the burn have nothing awaited between them
    const race = await body(p);
    const results = await Promise.allSettled([1, 2].map((n) => redeemNodeInvite(race, { id: newId("node"), name: `racer ${n}` }, { timeoutMs: 5000, log: silentLogger })));
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    const bound = p.d.grants.get(race.grant)!;
    expect(bound.invite).toBeUndefined();
    expect(p.d.grants.status(bound)).toBe("active");
  }, 20_000);

  test("an expired invite is refused by the redeemer's clock and by the primary's", async () => {
    const p = await primaryUp();
    const invite = await body(p, { inviteExpiresIn: 50 });
    await Bun.sleep(100);
    expect(await outcome(redeemNodeInvite(invite, { id: newId("node"), name: "late" }, { timeoutMs: 5000, log: silentLogger }))).toMatch(/expired/);
    // a redeemer whose clock is behind still meets the primary's
    expect(await outcome(redeemNodeInvite(invite, { id: newId("node"), name: "late" }, { timeoutMs: 5000, log: silentLogger, now: invite.expiresAt - 60_000 }))).toMatch(/cannot link here/);
  }, 20_000);

  test("no node takes the primary's id, or an id another grant holds", async () => {
    const p = await primaryUp();
    const taken = newId("node");
    grantFor(p.d, taken);
    for (const id of [p.d.identity.id, taken]) {
      const invite = await body(p);
      const { rpc, closed } = rpcOn(await seal(p, invite.grant, "enroll", await pskFromSecret(invite.secret)));
      expect(await outcome(rpc.request("node.enroll", { node: { id, name: "impostor" } }, { timeoutMs: 5000 }))).toMatch(/cannot join itself|already holds/);
      await closed;
      // the invite is still open: nothing was bound
      expect(p.d.grants.pending(invite.grant)).toBeDefined();
    }
  }, 20_000);
});

describe("a link's kind and its grant agree", () => {
  test("the kind-confusion matrix: every mismatch is refused at the hello or inside the link", async () => {
    const p = await primaryUp();
    const cluster = p.d.nodes.member()!.cluster;
    const nodeId = newId("node");
    const active = grantFor(p.d, nodeId);
    const pending = await body(p);
    const phone = p.d.grants.createController("a phone");
    // an invite's link naming a grant already redeemed, keyed from its key
    expect(await outcome(seal(p, active.grant, "enroll", pskFromHex(active.key)))).toMatch(/cannot link here/);
    // a grant's link naming a grant not yet redeemed, keyed from the invite's secret
    expect(await outcome(seal(p, pending.grant, "node", await pskFromSecret(pending.secret)))).toMatch(/cannot link here/);
    // a node's link naming a phone's grant, keyed from the phone's key
    expect(await outcome(seal(p, phone.controller.id, "node", pskFromHex(phone.key)))).toMatch(/cannot link here/);
    expect(await outcome(seal(p, phone.controller.id, "enroll", pskFromHex(phone.key)))).toMatch(/cannot link here/);
    // an invite's link asked for a hello
    const enrolling = rpcOn(await seal(p, pending.grant, "enroll", await pskFromSecret(pending.secret)));
    expect(await outcome(enrolling.rpc.request("node.hello", { protocolVersion: PROTOCOL_VERSION, platformVersion: "0.0.0", nodeId, cluster }, { timeoutMs: 5000 }))).toMatch(/node.enroll alone/);
    await enrolling.closed;
    // a grant's link asked to enroll
    const joining = rpcOn(await seal(p, active.grant, "node", pskFromHex(active.key)));
    expect(await outcome(joining.rpc.request("node.enroll", { node: { id: nodeId, name: "again" } }, { timeoutMs: 5000 }))).toMatch(/join first/);
    // a grant's link saying hello as another node
    expect(await outcome(joining.rpc.request("node.hello", { protocolVersion: PROTOCOL_VERSION, platformVersion: "0.0.0", nodeId: newId("node"), cluster }, { timeoutMs: 5000 }))).toMatch(/another node's/);
    expect((await joining.closed).code).toBe(4401);
    // and none of it reached the gate as a join
    expect(p.d.store.audit.list({ limit: 50 }).filter((e) => e.principal.kind === "node" && e.action === "hello")).toEqual([]);
  }, 20_000);
});

describe("the link is sealed from its first record", () => {
  test("a record injected, or one replayed, on the LAN ends the link", async () => {
    const p = await primaryUp();
    for (const attack of ["inject", "replay"] as const) {
      const id = newId("node");
      const grant = grantFor(p.d, id);
      const { raw, sent } = await recorded(p);
      const sock = await sealLan(raw, { grant: grant.grant, kind: "node", psk: pskFromHex(grant.key), timeoutMs: 5000 });
      const { rpc, closed } = rpcOn(sock);
      await rpc.request("node.hello", { protocolVersion: PROTOCOL_VERSION, platformVersion: "0.0.0", nodeId: id, cluster: p.d.nodes.member()!.cluster });
      await rpc.request("node.join", { node: rogueNode(id), endpoints: [], epoch: 1, backup: false, sessions: [], workspaces: [], asks: [] });
      await waitFor(() => p.d.nodes.linkedTo(id));
      // what a man in the middle can do without the key: a record of his own, or one he saw go by
      if (attack === "inject") raw.send(Buffer.from("not a record the key made").toString("base64"));
      else raw.send(sent[2]!);
      const how = await closed;
      expect(how.code).toBe(4403);
      await waitFor(() => !p.d.nodes.linkedTo(id));
    }
  }, 20_000);

  test("a node from before grants is told to be invited again", async () => {
    const p = await primaryUp();
    const raw = await openDirect(p.endpoint, 5000);
    const answers: string[] = [];
    raw.onMessage((text) => void answers.push(text));
    const closed = new Promise<{ code: number; reason: string }>((resolve) => raw.onClose((code, reason) => resolve({ code, reason })));
    raw.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node.hello", params: { protocolVersion: PROTOCOL_VERSION, platformVersion: "0.1.0", nodeId: newId("node"), cluster: "0123456789abcdef", nonce: "00".repeat(16) } }));
    const how = await closed;
    expect(how).toEqual({ code: 4401, reason: BEFORE_GRANTS });
    expect(JSON.parse(answers[0]!)).toMatchObject({ id: 1, error: { message: BEFORE_GRANTS } });
  }, 20_000);

  test("a recording of an enrollment, and the invite read later, give nothing: no key in the clear, no record that opens", async () => {
    const p = await primaryUp();
    const invite = await body(p);
    const { raw, sent, received } = await recorded(p);
    const sock = await sealLan(raw, { grant: invite.grant, kind: "enroll", psk: await pskFromSecret(invite.secret), timeoutMs: 5000 });
    const { rpc, closed } = rpcOn(sock);
    const answer = (await rpc.request("node.enroll", { node: { id: newId("node"), name: "recorded" } })) as { key: string };
    await closed;
    const wire = [...sent, ...received].join("\n");
    expect(wire).not.toContain(answer.key);
    expect(wire).not.toContain(invite.secret);
    // Whoever holds the recording and the invite has the pre-shared key and both public keys, but no private one.
    const answerFrame = JSON.parse(received[0]!) as { epk: string };
    const guess = await derive("initiator", await ephemeral(), answerFrame.epk, await pskFromSecret(invite.secret), { kind: "enroll", peer: invite.grant });
    expect(await outcome(guess.open(received[1]!))).not.toBe("ok");
  }, 20_000);
});

describe("joining and leaving", () => {
  test("a node joins and leaves through the client methods, and joins again with a new invite", async () => {
    const p = await primaryUp();
    const s = await startSecondary(p, { unjoined: true });
    started.push(s);
    expect(s.nodes.state()).toBe("unlinked");
    const c = await client(s);
    clients.push(c);
    const joined = await c.request<{ primary: { id: string; name: string }; role: string }>("node.join", { invite: await inviteOn(p, { role: "hands" }) });
    expect(joined).toEqual({ primary: { id: p.d.identity.id, name: p.d.identity.name }, role: "hands" });
    await linked(s);
    expect(readLinkFile(s.paths.linkFile)).toMatchObject({ via: "join", role: "hands", cluster: p.d.nodes.member()!.cluster });
    // a hands node never stands by
    expect(p.d.nodes.registry.get(s.identity.id)).toMatchObject({ hands: true });
    expect(p.d.nodes.registry.get(s.identity.id)?.backup).toBeUndefined();
    // linking closed this machine's clients, to reconnect into the new mode: the rest comes on a new one
    await c.closed;
    const c2 = await client(s);
    clients.push(c2);
    // in a cluster already: a second join is refused
    const again = await c2.call("node.join", { invite: await inviteOn(p) });
    expect("error" in again && again.error.data?.code).toBe("conflict");
    await c2.request("node.leave", {});
    expect(s.nodes.state()).toBe("unlinked");
    expect(existsSync(s.paths.linkFile)).toBe(false);
    // it left for good: the primary gave its grant up and forgot it
    await waitFor(() => p.d.nodes.registry.get(s.identity.id) === undefined);
    expect(p.d.grants.forNode(s.identity.id)).toBeUndefined();
    const c3 = await client(s);
    clients.push(c3);
    await c3.request("node.join", { invite: await inviteOn(p) });
    await linked(s);
    expect(s.nodes.member()?.role).toBe("full");
  }, 30_000);

  test("joining and leaving are asked on this machine alone", async () => {
    const calls: string[] = [];
    const deps: GrantMethodDeps = {
      grants: {} as GrantMethodDeps["grants"],
      nodes: {
        invite: async () => Promise.reject(new Error("unused")),
        join: async () => {
          calls.push("join");
          return { primary: { id: newId("node"), name: "p" }, role: "full" };
        },
        leave: async () => void calls.push("leave"),
        revoke: async () => undefined,
      },
      revokeController: () => undefined,
      phones: { invite: async () => Promise.reject(new Error("unused")) },
    };
    const table = grantMethods(deps);
    const ctx = (listener: "loopback" | "controller" | "cloud") => ({ listener, client: { id: newId("client"), kind: "controller" }, principal: { kind: "client", id: "c" }, origin: "x" }) as never;
    for (const listener of ["controller", "cloud"] as const) {
      expect(await outcome(Promise.resolve().then(() => table["node.join"]!.handler({ invite: "x" }, ctx(listener))))).toMatch(/this machine alone/);
      expect(await outcome(Promise.resolve().then(() => table["node.leave"]!.handler({}, ctx(listener))))).toMatch(/this machine alone/);
    }
    expect(calls).toEqual([]);
    await table["node.join"]!.handler({ invite: "x" }, ctx("loopback"));
    expect(calls).toEqual(["join"]);
  });

  test("a primary alone in a cluster of its own gives it up to join another", async () => {
    const p = await primaryUp();
    const alone = await startPrimary();
    primaries.push(alone);
    const own = alone.d.nodes.member()!;
    expect(own.via).toBe("self");
    expect(alone.d.nodes.roleOf()).toBe("primary");
    await alone.d.nodes.join(await inviteOn(p));
    await linked(alone.d);
    expect(alone.d.nodes.roleOf()).toBe("secondary");
    expect(alone.d.nodes.primaryId()).toBe(p.d.identity.id);
    expect(alone.d.nodes.member()).toMatchObject({ via: "join", cluster: p.d.nodes.member()!.cluster });
    expect(alone.d.grants.get(own.grant)).toBeUndefined();
    // a primary with another node in its cluster may not
    const q = await primaryUp();
    expect(await outcome(p.d.nodes.join(await inviteOn(q)))).toMatch(/other nodes, or open invites, in it/);
  }, 30_000);

  test("a primary alone that joins as hands hears its old cluster's registry no more", async () => {
    const p = await primaryUp();
    const alone = await startPrimary();
    primaries.push(alone);
    const signals = () => (alone.d.nodes as unknown as { offArbiter: unknown[] }).offArbiter.length;
    expect(signals()).toBeGreaterThan(0);
    await alone.d.nodes.join(await inviteOn(p, { role: "hands" }));
    await linked(alone.d);
    expect(alone.d.nodes.member()?.role).toBe("hands");
    expect(signals()).toBe(0);
  }, 30_000);

  test("a revoked grant's link closes, the node is forgotten, and it is refused after", async () => {
    const p = await primaryUp();
    const s = await startSecondary(p);
    started.push(s);
    await linked(s);
    const grant = s.nodes.member()!.grant;
    const c = await client(p.d);
    clients.push(c);
    await c.request("grant.revoke", { id: grant });
    await waitFor(() => !s.nodes.linked());
    expect(p.d.grants.get(grant)).toBeUndefined();
    expect(p.d.nodes.registry.get(s.identity.id)).toBeUndefined();
    const list = await c.request<{ nodes: Node[] }>("node.list");
    expect(list.nodes.map((n) => n.id)).not.toContain(s.identity.id);
    await Bun.sleep(600);
    expect(s.nodes.linked()).toBe(false);
    expect(p.d.nodes.linkedNodes()).not.toContain(s.identity.id);
  }, 20_000);
});

describe("from before grants", () => {
  test("the shared token goes at start, and a secondary that had only it starts unlinked", async () => {
    const home = tempHome();
    const p = paths(home);
    mkdirSync(p.data, { recursive: true });
    writeFileSync(p.legacyNodeToken, "5".repeat(64) + "\n");
    writeFileSync(p.config, `[sessions]\ndiscover = false\ninstall_hooks = false\n\n[node]\nrole = "secondary"\n\n[nodes]\ntoken = "${"5".repeat(64)}"\nprimary = "127.0.0.1:1"\ndiscovery = false\n`);
    const { startDaemon } = await import("../src/daemon.ts");
    const d = Object.assign(await startDaemon({ home, port: 0, log: silentLogger, brain: false, embedder: null }), { home });
    started.push(d);
    expect(existsSync(p.legacyNodeToken)).toBe(false);
    expect(d.nodes.state()).toBe("unlinked");
    expect(d.nodes.member()).toBeUndefined();
    expect(existsSync(join(home, "data", "link.json"))).toBe(false);
  });

  test("durations for the command line", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("12h")).toBe(43_200_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("2500")).toBe(2500);
    expect(() => parseDuration("soon")).toThrow(/not a duration/);
    expect(() => parseDuration("0h")).toThrow(/more than nothing/);
  });

  test("join asks whether the primary works here unasked: a no keeps the asks, anything else and no terminal are a yes", async () => {
    const invite = inviteText({ v: 1, kind: "node", grant: newId("grant"), secret: "ab".repeat(32), expiresAt: Date.now() + 60_000, node: { id: newId("node"), name: "study" } });
    const asked: string[] = [];
    const answering = (answer: string): Questions => ({ ask: async (q) => (asked.push(q), answer), close: () => {} });
    expect(await trustsPrimary(invite, {}, answering("n"))).toBe(false);
    expect(await trustsPrimary(invite, {}, answering(" No"))).toBe(false);
    expect(await trustsPrimary(invite, {}, answering(""))).toBe(true);
    expect(await trustsPrimary(invite, {}, answering("yes"))).toBe(true);
    expect(asked[0]).toMatch(/^Let study start sessions and terminals, .* without asking each time\? \[Y\/n\] $/);
    asked.length = 0;
    expect(await trustsPrimary(invite, {})).toBe(true);
    expect(await trustsPrimary(invite, { ask: true }, answering("y"))).toBe(false);
    expect(await trustsPrimary(invite, { trust: true }, answering("n"))).toBe(true);
    expect(await trustsPrimary("cophyla-invite:damaged", {}, answering("n"))).toBe(true);
    expect(asked).toEqual([]);
    expect(await trustsPrimary(invite, { ask: true, trust: true }).then(String, (e: unknown) => (e as Error).message)).toMatch(/give one/);
  });
});
