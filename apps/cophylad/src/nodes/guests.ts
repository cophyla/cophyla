// The workspace nodes this machine hosts, from their manifests under `data/nodes/`: each one
// started after the machine's own membership and stopped before it, and what the terminal
// asks of them (`cophyla node add|list|join|leave|remove`). Adding one checks the folder,
// makes the node an id of its own, lends it the folder and joins it to the cluster whose
// invite was given; removing one ends its sessions, leaves its cluster, takes away what it
// held (its sessions' ids kept as tombstones), retires its id and deletes its files.

import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parseInvite, RpcError } from "@cophyla/protocol";
import type { MetricsSample } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import type { Paths } from "../config/load.ts";
import type { Config } from "../config/schema.ts";
import type { Asks } from "../gate/asks.ts";
import type { Audit } from "../gate/audit.ts";
import type { Logger } from "../log.ts";
import type { Metrics } from "../metrics/index.ts";
import { guestOfSubscriber } from "../metrics/guest.ts";
import type { Sessions } from "../sessions/index.ts";
import type { Profiles } from "../sessions/profiles.ts";
import { Store } from "../store/index.ts";
import type { Tools } from "../tools/index.ts";
import type { Workspaces } from "../workspaces/index.ts";
import { GuestMember } from "./guest.ts";
import type { GuestState } from "./guest.ts";
import { addRetired, guestFiles, guestsRoot, newSlug, readGuests, removeGuestDir, writeManifest } from "./guest-files.ts";
import type { GuestManifest } from "./guest-files.ts";
import type { Owners } from "./owners.ts";
import { loadNodeIdentity } from "./self.ts";
import type { NodeIdentity } from "./self.ts";

/** A workspace node as `cophyla node list` shows it. */
export interface GuestInfo {
  id: string;
  name: string;
  folder: string;
  profile?: string;
  state: GuestState;
  cluster?: string;
  primary?: { id: string; name: string };
  via?: "direct" | "relay";
  expiresAt?: number;
}

export interface GuestsDeps {
  paths: Paths;
  config: Config;
  bus: Bus;
  asks: Asks;
  audit: Audit;
  sessions: Sessions;
  workspaces: Workspaces;
  profiles: Pick<Profiles, "get" | "defaultFor" | "launch">;
  tools: Pick<Tools, "list" | "risk" | "source" | "run">;
  store: Store;
  metrics?: Metrics;
  owners: Owners;
  identity: NodeIdentity;
  /** The machine's own membership: its cluster, and the nodes its registry knows. */
  machine: { cluster(): string | undefined; knows(node: string): boolean };
  platformVersion: string;
  log: Logger;
  now?: () => number;
}

interface Entry {
  dir: string;
  member: GuestMember;
}

export class Guests {
  private deps: GuestsDeps;
  private log: Logger;
  private entries = new Map<string, Entry>();
  private started = false;
  private stopped = false;
  /** One change at a time: an add, a join, a leave or a remove. */
  private busy: Promise<unknown> = Promise.resolve();

  constructor(deps: GuestsDeps) {
    this.deps = deps;
    this.log = deps.log;
    for (const g of readGuests(deps.paths.data)) {
      if (!deps.owners.isGuest(g.manifest.id)) deps.owners.add(g.manifest.id, g.manifest.folder);
      this.entries.set(g.manifest.id, { dir: g.dir, member: this.build(g.manifest, g.dir) });
    }
  }

  private build(manifest: GuestManifest, dir: string): GuestMember {
    const { deps } = this;
    const id = manifest.id;
    return new GuestMember({
      manifest,
      dir,
      config: deps.config,
      bus: deps.bus,
      asks: deps.asks,
      audit: deps.audit,
      sessions: deps.sessions,
      workspaces: deps.workspaces,
      profiles: deps.profiles,
      tools: deps.tools,
      store: deps.store,
      ...(deps.metrics ? { metrics: deps.metrics } : {}),
      owners: deps.owners,
      knownElsewhere: (node) => node === deps.identity.id || deps.machine.knows(node) || [...this.entries.entries()].some(([other, e]) => other !== id && (other === node || e.member.knows(node))),
      otherClusters: () => [deps.machine.cluster(), ...[...this.entries.entries()].filter(([other]) => other !== id).map(([, e]) => e.member.member()?.cluster)].filter((c): c is string => c !== undefined),
      platformVersion: deps.platformVersion,
      log: this.log.child(manifest.name),
      ...(deps.now ? { now: deps.now } : {}),
    });
  }

  /** Starts every workspace node: after the machine's own membership. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const e of this.entries.values()) e.member.start();
    if (this.entries.size > 0) this.log.info("workspace nodes up", { count: this.entries.size });
  }

  /** Stops every one: before the machine's own membership. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const e of this.entries.values()) await e.member.stop();
  }

  private info(m: GuestMember): GuestInfo {
    const member = m.member();
    const via = m.via();
    return {
      id: m.id,
      name: m.manifest.name,
      folder: m.manifest.folder,
      ...(m.manifest.profile !== undefined ? { profile: m.manifest.profile } : {}),
      state: m.state,
      ...(member ? { cluster: member.cluster, ...(member.primary ? { primary: member.primary } : {}), ...(member.expiresAt !== undefined ? { expiresAt: member.expiresAt } : {}) } : {}),
      ...(via && m.linked() ? { via } : {}),
    };
  }

  list(): GuestInfo[] {
    return [...this.entries.values()].map((e) => this.info(e.member)).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A workspace node by its name or id. */
  private find(name: string): { id: string; entry: Entry } {
    for (const [id, entry] of this.entries) if (id === name || entry.member.manifest.name.toLowerCase() === name.toLowerCase()) return { id, entry };
    throw new RpcError("not_found", `no workspace node ${name}`);
  }

