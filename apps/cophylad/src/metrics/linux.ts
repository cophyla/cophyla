// Linux: `/proc/stat` for the machine's busy and total ticks and its boot time, `/proc/meminfo`
// for memory, `/proc/<pid>/stat` for every process, whose start is ticks after the boot. The stat line is parsed after its last `)`, since
// a command name may hold spaces and parentheses; a pid that vanished between the listing
// and the read is skipped. `procRoot` is the seam the tests use with a fixture tree.

import { readdirSync, readFileSync } from "node:fs";
import { cpus } from "node:os";
import type { MetricsEngine, RawProcess, RawSample } from "./engine.ts";

const USER_HZ = 100;
const PAGE_BYTES = 4096;

export interface LinuxEngineOptions {
  procRoot?: string;
  cores?: number;
}

/** A `/proc/meminfo` value in bytes, from its `kB` line. */
function meminfoBytes(text: string, key: string): number {
  const at = text.indexOf(key + ":");
  if (at < 0) return 0;
  const end = text.indexOf("\n", at);
  const line = text.slice(at + key.length + 1, end < 0 ? undefined : end).trim();
  return Number(line.split(" ")[0]) * 1024;
}

/** One `/proc/<pid>/stat` line: name, ppid, utime + stime ticks, rss pages, and its start in ticks after the boot. */
export function parseStat(text: string): { name: string; parent: number; ticks: number; rssPages: number; startTicks: number } | undefined {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < 0) return undefined;
  const name = text.slice(open + 1, close);
  // After the `)`: state (3), ppid (4), ..., utime (14), stime (15), ..., starttime (22), vsize (23), rss (24).
  const rest = text.slice(close + 2).split(" ");
  const parent = Number(rest[1]);
  const ticks = Number(rest[11]) + Number(rest[12]);
  const startTicks = Number(rest[19]);
  const rssPages = Number(rest[21]);
  if (!Number.isFinite(parent) || !Number.isFinite(ticks) || !Number.isFinite(rssPages) || !Number.isFinite(startTicks)) return undefined;
  return { name, parent, ticks, rssPages, startTicks };
}

export class LinuxEngine implements MetricsEngine {
  readonly name = "linux";
  private root: string;
  private cores: number;

  constructor(opts: LinuxEngineOptions = {}) {
    this.root = opts.procRoot ?? "/proc";
    this.cores = opts.cores ?? cpus().length;
  }

  sample(): RawSample {
    const at = Date.now();
    const monoNs = process.hrtime.bigint();
    const stat = readFileSync(`${this.root}/stat`, "utf8");
    const line = stat.slice(0, stat.indexOf("\n") < 0 ? undefined : stat.indexOf("\n"));
    const fields = line.trim().split(/\s+/).slice(1, 9).map(Number);
    // user nice system idle iowait irq softirq steal
    const total = fields.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
    const busyNs = ((total - idle) * 1e9) / USER_HZ;
    const totalNs = (total * 1e9) / USER_HZ;
    // The boot, in whole seconds: a process's start is that and its ticks, to within a second.
    const btime = Number(/^btime\s+(\d+)\s*$/m.exec(stat)?.[1]);

    const meminfo = readFileSync(`${this.root}/meminfo`, "utf8");
    const memTotal = meminfoBytes(meminfo, "MemTotal");
    const memAvailable = meminfoBytes(meminfo, "MemAvailable");

    const processes: RawProcess[] = [];
    for (const entry of readdirSync(this.root)) {
      if (!/^\d+$/.test(entry)) continue;
      let text: string;
      try {
        text = readFileSync(`${this.root}/${entry}/stat`, "latin1");
      } catch {
        continue;
      }
      const parsed = parseStat(text);
      if (!parsed) continue;
      processes.push({
        pid: Number(entry),
        parent: parsed.parent,
        name: parsed.name,
        cpuTimeNs: (parsed.ticks * 1e9) / USER_HZ,
        rss: parsed.rssPages * PAGE_BYTES,
        ...(btime > 0 ? { startedAt: btime * 1000 + Math.round((parsed.startTicks * 1000) / USER_HZ) } : {}),
      });
    }
    return { at, monoNs, cores: this.cores, cpu: { busyNs, totalNs }, memory: { used: Math.max(0, memTotal - memAvailable), total: memTotal }, processes };
  }
}
