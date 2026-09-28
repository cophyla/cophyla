// A workspace node: one folder of this machine, lent to another person's cluster as a hands
// node of it. It is the hands subset of `Nodes`: a membership (its own grant, key and link
// file), a seek for that cluster's primary over its LAN endpoints and the relay, and a link
// that serves the primary what the folder holds. Everything it has is its own: an id and
// epoch, a registry and remembered answers in its own `node.sqlite`, a gate that stamps its
// asks and audit rows with its id, an event stream, and a partition of the bus. It never
// hears the machine's events, and the machine's apps never hear its own.
//
// It has no desktop, no direct connections, no discovery on the LAN, no profiles of its own
// to show and no brain: its sessions run headless on this machine's harness logins, under the
// profile `node add --profile` named, or each harness's usual one here.
//
// Joining redeems an invite without the machine's account, and is refused when the invite is
// the machine's own or names a node some registry here knows, when the cluster answered is the
// machine's or another workspace node's, or when the role is not hands. Joining a different
// cluster from the one it was last in takes away what it held first. A revoke or its grant's
// end forgets the membership; `leave` tells the primary and keeps the data.

import { parseInvite, PROTOCOL_VERSION, RpcError } from "@cophyla/protocol";
import type { HarnessKind, InviteBody, LinkLeaveReason, Node } from "@cophyla/protocol";
import { pskFromHex } from "@cophyla/relay";
import type { Bus } from "../bus.ts";
import type { Config } from "../config/schema.ts";
import { EventStream } from "../events/stream.ts";
import type { Asks } from "../gate/asks.ts";
import type { Audit } from "../gate/audit.ts";
import { Gate } from "../gate/index.ts";
import { Policy } from "../gate/policy.ts";
import { readLinkFile, removeLinkFile, writeLinkFile } from "../grants/link-file.ts";
import type { LinkFile } from "../grants/link-file.ts";
import type { Logger } from "../log.ts";
import type { Metrics } from "../metrics/index.ts";
import { guestSubscriber } from "../metrics/guest.ts";
import type { Sessions } from "../sessions/index.ts";
import type { Profiles } from "../sessions/profiles.ts";
import { Store } from "../store/index.ts";
import type { Tools } from "../tools/index.ts";
import type { Workspaces } from "../workspaces/index.ts";
import { redeemNodeInvite } from "./enroll.ts";
import { guestFiles, writeManifest } from "./guest-files.ts";
import type { GuestManifest } from "./guest-files.ts";
import { guestServedTable, stripRow } from "./guest-served.ts";
import { Outbound } from "./outbound.ts";
import type { LinkTarget } from "./outbound.ts";
import type { Owners } from "./owners.ts";
import { Registry } from "./registry.ts";
import { linkCandidates, Seeker } from "./seek.ts";
import { platformName } from "./self.ts";
import { openRelayLink } from "./sealed-link.ts";

export type GuestState = "unlinked" | "seeking" | "linked" | "stopped";

export interface GuestMemberDeps {
  manifest: GuestManifest;
  /** `data/nodes/<slug>/`. */
  dir: string;
  config: Config;
  bus: Bus;
  asks: Asks;
  audit: Audit;
  sessions: Sessions;
  workspaces: Workspaces;
  profiles: Pick<Profiles, "get" | "defaultFor" | "launch">;
  tools: Pick<Tools, "list" | "risk" | "source" | "run">;
  /** The machine's store: recall and a purge go through it. */
  store: Store;
  metrics?: Metrics;
  owners: Owners;
  /** Whether a node id is the machine's, or known to any registry here but this node's own: an invite from it is refused. */
  knownElsewhere: (node: string) => boolean;
  /** The clusters that are not this node's to join: the machine's and the other workspace nodes'. */
  otherClusters: () => string[];
  /** The manifest changed: written already, told so the list follows. */
  onManifest?: (m: GuestManifest) => void;
  platformVersion: string;
  log: Logger;
  now?: () => number;
}

