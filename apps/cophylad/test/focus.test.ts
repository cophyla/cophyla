// The window raisers over canned commands: every platform's walk and raise runs here on any
// host, since the commands are injected. What each raiser does with a real desktop is the
// Mac and Linux visits' job.

import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/log.ts";
import { DarwinRaiser, LinuxRaiser, UnsupportedRaiser, WindowsRaiser, defaultRaiser, itermSessionScript, parsePsTable, parseProcStatus, parseUnixIds, parseWmctrlList, splitWindowsCommandLine, terminalTabScript, tmuxSocketArgs, walkUp, withTmux } from "../src/sessions/focus.ts";
import type { Exec, ExecResult, RaiseResult, WindowRaiser } from "../src/sessions/focus.ts";

type Call = { file: string; args: string[] };

/** An `Exec` answering from a table keyed by the command's first argument (or the file), recording every call. */
function canned(answers: Record<string, ExecResult | ((args: string[]) => ExecResult)>): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (file, args) => {
    calls.push({ file, args });
    const key = Object.keys(answers).find((k) => k === `${file} ${args.join(" ")}` || k === file || k === args[0] || (args[0] === "-e" && k === args[1]));
    const a = key === undefined ? undefined : answers[key];
    if (a === undefined) return { code: 127, out: "", err: `${file}: not found` };
    return typeof a === "function" ? a(args) : a;
  };
  return { exec, calls };
}

const ok = (out: string): ExecResult => ({ code: 0, out, err: "" });

const PS = `
    1     0 /sbin/launchd
  345     1 /Applications/iTerm.app/Contents/MacOS/iTerm2
  400   345 login
  401   400 -zsh
  520   401 node
  600   520 /bin/sh
`;

