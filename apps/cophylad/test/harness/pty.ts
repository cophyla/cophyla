// Runs an interactive TUI (claude, codex) inside a pty (ConPTY on Windows, a pty elsewhere)
// so a test can watch the screen and type into it. Ported from spikes/_pty/pty.mjs. node-pty
// runs under a Node broker when Node is on PATH (`ptyHost`): under Bun the typed input is
// lost on Windows and the child is hung up on Linux. The harness tests need real terminals
// and real logins, so they run only with COPHYLA_HARNESS_TESTS=1.

import { appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HARNESS = process.env["COPHYLA_HARNESS_TESTS"] === "1";
/** The harness binaries: Windows' install locations, elsewhere whatever PATH says. */
export const CLAUDE = process.env["CLAUDE_BIN"] ?? (process.platform === "win32" ? join(homedir(), ".local", "bin", "claude.exe") : (Bun.which("claude") ?? "claude"));
export const CODEX = process.env["CODEX_BIN"] ?? (process.platform === "win32" ? join(homedir(), "AppData", "Local", "Programs", "OpenAI", "Codex", "bin", "codex.exe") : (Bun.which("codex") ?? "codex"));

/** Good enough for reading a TUI: drop CSI/OSC sequences, keep the text. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, " ")
    .replace(/\x1b[()][A-Z0-9]/g, "")
    .replace(/\x1b[=>]/g, "")
    .replace(/[ \t]+/g, " ");
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A nested session must not inherit this session's identity or messaging socket. */
export function scrubbedEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^CLAUDE_CODE_/.test(k) || ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_CONFIG_DIR"].includes(k)) continue;
    clean[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete clean[k];
    else clean[k] = v;
  }
  return clean;
}

export interface Tui {
  pid: number;
  readonly exited: { exitCode: number; signal?: number } | null;
  write(s: string): void;
  /** Types text, then Enter as a separate write so the TUI does not treat it as a paste. */
  submit(text: string, gapMs?: number): Promise<void>;
  text(tail?: number): string;
  mark(): number;
  since(mark: number): string;
  waitFor(re: RegExp, timeoutMs?: number, fromMark?: number): Promise<RegExpMatchArray>;
  kill(): void;
}

/**
 * Past what a fresh folder asks before the prompt box: the trust dialog, answered yes. Claude
 * Code 2.1.28x draws it as "❯ No, exit / Yes, I trust this folder" with No picked, so Enter
 * alone would end the session: Down first. Older ones picked "Yes, proceed", where Enter is it.
 */
export async function passTrust(t: Tui): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const m = await t.waitFor(/trust|Yes, proceed|Enter to confirm|›|❯|>\s*$/i, 90_000, t.mark() - 4000);
    await sleep(300);
    const screen = t.text(1500);
    if (/Yes, I trust this folder/.test(screen)) {
      if (/❯\s*No, exit/.test(screen)) {
        t.write("\x1b[B");
        await sleep(300);
      }
      t.write("\r");
      await sleep(1500);
      continue;
    }
    if (/trust|proceed|confirm/i.test(m[0]) && !/›|❯/.test(t.text(300))) {
      t.write("\r");
      await sleep(1500);
      continue;
    }
    break;
  }
}

/** The terminal, as the two hosts expose it: node-pty in this process, or through the Node broker. */
interface PtyHandle {
  pid: number;
  write(data: string): void;
  kill(): void;
}

/**
 * Where node-pty runs: `COPHYLA_PTY_HOST=bun` in this process, `COPHYLA_PTY_HOST=node` under a
 * Node child (`pty-broker.mjs`). Unset, Node whenever it is on PATH: under Bun, typed input
 * fails on Windows ("Socket is closed" on the ConPTY input socket) and on Linux the pty
 * child is hung up before its first byte; only the screen reads work in-process.
 */
export function ptyHost(): "bun" | "node" {
  const forced = process.env["COPHYLA_PTY_HOST"];
  if (forced === "bun" || forced === "node") return forced;
  return Bun.which("node") ? "node" : "bun";
}

