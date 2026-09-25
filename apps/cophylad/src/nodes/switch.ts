// A relayed node link whose frames can move to a data channel and back without the link's
// RPC noticing. It sits between the relay tunnel and the link's `RpcPeer`: what the peer
// writes goes on the relay until the channel is proven both ways, then on the channel,
// numbered; what arrives from either is handed to the peer in the order it was sent.
//
// The switch: when the channel opens, each side sends `link.ack` on it at once and every
// second after. A side that has heard the other's ack on the channel sends `link.switch` as
// its last frame on the relay, and from then on sends each frame on the channel as
// `link.replay {n, f}`. The other side reads the relay up to that `link.switch`, then the
// channel; channel frames that came first wait for it.
//
// The fallback: the channel silent for three seconds (no ack), failed, or gone with the
// helper. Silence is measured on the monotonic clock: a wall clock set forward (NTP, a VM's
// time sync) is not three seconds without an ack. The side that notices sends `link.fallback {received}` on the relay, the count of
// the other's channel frames it took, and holds what it sends until the other's fallback
// says how many of its own arrived; the rest go again on the relay as `link.replay`, taken
// once each by their number, and then the held frames. The side that hears a fallback first
// falls back itself. More than 8 MiB sent on the channel and not acknowledged ends the link
// (4408): a replay that large would stall the relay for everything else.

import type { Logger } from "../log.ts";

/** A data channel as the link sees it: sealed text frames both ways. */
export interface LinkChannel {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  attach(onText: (text: string) => void, onEnd: (code: number, reason: string) => void): void;
}

export interface SwitchTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface SwitchableLinkDeps {
  /** The relay tunnel's send. */
  relay: (text: string) => boolean;
  /** Hands a frame to the link's `RpcPeer`. */
  deliver: (text: string) => void;
  /** Ends the whole link: the replay grew past its cap. */
  close: (code: number, reason: string) => void;
  log: Logger;
  /** The link's frames now go on the channel, or on the relay again. */
  onMode?: (mode: "relay" | "direct") => void;
  timers?: SwitchTimers;
  /** Milliseconds on a clock that only moves forward; the monotonic one by default. */
  now?: () => number;
  ackMs?: number;
  silenceMs?: number;
  replayCapBytes?: number;
}

export const ACK_MS = 1000;
export const SILENCE_MS = 3000;
export const REPLAY_CAP_BYTES = 8 * 1024 * 1024;
export const LINK_TOO_FAR_BEHIND = 4408;

const REAL_TIMERS: SwitchTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

const frame = (method: string, params: unknown): string => JSON.stringify({ jsonrpc: "2.0", method, params });