describe("darwin raiser", () => {
  test("walks ps output up to launchd, nearest first, with the command's basename", () => {
    const table = parsePsTable(PS);
    expect(table.get(345)).toEqual({ ppid: 1, name: "iTerm2" });
    expect(walkUp(600, (p) => table.get(p)).map((p) => `${p.pid}:${p.name}`)).toEqual(["600:sh", "520:node", "401:-zsh", "400:login", "345:iTerm2", "1:launchd"]);
    expect(walkUp(999, (p) => table.get(p))).toEqual([]);
    // Claude Code's native install runs a file named by its version
    expect(parsePsTable("  700   401 /Users/u/.local/share/claude/versions/2.1.243\n").get(700)).toEqual({ ppid: 401, name: "claude" });
    // a cycle ends the walk
    expect(walkUp(7, (p) => ({ 7: { ppid: 8, name: "a" }, 8: { ppid: 7, name: "b" } })[p]).map((p) => p.pid)).toEqual([7, 8]);
  });

  test("raises the nearest ancestor that System Events lists as a GUI process", async () => {
    const { exec, calls } = canned({
      "ps -axo pid=,ppid=,comm=": ok(PS.replace("iTerm.app/Contents/MacOS/iTerm2", "Ghostty.app/Contents/MacOS/ghostty")),
      'tell application "System Events" to get unix id of every process whose background only is false': ok("345, 1201, 1288\n"),
      'tell application "System Events" to set frontmost of (first process whose unix id is 345) to true': ok(""),
    });
    const r = new DarwinRaiser({ exec });
    expect((await r.ancestors(520)).map((p) => p.pid)).toEqual([520, 401, 400, 345, 1]);
    expect(await r.raise(520)).toBe("raised");
    expect(calls.map((c) => c.file)).toEqual(["ps", "ps", "osascript", "osascript"]);
    expect(calls[3]!.args[1]).toContain("unix id is 345");
  });

  test("in Terminal or iTerm2 the session's own tab is selected by its tty, the front window only when that cannot be", async () => {
    const terminalPs = PS.replace("/Applications/iTerm.app/Contents/MacOS/iTerm2", "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal");
    const answers = (tab: ExecResult) =>
      canned({
        "ps -axo pid=,ppid=,comm=": ok(terminalPs),
        "ps -o tty= -p 520": ok("ttys044\n"),
        'tell application "System Events" to get unix id of every process whose background only is false': ok("345"),
        [terminalTabScript("/dev/ttys044")]: tab,
        'tell application "System Events" to set frontmost of (first process whose unix id is 345) to true': ok(""),
      });
    const found = answers(ok("raised\n"));
    expect(await new DarwinRaiser({ exec: found.exec }).raise(520)).toBe("raised");
    expect(found.calls.at(-1)!.args[1]).toContain('if tty of t is "/dev/ttys044" then');
    expect(found.calls.some((c) => c.args[1]?.includes("set frontmost"))).toBe(false);
    // Terminal's own permission refused: the app's front window, through System Events
    const refused = answers({ code: 1, out: "", err: "Not authorized to send Apple events to Terminal. (-1743)" });
    expect(await new DarwinRaiser({ exec: refused.exec }).raise(520)).toBe("raised");
    expect(refused.calls.at(-1)!.args[1]).toContain("set frontmost");
    // iTerm2 selects the split pane too; a tty is quoted as an AppleScript string
    expect(itermSessionScript("/dev/ttys7")).toContain('if tty of s is "/dev/ttys7" then');
    expect(terminalTabScript('a"b\\c')).toContain('"a\\"b\\\\c"');
  });

  test("a shell under iTermServer, which launchd adopted, is found in iTerm2 by its tty", async () => {
    const { exec, calls } = canned({
      "ps -axo pid=,ppid=,comm=": ok("    1     0 /sbin/launchd\n  700     1 /Applications/iTerm.app/Contents/MacOS/iTermServer-3.5.4\n  710   700 -zsh\n  720   710 claude\n"),
      "ps -o tty= -p 720": ok("ttys009\n"),
      [itermSessionScript("/dev/ttys009")]: ok("raised\n"),
    });
    expect(await new DarwinRaiser({ exec }).raise(720)).toBe("raised");
    expect(calls.some((c) => c.args[1]?.includes("System Events"))).toBe(false);
  });

  test("not_found when no ancestor is a GUI process or the pid is unknown; parses the id list loosely", async () => {
    const { exec } = canned({ ps: ok(PS), 'tell application "System Events" to get unix id of every process whose background only is false': ok("1201, 1288") });
    expect(await new DarwinRaiser({ exec }).raise(520)).toBe("not_found");
    expect(await new DarwinRaiser({ exec }).raise(999)).toBe("not_found");
    expect([...parseUnixIds("{345, 1201}")]).toEqual([345, 1201]);
    expect([...parseUnixIds("")]).toEqual([]);
  });

  test("the Automation permission refused (-1743) is denied, with a warning that names the setting", async () => {
    const lines: string[] = [];
    const log = createLogger("warn", (l) => lines.push(l));
    const { exec } = canned({
      ps: ok(PS),
      osascript: { code: 1, out: "", err: "execution error: Not authorized to send Apple events to System Events. (-1743)\n" },
    });
    expect(await new DarwinRaiser({ exec, log }).raise(520)).toBe("denied");
    expect(lines.some((l) => l.includes("Privacy & Security") && l.includes("Automation"))).toBe(true);
  });

  test("osascript still waiting at the timeout is the permission's prompt, unanswered; osascript missing is unsupported", async () => {
    const waiting = canned({ ps: ok(PS), osascript: { code: null, out: "", err: "", timedOut: true } });
    expect(await new DarwinRaiser({ exec: waiting.exec }).raise(520)).toBe("waiting");
    const { exec } = canned({ ps: ok(PS), osascript: { code: null, out: "", err: "" } });
    expect(await new DarwinRaiser({ exec }).raise(520)).toBe("unsupported");
  });
});

