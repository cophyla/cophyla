// A secondary's link to the primary. `probe` asks a candidate who it is (the handshake's
// first half, then the socket closed); `connect` runs the whole handshake, the link sealed
// with this node's grant, joins with this node's lists and stays: a heartbeat every
// `heartbeat_ms`, this node's bus and event stream carried up, the primary's forwarded
// requests served through this node's gate as principal `node`, this node's clients
// relayed up frame for frame, and, on a backup, the replication stream applied. What the
// link means for the role (linked, lost, told to take over, told the primary is leaving)
// is reported to the owner; nothing here decides it. The socket under the link is one of
// two: a WebSocket to the primary's LAN listener, or a tunnel through the server relay the
// owner opens (`LinkTarget.open`). Either way the link is sealed from its first record with
// the grant's key (`sealed-link.ts`), which is what proves each end to the other: an answer
// that opens came from a node that holds this node's grant, the primary or a backup with
// its replica; the join says which way the node came (`via`).
//
// A node joined as hands is a guest: it takes no takeover, its own clients stay its own
// (never relayed up), and of its audit rows only the ones the primary's requests made go up.
// The primary may hand it, or any node, a new key for its grant (`grant.rekey`) and tell it
// the grant is gone (`node.leave {reason: revoked}`), both inside the sealed link. A node
// whose owner shared some folders alone (`confine.ts`) sends up what is inside them: its
// sessions, workspaces and asks there, the samples with the rest folded, no custom event, no
// desktop, and of its audit rows the primary's own.

import { nodeLinkRequests, PROTOCOL_VERSION, RpcError } from "@cophyla/protocol";
import type { Ask, AuditEntry, ClientResult, IceServer, LinkLeaveReason, MetricsSample, Node, NodeRecord, ReplicaFile, ReplicaSnapshot, ReplicaWrite, RpcId, Session, Via, Workspace } from "@cophyla/protocol";
import { pskFromHex } from "@cophyla/relay";
import type { ClientRegistry, ClientSocket } from "../api/clients.ts";
import type { RelayUplink } from "../api/server.ts";
import type { BrainMethodTable } from "../brain-link/methods.ts";
import type { Bus } from "../bus.ts";
import type { EventStream } from "../events/stream.ts";
import type { Gate } from "../gate/index.ts";
import type { Logger } from "../log.ts";
import type { Metrics } from "../metrics/index.ts";
import type { Direct } from "../direct/index.ts";
import type { Remote } from "../remote/index.ts";
import { LinkDirect } from "./direct.ts";
import type { LinkDirectTiming } from "./direct.ts";
import { SwitchableLink } from "./switch.ts";
import { RpcPeer } from "../rpc/peer.ts";
import { NodePeer } from "./peer.ts";
import type { Registry } from "./registry.ts";
import type { Replica } from "./replication.ts";
import type { Confinement } from "./confine.ts";
import { sealLan } from "./sealed-link.ts";
import { NodeServer } from "./served.ts";
import type { ServeDeps } from "./served.ts";
import type { Profiles } from "../sessions/profiles.ts";
import { STREAM_LINK_REQUESTS } from "./streams.ts";
import type { StreamLinks } from "./streams.ts";

export interface HelloAnswer {
  nodeId: string;
  role: "primary" | "secondary";
  epoch: number;
  primary?: string;
}

export interface Linked {
  primary: string;
  epoch: number;
  tz: string;
  linkId: string;
  /** The endpoint linked to, or `relay` for a tunnel. */
  endpoint: string;
  via: Via;
}

/** A socket a link runs over: what a WebSocket and a relay tunnel have in common. */
export interface LinkSocket {
  send(text: string): boolean;
  close(code?: number, reason?: string): void;
  onMessage(fn: (text: string) => void): void;
  onClose(fn: (code: number, reason: string) => void): void;
  remote?: string;
}

/** Where a link may go: a LAN endpoint, or a tunnel the owner opens through the server relay. */
export type LinkTarget = { kind: "direct"; endpoint: string } | { kind: "relay"; open: () => Promise<LinkSocket> };