async function spawnInProcess(file: string, args: string[], opts: { cwd: string; env: Record<string, string>; cols: number; rows: number }, onData: (d: string) => void, onExit: (e: { exitCode: number; signal?: number }) => void): Promise<PtyHandle> {
  const pty = await import("@lydell/node-pty");
  const p = pty.spawn(file, args, { name: "xterm-256color", cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env: opts.env });
  p.onData(onData);
  p.onExit(onExit);
  return { pid: p.pid, write: (d) => p.write(d), kill: () => p.kill() };
}

async function spawnThroughNode(file: string, args: string[], opts: { cwd: string; env: Record<string, string>; cols: number; rows: number }, onData: (d: string) => void, onExit: (e: { exitCode: number; signal?: number }) => void): Promise<PtyHandle> {
  const { spawn } = await import("node:child_process");
  const { createInterface } = await import("node:readline");
  const node = process.env["COPHYLA_NODE"] ?? Bun.which("node") ?? "node";
  const broker = spawn(node, [join(import.meta.dir, "pty-broker.mjs")], { cwd: opts.cwd, stdio: ["pipe", "pipe", "inherit"] });
  const send = (msg: unknown) => broker.stdin.write(JSON.stringify(msg) + "\n");
  let pidResolve: (pid: number) => void = () => {};
  let pidReject: (e: Error) => void = () => {};
  const spawned = new Promise<number>((resolve, reject) => {
    pidResolve = resolve;
    pidReject = reject;
  });
  createInterface({ input: broker.stdout }).on("line", (line) => {
    let msg: { ev: string; pid?: number; data?: string; exitCode?: number; signal?: number; message?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.ev === "spawned") pidResolve(msg.pid!);
    else if (msg.ev === "data") onData(msg.data ?? "");
    else if (msg.ev === "exit") onExit({ exitCode: msg.exitCode ?? 0, ...(msg.signal !== undefined ? { signal: msg.signal } : {}) });
    else if (msg.ev === "error") pidReject(new Error(msg.message ?? "pty broker error"));
  });
  broker.on("exit", (code) => pidReject(new Error(`pty broker exited ${code} before spawning`)));
  send({ op: "spawn", file, args, cwd: opts.cwd, env: opts.env, cols: opts.cols, rows: opts.rows });
  const pid = await spawned;
  return { pid, write: (d) => send({ op: "write", data: d }), kill: () => send({ op: "kill" }) };
}

export async function spawnTui(file: string, args: string[], opts: { cwd: string; env?: Record<string, string>; cols?: number; rows?: number; rawLog?: string }): Promise<Tui> {
  let buf = "";
  if (opts.rawLog) writeFileSync(opts.rawLog, "");
  let exited: Tui["exited"] = null;
  const onData = (d: string) => {
    buf += d;
    if (buf.length > 400_000) buf = buf.slice(-200_000);
    if (opts.rawLog) appendFileSync(opts.rawLog, d);
  };
  const onExit = (e: { exitCode: number; signal?: number }) => {
    exited = e;
  };
  const spawnOpts = { cwd: opts.cwd, env: opts.env ?? scrubbedEnv(), cols: opts.cols ?? 140, rows: opts.rows ?? 45 };
  const p = ptyHost() === "node" ? await spawnThroughNode(file, args, spawnOpts, onData, onExit) : await spawnInProcess(file, args, spawnOpts, onData, onExit);
  return {
    pid: p.pid,
    get exited() {
      return exited;
    },
    write: (s) => p.write(s),
    async submit(text, gapMs = 400) {
      p.write(text);
      await sleep(gapMs);
      p.write("\r");
    },
    text: (tail = 6000) => stripAnsi(buf).slice(-tail),
    mark: () => buf.length,
    since: (mark) => stripAnsi(buf.slice(mark)),
    async waitFor(re, timeoutMs = 60_000, fromMark = 0) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const m = stripAnsi(buf.slice(fromMark)).match(re);
        if (m) return m;
        if (exited) throw new Error(`process exited (${exited.exitCode}) before ${re}`);
        await sleep(250);
      }
      throw new Error(`timeout waiting for ${re}\n--- screen tail ---\n${stripAnsi(buf).slice(-1500)}`);
    },
    kill() {
      try {
        p.kill();
      } catch {
        // already gone
      }
    },
  };
}
