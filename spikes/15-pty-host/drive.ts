// Runs spike 15 end to end. The host starts hidden and a Claude session starts in it with no
// window attached. Then a real terminal window attaches to the session. The driver types as
// the user through the host and reads the results off the registry, the transcript and the
// host's screen model. It leaves the host, the session and a window running, so keys can be
// tried by hand; `bun stop.ts` ends them by the pids in out/pids.json.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { scrub } from "../../apps/cophylad/src/sessions/env.ts";
import { windowsCommandLine } from "../../apps/cophylad/src/sessions/terminals.ts";
import { readRegistry, transcriptPathFor } from "../../apps/cophylad/src/sessions/claude/registry.ts";

const HERE = import.meta.dir;
const BIN = join(HERE, "target", "debug", "ptyhost.exe");
const OUT = join(HERE, "out");
// Outside any repository: a folder inside this one shares the repository's trust and its
// project memory, and a model told to remember something writes into that memory.
const WORK = "C:\\D\\scratch-pty\\work";
const CONFIG = "C:\\Users\\me\\.claude-accounts\\other";
const CLAUDE = join(process.env["USERPROFILE"]!, ".local", "bin", "claude.exe");
const PORT = 4951;
const TOKEN = randomBytes(16).toString("hex");
// Hooks off, so no daemon holds this session's plan dialog; the clear-context row on.
const SETTINGS = JSON.stringify({ disableAllHooks: true, showClearContextOnPlanAccept: true });

mkdirSync(WORK, { recursive: true });
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, "run.log");
const t0 = Date.now();
function log(...a: unknown[]): void {
  const line = `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")}`;
  console.log(line);
  appendFileSync(LOG, line + "\n");
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(what: string, fn: () => T | undefined | Promise<T | undefined>, ms: number): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v !== undefined && v !== false) return v as T;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const pids: { host?: number; claude?: number; clients: number[] } = { clients: [] };
const savePids = () => writeFileSync(join(OUT, "pids.json"), JSON.stringify(pids, null, 2));

// --- the host's control connection -----------------------------------------------------------

class Control {
  private buf = "";
  private waiters: ((v: any) => void)[] = [];
  private constructor(private sock: Socket) {
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        this.waiters.shift()?.(JSON.parse(line));
      }
    });
  }
  static open(): Promise<Control> {
    return new Promise((res, rej) => {
      const s = connect(PORT, "127.0.0.1", () => res(new Control(s)));
      s.on("error", rej);
    });
  }
  req(op: Record<string, unknown>): Promise<any> {
    return new Promise((res) => {
      this.waiters.push(res);
      this.sock.write(JSON.stringify({ token: TOKEN, ...op }) + "\n");
    });
  }
  close(): void {
    this.sock.end();
  }
}

// --- processes -------------------------------------------------------------------------------

