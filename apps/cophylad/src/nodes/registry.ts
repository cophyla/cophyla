// The node registry: every node of the user as this node last saw it, in memory and in the
// store's `nodes` table, so a secondary that loses the primary still knows which backups to
// try and in what order. `list()` puts this node first. Changes go out on the bus as
// `node.state` (to clients) and `node.joined` / `node.left` (to the event stream).

import type { Node, NodeRecord } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import type { Store } from "../store/index.ts";

export interface RegistryDeps {
  store: Store;
  bus: Pick<Bus, "emit">;
  self: () => Node;
  /** How this node is reached: the LAN listener's endpoints. */
  selfEndpoints: () => string[];
  selfRank: () => number | undefined;
  now?: () => number;
}

export class Registry {
  private deps: RegistryDeps;
  private rows = new Map<string, NodeRecord>();

  constructor(deps: RegistryDeps) {
    this.deps = deps;
    for (const row of deps.store.nodes.list()) if (row.id !== deps.self().id) this.rows.set(row.id, { ...row, status: "offline" });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** This node's own row, from the live `Node` and the listener. */
  self(): NodeRecord {
    const node = this.deps.self();
    const rank = this.deps.selfRank();
    return { ...node, endpoints: this.deps.selfEndpoints(), ...(rank !== undefined ? { rank } : {}) };
  }

  /** Every node, this one first, the rest by name. */
  list(): NodeRecord[] {
    const others = [...this.rows.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return [this.self(), ...others];
  }

  get(id: string): NodeRecord | undefined {
    return id === this.deps.self().id ? this.self() : this.rows.get(id);
  }

  /** The other nodes only. */
  peers(): NodeRecord[] {
    return this.list().slice(1);
  }

  /** Records a node as seen now; announces its row. `joined` also raises `node.joined`. This node's own row is never stored. */
  upsert(record: NodeRecord, opts: { joined?: boolean } = {}): NodeRecord {
    if (record.id === this.deps.self().id) return this.self();
    const row: NodeRecord = { ...record, lastSeen: this.now() };
    this.rows.set(row.id, row);
    this.deps.store.nodes.upsert(row);
    this.deps.bus.emit("node.state", row);
    if (opts.joined) this.deps.bus.emit("node.joined", row);
    return row;
  }

  /** Takes a registry from the primary: every row but this node's, marked as the primary said. */
  take(records: NodeRecord[]): void {
    const self = this.deps.self().id;
    for (const r of records) {
      if (r.id === self) continue;
      this.rows.set(r.id, r);
      this.deps.store.nodes.upsert(r);
      this.deps.bus.emit("node.state", r);
    }
  }

  /** A node went away: its row stays, offline. Raises `node.left` when it was online. */
  markOffline(id: string): NodeRecord | undefined {
    const row = this.rows.get(id);
    if (!row) return undefined;
    const wasOnline = row.status === "online";
    // gone, it has no data channel either
    const { p2p: _gone, ...rest } = row;
    const next: NodeRecord = { ...rest, status: "offline", lastSeen: this.now() };
    this.rows.set(id, next);
    this.deps.store.nodes.upsert(next);
    this.deps.bus.emit("node.state", next);
    if (wasOnline) this.deps.bus.emit("node.left", { node: id, at: this.now() });
    return next;
  }

  /** This node took the primary role: every other row that still says primary is from before, and says secondary now. */
  demoteOthers(): void {
    for (const row of [...this.rows.values()]) {
      if (row.role !== "primary") continue;
      const next: NodeRecord = { ...row, role: "secondary", capabilities: { ...row.capabilities, brain: false } };
      this.rows.set(row.id, next);
      this.deps.store.nodes.upsert(next);
      this.deps.bus.emit("node.state", next);
    }
  }

  /** Every peer marked offline: what a secondary does when its link drops and nothing else is known. */
  markAllOffline(): void {
    for (const id of [...this.rows.keys()]) this.markOffline(id);
  }

  /** The backups by rank, then by id: the order a secondary tries them and the order they promote in. */
  backups(): NodeRecord[] {
    return [...this.rows.values()].filter((r) => r.backup).sort((a, b) => (a.rank ?? 1) - (b.rank ?? 1) || a.id.localeCompare(b.id));
  }

  /** The node the registry last knew as primary, if any. */
  primary(): NodeRecord | undefined {
    return [...this.rows.values()].find((r) => r.role === "primary");
  }

  endpointsOf(id: string): string[] {
    return this.rows.get(id)?.endpoints ?? [];
  }

  forget(id: string): void {
    this.rows.delete(id);
    this.deps.store.nodes.delete(id);
  }
}
