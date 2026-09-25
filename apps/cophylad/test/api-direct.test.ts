// A paired phone on the relay opening a data channel, with the phone's end played in
// WebCrypto and the helper faked: `direct.info` hands the server's TURN servers (this node's
// STUN servers alone from a server without TURN), the offer is answered by the helper and
// keyed from a fresh key and the phone's pairing secret, the candidates cross both ways, and
// once the helper says the channel is open the node serves it like any socket, under the
// `p2p` kind: the phone's hello, the path in `direct.state` and on the controller rows, the
// requests a channel does not carry refused, another phone's token refused, a forged record
// closing it. An offer from the LAN or the desktop is refused; one that never opens is
// closed and counted as failed; the helper going ends the channels it held.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import type { ClientNotificationParams, Controller, RelayAccess } from "@cophyla/protocol";
import { chunk, derive, ephemeral, pskFromHex, Reassembler } from "@cophyla/relay";
import type { Tunnel } from "@cophyla/relay";
import { paths } from "../src/config/load.ts";
import type { Daemon } from "../src/daemon.ts";
import { silentLogger } from "../src/log.ts";
import { FakeNet } from "./fakes/net.ts";
import type { FakeHelper } from "./fakes/net.ts";
import { RelayPhone } from "./fakes/relay-phone.ts";
import type { Reply } from "./fakes/relay-phone.ts";
import { FakeServer } from "./fakes/server.ts";
import { isMethod, removeHome, tempHome, TestClient, waitFor } from "./helpers.ts";

type DirectState = ClientNotificationParams<"direct.state">;

interface Started {
  d: Daemon & { home: string };
  fake: FakeServer;
  net: FakeNet;
  ui: TestClient;
  wss: string;
}

let current: Started | undefined;
const closers: (() => void)[] = [];

afterEach(async () => {
  for (const c of closers.splice(0)) c();
  if (!current) return;
  const s = current;
  current = undefined;
  s.ui.close();
  await s.d.stop();
  await s.fake.stop();
  removeHome(s.d.home);
});

async function start(opts: { openTimeoutMs?: number } = {}): Promise<Started> {
  const fake = new FakeServer();
  const net = new FakeNet();
  const home = tempHome(`[controller]\nenabled = true\nport = 0\n\n[nodes]\ndiscovery = false\n\n[direct]\nrestart_backoff_ms = 20\n\n[cloud]\nenabled = true\nurl = "${fake.url}"\nallow_insecure = true\nreconnect_ms = 20\nreconnect_max_ms = 100\n`);
  const p = paths(home);
  mkdirSync(p.data, { recursive: true });
  writeFileSync(p.accountToken, fake.mintToken("test") + "\n", { mode: 0o600 });
  const { startDaemon } = await import("../src/daemon.ts");
  const d = Object.assign(
    await startDaemon({ home, port: 0, log: silentLogger, embedder: null, brain: false, cloud: { keys: [fake.publicKey] }, direct: { spawn: net.spawn, command: () => "cophyla-net", ...(opts.openTimeoutMs ? { openTimeoutMs: opts.openTimeoutMs } : {}) } }),
    { home },
  );
  const ui = await TestClient.connect(d.api.url);
  await ui.hello(d.token, { name: "desktop" });
  await waitFor(() => d.cloud.hostedAllowed("direct") === undefined, 5000);
  await ui.request("direct.enable", {});
  await waitFor(() => d.direct.ready, 5000);
  current = { d, fake, net, ui, wss: `https://127.0.0.1:${d.controller!.port}/ws/client` };
  return current;
}

async function pair(s: Started, name = "Pixel 8"): Promise<{ token: string; client: Controller; relay: RelayAccess }> {
  const offer = await s.ui.request<{ code: string }>("pair.start", {});
  const p = await TestClient.connect(s.wss, { insecure: true });
  const claimed = await p.request<{ token: string; client: Controller; relay: RelayAccess }>("pair.claim", { code: offer.code, name });
  p.close();
  return claimed;
}

/** The phone's end of an open channel: frames sealed and cut into `peer.data`, the node's `peer.send` put back together. */
class ChannelPhone {
  private helper: FakeHelper;
  private peer: string;
  private tunnel: Tunnel;
  private read = 0;
  private reassembler = new Reassembler();
  readonly frames: Record<string, unknown>[] = [];
  private n = 0;

  constructor(helper: FakeHelper, peer: string, tunnel: Tunnel) {
    this.helper = helper;
    this.peer = peer;
    this.tunnel = tunnel;
  }

