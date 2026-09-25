// Direct connections: phones and other nodes reach this node over a WebRTC data channel
// instead of the server's relay, when a path opens between them. The owner switches it on
// per node from the account card; the switch is kept in this node's store, never
// replicated. It runs while switched on, signed in, and on a plan that has it, re-checked at
// every change of the account; then the helper (cophyla-net) holds one UDP port on every
// usable address, learns the public one by STUN, asks the router to map it, and opens the
// channels the signalling asks for. `direct.state` says where it stands, with the channels
// open now; the states of the other nodes arrive on the bus and are kept for a new client.
// TURN credentials come from the server when a phone asks for them, and the paths that open
// are counted for the server's daily report.

import { join } from "node:path";
import { RpcError } from "@cophyla/protocol";
import type { DirectPeer, DirectReport, DirectState, Entitlement } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import type { DirectConfig } from "../config/schema.ts";
import type { Logger } from "../log.ts";
import type { Store } from "../store/index.ts";
import { NetHelper } from "./helper.ts";
import type { HelperSpawner, HelperStatus } from "./helper.ts";
import { PathReport } from "./report.ts";
import { TurnCache } from "./turn.ts";
import type { IceGrant } from "./turn.ts";

/** What the direct module needs of the cloud: who is signed in, the plan, TURN and the report. */
export interface DirectCloud {
  readonly signedIn: boolean;
  entitlement(): Entitlement;
  turnCredentials(): Promise<IceGrant>;
  directReport(report: DirectReport): Promise<void>;
  onUp(fn: () => void): () => void;
}

export interface DirectDeps {
  config: DirectConfig;
  nodeId: string;
  store: Store;
  bus: Bus;
  log: Logger;
  cloud: DirectCloud;
  /** Finds the helper and puts the copy it runs from in place; undefined when there is none. */
  command: () => string | undefined;
  env: Record<string, string | undefined>;
  /** `data/remote`: where the stream viewer's script reads the ICE servers. */
  remoteDir: string;
  spawn?: HelperSpawner;
  now?: () => number;
}

const ENABLED_KEY = "direct_enabled";
const PORT_KEY = "direct_port";

type Phase = Pick<DirectState, "state" | "reason" | "port">;

/** The helper's `net.state`, as far as a client is told: no addresses. */
interface NetView {
  mapping?: DirectState["mapping"];
  ipv6?: boolean;
}

export class Direct {
  private deps: DirectDeps;
  private log: Logger;
  private helper?: NetHelper;
  private phase: Phase = { state: "off" };
  private net: NetView = {};
  private peers = new Map<string, DirectPeer>();
  private others = new Map<string, DirectState>();
  private last?: string;
  private unsubscribe: (() => void)[] = [];
  private listeners = new Set<(method: string, params: unknown) => void>();
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  readonly turn: TurnCache;
  readonly report: PathReport;

  constructor(deps: DirectDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.turn = new TurnCache({ mint: () => deps.cloud.turnCredentials(), stun: deps.config.stun, file: join(deps.remoteDir, "ice-servers.json"), log: deps.log.child("turn"), ...(deps.now ? { now: deps.now } : {}) });
    this.report = new PathReport({ store: deps.store, enabled: deps.config.report, send: (report) => deps.cloud.directReport(report), log: deps.log, ...(deps.now ? { now: deps.now } : {}) });
  }

  start(): void {
    this.unsubscribe.push(
      this.deps.bus.on("account.state", () => void this.evaluate()),
      this.deps.bus.on("direct.state", (s) => {
        if (s.node !== this.deps.nodeId) this.others.set(s.node, s);
      }),
      this.deps.bus.on("node.left", (e) => void this.others.delete(e.node)),
      this.deps.cloud.onUp(() => void this.report.flush()),
    );
    void this.evaluate();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    await this.queue;
    await this.stopHelper();
  }

  // --- the switch -------------------------------------------------------------------------------

  get enabled(): boolean {
    return this.deps.store.meta.get(ENABLED_KEY) === "1";
  }

  /** Why it cannot run on this account now, whatever the switch says. */
  private blocked(): string | undefined {
    if (!this.deps.cloud.signedIn) return "sign in to use direct connections";
    if (!this.deps.cloud.entitlement().hosted.direct) return "the plan has no direct connections";
    return undefined;
  }

  /** Switched on by the owner: refused while it could not run. */
  async enable(): Promise<void> {
    const why = this.blocked();
    if (why) throw new RpcError("unavailable", why);
    if (!this.enabled) this.log.info("direct connections switched on");
    this.deps.store.meta.set(ENABLED_KEY, "1");
    await this.evaluate();
  }

  async disable(): Promise<void> {
    if (this.enabled) this.log.info("direct connections switched off");
    this.deps.store.meta.set(ENABLED_KEY, "0");
    await this.evaluate();
  }

  /** Brings the helper up or down to match the switch and the account; one at a time. */
  evaluate(): Promise<void> {
    this.queue = this.queue.then(() => this.apply()).catch((e: unknown) => this.log.error("direct connections", { error: e instanceof Error ? e.message : String(e) }));
    return this.queue;
  }