describe("tmux", () => {
  // claude 900 in pane %3 of window @2 in session $1; the server 700 was adopted by launchd
  const chain = [
    { pid: 900, name: "claude" },
    { pid: 800, name: "zsh" },
    { pid: 700, name: "tmux" },
    { pid: 1, name: "launchd" },
  ];
  const inner = () => {
    const raised: number[] = [];
    const r: WindowRaiser = {
      ancestors: async (pid) => (pid === 900 ? chain : []),
      commandLine: async () => ["tmux", "-L", "work", "new-session"],
      raise: async (pid): Promise<RaiseResult> => {
        raised.push(pid);
        return "raised";
      },
    };
    return { r, raised };
  };
  const tmux = (clients: string) =>
    canned({
      "tmux -L work list-panes -a -F #{pane_pid}\t#{session_id}\t#{window_id}\t#{pane_id}": ok("111\t$0\t@0\t%0\n800\t$1\t@2\t%3\n"),
      "tmux -L work list-clients -F #{client_pid}\t#{session_id}": ok(clients),
      "tmux -L work select-window -t @2": ok(""),
      "tmux -L work select-pane -t %3": ok(""),
    });

  test("the pane is selected and the window of the client attached to its session is raised", async () => {
    const { r, raised } = inner();
    const { exec, calls } = tmux("555\t$0\n560\t$1\n");
    expect(await withTmux(r, { exec }).raise(900)).toBe("raised");
    expect(raised).toEqual([560]);
    expect(calls.map((c) => c.args.slice(2, 4).join(" "))).toEqual(["list-panes -a", "select-window -t", "select-pane -t", "list-clients -F"]);
  });

  test("a detached session has no window; a chain without tmux goes straight to the raiser", async () => {
    const { r, raised } = inner();
    expect(await withTmux(r, { exec: tmux("555\t$0\n").exec }).raise(900)).toBe("not_found");
    expect(raised).toEqual([]);
    expect(await withTmux(r, { exec: tmux("").exec }).raise(42)).toBe("raised");
    expect(raised).toEqual([42]);
  });

  test("the server's socket is read off its command line", () => {
    expect(tmuxSocketArgs(["tmux", "-L", "work", "new"])).toEqual(["-L", "work"]);
    expect(tmuxSocketArgs(["tmux", "-S/tmp/s", "attach"])).toEqual(["-S", "/tmp/s"]);
    expect(tmuxSocketArgs(["tmux", "new-session", "-L", "x"])).toEqual([]);
    expect(tmuxSocketArgs(undefined)).toEqual([]);
  });
});

const PROC: Record<number, string> = {
  900: "Name:\tsh\nUmask:\t0022\nState:\tS (sleeping)\nPid:\t900\nPPid:\t800\n",
  800: "Name:\tcodex-x86_64-un\nPid:\t800\nPPid:\t700\n",
  700: "Name:\tbash\nPid:\t700\nPPid:\t600\n",
  600: "Name:\txterm\nPid:\t600\nPPid:\t1\n",
  1: "Name:\tsystemd\nPid:\t1\nPPid:\t0\n",
};
const readProc = (path: string): string => {
  const m = /^\/proc\/(\d+)\/status$/.exec(path);
  const text = m ? PROC[Number(m[1])] : undefined;
  if (text === undefined) throw new Error("ENOENT");
  return text;
};
const display = { DISPLAY: ":0" };
const tools = (names: string[]) => (name: string) => (names.includes(name) ? `/usr/bin/${name}` : null);

