// The settings' Usage page: where the agents' spend went, out of each machine's spend ledger
// (`usage.report`), drawn so the user can see what to change. One row of filters scopes all of
// it: the range (Today, 7, 30 or 90 days), the machine (every one, asked each and summed here),
// the account and the project; any bar, legend entry or session adds its key as a filter chip,
// and the chips and the selects are the same filter. Below them: a few figures, the spend over
// time stacked by a dimension picked beside it (its seven biggest keys and Other), what the
// numbers suggest doing, a bar list per dimension, and the sessions that spent most. A colour
// stays with its key while the page is open, so a filter never repaints what survives it.
// `UsageModel` and everything it derives are DOM-free; `usagePage` draws them. Cost is at API
// list prices: a plan charges by limits, so a dollar reads as how fast a limit drains.

import { USAGE_CONTEXT_BOUNDS } from "@cophyla/protocol";
import type { HarnessProfile, Node, UsageCell, UsageDimension, UsageFilter, UsageGroup, UsagePoint, UsageReport, UsageSession } from "@cophyla/protocol";
import { el, message, option } from "./ui.ts";

export type UsageRequest = <T>(method: string, params: unknown) => Promise<T>;

// --- the palette: the dataviz reference's dark steps, validated on #1c1a24 and #14121a -----

/** Categorical slots, in their fixed order: the series of the spend chart. */
export const SERIES_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"] as const;
/** What is folded into Other: a gray that clears 3:1 on the card. */
export const OTHER_COLOR = "#77717f";
/** The context buckets, an ordinal ramp: the smallest context dimmest, the largest brightest. */
export const CONTEXT_COLORS = ["#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4"] as const;
/** The bar lists: nominal keys, one hue. */
export const BAR_COLOR = SERIES_COLORS[0];

// --- ranges and buckets -------------------------------------------------------------------

export type UsageRange = "today" | "7d" | "30d" | "90d";

export const RANGES: readonly { id: UsageRange; label: string; days: number; previous: string }[] = [
  { id: "today", label: "Today", days: 1, previous: "the same hours before midnight" },
  { id: "7d", label: "7 days", days: 7, previous: "the 7 days before" },
  { id: "30d", label: "30 days", days: 30, previous: "the 30 days before" },
  { id: "90d", label: "90 days", days: 90, previous: "the 90 days before" },
];

const HOUR = 3_600_000;

/** What a range asks for: from local midnight `days - 1` days back to now, in hours for a day, else in days. */
export function rangeSpan(range: UsageRange, now: number): { from: number; to: number; bucket: "hour" | "day" } {
  const days = RANGES.find((r) => r.id === range)?.days ?? 7;
  const d = new Date(now);
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1)).getTime();
  return { from, to: now, bucket: days === 1 ? "hour" : "day" };
}

/** The buckets the chart draws, empty ones too: each hour of the day, or each local day of the range. */
export function bucketStarts(from: number, to: number, bucket: "hour" | "day"): number[] {
  const out: number[] = [];
  if (bucket === "hour") {
    const d = new Date(from);
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    for (let at = from; at < end; at += HOUR) out.push(at);
    return out;
  }
  const d = new Date(from);
  for (let i = 0; ; i++) {
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i).getTime();
    if (at > to) break;
    out.push(at);
  }
  return out;
}

// --- numbers in words ----------------------------------------------------------------------

/** Dollars: whole from $100, cents below, "<$0.01" for a crumb. */
export function money(v: number): string {
  if (v >= 100) return `$${Math.round(v).toLocaleString("en-US")}`;
  if (v > 0 && v < 0.01) return "<$0.01";
  if (v <= 0) return "$0";
  return `$${v.toFixed(2)}`;
}

/** Dollars on an axis: $0, $450, $1.5K, $12K, $1.2M. */
export function moneyCompact(v: number): string {
  if (v >= 1e6) return `$${trim(v / 1e6)}M`;
  if (v >= 1e3) return `$${trim(v / 1e3)}K`;
  if (v >= 10 || v === 0) return `$${Math.round(v)}`;
  return `$${trim(v)}`;
}

function trim(v: number): string {
  return (v >= 10 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, "");
}

/** A share in percent: whole from 10%, one decimal below, "<0.1%" for a crumb. */
export function share(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return "0%";
  const p = (100 * part) / whole;
  if (p < 0.1) return "<0.1%";
  return p >= 10 ? `${Math.round(p)}%` : `${p.toFixed(1).replace(/\.0$/, "")}%`;
}

