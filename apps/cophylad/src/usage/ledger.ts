// The spend ledger: what the harness sessions' model calls cost, kept per hour in the store's
// `spend` tables, and the usage page's report from it (`usage.report`). The Claude adapter
// feeds it as it reads a conversation's transcripts (`SpendSink`): each pass hands over the
// calls counted past the ledger's marks and the marks it read to, written together, so a
// transcript read again from the start (a daemon restart, a resume) counts nothing twice. The
// backfill (backfill.ts) fills it from the transcripts there were before, leaving alone a
// conversation the adapter has claimed. Calls are priced as the sessions' stats are, model by
// model with the hour-kept cache writes at their own rate; the harness's side calls arrive as
// a cost already, from its own cost record. A report keeps to the folders and accounts the
// node's session scope admits, whatever it held when the rows were written.

import { USAGE_CONTEXT_BOUNDS, UsageDimension } from "@cophyla/protocol";
import type { ClientParams, HarnessProfile, SessionScope, UsageCell, UsageGroup, UsagePoint, UsageReport, UsageSession } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import type { ModelTokens } from "../sessions/claude/transcript.ts";
import { isWithin, plainPath } from "../sessions/paths.ts";
import type { SpendConversation, SpendGroup, SpendQuery, SpendRow, SpendSum, Store } from "../store/index.ts";

/** A conversation's key in the ledger. */
export const conversationKey = (harness: string, id: string): string => `${harness}:${id}`;

/** The bucket of the context a call carried (`UsageDimension` `context`). */
export function contextBucket(tokens: number): number {
  const i = USAGE_CONTEXT_BOUNDS.findIndex((b) => tokens < b);
  return i < 0 ? USAGE_CONTEXT_BOUNDS.length : i;
}

/** One call's usage as a transcript counted it (`CountedUsage`). */
export interface SpendCall {
  at: number;
  model: string;
  agent: string;
  trigger: string;
  context: number;
  first: boolean;
  tokens: ModelTokens;
}

/** What the harness's cost record held beyond the transcripts, as it was read: a cost already. */
export interface SideSpend {
  at: number;
  model: string;
  cost: number;
  tokens: { in: number; out: number; cacheRead: number; cacheWrite: number };
}

/** One pass over a conversation: what it counted past the marks, and the marks it read to. */
export interface SpendPass {
  conversation: SpendConversation;
  calls: SpendCall[];
  side: SideSpend[];
  marks: Map<string, number>;
}

/** What an adapter feeds. */
export interface SpendSink {
  /** How far each transcript has been counted in; 0 for one never counted. */
  marks(keys: string[]): Map<string, number>;
  /** A conversation is read live from now: the backfill leaves it alone. */
  claim(conversation: string): void;
  commit(pass: SpendPass): void;
}

export type SpendPrice = (model: string, tokens: ModelTokens) => number | undefined;

export interface SpendLedgerDeps {
  store: Store;
  price: SpendPrice;
  log?: Logger;
  now?: () => number;
  /** How long the hours are kept. */
  retentionDays: number;
  /** The node's profiles, for an account's name. */
  profiles?: () => HarnessProfile[];
  /** A Cophyla session's name, for its line. */
  sessionName?: (id: string) => string | undefined;
  /** The node's session scope, which a report keeps to. */
  scope?: () => SessionScope;
  platform?: string;
}

const HOUR = 3_600_000;
/** The model a sub-agent's calls are priced on for `sonnetSaves`. */
const SONNET = "claude-sonnet-5-5";

/** The cell key of a call: its hour, model, agent, trigger and context bucket. */
const cellKey = (r: Pick<SpendRow, "hour" | "model" | "agent" | "trigger" | "context">): string => `${r.hour}\u0000${r.model}\u0000${r.agent}\u0000${r.trigger}\u0000${r.context}`;

