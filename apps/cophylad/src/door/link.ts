// The sign-in door's link to the primary, as the machine it opens for: the node's own grant
// and key from the kit, sealed and joined as the node itself, with `door: true`. It is the
// hands subset of `Nodes` and less: a registry seeded with the kit's primary and backups, a
// seek over the LAN endpoints the node knew and the relay, and a link that carries nothing up
// but the desktop's state and its streams. It brings no lists, stands by for nothing, takes no
// takeover, serves no table; a primary older than the door, which would take it for the whole
// node, is never joined. The streams it serves are let in by who the primary says the viewer
// is (`doorAllows`): the user's own phones and browsers, and the machines that paired a viewer
// with this desktop, with no one asked. A new key for the grant is kept for the daemon's next
// attach; the grant's end is too, and the kit is dropped.

import { PROTOCOL_VERSION, RpcError } from "@cophyla/protocol";
import type { IceServer, Node, TicketViewer } from "@cophyla/protocol";
import { pskFromHex } from "@cophyla/relay";
import type { Bus } from "../bus.ts";
import type { Gate } from "../gate/index.ts";
import type { Logger } from "../log.ts";
import type { Direct } from "../direct/index.ts";
import type { Remote } from "../remote/index.ts";
import { PipeHub } from "../remote/pipes.ts";
import type { Store } from "../store/index.ts";
import { Outbound } from "../nodes/outbound.ts";
import type { LinkTarget } from "../nodes/outbound.ts";
import { Registry } from "../nodes/registry.ts";
import { linkCandidates, Seeker } from "../nodes/seek.ts";
import { openRelayLink } from "../nodes/sealed-link.ts";
import { PIPE_OPEN_TIMEOUT_MS, StreamLinks } from "../nodes/streams.ts";
import type { ConsoleState } from "./constants.ts";
import type { Kit } from "./kit.ts";

/** Whether a viewer the primary vouches for may reach this desktop at its sign-in screen, and why. */
export function doorAllows(by: TicketViewer | undefined, machines: readonly string[]): { decision: "allow" | "deny"; why: string } {
  if (!by) return { decision: "deny", why: "the primary did not say who is asking: no one is let in at the sign-in screen unknown" };
  if (by.kind === "phone") {
    if (by.session) return { decision: "deny", why: "a shared computer's session opens no sign-in door" };
    return { decision: "allow", why: by.browser ? "one of the user's own browsers" : "one of the user's own phones" };
  }
  if (machines.includes(by.node)) return { decision: "allow", why: "a machine of the user's that views this desktop" };
  return { decision: "deny", why: "that machine has not viewed this desktop before: pair it while someone is signed in here" };
}

export interface DoorLinkDeps {
  kit: Kit;
  /** The grant's key now: the kit's, or one the primary handed since. */
  key: () => string;
  store: Store;
  bus: Bus;
  gate: Gate;
  remote: Remote;
  direct: Direct;
  platformVersion: string;
  console: () => ConsoleState;
  log: Logger;
  /** The primary handed the grant a new key. */
  onRekey: (key: string) => void;
  /** The primary ended the grant. */
  onRevoked: () => void;
  /** Linked, or not. */
  onLink: (linked: boolean) => void;
  /** The primary refused the door's protocol: it speaks `theirs`. */
  onProtocol?: (theirs: number) => void;
  now?: () => number;
}

/** The primary's protocol, from its refusal of ours (`protocol <ours> is not <theirs>`). */
export function refusedProtocol(e: unknown): number | undefined {
  if (!(e instanceof RpcError) || e.code !== "unsupported") return undefined;
  const m = /^protocol (\d+) is not (\d+)$/.exec(e.message);
  return m ? Number(m[2]) : undefined;
}

export class DoorLink {
  private deps: DoorLinkDeps;
  private log: Logger;
  readonly registry: Registry;
  readonly outbound: Outbound;
  readonly pipes: PipeHub;
  readonly streams: StreamLinks;
  private seeker: Seeker;
  private stopped = false;
  private preferred?: string;

