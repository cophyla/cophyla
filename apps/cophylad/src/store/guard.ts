// The main connection's guard. The daemon's thread is its control plane and SQLite is
// synchronous, so one statement that walks a big table holds every client, voice and session
// for as long as it reads: the hourly full scan of session_events froze the daemon for one to
// two minutes at a time. Every statement prepared on the main connection is therefore planned
// once (`EXPLAIN QUERY PLAN`, cached by its text) and a full scan of a table off the small
// list, or of a whole index of one, is a violation: logged once, or thrown under
// `COPHYLA_STRICT_SQL=1`, which the test preload sets, so a new scan fails the suite. A scan
// is allowed when it is bounded or cheap by construction: under a top-level `LIMIT` in index or
// rowid order (no temporary sort), of a virtual table (FTS5, `json_each`), of a CTE or
// subquery's rows, of `sqlite_master`, or in a statement that says why with
// `/* scan-ok: reason */`. Statements the tests write themselves are not checked.
//
// Each statement's run is timed as well: past 20 ms it is logged as a slow statement with the
// head of its text, the rows it answered or changed and its plan, at most once a minute per
// text; while it runs it is the watchdog's current task, so a stall inside SQLite is named.

import { Database } from "bun:sqlite";
import type { Changes, SQLQueryBindings, Statement } from "bun:sqlite";
import { appendFileSync } from "node:fs";
import type { Logger } from "../log.ts";
import { enter, leave, taskId } from "../watchdog/task.ts";

/** Tables a full read of is cheap: bounded by design, a few hundred rows at most. */
export const SMALL_TABLES: ReadonlySet<string> = new Set(["meta", "nodes", "policy", "entitlement", "usage", "workspaces", "tasks", "thread_spend", "transcript_tails", "sqlite_master", "sqlite_schema"]);

export const SLOW_MS = 20;
const SLOW_EVERY_MS = 60_000;
const SQL_HEAD = 200;
const MAX_PLANS = 4000;

interface PlanRow {
  id: number;
  parent: number;
  detail: string;
}

/** What the guard knows of a statement's text: its plan and what is wrong with it, if anything. */
interface Checked {
  plan: string[];
  violation?: string;
  label: number;
  lastSlow: number;
}

const KEYWORDS = new Set([
  "where", "on", "left", "right", "full", "join", "inner", "cross", "outer", "natural", "order", "group", "limit", "using", "set", "values",
  "union", "except", "intersect", "having", "window", "returning", "indexed", "not", "as", "select", "default", "and", "or",
]);

/** The SQL with every parenthesised part and string literal taken out: what the top level says. */
export function topLevel(sql: string): string {
  let out = "";
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += c;
  }
  return out;
}

