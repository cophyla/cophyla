// Samples kept apart by partition. The sampler owns every process on the machine, a workspace
// node's sessions' among them. The machine's own audience (its clients, its primary, its
// rollups, the brain's listeners) gets every sample with those processes folded into the
// `other` row; a workspace node's link gets a sample of its own: its node's id, its own
// sessions' processes, everything else as `other`, and the machine's totals (CPU, memory,
// GPUs) as they are, since its primary places work by the pressure it reads there. It gets no
// model counts, no spend and no plan limits: those are the owner's.

import type { MetricsSample } from "@cophyla/protocol";

/** The subscriber id a workspace node's link watches under: never a client's, never the machine's link's. */
export function guestSubscriber(node: string, linkId: string): string {
  return `guest:${node}:${linkId}`;
}

/** The workspace node a subscriber id is a link of, when it is one. */
export function guestOfSubscriber(id: string): string | undefined {
  const m = /^guest:([^:]+):/.exec(id);
  return m?.[1];
}

type Row = MetricsSample["processes"][number];

/** Adds a process into the one `other` row. */
function fold(other: Row | undefined, p: Row): Row {
  const into = other ?? { pid: 0, parent: 0, name: "other", cpu: 0, memory: 0, owner: { kind: "other" } };
  into.cpu += p.cpu;
  into.memory += p.memory;
  if (p.vram !== undefined) into.vram = (into.vram ?? 0) + p.vram;
  return into;
}

/** A sample with the processes of the sessions `drop` names folded into one `other` row; the same sample when there are none. */
export function foldSessions(sample: MetricsSample, drop: (session: string) => boolean): MetricsSample {
  if (!sample.processes.some((p) => p.owner.kind === "session" && drop(p.owner.session))) return sample;
  const kept: Row[] = [];
  let other: Row | undefined;
  for (const p of sample.processes) {
    if (p.owner.kind === "session" && drop(p.owner.session)) other = fold(other, p);
    else kept.push(p);
  }
  return { ...sample, processes: other ? [...kept, other] : kept };
}

/** A workspace node's sample: its id, its own sessions' processes, the rest as `other`, the machine's totals; no counts, spend or limits. */
export function guestSample(sample: MetricsSample, node: string, own: (session: string) => boolean): MetricsSample {
  const kept: Row[] = [];
  let other: Row | undefined;
  for (const p of sample.processes) {
    if (p.owner.kind === "session" && own(p.owner.session)) kept.push(p);
    else other = fold(other, p);
  }
  return {
    node,
    at: sample.at,
    cpu: sample.cpu,
    memory: { ...sample.memory },
    ...(sample.gpu ? { gpu: sample.gpu.map((g) => ({ ...g })) } : {}),
    processes: other ? [...kept, other] : kept,
    llm: {},
  };
}
