// The primary's side of every node link. A socket on `/ws/node` starts with the sealed
// hello in the clear: the grant the other node holds, which says what key the link is keyed
// from; a grant that is unknown, pending, ended or not a node's is refused there and then,
// before anything is sealed. Through the relay the tunnel arrives sealed already
// (`acceptSealed`). An invite's link (`enroll`) answers `node.enroll` and nothing else. A
// grant's link answers `node.hello` for the node the grant is bound to alone, in this
// cluster alone, then `node.join` (the gate's `hello` row under principal `node`); a joined
// secondary gets the registry and a link id, its lists go into the mirror, and from then on
// its upward stream is routed: client notifications to the mirror and the bus, capability
// events into the event stream, `pending` to the forward it belongs to, relayed frames to
// the relay host, `metrics.sample` to the clients watching that node, `remote.state` to the
// bus like the rest, `terminal.output` to the one client that opened that terminal there
// (terminals.ts). Requests go the other way as `forward` and `fanout`, and one comes up:
// `remote.pair`, a secondary's viewer asking a desktop's owner to accept its PIN; a backup
// gets the replication stream. A link that closes
// marks the node offline, ends its mirrored sessions and terminals and cancels its mirrored
// asks for every client, and raises `node.left`.
//
// Every upward row must be the sender's own: a row that names another node, or claims a
// session, ask or workspace this primary holds itself, is dropped with a line in the log, and
// so is a session event of a session the sender does not own. A node's own row may change
// what it says of itself (a voice stage, the desktop host) but never its role, backup rank,
// epoch, endpoints or way in: those came with the join.
//
// A node whose grant is hands is driven and drives nothing: its clients are not relayed here,
// it is never a backup and its epoch says nothing, it raises no `event.custom` and pairs no
// viewer, and the registry it is sent names only the primary and the backups. A grant that
// ends closes its node's link with a sealed `node.leave {reason: revoked}` first, so the node
// forgets the cluster on the primary's word and no one else's.

import { capabilityEvents, failure, newId, nodeLinkFrames, nodeLinkRequests, nodeLinkUpward, NODE_LINK_REFUSED, NODE_LINK_REVOKED, PROTOCOL_VERSION, protocolError, RpcError } from "@cophyla/protocol";
import type { Ask, CapabilityEventParams, IceServer, MetricsSample, NodeRecord, RpcId, Session, SpendTotals, Terminal } from "@cophyla/protocol";
import { parseSealedHello, sealedRefusal, sealedRespond, SealedSocket } from "@cophyla/relay";
import type { Psk, SealedKind } from "@cophyla/relay";
import type { z } from "zod";
import type { GrantRow } from "../grants/store.ts";
import type { ClientRegistry } from "../api/clients.ts";
import type { NodeSocket, NodeSocketHandler, RelayHost } from "../api/server.ts";
import type { Bus } from "../bus.ts";
import type { EventStream, StreamEvent } from "../events/stream.ts";
import type { Gate } from "../gate/index.ts";
import type { Policy } from "../gate/policy.ts";
import type { Logger } from "../log.ts";
import { SampleFeed, slackFor } from "../metrics/delivery.ts";
import type { ProcessDetail } from "../metrics/delivery.ts";
import { RpcPeer } from "../rpc/peer.ts";
import { plainRow } from "../sessions/tether/title.ts";
import type { Mirror } from "./mirror.ts";
import { NodePeer } from "./peer.ts";
import type { Registry } from "./registry.ts";
import type { Replicator } from "./replication.ts";
import { pairAsk } from "../api/methods.ts";
import type { DirectPathType } from "@cophyla/protocol";
import type { Direct } from "../direct/index.ts";
import { LinkDirect } from "./direct.ts";
import { SwitchableLink } from "./switch.ts";
import { PIPE_FRAMES, STREAM_LINK_REQUESTS } from "./streams.ts";
import type { StreamLinks } from "./streams.ts";
import { TerminalViews } from "./terminals.ts";

type NodeLinkResult<N extends keyof typeof nodeLinkRequests> = z.infer<(typeof nodeLinkRequests)[N]["result"]>;

/** What an old node, from before grants, gets for its first frame: its token opens nothing now. */
export const BEFORE_GRANTS = "from before grants: re-invite it";

/** What a link was sealed with: the grant, and whether it is an invite being redeemed. */
export interface LinkCredential {
  grant: GrantRow;
  kind: SealedKind;
  psk: Psk;
}

/** What `node.enroll` answers, without the envelope. */
export type EnrollResult = NodeLinkResult<"node.enroll">;

export interface InboundDeps {
  /** The key a link naming `grant` is keyed from, when the grant may link now; undefined otherwise. */
  credential: (grant: string, kind: SealedKind) => LinkCredential | undefined;
  /** This cluster's id. */
  cluster: () => string | undefined;
  /** Redeems an invite on its sealed link: the grant bound to the node, its key and how to reach the primary. */
  enroll?: (grant: GrantRow, node: { id: string; name: string }, account?: string) => Promise<EnrollResult>;
  /** A full node took the replica: its grant is marked, so removing it re-keys the others. */
  onBackupAttached?: (grant: string) => void;
  /** An invite's link closed, redeemed or not: what it came through may be let go. */
  onEnrollClosed?: (grant: GrantRow) => void;
  selfId: () => string;
  role: () => "primary" | "secondary";
  epoch: () => number;
  /** Where the primary is when this node is not it, for a joiner that came to the wrong node. */
  primaryEndpoint: () => string | undefined;
  tz: string;
  registry: Registry;
  mirror: Mirror;
  bus: Bus;
  events: EventStream;
  gate: Gate;
  policy: Policy;
  clients: ClientRegistry;
  /** A metrics watcher that is not a client (the brain's metric listeners, `listener:<id>`): its samples go here; undefined for a client's. */
  samples?: (client: string, sample: MetricsSample) => boolean | undefined;
  relayHost: () => RelayHost | undefined;
  replicator: Replicator;
  heartbeatMs: number;
  helloTimeoutMs: number;
  log: Logger;
  /** A primary of a higher epoch, or a takeover, announced itself through a join: the role machine decides. */
  onHigherEpoch: (epoch: number, nodeId: string) => void;
  /** A secondary's viewer pairing with `node`'s desktop: the PIN goes to that node's host, or this node's own. */
  pairOn?: (node: string, p: { pin: string; name: string }, opts: { signal?: AbortSignal; onPending?: (ask: Ask) => void }) => Promise<void>;
  /** Whether this node holds the session, ask or workspace itself: no linked node may claim one. */
  isLocal?: (kind: "session" | "ask" | "workspace", id: string) => boolean;
  /** A node left the cluster for good, over its own link: its grant goes. */
  onLeft?: (node: string, grant: string) => void;
  /** The direct connections: a relayed link's data channel is answered through them. */
  direct?: () => Direct | undefined;
  /** `[direct] nodes`. */
  directNodes?: () => boolean;
  /** Streams for viewers with no route to the desktop: tickets, their ends and pipes, served here or carried on. */
  streams?: StreamLinks;
  /** TURN credentials minted on this node's account, for a linked node's direct connections. */
  turn?: () => Promise<{ iceServers: IceServer[]; expiresAt: number }>;
  now?: () => number;
}