/** A workspace node's membership and link. */
export class GuestMember {
  private deps: GuestMemberDeps;
  private log: Logger;
  manifest: GuestManifest;
  /** Its own store: identity, epoch, registry, remembered answers. */
  readonly store: Store;
  readonly registry: Registry;
  readonly gate: Gate;
  private policy: Policy;
  private events: EventStream;
  private outbound: Outbound;
  private seeker: Seeker;
  private membership?: LinkFile;
  private stateValue: GuestState = "unlinked";
  private joining = false;
  private stopped = false;
  private membershipTimer?: ReturnType<typeof setTimeout>;
  /** The endpoint a leaving primary pointed at, tried first. */
  private preferred?: string;

  constructor(deps: GuestMemberDeps) {
    this.deps = deps;
    this.manifest = deps.manifest;
    this.log = deps.log;
    const files = guestFiles(deps.dir);
    this.store = new Store(files.db);
    this.store.migrate();
    const id = this.id;
    // its identity is its store's, as the machine's is the machine's store's
    if (this.store.meta.get("node_id") !== id) this.store.meta.set("node_id", id);
    const scoped = deps.bus.for(id);
    // Its own remembered answers: the owner's "always allow node:…" is for the owner's cluster, not this one.
    this.policy = new Policy(deps.config.gate, this.store);
    this.gate = new Gate({ config: deps.config.gate, policy: this.policy, asks: deps.asks, audit: deps.audit, log: this.log.child("gate"), node: id });
    this.registry = new Registry({ store: this.store, bus: scoped, self: () => this.row(), selfEndpoints: () => [], selfRank: () => undefined, ...(deps.now ? { now: deps.now } : {}) });
    const sessions = deps.sessions.view(id);
    const workspaces = deps.workspaces.view(id);
    const asks = deps.asks.view(id);
    this.events = new EventStream({ bus: scoped, sessions, log: this.log.child("events") });
    const membership = readLinkFile(files.link);
    if (membership) this.membership = membership;
    const metrics = deps.metrics;
    this.outbound = new Outbound({
      membership: () => this.membership,
      hands: () => true,
      confine: () => this.confinement(),
      local: { session: (s) => sessions.get(s), workspace: (w) => workspaces.get(w), ask: (a) => asks.get(a) },
      tools: { source: (name) => deps.tools.source(name), risk: (name) => deps.tools.risk(name) },
      onRekey: (key) => this.onRekey(key),
      platformVersion: deps.platformVersion,
      self: () => this.row(),
      selfEndpoints: () => [],
      backup: () => false,
      rank: () => 1,
      epoch: () => this.epoch,
      sessions: () => sessions.list(),
      workspaces: () => workspaces.list(),
      asks: () => asks.listOpen(),
      registry: this.registry,
      bus: scoped,
      events: this.events,
      gate: this.gate,
      served: (primaryId) =>
        guestServedTable(
          {
            node: () => this.row(),
            sessions,
            workspaces,
            asks,
            tools: deps.tools,
            confine: () => this.confinement(),
            recall: (p) => deps.store.index.recall(p, { only: id }),
            ...(metrics ? { metrics: { latest: () => metrics.guestLatest(id) } } : {}),
            ...(this.manifest.profile !== undefined ? { profile: this.manifest.profile } : {}),
            profiles: deps.profiles,
          },
          primaryId,
        ),
      ...(metrics
        ? {
            metrics: {
              subscribe: (client: string, intervalMs: number, processes?: "all" | "owners") => metrics.subscribe(client, intervalMs, processes),
              unsubscribe: (client: string) => metrics.unsubscribe(client),
              history: () => metrics.guestLatest(id),
            },
          }
        : {}),
      metricsSubscriber: (linkId) => guestSubscriber(id, linkId),
      outgoing: (_name, params) => stripRow(params),
      heartbeatMs: deps.config.nodes.heartbeat_ms,
      helloTimeoutMs: deps.config.nodes.hello_timeout_ms,
      log: this.log.child("outbound"),
      onLinked: (info) => this.onLinked(info.epoch),
      onLost: () => this.onLost(),
      onTakeover: () => Promise.reject(new RpcError("denied", "a workspace node never takes the primary role")),
      onLeave: (reason, primary) => this.onPrimaryLeaving(reason, primary),
      ...(deps.now ? { now: deps.now } : {}),
    });
    this.seeker = new Seeker({
      candidates: () => this.candidates(),
      connect: (target) => this.outbound.connect(target),
      active: () => this.stateValue === "seeking" && !this.stopped,
      reconnectMs: deps.config.nodes.reconnect_ms,
      reconnectMaxMs: deps.config.nodes.reconnect_max_ms,
      linked: () => {
        this.preferred = undefined;
      },
      log: this.log.child("seek"),
    });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  get id(): string {
    return this.manifest.id;
  }

  get state(): GuestState {
    return this.stateValue;
  }

  private get epoch(): number {
    return Number(this.store.meta.get("epoch") ?? "1") || 1;
  }

  /** The cluster it is in, and whom it joined. */
  member(): { cluster: string; grant: string; primary?: { id: string; name: string }; expiresAt?: number } | undefined {
    const m = this.membership;
    if (!m) return undefined;
    return { cluster: m.cluster, grant: m.grant, ...(m.primary ? { primary: m.primary } : {}), ...(m.expiresAt !== undefined ? { expiresAt: m.expiresAt } : {}) };
  }

  linked(): boolean {
    return this.outbound.linked();
  }

  via(): "direct" | "relay" | undefined {
    return this.outbound.info?.via;
  }

  primaryId(): string | undefined {
    return this.outbound.primaryId;
  }

  /** Whether a node is in this workspace node's own registry. */
  knows(node: string): boolean {
    return this.registry.get(node) !== undefined && node !== this.id;
  }

  private confinement() {
    const c = this.deps.owners.confinement(this.id);
    if (!c) throw new RpcError("unavailable", "this workspace node owns no folder now");
    return c;
  }

  /** The harnesses it offers: the one of the profile it was given, or each whose usual profile here can run. */
  harnesses(): HarnessKind[] {
    const { profiles } = this.deps;
    if (this.manifest.profile !== undefined) {
      const p = profiles.get(this.manifest.profile);
      return p && p.status === "ok" ? [p.harness] : [];
    }
    const out: HarnessKind[] = [];
    for (const h of ["claude", "codex", "muse"] as const) if (profiles.defaultFor(h)?.status === "ok") out.push(h);
    return out;
  }

  /** Its row as its cluster sees it: its name, its folder, the harnesses it offers; no voice, desktop or brain. */
  row(): Node {
    return {
      id: this.id,
      name: this.manifest.name,
      role: "secondary",
      status: "online",
      via: this.outbound?.info?.via ?? "direct",
      platform: platformName(),
      scope: { kind: "workspaces", paths: [this.manifest.folder] },
      capabilities: { harnesses: this.harnesses(), voice: { wake: false, stt: false, tts: false }, remote: false, brain: false },
      versions: { platform: this.deps.platformVersion, protocol: PROTOCOL_VERSION },
      lastSeen: this.now(),
    };
  }

  /** Its row changed (a harness signed in or out): its cluster hears it. */
  announce(): void {
    this.deps.bus.for(this.id).emit("node.state", this.row());
  }

  // --- lifecycle -----------------------------------------------------------------------------

  start(): void {
    if (this.stopped) return;
    this.events.start(this.deps.sessions.view(this.id).list());
    if (!this.membership) return;
    this.armMembershipClock();
    this.seek();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stateValue = "stopped";
    this.seeker.abandon();
    this.stopMembershipClock();
    this.outbound.leave("stopping");
    this.events.dispose();
    this.store.close();
  }

  private seek(): void {
    this.stateValue = "seeking";
    this.seeker.kick();
  }

  /** The ways to its primary: where the enrollment said, what its registry knows, and the relay. */
  private candidates(): LinkTarget[] {
    const m = this.membership;
    if (!m) return [];
    const relay = m.relay;
    const target: LinkTarget | undefined =
      relay && this.deps.config.nodes.relay
        ? { kind: "relay", open: () => openRelayLink({ url: relay.url, token: relay.token, peer: m.grant, psk: pskFromHex(m.key), kind: "node", timeoutMs: this.deps.config.nodes.hello_timeout_ms }) }
        : undefined;
    return linkCandidates({
      ...(this.preferred !== undefined ? { preferred: this.preferred } : {}),
      membership: m.endpoints ?? [],
      registryPrimary: this.registry.primary()?.endpoints ?? [],
      registryBackups: this.registry.backups().map((b) => b.endpoints),
      ...(target ? { relay: target, relayFirst: m.endpoints === undefined } : {}),
    });
  }

  private onLinked(epoch: number): void {
    this.stateValue = "linked";
    this.store.meta.set("epoch", String(epoch));
    this.announce();
  }

  private onLost(): void {
    if (this.stopped || this.stateValue !== "linked") return;
    const primary = this.outbound.primaryId ?? this.registry.primary()?.id;
    if (primary) this.registry.markOffline(primary);
    this.seek();
  }

  private onPrimaryLeaving(reason: LinkLeaveReason, primary?: string): void {
    if (reason === "revoked") {
      this.forget("its primary ended its grant");
      return;
    }
    if (primary) this.preferred = this.registry.endpointsOf(primary)[0];
  }

  private onRekey(key: string): void {
    const m = this.membership;
    if (!m) return;
    this.membership = { ...m, key };
    writeLinkFile(guestFiles(this.deps.dir).link, this.membership);
  }

  // --- membership ------------------------------------------------------------------------------

  /**
   * Redeems a node invite as this workspace node and links. Refused when the invite is the
   * machine's own or names a node another registry here knows, when the cluster is the
   * machine's or another workspace node's, or when the role it was given is not hands.
   */
  async join(text: string): Promise<{ primary: { id: string; name: string }; cluster: string }> {
    let body: InviteBody;
    try {
      body = parseInvite(text);
    } catch (e) {
      throw new RpcError("invalid", e instanceof Error ? e.message : String(e));
    }
    if (body.kind !== "node") throw new RpcError("invalid", "that invite is for a phone, not a node");
    if (this.stopped) throw new RpcError("unavailable", "this workspace node is stopping");
    if (this.membership) throw new RpcError("conflict", `${this.manifest.name} is in a cluster already: leave it first`);
    if (this.joining) throw new RpcError("conflict", "a join is in flight");
    if (this.deps.knownElsewhere(body.node.id)) throw new RpcError("conflict", "that invite is from this machine's own cluster, or from one another workspace node here is in: a workspace node joins another person's cluster");
    this.joining = true;
    try {
      const answer = await redeemNodeInvite(body, { id: this.id, name: this.manifest.name }, { timeoutMs: this.deps.config.nodes.hello_timeout_ms, log: this.log.child("enroll"), now: this.now() });
      if (this.stopped) throw new RpcError("unavailable", "this workspace node is stopping");
      if (this.deps.otherClusters().includes(answer.cluster)) throw new RpcError("conflict", "that cluster is this machine's own, or another workspace node's here: the invite is not used");
      if (answer.role !== "hands") throw new RpcError("denied", "a workspace node joins as hands only: ask for a hands invite");
      // Another cluster than the one it was last in: what the last one saw here goes first.
      if (this.manifest.lastCluster !== undefined && this.manifest.lastCluster !== answer.cluster) await this.purge("joined another cluster");
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
        paths: [this.manifest.folder],
      };
      writeLinkFile(guestFiles(this.deps.dir).link, file);
      this.membership = file;
      this.setManifest({ ...this.manifest, lastCluster: answer.cluster });
      this.log.info("a workspace node joined a cluster", { node: this.id, name: this.manifest.name, primary: answer.primary.id, via: answer.via, relay: answer.relay !== undefined });
      this.armMembershipClock();
      this.seeker.resetBackoff();
      this.seek();
      return { primary: answer.primary, cluster: answer.cluster };
    } finally {
      this.joining = false;
    }
  }

