// Terminals in the views. Every client hears each terminal's row (`terminal.state`) when what
// it shows changes: it started or ended, its title, size or windows moved, a session came into
// it or left, or an agent CLI started or ended in it. A client that opens one (`terminal.open`) gets its repaint, then its
// output, to it alone, as `terminal.output`.
//
// However many clients look at a terminal, the daemon holds one subscription to it, and hands
// each client the output from the position its own repaint stood at, decoded to text on its
// own, so a character split across two reads arrives whole. Output is batched per client by
// how far away it is (a few milliseconds on loopback, longer over the LAN and the relay), at
// most 64 KiB to a batch, and the first batch always follows the answer to the open. A client
// whose socket has more queued than it can take is sent nothing until it has drained, then a
// fresh repaint (`reset`) instead of what it missed; so is every client of a terminal when the
// daemon's own subscription fell behind the host.
//
// Watching never sizes a terminal. A client that opens one with `input` types into it through
// the daemon's subscription, which sizes nothing. One that opens it with `drive` sizes it too,
// through a connection of its own to the host holding a sizing subscription, so the host's
// own rule applies: whoever typed or resized last, a window or this client, has the size, and
// when the client goes, the window has it back.
//
// A terminal started in a folder lent to a workspace node is that node's, decided when it is
// first seen: the machine's clients neither list it nor open it, start one there, nor hear
// its row.

import { homedir } from "node:os";
import { RpcError } from "@cophyla/protocol";
import type { ClientParams, ClientResult, HarnessKind, NodeId, Session, Terminal, TerminalRef, TerminalSize } from "@cophyla/protocol";
import type { Subscription, TetherClient } from "@tether-pty/client";
import type { ClientRegistry, ListenerKind } from "../../api/clients.ts";
import type { Bus } from "../../bus.ts";
import type { Logger } from "../../log.ts";
import type { Workspaces } from "../../workspaces/index.ts";
import type { TerminalChange, TerminalEntry, Tether } from "./index.ts";

/** How long output waits to be sent with what follows it, by where the client is. */
const BATCH_MS: Record<ListenerKind, number> = { loopback: 8, controller: 30, relay: 30, relayed: 30, cloud: 100, p2p: 30 };
/** The most output one `terminal.output` carries. */
export const BATCH_CAP = 64 * 1024;
/** A client whose socket holds more than this unsent gets no output until it drained to `CAUGHT_UP_AT`. */
export const BEHIND_AT = 1024 * 1024;
export const CAUGHT_UP_AT = 128 * 1024;
const DRAIN_POLL_MS = 100;
/** A terminal's row waits this long for the changes that follow it (a window being dragged). */
const ROW_MS = 50;

function keyOf(ref: TerminalRef): string {
  return `${ref.host}/${ref.id}`;
}

function refOf(key: string): TerminalRef {
  const i = key.indexOf("/");
  return { host: key.slice(0, i), id: key.slice(i + 1) };
}

/**
 * The user's shell: PowerShell 7 where it is installed, else Windows PowerShell; `$SHELL`
 * elsewhere, a login shell on macOS as Terminal starts it, so `/etc/zprofile` and
 * `~/.zprofile` (Homebrew's `shellenv`) run.
 */
export function shellOf(env: Record<string, string>, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") return [Bun.which("pwsh", { PATH: env["PATH"] ?? env["Path"] ?? "" }) ? "pwsh.exe" : "powershell.exe", "-NoLogo"];
  const shell = env["SHELL"] || "/bin/sh";
  return platform === "darwin" ? [shell, "-l"] : [shell];
}

export interface TerminalRowsDeps {
  tether: Tether;
  bus: Bus;
  nodeId: NodeId;
  workspaces: Workspaces;
  /** The environment programs start in: the daemon's own, scrubbed. */
  env: Record<string, string | undefined>;
  /** The session running in a terminal. */
  sessionOf: (ref: TerminalRef) => Session | undefined;
  /** The harness whose agents screen a terminal shows, and a subscription to its changes and to its CLI mark's. */
  agentsOf?: (ref: TerminalRef) => HarnessKind | undefined;
  onAgents?: (fn: (ref: TerminalRef) => void) => () => void;
  /** The agent CLI running in a terminal. */
  cliOf?: (ref: TerminalRef) => HarnessKind | undefined;
  /** Which workspace node owns a folder; absent, every terminal is the machine's. */
  owners?: { ownerOf(path: string): string | undefined; isPrivate(node: string): boolean };
  log: Logger;
  rowMs?: number;
}

