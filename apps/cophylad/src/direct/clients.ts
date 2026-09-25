// Phones on data channels. A paired phone on the relay offers one (`direct.offer`): its SDP
// and a fresh key; the helper answers the SDP, this node answers with a fresh key of its own,
// and the records are keyed from the two and that phone's pairing secret, bound to the
// phone. The candidates cross as `direct.candidate` both ways, and when the helper says the
// channel is open it is served by the api like any socket, under the `p2p` listener kind,
// where only that phone's token may say hello. A channel that does not open within its time
// is closed and counted as failed; one that opens is counted by its path once the helper
// names it, and shows in `direct.state` until it ends.

import { randomBytes } from "node:crypto";
import { RpcError } from "@cophyla/protocol";
import type { Client, ClientNotificationName, ClientNotificationParams, DirectPathType } from "@cophyla/protocol";
import { derive, ephemeral, pskFromHex, TunnelError } from "@cophyla/relay";
import type { RelayCurve } from "@cophyla/relay";
import type { NodeSocketHandler, TunnelOptions } from "../api/server.ts";
import type { ListenerKind } from "../api/clients.ts";
import type { Logger } from "../log.ts";
import type { Direct } from "./index.ts";
import { ChannelSocket } from "./peers.ts";

/** How long a channel has from the offer to `open`. */
export const OPEN_TIMEOUT_MS = 20_000;
/** Offers in flight per phone: a new one past this ends the oldest. */
const PENDING_PER_CONTROLLER = 2;

export interface DirectClientsDeps {
  direct: Direct;
  log: Logger;
  /** A controller's pairing secret, as hex. */
  controllerKey: (controller: string) => string | undefined;
  /** Serves an open channel as a socket of the `p2p` kind: the api's acceptor, once it is up. */
  accept: () => ((sock: ChannelSocket, opts: TunnelOptions) => NodeSocketHandler) | undefined;
  /** A notification to one client, whatever its scope and wherever its socket: the signalling's. */
  sendTo: <N extends ClientNotificationName>(client: string, method: N, params: ClientNotificationParams<N>) => boolean;
  now?: () => number;
  openTimeoutMs?: number;
}

interface Channel {
  peer: string;
  /** The client that signalled it: the phone's relay connection. */
  client: string;
  controller: string;
  socket: ChannelSocket;
  handler?: NodeSocketHandler;
  open: boolean;
  timer?: ReturnType<typeof setTimeout>;
  since: number;
  path?: DirectPathType;
}

export interface OfferParams {
  sdp: string;
  epk: string;
  curve?: RelayCurve;
}

export class DirectClients {
  private deps: DirectClientsDeps;
  private log: Logger;
  private channels = new Map<string, Channel>();
  private off: () => void;