/** Tokens: 950, 271K, 1.2M, 13B. */
export function tokenCount(n: number): string {
  if (n >= 1e9) return `${trim(n / 1e9)}B`;
  if (n >= 1e6) return `${trim(n / 1e6)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(Math.round(n));
}

// --- keys in words ------------------------------------------------------------------------

export const DIMENSION_NAMES: Record<UsageDimension | "machine", string> = {
  account: "Account",
  project: "Project",
  session: "Session",
  model: "Model",
  agent: "Who",
  trigger: "Started by",
  context: "Context",
  machine: "Machine",
};

export const TRIGGER_LABELS: Record<string, string> = {
  typed: "You typed",
  peer: "Another agent's message",
  task: "Background task",
  monitor: "Monitor event",
  compact: "Compaction carry-over",
  command: "Slash command",
  side: "Claude's own calls",
  other: "Other",
};

/** A context bucket in words, from the protocol's bounds: "Under 100K", "100K–200K", "Over 500K". */
export function contextLabel(key: string): string {
  const i = Number(key);
  const b = USAGE_CONTEXT_BOUNDS;
  if (!Number.isInteger(i) || i < 0 || i > b.length) return key;
  const k = (n: number) => `${n / 1000}K`;
  if (i === 0) return `Under ${k(b[0]!)}`;
  if (i === b.length) return `Over ${k(b[b.length - 1]!)}`;
  return `${k(b[i - 1]!)}–${k(b[i]!)}`;
}

/** A Claude model by its family and version: claude-opus-5-5 → Opus 5.5; another id as it is. */
export function modelLabel(id: string): string {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (!m) return id || "Unknown model";
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
  return `${family} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

export function agentLabel(key: string): string {
  if (key === "main") return "Main conversation";
  if (key === "side") return "Claude's own calls";
  if (key.startsWith("sub:")) return key.length > 4 ? `Sub-agent: ${key.slice(4)}` : "Sub-agent";
  return key || "Other";
}

/** A folder by its last name: C:\D\Faircase → Faircase. */
export function projectLabel(path: string): string {
  if (!path) return "No folder";
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The last stretch of a session key, to tell sessions with no name apart. */
function shortId(key: string): string {
  const id = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key.replace(/^sess_/, "");
  return id.slice(-6).toLowerCase();
}

// --- reports summed over machines ----------------------------------------------------------

const DIMENSIONS: readonly UsageDimension[] = ["account", "project", "session", "model", "agent", "trigger", "context"];

export type UsageSessionLine = UsageSession & { node: string };

/** The kinds of cost, each with its colour slot: fixed by kind, never by size. */
export const COST_KINDS: readonly { key: keyof UsageCosts; label: string; color: string }[] = [
  { key: "cacheRead", label: "Re-reading context (cache reads)", color: SERIES_COLORS[0] },
  { key: "cacheWrite", label: "Writing context (cache writes)", color: SERIES_COLORS[1] },
  { key: "out", label: "Output", color: SERIES_COLORS[2] },
  { key: "in", label: "Input", color: SERIES_COLORS[3] },
  { key: "side", label: "Claude's own calls", color: SERIES_COLORS[4] },
];

/** The reports of the machines asked, summed: what the page draws. */
export interface MergedUsage {
  from: number;
  to: number;
  bucket: "hour" | "day";
  split: UsageDimension;
  totals: UsageCell;
  previous: UsageCell;
  series: UsagePoint[];
  groups: Record<UsageDimension, UsageGroup[]>;
  /** Each machine's totals, keyed by node. */
  machines: UsageGroup[];
  /** The machines each key came from, by dimension: two folders of one name are told apart by them. */
  owners: Record<UsageDimension, Map<string, Set<string>>>;
  sessions: UsageSessionLine[];
  sonnetSaves?: number;
  /** What the spend paid for, summed; absent when a machine read did not say (an older one). */
  costs?: UsageCosts;
  since?: number;
  filling: boolean;
}

/** What `totals.cost` was spent on: input, output, cache reads and writes, and Claude's own calls. */
export interface UsageCosts {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
  side: number;
}

export function emptyCell(): UsageCell {
  return { cost: 0, calls: 0, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 } };
}

function addCell(into: UsageCell, c: UsageCell): void {
  into.cost += c.cost;
  into.calls += c.calls;
  into.tokens.in += c.tokens.in;
  into.tokens.out += c.tokens.out;
  into.tokens.cacheRead += c.tokens.cacheRead;
  into.tokens.cacheWrite += c.tokens.cacheWrite;
  into.tokens.cacheWrite1h += c.tokens.cacheWrite1h;
}

/** Sums machines' reports: groups by key, series by bucket and key, sessions side by side with their machine. */
export function mergeReports(parts: readonly { node: string; name?: string; report: UsageReport }[], span: { from: number; to: number; bucket: "hour" | "day" }, split: UsageDimension): MergedUsage {
  const totals = emptyCell();
  const previous = emptyCell();
  const series = new Map<string, UsagePoint>();
  const groups = {} as Record<UsageDimension, Map<string, UsageGroup>>;
  const owners = {} as Record<UsageDimension, Map<string, Set<string>>>;
  for (const d of DIMENSIONS) {
    groups[d] = new Map();
    owners[d] = new Map();
  }
  const machines: UsageGroup[] = [];
  const sessions: UsageSessionLine[] = [];
  let saves: number | undefined;
  // summed only while every machine says it: a part missing would leave the parts short of the total
  let costs: UsageCosts | undefined = parts.length > 0 ? { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, side: 0 } : undefined;
  let since: number | undefined;
  let filling = false;
  for (const { node, name, report: r } of parts) {
    addCell(totals, r.totals);
    addCell(previous, r.previous);
    machines.push({ key: node, ...(name ? { label: name } : {}), ...cloneCell(r.totals) });
    for (const p of r.series) {
      const k = `${p.at}\u0000${p.key}`;
      const cur = series.get(k);
      if (cur) cur.cost += p.cost;
      else series.set(k, { ...p });
    }
    for (const d of DIMENSIONS) {
      for (const g of r.groups[d] ?? []) {
        const from = owners[d].get(g.key) ?? new Set<string>();
        from.add(node);
        owners[d].set(g.key, from);
        const cur = groups[d].get(g.key);
        if (cur) {
          addCell(cur, g);
          if (!cur.label && g.label) cur.label = g.label;
        } else groups[d].set(g.key, { key: g.key, ...(g.label ? { label: g.label } : {}), ...cloneCell(g) });
      }
    }
    for (const s of r.sessions) sessions.push({ ...s, node });
    if (r.sonnetSaves !== undefined) saves = (saves ?? 0) + r.sonnetSaves;
    if (!r.costs) costs = undefined;
    else if (costs) for (const k of COST_KINDS) costs[k.key] += r.costs[k.key];
    if (r.since !== undefined) since = since === undefined ? r.since : Math.min(since, r.since);
    if (r.filling) filling = true;
  }
  const byCost = (a: { cost: number }, b: { cost: number }) => b.cost - a.cost;
  const out = {} as Record<UsageDimension, UsageGroup[]>;
  for (const d of DIMENSIONS) out[d] = [...groups[d].values()].sort(byCost);
  return {
    ...span,
    split,
    totals,
    previous,
    series: [...series.values()],
    groups: out,
    machines: machines.sort(byCost),
    owners,
    sessions: sessions.sort(byCost),
    ...(saves !== undefined ? { sonnetSaves: saves } : {}),
    ...(costs ? { costs } : {}),
    ...(since !== undefined ? { since } : {}),
    filling,
  };
}

function cloneCell(c: UsageCell): UsageCell {
  return { cost: c.cost, calls: c.calls, tokens: { ...c.tokens } };
}

// --- what the page shows, derived -----------------------------------------------------------

export interface SeriesKey {
  key: string;
  label: string;
  color: string;
  total: number;
  /** Other folds what did not make the cut; it takes no filter. */
  other: boolean;
}

export interface SeriesView {
  buckets: number[];
  bucket: "hour" | "day";
  keys: SeriesKey[];
  /** Per bucket, per key in `keys`' order. */
  values: number[][];
  totals: number[];
  max: number;
}

export interface BarRow {
  key: string;
  label: string;
  /** The whole name, where the label is short for it. */
  title?: string;
  cost: number;
  share: string;
  /** Of the biggest row: how long its bar is, 0..1. */
  length: number;
  color: string;
  active: boolean;
}

export interface BarList {
  dimension: UsageDimension | "machine";
  title: string;
  rows: BarRow[];
  rest?: { count: number; cost: number; share: string };
}

export interface Kpi {
  id: string;
  label: string;
  value: string;
  detail: string;
  delta?: { text: string; up: boolean };
}

export interface Suggestion {
  id: string;
  cost: number;
  title: string;
  text: string;
}

export type SessionSort = "label" | "cost" | "contextAvg" | "sub" | "lastAt";

export interface SessionRow {
  key: string;
  node: string;
  label: string;
  title: string;
  project: string;
  projectTitle: string;
  account: string;
  machine: string;
  cost: number;
  share: string;
  contextAvg: number;
  subShare: number;
  lastAt: number;
  active: boolean;
}

export interface UsageMissing {
  node: string;
  name: string;
  reason: string;
}

export interface Chip {
  dimension: UsageDimension;
  key: string;
  text: string;
}

/** How many sessions the table shows at first, and how many more each press adds. */
export const SESSIONS_PAGE = 20;
/** How many rows a bar list shows before the rest is summed in a line. */
export const BAR_ROWS = 6;

/** Why a machine read failed, in a few words: from before the request, not linked, or the error itself. */
function missingReason(e: unknown): string {
  if (predates(e)) return "it needs the update";
  const text = message(e).toLowerCase();
  const code = (e as { code?: unknown } | undefined)?.code;
  if (code === "not_found" || code === "unavailable" || /not linked|unavailable|not found|offline/.test(text)) return "it is not connected";
  return message(e);
}

/** Whether a failure says the node is from before the request. */
function predates(e: unknown): boolean {
  const text = message(e).toLowerCase();
  const code = (e as { code?: unknown } | undefined)?.code;
  return code === "unsupported" || code === "unknown_method" || code === -32601 || /unknown method|method not found|no such method|not supported/.test(text);
}

/**
 * The page's state: the filters, what was read for them, and the page's own (the chart as a
 * table, the sessions' order and how many show). `load` asks each machine meant and sums what
 * answers; an answer for filters since changed is dropped.
 */
export class UsageModel {
  range: UsageRange = "7d";
  /** The machine asked; "" asks every online one. */
  machine = "";
  split: UsageDimension = "project";
  readonly filter = new Map<UsageDimension, string[]>();
  nodes: Node[] = [];
  profiles: HarnessProfile[] = [];
  data?: MergedUsage;
  loading = false;
  /** Asked at least once since the page opened. */
  loaded = false;
  /** Why nothing could be read; empty when something was. */
  note = "";
  missing: UsageMissing[] = [];
  table = false;
  sort: { by: SessionSort; desc: boolean } = { by: "cost", desc: true };
  shown = SESSIONS_PAGE;
  private slots = new Map<UsageDimension, Map<string, number>>();
  private seq = 0;
  private nodesRead = false;
  private request: UsageRequest;
  private changed: () => void;
  private now: () => number;

  constructor(request: UsageRequest, changed: () => void, now: () => number = () => Date.now()) {
    this.request = request;
    this.changed = changed;
    this.now = now;
  }

  /** Stops answers coming in after the page closed from drawing anything. */
  dispose(): void {
    this.seq++;
  }

  /** The machines the page can ask: online ones, by name. */
  machines(): Node[] {
    return this.nodes.filter((n) => n.status !== "offline").sort((a, b) => a.name.localeCompare(b.name));
  }

  nodeName(id: string): string {
    return this.nodes.find((n) => n.id === id)?.name ?? "A machine";
  }

  filterParam(): UsageFilter | undefined {
    const f: UsageFilter = {};
    for (const [d, keys] of this.filter) if (keys.length > 0) f[d] = [...keys];
    return Object.keys(f).length > 0 ? f : undefined;
  }

  async load(): Promise<void> {
    const seq = ++this.seq;
    this.loading = true;
    this.loaded = true;
    this.changed();
    if (!this.nodesRead) {
      try {
        const [nodes, profiles] = await Promise.all([
          this.request<{ nodes: Node[] }>("node.list", {}),
          this.request<{ profiles: HarnessProfile[] }>("profile.list", {}).catch(() => ({ profiles: [] as HarnessProfile[] })),
        ]);
        this.nodes = nodes.nodes;
        this.profiles = profiles.profiles;
        this.nodesRead = true;
      } catch (e) {
        if (seq !== this.seq) return;
        this.loading = false;
        this.note = `The machines could not be read: ${message(e)}`;
        this.changed();
        return;
      }
      if (seq !== this.seq) return;
    }
    const all = this.machines();
    const asked = this.machine ? all.filter((n) => n.id === this.machine) : all;
    if (this.machine && asked.length === 0) {
      this.loading = false;
      this.note = `${this.nodeName(this.machine)} is offline.`;
      this.data = undefined;
      this.changed();
      return;
    }
    const span = rangeSpan(this.range, this.now());
    const filter = this.filterParam();
    const tz = -new Date(span.to).getTimezoneOffset();
    const answers = await Promise.all(
      asked.map((n) =>
        this.request<UsageReport>("usage.report", { node: n.id, from: span.from, to: span.to, bucket: span.bucket, tz, split: this.split, ...(filter ? { filter } : {}) }).then(
          (report) => ({ node: n, report }),
          (e: unknown) => ({ node: n, error: e }),
        ),
      ),
    );
    if (seq !== this.seq) return;
    const parts: { node: string; name: string; report: UsageReport }[] = [];
    this.missing = [];
    for (const a of answers) {
      if ("report" in a) parts.push({ node: a.node.id, name: a.node.name, report: a.report });
      else this.missing.push({ node: a.node.id, name: a.node.name, reason: missingReason(a.error) });
    }
    this.loading = false;
    if (parts.length === 0) {
      this.data = undefined;
      this.note = asked.length === 0 ? "No machine is online to read." : this.missing.length === 1 ? `${this.missing[0]!.name} could not be read: ${this.missing[0]!.reason}.` : "No machine could be read.";
    } else {
      this.note = "";
      this.data = mergeReports(parts, span, this.split);
    }
    this.changed();
  }

  setRange(range: UsageRange): void {
    if (this.range === range) return;
    this.range = range;
    this.shown = SESSIONS_PAGE;
    void this.load();
  }

  setMachine(node: string): void {
    if (this.machine === node) return;
    this.machine = node;
    // accounts, projects and sessions are a machine's own
    for (const d of ["account", "project", "session"] as const) this.filter.delete(d);
    this.shown = SESSIONS_PAGE;
    void this.load();
  }

  setSplit(split: UsageDimension): void {
    if (this.split === split) return;
    this.split = split;
    void this.load();
  }

  /** One key of a dimension, the only one kept there: what a select picks. "" keeps every key. */
  pick(d: UsageDimension, key: string): void {
    if (key === "") this.filter.delete(d);
    else this.filter.set(d, [key]);
    this.shown = SESSIONS_PAGE;
    void this.load();
  }

  /** A bar, a legend entry or a session clicked: its key kept, or let go when it was. */
  toggle(d: UsageDimension, key: string): void {
    const keys = this.filter.get(d) ?? [];
    const next = keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
    if (next.length === 0) this.filter.delete(d);
    else this.filter.set(d, next);
    this.shown = SESSIONS_PAGE;
    void this.load();
  }

  unfilter(d: UsageDimension, key?: string): void {
    const keys = this.filter.get(d) ?? [];
    const next = key === undefined ? [] : keys.filter((k) => k !== key);
    if (next.length === 0) this.filter.delete(d);
    else this.filter.set(d, next);
    void this.load();
  }

  clearFilters(): void {
    if (this.filter.size === 0) return;
    this.filter.clear();
    void this.load();
  }

  isActive(d: UsageDimension, key: string): boolean {
    return this.filter.get(d)?.includes(key) ?? false;
  }

  chips(): Chip[] {
    const out: Chip[] = [];
    for (const [d, keys] of this.filter) for (const key of keys) out.push({ dimension: d, key, text: `${DIMENSION_NAMES[d]}: ${this.label(d, key)}` });
    return out;
  }

  /** A key in words. An account's name gains its machine's where several machines show and one name is on more than one. */
  label(d: UsageDimension | "machine", key: string): string {
    switch (d) {
      case "machine":
        return this.nodeName(key);
      case "account": {
        if (!key) return "Unknown account";
        const g = this.data?.groups.account.find((x) => x.key === key);
        const p = this.profiles.find((x) => x.id === key);
        const name = g?.label ?? p?.name ?? "An account";
        if (!this.machine && p && this.profiles.filter((x) => x.name === name && x.harness === p.harness && x.node !== p.node).length > 0) return `${name} (${this.nodeName(p.node)})`;
        return name;
      }
      case "project": {
        const base = projectLabel(key);
        const twins = (this.data?.groups.project ?? []).filter((g) => g.key !== key && projectLabel(g.key) === base);
        if (twins.length === 0) return base;
        // another folder of the same name: its machine's name tells them apart, else its parent's
        const mine = this.data?.owners.project.get(key);
        const theirs = new Set(twins.flatMap((t) => [...(this.data?.owners.project.get(t.key) ?? [])]));
        if (mine?.size === 1 && !theirs.has([...mine][0]!)) return `${base} (${this.nodeName([...mine][0]!)})`;
        const parts = key.split(/[\\/]+/).filter(Boolean);
        return parts.length >= 2 ? `${parts[parts.length - 2]}/${base}` : key;
      }
      case "session": {
        const s = this.data?.sessions.find((x) => x.key === key);
        const g = this.data?.groups.session.find((x) => x.key === key);
        const name = s?.label ?? g?.label;
        if (name) return name;
        return `${projectLabel(s?.project ?? "")} · ${shortId(key)}`;
      }
      case "model":
        return modelLabel(key);
      case "agent":
        return agentLabel(key);
      case "trigger":
        return TRIGGER_LABELS[key] ?? key;
      case "context":
        return contextLabel(key);
    }
  }

  /** The colour a key of the split takes: the lowest slot free among the keys shown, kept while the page is open. */
  private colors(d: UsageDimension, keys: readonly string[]): Map<string, number> {
    let m = this.slots.get(d);
    if (!m) {
      m = new Map();
      this.slots.set(d, m);
    }
    const used = new Set<number>();
    for (const k of keys) {
      const s = m.get(k);
      if (s !== undefined) used.add(s);
    }
    for (const k of keys) {
      if (m.has(k)) continue;
      let s = 0;
      while (used.has(s)) s++;
      // the slot's last holder is not shown: it lets the slot go
      for (const [held, slot] of m) if (slot === s) m.delete(held);
      m.set(k, s);
      used.add(s);
    }
    return m;
  }

  /** The spend over time: every bucket of the range, the split's biggest keys (seven and Other past eight), stacked biggest first. */
  series(): SeriesView | undefined {
    const data = this.data;
    if (!data) return undefined;
    const buckets = bucketStarts(data.from, data.to, data.bucket);
    const index = (at: number): number => {
      let lo = 0;
      let hi = buckets.length - 1;
      if (hi < 0 || at < buckets[0]!) return -1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (buckets[mid]! <= at) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    const totals = new Map<string, number>();
    for (const p of data.series) totals.set(p.key, (totals.get(p.key) ?? 0) + p.cost);
    const split = data.split;
    let kept: string[];
    if (split === "context") {
      kept = [...totals.keys()].filter((k) => k !== "other").sort((a, b) => Number(a) - Number(b));
    } else {
      const ranked = [...totals.entries()].filter(([k]) => k !== "other").sort((a, b) => b[1] - a[1]).map(([k]) => k);
      kept = ranked.length + (totals.has("other") ? 1 : 0) > SERIES_COLORS.length ? ranked.slice(0, SERIES_COLORS.length - 1) : ranked;
    }
    const folded = [...totals.keys()].some((k) => k === "other" || !kept.includes(k));
    const slots = split === "context" ? undefined : this.colors(split, kept);
    const keys: SeriesKey[] = kept.map((k) => ({
      key: k,
      label: this.label(split, k),
      color: split === "context" ? (CONTEXT_COLORS[Number(k)] ?? OTHER_COLOR) : SERIES_COLORS[slots!.get(k)!]!,
      total: totals.get(k) ?? 0,
      other: false,
    }));
    if (folded) keys.push({ key: "other", label: "Other", color: OTHER_COLOR, total: [...totals.entries()].filter(([k]) => k === "other" || !kept.includes(k)).reduce((a, [, v]) => a + v, 0), other: true });
    const at = new Map(keys.map((k, i) => [k.key, i]));
    const values = buckets.map(() => keys.map(() => 0));
    for (const p of data.series) {
      const i = index(p.at);
      if (i < 0) continue;
      const j = at.get(p.key) ?? at.get("other");
      if (j === undefined) continue;
      values[i]![j]! += p.cost;
    }
    const sums = values.map((row) => row.reduce((a, v) => a + v, 0));
    return { buckets, bucket: data.bucket, keys, values, totals: sums, max: Math.max(0, ...sums) };
  }

  /** A dimension's bar list: its biggest keys, the rest summed in a line; the context buckets in their order. */
  bars(d: UsageDimension | "machine", title: string, limit = BAR_ROWS): BarList | undefined {
    const data = this.data;
    if (!data) return undefined;
    const groups = d === "machine" ? data.machines : data.groups[d];
    if (!groups || groups.length === 0) return undefined;
    const total = data.totals.cost;
    const ordered = d === "context" ? [...groups].sort((a, b) => Number(a.key) - Number(b.key)) : groups;
    const shownRows = d === "context" ? ordered : ordered.slice(0, groups.length > limit + 1 ? limit : limit + 1);
    const max = Math.max(...shownRows.map((g) => g.cost), 0);
    const rows: BarRow[] = shownRows.map((g) => {
      const label = this.label(d, g.key);
      return {
        key: g.key,
        label,
        ...(d === "project" && g.key ? { title: g.key } : {}),
        cost: g.cost,
        share: share(g.cost, total),
        length: max > 0 ? g.cost / max : 0,
        color: d === "context" ? (CONTEXT_COLORS[Number(g.key)] ?? OTHER_COLOR) : BAR_COLOR,
        active: d === "machine" ? this.machine === g.key : this.isActive(d, g.key),
      };
    });
    const restGroups = ordered.slice(shownRows.length);
    const restCost = restGroups.reduce((a, g) => a + g.cost, 0);
    return { dimension: d, title, rows, ...(restGroups.length > 0 ? { rest: { count: restGroups.length, cost: restCost, share: share(restCost, total) } } : {}) };
  }

  private cost(d: UsageDimension, keep: (key: string) => boolean): number {
    return (this.data?.groups[d] ?? []).filter((g) => keep(g.key)).reduce((a, g) => a + g.cost, 0);
  }

  kpis(): Kpi[] {
    const data = this.data;
    if (!data) return [];
    const total = data.totals.cost;
    const range = RANGES.find((r) => r.id === this.range)!;
    const out: Kpi[] = [];
    const prev = data.previous.cost;
    const spend: Kpi = { id: "spend", label: "Spent", value: money(total), detail: `${data.totals.calls.toLocaleString("en-US")} model calls` };
    // a change only on a span the ledger holds whole: before history began it would read as growth from nothing
    const whole = data.since === undefined || data.since <= data.from - (data.to - data.from);
    if (prev > 0 && total > 0 && whole) {
      const pct = (100 * (total - prev)) / prev;
      const up = pct >= 0;
      spend.delta = { text: `${up ? "▲" : "▼"} ${Math.abs(pct) >= 10 ? Math.round(Math.abs(pct)) : Math.abs(pct).toFixed(1).replace(/\.0$/, "")}% vs ${range.previous}`, up };
    }
    out.push(spend);
    if (total <= 0) return out;
    const typed = this.cost("trigger", (k) => k === "typed");
    out.push({ id: "typed", label: "Started by you", value: share(typed, total), detail: `${money(typed)} on turns you typed; agents and background work started the rest` });
    const sub = this.cost("agent", (k) => k.startsWith("sub:"));
    out.push({ id: "sub", label: "Sub-agents", value: share(sub, total), detail: `${money(sub)} spent by agents your sessions started` });
    if (data.costs) {
      out.splice(1, 0, { id: "reread", label: "Re-reading context", value: share(data.costs.cacheRead, total), detail: `${money(data.costs.cacheRead)} on reading the conversation again each call` });
    } else {
      // an older machine says nothing of what the spend paid for: the context's size stands in
      const t = data.totals.tokens;
      const avg = data.totals.calls > 0 ? (t.in + t.cacheRead + t.cacheWrite) / data.totals.calls : 0;
      out.push({ id: "context", label: "Average context", value: tokenCount(avg), detail: "tokens each call re-read or wrote, on average" });
    }
    const big = this.cost("context", (k) => Number(k) >= 3);
    out.push({ id: "big", label: "Over 300K context", value: share(big, total), detail: `${money(big)} on calls carrying more than 300K tokens` });
    return out;
  }

  /** What the numbers suggest, biggest first: each only where it applies. */
  suggestions(): Suggestion[] {
    const data = this.data;
    if (!data || data.totals.cost <= 0) return [];
    const total = data.totals.cost;
    const out: Suggestion[] = [];
    const saves = data.sonnetSaves ?? 0;
    if (saves >= 1 && saves >= total * 0.03) {
      out.push({
        id: "sonnet",
        cost: saves,
        title: "Run sub-agents on Sonnet",
        text: `Sub-agents ran on a costlier model. On Sonnet the same calls would have cost ${money(saves)} less, ${share(saves, total)} of this spend. Set CLAUDE_CODE_SUBAGENT_MODEL=sonnet, or name the model per agent.`,
      });
    }
    const big = this.cost("context", (k) => Number(k) >= 3);
    if (big >= total * 0.15) {
      out.push({
        id: "context",
        cost: big,
        title: "Keep contexts smaller",
        text: `${data.costs ? `Re-reading the conversation on every call was ${money(data.costs.cacheRead)} (${share(data.costs.cacheRead, total)}) of this spend. ` : ""}${money(big)} (${share(big, total)}) went on calls carrying more than 300K tokens, each re-reading all of it. Compacting earlier (CLAUDE_CODE_AUTO_COMPACT_WINDOW=300k) and /clear between tasks keep calls smaller.`,
      });
    }
    const peer = this.cost("trigger", (k) => k === "peer");
    const monitor = this.cost("trigger", (k) => k === "monitor");
    const task = this.cost("trigger", (k) => k === "task");
    const woken = peer + monitor + task;
    if (woken >= total * 0.15) {
      // a part under 1% is noise in the sentence; it still counts in the sum
      const named = (v: number) => v >= total * 0.01;
      const parts = [
        named(peer) ? `other agents' messages (${share(peer, total)})` : "",
        named(monitor) ? `Monitor events (${share(monitor, total)})` : "",
        named(task) ? `background tasks finishing (${share(task, total)})` : "",
      ].filter(Boolean);
      out.push({
        id: "woken",
        cost: woken,
        title: "Fewer wake-ups between agents",
        text: `${money(woken)} (${share(woken, total)}) went on turns nobody typed: ${listWords(parts)}. Each one re-reads the whole conversation. Fewer, batched messages between agents and Monitors that fire only on what needs action cut these.`,
      });
    }
    const side = this.cost("agent", (k) => k === "side");
    if (side >= total * 0.05) {
      out.push({
        id: "side",
        cost: side,
        title: "Fewer long-running background agents",
        text: `${money(side)} (${share(side, total)}) went on Claude Code's own calls that no transcript holds: compaction, background agents' progress summaries, memory. Fewer background agents running for hours means fewer of them.`,
      });
    }
    return out.sort((a, b) => b.cost - a.cost).slice(0, 4);
  }

  sessionRows(): SessionRow[] {
    const data = this.data;
    if (!data) return [];
    const total = data.totals.cost;
    const rows = data.sessions.map<SessionRow>((s) => {
      const label = this.label("session", s.key);
      return {
        key: s.key,
        node: s.node,
        label,
        title: s.label ? `${s.label} (${s.key})` : s.key,
        project: projectLabel(s.project ?? ""),
        projectTitle: s.project ?? "",
        account: s.account !== undefined ? this.label("account", s.account) : "Unknown account",
        machine: this.nodeName(s.node),
        cost: s.cost,
        share: share(s.cost, total),
        contextAvg: s.contextAvg,
        subShare: s.cost > 0 ? s.subCost / s.cost : 0,
        lastAt: s.lastAt,
        active: this.isActive("session", s.key),
      };
    });
    const { by, desc } = this.sort;
    const val = (r: SessionRow): number | string => (by === "label" ? r.label.toLowerCase() : by === "sub" ? r.subShare : r[by]);
    rows.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const c = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number);
      return desc ? -c : c;
    });
    return rows;
  }

  sortBy(by: SessionSort): void {
    this.sort = this.sort.by === by ? { by, desc: !this.sort.desc } : { by, desc: by !== "label" };
    this.changed();
  }

  more(): void {
    this.shown += SESSIONS_PAGE;
    this.changed();
  }

  setTable(on: boolean): void {
    this.table = on;
    this.changed();
  }

  /** Quiet lines above the page: machines that did not answer, history still filling, where history starts. */
  notes(locale?: string): string[] {
    const out: string[] = [];
    for (const m of this.missing) out.push(`${m.name} is left out: ${m.reason}.`);
    const data = this.data;
    if (data?.filling) out.push("Still reading the transcripts from before the ledger began: older days fill in as it goes.");
    // only when history starts past the range's first bucket: a first day begun at 08:00 is no gap
    if (data?.since !== undefined && data.since >= data.from + (data.bucket === "day" ? 86_400_000 : HOUR)) out.push(`History starts ${new Date(data.since).toLocaleDateString(locale, { day: "numeric", month: "long" })}: nothing before it was recorded.`);
    return out;
  }
}

