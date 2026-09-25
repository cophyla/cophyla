// The phone's direct path to its node: a WebRTC data channel from the web view to the node's
// helper, found with the STUN and TURN servers the node hands out (`direct.info`) and
// signalled over the link the phone already has (`direct.offer`, then `direct.candidate`
// both ways as each side finds its addresses). Nothing crosses the channel in the clear:
// every frame is an `@cophyla/relay` record of the `direct` kind, keyed from fresh ephemerals
// exchanged in the offer and the pairing secret, so only the node this phone paired with can
// read it and the helper in between handles ciphertext; each record is cut into messages of
// 16 KiB at most. A channel that stops answering is given a moment (ICE's `disconnected`
// often heals), then reported failing, so the link can move before it is lost.

import { chunk, derive, ephemeral, pskFromHex, Reassembler } from "@cophyla/relay";
import type { Ephemeral, Tunnel } from "@cophyla/relay";
import type { Credential } from "./pairing.ts";
import type { Duplex } from "./transport.ts";

export interface IceServerLike {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface CandidateInit {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

/** The slice of `RTCDataChannel` this module drives. */
export interface ChannelLike {
  readonly readyState: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onbufferedamountlow: (() => void) | null;
}

/** The slice of `RTCPeerConnection` this module drives, so the tests can play it. */
export interface PeerLike {
  readonly localDescription: { sdp: string } | null;
  readonly iceConnectionState: string;
  createDataChannel(label: string, init: { ordered: boolean }): ChannelLike;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(description: { type: string; sdp?: string }): Promise<void>;
  setRemoteDescription(description: { type: "answer"; sdp: string }): Promise<void>;
  addIceCandidate(candidate: CandidateInit): Promise<void>;
  getStats(): Promise<{ forEach(fn: (report: Record<string, unknown>) => void): void }>;
  close(): void;
  onicecandidate: ((ev: { candidate: CandidateInit | null }) => void) | null;
  oniceconnectionstatechange: (() => void) | null;
}

export type PeerFactory = (config: { iceServers: IceServerLike[] }) => PeerLike;

/** How the link's current connection carries the signalling: requests with the core's own ids, the candidates as signals. */
export interface Signalling {
  request(method: "direct.info" | "direct.offer", params: unknown, timeoutMs: number): Promise<unknown>;
  signal(method: "direct.candidate", params: unknown): void;
  /** Every `direct.candidate` the node sends while this is listened to. */
  onCandidate(fn: (params: { peer: string; candidate: CandidateInit | null }) => void): () => void;
}

export interface DirectTimers {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DirectOptions {
  credential: Credential;
  peer: PeerFactory;
  /** The records' ephemeral: X25519, or P-256 in a web view without it. */
  ephemeral?: () => Promise<Ephemeral>;
  timers?: DirectTimers;
  /** How long the channel may take to open once the offer is answered. */
  openTimeoutMs?: number;
  /** How long ICE may say `disconnected` before the channel is reported failing. */
  graceMs?: number;
}

/** A failure with the node's code, when it gave one: `unsupported` and `denied` stop the upgrades, `unavailable` waits for the node. */
export class DirectError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const OPEN_TIMEOUT_MS = 15_000;
export const GRACE_MS = 3_000;
const REQUEST_MS = 15_000;
/** Above this the frames wait in the page; past `CLOSE_AT` the channel is given up as too slow. */
export const HIGH_WATER = 1024 * 1024;
export const CLOSE_AT = 8 * 1024 * 1024;
const LOW_WATER = 256 * 1024;

const REAL_TIMERS: DirectTimers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** X25519 where the web view has it, P-256 where it does not. */
export async function preferredEphemeral(): Promise<Ephemeral> {
  try {
    return await ephemeral("x25519");
  } catch {
    return ephemeral("p256");
  }
}

function candidateOf(c: CandidateInit): CandidateInit {
  const out: CandidateInit = { candidate: c.candidate };
  if (c.sdpMid !== undefined && c.sdpMid !== null) out.sdpMid = c.sdpMid;
  if (c.sdpMLineIndex !== undefined && c.sdpMLineIndex !== null) out.sdpMLineIndex = c.sdpMLineIndex;
  return out;
}

/**
 * Opens a data channel to the node the signalling reaches: its servers, a peer connection
 * with one ordered channel, the offer with a fresh key, the answer and the node's key, the
 * candidates both ways (the phone's own held until the node named the channel, the node's
 * held until the answer is in), and the channel's `open` within the timeout.
 */
export async function openDirect(sig: Signalling, opts: DirectOptions): Promise<DirectDuplex> {
  const access = opts.credential.relay;
  if (!access) throw new DirectError("unsupported", "this phone has no relay secret to key a direct channel with");
  const timers = opts.timers ?? REAL_TIMERS;
  const info = (await sig.request("direct.info", {}, REQUEST_MS)) as { iceServers?: IceServerLike[] };
  const pc = opts.peer({ iceServers: info.iceServers ?? [] });
  const channel = pc.createDataChannel("cophyla", { ordered: true });
  let peer: string | undefined;
  let answered = false;
  const mine: CandidateInit[] = [];
  const theirs: { peer: string; candidate: CandidateInit | null }[] = [];
  pc.onicecandidate = (ev) => {
    // the end of the phone's candidates needs no word: the node's checks go on regardless
    if (!ev.candidate || !ev.candidate.candidate) return;
    const c = candidateOf(ev.candidate);
    if (peer !== undefined) sig.signal("direct.candidate", { peer, candidate: c });
    else mine.push(c);
  };
  const add = (p: { peer: string; candidate: CandidateInit | null }): void => {
    if (p.peer !== peer || !p.candidate) return;
    void pc.addIceCandidate(candidateOf(p.candidate)).catch(() => undefined);
  };
  const off = sig.onCandidate((p) => {
    if (!answered) theirs.push(p);
    else add(p);
  });
  try {
    const eph = await (opts.ephemeral ?? preferredEphemeral)();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdp = pc.localDescription?.sdp ?? offer.sdp;
    if (!sdp) throw new DirectError("unavailable", "the web view made no offer");
    const answer = (await sig.request("direct.offer", { sdp, epk: eph.publicKey, curve: eph.curve }, REQUEST_MS)) as { peer: string; sdp: string; epk: string };
    peer = answer.peer;
    const tunnel = await derive("initiator", eph, answer.epk, pskFromHex(access.key), { kind: "direct", peer: opts.credential.controller });
    await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    answered = true;
    for (const p of theirs.splice(0)) add(p);
    for (const c of mine.splice(0)) sig.signal("direct.candidate", { peer, candidate: c });
    await opened(channel, timers, opts.openTimeoutMs ?? OPEN_TIMEOUT_MS);
    const duplex = new DirectDuplex(pc, channel, tunnel, { timers, graceMs: opts.graceMs ?? GRACE_MS, onEnd: off });
    await duplex.refreshPath();
    return duplex;
  } catch (e) {
    off();
    pc.onicecandidate = null;
    try {
      channel.close();
      pc.close();
    } catch {
      // already closed
    }
    throw e;
  }
}

function opened(channel: ChannelLike, timers: DirectTimers, timeoutMs: number): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = timers.setTimeout(() => {
      channel.onopen = null;
      channel.onclose = null;
      reject(new DirectError("timeout", `no direct path opened within ${timeoutMs / 1000} s`));
    }, timeoutMs);
    channel.onopen = () => {
      timers.clearTimeout(timer);
      channel.onopen = null;
      channel.onclose = null;
      resolve();
    };
    channel.onclose = () => {
      timers.clearTimeout(timer);
      channel.onopen = null;
      channel.onclose = null;
      reject(new DirectError("unavailable", "the direct channel closed before it opened"));
    };
  });
}