  constructor(deps: DirectClientsDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.off = deps.direct.onPeer((method, params) => this.onPeer(method, params));
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** `direct.info`: the servers a phone gathers with, TURN among them. */
  async info(client: Client, listener: ListenerKind): Promise<{ iceServers: unknown[]; expiresAt: number }> {
    this.phoneOnRelay(client, listener);
    return this.deps.direct.iceServers();
  }

  /** `direct.offer`: a phone on the relay offers a channel; the answer, the channel's name and this node's key. */
  async offer(client: Client, listener: ListenerKind, params: OfferParams): Promise<{ peer: string; sdp: string; epk: string }> {
    const controller = this.phoneOnRelay(client, listener);
    const key = this.deps.controllerKey(controller);
    if (!key) throw new RpcError("denied", "this phone has no pairing secret here: pair it again");
    if (!this.deps.direct.ready) throw new RpcError("unavailable", "direct connections are not running on this node");
    // a phone that keeps offering without opening has its oldest offers ended
    const pending = [...this.channels.values()].filter((c) => c.controller === controller && !c.open);
    for (const c of pending.slice(0, Math.max(0, pending.length - PENDING_PER_CONTROLLER + 1))) this.end(c, "a newer offer");
    const mine = await ephemeral(params.curve ?? "x25519");
    let tunnel;
    try {
      tunnel = await derive("responder", mine, params.epk, pskFromHex(key), { kind: "direct", peer: controller });
    } catch (e) {
      throw new RpcError("invalid", e instanceof TunnelError ? e.message : "the offer's key is not usable");
    }
    const peer = `c_${randomBytes(8).toString("hex")}`;
    const socket = new ChannelSocket({
      peer,
      tunnel,
      send: (data) => this.deps.direct.notify("peer.send", { peer, data }),
      close: () => void this.deps.direct.request("peer.close", { peer }).catch(() => undefined),
      log: this.log,
      remote: `direct:${peer}`,
    });
    const channel: Channel = { peer, client: client.id, controller, socket, open: false, since: this.now() };
    // named before the helper hears of it: its candidates can come before its answer does
    this.channels.set(peer, channel);
    channel.timer = setTimeout(() => this.end(channel, "no path opened in time"), this.deps.openTimeoutMs ?? OPEN_TIMEOUT_MS);
    try {
      const answer = (await this.deps.direct.request("peer.answer", { peer, sdp: params.sdp })) as { sdp: string };
      this.log.info("data channel offered", { peer, controller });
      return { peer, sdp: answer.sdp, epk: mine.publicKey };
    } catch (e) {
      this.end(channel, "the helper refused the offer");
      if (e instanceof RpcError) throw e;
      throw new RpcError("unavailable", e instanceof Error ? e.message : String(e));
    }
  }

  /** A candidate from the phone for its channel; another client's channel is not its to add to. */
  candidate(client: Client, params: { peer: string; candidate: unknown }): void {
    const channel = this.channels.get(params.peer);
    if (!channel || channel.client !== client.id || channel.open) return;
    void this.deps.direct.request("peer.candidate", { peer: params.peer, candidate: params.candidate }).catch((e: unknown) => this.log.debug("candidate not taken", { peer: params.peer, error: e instanceof Error ? e.message : String(e) }));
  }

  /** The signalling client went: the channels it had not opened yet go with it. */
  clientGone(client: string): void {
    for (const c of [...this.channels.values()]) if (c.client === client && !c.open) this.end(c, "the phone went");
  }

  /** Direct connections stopped here: every channel ends. */
  closeAll(reason: string): void {
    for (const c of [...this.channels.values()]) this.end(c, reason);
  }

  stop(): void {
    this.off();
    this.closeAll("daemon stopping");
  }

  private phoneOnRelay(client: Client, listener: ListenerKind): string {
    if (client.kind !== "controller" || client.controller === undefined) throw new RpcError("unsupported", "a data channel is a paired phone's");
    if (listener !== "cloud") throw new RpcError("unsupported", "a data channel is offered over the relay");
    return client.controller;
  }

  private onPeer(method: string, params: unknown): void {
    // the helper went: every channel it held went with it
    if (method === "helper.down") {
      for (const c of [...this.channels.values()]) {
        if (c.handler) c.socket.ended("the direct helper stopped");
        else this.end(c, "the direct helper stopped");
      }
      return;
    }
    const p = (params ?? {}) as { peer?: unknown };
    if (typeof p.peer !== "string") return;
    const channel = this.channels.get(p.peer);
    if (!channel) return;
    switch (method) {
      case "peer.candidate": {
        const candidate = (params as { candidate?: unknown }).candidate ?? null;
        if (!channel.open) this.deps.sendTo(channel.client, "direct.candidate", { peer: channel.peer, candidate: candidate as never });
        return;
      }
      case "peer.open":
        this.opened(channel);
        return;
      case "peer.data": {
        const data = (params as { data?: unknown }).data;
        if (typeof data === "string") channel.socket.receive(data);
        return;
      }
      case "peer.buffered": {
        const n = (params as { buffered?: unknown }).buffered;
        if (typeof n === "number") channel.socket.setBuffered(n);
        return;
      }
      case "peer.path": {
        const path = (params as { type?: unknown; rttMs?: unknown }) as { type?: DirectPathType; rttMs?: number };
        if (!path.type) return;
        const first = channel.path === undefined;
        channel.path = path.type;
        if (first) this.deps.direct.report.count("client", path.type);
        channel.handler?.setPath?.(path.type === "relay" ? "turn" : "direct");
        this.deps.direct.setPeer(channel.peer, { kind: "controller", id: channel.controller, path: path.type, since: channel.since, ...(typeof path.rttMs === "number" ? { rttMs: path.rttMs } : {}) });
        return;
      }
      case "peer.state": {
        const state = (params as { state?: unknown }).state;
        if (state !== "failed" && state !== "closed") return;
        if (channel.handler) channel.socket.ended(`the channel ${state}`);
        else this.end(channel, `the channel ${state}`);
        return;
      }
    }
  }

  private opened(channel: Channel): void {
    if (channel.open) return;
    const accept = this.deps.accept();
    if (!accept) {
      this.end(channel, "the api is not up");
      return;
    }
    channel.open = true;
    if (channel.timer) clearTimeout(channel.timer);
    channel.timer = undefined;
    const handler = accept(channel.socket, { listener: "p2p", controller: channel.controller, ...(channel.path ? { path: channel.path === "relay" ? "turn" : "direct" } : {}) });
    channel.handler = handler;
    channel.socket.attach(
      (text) => handler.message(text),
      (code, reason) => {
        handler.close(code, reason);
        this.forget(channel, reason);
      },
    );
    this.log.info("data channel open", { peer: channel.peer, controller: channel.controller });
  }

  /** Ends a channel: the helper told, the socket closed, and one that never opened counted as failed. */
  private end(channel: Channel, reason: string): void {
    if (!this.channels.has(channel.peer)) return;
    if (!channel.open) this.deps.direct.report.count("client", "failed");
    if (channel.handler) {
      // the socket's end closes the api's side and forgets the channel
      channel.socket.close(1000, reason);
      return;
    }
    void this.deps.direct.request("peer.close", { peer: channel.peer }).catch(() => undefined);
    this.forget(channel, reason);
  }

  private forget(channel: Channel, reason: string): void {
    if (!this.channels.delete(channel.peer)) return;
    if (channel.timer) clearTimeout(channel.timer);
    this.deps.direct.dropPeer(channel.peer);
    this.log.info("data channel closed", { peer: channel.peer, reason });
  }
}
