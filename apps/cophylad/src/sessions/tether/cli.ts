// The agent CLIs running in tether terminals that no session holds yet. A Codex CLI fires no
// hook and writes no thread until its first prompt, so until then its terminal is known as
// one by its processes alone: the topmost `codex` below the terminal's program marks it, which
// is the CLI and never the app-server daemon the CLI started below itself. Claude is marked
// the same way, for the moment before its registry entry is met, and Muse, which makes a
// session only at its first prompt, by its binary (`muse-bin-<version>`), not its launcher.
//
// A terminal is looked at when its title changes, which a CLI does as it starts, and only while
// it is running, unmarked and held by no session; a program that is itself the CLI (`tether
// run -- codex`) is marked by its name, with no look. Every terminal waiting to be looked at is
// looked at in one read of the process table, 300 ms after the first of them came and never
// sooner than 2 s after the read before: a terminal that retitles itself all the time costs a
// read every 2 s at most, and one at rest none. The CLIs one read finds are all marked before
// any is told of, so a thread looking for its CLI's terminal (a restart meets several) sees
// every one. A terminal a session held is looked at again when the session ends. A mark stays
// while its process lives, which a signal-0 kill tells at each tick without a read. A mark
// carries when its CLI started, where the table says: it tells which of two CLIs in one folder
// a new Codex thread came from.

import type { HarnessKind, TerminalRef } from "@cophyla/protocol";
import type { Logger } from "../../log.ts";
import type { TerminalChange, TerminalEntry } from "./index.ts";
import { plainTitle } from "./title.ts";

/** One process as the process table gives it. */
export interface ProcessRow {
  pid: number;
  parent: number;
  name: string;
  /** When it started, ms since the epoch, where the table says. */
  startedAt?: number;
}

/** A terminal's CLI: its harness, the process that is the CLI, and when that started where known. */
export interface CliMark {
  harness: Extract<HarnessKind, "claude" | "codex" | "muse">;
  pid: number;
  startedAt?: number;
}

/** The CLI a process is, by its image name; `codex-x86_64-…` is the Linux binary's own name, cut to 15 characters there. */
export function cliOfName(name: string): CliMark["harness"] | undefined {
  const base = name.split(/[\\/]/).pop() ?? name;
  if (/^claude(\.exe)?$/i.test(base)) return "claude";
  if (/^codex(-[\w.-]*)?(\.exe)?$/i.test(base)) return "codex";
  if (/^muse-bin/i.test(base)) return "muse";
  return undefined;
}

/** The topmost CLI below `root` (the root itself included), breadth first. */
export function findCli(root: number, table: ProcessRow[]): CliMark | undefined {
  const children = new Map<number, ProcessRow[]>();
  let self: ProcessRow | undefined;
  for (const p of table) {
    if (p.pid === root) self = p;
    else if (p.parent !== p.pid) (children.get(p.parent) ?? children.set(p.parent, []).get(p.parent)!).push(p);
  }
  const queue: ProcessRow[] = self ? [self] : (children.get(root) ?? []).slice();
  const seen = new Set<number>();
  while (queue.length > 0) {
    const p = queue.shift()!;
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    const harness = cliOfName(p.name);
    if (harness) return { harness, pid: p.pid, ...(p.startedAt !== undefined ? { startedAt: p.startedAt } : {}) };
    queue.push(...(children.get(p.pid) ?? []));
  }
  return undefined;
}

export interface TerminalClisDeps {
  /** The terminals as the node's tether knows them. */
  list(): TerminalEntry[];
  get(ref: TerminalRef): TerminalEntry | undefined;
  /** One read of the whole process table; `undefined` or empty where it cannot be read. */
  processes?: () => ProcessRow[] | undefined | Promise<ProcessRow[] | undefined>;
  /** Whether a live session holds the terminal: such a terminal is never looked at. */
  held(ref: TerminalRef): boolean;
  isAlive(pid: number): boolean;
  /** A terminal's mark came or went. */
  changed(ref: TerminalRef): void;
  log: Logger;
  now?: () => number;
  debounceMs?: number;
  gapMs?: number;
}

const DEBOUNCE_MS = 300;
const GAP_MS = 2000;

function keyOf(ref: TerminalRef): string {
  return `${ref.host}/${ref.id}`;
}

export class TerminalClis {
  private deps: TerminalClisDeps;
  private marks = new Map<string, { ref: TerminalRef; mark: CliMark }>();
  private titles = new Map<string, string>();
  private pending = new Map<string, TerminalRef>();
  private timer?: ReturnType<typeof setTimeout>;
  private lastRead = -Infinity;
  private reading = false;
  private stopped = false;

