// The daemon's port, checked before anything is opened: one a stopped daemon's leftovers still
// hold is freed, and one something else holds is named, so a daemon that cannot start says why.
//
// A listening socket stays open while any process holds a handle to it. On Windows a child
// inherited the daemon's sockets (inherit.ts now stops that), and a native sidecar's own
// children outlive it (its stop now ends the tree): a remote-desktop stream worker left from
// an earlier daemon kept 4817 taking connections nobody answered, twice. Such a leftover is
// Cophyla's own helper with its parent gone, never the user's work, so it is ended here; the
// tether hosts, the agents' shims and anything else are only named.

import { join } from "node:path";
import type { Logger } from "./log.ts";

export interface ProcessRow {
  pid: number;
  ppid: number;
  name: string;
  path?: string;
}

export interface PortCheck {
  host: string;
  port: number;
  /** Whether a program is one of Cophyla's own helpers, ended when left without a parent (`helperPaths`). */
  helpers: (path: string) => boolean;
  log: Logger;
  /** Seams for tests. */
  bindable?: (host: string, port: number) => boolean;
  processes?: () => ProcessRow[];
  end?: (pid: number) => boolean;
  holder?: (port: number) => number | undefined;
  wait?: (ms: number) => Promise<void>;
}

/** Whether `host:port` can be listened on now. */
export function bindable(host: string, port: number): boolean {
  try {
    const l = Bun.listen({ hostname: host, port, socket: { data() {} } });
    l.stop(true);
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === "EADDRINUSE" || /in use/i.test(String(e))) return false;
    throw e;
  }
}

/** Every process of the machine with its parent and image, read once (Windows). */
export function windowsProcesses(): ProcessRow[] {
  const r = Bun.spawnSync(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath | ConvertTo-Json -Compress"],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true },
  );
  try {
    const rows = JSON.parse(r.stdout.toString()) as { ProcessId: number; ParentProcessId: number; Name: string; ExecutablePath: string | null }[];
    return rows.map((x) => ({ pid: x.ProcessId, ppid: x.ParentProcessId, name: x.Name, ...(x.ExecutablePath ? { path: x.ExecutablePath } : {}) }));
  } catch {
    return [];
  }
}

/** The pid the system says listens on the port (Windows): the one that opened it, alive or not. */
export function windowsHolder(port: number): number | undefined {
  const r = Bun.spawnSync(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true },
  );
  const pid = Number(r.stdout.toString().trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function endTree(pid: number): boolean {
  return Bun.spawnSync(["taskkill", "/pid", String(pid), "/t", "/f"], { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true }).exitCode === 0;
}

/** Never ended whatever folder it runs from: a tether host holds the user's terminals, a shim belongs to a session. */
const NEVER = /^(tether|cophyla-mcp)(\.exe)?$/i;

/** Cophyla's helpers whose parent is gone: what a stopped daemon left running. */
export function leftovers(rows: ProcessRow[], isHelper: (path: string) => boolean, self = process.pid): ProcessRow[] {
  const alive = new Set(rows.map((r) => r.pid));
  return rows.filter((r) => r.pid !== self && !alive.has(r.ppid) && r.path !== undefined && !NEVER.test(r.name) && isHelper(r.path));
}

/**
 * Makes sure the daemon can listen on its port. Free: nothing to do. Held, on Windows: the
 * helpers a stopped daemon left are ended and the port is tried again for a few seconds.
 * Still held: an error naming what holds it, alive or gone, and the leftovers it saw.
 */
export async function freeOwnPort(c: PortCheck): Promise<"free" | "freed"> {
  const canBind = c.bindable ?? bindable;
  if (c.port === 0 || canBind(c.host, c.port)) return "free";
  if (process.platform !== "win32" && !c.processes) throw new Error(`port ${c.port} is in use: is another cophylad running?`);
  const rows = (c.processes ?? windowsProcesses)();
  const left = leftovers(rows, c.helpers);
  const end = c.end ?? endTree;
  const wait = c.wait ?? ((ms: number) => Bun.sleep(ms));
  if (left.length > 0) {
    c.log.warn("the daemon's port is held: ending what a stopped daemon left running", { port: c.port, processes: left.map((r) => ({ pid: r.pid, name: r.name, path: r.path })) });
    for (const r of left) end(r.pid);
    for (let i = 0; i < 20; i++) {
      if (canBind(c.host, c.port)) {
        c.log.info("the daemon's port is free again", { port: c.port });
        return "freed";
      }
      await wait(250);
    }
  }
  const owner = (c.holder ?? windowsHolder)(c.port);
  const row = owner !== undefined ? rows.find((r) => r.pid === owner) : undefined;
  const who = owner === undefined ? "a process the system does not name" : row ? `${row.name} (pid ${owner}, ${row.path ?? "no path"})` : `pid ${owner}, which has exited: a process it started still holds the socket`;
  const orphans = rows.filter((r) => r.pid !== process.pid && !rows.some((p) => p.pid === r.ppid) && r.ppid > 4).map((r) => `${r.name} ${r.pid}`);
  throw new Error(`port ${c.port} is held by ${who}${left.length > 0 ? `, still after ending ${left.map((r) => `${r.name} ${r.pid}`).join(", ")}` : ""}; processes whose parent is gone: ${orphans.slice(0, 20).join(", ") || "none"}`);
}

/**
 * Cophyla's own helpers: anything under its sidecars' folder, and the direct connections'
 * helper, from a checkout's `data/net` or an install's `bin` and version folders.
 */
export function helperPaths(data: string, installDir?: string): (path: string) => boolean {
  const norm = (x: string) => x.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const folders = [join(data, "sidecars"), join(data, "net")].map(norm);
  const install = installDir !== undefined ? norm(installDir) : undefined;
  return (path) => {
    const p = norm(path);
    if (folders.some((f) => p.startsWith(f + "/"))) return true;
    return install !== undefined && p.startsWith(install + "/") && /\/cophyla-net(\.exe)?$/.test(p);
  };
}
