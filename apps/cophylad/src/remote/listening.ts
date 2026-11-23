// What listens on this machine, for `ports.list`: the TCP ports a program serves on the
// loopback or on every address, which a page opened from another device reaches as if it sat
// here, with the program where the system names it. Read with what each system ships:
// `netstat -ano` on Windows (its two tables, fast where PowerShell's own listing takes a second
// or two, the programs named from the process list), `lsof` on macOS, and on Linux `ss`, which
// names the user's own programs, or `/proc/net/tcp` without names where there is no `ss`. A
// listener on one address of the network alone is left out: the host connects to its loopback
// only. So are Cophyla's own ports (the daemon's, its listeners and forwarders, its sidecars' and
// what they start), by the programs that hold them; a page the user's terminal or an agent
// serves is the user's, whoever started it. So are the system's: a port under 1024, and one a
// service of the system holds (`SYSTEM_PROGRAMS`), never a page anyone is building; such a port
// can still be typed by hand.

import type { ListeningPort } from "@cophyla/protocol";
import type { HostOs } from "../update/platform.ts";
import type { Exec } from "../sidecars/tts-py.ts";
import type { ProcessRow } from "../portheld.ts";

/** One listening socket as a system's tool lists it. */
export interface Listener {
  port: number;
  family: 4 | 6;
  pid?: number;
  process?: string;
}

/** Whether an address is one a page of this machine's loopback reaches: a loopback one, or every address. */
function reachable(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  return a === "0.0.0.0" || a === "*" || a === "::" || a === "::1" || /^127\.\d+\.\d+\.\d+$/.test(a) || a === "::ffff:127.0.0.1" || a === "::ffff:0.0.0.0";
}

/** `host:port` or `[host]:port`, split at the last colon. */
function splitAddress(text: string): { host: string; port: number } | undefined {
  const at = text.lastIndexOf(":");
  if (at <= 0) return undefined;
  const port = Number(text.slice(at + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host: text.slice(0, at), port };
}

/**
 * Windows' `netstat -ano -p TCP` or `-p TCPv6`: a listening socket is one whose far address
 * is all zeros (the state's word is the system language's, so it is not read).
 */
export function parseNetstat(text: string, family: 4 | 6): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[0]!.toUpperCase() !== "TCP") continue;
    const local = splitAddress(cols[1]!);
    const far = cols[2]!;
    if (!local || (far !== "0.0.0.0:0" && far !== "[::]:0")) continue;
    if (!reachable(local.host)) continue;
    const pid = Number(cols[cols.length - 1]);
    out.push({ port: local.port, family, ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}) });
  }
  return out;
}

/** macOS' `lsof -nP -iTCP -sTCP:LISTEN -F pctn`: a process (`p`, `c`), then each of its sockets (`t` the family, `n` the address). */
export function parseLsof(text: string): Listener[] {
  const out: Listener[] = [];
  let pid: number | undefined;
  let name: string | undefined;
  let family: 4 | 6 | undefined;
  for (const line of text.split(/\r?\n/)) {
    const kind = line[0];
    const value = line.slice(1);
    if (kind === "p") {
      pid = Number(value);
      name = undefined;
      family = undefined;
    } else if (kind === "c") name = value;
    else if (kind === "f") family = undefined;
    else if (kind === "t") family = value === "IPv6" ? 6 : value === "IPv4" ? 4 : undefined;
    else if (kind === "n") {
      // a listener's name is its own address alone; a connection's says `->` and its far end
      if (value.includes("->")) continue;
      const local = splitAddress(value);
      if (!local || !reachable(local.host)) continue;
      const fam = family ?? (local.host.includes(":") ? 6 : 4);
      out.push({ port: local.port, family: fam, ...(pid !== undefined && Number.isInteger(pid) ? { pid } : {}), ...(name ? { process: name } : {}) });
    }
  }
  return out;
}

