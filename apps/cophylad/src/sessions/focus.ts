// `session.focus`: raise the window that owns a session's process, by walking the process
// tree up from the pid to the nearest ancestor that has a window. One raiser per platform:
// Windows walks with PowerShell and `SetForegroundWindow`; macOS walks with `ps` and asks
// System Events for the nearest ancestor that is a GUI process, which needs the Automation
// permission, and in Terminal and iTerm2 selects the session's own tab by its tty (iTerm2
// runs its shells under an `iTermServer` that launchd adopts, so the app is not an ancestor
// at all); Linux walks `/proc` and activates through `xdotool` (X11 and XWayland windows)
// or `wmctrl`, and is unsupported without a display. Every command runs through an
// injectable `Exec`, so the parsers are tested with canned output on any host. The process
// walk stands on its own as `ProcessTree`: Codex's pid discovery needs it where raising is
// not possible (no display, no permission). The same walkers read a process's command line
// (`ProcessArgs`), which is how a Claude session's launch flags are known. The daemon's raiser
// walks over the metrics engine's process table where it reads (`withProcessTable`).

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Logger } from "../log.ts";
import { darwinArgv, installNameOf } from "../metrics/macos.ts";

/**
 * `denied`: the OS refused the permission raising needs (macOS's Automation); `waiting`: the
 * request for it is still on screen, unanswered.
 */
export type RaiseResult = "raised" | "not_found" | "unsupported" | "denied" | "waiting";

export interface ProcessInfo {
  pid: number;
  name: string;
}

export interface ProcessTree {
  /** The process and its ancestors, nearest first; empty where unsupported. */
  ancestors(pid: number): Promise<ProcessInfo[]>;
  /** Several processes' chains from one read of the whole table, where one walk per process costs much more. */
  ancestorsOf?(pids: number[]): Promise<Map<number, ProcessInfo[]>>;
}

export interface ProcessArgs {
  /** The process's command line as its arguments, the program first; `undefined` when it cannot be read. */
  commandLine(pid: number): Promise<string[] | undefined>;
}

export interface WindowRaiser extends ProcessTree, ProcessArgs {
  raise(pid: number): Promise<RaiseResult>;
}

/**
 * A Windows command line split the way the C runtime splits it: whitespace outside quotes
 * separates, a quote toggles quoting, `""` inside quotes is a quote, and backslashes are
 * literal unless they run into a quote (2n of them make n and the quote toggles; 2n+1 make n
 * and a literal quote).
 */
export function splitWindowsCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\") {
      let n = 0;
      while (line[i + n] === "\\") n++;
      if (line[i + n] === '"') {
        cur += "\\".repeat(Math.floor(n / 2));
        if (n % 2 === 1) cur += '"';
        else quoted = !quoted;
        i += n;
      } else {
        cur += "\\".repeat(n);
        i += n - 1;
      }
      started = true;
    } else if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        quoted = !quoted;
      }
      started = true;
    } else if ((ch === " " || ch === "\t") && !quoted) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

export interface ExecResult {
  /** The exit code; `null` when the command could not be started or was killed at the timeout. */
  code: number | null;
  out: string;
  err: string;
  /** Killed at the timeout, rather than never started. */
  timedOut?: boolean;
}

export type Exec = (file: string, args: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>;

/** Runs a command with no stdin, collecting its output; never rejects. */
export function runCommand(file: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      resolve({ code: null, out: "", err: "" });
      return;
    }
    let out = "";
    let err = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (out += d));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => (err += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs ?? 15000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, out, err });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(timedOut ? { code: null, out, err, timedOut } : { code, out, err });
    });
  });
}

// --- Windows ------------------------------------------------------------------------------

const RAISE_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace Cophyla -Name W -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
'@
$cur = [int]$args[0]
$seen = @{}
while ($cur -gt 0 -and -not $seen.ContainsKey($cur)) {
  $seen[$cur] = $true
  $p = Get-Process -Id $cur
  if ($p -and $p.MainWindowHandle -ne 0) {
    $h = $p.MainWindowHandle
    if ([Cophyla.W]::IsIconic($h)) { [void][Cophyla.W]::ShowWindow($h, 9) }
    [void][Cophyla.W]::SetForegroundWindow($h)
    Write-Output ("raised " + $cur)
    exit 0
  }
  $w = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $cur)
  if (-not $w) { break }
  $cur = [int]$w.ParentProcessId
}
Write-Output "none"
exit 1
`;

const ANCESTORS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$cur = [int]$args[0]
$seen = @{}
while ($cur -gt 0 -and -not $seen.ContainsKey($cur)) {
  $seen[$cur] = $true
  $w = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $cur)
  if (-not $w) { break }
  Write-Output ("" + $w.ProcessId + " " + $w.Name)
  $cur = [int]$w.ParentProcessId
}
`;