/** A pass's calls and side spend summed into ledger cells, priced. */
export function spendRows(calls: SpendCall[], side: SideSpend[], price: SpendPrice): SpendRow[] {
  const cells = new Map<string, SpendRow>();
  const cell = (hour: number, model: string, agent: string, trigger: string, context: number): SpendRow => {
    const k = cellKey({ hour, model, agent, trigger, context });
    let c = cells.get(k);
    if (!c) cells.set(k, (c = { hour, model, agent, trigger, context, calls: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, cost: 0 }));
    return c;
  };
  for (const u of calls) {
    // the harness's stand-in for a reply that failed: no call was billed
    if (u.model === "<synthetic>") continue;
    const c = cell(Math.floor(u.at / HOUR) * HOUR, u.model, u.agent, u.trigger, contextBucket(u.context));
    if (u.first) c.calls++;
    c.in += u.tokens.in;
    c.out += u.tokens.out;
    c.cacheRead += u.tokens.cacheRead;
    c.cacheWrite += u.tokens.cacheWrite;
    c.cacheWrite1h += u.tokens.cacheWrite1h;
    c.cost += price(u.model, u.tokens) ?? 0;
  }
  for (const s of side) {
    const c = cell(Math.floor(s.at / HOUR) * HOUR, s.model, "side", "side", 0);
    c.in += s.tokens.in;
    c.out += s.tokens.out;
    c.cacheRead += s.tokens.cacheRead;
    c.cacheWrite += s.tokens.cacheWrite;
    c.cost += s.cost;
  }
  return [...cells.values()];
}

const cellOf = (s: SpendSum): UsageCell => ({
  cost: Math.round(s.cost * 1e6) / 1e6,
  calls: s.calls,
  tokens: { in: s.in, out: s.out, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite, cacheWrite1h: s.cacheWrite1h },
});

/** How many keys a series keeps before the rest is summed as `other`. */
const SERIES_KEYS = 12;
const GROUPS = 50;
const SESSIONS = 100;

export class SpendLedger implements SpendSink {
  private deps: SpendLedgerDeps;
  private claimed = new Set<string>();
  /** The backfill is reading the transcripts there were before the ledger. */
  filling = false;