/** Linux's `ss -Hltnp`: the local address is the fourth column; the process, where the user may see it, `users:(("name",pid=…`. */
export function parseSs(text: string): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const local = splitAddress(cols[3]!);
    if (!local || !reachable(local.host)) continue;
    const users = /users:\(\("([^"]*)",pid=(\d+)/.exec(line);
    // `*` listens on both families where the system lets one socket take both
    const families: (4 | 6)[] = local.host === "*" ? [4, 6] : local.host.startsWith("[") ? [6] : [4];
    for (const family of families) out.push({ port: local.port, family, ...(users ? { pid: Number(users[2]), process: users[1]! } : {}) });
  }
  return out;
}

/** An address as `/proc/net/tcp` writes it: 32-bit words in hex, each in the machine's byte order (little-endian). */
function procAddress(hex: string): string {
  const words = hex.match(/.{8}/g) ?? [];
  const bytes = words.flatMap((w) => [w.slice(6, 8), w.slice(4, 6), w.slice(2, 4), w.slice(0, 2)].map((b) => parseInt(b, 16)));
  if (bytes.length === 4) return bytes.join(".");
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  const all = groups.join(":");
  if (all === "0:0:0:0:0:0:0:0") return "::";
  if (all === "0:0:0:0:0:0:0:1") return "::1";
  if (all.startsWith("0:0:0:0:0:ffff:")) return `::ffff:${bytes.slice(12).join(".")}`;
  return all;
}

/** `/proc/net/tcp` or `/proc/net/tcp6`: state `0A` is a listener; no program is named. */
export function parseProcNet(text: string, family: 4 | 6): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[3] !== "0A") continue;
    const [addr, portHex] = (cols[1] ?? "").split(":");
    if (!addr || !portHex) continue;
    const port = parseInt(portHex, 16);
    if (!(port > 0) || !reachable(procAddress(addr))) continue;
    out.push({ port, family });
  }
  return out;
}

/** The processes, their parents and names, from `ps -A -o pid=,ppid=,comm=`, as macOS and Linux print them. */
export function parsePs(text: string): ProcessRow[] {
  const out: ProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3]!.trim().split("/").pop() ?? "" });
  }
  return out;
}

/** Every process descended from `roots`, the roots included: what Cophyla runs. */
export function descendants(rows: ProcessRow[], roots: number[]): Set<number> {
  const out = new Set(roots);
  const children = new Map<number, number[]>();
  for (const r of rows) {
    if (r.pid === r.ppid) continue;
    const list = children.get(r.ppid) ?? [];
    list.push(r.pid);
    children.set(r.ppid, list);
  }
  const queue = [...roots];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}

/** The lowest port a page being built is looked for on: the ones under it are the system's. */
export const LOWEST_LISTED = 1024;

/**
 * Programs of the system itself, by name (lower case, no `.exe`): Windows' services and its
 * hosts, macOS' and Linux's daemons. What they listen on is never a page anyone is building.
 */
export const SYSTEM_PROGRAMS: ReadonlySet<string> = new Set([
  "system", "idle", "svchost", "lsass", "lsaiso", "services", "wininit", "winlogon", "csrss", "smss", "spoolsv", "msmpeng", "nissrv", "searchindexer", "searchhost", "dashost", "wudfhost", "fontdrvhost", "audiodg", "dllhost", "taskhostw", "sihost", "ctfmon", "mdnsresponder", "jhi_service", "lms", "ipoverusbsvc", "wlanext", "nvcontainer", "nvdisplay.container", "officeclicktorun", "memory compression", "registry", "secure system", "vmms", "vmcompute", "wslservice", "edgeupdate", "msedgewebview2",
  "launchd", "controlcenter", "rapportd", "sharingd", "airplayxpchelper", "mdnsresponder", "cupsd", "sshd", "systemd", "systemd-resolved", "systemd-networkd", "rpcbind", "avahi-daemon", "dnsmasq", "chronyd", "ntpd", "cups-browsed", "exim4", "master", "smbd", "nmbd", "containerd", "dockerd",
]);

/** Whether a program is the system's own, by its name as the process list gives it. */
export function systemProgram(name: string | undefined): boolean {
  if (!name) return false;
  const base = name.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
  return SYSTEM_PROGRAMS.has(base);
}

