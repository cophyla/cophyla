// Shared by the engines and the cost run: the raw shapes, the tree walk and owner grouping.
// Copied into apps/cophylad/src/metrics after the spike.

export interface RawProcess {
  pid: number;
  parent: number;
  name: string;
  /** user + kernel, cumulative, nanoseconds. */
  cpuTimeNs: number;
  /** Resident set, bytes. */
  rss: number;
}

export interface RawSample {
  at: number;
  monoNs: bigint;
  cores: number;
  cpu: { busyNs: number; totalNs: number };
  memory: { used: number; total: number };
  processes: RawProcess[];
}

export type Owner = { kind: "session"; session: string } | { kind: "platform" } | { kind: "brain" } | { kind: "sidecar"; name: string } | { kind: "other" };

/**
 * Owners from the tree: a root pid claims every descendant not already claimed. Sessions
 * first, then sidecars, the brain, the platform: an ACP agent under cophylad belongs to its
 * session, not to the platform.
 */
export function assignOwners(
  processes: RawProcess[],
  roots: { sessions: Map<number, string>; platform?: number; brain?: number; sidecars: Map<number, string> },
): Map<number, Owner> {
  const children = new Map<number, number[]>();
  const known = new Set(processes.map((p) => p.pid));
  for (const p of processes) {
    if (!known.has(p.parent) || p.parent === p.pid) continue;
    let list = children.get(p.parent);
    if (!list) children.set(p.parent, (list = []));
    list.push(p.pid);
  }
  const owners = new Map<number, Owner>();
  const claim = (root: number, owner: Owner) => {
    if (!known.has(root) || owners.has(root)) return;
    const queue = [root];
    const seen = new Set<number>();
    while (queue.length) {
      const pid = queue.shift()!;
      if (seen.has(pid) || owners.has(pid)) continue;
      seen.add(pid);
      owners.set(pid, owner);
      for (const c of children.get(pid) ?? []) queue.push(c);
    }
  };
  for (const [pid, session] of roots.sessions) claim(pid, { kind: "session", session });
  for (const [pid, name] of roots.sidecars) claim(pid, { kind: "sidecar", name });
  if (roots.brain !== undefined) claim(roots.brain, { kind: "brain" });
  if (roots.platform !== undefined) claim(roots.platform, { kind: "platform" });
  return owners;
}

export function cpuPercent(prev: RawSample, next: RawSample): number {
  const dBusy = next.cpu.busyNs - prev.cpu.busyNs;
  const dTotal = next.cpu.totalNs - prev.cpu.totalNs;
  return dTotal > 0 ? Math.min(100, Math.max(0, (dBusy / dTotal) * 100)) : 0;
}

/** Per process: share of all cores over the interval. */
export function processPercents(prev: RawSample, next: RawSample): Map<number, number> {
  const before = new Map(prev.processes.map((p) => [p.pid, p.cpuTimeNs]));
  const dMono = Number(next.monoNs - prev.monoNs);
  const out = new Map<number, number>();
  for (const p of next.processes) {
    const was = before.get(p.pid);
    if (was === undefined || dMono <= 0) {
      out.set(p.pid, 0);
      continue;
    }
    out.set(p.pid, Math.min(100, Math.max(0, ((p.cpuTimeNs - was) / (dMono * next.cores)) * 100)));
  }
  return out;
}
