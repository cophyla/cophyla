// Owners from the process tree. A root pid claims every descendant not already claimed, in
// the order sessions, sidecars, brain, platform: an ACP agent runs under cophylad, so its
// session must claim it before the platform does; a claimed subtree is never re-entered.
// Everything left is `other`. The walk is breadth-first with a visited set, since a pid
// reused under its own descendant would otherwise loop.

import type { MetricsSample, ProcessOwner } from "@cophyla/protocol";
import type { RawProcess } from "./engine.ts";

export interface OwnerRoots {
  /** Session root pids by session id. */
  sessions: Map<number, string>;
  platform?: number;
  brain?: number;
  /** Sidecar root pids by sidecar name. */
  sidecars: Map<number, string>;
}

export type SampleProcess = MetricsSample["processes"][number];

export function assignOwners(processes: RawProcess[], roots: OwnerRoots): Map<number, ProcessOwner> {
  const known = new Set(processes.map((p) => p.pid));
  const children = new Map<number, number[]>();
  for (const p of processes) {
    if (p.parent === p.pid || !known.has(p.parent)) continue;
    let list = children.get(p.parent);
    if (!list) children.set(p.parent, (list = []));
    list.push(p.pid);
  }
  const owners = new Map<number, ProcessOwner>();
  const claim = (root: number, owner: ProcessOwner) => {
    if (!known.has(root) || owners.has(root)) return;
    const queue = [root];
    const seen = new Set<number>();
    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (seen.has(pid) || owners.has(pid)) continue;
      seen.add(pid);
      owners.set(pid, owner);
      for (const child of children.get(pid) ?? []) queue.push(child);
    }
  };
  for (const [pid, session] of roots.sessions) claim(pid, { kind: "session", session });
  for (const [pid, name] of roots.sidecars) claim(pid, { kind: "sidecar", name });
  if (roots.brain !== undefined) claim(roots.brain, { kind: "brain" });
  if (roots.platform !== undefined) claim(roots.platform, { kind: "platform" });
  return owners;
}

/** Rows a sample carries: every owned process, and the top `keepOther` others by cpu, then memory. */
export const LIVE_OTHERS = 10;
/** The others a stored minute keeps: the busiest by cpu, and the busiest by memory. */
export const ROLLUP_OTHERS = 20;

/**
 * A stored minute's rows. Cophyla's own processes (the platform's and the brain's) are kept one
 * by one; a session's or a sidecar's tree, which holds everything run under it (a session's
 * tools and servers, the shells of tether's terminals: hundreds of processes on a busy desk),
 * is folded into one row for its owner, its cpu and memory summed under its root; of the rest,
 * the `keepOther` busiest by cpu and the `keepOther` busiest by memory. The minute keeps every
 * owner's share at a few kilobytes, where the whole tree was seventy.
 */
export function foldForRollup(list: SampleProcess[], keepOther = ROLLUP_OTHERS): SampleProcess[] {
  const own: SampleProcess[] = [];
  const groups = new Map<string, SampleProcess[]>();
  const others: SampleProcess[] = [];
  for (const p of list) {
    const o = p.owner;
    if (o.kind === "platform" || o.kind === "brain") own.push(p);
    else if (o.kind === "other") others.push(p);
    else {
      const key = o.kind === "session" ? `session:${o.session}` : `sidecar:${o.name}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(p);
    }
  }
  const folded: SampleProcess[] = [];
  for (const g of groups.values()) {
    if (g.length === 1) {
      folded.push(g[0]!);
      continue;
    }
    const pids = new Set(g.map((p) => p.pid));
    const root = g.find((p) => !pids.has(p.parent)) ?? g[0]!;
    const row: SampleProcess = { pid: root.pid, parent: root.parent, name: root.name, cpu: 0, memory: 0, owner: root.owner };
    let vram: number | undefined;
    for (const p of g) {
      row.cpu += p.cpu;
      row.memory += p.memory;
      if (p.vram !== undefined) vram = (vram ?? 0) + p.vram;
    }
    row.cpu = Math.round(row.cpu * 10) / 10;
    if (vram !== undefined) row.vram = vram;
    folded.push(row);
  }
  const byCpu = [...others].sort((a, b) => b.cpu - a.cpu || b.memory - a.memory || a.pid - b.pid).slice(0, keepOther);
  const byMemory = [...others].sort((a, b) => b.memory - a.memory || b.cpu - a.cpu || a.pid - b.pid).slice(0, keepOther);
  const kept = new Set([...byCpu, ...byMemory]);
  return [...own, ...folded, ...others.filter((p) => kept.has(p))];
}

export function trimProcesses(list: SampleProcess[], keepOther: number): SampleProcess[] {
  const owned = list.filter((p) => p.owner.kind !== "other");
  const others = list
    .filter((p) => p.owner.kind === "other")
    .sort((a, b) => b.cpu - a.cpu || b.memory - a.memory || a.pid - b.pid)
    .slice(0, keepOther);
  return [...owned, ...others];
}
