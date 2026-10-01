// The nodes module: the registry, the link to the primary or the links from the
// secondaries, discovery on the network, replication to the backups, and the role this
// node holds. A node configured primary listens for a live primary of a higher epoch before
// it takes the role; a secondary seeks the primary (the configured endpoint, then whoever
// answers a broadcast, then the registry's last primary and backups by rank), links, and
// serves what the primary forwards. A backup whose primary is gone waits `failover_ms`
// times its rank, then promotes itself at the next epoch and starts the brain; a primary
// that hears a higher epoch steps down and rejoins as a backup; the user can hand the role
// over with `node.promote`. Every role change is announced as `node.state` and closes this
// node's own clients, which reconnect into the right mode.
//
// Membership is a grant, kept in `data/link.json`: the cluster's first primary mints the
// cluster's id and a grant for itself; any other machine joins by redeeming an invite the
// primary minted (`invite`, `join`) and leaves with `leave`. A node in no cluster runs
// alone: configured primary, it starts a cluster of its own; configured secondary, it waits,
// UNLINKED, for an invite. Every link and every probe is sealed with the linking node's
// grant key, which only the primary and the backups holding its replica know besides the
// node itself: a datagram is never believed on its own, the endpoint it names is probed
// first, and the probe's sealed answer is what counts. A node joined as hands is never a
// backup and never takes the role. A node whose owner shared some folders alone (the join's
// `paths`, or `[node.scope]`'s workspaces) confines what its primary sees and does there to
// them (`confine.ts`); its own apps see the machine.
//
// Across networks the server's registry arbitrates, through the cloud module's `Arbiter`:
// while it is active (signed in, a plan with the relay, `[nodes] relay` on, the link up) a
// node *takes* the role only with a grant — a starting primary claims, a backup's failover
// claims, a takeover claims — and *keeps* a role through a link outage, reconciling at
// every link-up with `registry.register`. A grant that went elsewhere arrives as
// `registry.primary` and the holder steps down to it. The relay, reached with the relay token
// this node's own grant was given at enrollment and no account of its own, is the last
// candidate of a seek, and the first after a step-down to a node with no LAN endpoint. A
// backup whose link was a tunnel never promotes without the registry's word: with the server
// unreachable it keeps waiting; a directly linked backup keeps milestone 9's rule.

import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { FULL, inviteLink, inviteText, newId, parseInvite, RpcError } from "@cophyla/protocol";
import type { Ask, ClientNotificationParams, Grant, GrantRole, IceServer, InviteBody, InviteOffer, LinkLeaveReason, MetricsSample, Node, NodeRecord, NodeRole, RiskClass, Session, TargetLookup, Terminal, ToolSource, Via, Workspace } from "@cophyla/protocol";
import { pskFromHex } from "@cophyla/relay";
import type { SealedKind } from "@cophyla/relay";
import { readLinkFile, removeLinkFile, writeLinkFile } from "../grants/link-file.ts";
import type { LinkFile } from "../grants/link-file.ts";
import { targetLookup } from "../grants/lookup.ts";
import { freshSecret } from "../grants/store.ts";
import type { GrantRow, Grants } from "../grants/store.ts";
import type { NodeTunnel } from "../cloud/tunnels.ts";
import type { ClientRegistry } from "../api/clients.ts";
import { CLOSE_ROLE_CHANGED } from "../api/server.ts";
import type { NodeSocket, NodeSocketHandler, RelayHost, RelayUplink } from "../api/server.ts";
import type { BrainMethodTable } from "../brain-link/methods.ts";
import type { Bus } from "../bus.ts";
import type { Paths } from "../config/load.ts";
import type { Config } from "../config/schema.ts";
import type { Editable } from "../editable/index.ts";
import type { EventStream } from "../events/stream.ts";
import type { Asks } from "../gate/asks.ts";
import type { Gate } from "../gate/index.ts";
import type { Policy } from "../gate/policy.ts";
import type { Logger } from "../log.ts";
import type { Metrics } from "../metrics/index.ts";
import type { Direct } from "../direct/index.ts";
import type { LinkDirectTiming } from "./direct.ts";
import type { Remote as RemoteModule } from "../remote/index.ts";
import type { SessionFiles } from "../sessions/files.ts";
import type { Profiles } from "../sessions/profiles.ts";
import type { PipeHub, PipeWire } from "../remote/pipes.ts";
import type { Store } from "../store/index.ts";
import type { Tasks } from "../tasks/index.ts";
import type { TaskScheduler } from "../tasks/scheduler.ts";
import type { Chat } from "../chat/index.ts";
import type { Arbiter } from "../cloud/registry.ts";
import type { Workspaces } from "../workspaces/index.ts";
import { udpTransport } from "./discovery.ts";
import type { Datagram, DiscoverySocket, DiscoveryTransport, Remote } from "./discovery.ts";
import type { ForwardHost } from "./forward.ts";
import { Confinement } from "./confine.ts";
import { redeemNodeInvite } from "./enroll.ts";
import { Inbound } from "./inbound.ts";
import type { EnrollResult, LinkCredential } from "./inbound.ts";
import { Mirror } from "./mirror.ts";
import { Outbound } from "./outbound.ts";
import type { LinkTarget } from "./outbound.ts";
import { Registry } from "./registry.ts";
import { Replica, Replicator } from "./replication.ts";
import { RoleMachine } from "./role.ts";
import { endpointCandidates, linkCandidates, Seeker } from "./seek.ts";
import type { CandidateSources } from "./seek.ts";
import { PIPE_OPEN_TIMEOUT_MS, StreamLinks } from "./streams.ts";
import type { NodeTerminals, TerminalViews } from "./terminals.ts";
import type { RoleState } from "./role.ts";
import { openRelayLink } from "./sealed-link.ts";
import type { NodeIdentity } from "./self.ts";

export interface NodesDeps {
  config: Config;
  paths: Paths;
  store: Store;
  bus: Bus;
  gate: Gate;
  policy: Policy;
  clients: ClientRegistry;
  /** A metrics watcher that is not a client (`listener:<id>`): its samples of another node go here; undefined for a client's. */
  samples?: (client: string, sample: MetricsSample) => boolean | undefined;
  events: EventStream;
  editable: Editable;
  /** What runs only on the primary beside the brain: the task scheduler and the brain's listeners. */
  scheduler: Pick<TaskScheduler, "start" | "stop">;
  tasks: Tasks;
  asks: Asks;
  chat: Chat;
  sessions: { list(): Session[]; get(id: string): Session | undefined };
  workspaces: Workspaces;
  served: (primaryId: string) => BrainMethodTable;
  startBrain: () => Promise<void>;
  stopBrain: () => Promise<void>;
  /** This node's row at the current role. */
  self: () => Node;
  identity: NodeIdentity;
  metrics?: Metrics;
  /** The remote module, once built: what the served table and the upward `remote.pair` reach. */
  remote?: () => RemoteModule | undefined;
  /** This node's profiles, which the primary's clients may set over the link. */
  profiles?: Pick<Profiles, "update">;
  /** This node's sessions' folders, repositories and files, which the primary's clients' explorer lists and viewer reads over the link. */
  files?: Pick<SessionFiles, "list" | "git" | "read">;
  /** This node's terminals, once built: their rows go up a link, and the primary's clients open them. */
  terminals?: () => NodeTerminals | undefined;
  /** The direct connections, once built: switched from the primary's clients, their state carried up on link. */
  direct?: () => Direct | undefined;
  /** The pipes a stream page rides where there is no route to its desktop, once built. */
  pipes?: () => PipeHub | undefined;
  /** How soon a relayed link tries its data channel, and again; shorter in the tests. */
  directTiming?: LinkDirectTiming;
  log: Logger;
  platformVersion: string;
  tz: string;
  /** Every credential that reaches this node from outside: the node grants are the cluster's membership. */
  grants: Grants;
  /** A relay token for one of this node's grants, when the server can grant it now; throws otherwise. */
  relayGrant?: (peer: string, opts: { kind: "node"; name?: string; expiresAt?: number }) => Promise<{ url: string; token: string }>;
  /** Tells the server a relay peer is over; best effort. */
  revokeRelay?: (peer: string) => Promise<boolean>;
  /** The SHA-256 of the LAN listener's key, once it is up: what an invite pins. */
  lanSpki?: () => string | undefined;
  /** The account this node is signed in to: a machine on the same account as the primary joins as a full node. */
  account?: () => string | undefined;
  /** On a backup, the replica changed the primary's grants: what a grant that went held here is closed. */
  onGrantsChanged?: () => void;
  /** TURN credentials on this node's account, for a linked node with none of its own. */
  turn?: () => Promise<{ iceServers: IceServer[]; expiresAt: number }>;
  /** Where a tool comes from and its risk: what a confined node refuses its primary. */
  tools?: { source(name: string): ToolSource | undefined; risk(name: string): RiskClass | undefined };
  discovery?: DiscoveryTransport;
  /** The primary's relay host, once the listeners are up. */
  relayHost: () => RelayHost | undefined;
  /** The LAN listener's port, once it is up: what other nodes link to. */
  lanPort: () => number | undefined;
  lanIps: () => string[];
  /** The server's registry client, once the cloud module is built; absent in a daemon without it. */
  arbiter?: () => Arbiter | undefined;
  /** Whether an account token is on disk: a starting primary then waits for the link before it takes the role alone. */
  signedIn?: () => boolean;
  /** The role taken or given up: what the cloud backup's sender starts and stops on. */
  onRole?: (primary: boolean) => void;
  /** The workspace nodes here: the machine joins none of their clusters, and takes no invite from a node they know. */
  guests?: () => { clusters(): string[]; knows(node: string): boolean } | undefined;
  now?: () => number;
}

/** Whether a backup whose primary is gone may take the role now: never without a grant when its link was a tunnel. */
export function mayPromote(opts: { lostVia: Via | undefined; arbiterActive: boolean }): boolean {
  if (opts.arbiterActive) return true;
  return opts.lostVia !== "relay";
}