/** Each terminal's row, told on the bus as `terminal.state` once per change of what it shows. */
export class TerminalRows {
  private deps: TerminalRowsDeps;
  private told = new Map<string, string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The terminal each live session was last seen in. */
  private links = new Map<string, string>();
  /** The workspace node each terminal started in a lent folder is, decided when it is first seen. */
  private owners = new Map<string, string | undefined>();
  private offs: (() => void)[] = [];

  constructor(deps: TerminalRowsDeps) {
    this.deps = deps;
    this.offs.push(deps.tether.onChange((c) => this.onChange(c)));
    // a session in a terminal of any partition moves that terminal's row
    this.offs.push(deps.bus.onAll("session.state", (s) => this.onSession(s)));
    if (deps.onAgents) this.offs.push(deps.onAgents((ref) => this.schedule(keyOf(ref))));
  }

  stop(): void {
    for (const off of this.offs) off();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** The machine's terminals. */
  list(): Terminal[] {
    return this.deps.tether
      .list()
      .filter((e) => this.visible(e))
      .map((e) => this.row(e));
  }

  /** The workspace node a terminal is, when it started in a lent folder; undefined for the machine's. */
  private ownerOf(entry: TerminalEntry): string | undefined {
    const key = keyOf(entry.ref);
    if (this.owners.has(key)) return this.owners.get(key);
    const owner = this.deps.owners?.ownerOf(entry.info.cwd);
    this.owners.set(key, owner);
    return owner;
  }

  /** Whether a terminal is the machine's, which its clients may see and open. */
  visible(entry: TerminalEntry): boolean {
    return this.ownerOf(entry) === undefined;
  }

  /** Its CLI counts only while no session stands for it and it shows no agents screen; a session of another partition is not named. */
  row(entry: TerminalEntry): Terminal {
    const owner = this.ownerOf(entry);
    const s = this.deps.sessionOf(entry.ref);
    const same = s !== undefined && (owner === undefined ? !(this.deps.owners?.isPrivate(s.node) ?? false) : s.node === owner);
    const session = same ? s.id : undefined;
    const agents = this.deps.agentsOf?.(entry.ref);
    return this.deps.tether.toTerminal(entry, session, agents, session || agents ? undefined : this.deps.cliOf?.(entry.ref), owner);
  }

  /**
   * Starts a program in a terminal: in `cwd`, a workspace's folder, or the user's home. One
   * started in a workspace is work there, and moves it up the views' recent workspaces.
   */
  async spawn(p: ClientParams<"terminal.spawn">): Promise<Terminal> {
    if (!this.deps.tether.available) throw new RpcError("unsupported", "tether is not on this node");
    let cwd = p.cwd;
    let workspace: string | undefined;
    if (cwd === undefined && p.workspace !== undefined) {
      const ws = this.deps.workspaces.get(p.workspace);
      if (!ws) throw new RpcError("not_found", `no workspace ${p.workspace}`);
      if (ws.node !== this.deps.nodeId) throw new RpcError("unsupported", "the workspace is on another node");
      cwd = ws.path;
      workspace = ws.id;
    }
    // A lent folder is the other cluster's: a terminal started there would be theirs.
    if (this.deps.owners?.ownerOf(cwd ?? homedir()) !== undefined) throw new RpcError("conflict", `${cwd ?? homedir()} is lent to a workspace node`);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.deps.env)) if (v !== undefined) env[k] = v;
    const argv = p.argv ?? shellOf(env);
    const { ref } = await this.deps.tether.spawn({
      argv,
      cwd: cwd ?? homedir(),
      env,
      ...(p.name ? { name: p.name } : {}),
      ...(p.size ? { cols: p.size.cols, rows: p.size.rows } : {}),
      labels: { app: "cophylad" },
    });
    if (workspace !== undefined) this.deps.workspaces.touch(workspace);
    const entry = this.deps.tether.get(ref) ?? { ref, info: await this.deps.tether.info(ref) };
    this.deps.log.info("terminal started", { terminal: ref.id, argv0: argv[0], cwd });
    return this.row(entry);
  }

  private onChange(c: TerminalChange): void {
    const key = keyOf(c.entry.ref);
    if (!c.gone) return this.schedule(key);
    // Gone with its host, or removed: told once more, as ended, and forgotten.
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.told.delete(key);
    const row = this.deps.tether.toTerminal(c.entry, undefined, undefined, undefined, this.ownerOf(c.entry));
    this.owners.delete(key);
    this.deps.bus.emit("terminal.state", { ...row, status: "exited" });
  }

  private onSession(s: Session): void {
    const now = s.status !== "ended" && s.native.terminal ? keyOf(s.native.terminal) : undefined;
    const before = this.links.get(s.id);
    if (before === now) return;
    if (now) this.links.set(s.id, now);
    else this.links.delete(s.id);
    for (const key of [before, now]) if (key) this.schedule(key);
  }

  private schedule(key: string): void {
    if (this.timers.has(key)) return;
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.tell(key);
      }, this.deps.rowMs ?? ROW_MS),
    );
  }

  private tell(key: string): void {
    const entry = this.deps.tether.get(refOf(key));
    if (!entry) return;
    const row = this.row(entry);
    const line = JSON.stringify(row);
    if (this.told.get(key) === line) return;
    this.told.set(key, line);
    this.deps.bus.emit("terminal.state", row);
  }
}

