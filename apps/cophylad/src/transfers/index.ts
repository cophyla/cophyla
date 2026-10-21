// Transfers: files and folders sent from one of the user's machines to another. A transfer
// lives on the machine it goes to, which pulls it: it lists what the sending machine has
// (`files.tree`, a page at a time), then opens a pipe per file (`files.pipe.open`, over the
// links as a stream page's pipes go) and appends its bytes to a partial beside where it
// lands: `<dir>/<name>.cophyla-part`, a file, or a folder of them, files one at a time in the
// walk's order and empty folders kept. Once every byte came the partial is renamed to the
// first free of `name`, `name (1)`, …: nothing is ever written over. One transfer runs at a
// time on a machine; the rest wait, `queued`, in the order they were started.
//
// A pipe that closes short (the link went, the primary started again) leaves the transfer
// `waiting` for the sending machine, and it carries on from the partial's size once a pipe
// can open again, a backoff of 2 s up to 30 s between tries, until it is cancelled. Each file
// opens with what the sending machine finds of it now, its size and when it last changed: a
// file that changed since the walk starts again from nothing. The links are reliable and
// sealed, so no hash is taken. A cancel deletes the partial; a failure keeps it for a retry,
// until the transfer is dismissed. The rows are kept in `<data>/transfers.json`, what each
// lists in `<data>/transfers/<id>.json`, so a transfer goes on after the daemon starts again.
//
// Over RELAY_CONFIRM_BYTES with a hop on the server's relay (a link that rides it, with no
// data channel), a start is answered `confirm` and waits for the user's word: the relay counts
// every message it carries.

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join } from "node:path";
import { newId, RpcError, Transfer as TransferRow } from "@cophyla/protocol";
import type { NodeRecord, Transfer, TransferBy, TransferConfirm, TransferVia, TreeEntry } from "@cophyla/protocol";
import type { Bus } from "../bus.ts";
import type { Logger } from "../log.ts";
import { PipeRouteError } from "../remote/pipes.ts";
import type { FilePipe, PipeHub } from "../remote/pipes.ts";
import { FileSinkEnd } from "./sink.ts";
import type { TreePage } from "./tree.ts";

/** Bytes over which a transfer with a hop on the relay waits for the user's word. */
export const RELAY_CONFIRM_BYTES = 1024 ** 3;
/** What a partial is called, beside where it lands. */
export const PART = ".cophyla-part";
/** A running transfer's row goes out at most this often. */
const EMIT_MS = 1000;
/** And is kept on disk at most this often. */
const PERSIST_MS = 1000;
const BACKOFF_FIRST_MS = 2000;
const BACKOFF_MAX_MS = 30_000;
/** The bytes a second are counted over this long. */
const RATE_MS = 5000;
/** Transfers that ended and were not dismissed, kept at most: the oldest done and cancelled go first. */
const KEEP_ENDED = 100;
/** How long a page of a listing may take: a big folder takes a while to walk. */
export const TREE_TIMEOUT_MS = 120_000;
/** How long a cancel waits for its run to let go, and a stopping daemon for what runs. */
const HALT_MS = 15_000;
const STOP_MS = 3000;

/** A request over the links that failed because a link went or was not there: worth waiting for. */
function linkGone(e: unknown): boolean {
  return e instanceof RpcError && (e.code === "timeout" || (e.code === "unavailable" && /not linked|no link|no route|not linked to the primary|link closed|closed/.test(e.message)));
}

/** Where a transfer's way goes past the primary, at each hop: the LAN, a data channel, or the relay. */
export type Hop = "lan" | "direct" | "relay";

const RANK: Record<Hop, number> = { lan: 0, direct: 1, relay: 2 };

export interface StartParams {
  from: { node: string; path: string };
  to: { node: string; dir?: string };
  relayOk?: boolean;
  by?: TransferBy;
  notify?: string;
}