  /** Leaves its cluster for good: the primary hears it and drops the grant; the data here stays. */
  async leave(): Promise<void> {
    if (!this.membership) throw new RpcError("conflict", `${this.manifest.name} is in no cluster`);
    if (this.joining) throw new RpcError("conflict", "a join is in flight");
    this.forget("left the cluster", () => this.outbound.leave("left"));
  }

  /** The membership is over: left, revoked, or run out. Unlinked first, so the close is not taken for a primary lost. */
  private forget(why: string, closeLink: () => void = () => this.outbound.close(why)): void {
    const m = this.membership;
    if (!m) return;
    this.seeker.abandon();
    this.stopMembershipClock();
    this.stateValue = "unlinked";
    closeLink();
    removeLinkFile(guestFiles(this.deps.dir).link);
    this.membership = undefined;
    this.log.warn("a workspace node is in no cluster now", { node: this.id, name: this.manifest.name, why, cluster: m.cluster });
  }

  private armMembershipClock(): void {
    this.stopMembershipClock();
    const end = this.membership?.expiresAt;
    if (end === undefined || this.stopped) return;
    this.membershipTimer = setTimeout(() => {
      this.membershipTimer = undefined;
      const at = this.membership?.expiresAt;
      if (at === undefined) return;
      if (at <= this.now()) this.forget("its grant ran out");
      else this.armMembershipClock();
    }, Math.min(Math.max(0, end - this.now()), 2 ** 31 - 1));
    if (typeof this.membershipTimer === "object" && "unref" in this.membershipTimer) this.membershipTimer.unref();
  }

