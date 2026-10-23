// The spend ledger: a pass's calls summed into hour cells and priced, written with the marks
// they reach; the report over it: totals and the span before, every dimension's groups with
// the names the node knows, the series in hours or local days with the split's tail summed as
// `other`, the sessions' lines, a filter on any dimension, the scope's folders left out, the
// Sonnet what-if for the sub-agents, and the hours past the retention dropped.

import { describe, expect, test } from "bun:test";
import type { HarnessProfile, SessionScope } from "@cophyla/protocol";
import { Store } from "../src/store/index.ts";
import type { SpendConversation } from "../src/store/index.ts";
import { contextBucket, spendRows, SpendLedger } from "../src/usage/ledger.ts";
import type { SpendCall } from "../src/usage/ledger.ts";

const H = 3_600_000;
const DAY = 86_400_000;
// 2026-10-20T00:00Z, a Tuesday.
const T0 = Date.parse("2026-10-20T00:00:00.000Z");
const PRICES: Record<string, number[]> = { "claude-opus-5-5": [4, 20, 0.2, 5, 8], "claude-sonnet-5-5": [2, 10, 0.2, 2.5, 4] };
const price = (model: string, t: { in: number; out: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number }): number | undefined => {
  const p = PRICES[model];
  return p ? (t.in * p[0]! + t.out * p[1]! + t.cacheRead * p[2]! + (t.cacheWrite - t.cacheWrite1h) * p[3]! + t.cacheWrite1h * p[4]!) / 1e6 : undefined;
};
const tokens = (o: Partial<SpendCall["tokens"]> = {}): SpendCall["tokens"] => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, ...o });
const call = (at: number, model: string, o: Partial<SpendCall> = {}, t: Partial<SpendCall["tokens"]> = {}): SpendCall => ({ at, model, agent: "main", trigger: "typed", context: 0, first: true, tokens: tokens(t), ...o });

describe("spend rows", () => {
  test("calls sum into hour cells, priced; a later row's output adds no call; a failed reply's stand-in counts nothing; side spend is a cost already", () => {
    const rows = spendRows(
      [
        call(T0 + 10 * 60_000, "claude-opus-5-5", { context: 150_000 }, { in: 10, out: 100, cacheRead: 150_000 }),
        call(T0 + 50 * 60_000, "claude-opus-5-5", { context: 150_500, first: false }, { out: 400 }),
        call(T0 + 70 * 60_000, "claude-opus-5-5", { context: 40_000 }, { in: 5, out: 10, cacheRead: 40_000 }),
        call(T0 + 5 * 60_000, "<synthetic>", {}, { out: 0 }),
      ],
      [{ at: T0 + 20 * 60_000, model: "claude-opus-5-5", cost: 0.75, tokens: { in: 500, out: 0, cacheRead: 9000, cacheWrite: 0 } }],
      price,
    );
    const byKey = new Map(rows.map((r) => [`${r.hour}|${r.agent}|${r.context}`, r]));
    expect(rows).toHaveLength(3);
    const big = byKey.get(`${T0}|main|1`)!;
    expect(big.calls).toBe(1);
    expect(big.out).toBe(500);
    expect(big.cost).toBeCloseTo((10 * 4 + 500 * 20 + 150_000 * 0.2) / 1e6, 9);
    expect(byKey.get(`${T0 + H}|main|0`)!.calls).toBe(1);
    const side = byKey.get(`${T0}|side|0`)!;
    expect(side).toMatchObject({ trigger: "side", calls: 0, cost: 0.75, in: 500, cacheRead: 9000 });
  });

  test("context buckets: under 100K, to 200K, to 300K, to 500K, past it", () => {
    expect([0, 99_999, 100_000, 199_999, 200_000, 300_000, 499_999, 500_000, 2_000_000].map(contextBucket)).toEqual([0, 0, 1, 1, 2, 3, 3, 4, 4]);
  });
});