function listWords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** A bucket's start in words: "14:00", "Mon 20 Oct". */
export function bucketLabel(at: number, bucket: "hour" | "day", locale?: string, long = false): string {
  const d = new Date(at);
  if (bucket === "hour") return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toLocaleDateString(locale, long ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short" });
}

/** "3 hours ago", "yesterday", "12 Oct". */
export function agoText(at: number, now: number, locale?: string): string {
  const mins = Math.round((now - at) / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? "yesterday" : `${days} days ago`;
  return new Date(at).toLocaleDateString(locale, { day: "numeric", month: "short" });
}

// --- drawing --------------------------------------------------------------------------------

const SVG = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function btn(className: string, focus: string, text: string, onClick: () => void, opts: { pressed?: boolean; title?: string; label?: string } = {}): HTMLButtonElement {
  const b = el("button", className, text);
  b.type = "button";
  b.dataset["focus"] = focus;
  if (opts.pressed !== undefined) b.setAttribute("aria-pressed", String(opts.pressed));
  if (opts.title) b.title = opts.title;
  if (opts.label) b.setAttribute("aria-label", opts.label);
  b.addEventListener("click", onClick);
  return b;
}

function pickSelect(focus: string, label: string, value: string, options: readonly { value: string; label: string }[], set: (v: string) => void): HTMLSelectElement {
  const s = el("select", "host-settings-select host-usage-select");
  s.dataset["focus"] = focus;
  s.setAttribute("aria-label", label);
  for (const o of options) s.append(option(o.value, o.label));
  s.value = value;
  s.addEventListener("change", () => set(s.value));
  return s;
}

export interface UsagePageOptions {
  /** How wide the page's content is, in CSS pixels. */
  width: number;
  locale?: string;
  now?: number;
}

/** The page: filters, notes, then the figures, the chart, the suggestions, the bar lists and the sessions. */
export function usagePage(model: UsageModel, o: UsagePageOptions): HTMLElement[] {
  const out: HTMLElement[] = [filtersRow(model)];
  const chips = model.chips();
  if (chips.length > 0) out.push(chipsRow(model, chips));
  for (const n of model.notes(o.locale)) out.push(el("p", "host-settings-page-note is-quiet host-usage-note", n));
  const data = model.data;
  if (!data) {
    if (model.note) out.push(el("p", "host-settings-page-note", model.note));
    else if (model.loading || !model.loaded) out.push(el("p", "host-settings-page-note is-quiet", "Loading…"));
    return out;
  }
  const body = el("div", `host-usage${model.loading ? " is-loading" : ""}`);
  body.setAttribute("aria-busy", String(model.loading));
  if (data.totals.calls === 0) {
    body.append(el("div", "host-usage-empty", el("p", "host-usage-empty-title", "No spend recorded here."), el("p", "host-usage-empty-text", model.filter.size > 0 ? "Nothing matches these filters in this range. Remove a filter or pick a longer range." : "Nothing was spent in this range on the machines read.")));
    out.push(body);
    return out;
  }
  body.append(tiles(model), costsCard(model), timeCard(model, o), suggestionsCard(model), breakdowns(model), sessionsCard(model, o));
  out.push(body);
  return out;
}

function filtersRow(model: UsageModel): HTMLElement {
  const row = el("div", "host-usage-filters");
  const ranges = el("div", "host-usage-segment");
  ranges.setAttribute("role", "group");
  ranges.setAttribute("aria-label", "Range");
  for (const r of RANGES) ranges.append(btn("host-usage-segment-item", `usage:range:${r.id}`, r.label, () => model.setRange(r.id), { pressed: model.range === r.id }));
  row.append(ranges);
  const machines = model.machines();
  if (machines.length > 1) {
    row.append(pickSelect("usage:machine", "Machine", model.machine, [{ value: "", label: "All machines" }, ...machines.map((n) => ({ value: n.id, label: n.name }))], (v) => model.setMachine(v)));
  }
  for (const d of ["account", "project"] as const) {
    const keys = model.filter.get(d) ?? [];
    const groups = model.data?.groups[d] ?? [];
    const options = new Map<string, string>();
    for (const g of groups) options.set(g.key, model.label(d, g.key));
    for (const k of keys) if (!options.has(k)) options.set(k, model.label(d, k));
    if (options.size === 0 && keys.length === 0) continue;
    const value = keys.length === 1 ? keys[0]! : "";
    const list = [{ value: "", label: d === "account" ? "All accounts" : "All projects" }, ...[...options].map(([value, label]) => ({ value, label }))];
    // several picked by clicks: the select says so, and picking one keeps it alone
    if (keys.length > 1) list.splice(1, 0, { value: "\u0000", label: `${keys.length} ${d === "account" ? "accounts" : "projects"}` });
    row.append(pickSelect(`usage:${d}`, DIMENSION_NAMES[d], keys.length > 1 ? "\u0000" : value, list, (v) => {
      if (v !== "\u0000") model.pick(d, v);
    }));
  }
  return row;
}

function chipsRow(model: UsageModel, chips: Chip[]): HTMLElement {
  const row = el("div", "host-usage-chips");
  row.setAttribute("aria-label", "Filters");
  for (const c of chips) {
    const chip = btn("host-usage-chip", `usage:chip:${c.dimension}:${c.key}`, "", () => model.unfilter(c.dimension, c.key), { label: `Remove filter ${c.text}`, title: "Remove this filter" });
    chip.append(el("span", "host-usage-chip-text", c.text), el("span", "host-usage-chip-x", "✕"));
    row.append(chip);
  }
  if (chips.length > 1) row.append(btn("host-usage-chip-clear", "usage:chips:clear", "Clear all", () => model.clearFilters()));
  return row;
}

function tiles(model: UsageModel): HTMLElement {
  const box = el("div", "host-usage-tiles");
  for (const k of model.kpis()) {
    const tile = el("div", `host-usage-tile is-${k.id}`, el("span", "host-usage-tile-label", k.label), el("span", "host-usage-tile-value", k.value));
    if (k.delta) tile.append(el("span", `host-usage-tile-delta ${k.delta.up ? "is-up" : "is-down"}`, k.delta.text));
    tile.append(el("span", "host-usage-tile-detail", k.detail));
    box.append(tile);
  }
  return box;
}

/** What the spend paid for: one bar cut by kind of cost, 2px gaps between the cuts, and its legend with each kind's dollars and share. */
function costsCard(model: UsageModel): HTMLElement | "" {
  const data = model.data;
  const costs = data?.costs;
  if (!data || !costs) return "";
  const total = COST_KINDS.reduce((a, k) => a + costs[k.key], 0);
  if (total <= 0) return "";
  const card = el("section", "host-usage-card host-usage-costs");
  card.append(cardHead("What the spend paid for"));
  const bar = el("div", "host-usage-costbar");
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", COST_KINDS.map((k) => `${k.label} ${share(costs[k.key], total)}`).join(", "));
  const legend = el("ul", "host-usage-legend host-usage-cost-legend");
  for (const k of COST_KINDS) {
    const v = costs[k.key];
    // a sliver under 0.3% would only be a hairline: the legend carries it
    if (v / total >= 0.003) {
      const seg = el("span", "host-usage-costbar-seg");
      seg.style.flexGrow = String(v);
      seg.style.background = k.color;
      seg.title = `${k.label}: ${money(v)}, ${share(v, total)}`;
      bar.append(seg);
    }
    const swatch = el("span", "host-usage-swatch");
    swatch.style.background = k.color;
    legend.append(el("li", "host-usage-legend-item is-static", swatch, el("span", "host-usage-legend-label", k.label), el("span", "host-usage-legend-value", `${money(v)} · ${share(v, total)}`)));
  }
  card.append(bar, legend);
  return card;
}

function cardHead(title: string, ...right: (HTMLElement | undefined)[]): HTMLElement {
  return el("div", "host-usage-card-head", el("h3", "host-usage-card-title", title), ...right.filter((r): r is HTMLElement => r !== undefined));
}

/** A clean step for the axis: 1, 2, 2.5 or 5 times a power of ten, giving about `ticks` lines. */
export function niceStep(max: number, ticks = 4): number {
  if (max <= 0) return 1;
  const raw = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * pow) return m * pow;
  return 10 * pow;
}

const SPLITS: readonly { value: UsageDimension; label: string }[] = [
  { value: "project", label: "Project" },
  { value: "account", label: "Account" },
  { value: "model", label: "Model" },
  { value: "agent", label: "Who did the work" },
  { value: "trigger", label: "What started it" },
  { value: "context", label: "Context size" },
];

function timeCard(model: UsageModel, o: UsagePageOptions): HTMLElement {
  const view = model.series()!;
  const card = el("section", "host-usage-card host-usage-time");
  card.setAttribute("aria-label", "Spend over time");
  const split = el("label", "host-usage-inline", el("span", "host-usage-inline-label", "Split by"), pickSelect("usage:split", "Split by", model.split, SPLITS, (v) => model.setSplit(v as UsageDimension)));
  const table = btn("host-settings-button is-quiet host-usage-table-toggle", "usage:table", model.table ? "Chart" : "Table", () => model.setTable(!model.table), { pressed: model.table, title: model.table ? "Show the chart" : "Show the numbers as a table" });
  card.append(cardHead(model.range === "today" ? "Spend by hour" : "Spend by day", split, table));
  // one series needs no legend: the title and the filter chip name it
  if (view.keys.length > 1) card.append(legend(model, view));
  card.append(model.table ? seriesTable(view, o.locale) : columns(model, view, o));
  return card;
}

function legend(model: UsageModel, view: SeriesView): HTMLElement {
  const list = el("ul", "host-usage-legend");
  list.setAttribute("aria-label", "Series");
  for (const k of view.keys) {
    const swatch = el("span", "host-usage-swatch");
    swatch.style.background = k.color;
    const text = [swatch, el("span", "host-usage-legend-label", k.label), el("span", "host-usage-legend-value", money(k.total))];
    if (k.other) list.append(el("li", "host-usage-legend-item is-other", ...text));
    else {
      const b = btn("host-usage-legend-item", `usage:legend:${k.key}`, "", () => model.toggle(model.split, k.key), { pressed: model.isActive(model.split, k.key), title: `Show only ${k.label}` });
      b.append(...text);
      list.append(el("li", "", b));
    }
  }
  return list;
}

function seriesTable(view: SeriesView, locale?: string): HTMLElement {
  const wrap = el("div", "host-usage-table-wrap");
  const t = el("table", "host-usage-table");
  const head = el("tr", "", el("th", "", view.bucket === "hour" ? "Hour" : "Day"), el("th", "is-num", "Total"), ...view.keys.map((k) => el("th", "is-num", k.label)));
  t.append(el("thead", "", head));
  const body = el("tbody");
  view.buckets.forEach((at, i) => {
    if (view.totals[i]! <= 0) return;
    body.append(el("tr", "", el("td", "", bucketLabel(at, view.bucket, locale, true)), el("td", "is-num", money(view.totals[i]!)), ...view.values[i]!.map((v) => el("td", "is-num", v > 0 ? money(v) : "–"))));
  });
  t.append(body);
  wrap.append(t);
  return wrap;
}

/** The stacked columns: hairline grid, a column per bucket, the biggest key at the base, a 2px gap between segments; hover or the arrow keys show a bucket's every series. */
function columns(model: UsageModel, view: SeriesView, o: UsagePageOptions): HTMLElement {
  const width = Math.max(280, Math.floor(o.width - 32));
  const narrow = width < 520;
  const plotH = narrow ? 150 : 210;
  const left = 46;
  const right = 6;
  const top = 18;
  const axis = 24;
  const height = top + plotH + axis;
  const plotW = width - left - right;
  const n = view.buckets.length;
  const band = plotW / Math.max(1, n);
  const colW = Math.max(2, Math.min(24, band * 0.72));
  const step = niceStep(view.max, narrow ? 3 : 4);
  const maxY = Math.max(step, Math.ceil(view.max / step) * step);
  const y = (v: number) => top + plotH - (v / maxY) * plotH;
  const wrap = el("div", "host-usage-chart");
  wrap.tabIndex = 0;
  wrap.dataset["focus"] = "usage:chart";
  const peak = view.totals.indexOf(view.max);
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", `Spend by ${view.bucket}: ${money(view.keys.reduce((a, k) => a + k.total, 0))} in all${peak >= 0 && view.max > 0 ? `, most on ${bucketLabel(view.buckets[peak]!, view.bucket, o.locale, true)} (${money(view.max)})` : ""}. Use the arrow keys to read each ${view.bucket}, or the Table button for every number.`);
  const s = svg("svg", { width, height, viewBox: `0 0 ${width} ${height}`, class: "host-usage-svg" });
  s.setAttribute("aria-hidden", "true");
  // grid and axis
  for (let v = 0; v <= maxY + 1e-9; v += step) {
    const gy = Math.round(y(v)) + 0.5;
    s.append(svg("line", { x1: left, x2: width - right, y1: gy, y2: gy, class: v === 0 ? "host-usage-axis" : "host-usage-gridline" }));
    const t = svg("text", { x: left - 8, y: gy + 4, class: "host-usage-tick", "text-anchor": "end" });
    t.textContent = moneyCompact(v);
    s.append(t);
  }
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / (view.bucket === "hour" ? 44 : 58)))));
  view.buckets.forEach((at, i) => {
    if (i % labelEvery !== 0) return;
    const t = svg("text", { x: left + i * band + band / 2, y: top + plotH + 16, class: "host-usage-tick", "text-anchor": "middle" });
    t.textContent = view.bucket === "hour" ? String(new Date(at).getHours()).padStart(2, "0") : bucketLabel(at, "day", o.locale);
    s.append(t);
  });
  const cross = svg("line", { x1: 0, x2: 0, y1: top, y2: top + plotH, class: "host-usage-cross" });
  cross.style.display = "none";
  s.append(cross);
  const cols: SVGGElement[] = [];
  view.buckets.forEach((_at, i) => {
    const g = svg("g", { class: "host-usage-col" });
    const x = left + i * band + (band - colW) / 2;
    let base = top + plotH;
    const segs = view.values[i]!.map((v, j) => ({ v, j })).filter((x) => x.v > 0);
    segs.forEach(({ v, j }, k) => {
      const h = (v / maxY) * plotH;
      // a 2px surface gap under every segment but the first: it shrinks from its base
      const gap = k > 0 && h > 3 ? 2 : 0;
      const topY = base - h;
      const segH = Math.max(0.5, h - gap);
      const last = k === segs.length - 1;
      const key = view.keys[j]!;
      const shape = last ? svg("path", { d: roundedTop(x, topY, colW, segH, Math.min(4, colW / 2, segH)) }) : svg("rect", { x, y: topY, width: colW, height: segH });
      shape.setAttribute("fill", key.color);
      if (!key.other) {
        shape.classList.add("is-pick");
        shape.addEventListener("click", () => model.toggle(model.split, key.key));
      }
      g.append(shape);
      base = topY;
    });
    cols.push(g);
    s.append(g);
  });
  // the peak's total over its column, when it fits
  if (peak >= 0 && view.max > 0 && band >= 18) {
    const t = svg("text", { x: left + peak * band + band / 2, y: y(view.max) - 5, class: "host-usage-peak", "text-anchor": "middle" });
    t.textContent = moneyCompact(view.max);
    s.append(t);
  }
  const tip = el("div", "host-usage-tip");
  tip.hidden = true;
  let active = -1;
  const show = (i: number) => {
    active = i;
    // the peak's label steps aside while a column is read: the crosshair and the tip would cross it
    wrap.classList.toggle("is-reading", i >= 0 && i < n);
    if (i < 0 || i >= n) {
      tip.hidden = true;
      cross.style.display = "none";
      for (const c of cols) c.classList.remove("is-hot", "is-cold");
      return;
    }
    const cx = left + i * band + band / 2;
    cross.setAttribute("x1", String(cx));
    cross.setAttribute("x2", String(cx));
    cross.style.display = "";
    cols.forEach((c, j) => {
      c.classList.toggle("is-hot", j === i);
      c.classList.toggle("is-cold", j !== i);
    });
    tip.replaceChildren(el("div", "host-usage-tip-when", bucketLabel(view.buckets[i]!, view.bucket, o.locale, true)), el("div", "host-usage-tip-total", money(view.totals[i]!)));
    const rows = view.values[i]!.map((v, j) => ({ v, k: view.keys[j]! })).filter((r) => r.v > 0).sort((a, b) => b.v - a.v);
    for (const r of rows) {
      const key = el("span", "host-usage-tip-key");
      key.style.background = r.k.color;
      tip.append(el("div", "host-usage-tip-row", key, el("span", "host-usage-tip-value", money(r.v)), el("span", "host-usage-tip-label", r.k.label)));
    }
    if (rows.length === 0) tip.append(el("div", "host-usage-tip-row is-empty", "Nothing spent"));
    tip.hidden = false;
    const tw = tip.offsetWidth || 180;
    tip.style.left = `${Math.min(Math.max(0, cx + 12 + tw > width ? cx - 12 - tw : cx + 12), Math.max(0, width - tw))}px`;
    tip.style.top = `${top}px`;
  };
  const indexAt = (clientX: number) => {
    const r = s.getBoundingClientRect();
    const px = ((clientX - r.left) / Math.max(1, r.width)) * width;
    return px < left || px > width - right ? -1 : Math.min(n - 1, Math.floor((px - left) / band));
  };
  s.addEventListener("pointermove", (ev) => show(indexAt(ev.clientX)));
  s.addEventListener("pointerleave", () => {
    if (document.activeElement !== wrap) show(-1);
  });
  wrap.addEventListener("keydown", (ev) => {
    const next = ev.key === "ArrowRight" ? active + 1 : ev.key === "ArrowLeft" ? (active < 0 ? n - 1 : active - 1) : ev.key === "Home" ? 0 : ev.key === "End" ? n - 1 : undefined;
    if (next === undefined) return;
    ev.preventDefault();
    show(Math.max(0, Math.min(n - 1, next)));
  });
  wrap.addEventListener("focus", () => {
    if (active < 0) show(peak >= 0 ? peak : n - 1);
  });
  wrap.addEventListener("blur", () => show(-1));
  wrap.append(s, tip);
  return wrap;
}