/** How long a node invite may be redeemed, unless the minter says otherwise. */
export const DEFAULT_INVITE_MS = 60 * 60 * 1000;
/** How long a revoke waits for the node to be told before its relay token goes anyway. */
const REVOKE_TOLD_MS = 2000;

/** How often one endpoint a datagram named may be probed, and how many probes may run at once. */
const PROBE_INTERVAL_MS = 1000;
const MAX_PROBES = 4;

interface Candidate {
  endpoint: string;
  nodeId?: string;
  epoch?: number;
  heardAt: number;
}

export class Nodes {
  private deps: NodesDeps;
  private log: Logger;
  readonly registry: Registry;
  readonly mirror: Mirror;
  readonly role: RoleMachine;
  private inbound: Inbound;
  private outbound: Outbound;
  private replicator: Replicator;
  private replica?: Replica;
  private discovery?: DiscoverySocket;
  private beaconTimer?: ReturnType<typeof setTimeout>;
  private queryTimer?: ReturnType<typeof setTimeout>;
  private waitTimer?: ReturnType<typeof setTimeout>;
  /** The loop that tries the ways to the primary while this node seeks it. */
  private seeker: Seeker;
  /** Primaries heard on the network, newest first. */
  private heard: Candidate[] = [];
  /** An endpoint to try first at the next seek: the primary that told us where to go. */
  private preferred?: string;
  /** The relay first at the next seek: the holder the registry named has no LAN endpoint we know. */
  private preferRelay = false;
  /** How the last link to the primary ran, for the failover rule. */
  private lostVia?: Via;
  private registryTimer?: ReturnType<typeof setTimeout>;
  private offArbiter: (() => void)[] = [];
  /** This node's membership: its grant, key and cluster; none while it is in no cluster. */
  private membership?: LinkFile;
  /** A join in flight: a second one waits for no one. */
  private joining = false;
  private stopped = false;
  private started = false;
  private offBus: (() => void)[] = [];
  /** Role changes, for the tests and the log. */
  readonly transitions: { from: RoleState; to: RoleState; at: number }[] = [];