  async send(frame: unknown): Promise<void> {
    const record = await this.tunnel.seal(JSON.stringify(frame));
    for (const data of chunk(record)) this.helper.emit("peer.data", { peer: this.peer, data });
  }

  forge(data: string): void {
    this.helper.emit("peer.data", { peer: this.peer, data });
  }

  /** Reads what the node sent since the last look. */
  async pump(): Promise<void> {
    const out = this.helper.notified.filter((n) => n.method === "peer.send" && n.params["peer"] === this.peer);
    for (const n of out.slice(this.read)) {
      const record = this.reassembler.push(String(n.params["data"]));
      if (record !== undefined) this.frames.push(JSON.parse(await this.tunnel.open(record)) as Record<string, unknown>);
    }
    this.read = out.length;
  }

  async call(method: string, params: unknown = {}): Promise<Reply> {
    const id = `c${++this.n}`;
    await this.send({ jsonrpc: "2.0", id, method, params });
    const end = Date.now() + 5000;
    for (;;) {
      await this.pump();
      const found = this.frames.find((f) => f["id"] === id);
      if (found) return found as Reply;
      if (Date.now() > end) throw new Error(`no answer to ${method} on the channel`);
      await Bun.sleep(20);
    }
  }
}

/** A phone paired, on the relay, said hello there; its channel offered and answered. */
async function offered(s: Started) {
  const claimed = await pair(s);
  const phone = new RelayPhone(claimed.relay);
  closers.push(() => phone.close());
  await phone.connect();
  expect((await phone.call("hello", { token: claimed.token, kind: "controller", name: "Pixel 8", audio: { in: true, out: true } })).result).toBeDefined();
  const info = await phone.call("direct.info");
  const eph = await ephemeral("x25519");
  const answer = (await phone.call("direct.offer", { sdp: "fake-offer:phone", epk: eph.publicKey, curve: "x25519" })).result as { peer: string; sdp: string; epk: string };
  const tunnel = await derive("initiator", eph, answer.epk, pskFromHex(claimed.relay.key), { kind: "direct", peer: claimed.client.id });
  return { claimed, phone, info, answer, tunnel, helper: s.net.live! };
}