/** A column's top segment: rounded data-end, square at its base. */
function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  if (r <= 0) return `M${x} ${y}h${w}v${h}h${-w}z`;
  return `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`;
}

function suggestionsCard(model: UsageModel): HTMLElement | "" {
  const list = model.suggestions();
  if (list.length === 0) return "";
  const card = el("section", "host-usage-card host-usage-ideas");
  card.append(cardHead("Ways to spend less"));
  const ol = el("ol", "host-usage-ideas-list");
  for (const s of list) ol.append(el("li", "host-usage-idea", el("span", "host-usage-idea-title", s.title), el("span", "host-usage-idea-text", s.text)));
  card.append(ol);
  return card;
}

const BREAKDOWNS: readonly { d: UsageDimension; title: string }[] = [
  { d: "project", title: "By project" },
  { d: "account", title: "By account" },
  { d: "model", title: "By model" },
  { d: "agent", title: "Who did the work" },
  { d: "trigger", title: "What started it" },
  { d: "context", title: "Context each call carried" },
];

function breakdowns(model: UsageModel): HTMLElement {
  const grid = el("div", "host-usage-grid");
  const lists: BarList[] = [];
  if (!model.machine && (model.data?.machines.length ?? 0) > 1) {
    const m = model.bars("machine", "By machine");
    if (m) lists.push(m);
  }
  for (const b of BREAKDOWNS) {
    const list = model.bars(b.d, b.title);
    if (list) lists.push(list);
  }
  for (const list of lists) grid.append(barCard(model, list));
  return grid;
}

