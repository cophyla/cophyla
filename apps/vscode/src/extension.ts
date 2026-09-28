// The tether editor extension. It puts "tether" in the panel's profile menu: this window's own
// shell, started in tether, so what the user runs there (a `claude`, say) is one Cophyla can type
// into as the user. tether is the one cophylad runs, as it writes it in `<home>/editors/tether.json`,
// else the one on PATH.
//
// It also puts a session's terminal in this window's panel, beside the user's own, because
// `window.createTerminal` is the only way into that panel and only an extension can call it —
// VS Code's command line has no terminal in it, and the channel the `code` CLI uses to reach a
// running window carries no command at all. So the window announces itself rather than being
// reached into: it listens on a loopback port nobody else can guess, writes
// `<home>/editors/<pid>.json` naming that port, a token and the folders it has open, and takes
// the file away when it closes. The daemon reads that directory, picks the window whose
// folders hold the session's directory, and posts the command. A request without the token is
// refused, and so is one from off this machine.
//
// The same door raises a session already in one of this window's terminals: the daemon posts the
// session's process chain to `/focus`, and the window whose terminal runs one of those processes
// shows that terminal and brings itself forward. No extension API raises a window, but the
// product's own command line does: opening the folder a window already has open focuses that
// window (`code <folder>`), so the window runs it on its own folder, and on its own instance:
// the command line reaches the instance of the user data folder it is given (the default one
// otherwise), which is where this instance's socket (`VSCODE_IPC_HOOK`) lives.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import * as vscode from "vscode";

/** What the daemon asks for. */
interface TerminalRequest {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  title?: string;
}

/** Bodies are small; anything larger is not one of ours. */
const MAX_BODY = 64 * 1024;

let server: Server | undefined;
let entryPath: string | undefined;
let output: vscode.OutputChannel | undefined;

function log(message: string): void {
  output?.appendLine(`${new Date().toISOString()} ${message}`);
}

/** Where the daemon keeps its home, as the daemon itself resolves it. */
function cophylaHome(): string {
  const configured = vscode.workspace.getConfiguration("cophyla").get<string>("home");
  const raw = (configured && configured.trim()) || process.env["COPHYLA_HOME"] || join(homedir(), ".cophyla");
  return resolve(raw);
}

function folders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath);
}

function parse(body: string): TerminalRequest | undefined {
  try {
    const d = JSON.parse(body) as Record<string, unknown>;
    const argv = Array.isArray(d["argv"]) ? d["argv"].filter((a): a is string => typeof a === "string") : [];
    if (argv.length === 0 || typeof d["cwd"] !== "string") return undefined;
    const env: Record<string, string> = {};
    const given = d["env"];
    if (given && typeof given === "object") for (const [k, v] of Object.entries(given as Record<string, unknown>)) if (typeof v === "string") env[k] = v;
    return { argv, cwd: d["cwd"], env, ...(typeof d["title"] === "string" ? { title: d["title"] } : {}) };
  } catch {
    return undefined;
  }
}

/** Opens the terminal and shows it, without taking the user's focus out of the editor. */
function openTerminal(req: TerminalRequest): void {
  const [shellPath, ...shellArgs] = req.argv;
  const terminal = vscode.window.createTerminal({
    name: req.title && req.title.trim() ? req.title : "Cophyla session",
    cwd: req.cwd,
    shellPath,
    shellArgs,
    env: req.env ?? {},
    iconPath: new vscode.ThemeIcon("sparkle"),
    isTransient: true,
  });
  // The panel comes forward so the session can be watched, but the cursor stays where it was.
  terminal.show(true);
}

/** The product's command line (`code`, `cursor`, …), named in its product.json. */
function productCli(): string | undefined {
  const root = vscode.env.appRoot;
  let name = "code";
  try {
    const product = JSON.parse(readFileSync(join(root, "product.json"), "utf8")) as { applicationName?: unknown };
    if (typeof product.applicationName === "string" && product.applicationName) name = product.applicationName;
  } catch {
    // an editor without one is VS Code's layout
  }
  const cli = process.platform === "win32" ? join(root, "..", "..", "bin", `${name}.cmd`) : join(root, "bin", name);
  return existsSync(cli) ? cli : undefined;
}

/** What this window has open, as its command line names it: the workspace file, else its first folder. */
function openTarget(): string | undefined {
  const file = vscode.workspace.workspaceFile;
  if (file && file.scheme === "file") return file.fsPath;
  return folders()[0];
}

/**
 * `--user-data-dir` of this window's instance, so the command line reaches it and not the
 * default one: its socket's folder, when that is a user data folder (the socket goes elsewhere
 * when the path would be too long for one, and is a named pipe on Windows).
 */
function instanceArgs(): string[] {
  const hook = process.env["VSCODE_IPC_HOOK"];
  if (!hook || process.platform === "win32" || !hook.endsWith("-main.sock")) return [];
  const dir = dirname(hook);
  return existsSync(join(dir, "User")) ? ["--user-data-dir", dir] : [];
}