export interface TransfersDeps {
  selfId: () => string;
  /** A machine's name, as the registry has it. */
  nodeName: (id: string) => string;
  /** Where the rows are kept. */
  dataDir: string;
  bus: Pick<Bus, "emit">;
  pipes: Pick<PipeHub, "openForFile">;
  /** A page of what a path on a node holds: this node's walked here, another's asked over the links. */
  tree: (node: string, path: string, from?: number) => Promise<TreePage>;
  /** Whether a pipe toward `node` could open now. */
  reachable: (node: string) => boolean;
  /** Every machine of the cluster as this node knows it. */
  nodes: () => NodeRecord[];
  /** The primary, which every pipe between two secondaries crosses. */
  primary: () => string | undefined;
  /** The way the link between `node` and the primary goes; none for the primary itself. */
  hop: (node: string) => Hop | undefined;
  /** Whether this machine receives files. */
  receives?: () => boolean;
  /** Refuses a folder a confined node may not write in. */
  require?: (path: string) => void;
  /** The folder a transfer lands in when none is named. */
  downloads?: () => string;
  /** Tells an agent session of this machine where a file sent to it landed. */
  tell?: (session: string, text: string) => Promise<void>;
  log: Logger;
  now?: () => number;
  backoff?: { firstMs: number; maxMs: number };
  relayConfirmBytes?: number;
}

/** A transfer as this machine keeps it: the row, where its partial is, and how far it got. */
interface Row {
  t: Transfer;
  part: string;
  /** Entries before it have landed. */
  cursor: number;
  notify?: string;
  retryAt?: number;
  backoff?: number;
}

/** What `transfers.json` holds. */
interface Kept {
  rows: { t: Transfer; part: string; cursor: number; notify?: string }[];
}

/** A run was stopped from outside: cancelled, or the daemon is stopping. */
class Stopped extends Error {}
/** A pipe closed before its file came: the transfer waits and goes on. */
class Short extends Error {}

