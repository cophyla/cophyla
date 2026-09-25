// The phone's data channel over a played peer connection, with the node's end in WebCrypto:
// the offer carries a fresh key and the channel is keyed from it and the pairing secret; the
// phone's candidates wait for the channel's name and the node's for the answer; frames go
// both ways as sealed records cut into 16 KiB messages, and a forged one closes the channel;
// the page queues above 1 MiB and gives up past 8 MiB; ICE `disconnected` past the grace
// says failing once; the path comes from the selected pair; and what cannot open says why.

import { describe, expect, test } from "bun:test";
import { chunk, derive, ephemeral, pskFromHex, Reassembler } from "@cophyla/relay";
import type { Tunnel } from "@cophyla/relay";
import { CLOSE_AT, DirectError, HIGH_WATER, openDirect } from "../src/direct.ts";
import type { CandidateInit, ChannelLike, DirectTimers, PeerLike, Signalling } from "../src/direct.ts";
import type { Credential } from "../src/pairing.ts";

const KEY = "9f".repeat(32);
const CREDENTIAL: Credential = { token: "t", controller: "ctl_1", name: "Pixel", relay: { url: "https://orc.test", peer: "ctl_1", token: "rly", key: KEY } };

class FakeTimers implements DirectTimers {
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

class FakeChannel implements ChannelLike {
  readyState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  /** Held: sends pile up in `bufferedAmount` as a slow network would. */
  hold = false;
  readonly sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
    if (this.hold) this.bufferedAmount += data.length;
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.readyState = "open";
    this.onopen?.();
  }
  drain(): void {
    this.bufferedAmount = 0;
    this.onbufferedamountlow?.();
  }
}