/** Every process as `pid ppid name`, from one query: about a second, where each step of the walk above costs a query of its own. */
const PROCESS_TABLE_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
foreach ($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name) {
  Write-Output ("" + $p.ProcessId + " " + $p.ParentProcessId + " " + $p.Name)
}
`;

const COMMAND_LINE_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$w = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$args[0])
if (-not $w -or -not $w.CommandLine) { exit 1 }
Write-Output $w.CommandLine
`;

/** How long a command-line read may take: an ask waits on it. */
const COMMAND_LINE_TIMEOUT_MS = 5000;

export class WindowsRaiser implements WindowRaiser {
  private exec: Exec;

  constructor(exec: Exec = runCommand) {
    this.exec = exec;
  }

  /**
   * Runs a script with the pid as `$args[0]`. `-Command` joins what follows it into one
   * command, so a trailing argument would run as a statement of its own and `$args` would be
   * empty; the script is a block invoked with the pid instead.
   */
  private powershell(script: string, arg: number, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    return this.exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `& {${script}} ${Math.trunc(arg)}`], opts);
  }

  async commandLine(pid: number): Promise<string[] | undefined> {
    const r = await this.powershell(COMMAND_LINE_SCRIPT, pid, { timeoutMs: COMMAND_LINE_TIMEOUT_MS });
    const line = r.out.trim();
    return r.code === 0 && line ? splitWindowsCommandLine(line) : undefined;
  }

  async raise(pid: number): Promise<RaiseResult> {
    const r = await this.powershell(RAISE_SCRIPT, pid);
    return r.code === 0 && r.out.includes("raised") ? "raised" : "not_found";
  }

  async ancestors(pid: number): Promise<ProcessInfo[]> {
    const r = await this.powershell(ANCESTORS_SCRIPT, pid);
    const out: ProcessInfo[] = [];
    for (const line of r.out.split(/\r?\n/)) {
      const m = /^(\d+)\s+(.+)$/.exec(line.trim());
      if (m) out.push({ pid: Number(m[1]), name: m[2]! });
    }
    return out;
  }

  async ancestorsOf(pids: number[]): Promise<Map<number, ProcessInfo[]>> {
    const r = await this.powershell(PROCESS_TABLE_SCRIPT, 0);
    const table = parsePsTable(r.out);
    return new Map(pids.map((pid) => [pid, walkUp(pid, (p) => table.get(p))]));
  }
}

// --- macOS --------------------------------------------------------------------------------

/**
 * `pid ppid command` per line, as `ps -axo pid=,ppid=,comm=` prints it; the command may hold
 * spaces. A versioned install's executable (`…/claude/versions/2.1.243`) is named after it.
 */
export function parsePsTable(text: string): Map<number, { ppid: number; name: string }> {
  const table = new Map<number, { ppid: number; name: string }>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), name: installNameOf(m[3]!) ?? basename(m[3]!) });
  }
  return table;
}

/** The chain from `pid` up through the parent links of a table, nearest first, stopping at a cycle or an unknown pid. */
export function walkUp(pid: number, parentOf: (pid: number) => { ppid: number; name: string } | undefined): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  const seen = new Set<number>();
  let cur = pid;
  while (cur > 0 && !seen.has(cur)) {
    seen.add(cur);
    const p = parentOf(cur);
    if (!p) break;
    out.push({ pid: cur, name: p.name });
    cur = p.ppid;
  }
  return out;
}

/**
 * A raiser whose walks up the process tree read the whole table once, from `read`: the metrics
 * engine's, one system call on Windows, where each step of the raiser's own walk is a query of
 * its own. Where the table cannot be read, the raiser walks as it does.
 */
export function withProcessTable(raiser: WindowRaiser, read: () => Promise<{ pid: number; parent: number; name: string }[] | undefined>): WindowRaiser {
  const table = async () => {
    const rows = await read().catch(() => undefined);
    return rows && rows.length > 0 ? new Map(rows.map((p) => [p.pid, { ppid: p.parent, name: p.name }])) : undefined;
  };
  return {
    raise: (pid) => raiser.raise(pid),
    commandLine: (pid) => raiser.commandLine(pid),
    async ancestors(pid) {
      const t = await table();
      return t ? walkUp(pid, (p) => t.get(p)) : raiser.ancestors(pid);
    },
    async ancestorsOf(pids) {
      const t = await table();
      if (t) return new Map(pids.map((pid) => [pid, walkUp(pid, (p) => t.get(p))]));
      if (raiser.ancestorsOf) return raiser.ancestorsOf(pids);
      return new Map(await Promise.all(pids.map(async (pid) => [pid, await raiser.ancestors(pid)] as const)));
    },
  };
}