interface Running {
  row: Row;
  ctl: AbortController;
  pipe?: FilePipe;
  sink?: FileSinkEnd;
  done: Promise<void>;
  /** Bytes as they came lately, for the rate: time and count. */
  samples: [number, number][];
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Whether a path is taken: anything there, a link to nothing included. */
function taken(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The first of `name`, `name (1)`, … free in `dir`, a file's number before its extension; `skip` counts as taken too. */
export function freeName(dir: string, name: string, file: boolean, skip: (path: string) => boolean = () => false, suffix = ""): string {
  const ext = file ? extname(name) : "";
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  for (let i = 0; ; i++) {
    const candidate = join(dir, (i === 0 ? name : file ? `${stem} (${i})${ext}` : `${name} (${i})`) + suffix);
    if (!taken(candidate) && !skip(candidate)) return candidate;
  }
}

/** Bytes as a person reads them, as the views say them: gigabytes to one place, the rest whole. */
export function sizeText(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${Math.round(n)} B`;
}

export class Transfers {
  private deps: TransfersDeps;
  private log: Logger;
  private rows = new Map<string, Row>();
  private running?: Running;
  private timer?: ReturnType<typeof setTimeout>;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private emitted = new Map<string, number>();
  private emitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  private started = false;

  constructor(deps: TransfersDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.load();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private get file(): string {
    return join(this.deps.dataDir, "transfers.json");
  }

  private entriesFile(id: string): string {
    return join(this.deps.dataDir, "transfers", `${id}.json`);
  }

  // --- what is kept ----------------------------------------------------------------------------

  private load(): void {
    let kept: Kept;
    try {
      kept = JSON.parse(readFileSync(this.file, "utf8")) as Kept;
    } catch {
      return;
    }
    for (const r of kept.rows ?? []) {
      const parsed = TransferRow.safeParse(r.t);
      if (!parsed.success || typeof r.part !== "string") continue;
      const t = parsed.data;
      // one that ran when the daemon stopped goes on from where its partial is
      if (t.state === "running") t.state = "queued";
      const { rate: _rate, ...rest } = t;
      this.rows.set(t.id, { t: rest, part: r.part, cursor: Math.max(0, Math.floor(r.cursor ?? 0)), ...(r.notify ? { notify: r.notify } : {}) });
    }
  }

  private persistNow(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    const kept: Kept = { rows: [...this.rows.values()].map((r) => ({ t: r.t, part: r.part, cursor: r.cursor, ...(r.notify ? { notify: r.notify } : {}) })) };
    try {
      mkdirSync(this.deps.dataDir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(kept));
      renameSync(tmp, this.file);
    } catch (e) {
      this.log.warn("the transfers could not be kept", { error: message(e) });
    }
  }

  private persistSoon(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => this.persistNow(), PERSIST_MS);
    if (typeof this.persistTimer === "object" && "unref" in this.persistTimer) this.persistTimer.unref();
  }

  private readEntries(id: string): TreeEntry[] {
    try {
      return (JSON.parse(readFileSync(this.entriesFile(id), "utf8")) as { entries: TreeEntry[] }).entries;
    } catch (e) {
      throw new RpcError("not_found", `what this transfer lists is gone (${message(e)}): start it again`);
    }
  }

  private async writeEntries(id: string, entries: TreeEntry[]): Promise<void> {
    await mkdir(dirname(this.entriesFile(id)), { recursive: true });
    await writeFile(this.entriesFile(id), JSON.stringify({ entries }));
  }

  private dropEntries(id: string): void {
    try {
      rmSync(this.entriesFile(id), { force: true });
    } catch {
      // gone already
    }
  }

  // --- rows out --------------------------------------------------------------------------------

  /** A row's changes: out at once when its state moved, else at most once a second, and kept. */
  private changed(row: Row, now = false): void {
    if (now) this.emit(row);
    else this.emitSoon(row);
    this.persistSoon();
  }

  private emit(row: Row): void {
    const pending = this.emitTimers.get(row.t.id);
    if (pending) clearTimeout(pending);
    this.emitTimers.delete(row.t.id);
    this.emitted.set(row.t.id, this.now());
    this.deps.bus.emit("transfer.state", this.view(row));
  }

  private emitSoon(row: Row): void {
    if (this.emitTimers.has(row.t.id)) return;
    const wait = Math.max(0, (this.emitted.get(row.t.id) ?? 0) + EMIT_MS - this.now());
    if (wait === 0) {
      this.emit(row);
      return;
    }
    const t = setTimeout(() => {
      this.emitTimers.delete(row.t.id);
      if (this.rows.get(row.t.id) === row) this.emit(row);
    }, wait);
    if (typeof t === "object" && "unref" in t) t.unref();
    this.emitTimers.set(row.t.id, t);
  }

  /** A row as clients get it: the running one with its rate. */
  private view(row: Row): Transfer {
    const r = this.running;
    if (r?.row !== row || row.t.state !== "running") return { ...row.t };
    const rate = this.rate(r);
    return { ...row.t, ...(rate !== undefined ? { rate } : {}) };
  }

  private rate(r: Running): number | undefined {
    const s = r.samples;
    if (s.length < 2) return undefined;
    const [t0, b0] = s[0]!;
    const [t1, b1] = s[s.length - 1]!;
    if (t1 - t0 < 200) return undefined;
    return Math.max(0, Math.round(((b1 - b0) * 1000) / (t1 - t0)));
  }

  private sample(r: Running): void {
    const at = this.now();
    const last = r.samples[r.samples.length - 1];
    if (last && at - last[0] < 100) last[1] = r.row.t.bytes;
    else r.samples.push([at, r.row.t.bytes]);
    while (r.samples.length > 2 && at - r.samples[0]![0] > RATE_MS) r.samples.shift();
  }

  private set(row: Row, patch: Partial<Transfer>, drop: (keyof Transfer)[] = []): void {
    const next = { ...row.t, ...patch } as Transfer & Record<string, unknown>;
    for (const k of drop) delete next[k];
    row.t = next;
    this.changed(row, true);
  }

  // --- what the clients ask --------------------------------------------------------------------

  /** Every transfer this machine receives, the latest first. */
  list(): Transfer[] {
    return [...this.rows.values()].sort((a, b) => b.t.startedAt - a.t.startedAt).map((r) => this.view(r));
  }

  get(id: string): Transfer | undefined {
    const row = this.rows.get(id);
    return row ? this.view(row) : undefined;
  }

  /** Starts a transfer to this machine; answers `confirm` instead for a big one over the relay, unless `relayOk`. */
  async begin(p: StartParams): Promise<{ transfer?: Transfer; confirm?: TransferConfirm }> {
    if (this.stopped) throw new RpcError("unavailable", "this machine is stopping");
    const self = this.deps.selfId();
    if (p.to.node !== self) throw new RpcError("invalid", "a transfer is started on the machine it goes to");
    if (this.deps.receives && !this.deps.receives()) throw new RpcError("denied", "this machine receives no files");
    const source = p.from.node;
    this.checkSender(source);
    const dir = p.to.dir ?? (this.deps.downloads ?? (() => join(homedir(), "Downloads")))();
    if (!isAbsolute(dir)) throw new RpcError("invalid", `${dir}: not an absolute path`);
    this.deps.require?.(dir);
    try {
      await mkdir(dir, { recursive: true });
      if (!(await stat(dir)).isDirectory()) throw new Error("not a folder");
    } catch (e) {
      throw new RpcError("invalid", `${dir}: no folder to put it in (${message(e)})`);
    }
    const tree = await this.walk(source, p.from.path);
    const hops = this.relayHops(source);
    if (!p.relayOk && hops.length > 0 && tree.total > (this.deps.relayConfirmBytes ?? RELAY_CONFIRM_BYTES)) return { confirm: { bytes: tree.total, relayHops: hops } };
    const id = newId("transfer");
    const via = this.viaOf(source);
    const folder = tree.kind === "folder";
    const t: Transfer = {
      id,
      from: { node: source, path: p.from.path },
      to: { node: self, dir },
      kind: tree.kind,
      name: tree.name,
      total: tree.total,
      bytes: 0,
      ...(folder ? { files: { done: 0, total: tree.files } } : {}),
      state: "queued",
      ...(via ? { via } : {}),
      by: p.by ?? { kind: "user" },
      startedAt: this.now(),
    };
    await this.writeEntries(id, tree.entries);
    const parts = new Set([...this.rows.values()].map((r) => r.part));
    const row: Row = { t, part: freeName(dir, tree.name, !folder, (c) => parts.has(c), PART), cursor: 0, ...(p.notify ? { notify: p.notify } : {}) };
    this.rows.set(id, row);
    this.log.info("transfer started", { id, from: source, path: p.from.path, dir, kind: t.kind, bytes: t.total, files: tree.files, by: t.by.kind, via });
    this.changed(row, true);
    this.kick();
    return { transfer: this.view(row) };
  }

  /** Stops a transfer and deletes what came of it. */
  async cancel(id: string): Promise<void> {
    const row = this.need(id);
    if (row.t.state === "done" || row.t.state === "cancelled") throw new RpcError("conflict", `${row.t.name} has ended: dismiss it instead`);
    await this.halt(row, "cancelled");
    // it landed while it was being stopped
    if ((row.t.state as Transfer["state"]) === "done") throw new RpcError("conflict", `${row.t.name} has landed: dismiss it instead`);
    await this.removePart(row);
    this.set(row, { state: "cancelled", endedAt: this.now() }, ["rate", "error"]);
    this.dropEntries(id);
    this.log.info("transfer cancelled", { id });
    this.trim();
  }

  /** Starts a failed transfer again from what came of it. */
  retry(id: string): void {
    const row = this.need(id);
    if (row.t.state !== "failed") throw new RpcError("conflict", `${row.t.name} has not failed`);
    if (!existsSync(this.entriesFile(id))) throw new RpcError("conflict", "what this transfer lists is gone: start it again");
    delete row.retryAt;
    delete row.backoff;
    this.set(row, { state: "queued" }, ["error", "endedAt"]);
    this.kick();
  }

  /** Forgets a transfer that ended; a failed one's partial goes with it. */
  async dismiss(id: string): Promise<void> {
    const row = this.need(id);
    if (row.t.state !== "done" && row.t.state !== "failed" && row.t.state !== "cancelled") throw new RpcError("conflict", `${row.t.name} has not ended: cancel it first`);
    if (row.t.state === "failed") await this.removePart(row);
    this.forget(row);
  }

  private forget(row: Row): void {
    this.rows.delete(row.t.id);
    this.dropEntries(row.t.id);
    this.emitted.delete(row.t.id);
    this.deps.bus.emit("transfer.state", { ...row.t, dismissed: true });
    this.persistSoon();
  }

  /** The ended rows past KEEP_ENDED, the oldest done or cancelled ones, are forgotten. */
  private trim(): void {
    const ended = [...this.rows.values()].filter((r) => r.t.state === "done" || r.t.state === "cancelled").sort((a, b) => (a.t.endedAt ?? 0) - (b.t.endedAt ?? 0));
    while (ended.length > KEEP_ENDED) this.forget(ended.shift()!);
  }

  private need(id: string): Row {
    const row = this.rows.get(id);
    if (!row) throw new RpcError("not_found", `no transfer ${id} on this machine`);
    return row;
  }

  // --- the sending machine and the way there -----------------------------------------------------

  private checkSender(source: string): void {
    if (source === this.deps.selfId()) return;
    const row = this.deps.nodes().find((n) => n.id === source);
    // a hands node knows no machine but its primary: the primary, which sent it this, answers for the rest
    if (!row) {
      if (!this.deps.reachable(source)) throw new RpcError("not_found", `no machine ${source}`);
      return;
    }
    if (row.hands && row.scope.kind === "workspaces") throw new RpcError("denied", `${row.name} lends folders of another person's machine: it sends no files`);
    if (!row.capabilities.files) throw new RpcError("unsupported", `${row.name} runs an older Cophyla: update it to send files`);
    if (!this.deps.reachable(source)) throw new RpcError("unavailable", `${row.name} is offline`);
  }

  /** The machines whose link to the primary a transfer from `source` crosses. */
  private hopsOf(source: string): string[] {
    const self = this.deps.selfId();
    if (source === self) return [];
    const primary = this.deps.primary();
    return [self, source].filter((n) => n !== primary);
  }

  private viaOf(source: string): TransferVia | undefined {
    let worst: Hop | undefined;
    for (const n of this.hopsOf(source)) {
      const h = this.deps.hop(n) ?? "lan";
      if (worst === undefined || RANK[h] > RANK[worst]) worst = h;
    }
    return worst;
  }

  private relayHops(source: string): string[] {
    return this.hopsOf(source).filter((n) => this.deps.hop(n) === "relay");
  }

  /** Everything `path` on `source` holds, page after page. */
  private async walk(source: string, path: string): Promise<{ kind: "file" | "folder"; name: string; entries: TreeEntry[]; total: number; files: number }> {
    let p = await this.deps.tree(source, path);
    const entries = [...p.entries];
    const first = p;
    while (p.next !== undefined) {
      p = await this.deps.tree(source, path, p.next);
      entries.push(...p.entries);
      if (p.entries.length === 0) break;
    }
    if (entries.length !== first.count) throw new RpcError("conflict", `${first.name} changed while it was listed: send it again`);
    return { kind: first.kind, name: first.name, entries, total: first.total, files: first.files };
  }

  // --- running -----------------------------------------------------------------------------------

  /** Takes up what was kept: what ran goes on, what waited tries again now. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const row of this.rows.values()) if (row.t.state === "waiting") row.retryAt = this.now();
    this.kick();
  }

  /** A machine may be reachable again: what waits for it tries now. */
  poke(node?: string): void {
    for (const row of this.rows.values()) if (row.t.state === "waiting" && (node === undefined || row.t.from.node === node)) row.retryAt = this.now();
    this.kick();
  }

  /** Runs the next transfer, when none runs: the oldest queued one, or a waiting one whose time came and whose sender is there. */
  private kick(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || !this.started) return;
    const at = this.now();
    if (!this.running) {
      const ready = [...this.rows.values()]
        .filter((r) => {
          if (r.t.state === "queued") return true;
          if (r.t.state !== "waiting" || (r.retryAt ?? 0) > at) return false;
          if (this.deps.reachable(r.t.from.node)) return true;
          // still away: the next try after a longer wait
          this.backoff(r);
          return false;
        })
        .sort((a, b) => a.t.startedAt - b.t.startedAt);
      const next = ready[0];
      if (next) this.run(next);
    }
    const soonest = Math.min(...[...this.rows.values()].filter((r) => r.t.state === "waiting" && r.retryAt !== undefined).map((r) => r.retryAt!));
    if (Number.isFinite(soonest)) {
      this.timer = setTimeout(() => this.kick(), Math.max(10, soonest - at));
      if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
    }
  }