describe("a phone's data channel", () => {
  test("offered over the relay, keyed from a fresh key and the pairing secret, candidates both ways, then served as a p2p client", async () => {
    const s = await start();
    const { d, fake } = s;
    const { claimed, phone, info, answer, tunnel, helper } = await offered(s);
    expect(info.result).toMatchObject({ iceServers: expect.arrayContaining([expect.objectContaining({ username: fake.turnGrants[0]!.username })]) });
    expect(answer.peer).toMatch(/^c_[0-9a-f]{16}$/);
    expect(answer.sdp).toBe(`fake-answer:${answer.peer}`);
    expect(helper.peers.get(answer.peer)).toMatchObject({ role: "answer", remoteSdp: "fake-offer:phone" });
    // the helper's candidate reaches the phone over the relay; the phone's reaches the helper
    helper.emit("peer.candidate", { peer: answer.peer, candidate: { candidate: "candidate:1 1 udp 2122260223 192.0.2.10 50000 typ host", sdpMid: "0" } });
    await waitFor(() => phone.notifications.find((n) => n.method === "direct.candidate"));
    expect(phone.notifications.find((n) => n.method === "direct.candidate")!.params).toEqual({ peer: answer.peer, candidate: { candidate: "candidate:1 1 udp 2122260223 192.0.2.10 50000 typ host", sdpMid: "0" } });
    phone.signal("direct.candidate", { peer: answer.peer, candidate: { candidate: "candidate:2 1 udp 1686052607 203.0.113.9 61000 typ srflx" } });
    await waitFor(() => helper.peers.get(answer.peer)!.candidates.length === 1);
    // the audit keeps the offer's size, not its text
    const row = d.store.audit.list({ limit: 100 }).find((e) => e.action === "direct.offer")!;
    expect((row.args as { sdp: string }).sdp).toBe("[16 characters]");

    // open: the phone says hello on the channel
    helper.emit("peer.open", { peer: answer.peer });
    const ch = new ChannelPhone(helper, answer.peer, tunnel);
    const hello = await ch.call("hello", { token: claimed.token, kind: "controller", name: "Pixel 8", audio: { in: true, out: true } });
    expect(hello.result).toMatchObject({ client: { kind: "controller", controller: claimed.client.id, via: "relay", path: "direct" } });
    // the welcome follows the answer, each frame sealed in turn
    for (const end = Date.now() + 3000; Date.now() < end && !ch.frames.some((f) => f["method"] === "direct.state"); await Bun.sleep(20)) await ch.pump();
    expect(ch.frames.some((f) => f["method"] === "direct.state")).toBe(true);
    expect((await ch.call("session.list")).result).toEqual({ sessions: [] });
    // the helper names the path: in direct.state, on the controller rows, counted for the day
    const heard = s.ui.next(isMethod("direct.state", (p) => (p as DirectState).peers.length === 1));
    helper.emit("peer.path", { peer: answer.peer, type: "relay", local: "192.0.2.10:50000", remote: "198.51.100.7:3478", rttMs: 41 });
    expect(((await heard).params as DirectState).peers).toEqual([{ kind: "controller", id: claimed.client.id, path: "relay", rttMs: 41, since: expect.any(Number) }]);
    const rows = await s.ui.request<{ controllers: Controller[] }>("controller.list", {});
    expect(rows.controllers.find((c) => c.id === claimed.client.id)!.path).toBe("turn");
    expect(JSON.parse(d.store.meta.get("direct_paths")!)).toEqual({ [new Date().toISOString().slice(0, 10)]: { "client:relay": 1 } });
    // what a channel does not carry
    for (const [method, params] of [["view.stage", { id: "default" }], ["relay.info", {}], ["direct.offer", { sdp: "x", epk: "y" }], ["direct.info", {}], ["remote.open", { node: d.identity.id }], ["pair.claim", { code: "123456", name: "x" }]] as const) {
      expect((await ch.call(method, params)).error?.data?.code).toBe("unsupported");
    }
    // a forged record closes the channel, and the helper is told
    ch.forge("=bm90IGEgcmVjb3Jk");
    await waitFor(() => helper.requests.some((r) => r.method === "peer.close" && r.params["peer"] === answer.peer));
    await waitFor(() => d.clients.list().filter((c) => c.controller === claimed.client.id).length === 1);
    await waitFor(() => d.direct.state().peers.length === 0);
  });

  test("a server without TURN: the phone gathers with this node's STUN servers, and the offer is still answered", async () => {
    const s = await start();
    s.fake.turnUnavailable = true;
    const { info, answer } = await offered(s);
    expect(info.result).toMatchObject({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }] });
    expect(s.fake.turnGrants).toHaveLength(0);
    expect(answer.sdp).toBe(`fake-answer:${answer.peer}`);
  });

  test("only its own phone says hello on a channel", async () => {
    const s = await start();
    const { answer, tunnel, helper } = await offered(s);
    const other = await pair(s, "Tablet");
    helper.emit("peer.open", { peer: answer.peer });
    const ch = new ChannelPhone(helper, answer.peer, tunnel);
    const refused = await ch.call("hello", { token: other.token, kind: "controller", audio: { in: true, out: true } });
    expect(refused.error?.data).toMatchObject({ code: "denied", message: "this channel was opened for another phone" });
  });

  test("offers only from a phone on the relay; one that never opens is closed and counted failed; the helper going ends the channels", async () => {
    const s = await start({ openTimeoutMs: 300 });
    const { d, net } = s;
    // the desktop and a phone on the LAN offer nothing
    const fromDesktop = await s.ui.call("direct.offer", { sdp: "fake-offer:x", epk: "AAAA" });
    expect("error" in fromDesktop && fromDesktop.error.data?.code).toBe("unsupported");
    const claimed = await pair(s);
    const lan = await TestClient.connect(s.wss, { insecure: true });
    closers.push(() => lan.close());
    await lan.hello(claimed.token, { kind: "controller", audio: { in: false, out: false } });
    const r = await lan.call("direct.offer", { sdp: "fake-offer:x", epk: "AAAA" });
    expect("error" in r && r.error.data?.code).toBe("unsupported");
    // an offer that never opens
    const first = await offered(s);
    await waitFor(() => first.helper.requests.some((q) => q.method === "peer.close" && q.params["peer"] === first.answer.peer), 3000);
    expect(JSON.parse(d.store.meta.get("direct_paths")!)).toEqual({ [new Date().toISOString().slice(0, 10)]: { "client:failed": 1 } });
    // one that opens, then the helper dies under it
    const second = await offered(s);
    second.helper.emit("peer.open", { peer: second.answer.peer });
    const ch = new ChannelPhone(second.helper, second.answer.peer, second.tunnel);
    await ch.call("hello", { token: second.claimed.token, kind: "controller", audio: { in: true, out: true } });
    const onChannel = () => d.clients.list().filter((c) => c.controller === second.claimed.client.id).length;
    expect(onChannel()).toBe(2);
    net.live!.crash();
    await waitFor(() => onChannel() === 1, 3000);
    await waitFor(() => d.direct.ready && net.helpers.length === 2, 3000);
  });
});
