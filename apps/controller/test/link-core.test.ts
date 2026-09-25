// The link core over fake transports: pairing and the credential it leaves, hello, what a
// view may not send, reconnection with backoff, suspend and resume, the chooser (the LAN
// given a head start, the relay beside it once that passes or the LAN fails, the first to
// open carrying the link, the LAN again once it answers), the
// relay access asked for after a LAN hello without one, and a relay that no longer knows
// the token. The transports are faked at the `Transport` seam; `transport.test.ts` covers
// the real two.

import { describe, expect, test } from "bun:test";
import { CoreError, DRAIN_MS, LAN_HEAD_START_MS, LinkCore, QUIET_RETRY_MS, UPGRADE_BACKOFF_MS, UPGRADE_DELAY_MS } from "../src/link-core.ts";
import type { LinkCoreOptions, P2pDuplex, P2pTransport, Timers } from "../src/link-core.ts";
import type { Signalling } from "../src/direct.ts";
import { STORAGE_KEY, readCredential, syncStore, writeCredential } from "../src/pairing.ts";
import type { Credential, Storage } from "../src/pairing.ts";
import type { Duplex, Transport, TransportKind } from "../src/transport.ts";

class FakeStorage implements Storage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

class FakeTimers implements Timers {
  private handlers = new Map<number, { at: number; fn: () => void }>();
  private next = 1;
  now = 0;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.handlers.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.handlers.delete(handle as number);
  }
  advance(ms: number): void {
    this.now += ms;
    for (const [id, entry] of [...this.handlers].sort((a, b) => a[1].at - b[1].at)) {
      if (entry.at > this.now) continue;
      this.handlers.delete(id);
      entry.fn();
    }
  }
}

