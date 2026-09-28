// Each harness login's plan limits: how much of its session (five-hour) window and its
// weekly one it has used, carried on every sample for the spend rows. Claude's come from the
// usage endpoint Claude Code's own `/usage` reads, asked with the profile's login from its
// `.credentials.json`, or on macOS, where a login leaves none, from the profile's Keychain item
// (the daemon's `keychain`, through `/usr/bin/security` as Claude Code reads it, which the
// item's access list trusts, so no prompt): read and never refreshed or written, so an expired
// token means no new reading until Claude Code refreshes it. A profile on an API key has no
// plan and no limits. Codex writes its limits into every `token_count` of a
// rollout, so the newest of the recent rollouts' last ones is read: by the row's time, since a
// rollout Codex keeps writing on Windows can keep the time it was made as its last-modified
// one, and only a rollout that grew since it was last read is read again. Muse's host keeps the
// last usage it observed, which `usage/read` gives without a model call; none until the login
// has made one. Readings are taken while a client watches the samples (`refresh`), and when
// someone asks for them now (`fresh`: `profile.limits`, the brain choosing an account),
// Claude's at most every five minutes either way, and a window whose reset has passed reads 0
// until the next reading says otherwise.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HarnessProfile, LimitWindow, ProfileLimits } from "@cophyla/protocol";
import type { Logger } from "../log.ts";

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** Between two readings of a Claude login, and after the endpoint said too many. */
export const CLAUDE_EVERY_MS = 5 * 60_000;
export const CLAUDE_BACKOFF_MS = 15 * 60_000;
/** Between two readings of a Codex rollout or a Muse host: both local, so often. */
export const CODEX_EVERY_MS = 60_000;
const FETCH_TIMEOUT_MS = 5000;
/** How old a reading `fresh` takes as it is, and how long it waits for new ones. */
export const FRESH_MAX_AGE_MS = 5 * 60_000;
export const FRESH_TIMEOUT_MS = 3000;
/** How much of a rollout's end is read for its last `rate_limits`. */
const ROLLOUT_TAIL_BYTES = 256 * 1024;
/** A Codex window this long or longer is the weekly one; shorter, the session's. */
const WEEK_MINUTES_FLOOR = 24 * 60;

export interface PlanLimitsDeps {
  profiles: () => HarnessProfile[];
  log: Logger;
  /** A Muse profile's limits as its host last observed them. */
  muse?: (profileId: string) => Promise<ProfileLimits | undefined>;
  /** macOS: the text of a Claude login's Keychain item (what `.credentials.json` holds elsewhere); never asked when absent. */
  keychain?: (configDir: string) => Promise<string | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
}

/** A reading's outcome: new limits, none (the login has none to read), or the last reading kept. */
type Read = { limits: ProfileLimits } | { none: true } | { keep: true; retryMs?: number };

/** A rollout's size when it was last read, and the limits its last `token_count` carried then. */
interface RolloutRead {
  size: number;
  limits?: ProfileLimits;
}

export class PlanLimits {
  private deps: PlanLimitsDeps;
  private readings = new Map<string, ProfileLimits>();
  /** When each profile may be read again. */
  private due = new Map<string, number>();
  private running?: Promise<void>;
  /** When each profile was last read, whatever the reading said. */
  private readAt = new Map<string, number>();
  /** Each Codex profile's recent rollouts, by path, as last read. */
  private rollouts = new Map<string, Map<string, RolloutRead>>();