describe("linux raiser", () => {
  test("walks /proc status files up to init", async () => {
    expect(parseProcStatus(PROC[900]!)).toEqual({ ppid: 800, name: "sh" });
    expect(parseProcStatus("garbage")).toBeUndefined();
    const r = new LinuxRaiser({ readFile: readProc, env: {}, which: () => null });
    expect((await r.ancestors(900)).map((p) => `${p.pid}:${p.name}`)).toEqual(["900:sh", "800:codex-x86_64-un", "700:bash", "600:xterm", "1:systemd"]);
    expect(await r.ancestors(12345)).toEqual([]);
  });

  test("no display is unsupported before any command runs; the walk still works", async () => {
    const { exec, calls } = canned({});
    const r = new LinuxRaiser({ exec, readFile: readProc, env: {}, which: tools(["xdotool"]) });
    expect(await r.raise(900)).toBe("unsupported");
    expect(calls).toEqual([]);
    expect((await r.ancestors(900)).length).toBe(5);
    expect(await new LinuxRaiser({ exec, readFile: readProc, env: { WAYLAND_DISPLAY: "wayland-0" }, which: () => null }).raise(900)).toBe("unsupported");
  });

  test("xdotool: the first ancestor with a visible window is activated", async () => {
    const { exec, calls } = canned({
      "/usr/bin/xdotool": (args) => (args[0] === "search" ? (args[2] === "600" ? ok("58720263\n") : { code: 1, out: "", err: "" }) : ok("")),
    });
    const r = new LinuxRaiser({ exec, readFile: readProc, env: display, which: tools(["xdotool", "wmctrl"]) });
    expect(await r.raise(900)).toBe("raised");
    const searched = calls.filter((c) => c.args[0] === "search").map((c) => c.args[2]);
    expect(searched).toEqual(["900", "800", "700", "600"]);
    expect(calls.at(-1)!.args).toEqual(["windowactivate", "--sync", "58720263"]);
  });

  test("wmctrl when xdotool is absent or finds nothing: a window owned by an ancestor", async () => {
    const list = "0x0300000b  0 600    host xterm\n0x0400000c  0 31337  host Other\n";
    expect(parseWmctrlList(list)).toEqual([
      { id: "0x0300000b", pid: 600 },
      { id: "0x0400000c", pid: 31337 },
    ]);
    const { exec, calls } = canned({ "/usr/bin/wmctrl": (args) => (args[0] === "-lp" ? ok(list) : ok("")) });
    const r = new LinuxRaiser({ exec, readFile: readProc, env: display, which: tools(["wmctrl"]) });
    expect(await r.raise(900)).toBe("raised");
    expect(calls.at(-1)!.args).toEqual(["-ia", "0x0300000b"]);

    const both = canned({
      "/usr/bin/xdotool": { code: 1, out: "", err: "" },
      "/usr/bin/wmctrl": (args) => (args[0] === "-lp" ? ok(list) : ok("")),
    });
    expect(await new LinuxRaiser({ exec: both.exec, readFile: readProc, env: display, which: tools(["xdotool", "wmctrl"]) }).raise(900)).toBe("raised");
  });

  test("no tool is unsupported; no matching window is not_found", async () => {
    const { exec } = canned({ "/usr/bin/xdotool": { code: 1, out: "", err: "" }, "/usr/bin/wmctrl": ok("0x0400000c  0 31337  host Other\n") });
    expect(await new LinuxRaiser({ exec, readFile: readProc, env: display, which: () => null }).raise(900)).toBe("unsupported");
    expect(await new LinuxRaiser({ exec, readFile: readProc, env: display, which: tools(["xdotool", "wmctrl"]) }).raise(900)).toBe("not_found");
    expect(await new LinuxRaiser({ exec, readFile: readProc, env: display, which: tools(["xdotool"]) }).raise(12345)).toBe("not_found");
  });
});

