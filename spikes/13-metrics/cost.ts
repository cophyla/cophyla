// What sampling costs: one sample a second for 60 s through the OS engine of this platform
// plus NVML, measuring wall time per walk, the JSON size of a trimmed sample (every owned
// row plus the top 10 others), this process's own CPU share (process.cpuUsage, allowed in the
// spike only: the module never measures itself that way) beside the idlest live harness
// session's share, so "costs less than the sessions it measures" has a number.
//
//   bun run cost.ts [seconds=60] [intervalMs=1000]

import { assignOwners, cpuPercent, processPercents } from "./_shared.ts";
import type { RawSample } from "./_shared.ts";
import * as nvml from "./nvml.ts";

const seconds = Number(process.argv[2] ?? 60);
const intervalMs = Number(process.argv[3] ?? 1000);
const engine = process.platform === "win32" ? await import("./win.ts") : await import("./linux.ts");
const gpu = nvml.init();

const HARNESS = /^(claude|codex)(\.exe)?$/i;

function trimmed(sample: RawSample, percents: Map<number, number>) {
  const owners = assignOwners(sample.processes, { sessions: new Map(), platform: process.pid, sidecars: new Map() });
  const rows = sample.processes.map((p) => ({ pid: p.pid, parent: p.parent, name: p.name, cpu: Math.round((percents.get(p.pid) ?? 0) * 10) / 10, memory: p.rss, owner: owners.get(p.pid) ?? { kind: "other" } }));
  const owned = rows.filter((r) => r.owner.kind !== "other");
  const others = rows
    .filter((r) => r.owner.kind === "other")
    .sort((a, b) => b.cpu - a.cpu || b.memory - a.memory)
    .slice(0, 10);
  return { node: "node_x", at: sample.at, cpu: 0, memory: sample.memory, processes: [...owned, ...others], llm: {} };
}

let prev = engine.sample();
let prevCpu = process.cpuUsage();
let prevAt = performance.now();
const walks: number[] = [];
const gpuWalks: number[] = [];
const sizes: number[] = [];
const own: number[] = [];
const harness: number[] = [];
const end = Date.now() + seconds * 1000;
while (Date.now() < end) {
  await Bun.sleep(intervalMs);
  const t0 = performance.now();
  const next = engine.sample();
  const t1 = performance.now();
  if (gpu) nvml.sample();
  const t2 = performance.now();
  walks.push(t1 - t0);
  gpuWalks.push(t2 - t1);
  const percents = processPercents(prev, next);
  const json = JSON.stringify(trimmed(next, percents));
  sizes.push(json.length);
  const cpu = process.cpuUsage(prevCpu);
  const wall = performance.now() - prevAt;
  own.push(((cpu.user + cpu.system) / 1000 / wall) * 100);
  prevCpu = process.cpuUsage();
  prevAt = performance.now();
  const sessions = next.processes.filter((p) => HARNESS.test(p.name)).map((p) => percents.get(p.pid) ?? 0);
  if (sessions.length) harness.push(Math.min(...sessions) * next.cores);
  prev = next;
}
if (gpu) nvml.shutdown();

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return `mean ${mean.toFixed(2)} median ${s[Math.floor(s.length / 2)]!.toFixed(2)} max ${s[s.length - 1]!.toFixed(2)}`;
};
console.log(`platform ${process.platform}, ${prev.processes.length} processes, ${prev.cores} cores, ${walks.length} samples at ${intervalMs} ms`);
console.log(`walk ms:        ${stats(walks)}`);
if (gpu) console.log(`nvml ms:        ${stats(gpuWalks)}`);
console.log(`trimmed bytes:  ${stats(sizes)}`);
console.log(`own cpu % of one core (whole process, sampling + JSON): ${stats(own)}`);
console.log(`machine cpu %:  ${cpuPercent(prev, engine.sample()).toFixed(1)}`);
if (harness.length) console.log(`idlest harness session, % of one core: ${stats(harness)}`);
else console.log("no claude/codex process running to compare against");