/** Samples kept per linked node for a watcher that joins between two of them. */
const RECENT_SAMPLES = 8;

/** What an upward row claims: the node it is about, and the session, ask or workspace it names. */
export interface UpwardClaim {
  node: string | undefined;
  session?: string;
  ask?: string;
  workspace?: string;
}

type UpwardNotification = "session.state" | "session.event" | "ask.state" | "workspace.state" | "terminal.state" | "audit.entry" | "node.state" | "update.state" | "metrics.sample" | "remote.state" | "direct.state";
type UpwardEvent = "session.discovered" | "session.updated" | "session.ask" | "session.ended" | "workspace.updated" | "event.custom" | "node.pressure";

/** Who owns what an upward row names: the mirror for a row that names only a session or a workspace. */
interface OwnerLookup {
  sender: string;
  mirror: Pick<Mirror, "ownerOfSession" | "ownerOfWorkspace">;
}

/**
 * The client notifications a secondary may send up, each with what it claims. Every one must
 * name the sender; a table, so a new upward row cannot skip the check.
 */
export const UPWARD_NOTIFICATIONS: { [N in UpwardNotification]: (v: z.infer<(typeof nodeLinkUpward)[N]>, o: OwnerLookup) => UpwardClaim } = {
  "session.state": (v) => ({ node: v.node, session: v.id }),
  "session.event": (v, o) => ({ node: o.mirror.ownerOfSession(v.session), session: v.session }),
  "ask.state": (v) => ({ node: v.node, ask: v.id }),
  "workspace.state": (v) => ({ node: v.node, workspace: v.id }),
  "terminal.state": (v) => ({ node: v.node }),
  "audit.entry": (v) => ({ node: v.node }),
  "node.state": (v) => ({ node: v.id }),
  "update.state": (v) => ({ node: v.node }),
  "metrics.sample": (v) => ({ node: v.node }),
  "remote.state": (v) => ({ node: v.node }),
  "direct.state": (v) => ({ node: v.node }),
};

/** The capability events a secondary may raise into this node's stream, each with what it claims. */
export const UPWARD_EVENTS: { [N in UpwardEvent]: (v: CapabilityEventParams<N>, o: OwnerLookup) => UpwardClaim } = {
  "session.discovered": (v) => ({ node: v.session.node, session: v.session.id }),
  "session.updated": (v) => ({ node: v.session.node, session: v.session.id }),
  "session.ask": (v, o) => ({ node: v.ask.node === o.mirror.ownerOfSession(v.session) ? v.ask.node : undefined, session: v.session, ask: v.ask.id }),
  "session.ended": (v) => ({ node: v.session.node, session: v.session.id }),
  "workspace.updated": (v, o) => ({ node: o.mirror.ownerOfWorkspace(v.id), workspace: v.id }),
  "event.custom": (_v, o) => ({ node: o.sender }),
  "node.pressure": (v) => ({ node: v.node }),
};

/** Why an upward row is not the sender's to send, or undefined when it is. */
export function refuseClaim(claim: UpwardClaim, sender: string, isLocal?: InboundDeps["isLocal"]): string | undefined {
  if (claim.node !== sender) return claim.node === undefined ? "names nothing the sender owns" : `names node ${claim.node}`;
  if (isLocal) {
    if (claim.session !== undefined && isLocal("session", claim.session)) return `claims session ${claim.session} of this node`;
    if (claim.ask !== undefined && isLocal("ask", claim.ask)) return `claims ask ${claim.ask} of this node`;
    if (claim.workspace !== undefined && isLocal("workspace", claim.workspace)) return `claims workspace ${claim.workspace} of this node`;
  }
  return undefined;
}

const FANOUT_TIMEOUT_MS = 3000;

/** What a link's handshake has settled so far: what it was sealed with, and whether `node.hello` passed. */
interface Handshake {
  cred: LinkCredential;
  hello: boolean;
}

/** Why a hello was refused, as the refusal and the close say it: no more than that. */
const GRANT_REFUSED = "that grant cannot link here";

/** A first frame from before grants: a JSON-RPC `node.hello`, whose id the refusal answers. */
function oldHello(text: string): { id: RpcId; node?: string } | undefined {
  let m: { method?: unknown; id?: unknown; params?: { nodeId?: unknown } };
  try {
    m = JSON.parse(text) as typeof m;
  } catch {
    return undefined;
  }
  if (m?.method !== "node.hello" || (typeof m.id !== "string" && typeof m.id !== "number")) return undefined;
  return { id: m.id, ...(typeof m.params?.nodeId === "string" ? { node: m.params.nodeId } : {}) };
}

interface Pending {
  onPending?: (ask: Ask) => void;
}