/** Brings this window forward by opening what it has open, which focuses it. */
function raiseWindow(): void {
  const cli = productCli();
  const target = openTarget();
  if (!cli || !target) return;
  const windows = process.platform === "win32";
  const quote = (s: string) => (windows ? `"${s}"` : s);
  try {
    const child = spawn(quote(cli), [...instanceArgs().map(quote), quote(target)], { stdio: "ignore", detached: !windows, shell: windows, windowsHide: true });
    child.on("error", (e) => log(`could not raise this window: ${e.message}`));
    child.unref();
  } catch (e) {
    log(`could not raise this window: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** How long a terminal's process id is waited for: one whose process never started has none to give. */
const PROCESS_ID_MS = 1000;

/** Shows the terminal running one of `pids`, and brings this window forward; false when none of its terminals does. */
async function focusTerminal(pids: number[]): Promise<boolean> {
  const wanted = new Set(pids);
  if (wanted.size === 0) return false;
  for (const terminal of vscode.window.terminals) {
    const pid = await Promise.race([terminal.processId, new Promise<undefined>((r) => setTimeout(() => r(undefined), PROCESS_ID_MS))]);
    if (pid === undefined || !wanted.has(pid)) continue;
    terminal.show(false);
    raiseWindow();
    return true;
  }
  return false;
}

function parsePids(body: string): number[] | undefined {
  try {
    const d = JSON.parse(body) as { pids?: unknown };
    if (!Array.isArray(d.pids)) return undefined;
    return d.pids.filter((p): p is number => typeof p === "number" && Number.isInteger(p) && p > 0);
  } catch {
    return undefined;
  }
}

function handle(token: string, req: IncomingMessage, res: ServerResponse): void {
  const done = (code: number, body: string, type = "text/plain"): void => {
    res.writeHead(code, { "content-type": type });
    res.end(body);
  };
  if (req.method !== "POST" || (req.url !== "/terminal" && req.url !== "/focus")) return done(404, "not found");
  if (req.headers.authorization !== `Bearer ${token}`) return done(401, "bad token");
  let body = "";
  let tooBig = false;
  req.on("data", (chunk: Buffer) => {
    if (tooBig) return;
    body += chunk.toString("utf8");
    if (body.length > MAX_BODY) {
      tooBig = true;
      done(413, "too large");
      req.destroy();
    }
  });
  req.on("end", () => {
    if (tooBig) return;
    if (req.url === "/focus") {
      const pids = parsePids(body);
      if (!pids) return done(400, "not a focus request");
      focusTerminal(pids).then(
        (focused) => {
          if (focused) log("showed a session's terminal");
          done(200, JSON.stringify({ focused }), "application/json");
        },
        (e: unknown) => done(500, e instanceof Error ? e.message : String(e)),
      );
      return;
    }
    const parsed = parse(body);
    if (!parsed) return done(400, "not a terminal request");
    try {
      openTerminal(parsed);
      log(`opened a terminal in ${parsed.cwd}`);
      done(200, "ok");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`could not open a terminal: ${message}`);
      done(500, message);
    }
  });
}

function onPath(name: string): string | undefined {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return undefined;
}

/** tether with its state folder: as the daemon runs it, so the terminal lands on the host it watches; else the one on PATH. */
function tetherCommand(): string[] | undefined {
  try {
    const d = JSON.parse(readFileSync(join(cophylaHome(), "editors", "tether.json"), "utf8")) as { argv?: unknown };
    const argv = Array.isArray(d.argv) ? d.argv.filter((a): a is string => typeof a === "string") : [];
    // A binary an update has since cleared away is no command.
    if (argv.length > 0 && existsSync(argv[0]!)) return argv;
  } catch {
    // No daemon here has written it.
  }
  const found = onPath(process.platform === "win32" ? "tether.exe" : "tether");
  return found ? [found] : undefined;
}

/** The shell this window's terminals open, a login shell on macOS as VS Code starts it there. */
function shell(): string[] {
  const path = vscode.env.shell || (process.platform === "win32" ? "powershell.exe" : (process.env["SHELL"] ?? "/bin/sh"));
  return process.platform === "darwin" ? [path, "-l"] : [path];
}

/** The "tether" profile: `tether run -- <shell>`. */
function tetherProfile(): vscode.TerminalProfile | undefined {
  const tether = tetherCommand();
  if (!tether) return undefined;
  const [shellPath, ...args] = tether;
  return new vscode.TerminalProfile({ name: "tether", shellPath, shellArgs: [...args, "run", "--", ...shell()], iconPath: new vscode.ThemeIcon("terminal") });
}

/** Writes what this window is, for the daemon to find. Called again whenever the folders change. */
function announce(port: number, token: string): void {
  const dir = join(cophylaHome(), "editors");
  mkdirSync(dir, { recursive: true });
  entryPath = join(dir, `${process.pid}.json`);
  writeFileSync(entryPath, JSON.stringify({ pid: process.pid, port, token, folders: folders(), name: vscode.workspace.name ?? "VS Code" }, null, 2), "utf8");
}

function withdraw(): void {
  if (!entryPath) return;
  try {
    rmSync(entryPath);
  } catch {
    // Gone already: a daemon sweeps the file of a window that was killed rather than closed.
  }
  entryPath = undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("tether");
  context.subscriptions.push(output);
  const token = randomBytes(32).toString("hex");
  const listener = createServer((req, res) => handle(token, req, res));
  server = listener;
  // Loopback only: a session's command line is nobody else's business.
  listener.listen(0, "127.0.0.1", () => {
    const address = listener.address();
    const port = typeof address === "object" && address ? address.port : 0;
    if (!port) return;
    announce(port, token);
    log(`listening on 127.0.0.1:${port} for ${cophylaHome()}`);
  });
  listener.on("error", (e) => log(`could not listen: ${e.message}`));

  // A window that opens or closes a folder is a different window as far as routing goes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const address = listener.address();
      const port = typeof address === "object" && address ? address.port : 0;
      if (port) announce(port, token);
    }),
  );
  context.subscriptions.push({ dispose: () => withdraw() });

  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider("tether.terminal", {
      provideTerminalProfile: () => {
        const profile = tetherProfile();
        if (!profile) void vscode.window.showWarningMessage("No tether on this machine: put it on PATH, or start Cophyla here.");
        return profile;
      },
    }),
  );
}

export function deactivate(): void {
  withdraw();
  server?.close();
  server = undefined;
}
