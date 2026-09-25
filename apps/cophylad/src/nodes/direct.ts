// A relayed node link's data channel. The secondary offers one shortly after it joined
// (`direct.offer` on the link, its own helper's SDP and a fresh key), the primary's helper
// answers, the candidates cross as `direct.candidate` frames, and the records are keyed from
// the two keys and the secondary's grant key (the one its link is sealed with), bound to the
// secondary. Once the helpers say it is open,
// the channel is handed to the link's switch, which moves the frames when it has proven
// the channel both ways. ICE gives up within six seconds, inside the link's heartbeats, so a
// lost path falls back to the relay before anyone calls the node gone. A primary that does
// not know the offer (an older one) leaves the link on the relay; any other failure is tried
// again after a minute, then two, doubling up to half an hour.

import { randomBytes } from "node:crypto";
import { RpcError } from "@cophyla/protocol";
import type { DirectPathType } from "@cophyla/protocol";
import { derive, ephemeral } from "@cophyla/relay";
import type { Psk, RelayCurve, Tunnel } from "@cophyla/relay";
import type { Direct } from "../direct/index.ts";
import { ChannelSocket } from "../direct/peers.ts";
import type { Logger } from "../log.ts";
import type { SwitchableLink } from "./switch.ts";

/** ICE's clocks for a node link: inside two heartbeats, so the fallback comes before the link is called gone. */
export const NODE_ICE = { disconnectedMs: 2500, failedMs: 6000 };
/** After a link-up, how long the secondary waits before it offers. */
export const FIRST_TRY_MS = 2000;
/** The waits after a try that did not open, or a channel that was lost. */
export const RETRY_MS = [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000];
/** How long a channel has from the offer to `open`. */
export const OPEN_MS = 20_000;

export interface LinkDirectDeps {
  direct: Direct;
  link: SwitchableLink;
  /** Requests and frames on the node link itself. */
  request: (method: string, params: unknown, opts?: { timeoutMs?: number }) => Promise<unknown>;
  notify: (method: string, params: unknown) => boolean;
  /** The secondary's grant key as it stands now, a re-key included; undefined once the grant is gone. */
  psk: () => Psk | undefined;
  /** Which end: the secondary offers, the primary answers. */
  role: "secondary" | "primary";
  /** The secondary's id: what the records are bound to. */
  secondary: string;
  /** The other end's id, for `direct.state`. */
  other: string;
  /** `[direct] nodes`. */
  enabled: () => boolean;
  log: Logger;
  /** The channel carries the link now, with its path; `undefined` when it went back to the relay. */
  onPath?: (p: { path: DirectPathType; rttMs?: number; since: number } | undefined) => void;
  now?: () => number;
  /** The waits, shorter in the tests. */
  timing?: LinkDirectTiming;
}

export interface LinkDirectTiming {
  firstTryMs?: number;
  retryMs?: number[];
}

interface Attempt {
  id: string;
  tunnel?: Tunnel;
  socket?: ChannelSocket;
  path?: DirectPathType;
  since: number;
  timer?: ReturnType<typeof setTimeout>;
}

export class LinkDirect {
  private deps: LinkDirectDeps;
  private log: Logger;
  private attempt?: Attempt;
  private blocked = false;
  private backoff = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private off: () => void;

  constructor(deps: LinkDirectDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.off = deps.direct.onPeer((method, params) => this.onPeer(method, params));
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Whether `attempt` is still the one: an await may have ended it. */
  private isCurrent(attempt: Attempt): boolean {
    return this.attempt === attempt;
  }

  private get peerKey(): string {
    return `node:${this.deps.other}`;
  }

  /** The grant key the channel's records are keyed from. */
  private key(): Psk {
    const psk = this.deps.psk();
    if (!psk) throw new RpcError("denied", "the link's grant is gone");
    return psk;
  }

  // --- the secondary's tries ------------------------------------------------------------------

  /** Offers a channel after `ms`, unless one is up or the primary said it cannot. */
  schedule(ms: number): void {
    if (this.deps.role !== "secondary" || this.stopped || this.blocked) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tryNow();
    }, ms);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  private retry(): void {
    const waits = this.deps.timing?.retryMs ?? RETRY_MS;
    const ms = waits[Math.min(this.backoff, waits.length - 1)]!;
    this.backoff++;
    this.schedule(ms);
  }