  private backoff(row: Row): void {
    const first = this.deps.backoff?.firstMs ?? BACKOFF_FIRST_MS;
    const max = this.deps.backoff?.maxMs ?? BACKOFF_MAX_MS;
    row.backoff = row.backoff === undefined ? first : Math.min(max, row.backoff * 2);
    row.retryAt = this.now() + row.backoff;
  }

  private run(row: Row): void {
    const ctl = new AbortController();
    const running: Running = { row, ctl, samples: [], done: Promise.resolve() };
    this.running = running;
    running.done = this.runRow(running).finally(() => {
      if (this.running === running) this.running = undefined;
      this.kick();
    });
  }

  private async runRow(r: Running): Promise<void> {
    const row = r.row;
    const via = this.viaOf(row.t.from.node);
    this.set(row, { state: "running", ...(via ? { via } : {}) }, ["error"]);
    try {
      const entries = this.readEntries(row.t.id);
      if (row.t.kind === "folder") await mkdir(row.part, { recursive: true });
      let bytes = 0;
      let done = 0;
      for (let i = 0; i < row.cursor && i < entries.length; i++) {
        bytes += entries[i]!.size ?? 0;
        if (!entries[i]!.dir) done++;
      }
      row.t = { ...row.t, bytes, ...(row.t.files ? { files: { done, total: row.t.files.total } } : {}) };
      r.samples.push([this.now(), bytes]);
      for (let i = row.cursor; i < entries.length; i++) {
        if (r.ctl.signal.aborted) throw new Stopped();
        const e = entries[i]!;
        if (e.dir) await mkdir(join(row.part, ...e.rel.split("/")), { recursive: true });
        else {
          await this.pull(r, e, entries);
          if (row.t.files) row.t = { ...row.t, files: { done: row.t.files.done + 1, total: row.t.files.total } };
        }
        row.cursor = i + 1;
        this.changed(row);
      }
      if (r.ctl.signal.aborted) throw new Stopped();
      await this.land(row);
    } catch (e) {
      if (e instanceof Stopped || r.ctl.signal.aborted) return;
      const source = row.t.from.node;
      const away = !this.deps.reachable(source);
      if (e instanceof Short || e instanceof PipeRouteError || away || linkGone(e)) {
        this.backoff(row);
        this.set(row, { state: "waiting", error: `waiting for ${this.deps.nodeName(source)}` }, ["rate"]);
        this.log.info("transfer waiting", { id: row.t.id, reason: message(e), retryInMs: row.backoff });
        return;
      }
      this.set(row, { state: "failed", error: message(e), endedAt: this.now() }, ["rate"]);
      this.log.warn("transfer failed", { id: row.t.id, error: message(e) });
    }
  }

