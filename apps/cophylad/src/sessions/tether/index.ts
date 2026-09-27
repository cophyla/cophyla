// cophylad's side of tether: the terminals the node's tether hosts hold, and the requests
// sessions make of them. At start the daemon adopts every host running under the user's
// tether folder — their sessions outlived the daemon that started them, as terminal sessions
// always have — and, every few seconds after, any host started since: a terminal the user
// opens when no host runs (none yet, or the last one idled out) starts one of its own. It
// watches each, so it knows every terminal by its host, its id and its program's pid. A spawn goes to the host new sessions belong to, started on demand from the
// staged binary (see locate.ts); a host from an older binary keeps its sessions until they end.
//
// tether knows nothing of harnesses; which terminal holds which session is settled by the
// caller, by pid, and which agent CLI runs in one by its processes (cli.ts).

import { execFile } from "node:child_process";
import type { HarnessKind, NodeId, Terminal, TerminalRef } from "@cophyla/protocol";
import { connectOrStart, liveHosts, stateDir, TetherClient } from "@tether-pty/client";
import type { HostFile, Screen, SessionInfo, StartOptions, StreamHandlers, SubscribeParams, Subscription, TetherEvent } from "@tether-pty/client";
import type { TetherConfig } from "../../config/schema.ts";
import type { Logger } from "../../log.ts";
import { locateTether, stageTether } from "./locate.ts";

export interface RunResult {
  code: number;
  out: string;
  err: string;
}

export type Run = (exe: string, args: string[], env: Record<string, string | undefined>) => Promise<RunResult>;

function runFile(exe: string, args: string[], env: Record<string, string | undefined>): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(exe, args, { env: env as NodeJS.ProcessEnv, timeout: 30000, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      resolve({ code, out: String(stdout), err: String(stderr) });
    });
  });
}

export interface TetherOptions {
  config: TetherConfig;
  env: Record<string, string | undefined>;
  dataDir: string;
  nodeId: NodeId;
  log: Logger;
  /** `versions/<v>/` of an installed platform. */
  versionDir?: string;
  repoRoot?: string;
  /** Seams: the binary already staged, and how hosts are reached. */
  exe?: string;
  run?: Run;
  connectOrStart?: (opts: StartOptions) => Promise<TetherClient>;
  connect?: (host: HostFile) => Promise<TetherClient>;
  hosts?: (dir: string) => HostFile[];
  /** How often the tether folder is looked at for a host started since; `SCAN_MS` by default. */
  scanMs?: number;
}

/** How often the tether folder is read for a host the daemon does not hold: one directory listing. */
export const SCAN_MS = 3000;

function unref(t: unknown): void {
  if (t && typeof t === "object" && "unref" in t) (t as { unref(): void }).unref();
}

/** A terminal as the host last described it. */
export interface TerminalEntry {
  ref: TerminalRef;
  info: SessionInfo;
}

export type TerminalChange = { entry: TerminalEntry; gone?: false } | { entry: TerminalEntry; gone: true };