  private async apply(): Promise<void> {
    if (this.stopped) return;
    if (!this.enabled) {
      await this.stopHelper();
      this.set({ state: "off" });
      return;
    }
    const why = this.blocked();
    if (why) {
      await this.stopHelper();
      this.set({ state: "unavailable", reason: why });
      return;
    }
    // running, or left unavailable after it kept failing: its own status says which
    if (this.helper) return;
    let command: string | undefined;
    try {
      command = this.deps.command();
    } catch (e) {
      this.set({ state: "unavailable", reason: `the helper could not be put in place: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    if (!command) {
      this.set({ state: "unavailable", reason: "cophyla-net, the helper, was not found" });
      return;
    }
    const config = this.deps.config;
    const helper = new NetHelper({
      command,
      env: this.deps.env,
      log: this.log.child("net"),
      configure: (port) => ({ port, stun: config.stun, predict: config.predict, map: config.map_port, ipv6: config.ipv6 }),
      port: () => (config.port !== 0 ? config.port : Number(this.deps.store.meta.get(PORT_KEY) ?? 0) || 0),
      onPort: (port) => {
        if (config.port === 0) this.deps.store.meta.set(PORT_KEY, String(port));
      },
      onStatus: (s) => this.helperStatus(helper, s),
      onNotification: (method, params) => this.onNotification(method, params),
      backoffMs: config.restart_backoff_ms,
      backoffMaxMs: config.restart_backoff_max_ms,
      ...(this.deps.spawn ? { spawn: this.deps.spawn } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
    });
    this.helper = helper;
    helper.start();
  }

  private async stopHelper(): Promise<void> {
    const helper = this.helper;
    this.helper = undefined;
    this.net = {};
    this.turn.clear();
    if (helper) {
      await helper.stop();
      this.down();
    }
    if (this.peers.size > 0) {
      this.peers.clear();
      this.publish();
    }
  }

  /** The helper's channels are gone: whoever held them hears it. */
  private down(): void {
    for (const fn of this.listeners) fn("helper.down", {});
    if (this.peers.size > 0) {
      this.peers.clear();
      this.publish();
    }
  }

  private helperStatus(helper: NetHelper, s: HelperStatus): void {
    if (this.helper !== helper) return;
    switch (s.state) {
      case "starting":
        // started again after an exit: what the last one held is gone
        if (s.reason) this.down();
        this.set({ state: "starting", ...(s.reason ? { reason: s.reason } : {}) });
        return;
      case "ready":
        this.set({ state: "ready", port: s.port });
        return;
      case "unavailable":
        this.net = {};
        this.down();
        this.set({ state: "unavailable", reason: s.reason });
        return;
      case "stopped":
        return;
    }
  }

  private onNotification(method: string, params: unknown): void {
    if (method === "net.state") {
      const p = (params ?? {}) as { mapping?: { status?: string; protocols?: unknown }; ipv6?: unknown };
      const status = p.mapping?.status;
      const net: NetView = {};
      if (status === "off" || status === "probing" || status === "none" || status === "mapped") {
        net.mapping = { status, ...(Array.isArray(p.mapping?.protocols) ? { protocols: (p.mapping.protocols as unknown[]).filter((x): x is string => typeof x === "string") } : {}) };
      }
      if (typeof p.ipv6 === "boolean") net.ipv6 = p.ipv6;
      this.net = net;
      this.publish();
      return;
    }
    for (const fn of this.listeners) fn(method, params);
  }

  // --- the state --------------------------------------------------------------------------------

  private set(phase: Phase): void {
    this.phase = phase;
    this.publish();
  }

  /** This node's `direct.state`. */
  state(): DirectState {
    const s: DirectState = { node: this.deps.nodeId, state: this.phase.state, peers: [...this.peers.values()] };
    if (this.phase.reason !== undefined) s.reason = this.phase.reason;
    if (this.phase.state === "ready") {
      if (this.phase.port !== undefined) s.port = this.phase.port;
      if (this.net.mapping) s.mapping = this.net.mapping;
      if (this.net.ipv6 !== undefined) s.ipv6 = this.net.ipv6;
    }
    return s;
  }

  /** Every node's last known `direct.state`, this node's first. */
  states(): DirectState[] {
    return [this.state(), ...this.others.values()];
  }

  private publish(): void {
    const s = this.state();
    const text = JSON.stringify(s);
    if (text === this.last) return;
    this.last = text;
    this.deps.bus.emit("direct.state", s);
  }

  get ready(): boolean {
    return this.phase.state === "ready";
  }

  // --- for the channels -----------------------------------------------------------------------

  /** The helper's `peer.*` notifications, for whoever holds channels, and `helper.down` when it went. */
  onPeer(fn: (method: string, params: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** A request to the helper; `unavailable` while it is not ready. */
  request(method: string, params: unknown): Promise<unknown> {
    if (!this.helper) return Promise.reject(new RpcError("unavailable", "direct connections are not running on this node"));
    return this.helper.request(method, params);
  }

  notify(method: string, params: unknown): boolean {
    return this.helper?.notify(method, params) ?? false;
  }

  /** A channel opened or moved: it shows in `direct.state`. */
  setPeer(key: string, peer: DirectPeer): void {
    this.peers.set(key, peer);
    this.publish();
  }

  dropPeer(key: string): void {
    if (this.peers.delete(key)) this.publish();
  }

  /** ICE servers for a phone: the server's TURN set, or STUN alone without one, while direct connections run here. */
  async iceServers(): Promise<IceGrant> {
    if (!this.ready) throw new RpcError("unavailable", "direct connections are not running on this node");
    return this.turn.get();
  }

  get pid(): number | undefined {
    return this.helper?.pid;
  }
}