  constructor(deps: PlanLimitsDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The latest readings by profile, a window past its reset at 0; undefined when there are none. */
  latest(): Record<string, ProfileLimits> | undefined {
    if (this.readings.size === 0) return undefined;
    const now = this.now();
    const out: Record<string, ProfileLimits> = {};
    for (const [profile, r] of this.readings) {
      const limits: ProfileLimits = { at: r.at };
      const session = current(r.session, now);
      const weekly = current(r.weekly, now);
      if (session) limits.session = session;
      if (weekly) limits.weekly = weekly;
      out[profile] = limits;
    }
    return out;
  }

  /** Reads every profile that is due, one pass at a time; a pass under way is joined. */
  refresh(): Promise<void> {
    return this.running ?? this.queue();
  }

  /** A pass after the one under way, so no login is read twice at once. */
  private queue(only?: ReadonlySet<string>): Promise<void> {
    const next: Promise<void> = (this.running ?? Promise.resolve())
      .then(() => this.pass(only))
      .finally(() => {
        if (this.running === next) this.running = undefined;
      });
    this.running = next;
    return next;
  }

  /**
   * The latest readings of these profiles, read again first where the last read is older than
   * `maxAgeMs` and the profile is due (the five-minute floor and a 429's back-off still hold),
   * whether or not anyone watches the samples. Waits at most `timeoutMs` for the reads, then
   * answers with what there is.
   */
  async fresh(ids: readonly string[], opts: { maxAgeMs?: number; timeoutMs?: number } = {}): Promise<Record<string, ProfileLimits>> {
    const maxAge = opts.maxAgeMs ?? FRESH_MAX_AGE_MS;
    const now = this.now();
    const stale = ids.filter((id) => now - (this.readAt.get(id) ?? -Infinity) >= maxAge && (this.due.get(id) ?? 0) <= now);
    if (stale.length > 0) {
      // After a pass under way, which may have read them already: `pass` skips what is not due.
      const reads = this.queue(new Set(stale)).catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<void>((r) => {
        timer = setTimeout(r, opts.timeoutMs ?? FRESH_TIMEOUT_MS);
      });
      await Promise.race([reads, late]);
      if (timer) clearTimeout(timer);
    }
    const latest = this.latest() ?? {};
    const out: Record<string, ProfileLimits> = {};
    for (const id of ids) if (latest[id]) out[id] = latest[id]!;
    return out;
  }

  private async pass(only?: ReadonlySet<string>): Promise<void> {
    const profiles = this.deps.profiles();
    const known = new Set(profiles.map((p) => p.id));
    for (const id of [...this.readings.keys()]) if (!known.has(id)) this.readings.delete(id);
    for (const id of [...this.rollouts.keys()]) if (!known.has(id)) this.rollouts.delete(id);
    for (const p of profiles) {
      if (only && !only.has(p.id)) continue;
      const now = this.now();
      if ((this.due.get(p.id) ?? 0) > now) continue;
      const every = p.harness === "claude" ? CLAUDE_EVERY_MS : CODEX_EVERY_MS;
      let read: Read;
      try {
        read = p.harness === "claude" ? await this.readClaude(p) : p.harness === "muse" ? await this.readMuse(p) : this.readCodex(p);
      } catch (e) {
        this.deps.log.debug("plan limits not read", { profile: p.id, error: e instanceof Error ? e.message : String(e) });
        read = { keep: true };
      }
      this.due.set(p.id, now + ("keep" in read && read.retryMs !== undefined ? read.retryMs : every));
      this.readAt.set(p.id, now);
      if ("limits" in read) this.readings.set(p.id, read.limits);
      else if ("none" in read) this.readings.delete(p.id);
    }
  }

  private async readClaude(p: HarnessProfile): Promise<Read> {
    if (p.env["ANTHROPIC_API_KEY"]) return { none: true };
    let token = claudeToken(p.configDir, this.now());
    if (token === undefined && this.deps.keychain) {
      const item = await this.deps.keychain(p.configDir);
      if (item !== undefined) token = claudeTokenOf(item, this.now());
    }
    if (token === undefined) return { none: true };
    // Expired: Claude Code has not run under this login lately; what was read last still stands.
    if (token === "expired") return { keep: true };
    const res = await (this.deps.fetch ?? fetch)(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 429) return { keep: true, retryMs: CLAUDE_BACKOFF_MS };
    if (res.status === 401 || res.status === 403) return { none: true };
    if (!res.ok) return { keep: true };
    const body = (await res.json()) as Record<string, unknown>;
    const limits: ProfileLimits = { at: this.now() };
    const session = claudeWindow(body["five_hour"]);
    const weekly = claudeWindow(body["seven_day"]);
    if (session) limits.session = session;
    if (weekly) limits.weekly = weekly;
    return session || weekly ? { limits } : { none: true };
  }

  private async readMuse(p: HarnessProfile): Promise<Read> {
    const limits = this.deps.muse ? await this.deps.muse(p.id) : undefined;
    return limits ? { limits } : { none: true };
  }

  private readCodex(p: HarnessProfile): Read {
    const before = this.rollouts.get(p.id);
    const now = new Map<string, RolloutRead>();
    let newest: ProfileLimits | undefined;
    for (const { path, size } of recentRollouts(p.configDir)) {
      let read = before?.get(path);
      if (!read || read.size !== size) {
        try {
          const limits = lastRolloutLimits(readTail(path, ROLLOUT_TAIL_BYTES));
          read = limits ? { size, limits } : { size };
        } catch {
          continue; // gone between the listing and the read
        }
      }
      now.set(path, read);
      if (read.limits && (!newest || read.limits.at > newest.at)) newest = read.limits;
    }
    this.rollouts.set(p.id, now);
    return newest ? { limits: newest } : { keep: true };
  }
}

/** A window as it stands now: one whose reset has passed has started over. */
function current(w: LimitWindow | undefined, now: number): LimitWindow | undefined {
  if (!w) return undefined;
  return w.resetsAt !== undefined && w.resetsAt <= now ? { percent: 0 } : w;
}

/** The profile's access token, "expired" when it has run out, undefined when there is no login in the file. */
export function claudeToken(configDir: string, now: number): string | "expired" | undefined {
  const path = join(configDir, ".credentials.json");
  if (!existsSync(path)) return undefined;
  return claudeTokenOf(readFileSync(path, "utf8"), now);
}

/** The access token in a login's text (`.credentials.json`, or the Keychain item's), as `claudeToken` reads it. */
export function claudeTokenOf(text: string, now: number): string | "expired" | undefined {
  let oauth: { accessToken?: unknown; expiresAt?: unknown } | undefined;
  try {
    oauth = (JSON.parse(text) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } }).claudeAiOauth;
  } catch {
    return undefined;
  }
  if (!oauth || typeof oauth.accessToken !== "string" || oauth.accessToken === "") return undefined;
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= now) return "expired";
  return oauth.accessToken;
}

