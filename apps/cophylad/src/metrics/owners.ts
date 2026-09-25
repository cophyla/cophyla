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
export const ROLLUP_OTHERS = 5;

export function trimProcesses(list: SampleProcess[], keepOther: number): SampleProcess[] {
  const owned = list.filter((p) => p.owner.kind !== "other");
  const others = list
    .filter((p) => p.owner.kind === "other")
    .sort((a, b) => b.cpu - a.cpu || b.memory - a.memory || a.pid - b.pid)
    .slice(0, keepOther);
  return [...owned, ...others];
}