  constructor(deps: TerminalClisDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The CLI marked in a terminal, whether or not a session holds it now. */
  markOf(ref: TerminalRef): CliMark | undefined {
    return this.marks.get(keyOf(ref))?.mark;
  }

  /** Looks at every running terminal once: the daemon may have started under CLIs already open. */
  start(): void {
    for (const e of this.deps.list()) {
      this.titles.set(keyOf(e.ref), plainTitle(e.info.title ?? ""));
      this.consider(e);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }

  /** A terminal came, changed or went. */
  onTerminal(change: TerminalChange): void {
    const { ref, info } = change.entry;
    const key = keyOf(ref);
    if (change.gone || info.status === "exited") {
      this.titles.delete(key);
      this.pending.delete(key);
      this.clear(key);
      return;
    }
    // A spinner turning is no new title: only the words after it are compared.
    const title = plainTitle(info.title ?? "");
    const known = this.titles.has(key);
    const retitled = known && this.titles.get(key) !== title;
    this.titles.set(key, title);
    if (!known) {
      // Its own program may be the CLI, told by name, started when tether started it.
      const own = cliOfName(info.argv[0] ?? "");
      if (own && info.pid !== undefined) this.mark(key, ref, { harness: own, pid: info.pid, startedAt: info.startedAt });
      return;
    }
    if (retitled) this.consider(change.entry);
  }

  /**
   * A session that held the terminal ended: it is looked at again, since a held one never is,
   * and a CLI started again in it while it was held may have kept the title it had.
   */
  reconsider(ref: TerminalRef): void {
    const entry = this.deps.get(ref);
    if (entry) this.consider(entry);
  }

  /** Each tick: a mark whose process has gone goes with it. */
  tick(): void {
    for (const [key, { mark }] of this.marks) if (!this.deps.isAlive(mark.pid)) this.clear(key);
  }

  /** Whether a terminal has a mark whose process lives; a dead one goes first. */
  private marked(key: string): boolean {
    const held = this.marks.get(key);
    if (!held) return false;
    if (this.deps.isAlive(held.mark.pid)) return true;
    this.clear(key);
    return false;
  }

  private consider(entry: TerminalEntry): void {
    const key = keyOf(entry.ref);
    if (!this.deps.processes || this.stopped || entry.info.status !== "running" || entry.info.pid === undefined || this.marked(key) || this.deps.held(entry.ref)) return;
    this.pending.set(key, entry.ref);
    if (this.timer || this.reading) return;
    const wait = Math.max(this.deps.debounceMs ?? DEBOUNCE_MS, this.lastRead + (this.deps.gapMs ?? GAP_MS) - this.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.read();
    }, wait);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  /** One read of the process table for every terminal waiting. */
  private async read(): Promise<void> {
    if (this.stopped || this.pending.size === 0) return;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    this.reading = true;
    this.lastRead = this.now();
    const started = performance.now();
    let table: ProcessRow[] | undefined;
    try {
      table = await this.deps.processes!();
    } catch (e) {
      this.deps.log.debug("the process table could not be read", { error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.reading = false;
    }
    this.deps.log.debug("process table read for terminal CLIs", { terminals: waiting.length, processes: table?.length ?? 0, ms: Math.round(performance.now() - started) });
    if (table && table.length > 0 && !this.stopped) {
      const found: TerminalRef[] = [];
      for (const ref of waiting) {
        const entry = this.deps.get(ref);
        const key = keyOf(ref);
        if (!entry || entry.info.status !== "running" || entry.info.pid === undefined || this.marked(key) || this.deps.held(ref)) continue;
        const cli = findCli(entry.info.pid, table);
        if (cli && this.set(key, ref, cli)) found.push(ref);
      }
      // Every CLI the read found is marked before any is told of: a thread that looks then sees them all.
      for (const ref of found) this.deps.changed(ref);
    }
    // What came while the read ran waits its turn.
    if (this.pending.size > 0 && !this.timer) {
      const again = [...this.pending.values()];
      this.pending.clear();
      for (const ref of again) {
        const entry = this.deps.get(ref);
        if (entry) this.consider(entry);
      }
    }
  }

  private mark(key: string, ref: TerminalRef, mark: CliMark): void {
    if (this.set(key, ref, mark)) this.deps.changed(ref);
  }

  /** A terminal's mark, untold: whether it is new. */
  private set(key: string, ref: TerminalRef, mark: CliMark): boolean {
    const was = this.marks.get(key)?.mark;
    if (was && was.pid === mark.pid && was.harness === mark.harness) return false;
    this.marks.set(key, { ref, mark });
    this.deps.log.info("agent CLI in a terminal", { terminal: ref.id, harness: mark.harness, pid: mark.pid });
    return true;
  }

  private clear(key: string): void {
    const held = this.marks.get(key);
    if (!held) return;
    this.marks.delete(key);
    this.deps.log.debug("agent CLI left its terminal", { terminal: held.ref.id, harness: held.mark.harness, pid: held.mark.pid });
    this.deps.changed(held.ref);
  }
}
