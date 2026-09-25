// Ends what drive.ts started, by the pids it wrote: the attach clients, the session, the host.
// A pid is killed only while it still names the program it was recorded for.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pids = JSON.parse(readFileSync(join(import.meta.dir, "out", "pids.json"), "utf8")) as { host?: number; claude?: number; clients: number[] };

function nameOf(pid: number): string | undefined {
  const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
  return /^"([^"]+)"/.exec(r.stdout.trim())?.[1]?.toLowerCase();
}

function end(pid: number | undefined, expected: string): void {
  if (!pid) return;
  const name = nameOf(pid);
  if (name !== expected) {
    console.log(`${pid}: ${name ?? "gone"}, not ${expected}; left alone`);
    return;
  }
  const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" });
  console.log(`${pid} ${expected}: ${(r.stdout || r.stderr).trim()}`);
}

for (const c of pids.clients) end(c, "ptyhost.exe");
end(pids.claude, "claude.exe");
end(pids.host, "ptyhost.exe");