  /** The first try, after the join. */
  start(): void {
    this.schedule(this.deps.timing?.firstTryMs ?? FIRST_TRY_MS);
  }

  async tryNow(): Promise<void> {
    if (this.deps.role !== "secondary" || this.stopped || this.blocked || this.attempt || this.deps.link.hasChannel) return;
    if (!this.deps.enabled() || !this.deps.direct.ready) {
      // not now: the next link-up, or the next try, asks again
      this.retry();
      return;
    }
    const attempt: Attempt = { id: `n_${randomBytes(8).toString("hex")}`, since: this.now() };
    this.begin(attempt);
    try {
      const offer = (await this.deps.direct.request("peer.offer", { peer: attempt.id, ice: NODE_ICE })) as { sdp: string };
      const mine = await ephemeral("x25519");
      const answer = (await this.deps.request("direct.offer", { attempt: attempt.id, sdp: offer.sdp, epk: mine.publicKey, curve: mine.curve }, { timeoutMs: 15_000 })) as { sdp: string; epk: string };
      if (!this.isCurrent(attempt)) return;
      attempt.tunnel = await derive("initiator", mine, answer.epk, this.key(), { kind: "direct", peer: this.deps.secondary });
      await this.deps.direct.request("peer.accept", { peer: attempt.id, sdp: answer.sdp });
    } catch (e) {
      if (!this.isCurrent(attempt)) return;
      const code = e instanceof RpcError ? e.code : undefined;
      this.fail(attempt, e instanceof Error ? e.message : String(e));
      if (code === "unsupported") {
        this.blocked = true;
        this.log.info("the primary has no direct connections for links; this one stays on the relay");
      }
    }
  }

  // --- the primary's answer --------------------------------------------------------------------

  /** `direct.offer` from the secondary: this node's helper answers it, and this node's key. */
  async answer(params: { attempt: string; sdp: string; epk: string; curve?: RelayCurve }): Promise<{ sdp: string; epk: string }> {
    if (this.deps.role !== "primary") throw new RpcError("unsupported", "only the primary answers a link's channel");
    if (!this.deps.enabled()) throw new RpcError("unsupported", "direct connections are off for links on this node");
    if (!this.deps.direct.ready) throw new RpcError("unavailable", "direct connections are not running on this node");
    if (this.attempt) this.fail(this.attempt, "a newer offer");
    const attempt: Attempt = { id: params.attempt, since: this.now() };
    this.begin(attempt);
    try {
      const mine = await ephemeral(params.curve ?? "x25519");
      attempt.tunnel = await derive("responder", mine, params.epk, this.key(), { kind: "direct", peer: this.deps.secondary });
      const answer = (await this.deps.direct.request("peer.answer", { peer: attempt.id, sdp: params.sdp, ice: NODE_ICE })) as { sdp: string };
      return { sdp: answer.sdp, epk: mine.publicKey };
    } catch (e) {
      this.fail(attempt, e instanceof Error ? e.message : String(e));
      throw e instanceof RpcError ? e : new RpcError("unavailable", e instanceof Error ? e.message : String(e));
    }
  }

  /** A candidate from the other end, for the attempt it names. */
  candidate(params: { attempt: string; candidate: unknown }): void {
    const attempt = this.attempt;
    if (!attempt || attempt.id !== params.attempt || attempt.socket) return;
    void this.deps.direct.request("peer.candidate", { peer: attempt.id, candidate: params.candidate }).catch(() => undefined);
  }

  // --- the helper's side -------------------------------------------------------------------------

  private begin(attempt: Attempt): void {
    this.attempt = attempt;
    attempt.timer = setTimeout(() => {
      if (this.attempt === attempt && !attempt.socket) this.fail(attempt, "no path opened in time");
    }, OPEN_MS);
    if (typeof attempt.timer === "object" && "unref" in attempt.timer) attempt.timer.unref();
  }