function rig(o: { scope?: SessionScope; retentionDays?: number; now?: number } = {}) {
  const store = new Store(":memory:");
  store.migrate();
  const profiles: HarnessProfile[] = [{ id: "prof_home", node: "node_a", harness: "claude", name: "home", configDir: "/c", env: {}, origin: "discovered", status: "ok" } as HarnessProfile];
  const ledger = new SpendLedger({
    store,
    price,
    retentionDays: o.retentionDays ?? 90,
    now: () => o.now ?? T0 + 3 * DAY,
    profiles: () => profiles,
    sessionName: (id) => (id === "sess_one" ? "lightning" : undefined),
    ...(o.scope ? { scope: () => o.scope! } : {}),
    platform: "linux",
  });
  const conv = (conversation: string, o2: Partial<SpendConversation> = {}): SpendConversation => ({ conversation, harness: "claude", profile: "", cwd: "", firstAt: T0, lastAt: T0, ...o2 });
  return { store, ledger, conv };
}

const params = (o: Record<string, unknown> = {}) => ({ node: "node_a", from: T0, to: T0 + 2 * DAY, bucket: "day" as const, tz: 0, split: "model" as const, ...o });

describe("spend ledger", () => {
  test("a pass is written with its marks; marks read back; the conversation's line keeps what a later pass leaves out", () => {
    const { store, ledger, conv } = rig();
    expect(ledger.marks(["claude:a"]).size).toBe(0);
    ledger.commit({ conversation: conv("claude:a", { session: "sess_one", profile: "prof_home", cwd: "/w/faircase", title: "lightning" }), calls: [call(T0 + H, "claude-opus-5-5", {}, { out: 1000 })], side: [], marks: new Map([["claude:a", 4096], ["claude:a/agent-x.jsonl", 100]]) });
    ledger.commit({ conversation: conv("claude:a"), calls: [call(T0 + 2 * H, "claude-opus-5-5", {}, { out: 1000 })], side: [], marks: new Map([["claude:a", 8192]]) });
    expect([...ledger.marks(["claude:a", "claude:a/agent-x.jsonl", "claude:b"])]).toEqual([["claude:a", 8192], ["claude:a/agent-x.jsonl", 100]]);
    const c = store.spend.conversations()[0]!;
    expect(c).toMatchObject({ session: "sess_one", profile: "prof_home", cwd: "/w/faircase", title: "lightning", firstAt: T0, lastAt: T0 + 2 * H });
    expect(store.spend.total({ from: 0, to: T0 + DAY, filter: {}, hidden: [] })).toMatchObject({ calls: 2, out: 2000, cost: 0.04 });
  });

  test("the report: totals, the span before, groups named, the series by local day, sessions, a filter, the Sonnet what-if", () => {
    const { ledger, conv } = rig();
    // Before the range: what the span before spent.
    ledger.commit({ conversation: conv("claude:old", { cwd: "/w/old" }), calls: [call(T0 - DAY + H, "claude-opus-5-5", {}, { out: 5000 })], side: [], marks: new Map() });
    // A session Cophyla tracked, on account home: main on Opus, a sub-agent on Opus and one on Sonnet.
    ledger.commit({
      conversation: conv("claude:a", { session: "sess_one", profile: "prof_home", cwd: "/w/faircase", title: "fallback title" }),
      calls: [
        call(T0 + 22 * H, "claude-opus-5-5", { context: 350_000 }, { in: 10, out: 1000, cacheRead: 350_000 }),
        call(T0 + 23 * H, "claude-opus-5-5", { agent: "sub:general-purpose", trigger: "task", context: 120_000 }, { out: 2000, cacheRead: 120_000 }),
        call(T0 + 25 * H, "claude-sonnet-5-5", { agent: "sub:Explore", trigger: "peer" }, { out: 500 }),
      ],
      side: [{ at: T0 + 26 * H, model: "claude-opus-5-5", cost: 0.1, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } }],
      marks: new Map(),
    });
    // A conversation no session tracked, account unknown.
    ledger.commit({ conversation: conv("claude:b", { cwd: "/w/unreal", title: "berry" }), calls: [call(T0 + 30 * H, "claude-opus-5-5", { trigger: "monitor" }, { out: 3000 })], side: [], marks: new Map() });
    const r = ledger.report(params({ tz: 180 }), "node_a");
    const opusMain = (10 * 4 + 1000 * 20 + 350_000 * 0.2) / 1e6;
    const opusSub = (2000 * 20 + 120_000 * 0.2) / 1e6;
    const sonnetSub = (500 * 10) / 1e6;
    const unreal = (3000 * 20) / 1e6;
    expect(r.totals.cost).toBeCloseTo(opusMain + opusSub + sonnetSub + 0.1 + unreal, 6);
    expect(r.totals.calls).toBe(4);
    expect(r.previous.cost).toBeCloseTo(0.1, 6);
    expect(r.groups.account.map((g) => [g.key, g.label])).toEqual([["prof_home", "home"], ["", undefined]]);
    expect(r.groups.session.map((g) => [g.key, g.label])).toEqual([["sess_one", "lightning"], ["claude:b", "berry"]]);
    expect(r.groups.agent.map((g) => g.key).sort()).toEqual(["main", "side", "sub:Explore", "sub:general-purpose"]);
    expect(r.groups.trigger.find((g) => g.key === "monitor")!.cost).toBeCloseTo(unreal, 6);
    expect(r.groups.context.map((g) => g.key).sort()).toEqual(["0", "1", "3"]);
    // Days start at local midnight three hours east of UTC: 21:00Z, so 22:00Z on is the next day.
    expect([...new Set(r.series.map((p) => p.at))].sort()).toEqual([T0 + 21 * H]);
    expect([...new Set(ledger.report(params({ tz: 0 }), "node_a").series.map((p) => p.at))].sort()).toEqual([T0, T0 + DAY]);
    const day2 = r.series.filter((p) => p.at === T0 + 21 * H);
    expect(day2.map((p) => p.key).sort()).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    const s1 = r.sessions[0]!;
    expect(s1).toMatchObject({ key: "sess_one", label: "lightning", harness: "claude", project: "/w/faircase", account: "prof_home" });
    expect(s1.subCost).toBeCloseTo(opusSub + sonnetSub, 6);
    expect(s1.contextAvg).toBe(Math.round((10 + 350_000 + 120_000) / 3));
    expect(r.sessions[1]).toMatchObject({ key: "claude:b", label: "berry" });
    expect(r.sonnetSaves).toBeCloseTo(opusSub - (2000 * 10 + 120_000 * 0.2) / 1e6, 2);
    // What it was spent on, adding up to the total.
    const c = r.costs!;
    expect(c.cacheRead).toBeCloseTo((350_000 + 120_000) * 0.2 / 1e6, 6);
    expect(c.side).toBeCloseTo(0.1, 6);
    expect(c.in + c.out + c.cacheRead + c.cacheWrite + c.side).toBeCloseTo(r.totals.cost, 6);
    expect(r.since).toBe(T0 - DAY + H - ((T0 - DAY + H) % H));
    // A filter: the model alone, everywhere.
    const f = ledger.report(params({ filter: { model: ["claude-sonnet-5-5"] } }), "node_a");
    expect(f.totals.cost).toBeCloseTo(sonnetSub, 6);
    expect(f.groups.project.map((g) => g.key)).toEqual(["/w/faircase"]);
    expect(f.sonnetSaves).toBeUndefined();
    // Two dimensions: AND.
    expect(ledger.report(params({ filter: { model: ["claude-opus-5-5"], trigger: ["monitor", "task"] } }), "node_a").totals.cost).toBeCloseTo(opusSub + unreal, 6);
    // By the hour.
    expect(ledger.report(params({ bucket: "hour", from: T0 + 22 * H, to: T0 + 24 * H }), "node_a").series.map((p) => p.at).sort()).toEqual([T0 + 22 * H, T0 + 23 * H]);
  });

  test("a split of more than twelve keys keeps the twelve that spent most and sums the rest as other", () => {
    const { ledger, conv } = rig();
    for (let i = 0; i < 15; i++) ledger.commit({ conversation: conv(`claude:c${i}`, { cwd: `/w/p${i}` }), calls: [call(T0 + H, "claude-opus-5-5", {}, { out: 1000 * (i + 1) })], side: [], marks: new Map() });
    const r = ledger.report(params({ split: "project" }), "node_a");
    const keys = r.series.map((p) => p.key);
    expect(keys).toHaveLength(13);
    expect(keys).toContain("other");
    expect(keys).not.toContain("/w/p0");
    expect(r.series.find((p) => p.key === "other")!.cost).toBeCloseTo(((1000 + 2000 + 3000) * 20) / 1e6, 6);
  });

  test("the scope's hidden folders and switched-off accounts are left out of every report", () => {
    const { ledger, conv } = rig({ scope: { profilesOff: ["prof_off"], tetherOnly: false, allowedFolders: [], hiddenFolders: ["/w/secret"] } });
    ledger.commit({ conversation: conv("claude:a", { cwd: "/w/secret/inner" }), calls: [call(T0 + H, "claude-opus-5-5", {}, { out: 1000 })], side: [], marks: new Map() });
    ledger.commit({ conversation: conv("claude:b", { cwd: "/w/open", profile: "prof_off" }), calls: [call(T0 + H, "claude-opus-5-5", {}, { out: 1000 })], side: [], marks: new Map() });
    ledger.commit({ conversation: conv("claude:c", { cwd: "/w/open" }), calls: [call(T0 + H, "claude-opus-5-5", {}, { out: 2000 })], side: [], marks: new Map() });
    const r = ledger.report(params(), "node_a");
    expect(r.totals.cost).toBeCloseTo(0.04, 6);
    expect(r.sessions.map((s) => s.key)).toEqual(["claude:c"]);
  });

  test("hours past the retention go, with the conversations left with none; the marks stay", () => {
    const { store, ledger, conv } = rig({ retentionDays: 1, now: T0 + 2 * DAY });
    ledger.commit({ conversation: conv("claude:old", { firstAt: T0, lastAt: T0 }), calls: [call(T0, "claude-opus-5-5", {}, { out: 1 })], side: [], marks: new Map([["claude:old", 10]]) });
    ledger.commit({ conversation: conv("claude:new", { firstAt: T0 + 2 * DAY - H, lastAt: T0 + 2 * DAY - H }), calls: [call(T0 + 2 * DAY - H, "claude-opus-5-5", {}, { out: 1 })], side: [], marks: new Map() });
    expect(ledger.prune()).toBe(1);
    expect(store.spend.conversations().map((c) => c.conversation)).toEqual(["claude:new"]);
    expect(ledger.marks(["claude:old"]).get("claude:old")).toBe(10);
  });
});

describe("usage.report", () => {
  test("answers for this node from its ledger; another node's is not here, a range that ends first is refused, no ledger is unsupported", async () => {
    const { metricsMethods } = await import("../src/api/methods.ts");
    const { ledger, conv } = rig();
    ledger.commit({ conversation: conv("claude:a"), calls: [call(T0 + H, "claude-opus-5-5", {}, { out: 1000 })], side: [], marks: new Map() });
    const table = metricsMethods({ metrics: {} as never, ledger, nodeId: "node_a" });
    const handler = table["usage.report"]!.handler as (p: unknown, ctx: unknown) => unknown;
    expect((handler(params(), {}) as { totals: { cost: number } }).totals.cost).toBeCloseTo(0.02, 6);
    expect(() => handler(params({ node: "node_b" }), {})).toThrow(/not linked/);
    expect(() => handler(params({ to: T0 }), {})).toThrow(/ends before/);
    const bare = metricsMethods({ metrics: {} as never })["usage.report"]!.handler as (p: unknown, ctx: unknown) => unknown;
    expect(() => bare(params(), {})).toThrow(/no spend ledger/);
  });
});
