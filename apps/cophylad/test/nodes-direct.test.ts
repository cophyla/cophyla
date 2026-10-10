// Two nodes on no common network, linked through the server relay, each with direct
// connections on and a fake helper joined on one wire: the secondary offers the link a data
// channel (its first candidate crossing ahead of the offer, which the primary keeps for it,
// as the channel opens only once the primary's helper holds one), the link's frames move to it (the primary's row says `p2p`, both states list the
// other node), and what rides the link carries on across it; the secondary's helper killed,
// the link falls back to the relay with no `node.left`, and switches again once the helper is
// back. A primary with links kept off direct connections answers `unsupported`, and the
// secondary asks no more.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NodeRecord, Workspace } from "@cophyla/protocol";
import { paths } from "../src/config/load.ts";
import { FakeNet, FakeWire } from "./fakes/net.ts";
import { FakeServer } from "./fakes/server.ts";
import { tempHome, waitFor } from "./helpers.ts";
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

function signedInHome(f: FakeServer, extra = ""): { home: string; toml: string } {
  const home = tempHome();
  const p = paths(home);
  mkdirSync(p.data, { recursive: true });
  writeFileSync(p.accountToken, f.mintToken() + "\n", { mode: 0o600 });
  return { home, toml: `[cloud]\nenabled = true\nurl = "${f.url}"\nallow_insecure = true\nreconnect_ms = 20\nreconnect_max_ms = 100\nhello_timeout_ms = 3000\n\n[direct]\nrestart_backoff_ms = 50\n${extra}\n` };
}

const TIMING = { firstTryMs: 100, retryMs: [300] };

async function start(opts: { primaryLinks?: boolean } = {}) {
  fake = new FakeServer();
  const wire = new FakeWire();
  const netP = new FakeNet();
  const netS = new FakeNet();
  netP.wire = wire;
  netS.wire = wire;
  const ph = signedInHome(fake, opts.primaryLinks === false ? "nodes = false\n" : "");
  primary = await startPrimary({ noLan: true, heartbeatMs: 1000, home: ph.home, toml: ph.toml, daemon: { cloud: { keys: [fake.publicKey] }, direct: { spawn: netP.spawn, command: () => "cophyla-net" } } });
  await waitFor(() => fake!.primaryOf()?.primary === primary!.d.identity.id, 5000);
  await primary.d.direct.enable();
  await waitFor(() => primary!.d.direct.ready, 5000);
  const sh = signedInHome(fake);
  secondary = await startSecondary(
    primary,
    { noEndpoint: true, relayOnly: true, home: sh.home, toml: sh.toml, heartbeatMs: 1000, daemon: { cloud: { keys: [fake.publicKey] }, direct: { spawn: netS.spawn, command: () => "cophyla-net", link: TIMING } } },
  );
  await waitFor(() => secondary!.cloud.state().connected === true, 5000);
  await secondary.direct.enable();
  await waitFor(() => secondary!.direct.ready, 5000);
  await linked(secondary, 10_000);
  expect(secondary.nodes.via()).toBe("relay");
  return { primary, secondary, netP, netS, wire };
}