interface Chunk {
  data: Uint8Array;
  seq: number;
}

interface Viewer {
  client: string;
  feed: Feed;
  input: boolean;
  /** The connection and sizing subscription of a client that drives the terminal. */
  drive?: { conn: TetherClient; sub: Subscription };
  decoder: TextDecoder;
  /** The output position this client has been given up to. */
  at: number;
  /** The size the client last heard the terminal has. */
  cols: number;
  rows: number;
  /** Output held while this client's repaint is fetched. */
  held?: Chunk[];
  /** The daemon's subscription fell behind while the repaint was fetched: fetch another. */
  stale?: boolean;
  text: string[];
  bytes: number;
  timer?: ReturnType<typeof setTimeout>;
  /** A first batch went out, after the answer to the open: later ones may go at once. */
  live: boolean;
  /** Set while nothing is sent, until the socket drained. */
  behind?: ReturnType<typeof setInterval>;
  closed: boolean;
}

interface Feed {
  ref: TerminalRef;
  sub: Promise<Subscription>;
  viewers: Map<string, Viewer>;
}

export interface TerminalStreamsDeps {
  tether: Tether;
  registry: Pick<ClientRegistry, "get" | "send">;
  rows: Pick<TerminalRows, "row" | "visible">;
  log: Logger;
}

/** The terminals clients have open: one subscription per terminal, and each client's share of it. */
export class TerminalStreams {
  private deps: TerminalStreamsDeps;
  private feeds = new Map<string, Feed>();
  private off: () => void;

  constructor(deps: TerminalStreamsDeps) {
    this.deps = deps;
    this.off = deps.tether.onChange((c) => {
      if (c.gone) this.closeFeed(keyOf(c.entry.ref));
    });
  }

  async stop(): Promise<void> {
    this.off();
    for (const key of [...this.feeds.keys()]) this.closeFeed(key);
  }