class FakePeer implements PeerLike {
  localDescription: { sdp: string } | null = null;
  iceConnectionState = "new";
  readonly channel = new FakeChannel();
  readonly added: CandidateInit[] = [];
  remote?: string;
  closed = false;
  config: { iceServers: unknown[] };
  stats: Record<string, unknown>[] = [
    { id: "T1", type: "transport", selectedCandidatePairId: "CP1" },
    { id: "CP1", type: "candidate-pair", localCandidateId: "L1", remoteCandidateId: "R1", state: "succeeded", currentRoundTripTime: 0.0142 },
    { id: "L1", type: "local-candidate", candidateType: "srflx" },
    { id: "R1", type: "remote-candidate", candidateType: "host" },
  ];
  onicecandidate: ((ev: { candidate: CandidateInit | null }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  constructor(config: { iceServers: unknown[] }) {
    this.config = config;
  }
  createDataChannel(label: string, init: { ordered: boolean }): ChannelLike {
    expect(label).toBe("cophyla");
    expect(init.ordered).toBe(true);
    return this.channel;
  }
  async createOffer() {
    return { type: "offer", sdp: "fake-offer" };
  }
  async setLocalDescription(d: { type: string; sdp?: string }): Promise<void> {
    this.localDescription = { sdp: d.sdp! };
    // gathering starts: two candidates, and the end
    queueMicrotask(() => {
      this.onicecandidate?.({ candidate: { candidate: "candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host", sdpMid: "0", sdpMLineIndex: 0 } });
      this.onicecandidate?.({ candidate: { candidate: "candidate:2 1 udp 1686052607 203.0.113.9 61000 typ srflx", sdpMid: "0", sdpMLineIndex: 0 } });
      this.onicecandidate?.({ candidate: null });
    });
  }
  async setRemoteDescription(d: { type: "answer"; sdp: string }): Promise<void> {
    this.remote = d.sdp;
  }
  async addIceCandidate(c: CandidateInit): Promise<void> {
    this.added.push(c);
  }
  async getStats() {
    return { forEach: (fn: (r: Record<string, unknown>) => void) => this.stats.forEach(fn) };
  }
  close(): void {
    this.closed = true;
  }
  ice(state: string): void {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }
}

/** The node's side of the signalling: answers the two requests, keeps the tunnel it keyed, and sends candidates when told. */
class FakeNode implements Signalling {
  readonly requests: { method: string; params: Record<string, unknown> }[] = [];
  readonly signals: { method: string; params: Record<string, unknown> }[] = [];
  private listeners = new Set<(p: { peer: string; candidate: CandidateInit | null }) => void>();
  tunnel?: Tunnel;
  refuse?: { code: string; message: string };
  /** Candidates the node sends while it answers the offer, before the phone knows the channel's name. */
  early: CandidateInit[] = [{ candidate: "candidate:9 1 udp 2122260223 192.0.2.10 50000 typ host" }];
  async request(method: "direct.info" | "direct.offer", params: unknown): Promise<unknown> {
    const p = params as Record<string, unknown>;
    this.requests.push({ method, params: p });
    if (this.refuse) throw new DirectError(this.refuse.code, this.refuse.message);
    if (method === "direct.info") return { iceServers: [{ urls: ["turn:turn.example.test:3478"], username: "u", credential: "c" }], expiresAt: 1 };
    const mine = await ephemeral((p["curve"] as "x25519" | "p256") ?? "x25519");
    this.tunnel = await derive("responder", mine, String(p["epk"]), pskFromHex(KEY), { kind: "direct", peer: "ctl_1" });
    for (const c of this.early) this.candidate({ peer: "c1", candidate: c });
    this.candidate({ peer: "someone-else", candidate: { candidate: "candidate:x" } });
    return { peer: "c1", sdp: "fake-answer", epk: mine.publicKey };
  }
  signal(method: "direct.candidate", params: unknown): void {
    this.signals.push({ method, params: params as Record<string, unknown> });
  }
  onCandidate(fn: (p: { peer: string; candidate: CandidateInit | null }) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  candidate(p: { peer: string; candidate: CandidateInit | null }): void {
    for (const fn of [...this.listeners]) fn(p);
  }
  get listening(): number {
    return this.listeners.size;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function opened(opts: { timers?: FakeTimers } = {}) {
  const node = new FakeNode();
  const timers = opts.timers ?? new FakeTimers();
  let peer!: FakePeer;
  const opening = openDirect(node, {
    credential: CREDENTIAL,
    peer: (config) => (peer = new FakePeer(config)),
    timers,
  });
  for (let i = 0; i < 20 && !node.tunnel; i++) await tick();
  await tick();
  peer.channel.open();
  const duplex = await opening;
  return { node, peer, duplex, timers };
}

/** What the phone sent, back into frames as the node reads them. */
async function received(channel: FakeChannel, tunnel: Tunnel): Promise<string[]> {
  const r = new Reassembler();
  const out: string[] = [];
  for (const m of channel.sent.splice(0)) {
    const record = r.push(m);
    if (record !== undefined) out.push(await tunnel.open(record));
  }
  return out;
}

describe("the data channel on the phone", () => {
  test("the offer with a fresh key; the phone's candidates wait for the channel's name, the node's for the answer; the path from the selected pair", async () => {
    const { node, peer, duplex } = await opened();
    expect(peer.config.iceServers).toEqual([{ urls: ["turn:turn.example.test:3478"], username: "u", credential: "c" }]);
    expect(node.requests.map((r) => r.method)).toEqual(["direct.info", "direct.offer"]);
    expect(node.requests[1]!.params).toMatchObject({ sdp: "fake-offer", curve: expect.stringMatching(/^(x25519|p256)$/) });
    expect(peer.remote).toBe("fake-answer");
    // the node's early one, and never another channel's
    expect(peer.added).toEqual([{ candidate: "candidate:9 1 udp 2122260223 192.0.2.10 50000 typ host" }]);
    // the phone's two, named, and no end marker
    expect(node.signals.map((s) => s.params)).toEqual([
      { peer: "c1", candidate: { candidate: "candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host", sdpMid: "0", sdpMLineIndex: 0 } },
      { peer: "c1", candidate: { candidate: "candidate:2 1 udp 1686052607 203.0.113.9 61000 typ srflx", sdpMid: "0", sdpMLineIndex: 0 } },
    ]);
    // a late one from the node still lands
    node.candidate({ peer: "c1", candidate: { candidate: "candidate:10" } });
    expect(peer.added).toHaveLength(2);
    expect(duplex.path).toBe("direct");
    expect(duplex.rttMs).toBe(14);
    peer.stats[2] = { id: "L1", type: "local-candidate", candidateType: "relay" };
    await duplex.refreshPath();
    expect(duplex.path).toBe("turn");
  });

  test("frames both ways as sealed records in messages of 16 KiB at most; a forged one closes the channel", async () => {
    const { node, peer, duplex, timers } = await opened();
    const got: string[] = [];
    duplex.onmessage = (t) => got.push(t);
    duplex.send('{"jsonrpc":"2.0","id":"h1","method":"hello"}');
    const big = JSON.stringify({ jsonrpc: "2.0", method: "session.event", params: { text: "x".repeat(50_000) } });
    duplex.send(big);
    // sealing is WebCrypto's, a tick or more a record
    for (let i = 0; i < 500 && peer.channel.sent.length <= 4; i++) await tick();
    expect(peer.channel.sent.every((m) => m.length <= 16 * 1024)).toBe(true);
    expect(peer.channel.sent.length).toBeGreaterThan(4);
    expect(await received(peer.channel, node.tunnel!)).toEqual(['{"jsonrpc":"2.0","id":"h1","method":"hello"}', big]);
    for (const m of chunk(await node.tunnel!.seal('{"jsonrpc":"2.0","id":"h1","result":{}}'))) peer.channel.onmessage!({ data: m });
    for (let i = 0; i < 500 && got.length === 0; i++) await tick();
    expect(got).toEqual(['{"jsonrpc":"2.0","id":"h1","result":{}}']);
    const closes: [number, string][] = [];
    duplex.onclose = (code, reason) => closes.push([code, reason]);
    peer.channel.onmessage!({ data: "=bm90IGEgcmVjb3Jk" });
    await tick();
    timers.advance(0);
    expect(closes).toEqual([[4401, "a record on the direct channel failed to open"]]);
    expect(peer.closed).toBe(true);
    expect(node.listening).toBe(0);
  });

  test("above 1 MiB the page queues and flushes on low water; past 8 MiB the channel is given up", async () => {
    const { peer, duplex, timers } = await opened();
    peer.channel.hold = true;
    const frame = "y".repeat(12_000);
    for (let i = 0; i < 100; i++) duplex.send(frame);
    // sealing is WebCrypto's, a tick or more a record
    for (let i = 0; i < 500 && duplex.buffered() < 100 * 16_000; i++) await tick();
    expect(peer.channel.bufferedAmount).toBeGreaterThan(HIGH_WATER);
    expect(peer.channel.bufferedAmount).toBeLessThan(HIGH_WATER + 17_000);
    const queued = duplex.buffered() - peer.channel.bufferedAmount;
    expect(queued).toBeGreaterThan(0);
    const before = peer.channel.sent.length;
    peer.channel.drain();
    expect(peer.channel.sent.length).toBeGreaterThan(before);
    const closes: number[] = [];
    duplex.onclose = (code) => closes.push(code);
    for (let i = 0; i < 700; i++) duplex.send(frame);
    for (let i = 0; i < 2000 && closes.length === 0; i++) {
      await tick();
      timers.advance(0);
    }
    expect(closes).toEqual([4408]);
    expect(CLOSE_AT).toBe(8 * 1024 * 1024);
  });

  test("ICE disconnected past the grace says failing once; back in time it says nothing; failed ends the channel, and onclose fires once", async () => {
    const { peer, duplex, timers } = await opened();
    let failing = 0;
    duplex.onfailing = () => failing++;
    peer.ice("disconnected");
    timers.advance(2999);
    peer.ice("connected");
    timers.advance(10_000);
    expect(failing).toBe(0);
    peer.ice("disconnected");
    timers.advance(3000);
    expect(failing).toBe(1);
    const closes: [number, string][] = [];
    duplex.onclose = (code, reason) => closes.push([code, reason]);
    peer.ice("failed");
    duplex.close(1000, "again");
    timers.advance(0);
    expect(failing).toBe(1);
    expect(closes).toEqual([[1006, "the direct path failed"]]);
  });

  test("no channel within the timeout, a refusal with its code, and no secret to key with: each says why and leaves nothing open", async () => {
    const timers = new FakeTimers();
    const node = new FakeNode();
    let peer!: FakePeer;
    const opening = openDirect(node, { credential: CREDENTIAL, peer: (c) => (peer = new FakePeer(c)), timers, openTimeoutMs: 15_000 });
    for (let i = 0; i < 20 && !node.tunnel; i++) await tick();
    await tick();
    timers.advance(15_000);
    await expect(opening).rejects.toMatchObject({ code: "timeout" });
    expect(peer.closed).toBe(true);
    expect(node.listening).toBe(0);
    const off = new FakeNode();
    off.refuse = { code: "unavailable", message: "direct connections are not running on this node" };
    await expect(openDirect(off, { credential: CREDENTIAL, peer: (c) => new FakePeer(c), timers })).rejects.toMatchObject({ code: "unavailable" });
    const { relay: _none, ...bare } = CREDENTIAL;
    await expect(openDirect(new FakeNode(), { credential: bare, peer: (c) => new FakePeer(c), timers })).rejects.toMatchObject({ code: "unsupported" });
  });
});
