// Linux: /proc/stat for the machine, /proc/meminfo for memory, /proc/<pid>/stat for every
// process (parent, name, utime + stime, rss). No shell.
//
//   bun run linux.ts       one sample, timings, this process's own row (run in WSL)

import { readdirSync, readFileSync } from "node:fs";
import { cpus } from "node:os";
import type { RawProcess, RawSample } from "./_shared.ts";

const USER_HZ = 100;
const PAGE = 4096;
const cores = cpus().length;

export function sample(root = "/proc"): RawSample {
  const at = Date.now();
  const monoNs = process.hrtime.bigint();
  const stat = readFileSync(`${root}/stat`, "utf8");
  const cpu = stat.split("\n")[0]!.trim().split(/\s+/).slice(1).map(Number);
  // user nice system idle iowait irq softirq steal
  const total = cpu.slice(0, 8).reduce((a, b) => a + b, 0);
  const idle = (cpu[3] ?? 0) + (cpu[4] ?? 0);
  const busyNs = ((total - idle) * 1e9) / USER_HZ;
  const totalNs = (total * 1e9) / USER_HZ;

  const meminfo = readFileSync(`${root}/meminfo`, "utf8");
  const kb = (key: string) => {
    const at = meminfo.indexOf(key + ":");
    if (at < 0) return 0;
    const end = meminfo.indexOf("\n", at);
    const line = meminfo.slice(at + key.length + 1, end < 0 ? undefined : end).trim();
    return Number(line.split(" ")[0]) * 1024;
  };
  const memTotal = kb("MemTotal");
  const memAvail = kb("MemAvailable");

  const processes: RawProcess[] = [];
  for (const entry of readdirSync(root)) {
    if (!/^\d+$/.test(entry)) continue;
    let text: string;
    try {
      text = readFileSync(`${root}/${entry}/stat`, "latin1");
    } catch {
      continue; // gone
    }
    const open = text.indexOf("(");
    const close = text.lastIndexOf(")");
    if (open < 0 || close < 0) continue;
    const name = text.slice(open + 1, close);
    const rest = text.slice(close + 2).split(" ");
    // rest[0] = state (3), [1] = ppid (4), [11] = utime (14), [12] = stime (15), [21] = rss pages (24)
    const parent = Number(rest[1]);
    const utime = Number(rest[11]);
    const stime = Number(rest[12]);
    const rss = Number(rest[21]) * PAGE;
    processes.push({ pid: Number(entry), parent, name, cpuTimeNs: ((utime + stime) * 1e9) / USER_HZ, rss });
  }
  return { at, monoNs, cores, cpu: { busyNs, totalNs }, memory: { used: memTotal - memAvail, total: memTotal }, processes };
}

if (import.meta.main) {
  const t0 = performance.now();
  const s = sample();
  const t1 = performance.now();
  console.log(`processes ${s.processes.length} in ${(t1 - t0).toFixed(2)} ms, cores ${s.cores}`);
  console.log("me:", s.processes.find((p) => p.pid === process.pid), "cpuUsage:", process.cpuUsage(), "rss:", process.memoryUsage().rss);
  console.log("memory:", s.memory, "cpu:", s.cpu);
  const runs: number[] = [];
  for (let i = 0; i < 20; i++) {
    const a = performance.now();
    sample();
    runs.push(performance.now() - a);
  }
  runs.sort((a, b) => a - b);
  console.log(`20 walks: min ${runs[0]!.toFixed(2)} median ${runs[10]!.toFixed(2)} max ${runs[19]!.toFixed(2)} ms`);
}