  /** Opens a terminal for a client, replacing the view it had of it. */
  async open(client: string, id: string, opts: { input?: boolean; drive?: TerminalSize }): Promise<ClientResult<"terminal.open">> {
    const entry = this.deps.tether.byId(id);
    if (!entry || !this.deps.rows.visible(entry)) throw new RpcError("not_found", `no terminal ${id}`);
    await this.close(client, id);
    const feed = this.feed(entry.ref);
    const v: Viewer = { client, feed, input: opts.input === true || opts.drive !== undefined, decoder: new TextDecoder(), at: 0, cols: 0, rows: 0, held: [], text: [], bytes: 0, live: false, closed: false };
    feed.viewers.set(client, v);
    try {
      await feed.sub;
      if (opts.drive) v.drive = await this.driving(entry.ref, opts.drive);
      const snap = await this.deps.tether.screen(entry.ref, "vt", { scrollback: true });
      if (v.closed) throw new RpcError("cancelled", `terminal ${id} was closed while it opened`);
      v.cols = snap.cols;
      v.rows = snap.rows;
      this.joined(v, snap.seq);
      return { terminal: this.deps.rows.row(this.deps.tether.get(entry.ref) ?? entry), seq: snap.seq, cols: snap.cols, rows: snap.rows, data: snap.data ?? "" };
    } catch (e) {
      this.dropViewer(v);
      if (e instanceof RpcError) throw e;
      throw new RpcError("unavailable", `terminal ${id} could not be opened: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Stops a client's view of a terminal; `end` also ends its program. */
  async close(client: string, id: string, end = false): Promise<void> {
    const v = this.viewer(client, id);
    if (v) this.dropViewer(v);
    if (!end) return;
    const entry = this.deps.tether.byId(id);
    if (!entry || !this.deps.rows.visible(entry)) throw new RpcError("not_found", `no terminal ${id}`);
    await this.deps.tether.kill(entry.ref);
  }

  /** A client went away: every view it had goes. */
  dropClient(client: string): void {
    for (const feed of [...this.feeds.values()]) {
      const v = feed.viewers.get(client);
      if (v) this.dropViewer(v);
    }
  }

  /** Keys from a client that opened the terminal to type into it; from any other, nothing. */
  input(client: string, id: string, data: string): void {
    const v = this.viewer(client, id);
    if (!v?.input) {
      this.deps.log.debug("terminal input from a client that may not type", { client, terminal: id });
      return;
    }
    if (v.drive) {
      v.drive.sub.input(data);
      return;
    }
    void v.feed.sub.then((sub) => sub.input(data)).catch(() => undefined);
  }

  /** The size of a client that drives the terminal; from any other, nothing. */
  resize(client: string, id: string, size: TerminalSize): void {
    const v = this.viewer(client, id);
    if (!v?.drive) return;
    void v.drive.conn.resize(v.feed.ref.id, size.cols, size.rows).catch((e: unknown) => this.deps.log.debug("terminal resize failed", { terminal: id, error: e instanceof Error ? e.message : String(e) }));
  }

  /** How many clients look at a terminal, for tests and the log. */
  viewers(id: string): number {
    for (const f of this.feeds.values()) if (f.ref.id === id) return f.viewers.size;
    return 0;
  }

  private viewer(client: string, id: string): Viewer | undefined {
    for (const f of this.feeds.values()) if (f.ref.id === id) return f.viewers.get(client);
    return undefined;
  }

  private feed(ref: TerminalRef): Feed {
    const key = keyOf(ref);
    const held = this.feeds.get(key);
    if (held) return held;
    const feed: Feed = { ref, viewers: new Map(), sub: Promise.resolve(undefined as unknown as Subscription) };
    feed.sub = this.deps.tether.subscribe(ref, { from: "now", input: true, role: "viewer" }, { onOutput: (data, seq) => this.output(feed, data, seq), onResync: () => this.resynced(feed) });
    // A subscription that failed is not kept: the next open tries again.
    feed.sub.catch(() => {
      if (this.feeds.get(key) === feed) this.feeds.delete(key);
    });
    this.feeds.set(key, feed);
    return feed;
  }

  private async driving(ref: TerminalRef, size: TerminalSize): Promise<{ conn: TetherClient; sub: Subscription }> {
    const conn = await this.deps.tether.connectAlone(ref.host, "cophylad view");
    try {
      const sub = await conn.subscribe({ session: ref.id, from: "now", input: true, sizing: true, size, role: "viewer" }, { onOutput() {}, onResync() {} });
      return { conn, sub };
    } catch (e) {
      conn.close();
      throw e;
    }
  }

  private closeFeed(key: string): void {
    const feed = this.feeds.get(key);
    if (!feed) return;
    for (const v of [...feed.viewers.values()]) this.dropViewer(v);
    this.feeds.delete(key);
  }

  private dropViewer(v: Viewer): void {
    v.closed = true;
    clearTimeout(v.timer);
    clearInterval(v.behind);
    v.drive?.conn.close();
    const feed = v.feed;
    if (feed.viewers.get(v.client) === v) feed.viewers.delete(v.client);
    if (feed.viewers.size > 0) return;
    if (this.feeds.get(keyOf(feed.ref)) === feed) this.feeds.delete(keyOf(feed.ref));
    void feed.sub.then((s) => s.unsubscribe()).catch(() => undefined);
  }

  private output(feed: Feed, data: Uint8Array, seq: number): void {
    for (const v of feed.viewers.values()) {
      if (v.closed || v.behind) continue;
      if (v.held) v.held.push({ data: data.slice(), seq });
      else this.deliver(v, data, seq);
    }
  }

  /** The daemon's subscription fell behind the host: every client of it starts over from a repaint. */
  private resynced(feed: Feed): void {
    this.deps.log.info("terminal stream fell behind; its viewers are repainted", { terminal: feed.ref.id });
    for (const v of feed.viewers.values()) {
      if (v.closed || v.behind) continue;
      if (v.held) v.stale = true;
      else void this.reset(v);
    }
  }

  /** A client's repaint stands at `seq`: what was held from there on is its. */
  private joined(v: Viewer, seq: number): void {
    v.at = seq;
    const held = v.held ?? [];
    v.held = undefined;
    for (const c of held) this.deliver(v, c.data, c.seq);
    if (v.stale) {
      v.stale = false;
      setTimeout(() => void this.reset(v), 0);
    }
  }

  private deliver(v: Viewer, data: Uint8Array, seq: number): void {
    const end = seq + data.length;
    if (end <= v.at) return;
    const bytes = seq < v.at ? data.subarray(v.at - seq) : data;
    // What is held goes first when this would take the batch past its cap.
    if (v.live && v.bytes > 0 && v.bytes + bytes.length > BATCH_CAP) this.flush(v);
    v.at = end;
    const text = v.decoder.decode(bytes, { stream: true });
    if (text) v.text.push(text);
    v.bytes += bytes.length;
    if (this.buffered(v) > BEHIND_AT) return this.fallBehind(v);
    if (v.live && v.bytes >= BATCH_CAP) return this.flush(v);
    v.timer ??= setTimeout(() => this.flush(v), v.bytes >= BATCH_CAP ? 0 : this.batchMs(v));
  }

  private flush(v: Viewer): void {
    clearTimeout(v.timer);
    v.timer = undefined;
    v.live = true;
    if (v.closed || v.text.length === 0) {
      v.bytes = 0;
      return;
    }
    const data = v.text.join("");
    v.text = [];
    v.bytes = 0;
    // A size the client has not heard yet goes with the output drawn at it.
    const info = this.deps.tether.get(v.feed.ref)?.info;
    const resized = info !== undefined && (info.cols !== v.cols || info.rows !== v.rows);
    if (resized) {
      v.cols = info.cols;
      v.rows = info.rows;
    }
    const sent = this.deps.registry.send(v.client, "terminal.output", { terminal: v.feed.ref.id, seq: v.at, data, ...(resized ? { cols: v.cols, rows: v.rows } : {}) });
    if (!sent) this.dropViewer(v);
  }

  private fallBehind(v: Viewer): void {
    clearTimeout(v.timer);
    v.timer = undefined;
    v.text = [];
    v.bytes = 0;
    this.deps.log.info("terminal viewer fell behind; it gets a repaint once it drained", { client: v.client, terminal: v.feed.ref.id });
    v.behind = setInterval(() => {
      if (v.closed) return clearInterval(v.behind);
      if (this.buffered(v) > CAUGHT_UP_AT) return;
      clearInterval(v.behind);
      v.behind = undefined;
      void this.reset(v);
    }, DRAIN_POLL_MS);
  }

  /** Sends a client a fresh repaint, and its output from there. */
  private async reset(v: Viewer): Promise<void> {
    if (v.closed) return;
    clearTimeout(v.timer);
    v.timer = undefined;
    v.text = [];
    v.bytes = 0;
    v.held = [];
    let snap;
    try {
      snap = await this.deps.tether.screen(v.feed.ref, "vt", { scrollback: true });
    } catch (e) {
      this.deps.log.debug("terminal repaint failed", { terminal: v.feed.ref.id, error: e instanceof Error ? e.message : String(e) });
      v.held = undefined;
      return;
    }
    if (v.closed) return;
    v.decoder = new TextDecoder();
    v.live = true;
    v.cols = snap.cols;
    v.rows = snap.rows;
    if (!this.deps.registry.send(v.client, "terminal.output", { terminal: v.feed.ref.id, seq: snap.seq, data: snap.data ?? "", reset: true, cols: snap.cols, rows: snap.rows })) return this.dropViewer(v);
    this.joined(v, snap.seq);
  }

  private buffered(v: Viewer): number {
    return this.deps.registry.get(v.client)?.socket.buffered?.() ?? 0;
  }

  private batchMs(v: Viewer): number {
    return BATCH_MS[this.deps.registry.get(v.client)?.listener ?? "loopback"];
  }
}