  private stopMembershipClock(): void {
    if (this.membershipTimer) clearTimeout(this.membershipTimer);
    this.membershipTimer = undefined;
  }

  private setManifest(m: GuestManifest): void {
    this.manifest = m;
    writeManifest(this.deps.dir, m);
    this.deps.onManifest?.(m);
  }

  /**
   * Takes away what this workspace node held: its sessions end, its open asks are cancelled,
   * and its rows go from the machine's store (the session ids kept as tombstones), and from
   * its own the registry and remembered answers. Its folder stays its own.
   */
  async purge(why: string): Promise<void> {
    await this.deps.sessions.endAll(this.id);
    for (const a of this.deps.asks.listOpen(this.id)) this.deps.asks.cancel(a.id);
    const gone = this.deps.store.purgePartition(this.id, this.now());
    this.deps.sessions.forget(this.id);
    for (const r of this.registry.peers()) this.registry.forget(r.id);
    for (const r of this.policy.rules()) this.policy.forget(r.key);
    this.log.info("a workspace node's data taken away", { node: this.id, why, ...gone });
  }

  /** A workspace for its folder, so its cluster has somewhere to start a session. */
  ensureWorkspace(): void {
    const view = this.deps.workspaces.view(this.id);
    const folder = this.deps.owners.folderOf(this.id) ?? this.manifest.folder;
    if (view.list().some((w) => w.path.toLowerCase() === folder.toLowerCase())) return;
    view.put({ node: this.id, path: folder, name: this.manifest.name });
  }

  /** A sample of this node for its primary, when it watches. */
  deliverSample(sample: Parameters<Outbound["deliverSample"]>[0]): boolean {
    return this.outbound.deliverSample(sample);
  }
}