  constructor(deps: SpendLedgerDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  marks(keys: string[]): Map<string, number> {
    return this.deps.store.spend.marks(keys);
  }

  claim(conversation: string): void {
    this.claimed.add(conversation);
  }

  /** Whether the adapter reads the conversation live. */
  isClaimed(conversation: string): boolean {
    return this.claimed.has(conversation);
  }

  /** The conversations the adapter reads live. */
  claimedList(): string[] {
    return [...this.claimed];
  }

  commit(pass: SpendPass): void {
    const rows = spendRows(pass.calls, pass.side, this.deps.price);
    const marks = [...pass.marks];
    if (rows.length === 0 && marks.length === 0) return;
    const ats = [...pass.calls.map((c) => c.at), ...pass.side.map((s) => s.at)];
    const conv = ats.length > 0 ? { ...pass.conversation, firstAt: Math.min(pass.conversation.firstAt, ...ats), lastAt: Math.max(pass.conversation.lastAt, ...ats) } : pass.conversation;
    this.deps.store.spend.commit(conv, rows, marks);
  }

  /** Drops what is older than the retention. */
  prune(): number {
    const n = this.deps.store.spend.prune(this.now() - this.deps.retentionDays * 86_400_000);
    if (n > 0) this.deps.log?.info("spend ledger pruned", { rows: n });
    return n;
  }

  /** The conversations the scope leaves out now: by folder, or by an account switched off. */
  private hidden(): string[] {
    const scope = this.deps.scope?.();
    if (!scope || (scope.profilesOff.length === 0 && scope.allowedFolders.length === 0 && scope.hiddenFolders.length === 0)) return [];
    const platform = this.deps.platform;
    const out: string[] = [];
    for (const c of this.deps.store.spend.conversations()) {
      const cwd = plainPath(c.cwd);
      const off =
        (c.profile !== "" && scope.profilesOff.includes(c.profile)) ||
        (cwd !== "" && scope.allowedFolders.length > 0 && !scope.allowedFolders.some((f) => isWithin(cwd, f, platform))) ||
        (cwd !== "" && scope.hiddenFolders.some((f) => isWithin(cwd, f, platform)));
      if (off) out.push(c.conversation);
    }
    return out;
  }

  private label(dim: UsageDimension, key: string, titles: Map<string, string>): string | undefined {
    if (dim === "account") return key === "" ? undefined : this.deps.profiles?.().find((p) => p.id === key)?.name;
    if (dim === "session") return this.sessionLabel(key, titles.get(key));
    return undefined;
  }

  private sessionLabel(key: string, title: string | undefined): string | undefined {
    return (key.includes(":") ? undefined : this.deps.sessionName?.(key)) ?? title;
  }

  report(p: ClientParams<"usage.report">, node: string): UsageReport {
    const store = this.deps.store.spend;
    const q: SpendQuery = { from: p.from, to: p.to, filter: p.filter ?? {}, hidden: this.hidden() };
    const span = Math.max(0, p.to - p.from);
    const sessions = store.sessions(q, SESSIONS);
    const titles = new Map(sessions.filter((s) => s.title).map((s) => [s.key, s.title!]));
    const groups = {} as Record<UsageDimension, UsageGroup[]>;
    for (const dim of UsageDimension.options) {
      groups[dim] = store.groups(q, dim, GROUPS).map((g) => {
        const label = this.label(dim, g.key, titles);
        return { key: g.key, ...(label ? { label } : {}), ...cellOf(g) };
      });
    }
    // The split's keys: every one up to twelve, else the twelve that spent most and `other`.
    const all = store.groups(q, p.split, SERIES_KEYS + 1);
    const kept = new Set(all.length > SERIES_KEYS ? all.slice(0, SERIES_KEYS).map((g) => g.key) : all.map((g) => g.key));
    const points = new Map<string, UsagePoint>();
    for (const g of store.series(q, p.split, p.bucket === "day", p.tz)) {
      const key = kept.has(g.key) ? g.key : "other";
      const k = `${g.at}\u0000${key}`;
      const pt = points.get(k) ?? { at: g.at!, key, cost: 0 };
      pt.cost += g.cost;
      points.set(k, pt);
    }
    const series = [...points.values()].map((pt) => ({ ...pt, cost: Math.round(pt.cost * 1e6) / 1e6 }));
    const lines: UsageSession[] = sessions.map((s) => {
      const label = this.sessionLabel(s.key, s.title);
      return {
        key: s.key,
        ...(label ? { label } : {}),
        ...cellOf(s),
        harness: s.harness,
        ...(s.cwd ? { project: s.cwd } : {}),
        ...(s.profile ? { account: s.profile } : {}),
        firstAt: s.firstAt,
        lastAt: s.lastAt,
        subCost: Math.round(s.subCost * 1e6) / 1e6,
        contextAvg: s.calls > 0 ? Math.round((s.in + s.cacheRead + s.cacheWrite) / s.calls) : 0,
      };
    });
    const saves = this.sonnetSaves(store.subModels(q));
    const costs = this.costs(store.models(q));
    const since = store.oldest();
    return {
      node,
      from: p.from,
      to: p.to,
      totals: cellOf(store.total(q)),
      previous: cellOf(store.total({ ...q, from: p.from - span, to: p.from })),
      split: p.split,
      series,
      groups,
      sessions: lines,
      costs,
      ...(saves > 0.005 ? { sonnetSaves: Math.round(saves * 100) / 100 } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(this.filling ? { filling: true } : {}),
    };
  }

  /** The cost by token kind: each model's tokens of a kind at its price; the side calls' cost as it came. */
  private costs(models: SpendGroup[]): NonNullable<UsageReport["costs"]> {
    const out = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, side: 0 };
    const none = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
    for (const m of models) {
      if (m.key === "side") {
        out.side += m.cost;
        continue;
      }
      out.in += this.deps.price(m.key, { ...none, in: m.in }) ?? 0;
      out.out += this.deps.price(m.key, { ...none, out: m.out }) ?? 0;
      out.cacheRead += this.deps.price(m.key, { ...none, cacheRead: m.cacheRead }) ?? 0;
      out.cacheWrite += this.deps.price(m.key, { ...none, cacheWrite: m.cacheWrite, cacheWrite1h: m.cacheWrite1h }) ?? 0;
    }
    const r = (x: number) => Math.round(x * 1e6) / 1e6;
    return { in: r(out.in), out: r(out.out), cacheRead: r(out.cacheRead), cacheWrite: r(out.cacheWrite), side: r(out.side) };
  }

  /** How much less the sub-agents' calls on costlier models would have cost on Sonnet. */
  private sonnetSaves(models: SpendGroup[]): number {
    let saves = 0;
    for (const m of models) {
      if (m.key === SONNET) continue;
      const onSonnet = this.deps.price(SONNET, { in: m.in, out: m.out, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite, cacheWrite1h: m.cacheWrite1h });
      if (onSonnet !== undefined && m.cost > onSonnet) saves += m.cost - onSonnet;
    }
    return saves;
  }
}