export const RELAY_ENDPOINT = "relay";

export function targetLabel(t: LinkTarget): string {
  return t.kind === "direct" ? t.endpoint : RELAY_ENDPOINT;
}

/** What this node links with: its grant, the key the grant's links are keyed from, and the cluster. */
export interface Membership {
  grant: string;
  key: string;
  cluster: string;
}

export interface OutboundDeps {
  /** This node's membership; none while it is in no cluster. */
  membership: () => Membership | undefined;
  /** Joined as hands: a guest the primary drives. */
  hands: () => boolean;
  /** The folders this node shares with the primary, when its owner named some. */
  confine?: () => Confinement | undefined;
  /** This node answers the asks raised on it itself. */
  answerHere?: () => boolean;
  /** This node's own sessions, workspaces and asks, for what is checked and sent up. */
  local?: NonNullable<ServeDeps["local"]>;
  /** Where a tool comes from and its risk. */
  tools?: ServeDeps["tools"];
  /** The primary handed this node's grant a new key: kept for every link after this one. */
  onRekey: (key: string) => void;
  platformVersion: string;
  self: () => Node;
  selfEndpoints: () => string[];
  backup: () => boolean;
  rank: () => number;
  epoch: () => number;
  /** What this node carries into the join. */
  sessions: () => Session[];
  workspaces: () => Workspace[];
  asks: () => Ask[];
  registry: Registry;
  bus: Bus;
  events: EventStream;
  gate: Gate;
  clients: ClientRegistry;
  /** The table served to the primary, built once its id is known. */
  served: (primaryId: string) => BrainMethodTable;
  metrics?: Metrics;
  /** The remote module, so the primary's clients can invite to and revoke on this desktop, and its state goes up on link. */
  remote?: Remote;
  /** This node's profiles, which the primary's clients may set. */
  profiles?: Pick<Profiles, "update">;
  /** The direct connections, so the primary's clients can switch them here, and their state goes up on link; a relayed link offers a data channel through them. */
  direct?: Direct;
  /** `[direct] nodes`: whether a relayed link tries a data channel. */
  directNodes?: () => boolean;
  /** How soon a relayed link tries its data channel, and again; shorter in the tests. */
  directTiming?: LinkDirectTiming;
  /** Streams for viewers with no route to the desktop: a ticket, its end and its pipes, served here. */
  streams?: StreamLinks;
  /** The replica, on a backup; built by the owner with `fetchSnapshot` bound to this link. */
  replica?: () => Replica | undefined;
  heartbeatMs: number;
  helloTimeoutMs: number;
  log: Logger;
  onLinked: (info: Linked) => void;
  onLost: (reason: string) => void;
  /** The primary hands this node the role at `epoch`; resolves once this node is the primary. */
  onTakeover: (epoch: number) => Promise<void>;
  onLeave: (reason: LinkLeaveReason, primary?: string) => void;
  now?: () => number;
}

/** What goes up as it is: this node's client notifications, and the capability events its stream raises. */
const UPWARD_NOTIFICATIONS = ["session.state", "session.event", "ask.state", "workspace.state", "audit.entry", "node.state", "update.state", "remote.state", "direct.state"] as const;
const UPWARD_EVENTS = new Set<string>(["session.discovered", "session.updated", "session.ask", "session.ended", "workspace.updated", "event.custom", "node.pressure"]);

interface Socket {
  sock: LinkSocket;
  rpc: RpcPeer;
  /** A relayed link's switch, which can move its frames to a data channel. */
  link?: SwitchableLink;
}

/** Opens a WebSocket to `endpoint`'s `/ws/node`; resolves once it is open, wrapped as a `LinkSocket`. */
export function openDirect(endpoint: string, timeoutMs: number): Promise<LinkSocket> {
  return new Promise((resolve, reject) => {
    const url = `wss://${endpoint}/ws/node`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { tls: { rejectUnauthorized: false } } as never);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const timer = setTimeout(() => {
      reject(new RpcError("timeout", `${endpoint}: no answer within ${timeoutMs} ms`));
      try {
        ws.close();
      } catch {
        // already closed
      }
    }, timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({
        send: (text) => {
          if (ws.readyState !== 1) return false;
          ws.send(text);
          return true;
        },
        close: (code, reason) => {
          try {
            ws.close(code, reason);
          } catch {
            // already closed
          }
        },
        onMessage: (fn) => ws.addEventListener("message", (ev) => fn(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8"))),
        onClose: (fn) => ws.addEventListener("close", (ev) => fn(ev.code, ev.reason)),
        remote: endpoint,
      });
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new RpcError("unavailable", `${endpoint}: connection failed`));
    });
  });
}

