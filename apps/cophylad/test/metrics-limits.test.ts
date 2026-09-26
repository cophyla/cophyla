// Each harness login's plan limits: Claude's read from its usage endpoint with the login's
// own token (never refreshed; an expired one, an API key or a refusal reads nothing new),
// at most every five minutes and a quarter hour after a 429; Codex's from the newest
// `rate_limits` row of its recent rollouts, the window told by its length; Muse's
// from what its host last observed; a window past its reset reads 0; and a profile that is
// gone takes its reading with it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessProfile } from "@cophyla/protocol";
import { silentLogger } from "../src/log.ts";
import { CLAUDE_BACKOFF_MS, CLAUDE_EVERY_MS, CLAUDE_USAGE_URL, claudeWindow, lastRolloutLimits, PlanLimits, recentRollouts } from "../src/metrics/limits.ts";

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CLAUDE = "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8";
const CODEX = "prof_01ARZ3NDEKTSV4RRFFQ69G5FB9";
const T0 = Date.parse("2026-09-23T12:00:00Z");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cophyla-limits-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function profile(id: string, harness: "claude" | "codex", configDir: string, env: Record<string, string> = {}): HarnessProfile {
  return { id, node: NODE, harness, name: harness, configDir, env, origin: "discovered", status: "ok" };
}

function login(configDir: string, expiresAt: number): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok-1", refreshToken: "never-used", expiresAt, scopes: ["user:profile"] } }));
}

const USAGE = {
  five_hour: { utilization: 4, resets_at: "2026-09-23T14:40:00.273145+00:00" },
  seven_day: { utilization: 55, resets_at: "2026-09-27T08:00:00.273167+00:00" },
  seven_day_opus: null,
};