  /** One file of a transfer, appended to its partial from where it stopped. */
  private async pull(r: Running, e: TreeEntry, entries: TreeEntry[]): Promise<void> {
    const row = r.row;
    const dest = row.t.kind === "file" ? row.part : join(row.part, ...e.rel.split("/"));
    const base = row.t.bytes;
    let size = e.size ?? 0;
    let at: number | undefined;
    try {
      at = statSync(dest).size;
    } catch {
      at = undefined;
    }
    // more than the file has: what is there is of another version of it
    if (at !== undefined && at > size) {
      await rm(dest, { force: true });
      at = undefined;
    }
    for (;;) {
      if (r.ctl.signal.aborted) throw new Stopped();
      if (at === size) {
        // all of it came before, or there is nothing to it
        row.t = { ...row.t, bytes: base + size };
        return;
      }
      if (size === 0) {
        await writeFile(dest, new Uint8Array(0));
        at = 0;
        continue;
      }
      const start = at ?? 0;
      const sink = new FileSinkEnd(dest, start, () => {
        row.t = { ...row.t, bytes: base + start + sink.received };
        this.sample(r);
        // bytes came: the next wait, if any, starts short again
        delete row.backoff;
        this.changed(row);
      });
      r.sink = sink;
      let pipe: FilePipe;
      try {
        pipe = await this.deps.pipes.openForFile(row.t.from.node, { kind: "file", path: row.t.from.path, ...(e.rel !== "" ? { rel: e.rel } : {}), at: start }, sink);
      } catch (err) {
        sink.close("the pipe did not open");
        await sink.finish();
        r.sink = undefined;
        throw err;
      }
      r.pipe = pipe;
      if (r.ctl.signal.aborted) {
        sink.close("cancelled");
        pipe.close("cancelled");
        await sink.finish();
        throw new Stopped();
      }
      const f = pipe.file;
      if (f.size !== size || f.mtimeMs !== (e.mtimeMs ?? f.mtimeMs)) {
        // changed since the walk: counted at its size now, and from nothing when part of it came already
        row.t = { ...row.t, total: Math.max(0, row.t.total + f.size - size) };
        e.size = f.size;
        e.mtimeMs = f.mtimeMs;
        size = f.size;
        void this.writeEntries(row.t.id, entries).catch(() => undefined);
        if (start > 0) {
          sink.close("the file changed");
          pipe.close("the file changed");
          await sink.finish();
          await rm(dest, { force: true });
          at = undefined;
          row.t = { ...row.t, bytes: base };
          continue;
        }
      }
      sink.expect(f.size - start);
      const out = await sink.outcome;
      pipe.close(out.kind === "complete" ? "done" : out.reason);
      await sink.finish();
      r.pipe = undefined;
      r.sink = undefined;
      if (out.kind === "complete") {
        row.t = { ...row.t, bytes: base + size };
        return;
      }
      if (r.ctl.signal.aborted) throw new Stopped();
      if (out.kind === "error") throw new RpcError("unavailable", out.reason);
      throw new Short(out.reason);
    }
  }