/** The `-L name` or `-S path` a tmux server was started with, so its clients are asked on its socket. */
export function tmuxSocketArgs(argv: string[] | undefined): string[] {
  if (!argv) return [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-L" || a === "-S") return argv[i + 1] ? [a, argv[i + 1]!] : [];
    const joined = /^-(L|S)(.+)$/.exec(a);
    if (joined) return [`-${joined[1]}`, joined[2]!];
    if (!a.startsWith("-")) break;
  }
  return [];
}

/** Tab-separated tmux output as rows of fields, blank lines left out. */
function tmuxRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.split("\t"));
}

/**
 * A raiser that follows a session into tmux: the tmux server, which runs every pane, is
 * adopted by launchd (or init), so no window is ever above it. The pane whose process is in
 * the session's chain is selected in its window, and the window of a client attached to that
 * pane's session is raised instead. A session in a detached tmux has no window at all.
 */
export function withTmux(raiser: WindowRaiser, opts: { exec?: Exec; argv?: (pid: number) => string[] | undefined } = {}): WindowRaiser {
  const exec = opts.exec ?? runCommand;
  const tmux = (socket: string[], args: string[]) => exec("tmux", [...socket, ...args], { timeoutMs: 5000 });
  return {
    ancestors: (pid) => raiser.ancestors(pid),
    ...(raiser.ancestorsOf ? { ancestorsOf: (pids: number[]) => raiser.ancestorsOf!(pids) } : {}),
    commandLine: (pid) => raiser.commandLine(pid),
    async raise(pid) {
      const chain = await raiser.ancestors(pid).catch(() => []);
      const at = chain.findIndex((p) => p.name === "tmux" || p.name.startsWith("tmux:"));
      if (at <= 0) return raiser.raise(pid);
      const server = chain[at]!;
      const paneProcess = chain[at - 1]!.pid;
      const socket = tmuxSocketArgs(opts.argv ? opts.argv(server.pid) : await raiser.commandLine(server.pid).catch(() => undefined));
      const panes = await tmux(socket, ["list-panes", "-a", "-F", "#{pane_pid}\t#{session_id}\t#{window_id}\t#{pane_id}"]);
      if (panes.code !== 0) return "not_found";
      const pane = tmuxRows(panes.out).find((r) => Number(r[0]) === paneProcess);
      if (!pane || pane.length < 4) return "not_found";
      const [, session, window, paneId] = pane as [string, string, string, string];
      await tmux(socket, ["select-window", "-t", window]);
      await tmux(socket, ["select-pane", "-t", paneId]);
      const clients = await tmux(socket, ["list-clients", "-F", "#{client_pid}\t#{session_id}"]);
      const client = clients.code === 0 ? tmuxRows(clients.out).find((r) => r[1] === session) : undefined;
      return client ? raiser.raise(Number(client[0])) : "not_found";
    },
  };
}

/** The pids in a System Events answer such as `345, 1201, 1288`. */
export function parseUnixIds(text: string): Set<number> {
  const ids = new Set<number>();
  for (const m of text.matchAll(/\d+/g)) ids.add(Number(m[0]));
  return ids;
}

const NOT_AUTHORIZED = /-1743|not authori[sz]ed|not permitted/i;

/** A string as an AppleScript literal. */
function appleString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Terminal: the window and tab on `tty` selected and brought forward; "not_found" when no tab is on it. */
export function terminalTabScript(tty: string): string {
  return [
    'tell application "Terminal"',
    "  repeat with w in windows",
    "    repeat with t in tabs of w",
    `      if tty of t is ${appleString(tty)} then`,
    "        if miniaturized of w then set miniaturized of w to false",
    "        set selected tab of w to t",
    "        set index of w to 1",
    "        activate",
    '        return "raised"',
    "      end if",
    "    end repeat",
    "  end repeat",
    "end tell",
    'return "not_found"',
  ].join("\n");
}

/** iTerm2: the window, tab and split pane on `tty` selected and brought forward. */
export function itermSessionScript(tty: string): string {
  return [
    'tell application "iTerm2"',
    "  repeat with w in windows",
    "    repeat with t in tabs of w",
    "      repeat with s in sessions of t",
    `        if tty of s is ${appleString(tty)} then`,
    "          select w",
    "          select t",
    "          select s",
    "          activate",
    '          return "raised"',
    "        end if",
    "      end repeat",
    "    end repeat",
    "  end repeat",
    "end tell",
    'return "not_found"',
  ].join("\n");
}