describe("a relayed node link's data channel", () => {
  test("switches to the channel, carries the link on it, falls back with no node.left when the helper dies, and switches again", async () => {
    const { primary: p, secondary: s, netS } = await start();
    const left: string[] = [];
    p.d.bus.on("node.left", (e) => left.push(e.node));
    const c = await client(p.d);
    clients.push(c);
    // the primary's row says the link is on a data channel, and both states list the other node
    const row = async () => (await c.request<{ nodes: NodeRecord[] }>("node.list")).nodes.find((n) => n.id === s.identity.id)!;
    await waitFor(() => p.d.direct.state().peers.some((x) => x.kind === "node" && x.id === s.identity.id), 8000);
    await waitFor(() => p.d.nodes.forwardHost.registryList().find((n) => n.id === s.identity.id)?.p2p, 8000);
    expect((await row()).p2p).toMatchObject({ path: "srflx" });
    expect(s.direct.state().peers).toEqual([expect.objectContaining({ kind: "node", id: p.d.identity.id, path: "srflx", rttMs: 12 })]);
    const relayedBefore = fake!.seen.filter((m) => m === "relay").length;
    // the link carries on over the channel: a workspace on the secondary reaches the primary's list
    const ws = s.workspaces.put({ node: s.identity.id, path: s.home, name: "over-the-channel" });
    await waitFor(() => p.d.nodes.mirror.ownerOfWorkspace(ws.id) === s.identity.id, 5000);
    const list = await c.request<{ workspaces: Workspace[] }>("workspace.list");
    expect(list.workspaces.some((w) => w.id === ws.id)).toBe(true);
    // on the channel the relay is quiet: a heartbeat or two at most crossed it, never the workspace
    expect(fake!.seen.filter((m) => m === "relay").length - relayedBefore).toBeLessThan(4);

    // the secondary's helper dies: the link falls back, nobody is called gone, the row says relay
    netS.live!.crash();
    await waitFor(() => s.direct.state().peers.length === 0, 5000);
    mkdirSync(join(s.home, "w2"), { recursive: true });
    const ws2 = s.workspaces.put({ node: s.identity.id, path: join(s.home, "w2"), name: "over-the-relay" });
    await waitFor(() => p.d.nodes.mirror.ownerOfWorkspace(ws2.id) === s.identity.id, 5000);
    expect(p.d.nodes.linkedNodes()).toContain(s.identity.id);
    expect(left).toEqual([]);
    // back: the helper up again, the link on a channel again
    await waitFor(() => s.direct.ready && netS.helpers.length === 2, 5000);
    await waitFor(() => s.direct.state().peers.some((x) => x.kind === "node"), 8000);
    mkdirSync(join(s.home, "w3"), { recursive: true });
    const ws3 = s.workspaces.put({ node: s.identity.id, path: join(s.home, "w3"), name: "on-the-new-channel" });
    await waitFor(() => p.d.nodes.mirror.ownerOfWorkspace(ws3.id) === s.identity.id, 5000);
    expect(left).toEqual([]);
    expect(s.nodes.primaryId()).toBe(p.d.identity.id);
  });

  test("the candidate the secondary's helper gave as it made the offer crosses ahead of the offer; the primary keeps it for the offer, and the channel opens", async () => {
    const { secondary: s, netP, netS } = await start();
    await waitFor(() => s.direct.state().peers.some((x) => x.kind === "node"), 8000);
    const attempt = netS.live!.requests.find((r) => r.method === "peer.offer")!.params["peer"];
    const given = netP.live!.requests.filter((r) => r.method === "peer.candidate" && r.params["peer"] === attempt);
    expect(given.map((r) => (r.params["candidate"] as { candidate: string }).candidate)).toEqual([expect.stringContaining("typ srflx")]);
    // it reached the helper after the answer, never before (a helper refuses a peer it does not know)
    const methods = netP.live!.requests.filter((r) => r.params["peer"] === attempt).map((r) => r.method);
    expect(methods.slice(0, 2)).toEqual(["peer.answer", "peer.candidate"]);
  });

  test("a primary that keeps links off direct connections answers unsupported, and the secondary asks no more", async () => {
    const { netS } = await start({ primaryLinks: false });
    await waitFor(() => netS.live!.requests.some((r) => r.method === "peer.offer"), 5000);
    await Bun.sleep(1200);
    expect(netS.live!.requests.filter((r) => r.method === "peer.offer")).toHaveLength(1);
    expect(netS.live!.requests.filter((r) => r.method === "peer.close")).toHaveLength(1);
    expect(JSON.parse(secondary!.store.meta.get("direct_paths")!)).toEqual({ [new Date().toISOString().slice(0, 10)]: { "node:failed": 1 } });
  });
});