  /** Every byte came: the partial takes its name, the first free one. */
  private async land(row: Row): Promise<void> {
    const final = freeName(row.t.to.dir, row.t.name, row.t.kind === "file");
    for (let i = 0; ; i++) {
      try {
        await rename(row.part, final);
        break;
      } catch (e) {
        // a scanner may hold a fresh file a moment on Windows
        if (i >= 4) throw new RpcError("unavailable", `it came whole but could not be named ${final}: ${message(e)}`);
        await Bun.sleep(200 * (i + 1));
      }
    }
    this.set(row, { state: "done", bytes: row.t.total, to: { ...row.t.to, path: final }, endedAt: this.now() }, ["rate", "error"]);
    this.dropEntries(row.t.id);
    this.log.info("transfer landed", { id: row.t.id, path: final, bytes: row.t.total });
    this.trim();
    if (row.notify && this.deps.tell) {
      const by = row.t.by.kind === "agent" ? row.t.by.alias : "The user";
      const what = row.t.kind === "folder" ? `the folder ${row.t.name}` : row.t.name;
      void this.deps.tell(row.notify, `${by} sent you ${what}: ${final}`).catch((e: unknown) => this.log.warn("the receiving session could not be told", { id: row.t.id, error: message(e) }));
    }
  }

  /** Stops a transfer's run, when it runs, and waits for it to let go of its files. */
  private async halt(row: Row, why: string): Promise<void> {
    const r = this.running;
    if (r?.row !== row) return;
    r.ctl.abort();
    r.sink?.close(why);
    r.pipe?.close(why);
    // a pipe still opening may take its whole timeout to give up
    await Promise.race([r.done, Bun.sleep(HALT_MS)]);
  }

  private async removePart(row: Row): Promise<void> {
    for (let i = 0; ; i++) {
      try {
        await rm(row.part, { recursive: true, force: true });
        return;
      } catch (e) {
        if (i >= 4) {
          this.log.warn("a transfer's partial could not be deleted", { id: row.t.id, part: row.part, error: message(e) });
          return;
        }
        await Bun.sleep(200 * (i + 1));
      }
    }
  }

  /** The daemon is stopping: what runs stops where it is, to go on at the next start. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const t of this.emitTimers.values()) clearTimeout(t);
    this.emitTimers.clear();
    const r = this.running;
    if (r) {
      r.ctl.abort();
      r.sink?.close("stopping");
      r.pipe?.close("stopping");
      await Promise.race([r.done, Bun.sleep(STOP_MS)]);
    }
    this.persistNow();
  }
}