/** The listeners merged a row a port, by its number, with the program named where one was, Cophyla's own and the system's left out. */
export function mergeListeners(listeners: Listener[], names: Map<number, string>, own: Set<number>): ListeningPort[] {
  const byPort = new Map<number, ListeningPort>();
  const ours = new Set<number>();
  for (const l of listeners) {
    if (l.pid !== undefined && own.has(l.pid)) {
      ours.add(l.port);
      continue;
    }
    const row = byPort.get(l.port) ?? { port: l.port, v4: false, v6: false };
    if (l.family === 4) row.v4 = true;
    else row.v6 = true;
    const name = l.process ?? (l.pid !== undefined ? names.get(l.pid) : undefined);
    if (name && row.process === undefined) row.process = name.slice(0, 200);
    byPort.set(l.port, row);
  }
  // a port Cophyla holds on one address is its own on the other too; the system's are never a page being built
  return [...byPort.values()].filter((r) => !ours.has(r.port) && r.port >= LOWEST_LISTED && !systemProgram(r.process)).sort((a, b) => a.port - b.port);
}

export interface ListDeps {
  os: HostOs;
  exec: Exec;
  /** The daemon itself: its ports are Cophyla's own, and its children's are not (a terminal's, an agent's). */
  own: () => number[];
  /** Cophyla's helpers (its sidecars): their ports, and their children's, are Cophyla's own. */
  helpers?: () => number[];
  /** Every process with its parent and name (Windows; `ps` elsewhere). */
  processes?: () => ProcessRow[] | Promise<ProcessRow[]>;
  readFile?: (path: string) => Promise<string | undefined>;
}

/** Every process of a Windows machine with its parent and image, read without holding the daemon up (`windowsProcesses` reads them at once, for the start). */
export async function windowsProcessesAsync(exec: Exec): Promise<ProcessRow[]> {
  const text = await run(exec, ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"]);
  try {
    const rows = JSON.parse(text ?? "[]") as { ProcessId: number; ParentProcessId: number; Name: string }[];
    return (Array.isArray(rows) ? rows : [rows]).map((x) => ({ pid: x.ProcessId, ppid: x.ParentProcessId, name: x.Name }));
  } catch {
    return [];
  }
}

async function run(exec: Exec, command: string[]): Promise<string | undefined> {
  try {
    const r = await exec(command, {});
    return r.code === 0 ? r.stdout : undefined;
  } catch {
    return undefined;
  }
}

/** What listens on this machine's loopback and every address now, a row a port. */
export async function listPorts(deps: ListDeps): Promise<ListeningPort[]> {
  let listeners: Listener[] = [];
  let rows: ProcessRow[] = [];
  if (deps.os === "windows") {
    const [v4, v6, procs] = await Promise.all([run(deps.exec, ["netstat", "-ano", "-p", "TCP"]), run(deps.exec, ["netstat", "-ano", "-p", "TCPv6"]), Promise.resolve(deps.processes?.() ?? [])]);
    listeners = [...parseNetstat(v4 ?? "", 4), ...parseNetstat(v6 ?? "", 6)];
    rows = procs;
  } else {
    const ps = run(deps.exec, ["ps", "-A", "-o", "pid=,ppid=,comm="]);
    if (deps.os === "macos") {
      listeners = parseLsof((await run(deps.exec, ["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pctn"])) ?? "");
    } else {
      const ss = await run(deps.exec, ["ss", "-Hltnp"]);
      if (ss !== undefined) listeners = parseSs(ss);
      else {
        const read = deps.readFile ?? (async (p: string) => Bun.file(p).text().catch(() => undefined));
        listeners = [...parseProcNet((await read("/proc/net/tcp")) ?? "", 4), ...parseProcNet((await read("/proc/net/tcp6")) ?? "", 6)];
      }
    }
    rows = deps.processes ? await deps.processes() : parsePs((await ps) ?? "");
  }
  const names = new Map(rows.map((r) => [r.pid, r.name] as const));
  const own = descendants(rows, deps.helpers?.() ?? []);
  for (const pid of deps.own()) own.add(pid);
  return mergeListeners(listeners, names, own);
}