function barCard(model: UsageModel, list: BarList): HTMLElement {
  const card = el("section", "host-usage-card host-usage-bars-card");
  card.append(cardHead(list.title));
  const ol = el("ol", "host-usage-bars");
  for (const r of list.rows) {
    const fill = el("span", "host-usage-bar-fill");
    fill.style.setProperty("--w", String(r.length));
    fill.style.background = r.color;
    const pick = () => (list.dimension === "machine" ? model.setMachine(model.machine === r.key ? "" : r.key) : model.toggle(list.dimension, r.key));
    const b = btn(`host-usage-bar${r.active ? " is-active" : ""}`, `usage:bar:${list.dimension}:${r.key}`, "", pick, { pressed: r.active, title: `${r.title ?? r.label}: ${money(r.cost)}, ${r.share}. Click to ${r.active ? "remove the filter" : "look at it alone"}.` });
    b.append(el("span", "host-usage-bar-label", r.label), el("span", "host-usage-bar-track", fill, el("span", "host-usage-bar-value", money(r.cost), el("span", "host-usage-bar-share", r.share))));
    ol.append(el("li", "", b));
  }
  if (list.rest) ol.append(el("li", "host-usage-bar-rest", `${list.rest.count} more · ${money(list.rest.cost)} · ${list.rest.share}`));
  card.append(ol);
  return card;
}