/** The terminal apps whose tab a session runs in is found by its tty, by the name of the chain's GUI process. */
const TAB_APPS: Record<string, (tty: string) => string> = { Terminal: terminalTabScript, iTerm2: itermSessionScript };

/** iTerm2's per-session server, adopted by launchd: its shells' app is iTerm2, found by name. */
const ITERM_SERVER = /^iTermServer/;

export class DarwinRaiser implements WindowRaiser {
  private exec: Exec;
  private log: Logger | undefined;

  private argv: (pid: number) => string[] | undefined;

  constructor(opts: { exec?: Exec; log?: Logger; argv?: (pid: number) => string[] | undefined } = {}) {
    this.exec = opts.exec ?? runCommand;
    this.log = opts.log;
    // a test that scripts `ps` scripts the arguments with it
    this.argv = opts.argv ?? (opts.exec ? () => undefined : darwinArgv);
  }

  async ancestors(pid: number): Promise<ProcessInfo[]> {
    const r = await this.exec("ps", ["-axo", "pid=,ppid=,comm="]);
    if (r.code !== 0) return [];
    const table = parsePsTable(r.out);
    return walkUp(pid, (p) => table.get(p));
  }

  /**
   * The arguments exactly, from `sysctl(KERN_PROCARGS2)` (`darwinArgv`); `ps`, which joins them
   * with spaces so one holding a space reads as two, only where that cannot be read.
   */
  async commandLine(pid: number): Promise<string[] | undefined> {
    const exact = this.argv(pid);
    if (exact && exact.length > 0) return exact;
    const r = await this.exec("ps", ["-ww", "-o", "args=", "-p", String(pid)], { timeoutMs: COMMAND_LINE_TIMEOUT_MS });
    const args = r.out.trim().split(/\s+/).filter(Boolean);
    return r.code === 0 && args.length > 0 ? args : undefined;
  }

  /** The terminal device a process runs on, `/dev/ttys003`; none for one without a terminal. */
  private async ttyOf(pid: number): Promise<string | undefined> {
    const r = await this.exec("ps", ["-o", "tty=", "-p", String(pid)]);
    const tty = r.out.trim();
    return r.code === 0 && /^tty\w+$/.test(tty) ? `/dev/${tty}` : undefined;
  }

  /**
   * Runs a script; `blocked` says why it could not run: `denied` when the Automation permission
   * is refused, `waiting` when osascript is still waiting at the timeout (the permission's
   * prompt is up), `unsupported` when osascript could not be started at all.
   */
  private async osascript(script: string, app: string): Promise<ExecResult & { blocked?: "denied" | "waiting" | "unsupported" }> {
    const r = await this.exec("osascript", ["-e", script]);
    if (r.code !== 0 && NOT_AUTHORIZED.test(r.err + r.out)) {
      this.log?.warn(`session.focus needs the Automation permission for ${app}: System Settings › Privacy & Security › Automation`, {
        error: r.err.trim() || r.out.trim(),
      });
      return { ...r, blocked: "denied" };
    }
    if (r.code === null) return { ...r, blocked: r.timedOut ? "waiting" : "unsupported" };
    return r;
  }

  /** Selects the tab on the session's tty in a terminal app that can say which tab that is. */
  private async raiseTab(app: string, pid: number): Promise<RaiseResult> {
    const script = TAB_APPS[app];
    const tty = script ? await this.ttyOf(pid) : undefined;
    if (!script || !tty) return "not_found";
    const r = await this.osascript(script(tty), app);
    if (r.blocked) return r.blocked;
    return r.code === 0 && r.out.trim() === "raised" ? "raised" : "not_found";
  }

  async raise(pid: number): Promise<RaiseResult> {
    const chain = await this.ancestors(pid);
    if (chain.length === 0) return "not_found";
    if (chain.some((p) => ITERM_SERVER.test(p.name))) return this.raiseTab("iTerm2", pid);
    const gui = await this.osascript('tell application "System Events" to get unix id of every process whose background only is false', "System Events");
    if (gui.blocked) return gui.blocked;
    if (gui.code !== 0) return "not_found";
    const ids = parseUnixIds(gui.out);
    const target = chain.find((p) => ids.has(p.pid));
    if (!target) return "not_found";
    if (TAB_APPS[target.name]) {
      // the tab when the app says which; its permission refused, the app's front window as before
      const tab = await this.raiseTab(target.name, pid);
      if (tab === "raised" || tab === "waiting") return tab;
    }
    const set = await this.osascript(`tell application "System Events" to set frontmost of (first process whose unix id is ${target.pid}) to true`, "System Events");
    if (set.blocked) return set.blocked;
    return set.code === 0 ? "raised" : "not_found";
  }
}