  constructor(deps: NodesDeps) {
    this.deps = deps;
    this.log = deps.log;
    const epoch = Number(deps.store.meta.get("epoch") ?? "1") || 1;
    const configured: NodeRole = deps.config.node.role;
    const membership = readLinkFile(deps.paths.linkFile);
    if (membership) this.membership = membership;
    const hands = membership?.role === "hands";
    // A node joined as hands never claims the role, whatever it was configured; one in no cluster waits for an invite unless it starts one.
    const start = hands ? "seeking" : configured === "primary" ? "claiming" : membership ? "seeking" : "unlinked";
    this.role = new RoleMachine({ configured, epoch, start });
    this.role.hands = hands;
    this.role.configuredBackup = deps.config.node.backup;
    this.role.onChange((from, to) => {
      this.transitions.push({ from, to, at: this.now() });
      this.log.info("role", { from, to, epoch: this.role.epoch });
    });
    this.registry = new Registry({
      store: deps.store,
      bus: deps.bus,
      self: () => this.self(),
      selfEndpoints: () => this.selfEndpoints(),
      selfRank: () => (this.role.backup ? deps.config.node.backup_rank : undefined),
      ...(deps.now ? { now: deps.now } : {}),
    });
    this.mirror = new Mirror();
    this.replicator = new Replicator({ store: deps.store, paths: deps.paths, epoch: () => this.role.epoch, log: this.log.child("replication") });
    const streams = new StreamLinks({
      selfId: () => deps.identity.id,
      gate: deps.gate,
      remote: () => deps.remote?.(),
      pipes: () => deps.pipes?.(),
      // only the primary carries a stream on: to the secondary whose desktop it is
      carry: (node, method, params, opts) => {
        if (this.role.role !== "primary") return Promise.reject(new RpcError("unavailable", `no route to ${node} from here`));
        return this.inbound.forward(node, method, params, opts);
      },
      log: this.log.child("streams"),
    });
    this.inbound = new Inbound({
      credential: (grant, kind) => this.credential(grant, kind),
      cluster: () => this.membership?.cluster,
      enroll: (grant, node, account) => this.enroll(grant, node, account),
      onEnrollClosed: (grant) => this.onEnrollClosed(grant),
      onLeft: (node, grant) => this.onLeft(node, grant),
      onBackupAttached: (grant) => this.deps.grants.markReplica(grant),
      ...(deps.turn ? { turn: deps.turn } : {}),
      selfId: () => deps.identity.id,
      role: () => this.role.role,
      epoch: () => this.role.epoch,
      primaryEndpoint: () => this.outbound.info?.endpoint,
      tz: deps.tz,
      registry: this.registry,
      mirror: this.mirror,
      bus: deps.bus,
      events: deps.events,
      gate: deps.gate,
      policy: deps.policy,
      clients: deps.clients,
      ...(deps.samples ? { samples: deps.samples } : {}),
      relayHost: deps.relayHost,
      replicator: this.replicator,
      heartbeatMs: deps.config.nodes.heartbeat_ms,
      helloTimeoutMs: deps.config.nodes.hello_timeout_ms,
      log: this.log.child("inbound"),
      onHigherEpoch: (epoch, nodeId) => this.log.warn("a node joined at a higher epoch than this primary's", { epoch, node: nodeId, mine: this.role.epoch }),
      pairOn: (node, p, opts) => this.pairOn(node, p, opts),
      isLocal: (kind, id) => this.isLocal(kind, id),
      ...(deps.direct ? { direct: deps.direct } : {}),
      directNodes: () => deps.config.direct.nodes,
      streams,
      ...(deps.now ? { now: deps.now } : {}),
    });
    this.outbound = new Outbound({
      membership: () => this.membership,
      hands: () => this.role.hands,
      onRekey: (key) => this.onRekey(key),
      confine: () => this.confinement(),
      answerHere: () => this.membership?.answerHere === true,
      local: {
        session: (id) => deps.sessions.get(id),
        workspace: (id) => deps.workspaces.get(id),
        ask: (id) => deps.asks.get(id),
      },
      ...(deps.tools ? { tools: deps.tools } : {}),
      platformVersion: deps.platformVersion,
      self: () => this.self(),
      selfEndpoints: () => this.selfEndpoints(),
      backup: () => this.role.backup,
      rank: () => deps.config.node.backup_rank,
      epoch: () => this.role.epoch,
      sessions: () => deps.sessions.list(),
      workspaces: () => deps.workspaces.list({ node: deps.identity.id }),
      asks: () => deps.asks.listOpen(),
      registry: this.registry,
      bus: deps.bus,
      events: deps.events,
      gate: deps.gate,
      served: deps.served,
      ...(deps.metrics ? { metrics: deps.metrics } : {}),
      ...(deps.remote ? { remote: deps.remote() } : {}),
      ...(deps.profiles ? { profiles: deps.profiles } : {}),
      ...(deps.files ? { files: deps.files } : {}),
      ...(deps.terminals ? { terminals: deps.terminals } : {}),
      ...(deps.direct?.() ? { direct: deps.direct()! } : {}),
      directNodes: () => deps.config.direct.nodes,
      ...(deps.directTiming ? { directTiming: deps.directTiming } : {}),
      streams,
      replica: () => this.replica,
      heartbeatMs: deps.config.nodes.heartbeat_ms,
      helloTimeoutMs: deps.config.nodes.hello_timeout_ms,
      log: this.log.child("outbound"),
      onLinked: (info) => this.onLinked(info.primary, info.epoch, info.via),
      onLost: (reason) => this.onLost(reason),
      onTakeover: (epoch) => this.promoteSelf(epoch, "takeover"),
      onLeave: (reason, primary) => this.onPrimaryLeaving(reason, primary),
      ...(deps.now ? { now: deps.now } : {}),
    });
    this.seeker = new Seeker({
      candidates: () => this.candidates(),
      connect: (target) => this.outbound.connect(target),
      active: () => this.role.state === "seeking" && !this.stopped,
      reconnectMs: deps.config.nodes.reconnect_ms,
      reconnectMaxMs: deps.config.nodes.reconnect_max_ms,
      linked: () => {
        this.preferred = undefined;
        this.preferRelay = false;
      },
      missed: () => this.missed(),
      log: this.log,
    });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private arbiter(): Arbiter | undefined {
    return this.deps.arbiter?.();
  }

  /** Whether the server may be asked now. */
  private arbiterActive(): boolean {
    return this.deps.config.nodes.relay && (this.arbiter()?.active() ?? false);
  }

  // --- what the rest of the daemon reads ------------------------------------------------------

  /** This node's row at the current role, with the brain's version when it runs here. */
  self(): Node {
    return this.deps.self();
  }

  roleOf(): NodeRole {
    return this.role.role;
  }

  epoch(): number {
    return this.role.epoch;
  }

  state(): RoleState {
    return this.role.state;
  }

  /** Whether this secondary has a live link to the primary. */
  linked(): boolean {
    return this.outbound.linked();
  }

  primaryId(): string | undefined {
    return this.role.role === "primary" ? this.deps.identity.id : this.outbound.primaryId;
  }

  /** How this node reaches its primary: through a tunnel, or on the LAN (and `direct` for a primary). */
  via(): Via {
    return this.outbound.info?.via ?? "direct";
  }

  /** Whether a node is linked to this primary. */
  linkedTo(node: string): boolean {
    return this.inbound.linked(node);
  }

  linkedNodes(): string[] {
    return this.inbound.linkedIds();
  }

  /** How many backup nodes take this primary's replication now: a cloud restore with one is refused. */
  attachedBackups(): number {
    return this.replicator.attached;
  }

  /**
   * Where a node's machine is, for a viewer of its desktop: its first endpoint, or, for a node
   * with no LAN listener, the address it linked here from (known on the primary only).
   */
  addressOf(id: string): string | undefined {
    return this.registry.endpointsOf(id)[0] ?? this.inbound.addressOf(id);
  }

  /**
   * Whether this machine has a route to `node`'s: this node, or one linked over the LAN as
   * this node sees it. A node that came through the relay has none, nor has any node when
   * this one did (the primary's LAN is not this one's): its desktop is shown through the links.
   */
  lanRoute(node: string): boolean {
    if (node === this.deps.identity.id) return true;
    if (this.addressOf(node) === undefined) return false;
    if (this.role.role !== "primary" && this.outbound.info?.via !== "direct") return false;
    return this.registry.get(node)?.via !== "relay";
  }

  /** A request to `node` over the links: straight to it from the primary, through the primary from a secondary. */
  linkRequest(node: string, method: string, params: unknown, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    if (this.role.role === "primary") return this.inbound.forward(node, method, params, opts);
    return this.outbound.requestPrimary(method, params, opts);
  }

  /** The node a pipe toward `node` goes to next: `node` itself when it is linked here, the primary from a secondary. */
  nextHop(node: string): string | undefined {
    if (node === this.deps.identity.id) return undefined;
    if (this.role.role === "primary") return this.inbound.linked(node) ? node : undefined;
    return this.outbound.linked() ? this.outbound.primaryId : undefined;
  }

  /** How a pipe's frames go on the link to `node`, while there is one. */
  linkWire(node: string): PipeWire | undefined {
    let notify: ((method: string, params: unknown) => boolean) | undefined;
    if (this.role.role === "primary") {
      if (this.inbound.linked(node)) notify = (m, p) => this.inbound.peer(node)?.notify(m, p) ?? false;
    } else if (this.outbound.linked() && this.outbound.primaryId === node) {
      notify = (m, p) => this.outbound.notifyPrimary(m, p);
    }
    if (!notify) return undefined;
    const send = notify;
    return {
      data: (pipe, data) => send("pipe.data", { pipe, data }),
      ack: (pipe, bytes) => void send("pipe.ack", { pipe, bytes }),
      close: (pipe, reason) => void send("pipe.close", { pipe, reason: reason.slice(0, 200) }),
    };
  }

  /** Opens a pipe on the link to `hop`, toward `params.node`. */
  async openPipeOn(hop: string, params: { node: string; pipe: string }): Promise<{ window: number }> {
    return (await this.linkRequest(hop, "remote.pipe.open", params, { timeoutMs: PIPE_OPEN_TIMEOUT_MS })) as { window: number };
  }

  /** How other nodes reach this one: the LAN listener on every address, the LAN ones first. */
  selfEndpoints(): string[] {
    const port = this.deps.lanPort();
    if (port === undefined) return [];
    const ips = this.deps.lanIps();
    return [...ips.filter((ip) => ip !== "127.0.0.1"), ...ips.filter((ip) => ip === "127.0.0.1")].map((ip) => `${ip}:${port}`);
  }

  /** The seams a listener gets: accepting links on `/ws/node`, and relaying this node's clients up. */
  get seams(): { accepting: () => boolean; acceptSocket: (sock: NodeSocket) => NodeSocketHandler; relay: RelayUplink } {
    return {
      accepting: () => !this.stopped && this.membership !== undefined,
      acceptSocket: (sock) => this.inbound.acceptSocket(sock),
      relay: this.outbound.relay,
    };
  }

  /** What a new client of the primary hears beside this node's own: the mirrors and the registry. */
  initial(): { sessions: Session[]; workspaces: Workspace[]; asks: Ask[]; terminals: Terminal[]; nodes: NodeRecord[]; updates: ReturnType<Mirror["updates"]> } {
    return { sessions: this.mirror.sessions(), workspaces: this.mirror.workspaces(), asks: this.mirror.asks(), terminals: this.mirror.terminals(), nodes: this.registry.list(), updates: this.mirror.updates() };
  }

  /** The terminals of linked nodes the primary's clients have open: their keys and sizes go down the links. */
  get remoteTerminals(): Pick<TerminalViews, "input" | "resize"> {
    return this.inbound.terminals;
  }

  /** Where a terminal viewer of the primary's is on this node: its output goes up the link, and how far behind the link is. */
  readonly linkViewers = {
    get: (): { socket: { buffered(): number }; listener: "relayed" } | undefined => (this.outbound.linked() ? { socket: { buffered: () => this.outbound.buffered }, listener: "relayed" } : undefined),
    send: (client: string, params: ClientNotificationParams<"terminal.output">): boolean => this.outbound.terminalOutput(client, params),
  };

  mirrorSession(id: string): Session | undefined {
    return this.mirror.sessions().find((s) => s.id === id);
  }

  /** Whether this node holds a session, an ask, a workspace or a terminal itself, whatever a mirror says. */
  isLocal(kind: "session" | "ask" | "workspace" | "terminal", id: string): boolean {
    if (kind === "session") return this.deps.sessions.get(id) !== undefined;
    if (kind === "ask") return this.deps.asks.get(id) !== undefined;
    if (kind === "terminal") return this.deps.terminals?.()?.rows.list().some((t) => t.id === id) ?? false;
    return this.deps.workspaces.get(id)?.node === this.deps.identity.id;
  }

  /**
   * What a session, an ask or a workspace is about: this node's own row first, a linked node's
   * mirror after, the same sources the forwarder routes by. What the access checks read.
   */
  readonly lookup: TargetLookup = targetLookup({
    self: () => this.deps.identity.id,
    session: (id) => this.deps.sessions.get(id) ?? this.mirrorSession(id),
    ask: (id) => this.deps.asks.get(id) ?? this.mirror.ask(id),
    workspace: (id) => this.deps.workspaces.get(id) ?? this.mirror.workspaces().find((w) => w.id === id),
  });

  /** The forwarder's view of this module. What this node holds itself is routed here, whatever a mirror claims. */
  get forwardHost(): ForwardHost {
    return {
      selfId: () => this.deps.identity.id,
      ownerOfSession: (id) => (this.isLocal("session", id) ? undefined : this.mirror.ownerOfSession(id)),
      ownerOfAsk: (id) => (this.isLocal("ask", id) ? undefined : this.mirror.ownerOfAsk(id)),
      ownerOfWorkspace: (id) => (this.isLocal("workspace", id) ? undefined : this.mirror.ownerOfWorkspace(id)),
      ownerOfTerminal: (id) => (this.isLocal("terminal", id) ? undefined : this.mirror.ownerOfTerminal(id)),
      noteTerminal: (node, t) => {
        if (this.inbound.linked(node)) this.mirror.apply(node, "terminal.state", t);
      },
      mirrorAsk: (id) => this.mirror.ask(id),
      mirrorSessions: () => this.mirror.sessions(),
      mirrorWorkspaces: () => this.mirror.workspaces(),
      mirrorTerminals: () => this.mirror.terminals(),
      registryList: () => this.registry.list(),
      linked: (node) => this.inbound.linked(node),
      forward: (node, method, params, opts) => this.inbound.forward(node, method, params, opts),
      fanout: (method, params) => this.inbound.fanout(method, params),
      remoteMetrics: {
        subscribe: (client, node, intervalMs, processes, spend) => this.inbound.watchMetrics(client, node, intervalMs, processes, spend),
        unsubscribe: (client) => this.inbound.unwatchMetrics(client),
      },
      remoteTerminals: {
        open: (client, node, p, opts) => this.inbound.terminals.open(client, node, p, opts),
        close: (client, node, p, opts) => this.inbound.terminals.close(client, node, p, opts),
      },
      chat: this.deps.chat,
      localWorkspaces: () => this.deps.workspaces.list({ node: this.deps.identity.id }),
    };
  }

  /**
   * Has `node`'s desktop host accept a viewer's PIN: this node's own host, a linked
   * secondary's over a forward, or, from a secondary, the primary's routing over the link.
   */
  async pairOn(node: string, p: { pin: string; name: string }, opts: { signal?: AbortSignal; onPending?: (ask: Ask) => void } = {}): Promise<void> {
    if (node === this.deps.identity.id) {
      const remote = this.deps.remote?.();
      if (!remote) throw new RpcError("unsupported", "this node has no remote module");
      await remote.pair(p.pin, p.name, opts.signal ? { signal: opts.signal } : {});
      return;
    }
    if (this.role.role === "primary") {
      if (!this.inbound.linked(node)) {
        const known = this.registry.get(node) !== undefined;
        throw known ? new RpcError("unavailable", `node ${node} is not linked`) : new RpcError("not_found", `no node ${node}`);
      }
      await this.inbound.forward(node, "remote.pair", { node, pin: p.pin, name: p.name }, opts);
      return;
    }
    await this.outbound.requestPrimary("remote.pair", { node, pin: p.pin, name: p.name }, { timeoutMs: 120_000, ...(opts.signal ? { signal: opts.signal } : {}) });
  }

  /** TURN credentials from the primary, for this node's direct connections when it has no account of its own. */
  async turnFromPrimary(): Promise<{ iceServers: IceServer[]; expiresAt: number }> {
    if (this.role.role === "primary" || !this.outbound.linked()) throw new RpcError("unavailable", "no primary to ask for TURN credentials");
    return this.outbound.turn();
  }

  /** A sample of this node for the primary, when it watches. */
  deliverSample(sample: MetricsSample): boolean {
    return this.outbound.deliverSample(sample);
  }

  onDisconnect(client: string): void {
    this.inbound.onDisconnect(client);
  }

  /** An editable file changed here: sent to the backups while this node is the primary. */
  onFile(rel: string, kind: "changed" | "removed"): void {
    if (this.role.role === "primary") this.replicator.file(rel, kind);
  }

  // --- lifecycle ---------------------------------------------------------------------------------

  /** Settles the starting role: resolves once a configured primary has claimed or yielded, or a secondary has begun seeking. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const { config } = this.deps;
    if (!this.membership) {
      if (this.role.state === "unlinked") {
        this.log.warn("this node is in no cluster and runs alone: join one with `cophylad join` and an invite from the primary", { role: config.node.role });
        return;
      }
      this.foundCluster();
    }
    this.armMembershipClock();
    if (config.nodes.discovery) await this.openDiscovery();
    if (!this.role.hands) this.watchArbiter();
    if (this.role.state === "claiming") {
      // a signed-in node always claims: the registry may hold the role elsewhere
      const known = this.registry.peers().length > 0 || this.discovery !== undefined || this.deps.signedIn?.() === true;
      if (!known || config.nodes.claim_wait_ms === 0) {
        this.becomePrimary({ initial: true });
        return;
      }
      await this.claim();
      return;
    }
    this.startSeeking();
  }

  /** The registry's two signals: the link up (register, reconcile) and a grant that went elsewhere. */
  private watchArbiter(): void {
    const arb = this.arbiter();
    if (!arb || !this.deps.config.nodes.relay || this.offArbiter.length > 0) return;
    this.offArbiter.push(arb.onUp(() => void this.onArbiterUp()));
    this.offArbiter.push(arb.onPrimary((primary, epoch) => this.onRegistryPrimary(primary, epoch)));
  }

  /** Listens `claim_wait_ms` for a live primary before taking the role: a returning primary yields to the one that took over. */
  private async claim(): Promise<void> {
    const wait = this.deps.config.nodes.claim_wait_ms;
    this.log.info("claiming the primary role", { waitMs: wait, epoch: this.role.epoch });
    const deadline = this.now() + wait;
    this.query();
    // The registry's last primary and backups are asked directly, since a broadcast may not reach them.
    const endpoints = [...(this.registry.primary()?.endpoints ?? []), ...this.registry.backups().flatMap((b) => b.endpoints)];
    void Promise.all(endpoints.map((e) => this.outbound.probe(e).then((a) => this.heardPrimary({ endpoint: a.role === "primary" ? e : (a.primary ?? e), nodeId: a.nodeId, epoch: a.epoch, heardAt: this.now() })).catch(() => undefined)));
    while (this.now() < deadline && this.role.state === "claiming") await Bun.sleep(Math.min(100, Math.max(1, deadline - this.now())));
    if (this.role.state !== "claiming") return;
    // Signed in: the registry may hold the role elsewhere, so the link is given a moment to come up before the LAN's answer stands.
    if (this.deps.signedIn?.() && this.deps.config.nodes.relay && this.arbiter()) {
      const linkDeadline = this.now() + this.deps.config.cloud.hello_timeout_ms;
      while (this.now() < linkDeadline && this.role.state === "claiming" && !this.arbiter()!.ready()) await Bun.sleep(Math.min(100, Math.max(1, linkDeadline - this.now())));
      if (this.role.state !== "claiming") return;
      if (this.arbiterActive()) {
        const granted = await this.claimAtRegistry(this.role.epoch);
        if (this.role.state !== "claiming") return;
        if (!granted) return;
      } else this.log.info("the registry could not be asked; the LAN's answer stands", { link: this.arbiter()!.ready() ? "up, no relay on the plan" : "down" });
    }
    this.becomePrimary({ initial: true });
  }

  /**
   * Asks the registry for the role at `epoch`. Granted, the answered epoch is taken and
   * true returned; refused, this node becomes a backup seeking the holder (the relay first
   * when the holder has no endpoint we know) and false is returned. A failed request counts
   * as a grant withheld only when the caller says so: the LAN rules stand otherwise.
   */
  private async claimAtRegistry(epoch: number): Promise<boolean> {
    const arb = this.arbiter()!;
    let answer: Awaited<ReturnType<Arbiter["claim"]>>;
    try {
      answer = await arb.claim(epoch);
    } catch (e) {
      this.log.warn("the registry did not answer the claim; the LAN's answer stands", { error: e instanceof Error ? e.message : String(e) });
      return true;
    }
    if (answer.granted) {
      if (answer.epoch !== undefined) this.role.setEpoch(answer.epoch);
      this.log.info("the registry granted the primary role", { epoch: this.role.epoch });
      return true;
    }
    this.log.warn("the registry refused the primary role; another node holds it", { holder: answer.primary, epoch: answer.epoch, mine: epoch });
    if (answer.epoch !== undefined) this.role.setEpoch(answer.epoch);
    this.deps.store.meta.set("epoch", String(this.role.epoch));
    this.role.configuredBackup = true;
    if (answer.primary) this.aimAt(answer.primary, answer.epoch);
    if (this.role.state !== "seeking") this.role.go("seeking");
    this.startSeeking();
    return false;
  }

  /** Points the next seek at a node the registry named: the relay first (the server knows it, so it is likely on another network), its LAN endpoints after. */
  private aimAt(node: string, epoch?: number): void {
    const endpoints = this.registry.endpointsOf(node);
    this.preferred = endpoints[0];
    this.preferRelay = true;
    for (const e of endpoints) this.heard.unshift({ endpoint: e, nodeId: node, ...(epoch !== undefined ? { epoch } : {}), heardAt: this.now() });
  }

  /** The link came up with the plan known: this node registers, and the answer reconciles the role. */
  private async onArbiterUp(): Promise<void> {
    if (this.stopped || !this.arbiterActive()) return;
    void this.ensureRelayToken();
    const arb = this.arbiter()!;
    let answer: Awaited<ReturnType<Arbiter["register"]>>;
    try {
      answer = await arb.register(this.self(), this.role.epoch);
    } catch (e) {
      this.log.warn("registry.register failed", { error: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (this.stopped) return;
    const me = this.deps.identity.id;
    if (answer.primary && this.isHands(answer.primary)) {
      this.log.warn("the registry names a hands node as the primary; ignored", { node: answer.primary });
      return;
    }
    switch (this.role.state) {
      case "primary":
        if (answer.primary === me) {
          if (answer.epoch !== undefined) this.role.setEpoch(answer.epoch);
          this.startRegistryHeartbeat();
        } else if (answer.primary) {
          this.log.warn("the registry holds the primary role elsewhere; stepping down", { holder: answer.primary, epoch: answer.epoch });
          void this.stepDown(answer.primary, this.registry.endpointsOf(answer.primary), answer.epoch ?? this.role.epoch + 1, true);
        }
        return;
      case "seeking":
      case "waiting":
        if (answer.primary && answer.primary !== me) {
          this.aimAt(answer.primary, answer.epoch);
          if (this.role.state === "waiting") {
            this.clearTimers();
            this.role.go("seeking");
            this.startSeeking();
          } else this.kickSeek();
        } else if (this.role.state === "seeking") this.kickSeek();
        return;
      default:
        return;
    }
  }

  /** A grant went to another node: a primary of a lower epoch steps down to it; a seeker aims at it. */
  private onRegistryPrimary(primary: string, epoch: number): void {
    if (this.stopped) return;
    if (this.isHands(primary)) {
      this.log.warn("the registry names a hands node as the primary; ignored", { node: primary, epoch });
      return;
    }
    const me = this.deps.identity.id;
    if (primary === me) {
      if (this.role.role === "primary") this.role.setEpoch(epoch);
      return;
    }
    switch (this.role.state) {
      case "primary":
        if (primary === this.handingOver) return;
        if (epoch > this.role.epoch) {
          this.log.warn("the registry granted the primary role to another node; stepping down", { holder: primary, epoch });
          void this.stepDown(primary, this.registry.endpointsOf(primary), epoch, true);
        }
        return;
      case "waiting":
        this.aimAt(primary, epoch);
        this.clearTimers();
        this.role.go("seeking");
        this.startSeeking();
        return;
      case "seeking":
        this.aimAt(primary, epoch);
        if (!this.seeker.seeking) this.kickSeek();
        return;
      default:
        return;
    }
  }

  /** While primary and granted: the lease renewed every `registry_heartbeat_ms`; an answer naming another holder steps down. */
  private startRegistryHeartbeat(): void {
    this.stopRegistryHeartbeat();
    const tick = () => {
      this.registryTimer = undefined;
      if (this.stopped || this.role.state !== "primary" || !this.arbiterActive()) return;
      void this.arbiter()!
        .heartbeat()
        .then((a) => {
          if (this.stopped || this.role.state !== "primary") return;
          if (a.primary && a.primary !== this.deps.identity.id && a.primary !== this.handingOver) {
            this.log.warn("the registry names another primary; stepping down", { holder: a.primary, epoch: a.epoch });
            void this.stepDown(a.primary, this.registry.endpointsOf(a.primary), a.epoch ?? this.role.epoch + 1, true);
            return;
          }
          this.arm();
        })
        .catch((e: unknown) => {
          this.log.debug("registry heartbeat failed", { error: e instanceof Error ? e.message : String(e) });
          this.arm();
        });
    };
    const arm = () => {
      if (this.registryTimer) clearTimeout(this.registryTimer);
      this.registryTimer = setTimeout(tick, this.deps.config.nodes.registry_heartbeat_ms);
      if (typeof this.registryTimer === "object" && "unref" in this.registryTimer) this.registryTimer.unref();
    };
    this.arm = arm;
    arm();
  }

  private arm: () => void = () => undefined;

  private stopRegistryHeartbeat(): void {
    if (this.registryTimer) clearTimeout(this.registryTimer);
    this.registryTimer = undefined;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    this.stopMembershipClock();
    this.stopRegistryHeartbeat();
    for (const off of this.offArbiter) off();
    this.offArbiter = [];
    for (const off of this.offBus) off();
    this.offBus = [];
    if (this.role.role === "primary") this.inbound.leaveAll("stopping");
    else this.outbound.leave("stopping");
    this.inbound.closeAll();
    this.replicator.stop();
    this.replica?.dispose();
    this.discovery?.close();
    this.discovery = undefined;
    if (this.role.state !== "stopped") this.role.go("stopped");
  }

  private clearTimers(): void {
    for (const t of [this.beaconTimer, this.queryTimer, this.waitTimer]) if (t) clearTimeout(t);
    this.beaconTimer = this.queryTimer = this.waitTimer = undefined;
    this.seeker.clearTimer();
  }

  private announce(): void {
    this.deps.bus.emit("node.state", this.self());
  }

  /** Closes this node's own clients so they reconnect into the new mode; `after` the current request is answered, when one caused it. */
  private closeOwnClients(reason: string, after = false): void {
    const close = () => {
      const n = this.deps.clients.closeOn(CLOSE_ROLE_CHANGED, reason, ["loopback", "controller", "cloud", "p2p"]);
      if (n > 0) this.log.info("clients closed to reconnect", { reason, count: n });
    };
    if (!after) {
      close();
      return;
    }
    const t = setTimeout(close, 0);
    if (typeof t === "object" && "unref" in t) t.unref();
  }

  // --- primary --------------------------------------------------------------------------------------

  private becomePrimary(opts: { initial: boolean }): void {
    if (!this.membership) this.foundCluster();
    else this.deps.grants.setCluster(this.membership.cluster);
    if (this.role.state !== "primary") this.role.go("primary");
    this.replicator.start();
    this.startBeacon();
    // granted by the registry (the claim came through it): the lease is renewed from now on
    if (this.arbiterActive()) {
      this.startRegistryHeartbeat();
      void this.ensureRelayToken();
    }
    this.deps.store.meta.set("epoch", String(this.role.epoch));
    this.log.info("primary", { epoch: this.role.epoch, initial: opts.initial, endpoints: this.selfEndpoints() });
    this.deps.onRole?.(true);
    if (!opts.initial) this.announce();
  }

  /**
   * This node takes the role at `epoch`: after a failover wait, or handed over by the
   * primary. With the registry reachable the role is claimed there first: a failover asks
   * at this node's own epoch (the server lands a new holder above the old one's), a
   * takeover at the epoch the primary handed over. Refused, a failover seeks the holder and
   * a takeover answers `conflict` to the primary that asked.
   */
  private async promoteSelf(epoch: number, cause: "failover" | "takeover"): Promise<void> {
    if (this.role.role === "primary") return;
    if (this.arbiterActive()) {
      const arb = this.arbiter()!;
      let answer: Awaited<ReturnType<Arbiter["claim"]>>;
      try {
        answer = await arb.claim(cause === "takeover" ? epoch : this.role.epoch);
      } catch (e) {
        if (cause === "takeover") throw new RpcError("unavailable", `the registry did not answer the claim: ${e instanceof Error ? e.message : String(e)}`, { provider: "server" });
        this.log.warn("the registry did not answer the failover claim; waiting again", { error: e instanceof Error ? e.message : String(e) });
        if (this.role.state === "waiting") this.startWaiting();
        return;
      }
      if (!answer.granted) {
        this.log.warn("the registry refused the promotion; another node holds the role", { holder: answer.primary, epoch: answer.epoch, cause });
        if (answer.epoch !== undefined) this.role.setEpoch(answer.epoch);
        if (cause === "takeover") throw new RpcError("conflict", `the registry holds the primary role at ${answer.primary ?? "another node"}`);
        this.clearTimers();
        if (answer.primary) this.aimAt(answer.primary, answer.epoch);
        if (this.role.state !== "seeking") this.role.go("seeking");
        this.startSeeking();
        return;
      }
      if (answer.epoch !== undefined) epoch = Math.max(epoch, answer.epoch);
      this.log.info("the registry granted the promotion", { epoch, cause });
    }
    this.clearTimers();
    this.seeker.abandon();
    this.role.setEpoch(epoch);
    this.role.go("promoting");
    this.log.warn("promoting to primary", { epoch: this.role.epoch, cause });
    if (cause === "failover") this.outbound.close("promoting");
    this.replica?.dispose();
    this.replica = undefined;
    this.deps.store.meta.set("epoch", String(this.role.epoch));
    // Tasks parked on asks that were open on the old primary have nothing to wait for here.
    const released = this.deps.tasks.releaseUnknownAsks((id) => this.deps.asks.get(id)?.status === "open");
    if (released > 0) this.log.info("tasks released from asks that went with the old primary", { count: released });
    this.becomePrimary({ initial: false });
    await this.deps.startBrain();
    this.deps.scheduler.start();
    await this.deps.editable.rescan();
    this.closeOwnClients("promoted to primary");
    this.announce();
  }

  /** The node this primary is handing the role to, while the takeover is in flight. */
  private handingOver?: string;

  /** The user hands the role to a linked backup: it takes the next epoch, then this node steps down to it. */
  async promote(id: string): Promise<void> {
    if (this.role.role !== "primary") throw new RpcError("conflict", "only the primary can hand the role over");
    if (id === this.deps.identity.id) throw new RpcError("invalid", "this node is the primary already");
    const peer = this.inbound.peer(id);
    if (!peer?.open) throw new RpcError("not_found", `node ${id} is not linked`);
    if (!peer.info.backup) throw new RpcError("conflict", `node ${id} is not a backup`);
    const epoch = this.role.epoch + 1;
    // The backup announces its new epoch the moment it has it; that beacon is not a rival, it is the answer on its way.
    this.handingOver = id;
    try {
      await peer.request("node.takeover", { epoch }, { timeoutMs: 30_000 });
    } catch (e) {
      // The answer was lost to the step-down it caused: the role is where the user wanted it.
      if (this.role.role !== "primary") return;
      throw e;
    } finally {
      this.handingOver = undefined;
    }
    await this.stepDown(id, peer.info.endpoints, epoch);
  }

  /** A higher-epoch primary is live, or the user chose another: this node becomes a backup of it; `viaRegistry` when the server named it, so the relay is tried first. */
  private async stepDown(to: string, endpoints: string[], epoch: number, viaRegistry = false): Promise<void> {
    if (this.role.role !== "primary") return;
    this.role.go("stepping_down");
    this.log.warn("stepping down", { to, epoch, endpoints: endpoints.length > 0 ? endpoints : "relay" });
    this.stopBeacon();
    this.stopRegistryHeartbeat();
    this.role.setEpoch(epoch);
    this.deps.store.meta.set("epoch", String(this.role.epoch));
    await this.deps.stopBrain();
    this.deps.scheduler.stop();
    this.replicator.stop();
    this.deps.onRole?.(false);
    await this.deps.editable.rescan();
    this.inbound.leaveAll("stepdown", to);
    this.role.configuredBackup = true;
    this.role.go("seeking");
    this.preferred = endpoints[0];
    this.preferRelay = viaRegistry || endpoints.length === 0;
    for (const e of endpoints) this.heard.unshift({ endpoint: e, nodeId: to, epoch, heardAt: this.now() });
    this.closeOwnClients("stepped down", true);
    this.announce();
    this.startSeeking();
  }

  // --- secondary ------------------------------------------------------------------------------------

  private startSeeking(): void {
    if (this.stopped) return;
    if (this.role.state !== "seeking") this.role.go("seeking");
    this.startQueries();
    this.kickSeek();
  }

  /** Runs one round of attempts now, then again after the backoff while still seeking. */
  private kickSeek(): void {
    this.seeker.kick();
  }

  /** The LAN endpoints to try, in order. */
  private endpointCandidates(): string[] {
    return endpointCandidates(this.candidateSources());
  }

  private candidateSources(): CandidateSources {
    return {
      ...(this.preferred !== undefined ? { preferred: this.preferred } : {}),
      ...(this.deps.config.nodes.primary !== undefined ? { configured: this.deps.config.nodes.primary } : {}),
      membership: this.membership?.endpoints ?? [],
      heard: this.heard,
      registryPrimary: this.registry.primary()?.endpoints ?? [],
      registryBackups: this.registry.backups().map((b) => b.endpoints),
      self: this.selfEndpoints(),
    };
  }

  /**
   * Every way to the primary, in order: the LAN endpoints, then the relay when this node's
   * grant has a relay token (the server sends it to whichever node holds the role); the
   * relay first after a step-down to a node with no endpoint.
   */
  private candidates(): LinkTarget[] {
    const m = this.membership;
    const relay = m?.relay;
    const target: LinkTarget | undefined =
      m && relay && this.deps.config.nodes.relay
        ? { kind: "relay", open: () => openRelayLink({ url: relay.url, token: relay.token, peer: m.grant, psk: pskFromHex(m.key), kind: "node", timeoutMs: this.deps.config.nodes.hello_timeout_ms }) }
        : undefined;
    return linkCandidates({ ...this.candidateSources(), ...(target ? { relay: target, relayFirst: this.preferRelay } : {}) });
  }

  /**
   * A round found no primary. A backup asks the registry at its own epoch (granted only once
   * the holder's lease lapsed) and takes the role when granted; the network is asked again.
   */
  private async missed(): Promise<boolean> {
    if (this.role.backup && this.arbiterActive()) {
      const arb = this.arbiter()!;
      try {
        const answer = await arb.claim(this.role.epoch);
        if (this.role.state !== "seeking" || this.stopped) return true;
        if (answer.granted) {
          this.log.warn("no primary reachable and the registry's lease lapsed: taking the role", { epoch: answer.epoch });
          void this.promoteGranted(answer.epoch ?? this.role.epoch + 1);
          return true;
        }
        if (answer.primary) this.aimAt(answer.primary, answer.epoch);
      } catch (e) {
        this.log.debug("registry claim after a fruitless seek failed", { error: e instanceof Error ? e.message : String(e) });
      }
    }
    this.query();
    return false;
  }

  /** A grant the registry gave a seeking backup: the role, taken without a second claim. */
  private async promoteGranted(epoch: number): Promise<void> {
    this.clearTimers();
    this.seeker.abandon();
    this.role.setEpoch(epoch);
    this.role.go("promoting");
    this.log.warn("promoting to primary", { epoch: this.role.epoch, cause: "registry" });
    this.replica?.dispose();
    this.replica = undefined;
    this.deps.store.meta.set("epoch", String(this.role.epoch));
    const released = this.deps.tasks.releaseUnknownAsks((id) => this.deps.asks.get(id)?.status === "open");
    if (released > 0) this.log.info("tasks released from asks that went with the old primary", { count: released });
    this.becomePrimary({ initial: false });
    await this.deps.startBrain();
    this.deps.scheduler.start();
    await this.deps.editable.rescan();
    this.closeOwnClients("promoted to primary");
    this.announce();
  }

  private onLinked(primary: string, epoch: number, via: Via): void {
    this.clearTimers();
    this.lostVia = via;
    this.role.setEpoch(epoch);
    this.deps.store.meta.set("epoch", String(this.role.epoch));
    const row = this.registry.get(primary);
    if (row) this.deps.store.meta.set("last_primary", JSON.stringify({ id: primary, epoch, endpoints: row.endpoints }));
    if (this.role.state !== "linked") this.role.go("linked");
    if (this.role.backup) {
      this.replica = new Replica({
        store: this.deps.store,
        paths: this.deps.paths,
        selfNode: this.deps.identity.id,
        rescan: () => this.deps.editable.rescan(),
        fetchSnapshot: () => this.outbound.fetchSnapshot(),
        ...(this.deps.onGrantsChanged ? { onGrantsChanged: this.deps.onGrantsChanged } : {}),
        log: this.log.child("replica"),
      });
      void this.replica.sync().catch((e: unknown) => this.log.warn("replica snapshot failed", { error: e instanceof Error ? e.message : String(e) }));
    }
    // This node's own clients reconnect, to be relayed to the primary from now on.
    this.closeOwnClients("linked to the primary");
    this.announce();
  }

  private onLost(reason: string): void {
    if (this.stopped || this.role.role === "primary") return;
    const primary = this.outbound.primaryId ?? this.registry.primary()?.id;
    if (primary) this.registry.markOffline(primary);
    this.replica?.dispose();
    this.replica = undefined;
    if (this.role.state === "linked") {
      if (this.role.backup) this.startWaiting();
      else this.startSeeking();
    }
    this.announce();
    void reason;
  }

  /** The primary said it is going: to `primary` if it named one, else whoever answers. */
  private onPrimaryLeaving(reason: LinkLeaveReason, primary?: string): void {
    if (reason === "revoked") {
      this.forget("the primary ended this node's grant");
      return;
    }
    if (reason === "stepdown" && primary === this.deps.identity.id) return;
    if (primary) {
      this.preferred = this.registry.endpointsOf(primary)[0];
      this.role.configuredBackup = this.role.backup;
    }
  }

  /** A backup without a primary: counts down `failover_ms` times its rank, still listening for one. */
  private startWaiting(): void {
    if (this.role.state !== "waiting") this.role.go("waiting");
    const wait = this.deps.config.nodes.failover_ms * this.deps.config.node.backup_rank;
    this.log.warn("primary lost; waiting before promotion", { waitMs: wait, rank: this.deps.config.node.backup_rank, via: this.lostVia ?? "direct" });
    this.startQueries();
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = setTimeout(() => {
      this.waitTimer = undefined;
      if (this.role.state !== "waiting" || this.stopped) return;
      // A link that ran through a tunnel says nothing about the primary's health once the server is out of reach: keep waiting.
      if (!mayPromote({ lostVia: this.lostVia, arbiterActive: this.arbiterActive() })) {
        this.log.warn("the primary was linked through the relay and the registry cannot be asked; waiting on", { waitMs: wait });
        this.startWaiting();
        return;
      }
      void this.promoteSelf(this.role.epoch + 1, "failover");
    }, wait);
    if (typeof this.waitTimer === "object" && "unref" in this.waitTimer) this.waitTimer.unref();
    // Known endpoints are asked directly too: a primary that came back may not have beaconed yet.
    void this.probeKnown();
  }

  private async probeKnown(): Promise<void> {
    for (const e of this.endpointCandidates()) {
      if (this.role.state !== "waiting") return;
      try {
        const a = await this.outbound.probe(e);
        if (a.role === "primary") this.heardPrimary({ endpoint: e, nodeId: a.nodeId, epoch: a.epoch, heardAt: this.now() });
        else if (a.primary) this.heardPrimary({ endpoint: a.primary, nodeId: undefined, epoch: a.epoch, heardAt: this.now() });
      } catch {
        // not there
      }
    }
  }

  /** A primary announced itself: by beacon, by an answer, or by a probe. */
  private heardPrimary(c: Candidate): void {
    if (c.nodeId === this.deps.identity.id) return;
    this.heard = [c, ...this.heard.filter((h) => h.endpoint !== c.endpoint)].slice(0, 8);
    const mine = this.role.epoch;
    switch (this.role.state) {
      case "claiming": {
        const theirs = c.epoch ?? 0;
        const yields = theirs > mine || (theirs === mine && c.nodeId !== undefined && c.nodeId < this.deps.identity.id);
        if (!yields) return;
        this.log.warn("a live primary answered; this node joins it as a backup", { endpoint: c.endpoint, node: c.nodeId, epoch: theirs, mine });
        this.role.configuredBackup = true;
        this.preferred = c.endpoint;
        this.role.go("seeking");
        this.startSeeking();
        return;
      }
      case "primary": {
        if (c.nodeId === this.handingOver) return;
        if ((c.epoch ?? 0) > mine && c.nodeId) {
          this.log.warn("a primary of a higher epoch is live; stepping down to it", { endpoint: c.endpoint, node: c.nodeId, epoch: c.epoch });
          void this.stepDown(c.nodeId, [c.endpoint], c.epoch!);
        }
        return;
      }
      case "waiting": {
        this.preferred = c.endpoint;
        this.clearTimers();
        this.role.go("seeking");
        this.startSeeking();
        return;
      }
      case "seeking": {
        if (!this.seeker.seeking) {
          this.preferred = c.endpoint;
          this.kickSeek();
        }
        return;
      }
      default:
        return;
    }
  }

  // --- membership --------------------------------------------------------------------------------

  private confined?: { key: string; value: Confinement };

  /**
   * The folders this node shares with its primary: the join's, or `[node.scope]`'s
   * workspaces; none on a primary, or when the owner named none. Resolved once per list.
   */
  confinement(): Confinement | undefined {
    if (this.role.role === "primary" || !this.membership) return undefined;
    const scope = this.deps.config.node.scope;
    const paths = this.membership.paths ?? (scope.kind === "workspaces" ? scope.paths : undefined);
    if (!paths || paths.length === 0) return undefined;
    const key = JSON.stringify(paths);
    if (this.confined?.key !== key) this.confined = { key, value: new Confinement(paths) };
    return this.confined.value;
  }

  /** This node's membership as the status line and the tests read it: no key. */
  member(): { grant: string; cluster: string; role: GrantRole; via: "self" | "join"; primary?: { id: string; name: string }; expiresAt?: number } | undefined {
    const m = this.membership;
    if (!m) return undefined;
    return { grant: m.grant, cluster: m.cluster, role: m.role, via: m.via, ...(m.primary ? { primary: m.primary } : {}), ...(m.expiresAt !== undefined ? { expiresAt: m.expiresAt } : {}) };
  }

  /**
   * The key a link naming `grant` is sealed with, when the grant may link here now: a node
   * grant that was redeemed, has not ended and is bound to a node other than this one; or,
   * for `enroll`, a node grant whose invite is still open, keyed from the invite's secret.
   */
  private credential(id: string, kind: SealedKind): LinkCredential | undefined {
    const grants = this.deps.grants;
    if (kind === "enroll") {
      const row = grants.pending(id);
      if (!row?.invite || row.kind !== "node") return undefined;
      return { grant: row, kind, psk: pskFromHex(row.invite.secretHash) };
    }
    const row = grants.get(id);
    if (!row || row.kind !== "node" || grants.status(row) !== "active" || grants.expired(row) || !row.key || !row.node) return undefined;
    if (row.node === this.deps.identity.id) return undefined;
    return { grant: row, kind, psk: pskFromHex(row.key) };
  }

  /**
   * A node link the server relays here: a grant's own peer, or an invite's throwaway peer,
   * which is sealed as an enrollment. Taken while this node is the primary alone.
   */
  relayedLink(peer: string): NodeTunnel {
    if (this.stopped || this.role.role !== "primary" || !this.membership) throw new RpcError("denied", "this node is not the primary");
    let cred = this.credential(peer, "node");
    if (!cred) {
      const invite = this.deps.grants.byInvitePeer(peer);
      if (invite) cred = this.credential(invite.id, "enroll");
    }
    if (!cred) throw new RpcError("denied", "no grant of this node may link as that peer");
    const c = cred;
    return { kind: c.kind, psk: c.psk, accept: (sock) => this.inbound.acceptSealed(c, sock) };
  }

  /** This node starts a cluster of its own: its id, a full grant for itself, and the file that keeps them. */
  private foundCluster(): void {
    const grants = this.deps.grants;
    const cluster = grants.cluster(true)!;
    const self = grants.ensureSelf(this.deps.identity.id, this.deps.identity.name);
    const file: LinkFile = { v: 1, grant: self.id, key: self.key!, cluster, role: "full", via: "self" };
    writeLinkFile(this.deps.paths.linkFile, file);
    this.membership = file;
    this.log.info("a cluster of its own", { cluster, grant: self.id });
  }

  /** How long a link's handshake may take, the enrollment's too. */
  private get helloTimeoutMs(): number {
    return this.deps.config.nodes.hello_timeout_ms;
  }

  /**
   * Mints a node invite: a pending grant and the text that redeems it, naming this node's LAN
   * listener and, when the server can grant one, a throwaway relay peer. The primary alone.
   */
  async invite(opts: { name: string; role: GrantRole; expiresIn?: number; inviteExpiresIn?: number }): Promise<{ grant: Grant; invite: InviteOffer }> {
    if (this.role.role !== "primary" || !this.membership) throw new RpcError("conflict", "only the primary invites a node");
    const now = this.now();
    const inviteExpiresAt = now + (opts.inviteExpiresIn ?? DEFAULT_INVITE_MS);
    const expiresAt = opts.expiresIn !== undefined ? now + opts.expiresIn : undefined;
    const port = this.deps.lanPort();
    const spki = this.deps.lanSpki?.();
    const ips = this.deps.lanIps();
    const hosts = [...ips.filter((ip) => ip !== "127.0.0.1"), ...ips.filter((ip) => ip === "127.0.0.1")];
    const lan = port !== undefined && spki !== undefined && hosts.length > 0 ? { hosts, port, spki } : undefined;
    let relay: InviteBody["relay"];
    if (this.deps.relayGrant && this.deps.config.nodes.relay) {
      const peer = newId("grant", now);
      try {
        const r = await this.deps.relayGrant(peer, { kind: "node", name: `invite for ${opts.name}`, expiresAt: inviteExpiresAt });
        relay = { url: r.url, peer, token: r.token };
      } catch (e) {
        this.log.debug("no relay for the invite", { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (!lan && !relay) throw new RpcError("unavailable", "no way in for a new node: turn on [nodes] accept for the LAN listener, or sign in for the relay");
    const { row, secret } = this.deps.grants.mint({ kind: "node", name: opts.name, access: FULL, role: opts.role, ...(expiresAt !== undefined ? { expiresAt } : {}), inviteExpiresAt, ...(relay ? { invitePeer: relay.peer } : {}) });
    const body: InviteBody = { v: 1, kind: "node", grant: row.id, secret, expiresAt: inviteExpiresAt, node: { id: this.deps.identity.id, name: this.deps.identity.name }, ...(lan ? { lan } : {}), ...(relay ? { relay } : {}) };
    this.log.info("node invited", { grant: row.id, name: opts.name, role: opts.role, lan: lan !== undefined, relay: relay !== undefined, inviteExpiresAt, ...(expiresAt !== undefined ? { expiresAt } : {}) });
    return { grant: this.deps.grants.entity(row), invite: { text: inviteText(body), link: inviteLink(body), expiresAt: inviteExpiresAt } };
  }

  /** `node.enroll`, the primary's side: the grant bound, its key, the cluster, and the ways back here. */
  private async enroll(grant: GrantRow, node: { id: string; name: string }, account?: string): Promise<EnrollResult> {
    const m = this.membership;
    if (this.role.role !== "primary" || !m) throw new RpcError("conflict", "only the primary redeems an invite");
    // A machine signed in to this account could take the role at the server's registry: it is no guest.
    const own = this.deps.account?.();
    if (grant.role === "hands" && own !== undefined && account === own) throw new RpcError("denied", "a machine signed in to this node's own account joins as a full node, not hands");
    // Checked and spent in one step, with nothing awaited between: a second redemption finds it gone.
    const { row, key } = this.deps.grants.enrollNode(grant.id, node.id, this.deps.identity.id);
    let relay: EnrollResult["relay"];
    if (this.deps.relayGrant && this.deps.config.nodes.relay) {
      try {
        relay = await this.deps.relayGrant(row.id, { kind: "node", name: row.name, ...(row.expiresAt !== undefined ? { expiresAt: row.expiresAt } : {}) });
        this.deps.grants.setRelay(row.id, true);
      } catch (e) {
        this.log.debug("no relay for the enrolled node", { grant: row.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const endpoints = this.selfEndpoints();
    const spki = this.deps.lanSpki?.();
    return {
      grant: row.id,
      key,
      cluster: m.cluster,
      primary: { id: this.deps.identity.id, name: this.deps.identity.name },
      role: row.role ?? "full",
      ...(row.expiresAt !== undefined ? { expiresAt: row.expiresAt } : {}),
      ...(endpoints.length > 0 && spki !== undefined ? { lan: { endpoints, spki } } : {}),
      ...(relay ? { relay } : {}),
    };
  }

  /**
   * A signed-in node whose grant holds no relay token asks its own account for one: the
   * cluster's first primary, whose grant was never enrolled, and a node that joined while
   * the primary could not grant it. The server sends the grant's tunnels to whichever node
   * holds the role on the account, which only a node of this cluster can answer.
   */
  private async ensureRelayToken(): Promise<void> {
    const m = this.membership;
    if (!m || m.relay || !this.deps.relayGrant || !this.deps.config.nodes.relay) return;
    try {
      const relay = await this.deps.relayGrant(m.grant, { kind: "node", name: this.deps.identity.name, ...(m.expiresAt !== undefined ? { expiresAt: m.expiresAt } : {}) });
      const now = this.membership;
      if (!now || now.grant !== m.grant || now.relay) return;
      this.membership = { ...now, relay };
      writeLinkFile(this.deps.paths.linkFile, this.membership);
      this.log.info("a relay token for this node's grant", { grant: m.grant });
    } catch (e) {
      this.log.debug("no relay token for this node's grant", { grant: m.grant, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** An invite's link closed: once redeemed, its throwaway relay peer is let go. */
  private onEnrollClosed(grant: GrantRow): void {
    const peer = grant.invite?.peer;
    if (!peer || this.deps.grants.pending(grant.id)) return;
    void this.deps.revokeRelay?.(peer);
  }

  /** Whether this node may join a cluster now: in none, or alone in one of its own. */
  private mayJoin(): void {
    if (this.stopped) throw new RpcError("unavailable", "this node is stopping");
    const m = this.membership;
    if (!m) return;
    const alone = m.via === "self" && this.inbound.linkedIds().length === 0 && this.deps.grants.rows().every((r) => r.kind !== "node" || r.node === this.deps.identity.id);
    if (alone) return;
    throw new RpcError("conflict", m.via === "self" ? "this node is the primary of a cluster with other nodes, or open invites, in it" : "this node is in a cluster already: leave it first");
  }

  /**
   * Redeems a node invite and joins the primary that minted it. A node alone in a cluster of
   * its own gives that cluster up first (the role, if it held it); `paths` and `answerHere`
   * are kept for what the primary may reach here.
   */
  async join(text: string, opts: { paths?: string[]; answerHere?: boolean } = {}): Promise<{ primary: { id: string; name: string }; role: GrantRole }> {
    let body: InviteBody;
    try {
      body = parseInvite(text);
    } catch (e) {
      throw new RpcError("invalid", e instanceof Error ? e.message : String(e));
    }
    this.mayJoin();
    if (this.joining) throw new RpcError("conflict", "a join is in flight");
    if (this.deps.guests?.()?.knows(body.node.id)) throw new RpcError("conflict", "that invite is from a cluster a workspace node here is in: the machine joins a cluster of its own");
    // The folders to share must be there, and absolute, before anything is redeemed.
    const paths = (opts.paths ?? []).map((p) => resolvePath(p));
    for (const p of paths) {
      if (!existsSync(p) || !statSync(p).isDirectory()) throw new RpcError("invalid", `no folder ${p} to share`);
    }
    this.joining = true;
    try {
      const account = this.deps.account?.();
      const answer = await redeemNodeInvite(body, { id: this.deps.identity.id, name: this.deps.identity.name }, { timeoutMs: this.helloTimeoutMs, log: this.log.child("enroll"), now: this.now(), ...(account !== undefined ? { account } : {}) });
      this.mayJoin();
      if (this.deps.guests?.()?.clusters().includes(answer.cluster)) throw new RpcError("conflict", "a workspace node here is in that cluster: the machine joins a cluster of its own");
      if (this.role.role === "primary") await this.abdicate("joined another primary");
      this.deps.grants.forgetCluster();
      const file: LinkFile = {
        v: 1,
        grant: answer.grant,
        key: answer.key,
        cluster: answer.cluster,
        role: answer.role,
        via: "join",
        primary: answer.primary,
        ...(answer.lan ? { endpoints: answer.lan.endpoints } : {}),
        ...(answer.relay ? { relay: answer.relay } : {}),
        ...(answer.expiresAt !== undefined ? { expiresAt: answer.expiresAt } : {}),
        ...(paths.length > 0 ? { paths } : {}),
        ...(opts.answerHere ? { answerHere: true } : {}),
      };
      writeLinkFile(this.deps.paths.linkFile, file);
      this.membership = file;
      this.role.hands = file.role === "hands";
      // the folders shared are this node's workspaces, so the primary has somewhere to start a session
      if (paths.length > 0) this.deps.workspaces.fromScope({ kind: "workspaces", paths });
      this.log.info("joined a cluster", { primary: answer.primary.id, name: answer.primary.name, grant: answer.grant, role: answer.role, via: answer.via, relay: answer.relay !== undefined });
      if (this.deps.config.nodes.discovery && !this.discovery) await this.openDiscovery();
      if (!this.role.hands) this.watchArbiter();
      this.armMembershipClock();
      // `[nodes] primary` still comes first; the endpoints the enrollment gave follow it.
      this.preferRelay = file.endpoints === undefined && file.relay !== undefined;
      this.seeker.resetBackoff();
      this.startSeeking();
      this.announce();
      return { primary: answer.primary, role: answer.role };
    } finally {
      this.joining = false;
    }
  }

  /** A primary alone in its cluster gives the role up to join another: the brain and the scheduler stop, its clients reconnect. */
  private async abdicate(reason: string): Promise<void> {
    this.role.go("stepping_down");
    this.log.info("giving up the primary role", { reason });
    this.stopBeacon();
    this.stopRegistryHeartbeat();
    // The registry's signals were this cluster's: a node joining as hands must not hear them.
    for (const off of this.offArbiter) off();
    this.offArbiter = [];
    await this.deps.stopBrain();
    this.deps.scheduler.stop();
    this.replicator.stop();
    this.deps.onRole?.(false);
    await this.deps.editable.rescan();
    this.inbound.leaveAll("stopping");
    this.closeOwnClients(reason, true);
  }

  /**
   * Ends a node grant, revoked by the user or run out: the node hears it inside its link and
   * the link closes, the grant's relay peers go, and the node, if one was bound, is forgotten
   * here. A pending grant's invite is dead with it. A full node that took the replica took
   * every other node's key with it: the others are re-keyed.
   */
  async revoke(id: string, why: "revoked" | "expired" | "invite expired" = "revoked"): Promise<void> {
    const row = this.deps.grants.get(id);
    if (!row || row.kind !== "node") throw new RpcError("not_found", `no node grant ${id}`);
    if (row.node === this.deps.identity.id) throw new RpcError("conflict", "this node's own grant is not revoked");
    if (this.role.role !== "primary") throw new RpcError("conflict", "only the primary revokes a node's grant");
    this.deps.grants.revoke(id);
    const told = row.node ? this.inbound.revoked(row.node) : Promise.resolve();
    // The relay token goes once the node was told inside its link, or the server would cut the
    // link first and the node, never hearing why, would keep knocking; a node that never hears
    // does not hold the revoke up for long.
    if (row.relay) void Promise.race([told, Bun.sleep(REVOKE_TOLD_MS)]).then(() => this.deps.revokeRelay?.(id));
    if (row.invite?.peer) void this.deps.revokeRelay?.(row.invite.peer);
    this.log.info("node grant ended", { grant: id, name: row.name, node: row.node, why, pending: row.invite !== undefined });
    if (row.replica && row.role !== "hands") await this.rekeyAll(id);
  }

  /** A node left the cluster over its own link: its grant is given up, as a revoke would, and it is forgotten. */
  private onLeft(node: string, grant: string): void {
    const row = this.deps.grants.get(grant);
    if (!row || row.kind !== "node" || row.node !== node || this.role.role !== "primary") return;
    this.deps.grants.revoke(grant);
    this.inbound.revoked(node);
    if (row.relay) void this.deps.revokeRelay?.(grant);
    this.log.info("node left the cluster; its grant is gone", { grant, name: row.name, node });
    if (row.replica && row.role !== "hands") void this.rekeyAll(grant);
  }

  /**
   * A node that held the replica is gone, and every key in it with it: every other node grant
   * gets a new one. A linked node is handed its key inside its live link first; one that is
   * not linked, or does not take it, is marked to be invited again. This node's own grant
   * changes here and in its file.
   */
  private async rekeyAll(gone: string): Promise<void> {
    const grants = this.deps.grants;
    let handed = 0;
    let reinvite = 0;
    for (const row of grants.rows()) {
      if (row.kind !== "node" || row.id === gone || grants.status(row) !== "active" || !row.node) continue;
      if (row.node === this.deps.identity.id) {
        const key = grants.rekey(row.id);
        if (key && this.membership?.grant === row.id) {
          this.membership = { ...this.membership, key };
          writeLinkFile(this.deps.paths.linkFile, this.membership);
        }
        continue;
      }
      const key = freshSecret();
      if (await this.inbound.rekey(row.node, key, this.helloTimeoutMs)) {
        grants.rekey(row.id, key);
        handed++;
      } else {
        grants.markReinvite(row.id);
        reinvite++;
      }
    }
    this.log.warn("node grants re-keyed after a node that held the replica went", { gone, handed, reinvite });
  }

  /** The primary handed this node's grant a new key, inside the link: every link after this one is keyed from it. */
  private onRekey(key: string): void {
    const m = this.membership;
    if (!m) return;
    this.membership = { ...m, key };
    writeLinkFile(this.deps.paths.linkFile, this.membership);
    this.log.info("this node's grant has a new key", { grant: m.grant });
  }

  /**
   * This node leaves the cluster it joined: the primary hears it is for good and drops the
   * grant, the membership file goes, and this node runs alone, unlinked. Offline, the primary
   * keeps the grant until its user removes it.
   */
  async leave(): Promise<void> {
    const m = this.membership;
    if (!m) throw new RpcError("conflict", "this node is in no cluster");
    if (this.role.role === "primary" || this.role.is("promoting", "stepping_down")) throw new RpcError("conflict", "the primary cannot leave its cluster: hand the role to another node first");
    if (this.joining) throw new RpcError("conflict", "a join is in flight");
    // The link goes once the answer has left, since the client that asked may be relayed over it.
    this.forget("left the cluster", () => {
      const t = setTimeout(() => this.outbound.leave("left"), 0);
      if (typeof t === "object" && "unref" in t) t.unref();
    });
  }

  /**
   * This node's membership is over: it left, the primary said its grant ended, or the grant
   * ran out. Unlinked first, so the link's close is not taken for a primary lost; then the
   * link, the replica, discovery and the file go, and the cluster's grants with them.
   */
  private forget(why: string, closeLink: () => void = () => this.outbound.close(why)): void {
    const m = this.membership;
    if (!m || this.stopped) return;
    if (this.role.role === "primary" || this.role.is("promoting", "stepping_down")) {
      this.log.warn("this node's grant ended while it holds the primary role; it keeps the role", { why, grant: m.grant });
      return;
    }
    this.clearTimers();
    this.stopMembershipClock();
    this.seeker.abandon();
    this.role.go("unlinked");
    closeLink();
    this.replica?.dispose();
    this.replica = undefined;
    for (const off of this.offArbiter) off();
    this.offArbiter = [];
    this.discovery?.close();
    this.discovery = undefined;
    removeLinkFile(this.deps.paths.linkFile);
    this.membership = undefined;
    this.role.hands = false;
    const forgotten = this.deps.grants.forgetCluster();
    this.log.warn("this node is in no cluster now and runs alone", { why, cluster: m.cluster, grant: m.grant, forgotten });
    this.closeOwnClients(why, true);
    this.announce();
  }

  private membershipTimer?: ReturnType<typeof setTimeout>;

  /** A grant with an end: this node forgets the cluster when it comes, whether or not the primary says so. */
  private armMembershipClock(): void {
    this.stopMembershipClock();
    const end = this.membership?.expiresAt;
    if (end === undefined || this.stopped) return;
    this.membershipTimer = setTimeout(() => {
      this.membershipTimer = undefined;
      if (this.membership?.expiresAt === undefined) return;
      if (this.membership.expiresAt <= this.now()) this.forget("this node's grant ran out");
      else this.armMembershipClock();
    }, Math.min(Math.max(0, end - this.now()), 2 ** 31 - 1));
    if (typeof this.membershipTimer === "object" && "unref" in this.membershipTimer) this.membershipTimer.unref();
  }

  private stopMembershipClock(): void {
    if (this.membershipTimer) clearTimeout(this.membershipTimer);
    this.membershipTimer = undefined;
  }

  /** A node bound to a hands grant here: never followed as a primary, whatever the registry says. */
  private isHands(node: string): boolean {
    return this.deps.grants.forNode(node)?.role === "hands";
  }

  // --- discovery ---------------------------------------------------------------------------------

  private async openDiscovery(): Promise<void> {
    const transport = this.deps.discovery ?? udpTransport();
    try {
      this.discovery = await transport.open({ port: this.deps.config.nodes.discovery_port, onMessage: (msg, from) => this.onDatagram(msg, from), log: this.log.child("discovery") });
      this.log.info("discovery on", { port: this.discovery.port, cluster: this.membership?.cluster });
    } catch (e) {
      this.log.warn("discovery off: socket failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private datagram(t: Datagram["t"]): Datagram {
    return { cophyla: 1, t, cluster: this.membership?.cluster ?? "", nodeId: this.deps.identity.id, name: this.deps.identity.name, port: this.deps.lanPort() ?? 0, epoch: this.role.epoch, role: this.role.role };
  }

  private onDatagram(msg: Datagram, from: Remote): void {
    if (!this.membership || msg.cluster !== this.membership.cluster || msg.nodeId === this.deps.identity.id) return;
    if (msg.t === "q") {
      if (this.role.state === "primary" && this.discovery) this.discovery.send(this.datagram("a"), from.port, from.address);
      return;
    }
    if (msg.role !== "primary" || msg.port === 0) return;
    this.verifyCandidate(`${from.address}:${msg.port}`);
  }

  /** When each endpoint a datagram named was last probed, and the probes in flight. */
  private probedAt = new Map<string, number>();
  private probing = new Set<string>();

  /**
   * A datagram proves nothing: anyone on the network can send one. The endpoint it names is
   * acted on, in whatever state this node is, only once a probe there completes the handshake
   * with this node's secret, and then on what the probe answered, not on what the datagram
   * said. One probe per endpoint per `PROBE_INTERVAL_MS`, and a few at a time, so a flood of
   * datagrams costs little.
   */
  private verifyCandidate(endpoint: string): void {
    if (this.stopped || this.selfEndpoints().includes(endpoint) || this.probing.has(endpoint) || this.probing.size >= MAX_PROBES) return;
    const now = this.now();
    if (now - (this.probedAt.get(endpoint) ?? Number.NEGATIVE_INFINITY) < PROBE_INTERVAL_MS) return;
    if (this.probedAt.size > 64) for (const [e, at] of this.probedAt) if (now - at >= PROBE_INTERVAL_MS) this.probedAt.delete(e);
    this.probedAt.set(endpoint, now);
    this.probing.add(endpoint);
    void this.outbound
      .probe(endpoint)
      .then((a) => {
        if (this.stopped || a.role !== "primary") return;
        this.heardPrimary({ endpoint, nodeId: a.nodeId, epoch: a.epoch, heardAt: this.now() });
      })
      .catch((e: unknown) => this.log.debug("a datagram's endpoint failed its probe", { endpoint, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => this.probing.delete(endpoint));
  }

  private query(): void {
    if (this.discovery) this.discovery.broadcast(this.datagram("q"), this.deps.config.nodes.discovery_port);
  }

  private startQueries(): void {
    if (!this.discovery || this.queryTimer) return;
    const tick = () => {
      this.queryTimer = undefined;
      if (this.stopped || !this.role.is("seeking", "waiting", "claiming")) return;
      this.query();
      this.queryTimer = setTimeout(tick, this.deps.config.nodes.discovery_interval_ms);
      if (typeof this.queryTimer === "object" && "unref" in this.queryTimer) this.queryTimer.unref();
    };
    tick();
  }

  private startBeacon(): void {
    if (!this.discovery || this.beaconTimer) return;
    const tick = () => {
      this.beaconTimer = undefined;
      if (this.stopped || this.role.state !== "primary") return;
      this.discovery!.broadcast(this.datagram("b"), this.deps.config.nodes.discovery_port);
      this.beaconTimer = setTimeout(tick, this.deps.config.nodes.beacon_ms);
      if (typeof this.beaconTimer === "object" && "unref" in this.beaconTimer) this.beaconTimer.unref();
    };
    tick();
  }

  private stopBeacon(): void {
    if (this.beaconTimer) clearTimeout(this.beaconTimer);
    this.beaconTimer = undefined;
  }

  /** For the tests: the replica on a backup. */
  get replicaState(): { position: { epoch: number; seq: number }; snapshots: number } | undefined {
    return this.replica ? { position: this.replica.position, snapshots: this.replica.snapshots } : undefined;
  }

  /** For the tests: requests served for the primary so far. */
  get servedCount(): number {
    return this.outbound.served;
  }
}