describe("windows raiser", () => {
  test("parses the ancestors script's lines and the raise script's verdict", async () => {
    const { exec, calls } = canned({
      "powershell.exe": (args) => (args[5]!.includes("SetForegroundWindow") ? ok("raised 1234\n") : ok("5678 codex.exe\r\n1234 WindowsTerminal.exe\r\n")),
    });
    const r = new WindowsRaiser(exec);
    expect(await r.ancestors(5678)).toEqual([
      { pid: 5678, name: "codex.exe" },
      { pid: 1234, name: "WindowsTerminal.exe" },
    ]);
    expect(await r.raise(5678)).toBe("raised");
    expect(calls.every((c) => c.file === "powershell.exe" && c.args[0] === "-NoProfile")).toBe(true);
    const none = canned({ "powershell.exe": { code: 1, out: "none\n", err: "" } });
    expect(await new WindowsRaiser(none.exec).raise(1)).toBe("not_found");
  });

  test("several chains come from one read of the process table", async () => {
    const { exec, calls } = canned({
      "powershell.exe": ok("0 0 System Idle Process\r\n4 0 System\r\n900 4 explorer.exe\r\n57352 900 tether.exe\r\n141872 57352 cmd.exe\r\n74992 141872 claude.exe\r\n"),
    });
    const chains = await new WindowsRaiser(exec).ancestorsOf([74992, 57352, 31337]);
    expect(chains.get(74992)!.map((p) => `${p.pid}:${p.name}`)).toEqual(["74992:claude.exe", "141872:cmd.exe", "57352:tether.exe", "900:explorer.exe", "4:System"]);
    expect(chains.get(57352)!.map((p) => p.pid)).toEqual([57352, 900, 4]);
    expect(chains.get(31337)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("a command line is split the way the C runtime splits it", () => {
    expect(splitWindowsCommandLine('"C:\\Users\\me\\.local\\bin\\claude.exe"  --settings "C:\\Users\\me\\.claude\\settings.json" --dangerously-skip-permissions')).toEqual([
      "C:\\Users\\me\\.local\\bin\\claude.exe",
      "--settings",
      "C:\\Users\\me\\.claude\\settings.json",
      "--dangerously-skip-permissions",
    ]);
    expect(splitWindowsCommandLine('a "b c"d \\\\"e f" g\\h "" "say ""hi"""')).toEqual(["a", "b cd", "\\e f", "g\\h", "", 'say "hi"']);
    expect(splitWindowsCommandLine('x \\"y\\" C:\\dir\\ \t')).toEqual(["x", '"y"', "C:\\dir\\"]);
    expect(splitWindowsCommandLine("   ")).toEqual([]);
  });

  test("reads a process's command line through CIM; nothing when the process is gone", async () => {
    const { exec, calls } = canned({ "powershell.exe": ok('"C:\\bin\\claude.exe" --permission-mode auto\r\n') });
    expect(await new WindowsRaiser(exec).commandLine(4321)).toEqual(["C:\\bin\\claude.exe", "--permission-mode", "auto"]);
    // `-Command` joins what follows it into one command: the pid reaches `$args` only as the
    // argument of the invoked block, never as a separate argument of its own.
    expect(calls[0]!.args.at(-2)).toBe("-Command");
    expect(calls[0]!.args.at(-1)!.startsWith("& {")).toBe(true);
    expect(calls[0]!.args.at(-1)!.endsWith("} 4321")).toBe(true);
    const gone = canned({ "powershell.exe": { code: 1, out: "", err: "" } });
    expect(await new WindowsRaiser(gone.exec).commandLine(4321)).toBeUndefined();
  });
});

describe("command lines elsewhere", () => {
  test("macOS reads ps's arguments column; Linux reads /proc/<pid>/cmdline; elsewhere there is none", async () => {
    const { exec, calls } = canned({ ps: ok("/usr/local/bin/claude --dangerously-skip-permissions\n") });
    expect(await new DarwinRaiser({ exec }).commandLine(77)).toEqual(["/usr/local/bin/claude", "--dangerously-skip-permissions"]);
    expect(calls[0]!.args).toEqual(["-ww", "-o", "args=", "-p", "77"]);
    expect(await new DarwinRaiser({ exec: canned({ ps: { code: 1, out: "", err: "" } }).exec }).commandLine(77)).toBeUndefined();

    const cmdline = (path: string): string => {
      if (path === "/proc/900/cmdline") return "node\0/opt/claude/cli.js\0--settings\0/home/me/my settings.json\0";
      throw new Error("ENOENT");
    };
    const linux = new LinuxRaiser({ readFile: cmdline, env: {}, which: () => null });
    expect(await linux.commandLine(900)).toEqual(["node", "/opt/claude/cli.js", "--settings", "/home/me/my settings.json"]);
    expect(await linux.commandLine(901)).toBeUndefined();
    expect(await new UnsupportedRaiser().commandLine()).toBeUndefined();
  });
});

describe("defaultRaiser", () => {
  test("picks the platform's raiser", () => {
    expect(defaultRaiser("win32")).toBeInstanceOf(WindowsRaiser);
    expect(defaultRaiser("darwin")).toBeInstanceOf(DarwinRaiser);
    expect(defaultRaiser("linux", { env: {} })).toBeInstanceOf(LinuxRaiser);
    expect(defaultRaiser("freebsd")).toBeInstanceOf(UnsupportedRaiser);
  });
});