// --- Linux --------------------------------------------------------------------------------

export interface LinuxDeps {
  exec?: Exec;
  /** Reads a `/proc/<pid>/status` file; throws when the process is gone. */
  readFile?: (path: string) => string;
  env?: Record<string, string | undefined>;
  /** Where a tool is on PATH, or null. */
  which?: (name: string) => string | null;
}

/** The `Name:` and `PPid:` lines of a `/proc/<pid>/status`. */
export function parseProcStatus(text: string): { ppid: number; name: string } | undefined {
  const name = /^Name:\s*(.*)$/m.exec(text)?.[1]?.trim();
  const ppid = /^PPid:\s*(\d+)\s*$/m.exec(text)?.[1];
  if (name === undefined || ppid === undefined) return undefined;
  return { ppid: Number(ppid), name };
}

/** The window id and owner pid of every `wmctrl -lp` line: `0x0300000b  0 12345 host title`. */
export function parseWmctrlList(text: string): { id: string; pid: number }[] {
  const out: { id: string; pid: number }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s/i.exec(line);
    if (m) out.push({ id: m[1]!, pid: Number(m[3]) });
  }
  return out;
}

export class LinuxRaiser implements WindowRaiser {
  private exec: Exec;
  private readFile: (path: string) => string;
  private env: Record<string, string | undefined>;
  private which: (name: string) => string | null;

  constructor(deps: LinuxDeps = {}) {
    this.exec = deps.exec ?? runCommand;
    this.readFile = deps.readFile ?? ((path) => readFileSync(path, "utf8"));
    this.env = deps.env ?? process.env;
    this.which = deps.which ?? ((name) => Bun.which(name));
  }

  async ancestors(pid: number): Promise<ProcessInfo[]> {
    return walkUp(pid, (p) => {
      try {
        return parseProcStatus(this.readFile(`/proc/${p}/status`));
      } catch {
        return undefined;
      }
    });
  }

  /** `/proc/<pid>/cmdline`: the arguments, each ended by a NUL. */
  async commandLine(pid: number): Promise<string[] | undefined> {
    try {
      const args = this.readFile(`/proc/${pid}/cmdline`).split("\0");
      if (args[args.length - 1] === "") args.pop();
      return args.length > 0 ? args : undefined;
    } catch {
      return undefined;
    }
  }

  async raise(pid: number): Promise<RaiseResult> {
    if (!this.env["DISPLAY"] && !this.env["WAYLAND_DISPLAY"]) return "unsupported";
    const chain = await this.ancestors(pid);
    if (chain.length === 0) return "not_found";
    const xdotool = this.which("xdotool");
    const wmctrl = this.which("wmctrl");
    if (!xdotool && !wmctrl) return "unsupported";
    if (xdotool) {
      for (const p of chain) {
        const found = await this.exec(xdotool, ["search", "--pid", String(p.pid), "--onlyvisible"]);
        const id = found.out.split(/\s+/).find((w) => /^\d+$/.test(w));
        if (found.code !== 0 || !id) continue;
        const r = await this.exec(xdotool, ["windowactivate", "--sync", id]);
        if (r.code === 0) return "raised";
      }
    }
    if (wmctrl) {
      const list = await this.exec(wmctrl, ["-lp"]);
      if (list.code === 0) {
        const windows = parseWmctrlList(list.out);
        for (const p of chain) {
          const w = windows.find((x) => x.pid === p.pid);
          if (!w) continue;
          const r = await this.exec(wmctrl, ["-ia", w.id]);
          if (r.code === 0) return "raised";
        }
      }
    }
    return "not_found";
  }
}

// --- elsewhere ----------------------------------------------------------------------------

export class UnsupportedRaiser implements WindowRaiser {
  async raise(): Promise<RaiseResult> {
    return "unsupported";
  }
  async ancestors(): Promise<ProcessInfo[]> {
    return [];
  }
  async commandLine(): Promise<string[] | undefined> {
    return undefined;
  }
}

export function defaultRaiser(platform: NodeJS.Platform = process.platform, opts: { env?: Record<string, string | undefined>; log?: Logger } = {}): WindowRaiser {
  switch (platform) {
    case "win32":
      return new WindowsRaiser();
    case "darwin":
      return new DarwinRaiser({ ...(opts.log ? { log: opts.log } : {}) });
    case "linux":
      return new LinuxRaiser({ ...(opts.env ? { env: opts.env } : {}) });
    default:
      return new UnsupportedRaiser();
  }
}