export class Inbound {
  private deps: InboundDeps;
  private log: Logger;
  private peers = new Map<string, NodePeer>();
  /** The address each node last linked from: how to reach a node with no LAN listener of its own. */
  private addresses = new Map<string, string>();
  /** Each relayed link's data channel, by node. */
  private linkDirects = new Map<string, LinkDirect>();
  /** Forwarded requests in flight, by peer and request id, for `pending` notices. */
  private forwards = new Map<string, Pending>();
  /** Relayed clients by `<node>:<peer>` and back. */
  private relayed = new Map<string, string>();
  private relayedBack = new Map<string, { node: string; peer: string }>();
  /** Clients watching other nodes' metrics: client → node → its feed. A view watches every node at once. */
  private metricsWatchers = new Map<string, Map<string, SampleFeed>>();
  /** The last few samples each linked node sent, for a watcher that joins between them. */
  private recentSamples = new Map<string, MetricsSample[]>();
  /** Watchers waiting for a node's answer to their spend, by `<client> <node>`: the link is subscribed for them too meanwhile. */
  private joining = new Map<string, { node: string; intervalMs: number; processes: ProcessDetail }>();
  private accepting = false;
  /** The terminals of linked nodes the clients have open. */
  readonly terminals: TerminalViews;

  constructor(deps: InboundDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.terminals = new TerminalViews({
      clients: deps.clients,
      forward: (node, method, params, opts) => this.forward(node, method, params, opts),
      notify: (node, method, params) => this.peers.get(node)?.notify(method, params) ?? false,
      log: this.log.child("terminals"),
    });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Whether `/ws/node` takes links now. */
  isAccepting(): boolean {
    return this.accepting;
  }

  setAccepting(on: boolean): void {
    this.accepting = on;
  }

  peer(id: string): NodePeer | undefined {
    return this.peers.get(id);
  }

  linked(id: string): boolean {
    return this.peers.get(id)?.open ?? false;
  }

  linkedIds(): string[] {
    return [...this.peers.keys()];
  }

  /** The address a node last linked from, without a port. */
  addressOf(id: string): string | undefined {
    return this.addresses.get(id);
  }

  // --- a socket arrives ------------------------------------------------------------------------

  /**
   * A LAN socket on `/ws/node`. Its first frame is the sealed hello in the clear, naming the
   * grant: one that may link now is answered and the socket sealed from there on, anything
   * else refused before a byte is sealed. A node from before grants, whose first frame is a
   * JSON-RPC `node.hello`, is told to be invited again.
   */
  acceptSocket(sock: NodeSocket): NodeSocketHandler {
    let sealed: SealedSocket | undefined;
    let inner: NodeSocketHandler | undefined;
    let first = true;
    let gone = false;
    const timer = setTimeout(() => {
      if (!sealed) sock.close(NODE_LINK_REFUSED, "no hello");
    }, this.deps.helloTimeoutMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    const open = async (text: string): Promise<void> => {
      const hello = parseSealedHello(text);
      if (!hello) {
        const old = oldHello(text);
        if (old) {
          this.log.warn("node link refused: a node from before grants", { remote: sock.remote, node: old.node });
          sock.send(JSON.stringify(failure(old.id, protocolError("denied", BEFORE_GRANTS))));
          sock.close(NODE_LINK_REFUSED, BEFORE_GRANTS);
        } else sock.close(NODE_LINK_REFUSED, "not a sealed hello");
        return;
      }
      const cred = this.deps.credential(hello.grant, hello.kind);
      if (!cred) {
        this.log.warn("node link refused: no grant that may link", { remote: sock.remote, grant: hello.grant, kind: hello.kind });
        sock.send(sealedRefusal(GRANT_REFUSED));
        sock.close(NODE_LINK_REFUSED, GRANT_REFUSED);
        return;
      }
      const { answer, tunnel } = await sealedRespond(hello, cred.psk);
      if (gone) return;
      clearTimeout(timer);
      const s = new SealedSocket(
        tunnel,
        { send: (frame) => sock.send(frame), close: (code, reason) => sock.close(code, reason) },
        { onText: (t) => inner?.message(t), onClose: (code, reason) => inner?.close(code, reason) },
      );
      sealed = s;
      inner = this.acceptSealed(cred, { send: (t) => void s.send(t), close: (code, reason) => s.close(code, reason), remote: sock.remote });
      sock.send(answer);
    };
    return {
      message: (text) => {
        if (sealed) sealed.receive(text);
        else if (first) {
          // Nothing but the hello comes before the answer: the initiator waits for it.
          first = false;
          void open(text).catch((e: unknown) => {
            this.log.warn("node link refused: the hello failed", { remote: sock.remote, error: e instanceof Error ? e.message : String(e) });
            sock.close(NODE_LINK_REFUSED, "bad hello");
          });
        }
      },
      close: (code, reason) => {
        gone = true;
        clearTimeout(timer);
        sealed?.transportClosed(code, reason);
      },
    };
  }

  /**
   * A link already sealed with `cred`: from `acceptSocket` on the LAN, or a relay tunnel the
   * server opened. What it may do first depends on how it was sealed: an invite's link
   * redeems it and closes, a grant's says hello and joins.
   */
  acceptSealed(cred: LinkCredential, sock: NodeSocket): NodeSocketHandler {
    const hs: Handshake = { cred, hello: false };
    let peer: NodePeer | undefined;
    // a grant's link through the relay has a switch under its RPC: its frames can move to a data channel
    const direct = cred.kind === "node" && sock.remote.startsWith("relay:") ? this.deps.direct?.() : undefined;
    let link: SwitchableLink | undefined;
    let linkDirect: LinkDirect | undefined;
    const rpc = new RpcPeer({
      write: (text) => {
        if (link) return link.send(text);
        sock.send(text);
        return true;
      },
      log: this.log,
      label: `link ${sock.remote}`,
      onRequest: (method, params, id) =>
        peer
          ? this.onRequest(peer, method, params, id)
          : this.onHandshake(sock, rpc, hs, method, params, (p) => {
              peer = p;
              if (link && direct) {
                linkDirect = new LinkDirect({
                  direct,
                  link,
                  request: (m, prm, opts) => p.request(m, prm, opts ?? {}),
                  notify: (m, prm) => p.notify(m, prm),
                  // the grant as it stands when the channel is keyed: a re-key since the join included
                  psk: () => this.deps.credential(cred.grant.id, "node")?.psk,
                  role: "primary",
                  secondary: p.id,
                  other: p.id,
                  enabled: () => this.deps.directNodes?.() ?? true,
                  log: this.log.child("direct"),
                  onPath: (at) => this.setP2p(p.id, at),
                  ...(this.deps.now ? { now: this.deps.now } : {}),
                });
                this.linkDirects.set(p.id, linkDirect);
              }
            }),
      onNotification: (method, params) => {
        if (peer) this.onNotification(peer, method, params);
      },
    });
    if (direct) {
      link = new SwitchableLink({
        relay: (text) => {
          sock.send(text);
          return true;
        },
        deliver: (text) => rpc.onText(text),
        close: (code, reason) => sock.close(code, reason),
        log: this.log.child("switch"),
        onMode: (mode) => linkDirect?.modeChanged(mode),
      });
    }
    const timer = setTimeout(() => {
      if (!peer) sock.close(NODE_LINK_REFUSED, "no join");
    }, this.deps.helloTimeoutMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    return {
      message: (text) => (link ? link.fromRelay(text) : rpc.onText(text)),
      close: (code, reason) => {
        clearTimeout(timer);
        link?.shut();
        if (peer) peer.closedBy(`link closed (${code} ${reason})`);
        else rpc.close("closed before join");
        if (cred.kind === "enroll") this.deps.onEnrollClosed?.(cred.grant);
      },
    };
  }

  /** A relayed link's data channel carries it now, or no longer: the node's row says so. */
  private setP2p(id: string, at: { path: DirectPathType; rttMs?: number; since: number } | undefined): void {
    const row = this.deps.registry.get(id);
    if (!row || row.status !== "online") return;
    if (at) this.deps.registry.upsert({ ...row, p2p: at });
    else if (row.p2p) {
      const { p2p: _gone, ...rest } = row;
      this.deps.registry.upsert(rest);
    } else return;
    this.broadcastRegistry();
  }

  private async onHandshake(sock: NodeSocket, rpc: RpcPeer, hs: Handshake, method: string, params: unknown, linked: (p: NodePeer) => void): Promise<unknown> {
    const grant = hs.cred.grant;
    if (hs.cred.kind === "enroll") {
      // An invite's link redeems it and nothing else, and closes once the answer has left.
      try {
        return await this.enroll(sock, grant, method, params);
      } finally {
        setTimeout(() => sock.close(1000, "enrolled"), 0);
      }
    }
    return this.join(sock, rpc, hs, method, params, linked);
  }

  /** `node.enroll` on an invite's link: the primary binds the grant to the node and answers its key. */
  private async enroll(sock: NodeSocket, grant: GrantRow, method: string, params: unknown): Promise<EnrollResult> {
    if (method !== "node.enroll") throw new RpcError("conflict", "an invite's link answers node.enroll alone");
    const parsed = nodeLinkRequests["node.enroll"].params.safeParse(params ?? {});
    if (!parsed.success) throw new RpcError("invalid", "bad node.enroll", parsed.error.issues);
    const enroll = this.deps.enroll;
    if (this.deps.role() !== "primary" || !enroll) {
      const primary = this.deps.primaryEndpoint();
      throw new RpcError("conflict", "only the primary redeems an invite", primary ? { primary } : undefined);
    }
    const p = parsed.data;
    return this.deps.gate.run(
      {
        principal: { kind: "node", id: p.node.id },
        action: "node.enroll",
        target: grant.name,
        args: { grant: grant.id, node: p.node.id, name: p.node.name },
        sessionKey: `enroll-${grant.id}`,
        redactResult: (r) => {
          const e = r as EnrollResult;
          return { ...e, key: "[redacted]", ...(e.relay ? { relay: { url: e.relay.url, token: "[redacted]" } } : {}) };
        },
      },
      async () => {
        const answer = await enroll(grant, p.node, p.account);
        this.log.info("invite redeemed", { grant: grant.id, name: grant.name, node: p.node.id, nodeName: p.node.name, role: answer.role, via: sock.remote.startsWith("relay:") ? "relay" : "direct" });
        return answer;
      },
    );
  }

  /** `node.hello`, then `node.join`, on a grant's link. */
  private async join(sock: NodeSocket, rpc: RpcPeer, hs: Handshake, method: string, params: unknown, linked: (p: NodePeer) => void): Promise<unknown> {
    const grant = hs.cred.grant;
    if (method === "node.hello") {
      const parsed = nodeLinkRequests["node.hello"].params.safeParse(params ?? {});
      if (!parsed.success) throw new RpcError("invalid", "bad node.hello", parsed.error.issues);
      const p = parsed.data;
      // The key proved the grant; the grant names the one node that may hold it.
      if (p.nodeId !== grant.node) {
        this.log.warn("node link refused: the grant is another node's", { remote: sock.remote, grant: grant.id, node: p.nodeId, bound: grant.node });
        setTimeout(() => sock.close(NODE_LINK_REFUSED, GRANT_REFUSED), 0);
        throw new RpcError("denied", "that grant is another node's");
      }
      if (p.cluster !== this.deps.cluster()) {
        this.log.warn("node link refused: another cluster", { remote: sock.remote, node: p.nodeId });
        setTimeout(() => sock.close(NODE_LINK_REFUSED, "wrong cluster"), 0);
        throw new RpcError("denied", "not this cluster");
      }
      if (p.protocolVersion !== PROTOCOL_VERSION) {
        this.log.warn("node link refused: protocol mismatch", { remote: sock.remote, node: p.nodeId, theirs: p.protocolVersion });
        setTimeout(() => sock.close(NODE_LINK_REFUSED, "protocol mismatch"), 0);
        throw new RpcError("unsupported", `protocol ${p.protocolVersion} is not ${PROTOCOL_VERSION}`);
      }
      hs.hello = true;
      const primary = this.deps.primaryEndpoint();
      return {
        nodeId: this.deps.selfId(),
        cluster: p.cluster,
        role: this.deps.role(),
        epoch: this.deps.epoch(),
        // every primary is the one the user chose at its epoch: an older node's own promotion says nothing of it
        ...(this.deps.role() === "primary" ? { chosen: true } : {}),
        ...(this.deps.role() !== "primary" && primary ? { primary } : {}),
      };
    }
    if (method === "node.join") {
      if (!hs.hello) throw new RpcError("conflict", "hello first");
      const parsed = nodeLinkRequests["node.join"].params.safeParse(params ?? {});
      if (!parsed.success) throw new RpcError("invalid", "bad node.join", parsed.error.issues);
      const p = parsed.data;
      if (p.node.id !== grant.node) {
        this.log.warn("node link refused: joined as another node", { remote: sock.remote, grant: grant.id, node: p.node.id, bound: grant.node });
        setTimeout(() => sock.close(NODE_LINK_REFUSED, GRANT_REFUSED), 0);
        throw new RpcError("denied", "that grant is another node's");
      }
      if (this.deps.role() !== "primary") {
        const primary = this.deps.primaryEndpoint();
        throw new RpcError("conflict", "not the primary", primary ? { primary } : undefined);
      }
      const hands = grant.role === "hands";
      // A hands node stands by for nothing: it is never a backup, and its epoch says nothing.
      const backup = p.backup && !hands;
      if (!hands && p.epoch > this.deps.epoch()) this.deps.onHigherEpoch(p.epoch, p.node.id);
      const linkId = `link-${newId("client").slice(4)}`;
      await this.deps.gate.run(
        { principal: { kind: "node", id: p.node.id }, action: "hello", args: { node: p.node.id, name: p.node.name, grant: grant.id, role: grant.role ?? "full", epoch: p.epoch, backup, endpoints: p.endpoints }, sessionKey: linkId },
        () => ({ linkId }),
      );
      const existing = this.peers.get(p.node.id);
      if (existing) existing.close(4409, "replaced by a new link");
      const rank = backup && p.rank !== undefined ? p.rank : undefined;
      const nodePeer = new NodePeer(
        rpc,
        { linkId, node: p.node, epoch: p.epoch, backup, ...(rank !== undefined ? { rank } : {}), endpoints: p.endpoints, grant: grant.id, hands },
        { log: this.log, closeSocket: (code, reason) => sock.close(code, reason), now: this.now() },
      );
      this.peers.set(p.node.id, nodePeer);
      // a node that came through the relay has no address a viewer could reach; its row says so
      const via = sock.remote.startsWith("relay:") ? "relay" : "direct";
      if (via === "direct" && sock.remote !== "?") this.addresses.set(p.node.id, sock.remote.replace(/^::ffff:/, ""));
      else this.addresses.delete(p.node.id);
      linked(nodePeer);
      nodePeer.onClose((reason) => this.onLinkClosed(nodePeer, reason));
      // Silence for two heartbeat intervals is the link gone.
      nodePeer.watch(this.deps.heartbeatMs, async () => this.now() - nodePeer.lastHeard < this.deps.heartbeatMs * 1.5);
      // Whether it stands by and whether it is hands come from the grant and the join, not from what its row says.
      const { backup: _backup, hands: _hands, ...sent } = p.node;
      const record: NodeRecord = { ...sent, via, status: "online", endpoints: p.endpoints, epoch: p.epoch, ...(backup ? { backup: true } : {}), ...(rank !== undefined ? { rank } : {}), ...(hands ? { hands: true } : {}) };
      this.deps.registry.upsert(record, { joined: true });
      // The join's lists pass the same test as the upward rows: the joiner's own, and none of this node's.
      const own = <T>(rows: T[], claim: (row: T) => UpwardClaim) => rows.filter((row) => refuseClaim(claim(row), p.node.id, this.deps.isLocal) === undefined);
      const sessions = own(p.sessions, (s) => ({ node: s.node, session: s.id }));
      const workspaces = own(p.workspaces, (w) => ({ node: w.node, workspace: w.id }));
      const asks = own(p.asks, (a) => ({ node: a.node, ask: a.id }));
      const terminals: Terminal[] = own(p.terminals ?? [], (t) => ({ node: t.node })).map(plainRow);
      const dropped = p.sessions.length + p.workspaces.length + p.asks.length + (p.terminals?.length ?? 0) - sessions.length - workspaces.length - asks.length - terminals.length;
      if (dropped > 0) this.log.warn("join rows refused: not the joiner's", { node: p.node.id, count: dropped });
      this.deps.mirror.fill(p.node.id, { sessions, workspaces, asks, terminals });
      for (const s of sessions) if (s.status !== "ended") this.deps.bus.emit("session.state", s);
      for (const t of terminals) if (t.status === "running") this.deps.bus.emit("terminal.state", t);
      for (const w of workspaces) this.deps.bus.emit("workspace.state", w);
      for (const a of asks) if (a.status === "open") this.deps.bus.emit("ask.state", a);
      if (backup) {
        this.deps.replicator.attach({ id: p.node.id, notify: (m, prm) => nodePeer.notify(m, prm) });
        this.deps.onBackupAttached?.(grant.id);
      }
      this.log.info("node joined", { node: p.node.id, name: p.node.name, grant: grant.id, role: grant.role ?? "full", via, backup, rank, sessions: p.sessions.length, asks: p.asks.length, link: linkId });
      this.broadcastRegistry(p.node.id);
      return { registry: this.registryFor(nodePeer), tz: this.deps.tz, epoch: this.deps.epoch(), primary: this.deps.selfId(), linkId };
    }
    throw new RpcError("conflict", "join first");
  }

  private onLinkClosed(peer: NodePeer, reason: string): void {
    if (this.peers.get(peer.id) !== peer) return;
    this.peers.delete(peer.id);
    this.linkDirects.get(peer.id)?.stop();
    this.linkDirects.delete(peer.id);
    this.deps.streams?.gone(peer.id);
    this.deps.policy.forgetSession(peer.info.linkId);
    this.deps.replicator.detach(peer.id);
    for (const [key, clientId] of [...this.relayed]) {
      if (!key.startsWith(peer.id + ":")) continue;
      this.relayed.delete(key);
      this.relayedBack.delete(clientId);
      this.deps.relayHost()?.close(clientId);
    }
    for (const [client, nodes] of [...this.metricsWatchers]) {
      nodes.delete(peer.id);
      if (nodes.size === 0) this.metricsWatchers.delete(client);
    }
    this.recentSamples.delete(peer.id);
    for (const [key, j] of [...this.joining]) if (j.node === peer.id) this.joining.delete(key);
    const dropped = this.deps.mirror.drop(peer.id);
    this.terminals.nodeGone(peer.id);
    const at = this.now();
    for (const s of dropped.sessions) this.deps.bus.emit("session.state", { ...s, status: "ended", endedAt: at, lastActivity: at });
    for (const t of dropped.terminals) this.deps.bus.emit("terminal.state", { ...t, status: "exited" });
    for (const a of dropped.asks) this.deps.bus.emit("ask.state", { ...a, status: "cancelled" });
    this.deps.registry.markOffline(peer.id);
    this.log.info("node left", { node: peer.id, reason, sessions: dropped.sessions.length, asks: dropped.asks.length });
    this.broadcastRegistry();
  }

  /** The registry to every linked node but `except`. */
  broadcastRegistry(except?: string): void {
    for (const p of this.peers.values()) if (p.id !== except) p.notify("registry.update", { nodes: this.registryFor(p) });
  }

  /** The registry as a node is sent it: whole, or, to a hands node, the primary and the backups alone, what it needs to follow the primary the user chooses next. */
  private registryFor(peer: NodePeer): NodeRecord[] {
    const nodes = this.deps.registry.list();
    return peer.info.hands ? nodes.filter((n) => n.role === "primary" || n.backup === true) : nodes;
  }

  // --- requests and notices from a linked secondary -----------------------------------------

  private async onRequest(peer: NodePeer, method: string, params: unknown, id: RpcId): Promise<unknown> {
    peer.heard(this.now());
    switch (method) {
      case "node.heartbeat": {
        const parsed = nodeLinkRequests["node.heartbeat"].params.safeParse(params ?? {});
        if (!parsed.success) throw new RpcError("invalid", "bad heartbeat");
        return { epoch: this.deps.epoch() };
      }
      case "relay.open": {
        if (peer.info.hands) throw new RpcError("denied", "a hands node's clients are its own");
        const parsed = nodeLinkRequests["relay.open"].params.safeParse(params ?? {});
        if (!parsed.success) throw new RpcError("invalid", "bad relay.open", parsed.error.issues);
        const host = this.deps.relayHost();
        if (!host) throw new RpcError("unavailable", "no relay here");
        const p = parsed.data;
        const key = `${peer.id}:${p.peer}`;
        const opened = await host.open(
          p.client,
          p.origin,
          {
            send: (text) => void peer.notify("relay", { peer: p.peer, frame: text }),
            close: () => void peer.notify("relay.close", { peer: p.peer }),
          },
          peer.id,
          { ...(p.grant !== undefined ? { grant: p.grant } : {}), ...(p.access !== undefined ? { access: p.access } : {}) },
        );
        this.relayed.set(key, opened.client.id);
        this.relayedBack.set(opened.client.id, { node: peer.id, peer: p.peer });
        return opened.result;
      }
      case "replicate.snapshot": {
        if (!peer.info.backup) throw new RpcError("denied", "not a backup");
        return this.deps.replicator.snapshot();
      }
      case "remote.pair": {
        if (peer.info.hands) throw new RpcError("denied", "a hands node pairs no viewer with another node's desktop");
        // Gated here as the secondary node, then carried to the desktop's owner, whose gate asks the user.
        const parsed = nodeLinkRequests["remote.pair"].params.safeParse(params ?? {});
        if (!parsed.success) throw new RpcError("invalid", "bad remote.pair", parsed.error.issues);
        const pairOn = this.deps.pairOn;
        if (!pairOn) throw new RpcError("unsupported", "this primary has no remote module");
        const p = parsed.data;
        const name = p.name ?? peer.info.node.name;
        return this.deps.gate.run(
          { principal: { kind: "node", id: peer.id }, action: "remote.pair", target: name, args: p, sessionKey: peer.info.linkId, ask: pairAsk(name) },
          async () => {
            await pairOn(p.node, { pin: p.pin, name }, { onPending: (ask) => void peer.notify("pending", { id, ask, at: this.now() }) });
            return {};
          },
          { onPending: (ask) => void peer.notify("pending", { id, ask, at: this.now() }) },
        );
      }
      case "direct.offer": {
        // the secondary offers its relayed link a data channel: this node's helper answers
        const linkDirect = this.linkDirects.get(peer.id);
        if (!linkDirect) throw new RpcError("unsupported", "this link has no data channel to offer: it is not relayed, or this node has no direct connections");
        const parsed = nodeLinkRequests["direct.offer"].params.safeParse(params ?? {});
        if (!parsed.success) throw new RpcError("invalid", "bad direct.offer", parsed.error.issues);
        return linkDirect.answer(parsed.data);
      }
      case "direct.turn": {
        const turn = this.deps.turn;
        if (!turn) throw new RpcError("unavailable", "this node mints no TURN credentials");
        return this.deps.gate.run({ principal: { kind: "node", id: peer.id }, action: "direct.turn", args: {}, sessionKey: peer.info.linkId, redactResult: () => "[credentials]" }, () => turn());
      }
      default: {
        const streams = this.deps.streams;
        // a hands node reaches no other machine's desktop, nor streams one through here
        if (peer.info.hands && STREAM_LINK_REQUESTS.has(method)) throw new RpcError("denied", "a hands node opens no stream to another node");
        if (streams && STREAM_LINK_REQUESTS.has(method)) {
          return streams.request({ id: peer.id, sessionKey: peer.info.linkId }, method, params, (ask) => void peer.notify("pending", { id, ask, at: this.now() }));
        }
        throw new RpcError("unsupported", `${method} is not served upward`);
      }
    }
  }

  private onNotification(peer: NodePeer, method: string, params: unknown): void {
    peer.heard(this.now());
    if (method === "relay") {
      const p = params as { peer: string; frame: string };
      const clientId = this.relayed.get(`${peer.id}:${p.peer}`);
      if (clientId) this.deps.relayHost()?.frame(clientId, p.frame);
      return;
    }
    if (method === "relay.close") {
      const p = params as { peer: string };
      const key = `${peer.id}:${p.peer}`;
      const clientId = this.relayed.get(key);
      if (!clientId) return;
      this.relayed.delete(key);
      this.relayedBack.delete(clientId);
      this.deps.relayHost()?.close(clientId);
      return;
    }
    if (method === "node.leave") {
      const p = params as { reason: string; primary?: string };
      this.log.info("node leaving", { node: peer.id, reason: p.reason });
      peer.close(1000, `left: ${p.reason}`);
      if (p.reason === "left" && peer.info.grant) this.deps.onLeft?.(peer.id, peer.info.grant);
      return;
    }
    if (method === "direct.candidate") {
      this.linkDirects.get(peer.id)?.candidate(params as { attempt: string; candidate: unknown });
      return;
    }
    if (PIPE_FRAMES.has(method)) {
      this.deps.streams?.frame(peer.id, method, params);
      return;
    }
    if (method === "pending") {
      const p = params as { id: RpcId; ask: Ask };
      const f = this.forwards.get(`${peer.id}:${String(p.id)}`);
      f?.onPending?.(p.ask);
      return;
    }
    if (method === "terminal.output") {
      const parsed = nodeLinkFrames["terminal.output"].safeParse(params);
      if (parsed.success) this.terminals.output(peer.id, parsed.data);
      else this.log.debug("bad terminal output ignored", { node: peer.id });
      return;
    }
    if (Object.hasOwn(UPWARD_NOTIFICATIONS, method)) {
      const name = method as UpwardNotification;
      const parsed = nodeLinkUpward[name].safeParse(params);
      if (!parsed.success) {
        this.log.debug("bad upward notification ignored", { node: peer.id, method });
        return;
      }
      const value = name === "terminal.state" ? plainRow(parsed.data as Terminal) : parsed.data;
      // A row about any other node is the registry this node was given, echoed: nothing new.
      if (name === "node.state" && (value as NodeRecord).id !== peer.id) return;
      const refused = refuseClaim((UPWARD_NOTIFICATIONS[name] as (v: unknown, o: OwnerLookup) => UpwardClaim)(value, { sender: peer.id, mirror: this.deps.mirror }), peer.id, this.deps.isLocal);
      if (refused) {
        this.log.warn("upward row refused: not the sender's", { node: peer.id, method, why: refused });
        return;
      }
      if (name === "metrics.sample") {
        this.routeSample(peer.id, value as MetricsSample);
        return;
      }
      // A node on an older build tells each frame of a CLI's spinner: with it off, a row that only spun is nothing new.
      if (name === "terminal.state" && JSON.stringify(this.deps.mirror.terminal(peer.id, (value as Terminal).id)) === JSON.stringify(value)) return;
      this.deps.mirror.apply(peer.id, method, value);
      if (name === "node.state") {
        // The node's own row changed (a voice stage, its desktop host): the registry's copy
        // follows, but what the join settled stays as it was.
        const row = this.deps.registry.get(peer.id);
        if (row) this.deps.registry.upsert(pinned(row, value as NodeRecord));
        return;
      }
      this.deps.bus.emit(method as "session.state", value as Session);
      return;
    }
    if (Object.hasOwn(UPWARD_EVENTS, method)) {
      const name = method as UpwardEvent;
      if (name === "event.custom" && peer.info.hands) {
        this.log.warn("upward event refused: a hands node raises no custom event", { node: peer.id });
        return;
      }
      const parsed = capabilityEvents[name].safeParse(params);
      if (!parsed.success) {
        this.log.debug("bad upward event ignored", { node: peer.id, method });
        return;
      }
      const refused = refuseClaim((UPWARD_EVENTS[name] as (v: unknown, o: OwnerLookup) => UpwardClaim)(parsed.data, { sender: peer.id, mirror: this.deps.mirror }), peer.id, this.deps.isLocal);
      if (refused) {
        this.log.warn("upward event refused: not the sender's", { node: peer.id, method, why: refused });
        return;
      }
      this.deps.events.inject({ name: method, params: parsed.data } as StreamEvent);
      return;
    }
    this.log.debug("upward frame ignored", { node: peer.id, method });
  }

  // --- requests to a linked secondary ---------------------------------------------------------

  /** One request to one node; `pending` notices about it reach `onPending`; an abort sends `cancel`. */
  async forward(node: string, method: string, params: unknown, opts: { signal?: AbortSignal; onPending?: (ask: Ask) => void; timeoutMs?: number } = {}): Promise<unknown> {
    const peer = this.peers.get(node);
    if (!peer?.open) throw new RpcError("unavailable", `node ${node} is not linked`);
    let key: string | undefined;
    const onAbort = () => {
      if (key !== undefined) void peer.request("cancel", { id: key.slice(node.length + 1) }).catch(() => undefined);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await peer.request(method, params, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        onSent: (id) => {
          key = `${node}:${String(id)}`;
          this.forwards.set(key, { ...(opts.onPending ? { onPending: opts.onPending } : {}) });
        },
      });
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      if (key !== undefined) this.forwards.delete(key);
    }
  }

  /** The same request to every linked node; a node that fails or times out is left out. */
  async fanout(method: string, params: unknown): Promise<Map<string, unknown>> {
    const out = new Map<string, unknown>();
    await Promise.all(
      [...this.peers.values()]
        .filter((p) => p.open)
        .map((p) =>
          p
            .request(method, params, { timeoutMs: FANOUT_TIMEOUT_MS })
            .then((r) => out.set(p.id, r))
            .catch((e: unknown) => this.log.debug("fan-out answer missing", { node: p.id, method, error: e instanceof Error ? e.message : String(e) })),
        ),
    );
    return out;
  }

  // --- metrics across the link ------------------------------------------------------------------

  /**
   * A client watches a node: the node is subscribed once, at the smallest interval any watcher
   * asked for and with every process row when any watcher wants them, and each watcher is sent
   * its own share of what comes (see `delivery.ts`). With `spend` the node's totals come back
   * and the watcher counts every token after them.
   */
  async watchMetrics(client: string, node: string, intervalMs: number, processes: ProcessDetail = "all", spend?: { from?: number; to?: number }): Promise<{ spend?: SpendTotals }> {
    if (!this.linked(node)) throw new RpcError("unavailable", `node ${node} is not linked`);
    const nodesOf = () => {
      let nodes = this.metricsWatchers.get(client);
      if (!nodes) this.metricsWatchers.set(client, (nodes = new Map()));
      return nodes;
    };
    if (!spend) {
      const nodes = nodesOf();
      const feed = nodes.get(node);
      if (feed) {
        feed.intervalMs = intervalMs;
        feed.processes = processes;
      } else nodes.set(node, new SampleFeed(intervalMs, processes));
      await this.forward(node, "metrics.subscribe", this.subscription(node)!);
      return {};
    }
    // With spend, the node sums the totals in the turn it hands the link its latest, and the
    // answer follows that sample on the link. The watcher's feed is made when the answer lands,
    // counting from the totals on: a sample that came in meanwhile is taken in if it is newer.
    this.metricsWatchers.get(client)?.delete(node);
    const key = `${client} ${node}`;
    this.joining.set(key, { node, intervalMs, processes });
    let answer: { spend?: SpendTotals };
    try {
      answer = (await this.forward(node, "metrics.subscribe", { ...this.subscription(node)!, spend })) as { spend?: SpendTotals };
    } catch (e) {
      this.joining.delete(key);
      await this.resubscribe(node);
      throw e;
    }
    this.joining.delete(key);
    if (!this.deps.clients.get(client)) {
      // gone while it waited: the link goes back to what the others want
      await this.resubscribe(node);
      return answer.spend ? { spend: answer.spend } : {};
    }
    // A node that sums no totals (one on an earlier version) gives the watcher none, and its samples count from here.
    const totals = answer.spend;
    const feed = new SampleFeed(intervalMs, processes, totals?.at ?? 0);
    nodesOf().set(node, feed);
    const recent = this.recentSamples.get(node) ?? [];
    for (const sample of recent) feed.count(sample);
    const latest = recent.at(-1);
    if (latest && !this.sendSample(client, feed.now(latest))) this.metricsWatchers.delete(client);
    return totals ? { spend: totals } : {};
  }

  /** A client stops watching: every node it watched is re-subscribed at the next smallest interval, or unsubscribed. */
  async unwatchMetrics(client: string): Promise<void> {
    const nodes = this.metricsWatchers.get(client);
    if (!nodes) return;
    this.metricsWatchers.delete(client);
    for (const node of nodes.keys()) await this.resubscribe(node);
  }

  /** Subscribes the link to what its watchers want now, or unsubscribes it when none is left. */
  private async resubscribe(node: string): Promise<void> {
    if (!this.linked(node)) return;
    const subscription = this.subscription(node);
    await this.forward(node, subscription === undefined ? "metrics.unsubscribe" : "metrics.subscribe", subscription ?? {}).catch(() => undefined);
  }

  /** What a node is subscribed for: the smallest interval its watchers and those joining asked for, every process row when any wants them; none when it has no watcher. */
  private subscription(node: string): { node: string; intervalMs: number; processes: ProcessDetail } | undefined {
    let min: number | undefined;
    let processes: ProcessDetail = "owners";
    const wants = [...[...this.metricsWatchers.values()].map((nodes) => nodes.get(node)), ...[...this.joining.values()].filter((j) => j.node === node)];
    for (const want of wants) {
      if (!want) continue;
      if (min === undefined || want.intervalMs < min) min = want.intervalMs;
      if (want.processes === "all") processes = "all";
    }
    return min === undefined ? undefined : { node, intervalMs: min, processes };
  }

  private routeSample(node: string, sample: MetricsSample): void {
    const recent = this.recentSamples.get(node) ?? [];
    recent.push(sample);
    if (recent.length > RECENT_SAMPLES) recent.shift();
    this.recentSamples.set(node, recent);
    const slack = slackFor(this.subscription(node)?.intervalMs ?? 0);
    for (const [client, nodes] of [...this.metricsWatchers]) {
      const due = nodes.get(node)?.offer(sample, slack);
      if (due && !this.sendSample(client, due)) this.metricsWatchers.delete(client);
    }
  }

  /** A sample to a watcher: a client's as `metrics.sample`, or one of the daemon's own through `samples`. */
  private sendSample(client: string, sample: MetricsSample): boolean {
    return this.deps.samples?.(client, sample) ?? this.deps.clients.send(client, "metrics.sample", sample);
  }

  /** A client went: its watch on another node goes with it, and so do the terminals it had open on one. */
  onDisconnect(client: string): void {
    if (this.metricsWatchers.has(client)) void this.unwatchMetrics(client);
    this.terminals.drop(client);
  }

  // --- leaving -----------------------------------------------------------------------------------

  /** Asks a linked node to take a new key for its grant, over the link it holds now. */
  async rekey(node: string, key: string, timeoutMs: number): Promise<boolean> {
    const peer = this.peers.get(node);
    if (!peer?.open) return false;
    try {
      await peer.request("grant.rekey", { key }, { timeoutMs });
      return true;
    } catch (e) {
      this.log.warn("a node did not take its new key", { node, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  /** Tells every linked node this primary is going (stopping, or stepping down in favour of `primary`) and closes the links. */
  leaveAll(reason: "stopping" | "stepdown", primary?: string): void {
    for (const p of [...this.peers.values()]) {
      p.notify("node.leave", { reason, ...(primary !== undefined ? { primary } : {}) });
      p.close(1001, reason);
    }
  }

  /**
   * A node's grant ended: the node hears it inside the link, the link closes as `revoked`, and
   * its row goes from the registry. Settles once the link's last record has left, so its relay
   * token is revoked after the node was told why.
   */
  revoked(node: string): Promise<void> {
    const peer = this.peers.get(node);
    let gone: Promise<void> = Promise.resolve();
    if (peer) {
      peer.notify("node.leave", { reason: NODE_LINK_REVOKED });
      gone = peer.close(NODE_LINK_REFUSED, NODE_LINK_REVOKED);
    }
    this.addresses.delete(node);
    if (this.deps.registry.get(node)) {
      this.deps.registry.markOffline(node);
      this.deps.registry.forget(node);
      this.broadcastRegistry();
    }
    return gone;
  }

  /** Closes every link without a word; for a listener going down. */
  closeAll(): void {
    for (const p of [...this.peers.values()]) p.close(1001, "closing");
  }
}

/** A node's own row as it sent it, with what its join settled kept: its role, backup rank, epoch, endpoints, way in and whether it is hands. */
export function pinned(row: NodeRecord, sent: Omit<NodeRecord, "endpoints"> & { endpoints?: string[] }): NodeRecord {
  const { backup: _backup, rank: _rank, epoch: _epoch, endpoints: _endpoints, hands: _hands, ...rest } = sent;
  return {
    ...rest,
    id: row.id,
    role: row.role,
    via: row.via,
    status: "online",
    endpoints: row.endpoints,
    ...(row.backup !== undefined ? { backup: row.backup } : {}),
    ...(row.rank !== undefined ? { rank: row.rank } : {}),
    ...(row.epoch !== undefined ? { epoch: row.epoch } : {}),
    ...(row.hands ? { hands: true } : {}),
  };
}