function key(ref: TerminalRef): string {
  return `${ref.host}/${ref.id}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export class Tether {
  readonly dir: string;
  private opts: TetherOptions;
  private run: Run;
  private exePath?: string;
  private version?: string;
  private clients = new Map<string, TetherClient>();
  private entries = new Map<string, TerminalEntry>();
  private listeners = new Set<(c: TerminalChange) => void>();
  private starting?: Promise<TetherClient>;
  private stopped = false;
  private scanTimer?: ReturnType<typeof setInterval>;
  private scanning = false;
  /** Hosts that could not be adopted, by id: each is warned of once, not at every scan. */
  private refused = new Set<string>();

  constructor(opts: TetherOptions) {
    this.opts = opts;
    this.run = opts.run ?? runFile;
    this.dir = opts.config.dir ?? stateDir(opts.env);
    if (opts.exe) this.exePath = opts.exe;
  }

  /** The binary sessions run under, staged; `undefined` when tether is not on this node. */
  get exe(): string | undefined {
    return this.exePath;
  }

  get available(): boolean {
    return this.exePath !== undefined;
  }

  /** Where a window opens when no editor has the folder. */
  get window(): TetherConfig["window"] {
    return this.opts.config.window;
  }

  /** Whether a session cophylad starts gets a window at once. */
  get windowOnStart(): boolean {
    return this.opts.config.window_on_start === true;
  }

  /** Finds and stages the binary, then adopts the hosts already running. */
  async start(): Promise<void> {
    if (!this.exePath) {
      const found = locateTether({ config: this.opts.config, env: this.opts.env, ...(this.opts.versionDir ? { versionDir: this.opts.versionDir } : {}), ...(this.opts.repoRoot ? { repoRoot: this.opts.repoRoot } : {}) });
      if (!found) {
        this.opts.log.info("tether not found; sessions start in a terminal of their own");
        return;
      }
      const version = await this.versionOf(found.path);
      if (!version) {
        this.opts.log.warn("tether did not say its version; not used", { path: found.path });
        return;
      }
      try {
        this.exePath = stageTether(found.path, this.opts.dataDir, version);
        this.version = version;
      } catch (e) {
        this.opts.log.warn("tether could not be staged; not used", { path: found.path, error: e instanceof Error ? e.message : String(e) });
        return;
      }
      this.opts.log.info("tether found", { origin: found.origin, version, exe: this.exePath, dir: this.dir });
    }
    const hosts = (this.opts.hosts ?? liveHosts)(this.dir);
    for (const h of hosts) await this.connect(h).catch((e: unknown) => this.refuse(h, e));
    if (hosts.length > 0) this.opts.log.info("tether hosts adopted", { hosts: this.clients.size, terminals: this.entries.size });
    this.scanTimer = setInterval(() => void this.scan(), this.opts.scanMs ?? SCAN_MS);
    unref(this.scanTimer);
  }

  /** Adopts every live host not held: one a terminal started after the daemon, when no host ran. */
  private async scan(): Promise<void> {
    if (this.stopped || this.scanning) return;
    this.scanning = true;
    try {
      for (const h of (this.opts.hosts ?? liveHosts)(this.dir)) {
        const held = this.clients.get(h.host);
        if ((held && !held.closed) || this.refused.has(h.host)) continue;
        try {
          await this.connect(h);
          this.opts.log.info("tether host adopted", { host: h.host, terminals: [...this.entries.values()].filter((e) => e.ref.host === h.host).length });
        } catch (e) {
          this.refuse(h, e);
        }
      }
    } catch {
      // the folder unreadable this time: the next scan looks again
    } finally {
      this.scanning = false;
    }
  }

  private refuse(host: HostFile, e: unknown): void {
    this.refused.add(host.host);
    this.opts.log.warn("tether host not adopted", { host: host.host, error: e instanceof Error ? e.message : String(e) });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
    this.entries.clear();
  }

  private async versionOf(exe: string): Promise<string | undefined> {
    const r = await this.run(exe, ["--version"], this.opts.env);
    return r.code === 0 ? r.out.trim().split(/\s+/).pop() : undefined;
  }

  /** Arguments that carry the configured state folder to another `tether`. */
  private dirArgs(): string[] {
    return this.opts.config.dir ? ["--dir", this.opts.config.dir] : [];
  }

  onChange(cb: (c: TerminalChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed(c: TerminalChange): void {
    for (const l of this.listeners) l(c);
  }

  /** Connects to a host, watches it, and learns its terminals; the client already held when there is one. */
  private async connect(host: HostFile): Promise<TetherClient> {
    const held = this.clients.get(host.host);
    if (held && !held.closed) return held;
    const client = await (this.opts.connect ?? ((h) => TetherClient.connect(h, { name: "cophylad" })))(host);
    return this.adopt(client);
  }

  private async adopt(client: TetherClient): Promise<TetherClient> {
    const host = client.host.host;
    const held = this.clients.get(host);
    if (held && !held.closed && held !== client) {
      client.close();
      return held;
    }
    this.clients.set(host, client);
    client.onEvent((e) => this.onEvent(host, e));
    client.onClose(() => this.lost(host, client));
    await client.watch();
    for (const info of await client.list()) this.put({ host, id: info.session }, info);
    return client;
  }

  /** A host's connection closed: it exited, and its terminals with it, or it is unreachable. */
  private lost(host: string, client: TetherClient): void {
    if (this.clients.get(host) !== client) return;
    this.clients.delete(host);
    if (this.stopped) return;
    for (const [k, e] of this.entries) {
      if (e.ref.host !== host) continue;
      this.entries.delete(k);
      this.changed({ entry: e, gone: true });
    }
    this.opts.log.info("tether host gone", { host });
  }

  private put(ref: TerminalRef, info: SessionInfo): TerminalEntry {
    const entry = { ref, info };
    this.entries.set(key(ref), entry);
    this.changed({ entry });
    return entry;
  }

  private onEvent(host: string, e: TetherEvent): void {
    if (typeof e.session !== "string") return;
    const ref = { host, id: e.session };
    const entry = this.entries.get(key(ref));
    if (e.ev === "created") {
      this.put(ref, e["info"] as SessionInfo);
      return;
    }
    if (!entry) return;
    const info = { ...entry.info };
    switch (e.ev) {
      case "removed":
        this.entries.delete(key(ref));
        this.changed({ entry, gone: true });
        return;
      case "exited":
        info.status = "exited";
        info.exit = { code: Number(e["code"] ?? -1), ...(typeof e["signal"] === "string" ? { signal: e["signal"] } : {}) };
        break;
      case "title":
        info.title = String(e["title"] ?? "");
        break;
      case "resized":
        info.cols = Number(e["cols"]);
        info.rows = Number(e["rows"]);
        break;
      case "cwd":
        info.cwdReported = String(e["cwd"] ?? "");
        break;
      case "labels":
        info.labels = (e["labels"] as Record<string, string>) ?? {};
        break;
      case "attached":
        info.clients = [...info.clients, e["client"] as SessionInfo["clients"][number]];
        break;
      case "detached":
        info.clients = info.clients.filter((c) => c.stream !== e["stream"]);
        break;
      default:
        return;
    }
    this.put(ref, info);
  }

  /** The host new sessions go to, started when there is none. */
  async current(): Promise<TetherClient> {
    if (!this.exePath) throw new Error("tether is not on this node");
    const start = async () => {
      const client = await (this.opts.connectOrStart ?? connectOrStart)({
        exe: this.exePath!,
        dir: this.dir,
        name: "cophylad",
        idleExitS: this.opts.config.idle_exit_s,
        ...(this.version ? { exeVersion: this.version } : {}),
      });
      return this.adopt(client);
    };
    this.starting ??= start().finally(() => (this.starting = undefined));
    return this.starting;
  }

  /** The client for a terminal's host, connecting to it when need be. */
  async client(host: string): Promise<TetherClient> {
    const held = this.clients.get(host);
    if (held && !held.closed) return held;
    const file = (this.opts.hosts ?? liveHosts)(this.dir).find((h) => h.host === host);
    if (!file) throw new Error(`tether host ${host} is not running`);
    return this.connect(file);
  }

  async spawn(p: { argv: string[]; cwd: string; env: Record<string, string>; name?: string; cols?: number; rows?: number; labels?: Record<string, string> }): Promise<{ ref: TerminalRef; pid?: number }> {
    const client = await this.current();
    const r = await client.spawn({
      argv: p.argv,
      cwd: p.cwd,
      env: { base: "empty", set: p.env },
      size: { cols: p.cols ?? 120, rows: p.rows ?? 32 },
      ...(p.name ? { name: p.name } : {}),
      ...(p.labels ? { labels: p.labels } : {}),
    });
    const ref = { host: client.host.host, id: r.session };
    // The `created` event may not have landed yet; the terminal is known from here on.
    if (!this.entries.has(key(ref))) {
      const info = await client.info(r.session).catch(() => undefined);
      if (info) this.put(ref, info);
    }
    return { ref, ...(r.pid !== undefined ? { pid: r.pid } : {}) };
  }

  get(ref: TerminalRef): TerminalEntry | undefined {
    return this.entries.get(key(ref));
  }

  /** The terminal whose program has this pid. */
  byPid(pid: number): TerminalEntry | undefined {
    for (const e of this.entries.values()) if (e.info.pid === pid && e.info.status === "running") return e;
    return undefined;
  }

  /** The terminal with this id on any host. */
  byId(id: string): TerminalEntry | undefined {
    for (const e of this.entries.values()) if (e.ref.id === id) return e;
    return undefined;
  }

  list(): TerminalEntry[] {
    return [...this.entries.values()];
  }

  /** The processes the hosts run as, for the metrics tree walk. */
  hostPids(): number[] {
    return [...this.clients.values()].filter((c) => !c.closed).map((c) => c.host.pid);
  }

  /** The command a terminal window runs to show one. */
  attachArgv(ref: TerminalRef, title: string): string[] {
    if (!this.exePath) throw new Error("tether is not on this node");
    return [this.exePath, ...this.dirArgs(), "attach", ref.id, "--title", title];
  }

  /** Opens a window on a terminal in the platform's terminal; which one it used. */
  async openWindow(ref: TerminalRef, opts: { title: string; cwd?: string; terminal?: string }): Promise<string> {
    if (!this.exePath) throw new Error("tether is not on this node");
    const args = [...this.dirArgs(), "open", ref.id, "--terminal", opts.terminal ?? "auto", "--title", opts.title, ...(opts.cwd ? ["--cwd", opts.cwd] : [])];
    const r = await this.run(this.exePath, args, { ...this.opts.env, TETHER_DIR: this.dir });
    if (r.code !== 0) throw new Error(r.err.trim() || `tether open exited ${r.code}`);
    let opened: { terminal?: string; pid?: number } = {};
    try {
      opened = JSON.parse(r.out) as typeof opened;
    } catch {
      // An older binary's answer, or none: the window is open all the same.
    }
    // The window's own process, when tether started it, so what was opened can be told apart.
    this.opts.log.info("terminal window opened", { terminal: ref.id, window: opened.terminal ?? "?", ...(opened.pid !== undefined ? { pid: opened.pid } : {}) });
    return String(opened.terminal ?? "?");
  }

  /** The windows attached to a terminal, the one used most recently first. */
  windows(ref: TerminalRef): SessionInfo["clients"] {
    const entry = this.get(ref);
    return (entry?.info.clients ?? []).filter((c) => c.role === "window").sort((a, b) => (b.lastInput ?? b.attachedAt) - (a.lastInput ?? a.attachedAt));
  }

  async info(ref: TerminalRef): Promise<SessionInfo> {
    const info = await (await this.client(ref.host)).info(ref.id);
    this.put(ref, info);
    return info;
  }

  /** A terminal's screen: `vt` is the repaint, with the scrollback when asked for. */
  async screen(ref: TerminalRef, format: "text" | "cells" | "vt" = "cells", opts: { scrollback?: boolean } = {}): Promise<Screen> {
    return (await this.client(ref.host)).screen(ref.id, { format, ...(opts.scrollback ? { scrollback: true } : {}) });
  }

  async paste(ref: TerminalRef, text: string): Promise<void> {
    await (await this.client(ref.host)).paste(ref.id, text);
  }

  async keys(ref: TerminalRef, keys: string[]): Promise<void> {
    await (await this.client(ref.host)).keys(ref.id, keys);
  }

  async write(ref: TerminalRef, data: string): Promise<void> {
    await (await this.client(ref.host)).write(ref.id, data);
  }

  async resize(ref: TerminalRef, cols: number, rows: number): Promise<void> {
    await (await this.client(ref.host)).resize(ref.id, cols, rows);
  }

  async kill(ref: TerminalRef): Promise<void> {
    await (await this.client(ref.host)).kill(ref.id);
  }

  async subscribe(ref: TerminalRef, params: Omit<SubscribeParams, "session">, handlers: StreamHandlers): Promise<Subscription> {
    return (await this.client(ref.host)).subscribe({ ...params, session: ref.id }, handlers);
  }

  /**
   * A connection of its own to a terminal's host, for a subscription that sizes the terminal:
   * the host settles typing and resizing by the sizing subscription a connection holds, so two
   * clients driving terminals must not share one. The caller closes it.
   */
  async connectAlone(host: string, name: string): Promise<TetherClient> {
    const file = (await this.client(host)).host;
    return (this.opts.connect ?? ((h) => TetherClient.connect(h, { name })))(file);
  }

  /**
   * A terminal as the client protocol carries it, with the session running in it when there is
   * one, the harness whose agents screen it shows, or the harness whose CLI runs in it.
   */
  toTerminal(entry: TerminalEntry, session?: string, agents?: HarnessKind, harness?: HarnessKind): Terminal {
    const i = entry.info;
    return {
      id: entry.ref.id,
      node: this.opts.nodeId,
      host: entry.ref.host,
      ...(i.name ? { name: i.name } : {}),
      argv0: basename(i.argv[0] ?? ""),
      cwd: i.cwd,
      ...(i.pid !== undefined ? { pid: i.pid } : {}),
      cols: i.cols,
      rows: i.rows,
      ...(i.title ? { title: i.title } : {}),
      status: i.status,
      ...(i.exit ? { exitCode: i.exit.code } : {}),
      ...(session ? { session } : {}),
      ...(agents ? { agents } : {}),
      ...(harness ? { harness } : {}),
      windows: i.clients.filter((c) => c.role === "window").length,
      startedAt: i.startedAt,
    };
  }

  /**
   * Writes terminal profiles that start `argv` in tether: a Windows Terminal fragment where
   * Windows Terminal is. Idempotent; the path when one was written.
   */
  async installProfile(opts: { app: string; name: string; argv: string[] }): Promise<string | undefined> {
    if (!this.exePath || process.platform !== "win32") return undefined;
    const r = await this.run(this.exePath, [...this.dirArgs(), "profiles", "install", "--wt", "--app", opts.app, "--name", opts.name, "--", ...opts.argv], this.opts.env);
    if (r.code !== 0) throw new Error(r.err.trim() || `tether profiles exited ${r.code}`);
    return r.out.trim().split(/\s+/).slice(1).join(" ") || undefined;
  }

  /** The binary with its state folder: what a terminal of the user's runs tether as. */
  commandArgv(): string[] {
    if (!this.exePath) throw new Error("tether is not on this node");
    return [this.exePath, ...this.dirArgs()];
  }

  /**
   * What the user types in a terminal of their own to show a terminal there: `tether` by name
   * where the PATH finds it (the platform puts it there), else this node's own copy.
   */
  attachCommand(ref: TerminalRef): string {
    if (!this.exePath) throw new Error("tether is not on this node");
    const bin = Bun.which("tether") ? "tether" : this.exePath;
    return [bin, ...this.dirArgs(), "attach", ref.id].map((w) => (/[\s"'&|<>^()]/.test(w) ? `"${w}"` : w)).join(" ");
  }
}