/** A fetch that answers from a queue and records what it was asked. */
function fakeFetch(answers: (() => Response)[]): { fetch: typeof fetch; calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    const next = answers.shift();
    if (!next) throw new Error("no answer queued");
    return next();
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("plan limits: Claude", () => {
  test("the usage endpoint with the login's token: the five-hour window is the session's, the seven-day the week's", async () => {
    const home = join(dir, ".claude");
    login(home, T0 + 3_600_000);
    const { fetch, calls } = fakeFetch([json(USAGE)]);
    const clock = { now: T0 };
    const limits = new PlanLimits({ profiles: () => [profile(CLAUDE, "claude", home)], log: silentLogger, fetch, now: () => clock.now });
    expect(limits.latest()).toBeUndefined();
    await limits.refresh();
    expect(calls).toEqual([{ url: CLAUDE_USAGE_URL, headers: { Authorization: "Bearer tok-1", "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json" } }]);
    expect(limits.latest()).toEqual({
      [CLAUDE]: { at: T0, session: { percent: 4, resetsAt: Date.parse("2026-09-23T14:40:00.273Z") }, weekly: { percent: 55, resetsAt: Date.parse("2026-09-27T08:00:00.273Z") } },
    });
    // Not again within five minutes, however often it is asked.
    clock.now += CLAUDE_EVERY_MS - 1;
    await limits.refresh();
    expect(calls.length).toBe(1);
    // Past the session window's reset it reads 0 until the next reading.
    clock.now = Date.parse("2026-09-23T14:41:00Z");
    expect(limits.latest()![CLAUDE]!.session).toEqual({ percent: 0 });
    expect(limits.latest()![CLAUDE]!.weekly!.percent).toBe(55);
  });

  test("an expired token keeps the last reading and asks nothing; a refusal drops it; a 429 keeps it and waits a quarter hour", async () => {
    const home = join(dir, ".claude");
    login(home, T0 + 3_600_000);
    const { fetch, calls } = fakeFetch([json(USAGE), json({ error: "slow down" }, 429), json({ error: "no" }, 401)]);
    const clock = { now: T0 };
    const limits = new PlanLimits({ profiles: () => [profile(CLAUDE, "claude", home)], log: silentLogger, fetch, now: () => clock.now });
    await limits.refresh();
    expect(limits.latest()![CLAUDE]!.weekly!.percent).toBe(55);
    // Too many: the reading stands, and the next try waits.
    clock.now += CLAUDE_EVERY_MS;
    await limits.refresh();
    expect(calls.length).toBe(2);
    expect(limits.latest()![CLAUDE]!.weekly!.percent).toBe(55);
    clock.now += CLAUDE_EVERY_MS;
    await limits.refresh();
    expect(calls.length).toBe(2);
    // The token runs out before the backoff does: nothing is asked, the reading stands.
    clock.now = T0 + CLAUDE_EVERY_MS + CLAUDE_BACKOFF_MS;
    login(home, clock.now - 1);
    await limits.refresh();
    expect(calls.length).toBe(2);
    expect(limits.latest()![CLAUDE]!.weekly!.percent).toBe(55);
    // Claude Code refreshed it; the server refuses the login: no limits to show.
    clock.now += CLAUDE_EVERY_MS;
    login(home, clock.now + 3_600_000);
    await limits.refresh();
    expect(calls.length).toBe(3);
    expect(limits.latest()).toBeUndefined();
  });

  test("fresh: read when asked, with no one watching the samples; within five minutes, or while backing off, the reading stands", async () => {
    const home = join(dir, ".claude");
    login(home, T0 + 3_600_000);
    const { fetch, calls } = fakeFetch([json(USAGE), json({ error: "slow down" }, 429)]);
    const clock = { now: T0 };
    const limits = new PlanLimits({ profiles: () => [profile(CLAUDE, "claude", home), profile(CODEX, "codex", join(dir, ".codex"))], log: silentLogger, fetch, now: () => clock.now });
    // Only the profiles asked about, and only those with a reading.
    expect(await limits.fresh([CLAUDE, CODEX])).toEqual({ [CLAUDE]: expect.objectContaining({ weekly: expect.objectContaining({ percent: 55 }) }) });
    expect(calls.length).toBe(1);
    clock.now += CLAUDE_EVERY_MS - 1;
    await limits.fresh([CLAUDE]);
    expect(calls.length).toBe(1);
    clock.now += 1;
    expect((await limits.fresh([CLAUDE]))[CLAUDE]!.weekly!.percent).toBe(55);
    expect(calls.length).toBe(2);
    clock.now += CLAUDE_EVERY_MS;
    await limits.fresh([CLAUDE]);
    expect(calls.length).toBe(2);
  });

  test("fresh answers with what there is when the reading takes too long", async () => {
    const home = join(dir, ".claude");
    login(home, T0 + 3_600_000);
    let release!: () => void;
    const slow = (async () => {
      await new Promise<void>((r) => (release = r));
      return json(USAGE)();
    }) as unknown as typeof fetch;
    const limits = new PlanLimits({ profiles: () => [profile(CLAUDE, "claude", home)], log: silentLogger, fetch: slow, now: () => T0 });
    const started = Date.now();
    expect(await limits.fresh([CLAUDE], { timeoutMs: 50 })).toEqual({});
    expect(Date.now() - started).toBeLessThan(2000);
    release();
    await limits.refresh();
    expect(limits.latest()![CLAUDE]!.weekly!.percent).toBe(55);
  });

  test("an API key, or no login in the directory, has no plan: nothing is asked", async () => {
    const keyed = join(dir, "keyed");
    login(keyed, T0 + 3_600_000);
    const { fetch, calls } = fakeFetch([]);
    const limits = new PlanLimits({ profiles: () => [profile(CLAUDE, "claude", keyed, { ANTHROPIC_API_KEY: "sk-x" }), profile(CODEX, "claude", join(dir, "empty"))], log: silentLogger, fetch, now: () => T0 });
    await limits.refresh();
    expect(calls).toEqual([]);
    expect(limits.latest()).toBeUndefined();
  });

  test("a network failure keeps what was read; a profile that is gone takes its reading with it", async () => {
    const home = join(dir, ".claude");
    login(home, T0 + 3_600_000);
    const { fetch } = fakeFetch([json(USAGE), () => {
      throw new Error("offline");
    }]);
    const clock = { now: T0 };
    let profiles = [profile(CLAUDE, "claude", home)];
    const limits = new PlanLimits({ profiles: () => profiles, log: silentLogger, fetch, now: () => clock.now });
    await limits.refresh();
    clock.now += CLAUDE_EVERY_MS;
    await limits.refresh();
    expect(limits.latest()![CLAUDE]!.session!.percent).toBe(4);
    profiles = [];
    await limits.refresh();
    expect(limits.latest()).toBeUndefined();
  });

  test("a window reads its utilization and its reset, and nothing without a number", () => {
    expect(claudeWindow({ utilization: 12.5, resets_at: "2026-09-23T14:40:00Z" })).toEqual({ percent: 12.5, resetsAt: Date.parse("2026-09-23T14:40:00Z") });
    expect(claudeWindow({ utilization: 0, resets_at: null })).toEqual({ percent: 0 });
    expect(claudeWindow({ utilization: null })).toBeUndefined();
    expect(claudeWindow(null)).toBeUndefined();
  });
});

describe("plan limits: Codex", () => {
  const tokenCount = (at: string, rateLimits: unknown) => JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: null, rate_limits: rateLimits } });

  test("the last token_count that carries a window: a week-long one is the weekly, a shorter one the session's", () => {
    const text = [
      tokenCount("2026-09-23T11:00:00Z", { limit_id: "codex", primary: { used_percent: 30, window_minutes: 300, resets_at: 1790000000 }, secondary: { used_percent: 12, window_minutes: 10080, resets_at: 1790400000 } }),
      JSON.stringify({ timestamp: "2026-09-23T11:05:00Z", type: "response_item", payload: { type: "message", role: "assistant", content: [] } }),
      tokenCount("2026-09-23T11:10:00Z", { limit_id: "codex", primary: null, secondary: null }),
      "",
    ].join("\n");
    expect(lastRolloutLimits(text)).toEqual({ at: Date.parse("2026-09-23T11:00:00Z"), session: { percent: 30, resetsAt: 1790000000_000 }, weekly: { percent: 12, resetsAt: 1790400000_000 } });
    // A plan with the weekly window alone, and the older form that counts to the reset.
    const weekly = tokenCount("2026-09-23T11:00:00Z", { primary: { used_percent: 1, window_minutes: 10080, resets_in_seconds: 60 }, secondary: null });
    expect(lastRolloutLimits(weekly)).toEqual({ at: Date.parse("2026-09-23T11:00:00Z"), weekly: { percent: 1, resetsAt: Date.parse("2026-09-23T11:01:00Z") } });
    expect(lastRolloutLimits("not json \"rate_limits\"\n")).toBeUndefined();
  });

  test("the newest row of the last two days' rollouts is read, whatever their times say, every minute", async () => {
    const home = join(dir, ".codex");
    const day = (y: string, m: string, d: string) => {
      const p = join(home, "sessions", y, m, d);
      mkdirSync(p, { recursive: true });
      return p;
    };
    const old = day("2026", "08", "31");
    const yesterday = day("2026", "09", "22");
    const today = day("2026", "09", "23");
    const row = (at: string, percent: number) => tokenCount(at, { primary: { used_percent: percent, window_minutes: 10080, resets_at: 1790400000 }, secondary: null }) + "\n";
    const write = (d: string, name: string, text: string, mtime: number) => {
      const path = join(d, name);
      writeFileSync(path, text);
      utimesSync(path, mtime / 1000, mtime / 1000);
      return path;
    };
    write(old, "rollout-2026-08-31T10-00-00-a.jsonl", row("2026-09-23T11:50:00Z", 90), T0 + 60_000);
    // A session started yesterday and still going wrote last, though its file kept the time it was made
    // (as Windows shows a rollout Codex keeps open); a month-old directory is not looked at.
    const long = write(yesterday, "rollout-2026-09-22T09-00-00-b.jsonl", row("2026-09-23T11:00:00Z", 7), T0 - 86_400_000);
    const short = write(today, "rollout-2026-09-23T08-00-00-c.jsonl", row("2026-09-23T10:00:00Z", 3), T0 - 60_000);
    expect(recentRollouts(home).map((r) => r.path).sort()).toEqual([long, short].sort());
    expect(recentRollouts(join(dir, "none"))).toEqual([]);
    const clock = { now: T0 };
    const limits = new PlanLimits({ profiles: () => [profile(CODEX, "codex", home)], log: silentLogger, now: () => clock.now });
    await limits.refresh();
    expect(limits.latest()![CODEX]).toEqual({ at: Date.parse("2026-09-23T11:00:00Z"), weekly: { percent: 7, resetsAt: 1790400000_000 } });
    // The other one grows: read again once the minute is up, its row now the newest.
    write(today, "rollout-2026-09-23T08-00-00-c.jsonl", row("2026-09-23T10:00:00Z", 3) + row("2026-09-23T11:30:00Z", 9), T0 - 60_000);
    await limits.refresh();
    expect(limits.latest()![CODEX]!.weekly!.percent).toBe(7);
    clock.now += 60_000;
    await limits.refresh();
    expect(limits.latest()![CODEX]!.weekly!.percent).toBe(9);
  });
});

describe("plan limits: Muse", () => {
  test("what its host last observed, read locally each minute; none before the login made a model call", async () => {
    const MUSE = "prof_01ARZ3NDEKTSV4RRFFQ69G5FBB";
    const muse: HarnessProfile = { id: MUSE, node: NODE, harness: "muse", name: "muse", configDir: dir, env: {}, origin: "discovered", status: "ok" };
    const asked: string[] = [];
    let reading: { at: number; session?: { percent: number }; weekly?: { percent: number } } | undefined;
    const clock = { now: T0 };
    const limits = new PlanLimits({
      profiles: () => [muse],
      log: silentLogger,
      now: () => clock.now,
      muse: async (id) => {
        asked.push(id);
        return reading;
      },
    });
    await limits.refresh();
    expect(limits.latest()).toBeUndefined();
    reading = { at: T0, session: { percent: 12 }, weekly: { percent: 3 } };
    await limits.refresh();
    expect(asked).toEqual([MUSE]);
    clock.now += 60_000;
    await limits.refresh();
    expect(asked).toEqual([MUSE, MUSE]);
    expect(limits.latest()).toEqual({ [MUSE]: { at: T0, session: { percent: 12 }, weekly: { percent: 3 } } });
  });
});