/** An open data channel as the link core's duplex: sealed, chunked records both ways, with the page's own queue above the channel's. */
export class DirectDuplex implements Duplex {
  onmessage: ((text: string) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  /** ICE stopped answering past the grace, or failed: the link should move before the channel is lost. */
  onfailing: (() => void) | null = null;
  /** How the selected pair reaches the node: `turn` through a relay candidate, `direct` otherwise. */
  path: "direct" | "turn" | undefined;
  rttMs: number | undefined;
  private pc: PeerLike;
  private channel: ChannelLike;
  private tunnel: Tunnel;
  private timers: DirectTimers;
  private graceMs: number;
  private onEnd: () => void;
  private reassembler = new Reassembler();
  private sending: Promise<void> = Promise.resolve();
  private queue: string[] = [];
  private queued = 0;
  private grace: unknown;
  private failing = false;
  private ended = false;

  constructor(pc: PeerLike, channel: ChannelLike, tunnel: Tunnel, opts: { timers: DirectTimers; graceMs: number; onEnd: () => void }) {
    this.pc = pc;
    this.channel = channel;
    this.tunnel = tunnel;
    this.timers = opts.timers;
    this.graceMs = opts.graceMs;
    this.onEnd = opts.onEnd;
    channel.bufferedAmountLowThreshold = LOW_WATER;
    channel.onbufferedamountlow = () => this.flush();
    channel.onmessage = (ev) => this.receive(String(ev.data));
    channel.onclose = () => this.end(1006, "the direct channel closed");
    pc.oniceconnectionstatechange = () => this.iceChanged();
  }

  send(text: string): void {
    if (this.ended) return;
    this.sending = this.sending
      .then(async () => {
        const record = await this.tunnel.seal(text);
        for (const message of chunk(record)) this.push(message);
      })
      .catch(() => this.end(1011, "a record could not be sealed"));
  }

  close(code = 1000, reason = ""): void {
    this.end(code, reason);
  }

  /** Bytes waiting: the channel's own and the page's queue above it. */
  buffered(): number {
    return (this.ended ? 0 : this.channel.bufferedAmount) + this.queued;
  }

  private push(message: string): void {
    if (this.ended) return;
    if (this.queue.length > 0 || this.channel.bufferedAmount > HIGH_WATER) {
      this.queue.push(message);
      this.queued += message.length;
      if (this.queued + this.channel.bufferedAmount > CLOSE_AT) this.end(4408, "the direct channel fell behind");
      return;
    }
    this.channel.send(message);
  }

  private flush(): void {
    while (!this.ended && this.queue.length > 0 && this.channel.bufferedAmount <= HIGH_WATER) {
      const message = this.queue.shift()!;
      this.queued -= message.length;
      this.channel.send(message);
    }
  }

  private receive(message: string): void {
    if (this.ended) return;
    let record: string | undefined;
    try {
      record = this.reassembler.push(message);
    } catch {
      this.end(4401, "a malformed message on the direct channel");
      return;
    }
    if (record === undefined) return;
    // opens are serialized in the tunnel, so the frames come out in order
    this.tunnel.open(record).then(
      (text) => {
        if (!this.ended) this.onmessage?.(text);
      },
      () => this.end(4401, "a record on the direct channel failed to open"),
    );
  }

  private iceChanged(): void {
    const state = this.pc.iceConnectionState;
    if (state === "connected" || state === "completed") {
      if (this.grace !== undefined) this.timers.clearTimeout(this.grace);
      this.grace = undefined;
      this.failing = false;
      void this.refreshPath();
      return;
    }
    if (state === "disconnected") {
      if (this.grace !== undefined || this.failing) return;
      this.grace = this.timers.setTimeout(() => {
        this.grace = undefined;
        this.fail();
      }, this.graceMs);
      return;
    }
    if (state === "failed" || state === "closed") {
      this.fail();
      this.end(1006, "the direct path failed");
    }
  }

  private fail(): void {
    if (this.failing || this.ended) return;
    this.failing = true;
    this.onfailing?.();
  }

  /** Reads the selected pair: a relay candidate at either end means TURN carries it. */
  async refreshPath(): Promise<void> {
    try {
      const stats = await this.pc.getStats();
      const byId = new Map<string, Record<string, unknown>>();
      let selected: string | undefined;
      stats.forEach((r) => {
        byId.set(String(r["id"]), r);
        if (r["type"] === "transport" && typeof r["selectedCandidatePairId"] === "string") selected = r["selectedCandidatePairId"];
      });
      let pair = selected ? byId.get(selected) : undefined;
      if (!pair) for (const r of byId.values()) if (r["type"] === "candidate-pair" && r["state"] === "succeeded" && (r["nominated"] === true || r["selected"] === true)) pair = r;
      if (!pair) return;
      const local = byId.get(String(pair["localCandidateId"]));
      const remote = byId.get(String(pair["remoteCandidateId"]));
      this.path = local?.["candidateType"] === "relay" || remote?.["candidateType"] === "relay" ? "turn" : "direct";
      const rtt = pair["currentRoundTripTime"];
      if (typeof rtt === "number") this.rttMs = Math.round(rtt * 1000);
    } catch {
      // the stats are a nicety
    }
  }

  private end(code: number, reason: string): void {
    if (this.ended) return;
    this.ended = true;
    if (this.grace !== undefined) this.timers.clearTimeout(this.grace);
    this.queue = [];
    this.queued = 0;
    this.onEnd();
    this.channel.onmessage = null;
    this.channel.onclose = null;
    this.channel.onbufferedamountlow = null;
    this.pc.oniceconnectionstatechange = null;
    this.pc.onicecandidate = null;
    try {
      this.channel.close();
      this.pc.close();
    } catch {
      // already closed
    }
    // once, and after the caller's own close returned, as a socket's would
    this.timers.setTimeout(() => this.onclose?.(code, reason), 0);
  }
}