  constructor(deps: DoorLinkDeps) {
    this.deps = deps;
    this.log = deps.log;
    const kit = deps.kit;
    const self = kit.node.id;
    this.registry = new Registry({ store: deps.store, bus: deps.bus, self: () => this.row(), selfEndpoints: () => [], selfRank: () => undefined, ...(deps.now ? { now: deps.now } : {}) });
    this.registry.take(kit.registry);
    this.pipes = new PipeHub({
      selfId: () => self,
      loopbackPort: () => deps.remote.loopback.port(),
      // a door has no clients of its own: every pipe comes over the link
      clientWire: () => ({ data: () => false, ack: () => undefined, close: () => undefined }),
      linkWire: (node) => {
        if (!this.outbound.linked() || this.outbound.primaryId !== node) return undefined;
        const send = (m: string, p: unknown) => this.outbound.notifyPrimary(m, p);
        return {
          data: (pipe, data) => send("pipe.data", { pipe, data }),
          ack: (pipe, bytes) => void send("pipe.ack", { pipe, bytes }),
          close: (pipe, reason) => void send("pipe.close", { pipe, reason: reason.slice(0, 200) }),
        };
      },
      nextHop: (node) => (node === self ? undefined : this.outbound.linked() ? this.outbound.primaryId : undefined),
      openOnLink: async (_hop, params) => (await this.outbound.requestPrimary("remote.pipe.open", params, { timeoutMs: PIPE_OPEN_TIMEOUT_MS })) as { window: number },
      log: this.log.child("pipes"),
    });
    this.streams = new StreamLinks({
      selfId: () => self,
      gate: deps.gate,
      remote: () => deps.remote,
      pipes: () => this.pipes,
      carry: (node) => Promise.reject(new RpcError("unavailable", `no route to ${node} from a sign-in door`)),
      decide: (t) => doorAllows(t.by, kit.machines),
      log: this.log.child("streams"),
    });
    this.outbound = new Outbound({
      membership: () => ({ grant: kit.link.grant, key: deps.key(), cluster: kit.link.cluster }),
      hands: () => false,
      // nothing is asked of this machine's owner from elsewhere: no one is there
      answerHere: () => true,
      asDoor: () => true,
      onRekey: (key) => deps.onRekey(key),
      platformVersion: deps.platformVersion,
      self: () => this.row(),
      selfEndpoints: () => [],
      backup: () => false,
      rank: () => 1,
      epoch: () => kit.epoch,
      sessions: () => [],
      workspaces: () => [],
      asks: () => [],
      registry: this.registry,
      bus: deps.bus,
      events: { on: () => () => undefined },
      gate: deps.gate,
      served: () => ({}),
      remote: deps.remote,
      direct: deps.direct,
      directNodes: () => kit.direct.config.nodes,
      streams: this.streams,
      heartbeatMs: kit.nodes.heartbeat_ms,
      helloTimeoutMs: kit.nodes.hello_timeout_ms,
      log: this.log.child("outbound"),
      onLinked: (info) => {
        this.log.info("the sign-in door linked to the primary", { primary: info.primary, via: info.via });
        deps.onLink(true);
        this.announce();
      },
      onLost: (reason) => {
        deps.onLink(false);
        if (this.stopped) return;
        this.log.warn("the sign-in door lost the primary; seeking it again", { reason });
        this.seeker.kick();
      },
      onTakeover: () => Promise.reject(new RpcError("denied", "a sign-in door never takes the primary role")),
      onLeave: (reason, primary) => {
        if (reason === "revoked") {
          this.log.warn("the primary ended this machine's grant while its sign-in door held the link");
          deps.onRevoked();
          return;
        }
        if (primary) this.preferred = this.registry.endpointsOf(primary)[0];
      },
      ...(deps.now ? { now: deps.now } : {}),
    });
    this.seeker = new Seeker({
      candidates: () => this.candidates(),
      connect: (target) =>
        this.outbound.connect(target).catch((e: unknown) => {
          const theirs = refusedProtocol(e);
          if (theirs !== undefined) deps.onProtocol?.(theirs);
          throw e;
        }),
      active: () => !this.stopped && !this.outbound.linked(),
      reconnectMs: kit.nodes.reconnect_ms,
      reconnectMaxMs: kit.nodes.reconnect_max_ms,
      linked: () => {
        this.preferred = undefined;
      },
      log: this.log.child("seek"),
    });
  }

  /** The machine's row while its door holds it: its desktop alone, and where the console is. */
  row(): Node {
    const kit = this.deps.kit;
    return {
      id: kit.node.id,
      name: kit.node.name,
      role: "secondary",
      status: "online",
      via: this.outbound?.info?.via ?? "direct",
      platform: "windows",
      scope: { kind: "machine" },
      capabilities: { harnesses: [], voice: { wake: false, stt: false, tts: false }, remote: this.deps.remote.capable(), brain: false },
      versions: { platform: this.deps.platformVersion, protocol: PROTOCOL_VERSION },
      lastSeen: (this.deps.now ?? Date.now)(),
      door: this.deps.console() === "locked" ? "locked" : "signin",
    };
  }

  /** The row changed (the console, or the desktop came up): the primary hears it. */
  announce(): void {
    this.deps.bus.emit("node.state", this.row());
  }

  /** Every way to the primary: where the node enrolled, its last primary, the registry's primary and backups, then the relay. */
  private candidates(): LinkTarget[] {
    const kit = this.deps.kit;
    const m = kit.link;
    const relay = m.relay;
    const target: LinkTarget | undefined =
      relay && kit.nodes.relay
        ? { kind: "relay", open: () => openRelayLink({ url: relay.url, token: relay.token, peer: m.grant, psk: pskFromHex(this.deps.key()), kind: "node", timeoutMs: kit.nodes.hello_timeout_ms }) }
        : undefined;
    return linkCandidates({
      ...(this.preferred !== undefined ? { preferred: this.preferred } : {}),
      ...(kit.nodes.primary !== undefined ? { configured: kit.nodes.primary } : {}),
      membership: m.endpoints ?? [],
      registryPrimary: [...(kit.lastPrimary?.endpoints ?? []), ...(this.registry.primary()?.endpoints ?? [])],
      registryBackups: this.registry.backups().map((b) => b.endpoints),
      ...(target ? { relay: target, relayFirst: m.endpoints === undefined } : {}),
    });
  }

  linked(): boolean {
    return this.outbound.linked();
  }

  /** TURN credentials from the primary's account, for the desktop's streams. */
  turn(): Promise<{ iceServers: IceServer[]; expiresAt: number }> {
    return this.outbound.turn();
  }

  start(): void {
    this.seeker.kick();
  }

  /** Leaves the link (the node's daemon takes it next) and stops seeking; the link's pipes and streams go with it. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.seeker.abandon();
    this.outbound.leave("stopping");
  }
}