/** The names the statement gives its tables (an alias, or the table's own name), each to its table. */
export function aliases(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\b(?:FROM|JOIN|UPDATE|INTO)\s+([A-Za-z_]\w*)(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi;
  for (const m of sql.matchAll(re)) {
    const table = m[1]!;
    out.set(table, table);
    const alias = m[2];
    if (alias && !KEYWORDS.has(alias.toLowerCase())) out.set(alias, table);
  }
  return out;
}

/** What is wrong with a plan, or `undefined` when its every scan is allowed. */
export function judge(sql: string, plan: PlanRow[], tables: ReadonlySet<string>, small: ReadonlySet<string> = SMALL_TABLES, partial: ReadonlySet<string> = new Set()): string | undefined {
  if (/\/\*\s*scan-ok:/i.test(sql)) return undefined;
  const names = aliases(sql);
  const top = topLevel(sql);
  const limited = /\bLIMIT\b/i.test(top);
  // A sort of the whole result reads it all first; one of the last term (or right part) only
  // orders ties within the index's order, and the walk still stops at the LIMIT.
  const sorted = plan.some((r) => /^USE TEMP B-TREE FOR (ORDER BY|GROUP BY|DISTINCT)/.test(r.detail));
  for (const row of plan) {
    const m = /^SCAN (\S+)(.*)$/.exec(row.detail);
    if (!m) continue;
    const rest = m[2]!;
    if (m[1] === "CONSTANT" || rest.includes("VIRTUAL TABLE")) continue;
    const table = names.get(m[1]!) ?? m[1]!;
    if (!tables.has(table) || small.has(table)) continue;
    // A walk in index or rowid order under the statement's own LIMIT stops when it has its rows.
    if (row.parent === 0 && limited && !sorted) continue;
    const how = /USING COVERING INDEX (\S+)/.exec(rest)?.[1] ?? /USING INDEX (\S+)/.exec(rest)?.[1];
    // A partial index holds only the rows its WHERE admits (the live sessions, the open threads): a walk of it is bounded by them.
    if (how && partial.has(how)) continue;
    return how ? `full scan of ${table} (index ${how})` : `full scan of ${table}`;
  }
  return undefined;
}

/** Whether a statement is one the planner says anything useful about. */
const PLANNED = /^\s*(?:\/\*.*?\*\/\s*)*(SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE)\b/is;

/** The first frame of a stack outside the guard and bun:sqlite: the code that prepared the statement. */
function callerOf(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  for (const line of stack.split("\n").slice(1)) {
    // frames with no file of their own (bun:sqlite's, a matcher's `(unknown)`) and the guard's are passed over
    if (/[\\/]store[\\/]guard\.ts/.test(line) || !/\.[cm]?[jt]sx?:\d+/.test(line)) continue;
    return line.trim();
  }
  return undefined;
}

/** Whether the code that prepared a statement is a test's, which may read what it likes. */
function fromTest(stack: string | undefined): boolean {
  const line = callerOf(stack);
  return line !== undefined && /[\\/]test[\\/]/.test(line) && !/[\\/]src[\\/]/.test(line);
}

export interface GuardOptions {
  /** Throws on a violation instead of logging it. */
  strict?: boolean;
  slowMs?: number;
  /** The small tables; SMALL_TABLES otherwise. */
  small?: ReadonlySet<string>;
  /** Checks the statements a test prepares itself as well: the guard's own tests. */
  checkTests?: boolean;
}

export interface GuardReport {
  sql: string;
  violation: string;
  plan: string[];
}

/** A Database whose statements are planned, judged and timed; everything else is bun:sqlite's own. */
export class GuardedDatabase extends Database {
  /** Where violations and slow statements are logged; set once the daemon has its logger. */
  log?: Logger;
  /** Hears each violation found (the tests collect them). */
  onViolation?: (r: GuardReport) => void;
  /** No checks while set: the migrations, which run DDL and one-time fills by design. */
  paused = false;
  readonly strict: boolean;
  private slowMs: number;
  private small: ReadonlySet<string>;
  private checkTests: boolean;
  private checked = new Map<string, Checked>();
  private tableNames?: Set<string>;
  private partialIndexes?: Set<string>;

  constructor(path: string, opts: ConstructorParameters<typeof Database>[1] = {}, guard: GuardOptions = {}) {
    super(path, opts as never);
    this.strict = guard.strict ?? process.env["COPHYLA_STRICT_SQL"] === "1";
    this.slowMs = guard.slowMs ?? SLOW_MS;
    this.small = guard.small ?? SMALL_TABLES;
    this.checkTests = guard.checkTests ?? false;
  }

  /** Forgets the table list, so a table made since is known: after the migrations. */
  schemaChanged(): void {
    this.tableNames = undefined;
    this.partialIndexes = undefined;
  }

  private partial(): Set<string> {
    if (!this.partialIndexes) {
      const s = super.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql LIKE '% WHERE %'");
      try {
        this.partialIndexes = new Set((s.all() as { name: string }[]).map((r) => r.name));
      } finally {
        s.finalize();
      }
    }
    return this.partialIndexes;
  }

  private tables(): Set<string> {
    if (!this.tableNames) {
      const s = super.prepare("SELECT name FROM sqlite_master WHERE type = 'table'");
      try {
        this.tableNames = new Set((s.all() as { name: string }[]).map((r) => r.name));
      } finally {
        s.finalize();
      }
    }
    return this.tableNames;
  }

  /** The text's plan and verdict, worked out once. */
  private check(sql: string): Checked {
    const known = this.checked.get(sql);
    if (known) return known;
    const label = taskId(`sql: ${sql.replace(/\s+/g, " ").trim().slice(0, 80)}`);
    const c: Checked = { plan: [], label, lastSlow: 0 };
    if (!this.paused && PLANNED.test(sql)) {
      let rows: PlanRow[] = [];
      try {
        // finalized at once: an explained statement left open counts as one in progress, and a COMMIT then fails
        const s = super.prepare(`EXPLAIN QUERY PLAN ${sql}`);
        try {
          rows = s.all() as PlanRow[];
        } finally {
          s.finalize();
        }
      } catch {
        // a statement the planner will not explain is left to fail as it runs
      }
      c.plan = rows.map((r) => r.detail);
      const violation = judge(sql, rows, this.tables(), this.small, this.partial());
      if (violation && (this.checkTests || !fromTest(new Error().stack))) c.violation = violation;
    }
    if (this.checked.size >= MAX_PLANS) this.checked.clear();
    this.checked.set(sql, c);
    if (c.violation) {
      const report: GuardReport = { sql, violation: c.violation, plan: c.plan };
      this.onViolation?.(report);
      const file = process.env["COPHYLA_SQL_REPORT"];
      if (file) appendFileSync(file, JSON.stringify({ ...report, at: callerOf(new Error().stack) }) + "\n");
      if (this.strict) {
        this.checked.delete(sql);
        throw new Error(`unbounded statement (${c.violation}); bound it by an index or say why with /* scan-ok: reason */: ${sql.replace(/\s+/g, " ").trim().slice(0, SQL_HEAD)}`);
      }
      this.log?.warn("unbounded statement", { violation: c.violation, sql: sql.replace(/\s+/g, " ").trim().slice(0, SQL_HEAD), plan: c.plan });
    }
    return c;
  }

  /** Times one run of a statement, labelled for the watchdog, and logs it when slow. */
  private timed<T>(c: Checked, sql: string, run: () => T, rows: (r: T) => number | undefined): T {
    const prev = enter(c.label);
    const t0 = performance.now();
    try {
      const out = run();
      const ms = performance.now() - t0;
      if (ms >= this.slowMs) this.slow(c, sql, ms, rows(out));
      return out;
    } finally {
      leave(prev);
    }
  }

  private slow(c: Checked, sql: string, ms: number, rows: number | undefined): void {
    const now = Date.now();
    if (now - c.lastSlow < SLOW_EVERY_MS) return;
    c.lastSlow = now;
    this.log?.warn("slow statement", { ms: Math.round(ms), sql: sql.replace(/\s+/g, " ").trim().slice(0, SQL_HEAD), ...(rows !== undefined ? { rows } : {}), plan: c.plan });
  }

  /** Wraps a statement's runs; a statement bun:sqlite cached comes back wrapped already. */
  private wrap<S extends Statement>(stmt: S, sql: string): S {
    const s = stmt as unknown as Record<string | symbol, unknown>;
    if (s[WRAPPED]) return stmt;
    s[WRAPPED] = true;
    const c = this.check(sql);
    const all = stmt.all.bind(stmt);
    const get = stmt.get.bind(stmt);
    const run = stmt.run.bind(stmt);
    const values = stmt.values.bind(stmt);
    const iterate = stmt.iterate.bind(stmt);
    s["all"] = (...a: unknown[]) => this.timed(c, sql, () => all(...(a as [])), (r) => (r as unknown[]).length);
    s["get"] = (...a: unknown[]) => this.timed(c, sql, () => get(...(a as [])), () => undefined);
    s["run"] = (...a: unknown[]) => this.timed(c, sql, () => run(...(a as [])), (r) => (r as { changes: number }).changes);
    s["values"] = (...a: unknown[]) => this.timed(c, sql, () => values(...(a as [])), (r) => (r as unknown[]).length);
    s["iterate"] = (...a: unknown[]) => this.timed(c, sql, () => iterate(...(a as [])), () => undefined);
    return stmt;
  }

  override prepare<R, P extends SQLQueryBindings | SQLQueryBindings[]>(sql: string, params?: P, ...more: unknown[]): Statement<R, P extends any[] ? P : [P]> {
    // bun:sqlite's `query` passes a third argument (its cache flag): every argument goes through
    const stmt = (super.prepare as (sql: string, ...rest: unknown[]) => Statement<R, P extends any[] ? P : [P]>)(sql, params, ...more);
    // The transaction controls bun:sqlite prepares for itself are not the daemon's statements.
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)) return stmt;
    return this.wrap(stmt, sql);
  }

  override run<P extends SQLQueryBindings[]>(sql: string, ...bindings: P[]): Changes {
    const c = this.paused || /;\s*\S/.test(sql.trim().replace(/;\s*$/, "")) ? undefined : this.check(sql);
    const go = () => (super.run as (sql: string, ...b: unknown[]) => Changes)(sql, ...bindings);
    return c ? this.timed(c, sql, go, (r) => r.changes) : go();
  }

  override exec<P extends SQLQueryBindings[]>(sql: string, ...bindings: P[]): Changes {
    return this.run(sql, ...bindings);
  }
}

const WRAPPED = Symbol("guarded");