export class Outbound {
  private deps: OutboundDeps;
  private log: Logger;
  private peer?: NodePeer;
  private linkedInfo?: Linked;
  private server?: NodeServer;
  private unsubscribe: (() => void)[] = [];
  private relayed = new Map<string, ClientSocket>();
  /** The data channel of a relayed link, while there is one. */
  private linkDirect?: LinkDirect;
  /** Requests from the primary being served, so the tests can wait on them. */
  served = 0;

  constructor(deps: OutboundDeps) {
    this.deps = deps;
    this.log = deps.log;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  linked(): boolean {
    return this.peer?.open === true && this.linkedInfo !== undefined;
  }

  get info(): Linked | undefined {
    return this.linkedInfo;
  }

  get primaryId(): string | undefined {
    return this.linkedInfo?.primary;
  }

  /** The metrics subscriber id this link's samples are delivered under. */
  get metricsSubscriber(): string | undefined {
    return this.linkedInfo ? `link:${this.linkedInfo.linkId}` : undefined;
  }

  // --- the handshake ---------------------------------------------------------------------------

  private membership(): Membership {
    const m = this.deps.membership();
    if (!m) throw new RpcError("conflict", "this node is in no cluster: join one with an invite");
    return m;
  }

  /** A LAN socket to `endpoint`, sealed with this node's grant. */
  private async openSealed(endpoint: string, m: Membership): Promise<LinkSocket> {
    const raw = await openDirect(endpoint, this.deps.helloTimeoutMs);
    return sealLan(raw, { grant: m.grant, kind: "node", psk: pskFromHex(m.key), timeoutMs: this.deps.helloTimeoutMs });
  }

  private hello(rpc: RpcPeer, m: Membership): Promise<HelloAnswer & { cluster: string }> {
    return rpc
      .request("node.hello", { protocolVersion: PROTOCOL_VERSION, platformVersion: this.deps.platformVersion, nodeId: this.deps.self().id, cluster: m.cluster }, { timeoutMs: this.deps.helloTimeoutMs })
      .then((r) => {
        const parsed = nodeLinkRequests["node.hello"].result.safeParse(r);
        if (!parsed.success) throw new RpcError("invalid", "bad node.hello answer");
        if (parsed.data.cluster !== m.cluster) throw new RpcError("denied", "the answer names another cluster");
        return parsed.data;
      });
  }

  /**
   * Who is at `endpoint`: role, epoch, and where the primary is if not there; the socket is
   * closed after. The answer opened under this node's own key, so it came from a node that
   * holds the grant. Direct only: across the relay, the registry's answer is the probe.
   */
  async probe(endpoint: string): Promise<HelloAnswer> {
    const m = this.membership();
    const raw = await this.openSealed(endpoint, m);
    const sock = this.socketFor(raw, "probe", false);
    try {
      const a = await this.hello(sock.rpc, m);
      return { nodeId: a.nodeId, role: a.role, epoch: a.epoch, ...(a.primary !== undefined ? { primary: a.primary } : {}) };
    } finally {
      sock.rpc.close("probe done");
      sock.sock.close(1000, "probe done");
    }
  }

  /** The link's RPC over a socket; over the relay, with the switch between them that can move it to a data channel. */
  private socketFor(raw: LinkSocket, label: string, switchable: boolean): Socket {
    let link: SwitchableLink | undefined;
    const rpc = new RpcPeer({
      write: (text) => (link ? link.send(text) : raw.send(text)),
      log: this.log,
      label,
      onRequest: (method, params, id) => this.onRequest(rpc, method, params, id),
      onNotification: (method, params) => this.onNotification(rpc, method, params),
    });
    if (switchable) {
      link = new SwitchableLink({
        relay: (text) => raw.send(text),
        deliver: (text) => rpc.onText(text),
        close: (code, reason) => raw.close(code, reason),
        log: this.log.child("switch"),
        onMode: (mode) => this.linkDirect?.modeChanged(mode),
      });
    }
    raw.onMessage((text) => (link ? link.fromRelay(text) : rpc.onText(text)));
    raw.onClose((code, reason) => {
      link?.shut();
      const peer = this.peer;
      if (peer && peer.rpc === rpc) peer.closedBy(`link closed (${code} ${reason})`);
      else rpc.close("closed");
    });
    return { sock: raw, rpc, ...(link ? { link } : {}) };
  }

  /** The whole handshake against a target; on success this node is linked until the socket goes. */
  async connect(target: LinkTarget): Promise<Linked> {
    if (this.peer) throw new RpcError("conflict", "already linked");
    const endpoint = targetLabel(target);
    const m = this.membership();
    const raw = target.kind === "direct" ? await this.openSealed(target.endpoint, m) : await target.open();
    const sock = this.socketFor(raw, `link ${endpoint}`, target.kind === "relay" && this.deps.direct !== undefined);
    try {
      const a = await this.hello(sock.rpc, m);
      if (a.role !== "primary") throw new RpcError("conflict", `${endpoint} is not the primary`, a.primary !== undefined ? { primary: a.primary } : undefined);
      const self: Node = { ...this.deps.self(), via: target.kind };
      const rank = this.deps.rank();
      const joined = await sock.rpc.request(
        "node.join",
        {
          node: self,
          endpoints: this.deps.selfEndpoints(),
          epoch: this.deps.epoch(),
          backup: this.deps.backup(),
          ...(this.deps.backup() ? { rank } : {}),
          ...this.lists(),
        },
        { timeoutMs: this.deps.helloTimeoutMs },
      );
      const parsed = nodeLinkRequests["node.join"].result.safeParse(joined);
      if (!parsed.success) throw new RpcError("invalid", "bad node.join answer");
      const j = parsed.data;
      const primaryNode = j.registry.find((n) => n.id === j.primary);
      const peer = new NodePeer(
        sock.rpc,
        { linkId: j.linkId, node: primaryNode ?? { ...self, id: j.primary, role: "primary" }, epoch: j.epoch, backup: false, endpoints: primaryNode?.endpoints ?? (target.kind === "direct" ? [endpoint] : []) },
        { log: this.log, closeSocket: (code, reason) => sock.sock.close(code, reason), now: this.now() },
      );
      this.peer = peer;
      this.linkedInfo = { primary: j.primary, epoch: j.epoch, tz: j.tz, linkId: j.linkId, endpoint, via: target.kind };
      peer.onClose((reason) => this.onClosed(peer, reason));
      this.deps.registry.take(j.registry);
      this.server = new NodeServer({
        gate: this.deps.gate,
        table: this.deps.served(j.primary),
        principal: { kind: "node", id: j.primary },
        sessionKey: j.linkId,
        log: this.log,
        onPending: (id, ask) => void peer.notify("pending", { id, ask, at: this.now() }),
        ...(this.deps.metrics ? { metrics: this.deps.metrics } : {}),
        metricsSubscriber: `link:${j.linkId}`,
        ...(this.deps.remote ? { remote: this.deps.remote } : {}),
        ...(this.deps.profiles ? { profiles: this.deps.profiles } : {}),
        ...(this.deps.direct ? { direct: this.deps.direct } : {}),
        ...(this.deps.confine ? { confine: this.deps.confine } : {}),
        ...(this.deps.answerHere ? { answerHere: this.deps.answerHere } : {}),
        ...(this.deps.local ? { local: this.deps.local } : {}),
        ...(this.deps.tools ? { tools: this.deps.tools } : {}),
      });
      this.subscribeUpward(peer);
      // What only changes on events goes up once now, so the primary's clients see it before the next change.
      if (this.deps.remote && !this.confined()) void peer.notify("remote.state", this.deps.remote.state());
      if (this.deps.direct) void peer.notify("direct.state", this.deps.direct.state());
      // a relayed link tries a data channel of its own shortly after the join
      if (sock.link && this.deps.direct) {
        this.linkDirect = new LinkDirect({
          direct: this.deps.direct,
          link: sock.link,
          request: (method, params, opts) => peer.request(method, params, opts ?? {}),
          notify: (method, params) => peer.notify(method, params),
          // this node's grant key as it stands, a re-key included
          psk: () => {
            const key = this.deps.membership()?.key;
            return key ? pskFromHex(key) : undefined;
          },
          role: "secondary",
          secondary: this.deps.self().id,
          other: j.primary,
          enabled: () => this.deps.directNodes?.() ?? true,
          log: this.log.child("direct"),
          ...(this.deps.now ? { now: this.deps.now } : {}),
          ...(this.deps.directTiming ? { timing: this.deps.directTiming } : {}),
        });
        this.linkDirect.start();
      }
      peer.watch(this.deps.heartbeatMs, async () => {
        await peer.request("node.heartbeat", { epoch: this.deps.epoch() }, { timeoutMs: this.deps.heartbeatMs });
        peer.heard(this.now());
        return true;
      });
      this.log.info("linked to the primary", { primary: j.primary, endpoint, via: target.kind, epoch: j.epoch, link: j.linkId, backup: this.deps.backup() });
      this.deps.onLinked(this.linkedInfo);
      return this.linkedInfo;
    } catch (e) {
      sock.rpc.close("handshake failed");
      sock.sock.close(1000, "handshake failed");
      throw e;
    }
  }

  private onClosed(peer: NodePeer, reason: string): void {
    if (this.peer !== peer) return;
    this.peer = undefined;
    const info = this.linkedInfo;
    this.linkedInfo = undefined;
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    this.server?.abortAll();
    this.server = undefined;
    this.linkDirect?.stop();
    this.linkDirect = undefined;
    if (info) this.deps.streams?.gone(info.primary);
    if (info && this.deps.metrics) this.deps.metrics.unsubscribe(`link:${info.linkId}`);
    for (const [peerId, port] of [...this.relayed]) {
      this.relayed.delete(peerId);
      port.close(4409, "link to the primary lost");
    }
    this.log.warn("link to the primary lost", { primary: info?.primary, reason });
    this.deps.onLost(reason);
  }

  /** Closes the link from this side. */
  close(reason = "closing"): void {
    this.peer?.close(1000, reason);
  }

  /** Tells the primary this node is going (for good, `left`, and its grant with it), then closes. */
  leave(reason: "stopping" | "stepdown" | "left", primary?: string): void {
    this.peer?.notify("node.leave", { reason, ...(primary !== undefined ? { primary } : {}) });
    this.close(reason);
  }

  // --- what goes up -------------------------------------------------------------------------------

  /** The folders this node shares, when its owner named some. */
  private confined(): Confinement | undefined {
    const c = this.deps.confine?.();
    return c?.active ? c : undefined;
  }

  private sessionOf = (id: string): Session | undefined => this.deps.local?.session(id);

  /** What the join carries: this node's lists, as far as the folders it shares reach. */
  private lists(): { sessions: Session[]; workspaces: Workspace[]; asks: Ask[] } {
    const sessions = this.deps.sessions();
    const workspaces = this.deps.workspaces();
    const asks = this.deps.asks();
    const c = this.confined();
    if (!c) return { sessions, workspaces, asks };
    return { sessions: sessions.filter((s) => c.session(s)), workspaces: workspaces.filter((w) => c.workspace(w)), asks: asks.filter((a) => c.ask(a, this.sessionOf)) };
  }

  /** Whether a row goes up: this node's own, and, on a confined node, about what is inside. */
  private sendsUp(name: (typeof UPWARD_NOTIFICATIONS)[number], params: unknown): boolean {
    // This node's own row goes up; the registry the primary sent, re-announced here, does not.
    if (name === "node.state") return (params as NodeRecord).id === this.deps.self().id;
    const c = this.confined();
    // A guest's own doings stay its own, and so do a confined node's: only what the primary did here goes up.
    if (name === "audit.entry") return (!this.deps.hands() && !c) || (params as AuditEntry).principal.kind === "node";
    if (!c) return true;
    switch (name) {
      case "session.state":
        return c.session(params as Session);
      case "session.event": {
        const s = this.sessionOf((params as { session: string }).session);
        return s !== undefined && c.session(s);
      }
      case "ask.state":
        return c.ask(params as Ask, this.sessionOf);
      case "workspace.state":
        return c.workspace(params as Workspace);
      case "remote.state":
        return false;
      default:
        return true;
    }
  }

  /** Whether a capability event goes up: on a confined node, one about what is inside, and no custom event. */
  private eventGoesUp(name: string, params: unknown): boolean {
    const c = this.confined();
    if (!c) return true;
    const p = params as { session?: string | Session; id?: string };
    switch (name) {
      case "session.discovered":
      case "session.updated":
      case "session.ended":
        return typeof p.session === "object" && c.session(p.session);
      case "session.ask": {
        const s = typeof p.session === "string" ? this.sessionOf(p.session) : undefined;
        return s !== undefined && c.session(s);
      }
      case "workspace.updated": {
        const w = p.id !== undefined ? this.deps.local?.workspace(p.id) : undefined;
        return w !== undefined && c.workspace(w);
      }
      case "event.custom":
        return false;
      default:
        return true;
    }
  }

  private subscribeUpward(peer: NodePeer): void {
    for (const name of UPWARD_NOTIFICATIONS) {
      this.unsubscribe.push(
        this.deps.bus.on(name, (params) => {
          if (this.sendsUp(name, params)) void peer.notify(name, params);
        }),
      );
    }
    this.unsubscribe.push(
      this.deps.events.on((e) => {
        if (UPWARD_EVENTS.has(e.name) && this.eventGoesUp(e.name, e.params)) peer.notify(e.name, e.params);
      }),
    );
  }

  /** A sample of this node for the primary's watchers; on a confined node, with the processes of sessions outside folded. */
  deliverSample(sample: MetricsSample): boolean {
    const c = this.confined();
    return this.peer?.notify("metrics.sample", c ? c.sample(sample, this.sessionOf) : sample) ?? false;
  }

  // --- what comes down ------------------------------------------------------------------------------

  private async onRequest(rpc: RpcPeer, method: string, params: unknown, id: RpcId): Promise<unknown> {
    const peer = this.peer;
    if (!peer || peer.rpc !== rpc) throw new RpcError("unavailable", "not linked");
    peer.heard(this.now());
    if (method === "grant.rekey") {
      const parsed = nodeLinkRequests["grant.rekey"].params.safeParse(params ?? {});
      if (!parsed.success) throw new RpcError("invalid", "bad grant.rekey");
      this.deps.onRekey(parsed.data.key);
      return {};
    }
    if (method === "node.takeover") {
      if (this.deps.hands()) throw new RpcError("denied", "a hands node never takes the primary role");
      const parsed = nodeLinkRequests["node.takeover"].params.safeParse(params ?? {});
      if (!parsed.success) throw new RpcError("invalid", "bad node.takeover");
      this.log.info("takeover requested by the primary", { epoch: parsed.data.epoch });
      await this.deps.onTakeover(parsed.data.epoch);
      return {};
    }
    const info = this.linkedInfo;
    if (!this.server || !info) throw new RpcError("unavailable", "not linked");
    this.served++;
    if (this.deps.streams && STREAM_LINK_REQUESTS.has(method)) {
      return this.deps.streams.request({ id: info.primary, sessionKey: info.linkId }, method, params, (ask) => void peer.notify("pending", { id, ask, at: this.now() }));
    }
    return this.server.serve(method, params, id);
  }

  private onNotification(rpc: RpcPeer, method: string, params: unknown): void {
    const peer = this.peer;
    if (!peer || peer.rpc !== rpc) return;
    peer.heard(this.now());
    switch (method) {
      case "relay": {
        const p = params as { peer: string; frame: string };
        this.relayed.get(p.peer)?.send(p.frame);
        return;
      }
      case "relay.close": {
        const p = params as { peer: string };
        const port = this.relayed.get(p.peer);
        this.relayed.delete(p.peer);
        port?.close(1000, "closed by the primary");
        return;
      }
      case "registry.update": {
        const p = params as { nodes: NodeRecord[] };
        this.deps.registry.take(p.nodes);
        return;
      }
      case "node.leave": {
        const p = params as { reason: LinkLeaveReason; primary?: string };
        this.log.info("the primary is leaving", { reason: p.reason, primary: p.primary });
        this.deps.onLeave(p.reason, p.primary);
        return;
      }
      case "replicate.write":
        this.deps.replica?.()?.onWrite(params as ReplicaWrite);
        return;
      case "replicate.file":
        this.deps.replica?.()?.onFile(params as ReplicaFile);
        return;
      case "direct.candidate":
        this.linkDirect?.candidate(params as { attempt: string; candidate: unknown });
        return;
      case "pipe.data":
      case "pipe.ack":
      case "pipe.close":
        if (this.linkedInfo) this.deps.streams?.frame(this.linkedInfo.primary, method, params);
        return;
      default:
        this.log.debug("frame from the primary ignored", { method });
    }
  }

  /** One request up to the primary, for what only it can route: a viewer's `remote.pair` on another node's desktop. */
  async requestPrimary(method: string, params: unknown, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    const peer = this.peer;
    if (!peer?.open) throw new RpcError("unavailable", "not linked to the primary");
    return peer.request(method, params, { ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
  }

  /** TURN credentials from the primary's account, for this node's direct connections. */
  async turn(): Promise<{ iceServers: IceServer[]; expiresAt: number }> {
    const r = await this.requestPrimary("direct.turn", {}, { timeoutMs: 20_000 });
    const parsed = nodeLinkRequests["direct.turn"].result.safeParse(r);
    if (!parsed.success) throw new RpcError("invalid", "bad direct.turn answer");
    return parsed.data;
  }

  /** One frame up to the primary: a pipe's bytes, window or end. */
  notifyPrimary(method: string, params: unknown): boolean {
    const peer = this.peer;
    if (!peer?.open) return false;
    return peer.notify(method, params);
  }

  /** Asks the primary for a whole replica snapshot. */
  async fetchSnapshot(): Promise<ReplicaSnapshot> {
    const peer = this.peer;
    if (!peer?.open) throw new RpcError("unavailable", "not linked");
    const r = await peer.request("replicate.snapshot", {}, { timeoutMs: 60_000 });
    const parsed = nodeLinkRequests["replicate.snapshot"].result.safeParse(r);
    if (!parsed.success) throw new RpcError("invalid", "bad snapshot");
    return parsed.data;
  }

  // --- this node's clients, relayed to the primary --------------------------------------------------

  readonly relay: RelayUplink = {
    // A guest's own clients see this machine alone.
    linked: () => this.linked() && !this.deps.hands(),
    open: async (peerId, info, origin, port, as = {}) => {
      const peer = this.peer;
      if (!peer?.open) throw new RpcError("unavailable", "not linked");
      // Registered before the request: the primary's welcome frames come down before its answer does.
      this.relayed.set(peerId, port);
      try {
        const params = { peer: peerId, client: info, origin, ...(as.grant !== undefined ? { grant: as.grant } : {}), ...(as.access !== undefined ? { access: as.access } : {}) };
        return (await peer.request("relay.open", params, { timeoutMs: this.deps.helloTimeoutMs })) as ClientResult<"hello">;
      } catch (e) {
        this.relayed.delete(peerId);
        throw e;
      }
    },
    frame: (peerId, text) => {
      this.peer?.notify("relay", { peer: peerId, frame: text });
    },
    close: (peerId) => {
      if (!this.relayed.delete(peerId)) return;
      this.peer?.notify("relay.close", { peer: peerId });
    },
  };

  relayedCount(): number {
    return this.relayed.size;
  }
}