/** A link-control notification, from text that might be one; anything else is the link's own. */
function control(text: string): { method: string; params: Record<string, unknown> } | undefined {
  if (!text.includes('"link.')) return undefined;
  try {
    const m = JSON.parse(text) as { method?: unknown; params?: unknown; id?: unknown };
    if (typeof m.method !== "string" || !m.method.startsWith("link.") || m.id !== undefined) return undefined;
    return { method: m.method, params: (m.params ?? {}) as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

export class SwitchableLink {
  private deps: SwitchableLinkDeps;
  private log: Logger;
  /** Where this side's frames go: the relay, the channel, or held until the other side's fallback. */
  private out: "relay" | "direct" | "held" = "relay";
  private sent = 0;
  private unacked: { n: number; f: string }[] = [];
  private unackedBytes = 0;
  private held: string[] = [];
  /** The other side said `link.switch`: its frames come on the channel. */
  private inFromChannel = false;
  private received = 0;
  private early: { n: number; f: string }[] = [];
  private channel?: LinkChannel;
  private acked = false;
  private lastAck = 0;
  private ticker?: unknown;
  private closed = false;

  constructor(deps: SwitchableLinkDeps) {
    this.deps = deps;
    this.log = deps.log;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : performance.now();
  }

  private timers(): SwitchTimers {
    return this.deps.timers ?? REAL_TIMERS;
  }

  /** Where this side's frames go now. */
  get mode(): "relay" | "direct" {
    return this.out === "direct" ? "direct" : "relay";
  }

  get hasChannel(): boolean {
    return this.channel !== undefined;
  }

  // --- the RpcPeer's side -----------------------------------------------------------------------

  /** A frame from the link's peer. */
  send(text: string): boolean {
    if (this.closed) return false;
    switch (this.out) {
      case "relay":
        return this.deps.relay(text);
      case "held":
        this.held.push(text);
        return true;
      case "direct": {
        const n = ++this.sent;
        this.unacked.push({ n, f: text });
        this.unackedBytes += text.length;
        if (this.unackedBytes > (this.deps.replayCapBytes ?? REPLAY_CAP_BYTES)) {
          this.log.warn("the direct channel fell too far behind; the link ends", { unacked: this.unacked.length, bytes: this.unackedBytes });
          this.shut();
          this.deps.close(LINK_TOO_FAR_BEHIND, "the direct channel fell too far behind");
          return false;
        }
        this.channel!.send(frame("link.replay", { n, f: text }));
        return true;
      }
    }
  }

  /** A frame from the relay tunnel. */
  fromRelay(text: string): void {
    if (this.closed) return;
    const c = control(text);
    if (!c) {
      this.deps.deliver(text);
      return;
    }
    switch (c.method) {
      case "link.switch":
        this.inFromChannel = true;
        for (const e of this.early.splice(0)) this.numbered(e.n, e.f);
        return;
      case "link.fallback":
        this.peerFellBack(typeof c.params["received"] === "number" ? c.params["received"] : 0);
        return;
      case "link.replay":
        if (typeof c.params["n"] === "number" && typeof c.params["f"] === "string") this.numbered(c.params["n"], c.params["f"]);
        return;
      default:
        // an ack or a control this side does not know: never the link's
        return;
    }
  }

  // --- the channel ------------------------------------------------------------------------------

  /** The data channel opened: its hello goes at once, then an ack every second, which the other side's silence is measured by. */
  attach(channel: LinkChannel): void {
    if (this.closed) {
      channel.close(1000, "the link is gone");
      return;
    }
    if (this.channel) this.lose("a newer channel");
    this.channel = channel;
    this.acked = false;
    this.lastAck = this.now();
    channel.attach(
      (text) => this.fromChannel(channel, text),
      (_code, reason) => {
        if (this.channel === channel) this.lose(reason || "the channel closed");
      },
    );
    this.sendAck();
    this.ticker = this.timers().setInterval(() => this.tick(), this.deps.ackMs ?? ACK_MS);
  }

  private tick(): void {
    if (!this.channel) return;
    if (this.now() - this.lastAck > (this.deps.silenceMs ?? SILENCE_MS)) {
      this.lose("the channel went silent");
      return;
    }
    this.sendAck();
  }

  private sendAck(): void {
    this.channel?.send(frame("link.ack", { n: this.received }));
  }

  private fromChannel(channel: LinkChannel, text: string): void {
    if (this.channel !== channel) return;
    const c = control(text);
    if (!c) return;
    if (c.method === "link.ack") {
      this.lastAck = this.now();
      const n = c.params["n"];
      if (typeof n === "number") this.peerTook(n);
      if (!this.acked) {
        this.acked = true;
        // proven both ways: this side's last relay frame, then the channel
        if (this.out === "relay") {
          this.deps.relay(frame("link.switch", {}));
          this.out = "direct";
          this.log.info("node link on the direct channel");
          this.deps.onMode?.("direct");
        }
      }
      return;
    }
    if (c.method === "link.replay" && typeof c.params["n"] === "number" && typeof c.params["f"] === "string") {
      if (this.inFromChannel) this.numbered(c.params["n"], c.params["f"]);
      else this.early.push({ n: c.params["n"], f: c.params["f"] });
    }
  }

  /** One of the other side's numbered frames: taken once, in order. */
  private numbered(n: number, f: string): void {
    if (n <= this.received) return;
    this.received = n;
    this.deps.deliver(f);
  }

  /** The other side took this side's frames up to `n`. */
  private peerTook(n: number): void {
    let drop = 0;
    while (drop < this.unacked.length && this.unacked[drop]!.n <= n) {
      this.unackedBytes -= this.unacked[drop]!.f.length;
      drop++;
    }
    if (drop > 0) this.unacked.splice(0, drop);
  }

  // --- falling back -----------------------------------------------------------------------------

  /** The channel is gone for this side: say how far it got, and hold what it sends until the other side says how far it got. */
  lose(reason: string): void {
    const channel = this.channel;
    if (!channel) return;
    this.channel = undefined;
    this.acked = false;
    if (this.ticker !== undefined) this.timers().clearInterval(this.ticker);
    this.ticker = undefined;
    try {
      channel.close(1000, reason);
    } catch {
      // gone already
    }
    this.inFromChannel = false;
    this.early = [];
    this.log.info("node link back on the relay", { reason, unacked: this.unacked.length });
    this.deps.relay(frame("link.fallback", { received: this.received }));
    if (this.out === "direct") this.out = "held";
    this.deps.onMode?.("relay");
  }

  private peerFellBack(took: number): void {
    // the other side lost the channel first: this side falls back too, and says how far it got
    if (this.channel) this.lose("the other side fell back");
    for (const u of this.unacked) if (u.n > took) this.deps.relay(frame("link.replay", { n: u.n, f: u.f }));
    this.unacked = [];
    this.unackedBytes = 0;
    if (this.out !== "relay") {
      this.out = "relay";
      for (const t of this.held.splice(0)) this.deps.relay(t);
    }
  }

  /** The link ended: the channel with it. */
  shut(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ticker !== undefined) this.timers().clearInterval(this.ticker);
    this.ticker = undefined;
    const channel = this.channel;
    this.channel = undefined;
    channel?.close(1000, "the link ended");
  }
}