  private onPeer(method: string, params: unknown): void {
    const attempt = this.attempt;
    if (!attempt) return;
    if (method === "helper.down") {
      this.lost(attempt, "the direct helper stopped");
      return;
    }
    const p = (params ?? {}) as { peer?: unknown };
    if (p.peer !== attempt.id) return;
    switch (method) {
      case "peer.candidate":
        if (!attempt.socket) this.deps.notify("direct.candidate", { attempt: attempt.id, candidate: (params as { candidate?: unknown }).candidate ?? null });
        return;
      case "peer.open":
        this.opened(attempt);
        return;
      case "peer.data": {
        const data = (params as { data?: unknown }).data;
        if (typeof data === "string") attempt.socket?.receive(data);
        return;
      }
      case "peer.buffered": {
        const n = (params as { buffered?: unknown }).buffered;
        if (typeof n === "number") attempt.socket?.setBuffered(n);
        return;
      }
      case "peer.path": {
        const path = params as { type?: DirectPathType; rttMs?: number };
        if (!path.type) return;
        if (attempt.path === undefined && attempt.socket) this.deps.direct.report.count("node", path.type);
        attempt.path = path.type;
        const at = { path: path.type, since: attempt.since, ...(typeof path.rttMs === "number" ? { rttMs: path.rttMs } : {}) };
        this.deps.direct.setPeer(this.peerKey, { kind: "node", id: this.deps.other, ...at });
        if (this.deps.link.mode === "direct") this.deps.onPath?.(at);
        return;
      }
      case "peer.state": {
        const state = (params as { state?: unknown }).state;
        if (state === "failed" || state === "closed") this.lost(attempt, `the channel ${state}`);
        return;
      }
    }
  }

  private opened(attempt: Attempt): void {
    if (attempt.socket || !attempt.tunnel) return;
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.timer = undefined;
    const socket = new ChannelSocket({
      peer: attempt.id,
      tunnel: attempt.tunnel,
      send: (data) => this.deps.direct.notify("peer.send", { peer: attempt.id, data }),
      // the switch gave the channel up (silence, or the other side fell back)
      close: (_code, reason) => this.lost(attempt, reason),
      log: this.log,
      remote: `direct:${attempt.id}`,
    });
    attempt.socket = socket;
    this.backoff = 0;
    this.log.info("node link's data channel open", { attempt: attempt.id, other: this.deps.other });
    this.deps.link.attach(socket);
  }

  /** An attempt that never opened: the helper told, counted as failed, tried again later. */
  private fail(attempt: Attempt, reason: string): void {
    if (!this.isCurrent(attempt)) return;
    this.attempt = undefined;
    if (attempt.timer) clearTimeout(attempt.timer);
    this.deps.direct.report.count("node", "failed");
    void this.deps.direct.request("peer.close", { peer: attempt.id }).catch(() => undefined);
    this.log.info("node link's data channel did not open", { attempt: attempt.id, reason });
    this.retry();
  }

  /** An open channel gone: the switch falls back, the helper is told, the path forgotten, and the secondary tries again later. */
  private lost(attempt: Attempt, reason: string): void {
    if (!this.isCurrent(attempt)) return;
    if (!attempt.socket) {
      this.fail(attempt, reason);
      return;
    }
    this.attempt = undefined;
    attempt.socket.ended(reason);
    void this.deps.direct.request("peer.close", { peer: attempt.id }).catch(() => undefined);
    this.deps.direct.dropPeer(this.peerKey);
    this.deps.onPath?.(undefined);
    this.retry();
  }

  /** The switch moved the link's frames: the path shows while the channel carries them. */
  modeChanged(mode: "relay" | "direct"): void {
    const attempt = this.attempt;
    if (mode === "direct" && attempt?.path) this.deps.onPath?.({ path: attempt.path, since: attempt.since });
    else if (mode === "relay") this.deps.onPath?.(undefined);
  }

  /** The link ended: its channel, its tries and its row go. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.off();
    if (this.timer) clearTimeout(this.timer);
    const attempt = this.attempt;
    this.attempt = undefined;
    if (attempt) {
      if (attempt.timer) clearTimeout(attempt.timer);
      attempt.socket?.ended("the link ended");
      void this.deps.direct.request("peer.close", { peer: attempt.id }).catch(() => undefined);
      this.deps.direct.dropPeer(this.peerKey);
    }
  }
}