function childrenOf(pid: number): { pid: number; name: string }[] {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`], { encoding: "utf8" });
  return r.stdout.split(/\r?\n/).filter(Boolean).map((l) => ({ pid: Number(l.split(" ")[0]), name: l.split(" ").slice(1).join(" ") }));
}

/** Opens a terminal window running the attach client; returns the client's pid. */
async function openWindow(title: string, id: string, viaConhost = false): Promise<number> {
  const attach = [BIN, "attach", "--port", String(PORT), "--token", TOKEN, "--id", id];
  const argv = viaConhost ? ["conhost.exe", ...attach] : attach;
  const cmd = spawn("cmd.exe", [windowsCommandLine({ argv, cwd: HERE, env: {}, title })], { cwd: HERE, detached: true, stdio: "ignore", windowsHide: false, windowsVerbatimArguments: true });
  cmd.unref();
  return waitFor(`the attach client of ${title}`, () => {
    for (const c of childrenOf(cmd.pid!)) {
      if (c.name.toLowerCase() === "ptyhost.exe") return c.pid;
      for (const g of childrenOf(c.pid)) if (g.name.toLowerCase() === "ptyhost.exe") return g.pid;
    }
    return undefined;
  }, 15000);
}

// --- the transcript --------------------------------------------------------------------------

const transcriptOf = (sessionId: string) => transcriptPathFor(CONFIG, WORK, sessionId);
function rows(sessionId: string): any[] {
  const path = transcriptOf(sessionId);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
}
function text(row: any): string {
  const c = row?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  return "";
}
const replies = (sid: string) => rows(sid).filter((r) => r.type === "assistant" && text(r).trim());
const userRow = (sid: string, needle: string) => rows(sid).find((r) => r.type === "user" && text(r).includes(needle));
const flags = (r: any) => ({ isMeta: r?.isMeta ?? null, origin: r?.origin ?? null, promptSource: r?.promptSource ?? null, userType: r?.userType ?? null });

// --- the run ---------------------------------------------------------------------------------

async function main(): Promise<void> {
  log(`host ${BIN} on 127.0.0.1:${PORT}`);
  const hostLog = openSync(join(OUT, "host.log"), "a");
  const env = { ...scrub(process.env), CLAUDE_CONFIG_DIR: CONFIG };
  const host = spawn(BIN, ["serve", "--port", String(PORT), "--token", TOKEN, "--raw", OUT], { cwd: HERE, env: env as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", hostLog, hostLog], windowsHide: true });
  host.unref();
  pids.host = host.pid;
  savePids();
  const ctl = await waitFor("the host to listen", () => Control.open().catch(() => undefined), 10000);

  // A. A session with no window attached.
  const spawned = await ctl.req({ op: "spawn", argv: [CLAUDE, "--model", "haiku", "--settings", SETTINGS], cwd: WORK, cols: 120, rows: 36 });
  if (!spawned.ok) throw new Error(`spawn: ${spawned.error}`);
  const id: string = spawned.id;
  pids.claude = spawned.pid;
  savePids();
  log("A. spawned", spawned);
  const reg = () => readRegistry(join(CONFIG, "sessions")).find((l) => l.pid === pids.claude);
  const screen = async () => (await ctl.req({ op: "screen", id })) as { text: string; clients: number; size: number[] };
  const shown = (s: { text: string }) => s.text.split("\n").map((l) => l.trimEnd()).filter(Boolean).join("\n");
  // A new folder asks for trust first, and the session registers only once it is answered.
  const opening = await waitFor("the trust dialog or the prompt", async () => {
    const s = await screen();
    return /trust/i.test(s.text) || /shift\+tab/i.test(s.text) ? s : undefined;
  }, 30000);
  if (/trust/i.test(opening.text)) {
    log("A. trust dialog with no window:\n" + shown(opening));
    // No numbers here: the arrow down to "Yes", checked on the screen, then Enter.
    const selected = async () => (await screen()).text.split("\n").find((l) => l.includes("❯")) ?? "";
    for (let i = 0; i < 3 && !/❯\s*Yes/.test(await selected()); i++) {
      await ctl.req({ op: "write", id, data: "\x1b[B" });
      await sleep(500);
    }
    const row = await selected();
    if (!/❯\s*Yes/.test(row)) throw new Error(`the arrow did not reach Yes: ${JSON.stringify(row)}`);
    log(`A. selected ${JSON.stringify(row.trim())}; Enter`);
    await ctl.req({ op: "write", id, data: "\r" });
  }
  const first = await waitFor("the registry entry", reg, 60000);
  log("A. registered with no window attached, session", first.sessionId);
  await waitFor("the prompt", async () => /shift\+tab/i.test((await screen()).text) || undefined, 30000).catch(() => log("A. no prompt marker seen"));
  log("A. screen with no window:\n" + shown(await screen()));

  // B. A real terminal window, attached.
  pids.clients.push(await openWindow("pty-host s1", id));
  savePids();
  await sleep(3000);
  log("B. window attached; host sees clients:", (await screen()).clients, "size:", (await screen()).size);

  // C. Typed through the host: a user turn, and /clear clears.
  async function turn(sid: string, say: string): Promise<string> {
    const before = replies(sid).length;
    log(`C. submit ${JSON.stringify(say)}`);
    await ctl.req({ op: "submit", id, text: say });
    const landed = await waitFor("the user row", () => userRow(sid, say.slice(0, 20)), 10000).catch(() => undefined);
    if (!landed) {
      log("C. no user row after 10 s: Enter again");
      await ctl.req({ op: "write", id, data: "\r" });
    }
    const reply = await waitFor(`a reply to ${say}`, async () => {
      if (/Do you want to/i.test((await screen()).text)) throw new Error("the turn stopped on a permission dialog:\n" + shown(await screen()));
      return replies(sid)[before];
    }, 120000);
    log(`C. reply ${JSON.stringify(text(reply).trim())}`);
    return text(reply).trim();
  }
  const sid1 = first.sessionId;
  await turn(sid1, "Here is a code word for this chat only: PINEAPPLE. Do not save it anywhere. Reply with just: OK");
  log("C. that turn as stored:", flags(userRow(sid1, "PINEAPPLE")));
  await sleep(1500);
  log("C. submit \"/clear\"");
  await ctl.req({ op: "submit", id, text: "/clear" });
  const sid2 = await waitFor("a new session id", () => {
    const l = reg();
    return l && l.sessionId !== sid1 ? l.sessionId : undefined;
  }, 30000).catch(() => undefined);
  log("C. session id after /clear:", sid2 ?? `(unchanged: ${reg()?.sessionId})`);
  const sidNow = sid2 ?? sid1;
  await sleep(1500);
  await turn(sidNow, "What was the code word I gave you in this chat? Reply with just the word, or NONE if you have none.");
  log("C. that turn as stored:", flags(userRow(sidNow, "What was the code word")));

  // D. Plan mode, and the CLI's own "clear context" row pressed by key.
  for (let i = 0; i < 5 && !/plan mode/i.test((await screen()).text); i++) {
    await ctl.req({ op: "write", id, data: "\x1b[Z" });
    await sleep(900);
  }
  log("D. plan mode on:", /plan mode/i.test((await screen()).text));
  const sidPlan = reg()!.sessionId;
  await ctl.req({ op: "submit", id, text: "Make a plan to create hello.txt in the current directory containing the single word hi. Keep the plan to one line, then exit plan mode." });
  log("D. plan asked; waiting for the dialog");
  const dialog = await waitFor("the plan dialog", async () => {
    const s = await screen();
    return /clear context/i.test(s.text) ? s : undefined;
  }, 180000);
  log("D. the dialog:\n" + shown(dialog));
  const row = dialog.text.split("\n").find((l) => /clear context/i.test(l)) ?? "";
  const key = /(\d)\./.exec(row)?.[1];
  log(`D. clear-context row ${JSON.stringify(row.trim())}; pressing ${JSON.stringify(key)}`);
  if (key) await ctl.req({ op: "write", id, data: key });
  await sleep(1500);
  if (/clear context/i.test((await screen()).text)) {
    log("D. dialog still open after the digit: Enter");
    await ctl.req({ op: "write", id, data: "\r" });
  }
  const sid3 = await waitFor("a new session id", () => {
    const l = reg();
    return l && l.sessionId !== sidPlan ? l.sessionId : undefined;
  }, 60000).catch(() => undefined);
  log("D. session id after the row:", sid3 ?? "(unchanged)");
  if (sid3) {
    const firstUser = await waitFor("the first user row", () => rows(sid3).find((r) => r.type === "user" && text(r).trim()), 30000).catch(() => undefined);
    log("D. its first message:", JSON.stringify(text(firstUser).slice(0, 160)), flags(firstUser));
  }
  const hello = join(WORK, "hello.txt");
  const made = await waitFor("hello.txt", async () => {
    if (existsSync(hello)) return "made";
    if (/Do you want to/i.test((await screen()).text)) return "prompted";
    return undefined;
  }, 180000).catch(() => "timed out");
  log("D. hello.txt:", made, existsSync(hello) ? JSON.stringify(readFileSync(hello, "utf8")) : "");
  await sleep(4000);
  log("D. screen after:\n" + shown(await screen()));

  // E. Detach and reattach, the second time in a classic console window.
  const firstClient = pids.clients[0]!;
  spawnSync("taskkill", ["/PID", String(firstClient), "/F"]);
  await sleep(2000);
  log("E. killed the first window's client; host sees clients:", (await screen()).clients);
  pids.clients.push(await openWindow("pty-host s1 (conhost)", id, true));
  savePids();
  await sleep(3000);
  log("E. reattached in conhost; host sees clients:", (await screen()).clients, "size:", (await screen()).size);

  ctl.close();
  log("done: the host, the session and the conhost window are left up; `bun stop.ts` ends them");
}

main()
  .catch((e) => log("FAILED:", String(e?.stack ?? e)))
  .finally(() => {
    savePids();
    process.exit(0);
  });