  /** Every workspace node's member, for the tests. */
  member(name: string): GuestMember {
    return this.find(name).entry.member;
  }

  /** The clusters the workspace nodes are in: the machine joins none of them. */
  clusters(): string[] {
    return [...this.entries.values()].map((e) => e.member.member()?.cluster).filter((c): c is string => c !== undefined);
  }

  /** Whether a node is a workspace node here or known to one's registry: the machine takes no invite from it. */
  knows(node: string): boolean {
    return [...this.entries.entries()].some(([id, e]) => id === node || e.member.knows(node));
  }

  /** A sample for the workspace node a `guest:<node>:<link>` subscriber is a link of. */
  deliverSample(subscriber: string, sample: MetricsSample): boolean {
    const node = guestOfSubscriber(subscriber);
    const e = node !== undefined ? this.entries.get(node) : undefined;
    return e?.member.deliverSample(sample) ?? false;
  }

  /** The harnesses changed: each workspace node's cluster hears its row again. */
  announce(): void {
    for (const e of this.entries.values()) if (e.member.linked()) e.member.announce();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => undefined);
    return run;
  }

  /**
   * Whether a folder may be lent, and as what name: the folder resolved, and the name the
   * node will go by. The profile, when named, must be one of this machine's.
   */
  check(opts: { folder: string; name?: string; profile?: string }): { folder: string; name: string } {
    const { deps } = this;
    const folder = deps.owners.check(opts.folder, { machineSessionsIn: (inside) => deps.sessions.list().filter((s) => inside(s.cwd)).length });
    const name = (opts.name ?? basename(folder)).trim() || folder;
    if ([...this.entries.values()].some((e) => e.member.manifest.name.toLowerCase() === name.toLowerCase())) throw new RpcError("conflict", `a workspace node is called ${name} already: give another --name`);
    if (opts.profile !== undefined) {
      const p = deps.profiles.get(opts.profile);
      if (!p) throw new RpcError("not_found", `no profile ${opts.profile}`);
      if (p.harness !== "claude" && p.harness !== "codex" && p.harness !== "muse") throw new RpcError("invalid", `profile ${opts.profile} is not one a workspace node's sessions can run on`);
    }
    return { folder, name };
  }

  /**
   * Lends a folder to another person's cluster: checked, given an id of its own, and joined
   * with the invite. When the join fails, nothing is left of it.
   */
  add(opts: { folder: string; name?: string; profile?: string; invite: string }): Promise<GuestInfo> {
    return this.serial(async () => {
      if (this.stopped) throw new RpcError("unavailable", "the daemon is stopping");
      const { deps } = this;
      const { folder, name } = this.check(opts);
      try {
        const body = parseInvite(opts.invite);
        if (body.kind !== "node") throw new Error("that invite is for a phone, not a node");
      } catch (e) {
        throw new RpcError("invalid", e instanceof Error ? e.message : String(e));
      }
      const slug = newSlug(deps.paths.data, name);
      const dir = join(guestsRoot(deps.paths.data), slug);
      // its identity, made in its own store as the machine's is in the machine's
      mkdirSync(dir, { recursive: true });
      const store = new Store(guestFiles(dir).db);
      let id: string;
      try {
        store.migrate();
        id = loadNodeIdentity(store, deps.config).id;
      } finally {
        store.close();
      }
      const manifest: GuestManifest = { v: 1, id, name, folder, ...(opts.profile !== undefined ? { profile: opts.profile } : {}) };
      writeManifest(dir, manifest);
      deps.owners.add(id, folder);
      const member = this.build(manifest, dir);
      this.entries.set(id, { dir, member });
      member.start();
      try {
        member.ensureWorkspace();
        await member.join(opts.invite);
      } catch (e) {
        this.entries.delete(id);
        await member.stop();
        deps.store.purgePartition(id);
        deps.owners.drop(id);
        removeGuestDir(dir);
        throw e;
      }
      this.log.info("a workspace node added", { node: id, name, folder });
      return this.info(member);
    });
  }

  /** Joins a workspace node that is in no cluster to one, with a fresh invite. */
  join(name: string, invite: string): Promise<GuestInfo> {
    return this.serial(async () => {
      const { entry } = this.find(name);
      await entry.member.join(invite);
      return this.info(entry.member);
    });
  }

  /** Leaves its cluster for good; what it holds here stays until it joins another or is removed. */
  leave(name: string): Promise<GuestInfo> {
    return this.serial(async () => {
      const { entry } = this.find(name);
      await entry.member.leave();
      return this.info(entry.member);
    });
  }

  /** Removes a workspace node: its sessions end, it leaves, its data goes, its id is retired, its files deleted. */
  remove(name: string): Promise<void> {
    return this.serial(async () => {
      const { deps } = this;
      const { id, entry } = this.find(name);
      const m = entry.member;
      await deps.sessions.endAll(id);
      for (const a of deps.asks.listOpen(id)) deps.asks.cancel(a.id);
      if (m.member()) await m.leave();
      this.entries.delete(id);
      await m.stop();
      const gone = deps.store.purgePartition(id);
      deps.sessions.forget(id);
      deps.owners.retire(id);
      addRetired(deps.paths.data, id);
      removeGuestDir(entry.dir);
      this.log.info("a workspace node removed", { node: id, name: m.manifest.name, ...gone });
    });
  }
}