// what it spent beside its name, so a phone shows both before the table scrolls
const SESSION_COLUMNS: readonly { by?: SessionSort; label: string; num?: boolean; wide?: boolean }[] = [
  { by: "label", label: "Session", wide: true },
  { by: "cost", label: "Spent", num: true },
  { label: "Project" },
  { label: "Account" },
  { by: "contextAvg", label: "Avg context", num: true },
  { by: "sub", label: "Sub-agents", num: true },
  { by: "lastAt", label: "Last active", num: true },
];

function sessionsCard(model: UsageModel, o: UsagePageOptions): HTMLElement {
  const rows = model.sessionRows();
  const card = el("section", "host-usage-card host-usage-sessions");
  const showMachine = !model.machine && new Set(rows.map((r) => r.node)).size > 1;
  card.append(cardHead("Sessions", el("span", "host-usage-card-aside", rows.length > model.shown ? `the ${model.shown} of ${rows.length} that spent most` : `${rows.length} ${rows.length === 1 ? "session" : "sessions"}`)));
  const wrap = el("div", "host-usage-table-wrap");
  const t = el("table", "host-usage-table host-usage-session-table");
  const cols = showMachine ? [...SESSION_COLUMNS.slice(0, 4), { label: "Machine" }, ...SESSION_COLUMNS.slice(4)] : SESSION_COLUMNS;
  const head = el("tr");
  for (const c of cols) {
    const th = el("th", `${c.num ? "is-num" : ""}${c.wide ? " is-wide" : ""}`.trim());
    if (c.by) {
      const by = c.by;
      const sorted = model.sort.by === by;
      th.setAttribute("aria-sort", sorted ? (model.sort.desc ? "descending" : "ascending") : "none");
      th.append(btn("host-usage-sort", `usage:sort:${by}`, `${c.label}${sorted ? (model.sort.desc ? " ↓" : " ↑") : ""}`, () => model.sortBy(by)));
    } else th.textContent = c.label;
    head.append(th);
  }
  t.append(el("thead", "", head));
  const body = el("tbody");
  const now = o.now ?? Date.now();
  for (const r of rows.slice(0, model.shown)) {
    const name = btn("host-usage-session-name", `usage:session:${r.key}`, r.label, () => model.toggle("session", r.key), { pressed: r.active, title: `${r.title}. Click to ${r.active ? "remove the filter" : "look at it alone"}.` });
    const project = el("td", "host-usage-ellipsis", r.project);
    if (r.projectTitle) project.title = r.projectTitle;
    const cells: HTMLElement[] = [el("td", "is-wide", name), el("td", "is-num", el("span", "host-usage-strong", money(r.cost)), el("span", "host-usage-faint", ` ${r.share}`)), project, el("td", "host-usage-ellipsis", r.account)];
    if (showMachine) cells.push(el("td", "host-usage-ellipsis", r.machine));
    cells.push(
      el("td", "is-num", r.contextAvg > 0 ? tokenCount(r.contextAvg) : "–"),
      el("td", "is-num", r.subShare > 0 ? share(r.subShare, 1) : "–"),
      el("td", "is-num host-usage-faint", agoText(r.lastAt, now, o.locale)),
    );
    const tr = el("tr", r.active ? "is-active" : "", ...cells);
    body.append(tr);
  }
  t.append(body);
  wrap.append(t);
  card.append(wrap);
  if (rows.length > model.shown) card.append(el("div", "host-usage-more", btn("host-settings-button is-quiet", "usage:more", `Show ${Math.min(SESSIONS_PAGE, rows.length - model.shown)} more`, () => model.more())));
  return card;
}