/** `{utilization, resets_at}` from the usage endpoint: a percent and an ISO time. */
export function claudeWindow(v: unknown): LimitWindow | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const used = o["utilization"];
  if (typeof used !== "number" || !Number.isFinite(used)) return undefined;
  const w: LimitWindow = { percent: Math.max(0, used) };
  const resets = typeof o["resets_at"] === "string" ? Date.parse(o["resets_at"]) : NaN;
  if (Number.isFinite(resets)) w.resetsAt = resets;
  return w;
}

/** Directory names that are numbers (`YYYY`, `MM`, `DD`), largest first. */
function numbered(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => Number(b) - Number(a));
  } catch {
    return [];
  }
}

/** The rollouts of the last two days Codex wrote any, with their sizes: `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`. */
export function recentRollouts(codexHome: string): { path: string; size: number }[] {
  const root = join(codexHome, "sessions");
  const days: string[] = [];
  outer: for (const y of numbered(root)) {
    for (const m of numbered(join(root, y))) {
      for (const d of numbered(join(root, y, m))) {
        days.push(join(root, y, m, d));
        if (days.length === 2) break outer;
      }
    }
  }
  const out: { path: string; size: number }[] = [];
  for (const day of days) {
    let names: string[];
    try {
      names = readdirSync(day);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const path = join(day, name);
      try {
        out.push({ path, size: statSync(path).size });
      } catch {
        // gone between the listing and the stat
      }
    }
  }
  return out;
}

/** The last `bytes` of a file as text, the partial first line dropped when the read starts mid-file. */
function readTail(path: string, bytes: number): string {
  const size = statSync(path).size;
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString("utf8");
  return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
}

/** The limits of the last `token_count` in a rollout's lines that carries a window. */
export function lastRolloutLimits(text: string): ProfileLimits | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"rate_limits"')) continue;
    let row: { timestamp?: unknown; payload?: { rate_limits?: Record<string, unknown> } };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      continue;
    }
    const rl = row.payload?.rate_limits;
    if (!rl) continue;
    const stamped = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
    const at = Number.isFinite(stamped) ? stamped : Date.now();
    const limits: ProfileLimits = { at };
    for (const w of [rl["primary"], rl["secondary"]]) {
      const read = codexWindow(w, at);
      if (read) limits[read.kind] = read.window;
    }
    if (limits.session || limits.weekly) return limits;
  }
  return undefined;
}

/** `{used_percent, window_minutes, resets_at | resets_in_seconds}`: which window it is by its length. */
function codexWindow(v: unknown, at: number): { kind: "session" | "weekly"; window: LimitWindow } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const used = o["used_percent"];
  const minutes = o["window_minutes"];
  if (typeof used !== "number" || !Number.isFinite(used) || typeof minutes !== "number") return undefined;
  const window: LimitWindow = { percent: Math.max(0, used) };
  if (typeof o["resets_at"] === "number") window.resetsAt = o["resets_at"] * 1000;
  else if (typeof o["resets_in_seconds"] === "number") window.resetsAt = at + o["resets_in_seconds"] * 1000;
  return { kind: minutes >= WEEK_MINUTES_FLOOR ? "weekly" : "session", window };
}