/** A connection the test drives: what was sent, and frames delivered back. */
class FakeDuplex implements Duplex {
  readonly sent: Record<string, unknown>[] = [];
  closed?: { code: number; reason: string };
  onmessage: ((text: string) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.onclose?.(code, reason);
  }
  deliver(frame: unknown): void {
    this.onmessage?.(JSON.stringify(frame));
  }
  last(match: (f: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find(match);
  }
}

/** A transport whose opens the test answers: reachable yields a duplex, unreachable refuses, held waits for `release` or `refuse`. */
class FakeTransport implements Transport {
  readonly opened: FakeDuplex[] = [];
  reachable = true;
  hold = false;
  tries = 0;
  private held: { resolve: (d: Duplex) => void; reject: (e: Error) => void }[] = [];
  readonly kind: TransportKind;
  label: string;
  constructor(kind: TransportKind, label?: string) {
    this.kind = kind;
    this.label = label ?? (kind === "lan" ? "wss://node.test/ws/client" : "https://orc.test/ws/relay");
  }
  async open(): Promise<Duplex> {
    this.tries++;
    if (this.hold) return new Promise<Duplex>((resolve, reject) => this.held.push({ resolve, reject }));
    if (!this.reachable) throw new Error(`${this.label}: unreachable`);
    const d = new FakeDuplex();
    this.opened.push(d);
    return d;
  }
  /** The oldest held open answers. */
  release(): FakeDuplex {
    const d = new FakeDuplex();
    this.opened.push(d);
    this.held.shift()!.resolve(d);
    return d;
  }
  /** The oldest held open fails. */
  refuse(reason: string): void {
    this.held.shift()!.reject(new Error(reason));
  }
}

const helloOk = (id: string) => ({ jsonrpc: "2.0", id, result: { client: { id: "cli_1", kind: "controller", scopes: ["voice"], via: "direct", audio: { in: true, out: true }, connectedAt: 1 }, node: "node_1", protocolVersion: 1, platformVersion: "0.6.0" } });
const ACCESS = { url: "https://orc.test", peer: "ctl_1", token: "rly_x", key: "9f".repeat(32) };

async function setup(opts: { credential?: Credential; relay?: boolean; extra?: Partial<LinkCoreOptions> } = {}) {
  const storage = new FakeStorage();
  if (opts.credential) writeCredential(storage, opts.credential);
  const timers = new FakeTimers();
  const lan = new FakeTransport("lan");
  const relay = new FakeTransport("relay");
  const core = new LinkCore({
    store: syncStore(storage),
    name: "Pixel",
    lan: () => [lan],
    ...(opts.relay === false ? {} : { relay: () => relay }),
    timers,
    now: () => timers.now,
    random: () => 0.5,
    lanRetryMs: 60_000,
    ...opts.extra,
  });
  const states: string[] = [];
  await core.listen<{ state: string }>("cophylad:state", (s) => states.push(s.state));
  await core.load();
  return { core, lan, relay, storage, timers, states };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("pairing", () => {
  test("claims a code over the LAN, keeps the token with the LAN URL and the relay access, and says hello on the same connection", async () => {
    const { core, lan, storage, states } = await setup();
    const paired = core.pair("482913", "Pixel");
    await tick();
    const d = lan.opened[0]!;
    const claim = d.last((f) => f["method"] === "pair.claim")!;
    expect(claim["params"]).toEqual({ code: "482913", name: "Pixel" });
    d.deliver({ jsonrpc: "2.0", id: claim["id"], result: { token: "tok", client: { id: "ctl_1", name: "Pixel", pairedAt: 1, connected: false, relay: true }, relay: ACCESS } });
    expect((await paired).id).toBe("ctl_1");
    await tick();
    expect(readCredential(storage)).toEqual({ token: "tok", controller: "ctl_1", name: "Pixel", lan: ["wss://node.test/ws/client"], relay: ACCESS });
    const hello = d.last((f) => f["method"] === "hello")!;
    expect(hello["params"]).toMatchObject({ token: "tok", kind: "controller", audio: { in: true, out: true, codecs: ["pcm"], played: true } });
    d.deliver(helloOk(String(hello["id"])));
    expect(states.at(-1)).toBe("connected");
    expect(core.snapshot.via).toBe("lan");
    // with the access in hand, no relay.info is asked
    expect(d.last((f) => f["method"] === "relay.info")).toBeUndefined();
    expect(hello["params"]).not.toHaveProperty("forward");
  });

  test("the native app's hello says it forwards stream pages", async () => {
    const { core, lan } = await setup({ extra: { helloExtra: { forward: true } } });
    void core.pair("482913", "Pixel");
    await tick();
    const d = lan.opened[0]!;
    const claim = d.last((f) => f["method"] === "pair.claim")!;
    d.deliver({ jsonrpc: "2.0", id: claim["id"], result: { token: "tok", client: { id: "ctl_1", name: "Pixel", pairedAt: 1, connected: false, relay: true }, relay: ACCESS } });
    await tick();
    await tick();
    expect(d.last((f) => f["method"] === "hello")!["params"]).toMatchObject({ token: "tok", forward: true });
  });

  test("a refused code rejects, keeps nothing and does not retry", async () => {
    const { core, lan, storage, timers } = await setup();
    const paired = core.pair("000000", "Pixel");
    await tick();
    const d = lan.opened[0]!;
    const claim = d.last((f) => f["method"] === "pair.claim")!;
    d.deliver({ jsonrpc: "2.0", id: claim["id"], error: { code: -32000, message: "denied", data: { code: "denied", message: "that code is not open" } } });
    await expect(paired).rejects.toThrow(/not open/);
    expect(readCredential(storage)).toBeUndefined();
    expect(core.snapshot.state).toBe("unauthorized");
    timers.advance(60_000);
    await tick();
    expect(lan.opened).toHaveLength(1);
  });

  test("paired without access: relay.info is asked after the LAN hello, and its answer is kept", async () => {
    const { core, lan, storage } = await setup({ credential: { token: "t", controller: "ctl_1", name: "Pixel", lan: ["wss://node.test/ws/client"] } });
    core.connect();
    await tick();
    const d = lan.opened[0]!;
    d.deliver(helloOk(String(d.last((f) => f["method"] === "hello")!["id"])));
    const info = d.last((f) => f["method"] === "relay.info")!;
    expect(info).toBeDefined();
    d.deliver({ jsonrpc: "2.0", id: info["id"], result: ACCESS });
    await tick();
    expect(readCredential(storage)?.relay).toEqual(ACCESS);
    // a refusal (still signed out) changes nothing
    const { core: c2, lan: l2, storage: s2 } = await setup({ credential: { token: "t", controller: "ctl_1", name: "Pixel" } });
    c2.connect();
    await tick();
    const d2 = l2.opened[0]!;
    d2.deliver(helloOk(String(d2.last((f) => f["method"] === "hello")!["id"])));
    const info2 = d2.last((f) => f["method"] === "relay.info")!;
    d2.deliver({ jsonrpc: "2.0", id: info2["id"], error: { code: -32000, message: "unavailable", data: { code: "unavailable", message: "not signed in" } } });
    await tick();
    expect(readCredential(s2)?.relay).toBeUndefined();
    // a build without the relay never asks
    const { core: c3, lan: l3 } = await setup({ credential: { token: "t", controller: "ctl_1", name: "Pixel" }, relay: false });
    c3.connect();
    await tick();
    const d3 = l3.opened[0]!;
    d3.deliver(helloOk(String(d3.last((f) => f["method"] === "hello")!["id"])));
    expect(d3.last((f) => f["method"] === "relay.info")).toBeUndefined();
  });
});

describe("pairing through the account", () => {
  const LAN = { host: "192.168.1.44", port: 4818, spki: "q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c=" };
  const forLan: LinkCoreOptions["credentialForLan"] = (lan) => ({ lan: [`wss://${lan.host}:${lan.port}/ws/client`], node: { ...lan } });

  test("pair.account on the pairing tunnel, the credential with the relay access and the LAN pin, then the relay carries the link with the new token", async () => {
    const { core, lan, relay, storage } = await setup({ extra: { credentialForLan: forLan } });
    const tunnel = new FakeTransport("relay", "https://orc.test/ws/relay");
    const paired = core.pairAccount("Pixel", tunnel);
    await tick();
    const d = tunnel.opened[0]!;
    const req = d.last((f) => f["method"] === "pair.account")!;
    expect(req["params"]).toEqual({ name: "Pixel" });
    // nothing else goes up a pairing tunnel: no code, no hello
    expect(d.sent.map((f) => f["method"])).toEqual(["pair.account"]);
    d.deliver({ jsonrpc: "2.0", id: req["id"], result: { token: "tok", client: { id: "ctl_1", name: "Pixel", pairedAt: 1, connected: false, relay: true, account: "octocat" }, relay: ACCESS, lan: LAN } });
    expect((await paired).account).toBe("octocat");
    await tick();
    // the pairing tunnel has done its one job
    expect(d.closed).toEqual({ code: 1000, reason: "paired" });
    expect(readCredential(storage)).toEqual({ token: "tok", controller: "ctl_1", name: "Pixel", relay: ACCESS, lan: ["wss://192.168.1.44:4818/ws/client"], node: LAN });
    // back through the relay with the token, the LAN left to the timer
    const r = relay.opened[0]!;
    const hello = r.last((f) => f["method"] === "hello")!;
    expect(hello["params"]).toMatchObject({ token: "tok", kind: "controller" });
    r.deliver(helloOk(String(hello["id"])));
    expect(core.snapshot.state).toBe("connected");
    expect(core.snapshot.via).toBe("relay");
    expect(lan.opened).toHaveLength(0);
  });

  const answer = (id: unknown) => ({ jsonrpc: "2.0", id, result: { token: "tok", client: { id: "ctl_1", name: "Pixel", pairedAt: 1, connected: false, relay: true, account: "octocat" }, relay: ACCESS, lan: LAN } });

  test("the app pausing mid-pairing (the browser handing back, a second tap on Sign in) leaves the tunnel to finish; the link waits for resume, and the grant is never spent twice", async () => {
    const { core, lan, relay, storage } = await setup({ extra: { credentialForLan: forLan } });
    const tunnel = new FakeTransport("relay");
    const paired = core.pairAccount("Pixel", tunnel);
    await tick();
    const d = tunnel.opened[0]!;
    core.suspend();
    expect(d.closed).toBeUndefined();
    d.deliver(answer(d.last((f) => f["method"] === "pair.account")!["id"]));
    expect((await paired).id).toBe("ctl_1");
    await tick();
    expect(readCredential(storage)?.token).toBe("tok");
    // paused: nothing opens until the app is back
    expect(lan.opened.length + relay.opened.length).toBe(0);
    core.resume();
    await tick();
    const back = [...lan.opened, ...relay.opened];
    expect(back).toHaveLength(1);
    expect(back[0]!.last((f) => f["method"] === "hello")!["params"]).toMatchObject({ token: "tok" });
    expect(tunnel.opened).toHaveLength(1);
  });

  test("the app pausing while the tunnel is still opening: the pairing goes on once it opens", async () => {
    const { core, storage } = await setup();
    let open!: (d: FakeDuplex) => void;
    const d = new FakeDuplex();
    const slow: Transport = { kind: "relay", label: "https://orc.test/ws/relay", open: () => new Promise<Duplex>((r) => (open = r)) };
    const paired = core.pairAccount("Pixel", slow);
    await tick();
    core.suspend();
    open(d);
    await tick();
    expect(d.closed).toBeUndefined();
    d.deliver(answer(d.last((f) => f["method"] === "pair.account")!["id"]));
    expect((await paired).id).toBe("ctl_1");
    await tick();
    expect(readCredential(storage)?.token).toBe("tok");
  });

  test("a tunnel cut off before the node answered settles the pairing once with a word to sign in again, and is never opened again", async () => {
    const { core, storage, timers } = await setup();
    const tunnel = new FakeTransport("relay");
    const paired = core.pairAccount("Pixel", tunnel);
    await tick();
    tunnel.opened[0]!.close(1006, "gone");
    await expect(paired).rejects.toThrow(/sign in again/);
    expect(core.snapshot.state).toBe("unauthorized");
    core.suspend();
    core.resume();
    timers.advance(60_000);
    await tick();
    expect(tunnel.opened).toHaveLength(1);
    expect(readCredential(storage)).toBeUndefined();
  });

  test("a pairing tunnel that cannot open (a spent grant, no node online) rejects with the reason, keeps nothing and leaves the page on pairing", async () => {
    const { core, storage, timers, relay } = await setup();
    const tunnel = new FakeTransport("relay");
    tunnel.reachable = false;
    await expect(core.pairAccount("Pixel", tunnel)).rejects.toThrow(/unreachable/);
    expect(core.snapshot.state).toBe("unauthorized");
    expect(readCredential(storage)).toBeUndefined();
    timers.advance(60_000);
    await tick();
    expect(tunnel.opened).toHaveLength(0);
    expect(relay.opened).toHaveLength(0);
  });

  test("the node refusing pair.account rejects and keeps nothing; the browser's credential names no LAN it was not told of", async () => {
    const { core, storage } = await setup();
    const tunnel = new FakeTransport("relay");
    const refused = core.pairAccount("Pixel", tunnel);
    await tick();
    const d = tunnel.opened[0]!;
    d.deliver({ jsonrpc: "2.0", id: d.last((f) => f["method"] === "pair.account")!["id"], error: { code: -32000, message: "denied", data: { code: "denied", message: "this node does not pair through the account" } } });
    await expect(refused).rejects.toThrow(/does not pair through the account/);
    expect(readCredential(storage)).toBeUndefined();
    expect(d.closed).toBeDefined();
    // without a LAN mapping the credential holds the relay alone
    const { core: c2, storage: s2 } = await setup();
    const t2 = new FakeTransport("relay");
    const ok = c2.pairAccount("Pixel", t2);
    await tick();
    const d2 = t2.opened[0]!;
    d2.deliver({ jsonrpc: "2.0", id: d2.last((f) => f["method"] === "pair.account")!["id"], result: { token: "tok", client: { id: "ctl_2", name: "Pixel", pairedAt: 1, connected: false, relay: true }, relay: ACCESS, lan: LAN } });
    await ok;
    await tick();
    expect(readCredential(s2)).toEqual({ token: "tok", controller: "ctl_2", name: "Pixel", relay: ACCESS });
  });

  test("a code whose node cannot be reached rejects instead of hanging", async () => {
    const { core, lan } = await setup();
    lan.reachable = false;
    await expect(core.pair("482913", "Pixel")).rejects.toThrow(/unreachable/);
    expect(core.snapshot.state).toBe("unauthorized");
  });

  test("a view may not send pair.account", async () => {
    const { core } = await setup();
    await expect(core.invoke("cophylad_send", { frame: { jsonrpc: "2.0", id: 1, method: "pair.account", params: { name: "x" } } })).rejects.toThrow(/controller's own/);
  });
});

describe("an invite from the desktop", () => {
  const INVITE = { grant: "ctl_9", secret: "ab".repeat(32) };
  const LAN = { host: "192.168.1.44", port: 4818, spki: "q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c=" };
  const answer = (id: unknown, relay = false) => ({ jsonrpc: "2.0", id, result: { token: "tok", client: { id: "ctl_9", name: "Work phone", pairedAt: 1, connected: false, ...(relay ? { relay: true } : {}) }, ...(relay ? { relay: ACCESS } : {}), lan: LAN } });

  test("redeemed on the LAN address it names: the credential records that address and its pin, and hello goes on the same socket", async () => {
    const { core, relay, storage } = await setup();
    const pinned = new FakeTransport("lan", "wss://192.168.1.44:4818/ws/client");
    const peer = new FakeTransport("relay", "https://orc.test/ws/relay");
    const redeemed = core.redeem(INVITE, "Pixel", { lans: [pinned], relay: peer, credentialFor: (t) => (t === pinned ? { lan: [t.label], node: LAN } : {}) });
    await tick();
    const d = pinned.opened[0]!;
    const req = d.last((f) => f["method"] === "invite.redeem")!;
    expect(req["params"]).toEqual({ grant: "ctl_9", secret: INVITE.secret, name: "Pixel" });
    expect(d.sent.map((f) => f["method"])).toEqual(["invite.redeem"]);
    d.deliver(answer(req["id"]));
    expect((await redeemed).id).toBe("ctl_9");
    await tick();
    expect(readCredential(storage)).toEqual({ token: "tok", controller: "ctl_9", name: "Pixel", lan: ["wss://192.168.1.44:4818/ws/client"], node: LAN });
    const hello = d.last((f) => f["method"] === "hello")!;
    expect(hello["params"]).toMatchObject({ token: "tok", kind: "controller" });
    d.deliver(helloOk(String(hello["id"])));
    expect(core.snapshot.state).toBe("connected");
    expect(core.snapshot.via).toBe("lan");
    // the LAN answered within its head start: the invite's relay peer was never opened
    expect(peer.tries).toBe(0);
    expect(relay.tries).toBe(0);
  });

  test("the LAN silent: the invite's relay peer opens after the head start, and the link comes back on the relay access the node minted", async () => {
    const { core, relay, storage, timers } = await setup({ extra: { credentialForLan: (lan) => ({ lan: [`wss://${lan.host}:${lan.port}/ws/client`], node: { ...lan } }) } });
    const pinned = new FakeTransport("lan", "wss://192.168.1.44:4818/ws/client");
    pinned.hold = true;
    const peer = new FakeTransport("relay", "https://orc.test/ws/relay");
    const redeemed = core.redeem(INVITE, "Pixel", { lans: [pinned], relay: peer });
    await tick();
    expect(peer.tries).toBe(0);
    timers.advance(LAN_HEAD_START_MS);
    await tick();
    const d = peer.opened[0]!;
    d.deliver(answer(d.last((f) => f["method"] === "invite.redeem")!["id"], true));
    expect((await redeemed).relay).toBe(true);
    await tick();
    // the invite's tunnel has done its one job
    expect(d.closed).toEqual({ code: 1000, reason: "paired" });
    expect(readCredential(storage)).toEqual({ token: "tok", controller: "ctl_9", name: "Pixel", relay: ACCESS, lan: ["wss://192.168.1.44:4818/ws/client"], node: LAN });
    const r = relay.opened[0]!;
    r.deliver(helloOk(String(r.last((f) => f["method"] === "hello")!["id"])));
    expect(core.snapshot.via).toBe("relay");
    // the LAN that answered late is closed unused
    pinned.release();
    await tick();
    expect(pinned.opened[0]!.closed).toBeDefined();
  });

  test("a spent invite rejects with the node's word and keeps nothing; one cut off asks for the invite again; neither is retried", async () => {
    const { core, storage, timers } = await setup();
    const pinned = new FakeTransport("lan", "wss://192.168.1.44:4818/ws/client");
    const refused = core.redeem(INVITE, "Pixel", { lans: [pinned] });
    await tick();
    const d = pinned.opened[0]!;
    d.deliver({ jsonrpc: "2.0", id: d.last((f) => f["method"] === "invite.redeem")!["id"], error: { code: -32000, message: "denied", data: { code: "denied", message: "that invite is not open" } } });
    await expect(refused).rejects.toThrow(/not open/);
    expect(readCredential(storage)).toBeUndefined();
    expect(core.snapshot.state).toBe("unauthorized");

    const cut = core.redeem(INVITE, "Pixel", { lans: [pinned] });
    await tick();
    pinned.opened[1]!.close(1006, "gone");
    await expect(cut).rejects.toThrow(/open the invite again/);
    timers.advance(60_000);
    await tick();
    expect(pinned.opened).toHaveLength(2);
    // nothing to reach it by
    await expect(core.redeem(INVITE, "Pixel", { lans: [] })).rejects.toThrow(/no way/);
  });

  test("a phone that is paired already redeems nothing, and a view may not send invite.redeem", async () => {
    const { core, lan } = await setup({ credential: { token: "t", controller: "ctl_1", name: "Pixel" } });
    core.connect();
    await tick();
    const d = lan.opened[0]!;
    d.deliver(helloOk(String(d.last((f) => f["method"] === "hello")!["id"])));
    await expect(core.redeem(INVITE, "Pixel", { lans: [new FakeTransport("lan")] })).rejects.toThrow(/paired already/);
    await expect(core.invoke("cophylad_send", { frame: { jsonrpc: "2.0", id: 1, method: "invite.redeem", params: { ...INVITE, name: "x" } } })).rejects.toThrow(/controller's own/);
  });
});

describe("the link", () => {
  test("a token the node has forgotten is dropped, and the page goes back to pairing", async () => {
    const { core, lan, storage, timers } = await setup({ credential: { token: "old", controller: "ctl_1", name: "Pixel" } });
    core.connect();
    await tick();
    const d = lan.opened[0]!;
    d.deliver({ jsonrpc: "2.0", id: d.last((f) => f["method"] === "hello")!["id"], error: { code: -32000, message: "denied", data: { code: "denied", message: "bad token" } } });
    await tick();
    expect(readCredential(storage)).toBeUndefined();
    expect(core.snapshot.state).toBe("unauthorized");
    timers.advance(60_000);
    await tick();
    expect(lan.opened).toHaveLength(1);
  });

  test("a dropped connection comes back with growing backoff, and suspend stops it", async () => {
    const { core, lan, timers } = await setup({ credential: { token: "t", controller: "ctl_1", name: "Pixel" }, relay: false });
    core.connect();
    await tick();
    lan.opened[0]!.deliver(helloOk(String(lan.opened[0]!.last((f) => f["method"] === "hello")!["id"])));
    expect(core.snapshot.state).toBe("connected");
    lan.opened[0]!.close(1006, "gone");
    expect(core.snapshot.state).toBe("disconnected");
    // the node is not back: the opens fail, and each wait is longer than the last
    lan.reachable = false;
    let opens = 0;
    const open = lan.open.bind(lan);
    lan.open = async () => {
      opens++;
      return open();
    };
    timers.advance(1000);
    await tick();
    await tick();
    expect(opens).toBe(1);
    timers.advance(1000);
    await tick();
    await tick();
    expect(opens).toBe(1);
    timers.advance(1500);
    await tick();
    await tick();
    expect(opens).toBe(2);
    // the node is back: the next try opens, and a pause closes it and stops the retries
    lan.reachable = true;
    timers.advance(5000);
    await tick();
    await tick();
    expect(lan.opened).toHaveLength(2);
    core.suspend();
    expect(lan.opened[1]!.closed).toBeDefined();
    timers.advance(60_000);
    await tick();
    expect(lan.opened).toHaveLength(2);
    core.resume();
    await tick();
    await tick();
    expect(lan.opened).toHaveLength(3);
  });

  test("a view may not say hello, claim a code or ask for the access; nothing is sent while the link is down; other frames reach the host as text", async () => {
    const { core, lan } = await setup({ credential: { token: "t", controller: "ctl_1", name: "Pixel" } });
    for (const method of ["hello", "pair.claim", "relay.info"]) await expect(core.invoke("cophylad_send", { frame: { jsonrpc: "2.0", id: 1, method, params: {} } })).rejects.toThrow(/denied/);
    await expect(core.invoke("cophylad_send", { frame: { jsonrpc: "2.0", id: 1, method: "chat.send", params: {} } })).rejects.toThrow(/unavailable/);
    const frames: string[] = [];
    await core.listen<string>("cophylad:frame", (text) => frames.push(text));
    core.connect();
    await tick();
    const d = lan.opened[0]!;
    d.deliver(helloOk(String(d.last((f) => f["method"] === "hello")!["id"])));
    await core.invoke("cophylad_send", { frame: { jsonrpc: "2.0", id: 7, method: "chat.send", params: { text: "hi" } } });
    expect(d.last((f) => f["method"] === "chat.send")).toMatchObject({ id: 7 });
    d.deliver({ jsonrpc: "2.0", method: "voice.state", params: { state: "listening" } });
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]!)).toMatchObject({ method: "voice.state" });
  });

  test("forget drops the credential and closes the connection", async () => {
    const { core, lan, storage } = await setup({ credential: { token: "t", controller: "ctl_1", name: "Pixel", relay: ACCESS } });
    core.connect();
    await tick();
    core.forget();
    await tick();
    expect(readCredential(storage)).toBeUndefined();
    expect(storage.map.has(STORAGE_KEY)).toBe(false);
    expect(lan.opened[0]!.closed).toBeDefined();
    expect(core.snapshot.state).toBe("unauthorized");
  });
});

describe("a stream's pipes", () => {
  test("opened with the core's own requests, signalled on the link, heard by the app alone; never through cophylad_send", async () => {
    const { core, lan } = await setup({ credential: { token: "t", controller: "ctl_1", name: "Pixel" }, relay: false });
    await expect(core.pipeOpen("node_b")).rejects.toThrow("not connected");
    const frames: string[] = [];
    await core.listen<string>("cophylad:frame", (t) => frames.push(t));
    const heard: [string, unknown][] = [];
    core.onPipe((method, params) => heard.push([method, params]));
    core.connect();
    await tick();
    const d = lan.opened[0]!;
    d.deliver(helloOk(String(d.last((f) => f["method"] === "hello")!["id"])));
    const opening = core.pipeOpen("node_b");
    const ask = d.last((f) => f["method"] === "remote.pipe.open")!;
    expect(String(ask["id"])).toMatch(/^d\d+$/);
    expect(ask["params"]).toEqual({ node: "node_b" });
    d.deliver({ jsonrpc: "2.0", id: ask["id"], result: { pipe: "p_1", window: 262_144 } });
    expect(await opening).toEqual({ pipe: "p_1", window: 262_144 });
    core.pipeSignal("remote.pipe.data", { pipe: "p_1", data: "R0VU" });
    expect(d.sent.at(-1)).toEqual({ jsonrpc: "2.0", method: "remote.pipe.data", params: { pipe: "p_1", data: "R0VU" } });
    d.deliver({ jsonrpc: "2.0", method: "remote.pipe.data", params: { pipe: "p_1", data: "SFRUUA==" } });
    d.deliver({ jsonrpc: "2.0", method: "remote.pipe.close", params: { pipe: "p_1" } });
    expect(heard).toEqual([
      ["remote.pipe.data", { pipe: "p_1", data: "SFRUUA==" }],
      ["remote.pipe.close", { pipe: "p_1" }],
    ]);
    // the host (and so the view) heard none of it
    expect(frames.some((t) => t.includes("remote.pipe"))).toBe(false);
    await expect(core.invoke("cophylad_send", { frame: { jsonrpc: "2.0", method: "remote.pipe.data", params: { pipe: "p_1", data: "eA==" } } })).rejects.toThrow("denied");
    await expect(core.invoke("cophylad_send", { frame: { jsonrpc: "2.0", id: "h1", method: "remote.pipe.open", params: {} } })).rejects.toThrow("denied");
  });
});

describe("the chooser", () => {
  const paired: Credential = { token: "t", controller: "ctl_1", name: "Pixel", lan: ["wss://node.test/ws/client"], relay: ACCESS };

  test("the LAN out of reach: the relay carries the link, the LAN is tried again on the timer and takes over when it answers", async () => {
    const { core, lan, relay, timers, states } = await setup({ credential: paired });
    lan.reachable = false;
    core.connect();
    await tick();
    await tick();
    expect(lan.opened).toHaveLength(0);
    expect(relay.opened).toHaveLength(1);
    const d = relay.opened[0]!;
    const hello = d.last((f) => f["method"] === "hello")!;
    expect(hello["params"]).toMatchObject({ token: "t", kind: "controller" });
    d.deliver(helloOk(String(hello["id"])));
    expect(core.snapshot).toMatchObject({ state: "connected", via: "relay", url: "https://orc.test/ws/relay" });
    // a drop on the relay reconnects on the relay: the LAN is not retried on every attempt
    d.close(1006, "gone");
    timers.advance(1000);
    await tick();
    await tick();
    expect(relay.opened).toHaveLength(2);
    expect(lan.opened).toHaveLength(0);
    relay.opened[1]!.deliver(helloOk(String(relay.opened[1]!.last((f) => f["method"] === "hello")!["id"])));
    // the minute passes with the LAN still gone: nothing changes
    timers.advance(60_000);
    await tick();
    await tick();
    expect(core.snapshot.via).toBe("relay");
    expect(lan.opened).toHaveLength(0);
    // the LAN answers at the next try: it says hello, takes the link over with no gap, and the relay goes once drained
    lan.reachable = true;
    const before = states.length;
    timers.advance(60_000);
    await tick();
    await tick();
    const onLan = lan.opened.at(-1)!;
    const promoted = onLan.last((f) => f["method"] === "hello")!;
    expect(promoted["id"]).toBe("p4");
    expect(relay.opened[1]!.closed).toBeUndefined();
    onLan.deliver(helloOk("p4"));
    expect(core.snapshot).toMatchObject({ state: "connected", via: "lan" });
    expect(states.slice(before)).toEqual(["connected"]);
    timers.advance(DRAIN_MS);
    expect(relay.opened[1]!.closed?.reason).toBe("the link moved");
  });

  test("a network change while on the relay tries the LAN at once", async () => {
    const { core, lan, relay, timers } = await setup({ credential: paired });
    lan.reachable = false;
    core.connect();
    await tick();
    await tick();
    relay.opened[0]!.deliver(helloOk(String(relay.opened[0]!.last((f) => f["method"] === "hello")!["id"])));
    expect(await core.retryLan()).toBe(false);
    lan.reachable = true;
    const moving = core.networkChanged();
    await tick();
    lan.opened.at(-1)!.deliver(helloOk("p4"));
    await moving;
    expect(core.via).toBe("lan");
    timers.advance(DRAIN_MS);
    expect(relay.opened[0]!.closed).toBeDefined();
  });

  test("a LAN whose hello is refused or never answered leaves the link on the relay", async () => {
    const { core, lan, relay, timers } = await setup({ credential: paired });
    lan.reachable = false;
    core.connect();
    await tick();
    await tick();
    relay.opened[0]!.deliver(helloOk(String(relay.opened[0]!.last((f) => f["method"] === "hello")!["id"])));
    lan.reachable = true;
    const refused = core.retryLan();
    await tick();
    lan.opened.at(-1)!.deliver({ jsonrpc: "2.0", id: "p4", error: { code: -32000, message: "denied", data: { code: "denied", message: "bad token" } } });
    expect(await refused).toBe(false);
    expect(lan.opened.at(-1)!.closed?.reason).toBe("hello refused");
    const silent = core.retryLan();
    await tick();
    timers.advance(10_000);
    expect(await silent).toBe(false);
    expect(core.snapshot).toMatchObject({ state: "connected", via: "relay" });
    expect(relay.opened[0]!.closed).toBeUndefined();
  });

  test("the relay refusing the token drops the access and the LAN is tried; a build without the relay never opens one", async () => {
    const { core, lan, relay, storage, timers } = await setup({ credential: paired });
    lan.reachable = false;
    core.connect();
    await tick();
    await tick();
    const d = relay.opened[0]!;
    d.deliver(helloOk(String(d.last((f) => f["method"] === "hello")!["id"])));
    d.close(4401, "revoked");
    await tick();
    expect(readCredential(storage)?.relay).toBeUndefined();
    timers.advance(1000);
    await tick();
    await tick();
    // no access left: the LAN alone is tried, and fails; the relay is not opened again
    expect(relay.opened).toHaveLength(1);
    expect(core.snapshot.state).toBe("disconnected");
    const { core: c2, lan: l2, relay: r2 } = await setup({ credential: paired, relay: false });
    l2.reachable = false;
    c2.connect();
    await tick();
    await tick();
    expect(r2.opened).toHaveLength(0);
    expect(c2.snapshot.state).toBe("disconnected");
  });

  test("the LAN silent: the relay opens beside it once the head start passes and carries the link; a LAN that answers late is closed unused", async () => {
    const { core, lan, relay, timers } = await setup({ credential: paired });
    lan.hold = true;
    core.connect();
    await tick();
    expect(lan.tries).toBe(1);
    timers.advance(LAN_HEAD_START_MS - 1);
    await tick();
    expect(relay.tries).toBe(0);
    timers.advance(1);
    await tick();
    expect(relay.opened).toHaveLength(1);
    const d = relay.opened[0]!;
    d.deliver(helloOk(String(d.last((f) => f["method"] === "hello")!["id"])));
    expect(core.snapshot).toMatchObject({ state: "connected", via: "relay" });
    const late = lan.release();
    await tick();
    expect(late.closed?.reason).toBe("another way answered first");
    expect(late.sent).toHaveLength(0);
    expect(d.closed).toBeUndefined();
    expect(core.snapshot.via).toBe("relay");
  });

  test("a LAN that answers within its head start carries the link, and the relay is never opened", async () => {
    const { core, lan, relay, timers } = await setup({ credential: paired });
    lan.hold = true;
    core.connect();
    await tick();
    timers.advance(LAN_HEAD_START_MS - 100);
    const d = lan.release();
    await tick();
    timers.advance(LAN_HEAD_START_MS);
    await tick();
    expect(relay.tries).toBe(0);
    d.deliver(helloOk(String(d.last((f) => f["method"] === "hello")!["id"])));
    expect(core.snapshot).toMatchObject({ state: "connected", via: "lan" });
  });

  test("neither opens: the relay's reason is shown once the LAN gives up too, and the next try is the relay alone", async () => {
    const { core, lan, relay, timers } = await setup({ credential: paired });
    lan.hold = true;
    relay.reachable = false;
    core.connect();
    await tick();
    timers.advance(LAN_HEAD_START_MS);
    await tick();
    // the relay failed while the LAN still tries
    expect(relay.tries).toBe(1);
    expect(core.snapshot.state).toBe("connecting");
    lan.refuse("no answer from wss://node.test/ws/client within 4000 ms");
    await tick();
    expect(core.snapshot).toMatchObject({ state: "disconnected", error: "https://orc.test/ws/relay: unreachable" });
    lan.hold = false;
    relay.reachable = true;
    timers.advance(1000);
    await tick();
    await tick();
    expect(lan.tries).toBe(1);
    expect(relay.opened).toHaveLength(1);
  });

  test("no LAN offered (the phone on mobile data): the relay opens at once", async () => {
    const { core, relay } = await setup({ credential: paired, extra: { lan: () => [] } });
    core.connect();
    await tick();
    expect(relay.opened).toHaveLength(1);
    expect(relay.opened[0]!.last((f) => f["method"] === "hello")).toBeDefined();
  });

  test("a pause while the LAN still tries opens no relay, and a LAN that answers after it is closed", async () => {
    const { core, lan, relay, timers } = await setup({ credential: paired });
    lan.hold = true;
    core.connect();
    await tick();
    core.suspend();
    timers.advance(LAN_HEAD_START_MS);
    await tick();
    expect(relay.tries).toBe(0);
    const late = lan.release();
    await tick();
    expect(late.closed?.reason).toBe("paused");
    expect(core.snapshot).toMatchObject({ state: "disconnected", error: "paused" });
    // back: a fresh round, the LAN first
    lan.hold = false;
    core.resume();
    await tick();
    expect(lan.opened).toHaveLength(2);
    expect(lan.opened[1]!.last((f) => f["method"] === "hello")).toBeDefined();
  });

  test("resume after a pause tries the LAN first again", async () => {
    const { core, lan, relay } = await setup({ credential: paired });
    lan.reachable = false;
    core.connect();
    await tick();
    await tick();
    relay.opened[0]!.deliver(helloOk(String(relay.opened[0]!.last((f) => f["method"] === "hello")!["id"])));
    core.suspend();
    lan.reachable = true;
    core.resume();
    await tick();
    await tick();
    expect(lan.opened).toHaveLength(1);
    expect(relay.opened).toHaveLength(1);
  });
});

// --- the data channel -----------------------------------------------------------------------------

class FakeP2pDuplex extends FakeDuplex implements P2pDuplex {
  onfailing: (() => void) | null = null;
  path: "direct" | "turn" | undefined = "direct";
}

/** The data channel as the test plays it: each open waits for `answer` or `refuse`, and keeps the signalling it was given. */
class FakeP2p implements P2pTransport {
  readonly label = "direct";
  readonly opens: { sig: Signalling; credential: Credential; resolve: (d: P2pDuplex) => void; reject: (e: Error) => void }[] = [];
  open(sig: Signalling, credential: Credential): Promise<P2pDuplex> {
    return new Promise<P2pDuplex>((resolve, reject) => this.opens.push({ sig, credential, resolve, reject }));
  }
  answer(path: "direct" | "turn" = "direct"): FakeP2pDuplex {
    const d = new FakeP2pDuplex();
    d.path = path;
    this.opens.at(-1)!.resolve(d);
    return d;
  }
  refuse(code: string): void {
    this.opens.at(-1)!.reject(new CoreError(code, `refused: ${code}`));
  }
}

describe("the data channel", () => {
  const paired: Credential = { token: "t", controller: "ctl_1", name: "Pixel", lan: ["wss://node.test/ws/client"], relay: ACCESS };

  /** On the relay, said hello, with the data channel to hand. */
  async function onRelay(extra: Partial<LinkCoreOptions> = {}) {
    const p2p = new FakeP2p();
    const s = await setup({ credential: paired, extra: { p2p, ...extra } });
    s.lan.reachable = false;
    const frames: string[] = [];
    await s.core.listen<string>("cophylad:frame", (t) => frames.push(t));
    s.core.connect();
    await tick();
    await tick();
    const r = s.relay.opened.at(-1)!;
    r.deliver(helloOk(String(r.last((f) => f["method"] === "hello")!["id"])));
    return { ...s, p2p, frames, r };
  }

  test("tried two seconds after a relay hello; its hello takes the link over with no gap; the relay's answers still arrive while it drains", async () => {
    const { core, p2p, timers, states, frames, r } = await onRelay();
    timers.advance(UPGRADE_DELAY_MS - 1);
    expect(p2p.opens).toHaveLength(0);
    timers.advance(1);
    expect(p2p.opens).toHaveLength(1);
    expect(p2p.opens[0]!.credential.controller).toBe("ctl_1");
    const d = p2p.answer("turn");
    await tick();
    const hello = d.last((f) => f["method"] === "hello")!;
    expect(hello).toMatchObject({ id: "p4", params: { token: "t", kind: "controller" } });
    const before = states.length;
    d.deliver(helloOk("p4"));
    expect(core.snapshot).toMatchObject({ state: "connected", via: "p2p", path: "turn", url: "direct" });
    expect(states.slice(before)).toEqual(["connected"]);
    // the relay drains: an answer to something the view asked on it arrives, a notification does not
    r.deliver({ jsonrpc: "2.0", id: "h7", result: { ok: true } });
    r.deliver({ jsonrpc: "2.0", method: "session.state", params: {} });
    expect(frames.map((f) => JSON.parse(f) as unknown)).toEqual([{ jsonrpc: "2.0", id: "h7", result: { ok: true } }]);
    // what the view sends goes on the channel now
    await core.invoke("cophylad_send", { frame: { jsonrpc: "2.0", id: "h8", method: "session.list" } });
    expect(d.last((f) => f["id"] === "h8")).toBeDefined();
    timers.advance(DRAIN_MS);
    expect(r.closed?.reason).toBe("the link moved");
    expect(core.snapshot.via).toBe("p2p");
  });

  test("the signalling rides the relay under the core's own ids; the node's answers and candidates never reach the view, and a view cannot signal", async () => {
    const { core, p2p, timers, frames, r } = await onRelay();
    timers.advance(UPGRADE_DELAY_MS);
    const sig = p2p.opens[0]!.sig;
    const info = sig.request("direct.info", {}, 5000);
    expect(r.last((f) => f["method"] === "direct.info")!["id"]).toBe("d1");
    r.deliver({ jsonrpc: "2.0", id: "d1", result: { iceServers: [{ urls: "stun:x" }], expiresAt: 5 } });
    expect(await info).toEqual({ iceServers: [{ urls: "stun:x" }], expiresAt: 5 });
    const heard: unknown[] = [];
    const off = sig.onCandidate((p) => heard.push(p));
    r.deliver({ jsonrpc: "2.0", method: "direct.candidate", params: { peer: "c1", candidate: { candidate: "candidate:1 1 udp 1 192.0.2.1 5000 typ host" } } });
    off();
    r.deliver({ jsonrpc: "2.0", method: "direct.candidate", params: { peer: "c1", candidate: null } });
    expect(heard).toHaveLength(1);
    sig.signal("direct.candidate", { peer: "c1", candidate: { candidate: "candidate:2" } });
    expect(r.last((f) => f["method"] === "direct.candidate")).toMatchObject({ params: { peer: "c1" } });
    const refused = sig.request("direct.offer", { sdp: "v=0", epk: "k" }, 5000);
    r.deliver({ jsonrpc: "2.0", id: "d2", error: { code: -32000, message: "unavailable", data: { code: "unavailable", message: "direct connections are not running on this node" } } });
    await expect(refused).rejects.toMatchObject({ code: "unavailable" });
    const late = sig.request("direct.info", {}, 5000);
    timers.advance(5000);
    await expect(late).rejects.toMatchObject({ code: "timeout" });
    expect(frames).toEqual([]);
    await expect(core.invoke("cophylad_send", { frame: { jsonrpc: "2.0", id: "h1", method: "direct.offer", params: {} } })).rejects.toThrow("denied");
    await expect(core.invoke("cophylad_send", { frame: { jsonrpc: "2.0", method: "remote.pipe.data", params: {} } })).rejects.toThrow("denied");
    await core.invoke("cophylad_send", { frame: { jsonrpc: "2.0", id: "h2", method: "direct.enable", params: {} } });
    expect(r.last((f) => f["id"] === "h2")).toBeDefined();
  });

  test("a node without them is not asked again on this connection; a timeout waits 30 s, then two minutes; ready tries at once", async () => {
    const { core, p2p, timers, relay } = await onRelay();
    timers.advance(UPGRADE_DELAY_MS);
    p2p.refuse("unsupported");
    await tick();
    timers.advance(3_600_000);
    expect(p2p.opens).toHaveLength(1);
    // a new connection asks again
    relay.opened.at(-1)!.close(1006, "gone");
    timers.advance(1000);
    await tick();
    await tick();
    const r2 = relay.opened.at(-1)!;
    r2.deliver(helloOk(String(r2.last((f) => f["method"] === "hello")!["id"])));
    timers.advance(UPGRADE_DELAY_MS);
    expect(p2p.opens).toHaveLength(2);
    p2p.refuse("timeout");
    await tick();
    timers.advance(UPGRADE_BACKOFF_MS[0]! - 1);
    expect(p2p.opens).toHaveLength(2);
    timers.advance(1);
    expect(p2p.opens).toHaveLength(3);
    p2p.refuse("timeout");
    await tick();
    timers.advance(UPGRADE_BACKOFF_MS[0]!);
    expect(p2p.opens).toHaveLength(3);
    timers.advance(UPGRADE_BACKOFF_MS[1]! - UPGRADE_BACKOFF_MS[0]!);
    expect(p2p.opens).toHaveLength(4);
    // switched off on the node: nothing until it says ready
    p2p.refuse("unavailable");
    await tick();
    timers.advance(3_600_000);
    expect(p2p.opens).toHaveLength(4);
    r2.deliver({ jsonrpc: "2.0", method: "direct.state", params: { node: "node_other", state: "ready", peers: [] } });
    timers.advance(0);
    expect(p2p.opens).toHaveLength(4);
    r2.deliver({ jsonrpc: "2.0", method: "direct.state", params: { node: "node_1", state: "ready", peers: [] } });
    timers.advance(0);
    expect(p2p.opens).toHaveLength(5);
    expect(core.snapshot.via).toBe("relay");
  });

  test("while a stream shows or the button is held the link stays where it is", async () => {
    let quiet = false;
    const { p2p, timers } = await onRelay({ quiet: () => quiet });
    timers.advance(UPGRADE_DELAY_MS);
    await tick();
    expect(p2p.opens).toHaveLength(0);
    quiet = true;
    timers.advance(QUIET_RETRY_MS);
    await tick();
    expect(p2p.opens).toHaveLength(1);
  });

  test("a channel failing has the relay opened and promoted beside it before it goes; one lost outright reconnects as ever", async () => {
    const { core, p2p, timers, relay, states } = await onRelay();
    timers.advance(UPGRADE_DELAY_MS);
    const d = p2p.answer();
    await tick();
    d.deliver(helloOk("p4"));
    timers.advance(DRAIN_MS);
    expect(core.snapshot.via).toBe("p2p");
    const before = states.length;
    d.onfailing!();
    await tick();
    const back = relay.opened.at(-1)!;
    expect(back.last((f) => f["method"] === "hello")!["id"]).toBe("p4");
    back.deliver(helloOk("p4"));
    expect(core.snapshot).toMatchObject({ state: "connected", via: "relay" });
    expect(states.slice(before)).toEqual(["connected"]);
    timers.advance(DRAIN_MS);
    expect(d.closed?.reason).toBe("the link moved");
    // up again on the channel, then lost with no warning: the ordinary reconnect
    timers.advance(UPGRADE_DELAY_MS);
    const d2 = p2p.answer();
    await tick();
    d2.deliver(helloOk("p4"));
    d2.close(1006, "the direct channel closed");
    expect(core.snapshot.state).toBe("disconnected");
    timers.advance(1000);
    await tick();
    await tick();
    expect(relay.opened.at(-1)!.last((f) => f["method"] === "hello")!["id"]).toBe("p2");
  });

  test("on the channel the LAN is still tried, and takes over when it answers", async () => {
    const { core, p2p, timers, lan } = await onRelay();
    timers.advance(UPGRADE_DELAY_MS);
    const d = p2p.answer();
    await tick();
    d.deliver(helloOk("p4"));
    lan.reachable = true;
    timers.advance(60_000);
    await tick();
    await tick();
    lan.opened.at(-1)!.deliver(helloOk("p4"));
    expect(core.snapshot.via).toBe("lan");
    timers.advance(DRAIN_MS);
    expect(d.closed?.reason).toBe("the link moved");
  });
});
