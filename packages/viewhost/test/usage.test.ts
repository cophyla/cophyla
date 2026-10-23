// The settings' Usage page without a DOM: two machines' reports summed (groups by key, series by
// bucket and key, sessions side by side with their machine), the chart's fold to seven keys and
// Other with each key's colour kept across a filter, keys in words (two folders or accounts of
// one name told apart), the figures and what the numbers suggest past each threshold, the chips
// a click and a select leave, a machine from before the request left out in a note, an answer
// for filters since changed dropped, and the ranges' buckets.

import { describe, expect, test } from "bun:test";
import type { HarnessProfile, Node, UsageCell, UsageDimension, UsageGroup, UsagePoint, UsageReport, UsageSession } from "@cophyla/protocol";
import { agentLabel, bucketStarts, CONTEXT_COLORS, contextLabel, mergeReports, modelLabel, money, OTHER_COLOR, projectLabel, rangeSpan, SERIES_COLORS, share, tokenCount, UsageModel } from "../src/usage.ts";

const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const AGHA = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const NOW = new Date(2026, 9, 23, 14, 30).getTime();
const DAYS: readonly UsageDimension[] = ["account", "project", "session", "model", "agent", "trigger", "context"];

const cell = (cost: number, calls = 10): UsageCell => ({ cost, calls, tokens: { in: calls, out: calls * 100, cacheRead: calls * 200_000, cacheWrite: calls * 10_000, cacheWrite1h: calls * 3000 } });
const group = (key: string, cost: number, label?: string): UsageGroup => ({ key, ...(label ? { label } : {}), ...cell(cost) });

function report(node: string, o: Partial<Record<UsageDimension, UsageGroup[]>> & { series?: UsagePoint[]; sessions?: UsageSession[]; total?: number; previous?: number; sonnetSaves?: number; since?: number; filling?: boolean; costs?: UsageReport["costs"] } = {}): UsageReport {
  const groups = Object.fromEntries(DAYS.map((d) => [d, o[d] ?? []])) as Record<UsageDimension, UsageGroup[]>;
  return {
    node,
    from: 0,
    to: NOW,
    totals: cell(o.total ?? 100, 100),
    previous: cell(o.previous ?? 0, 0),
    split: "project",
    series: o.series ?? [],
    groups,
    sessions: o.sessions ?? [],
    ...(o.sonnetSaves !== undefined ? { sonnetSaves: o.sonnetSaves } : {}),
    ...(o.since !== undefined ? { since: o.since } : {}),
    ...(o.filling ? { filling: true } : {}),
    ...(o.costs ? { costs: o.costs } : {}),
  };
}

const session = (key: string, cost: number, extra: Partial<UsageSession> = {}): UsageSession => ({ key, harness: "claude", firstAt: NOW - 3_600_000, lastAt: NOW - 600_000, subCost: cost / 2, contextAvg: 250_000, ...cell(cost), ...extra });

const node = (id: string, name: string, status: Node["status"] = "online") => ({ id, name, status }) as unknown as Node;
const profile = (id: string, nodeId: string, name: string) => ({ id, node: nodeId, harness: "claude", name }) as unknown as HarnessProfile;

/** A fake node pair: what each answers `usage.report` with, and every request it was asked. */
function fake(answers: Record<string, (params: Record<string, unknown>) => Promise<UsageReport>>, nodes = [node(DESK, "Desk"), node(AGHA, "Agha")], profiles: HarnessProfile[] = []) {
  const asked: { method: string; params: Record<string, unknown> }[] = [];
  const request = async <T>(method: string, params: unknown): Promise<T> => {
    const p = (params ?? {}) as Record<string, unknown>;
    asked.push({ method, params: p });
    if (method === "node.list") return { nodes } as T;
    if (method === "profile.list") return { profiles } as T;
    if (method === "usage.report") return (await answers[p["node"] as string]!(p)) as T;
    throw new Error(`unknown method ${method}`);
  };
  let draws = 0;
  const model = new UsageModel(request, () => draws++, () => NOW);
  return { model, asked, draws: () => draws };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("usage: two machines' reports summed", () => {
  test("totals, groups by key, series by bucket and key, sessions with their machine, what Sonnet saves, history's start", () => {
    const day = new Date(2026, 9, 22).getTime();
    const merged = mergeReports(
      [
        { node: DESK, name: "Desk", report: report(DESK, { total: 70, previous: 50, model: [group("claude-opus-5-5", 60), group("claude-sonnet-5-5", 10)], project: [group("C:\\D\\Faircase", 70)], series: [{ at: day, key: "C:\\D\\Faircase", cost: 70 }], sessions: [session("sess_a", 70)], sonnetSaves: 5, since: 1000 }) },
        { node: AGHA, name: "Agha", report: report(AGHA, { total: 30, model: [group("claude-opus-5-5", 30)], project: [group("D:\\UnrealEngine", 30)], series: [{ at: day, key: "D:\\UnrealEngine", cost: 30 }], sessions: [session("sess_b", 30)], sonnetSaves: 2, since: 500, filling: true }) },
      ],
      { from: 0, to: NOW, bucket: "day" },
      "project",
    );
    expect(merged.totals.cost).toBe(100);
    expect(merged.totals.calls).toBe(200);
    expect(merged.previous.cost).toBe(50);
    expect(merged.groups.model.map((g) => [g.key, g.cost])).toEqual([["claude-opus-5-5", 90], ["claude-sonnet-5-5", 10]]);
    expect(merged.machines.map((m) => [m.key, m.label, m.cost])).toEqual([[DESK, "Desk", 70], [AGHA, "Agha", 30]]);
    expect(merged.sessions.map((s) => [s.key, s.node])).toEqual([["sess_a", DESK], ["sess_b", AGHA]]);
    expect(merged.series).toHaveLength(2);
    expect(merged.sonnetSaves).toBe(7);
    expect(merged.since).toBe(500);
    expect(merged.filling).toBe(true);
    expect([...merged.owners.project.get("D:\\UnrealEngine")!]).toEqual([AGHA]);
  });

  test("every online machine is asked, with the range, the split, the time zone and the filter; one from before the request is left out in a note", async () => {
    const { model, asked } = fake({
      [DESK]: async () => report(DESK, { total: 40, project: [group("C:\\D\\Faircase", 40)] }),
      [AGHA]: async () => {
        throw Object.assign(new Error("unknown method usage.report"), { code: "unknown_method" });
      },
    });
    await model.load();
    const reports = asked.filter((a) => a.method === "usage.report");
    // by name: Agha, then Desk
    expect(reports.map((a) => a.params["node"])).toEqual([AGHA, DESK]);
    expect(reports[1]!.params).toMatchObject({ bucket: "day", split: "project", from: new Date(2026, 9, 17).getTime(), to: NOW, tz: -new Date(NOW).getTimezoneOffset() });
    expect(reports[1]!.params["filter"]).toBeUndefined();
    expect(model.data?.totals.cost).toBe(40);
    expect(model.missing).toEqual([{ node: AGHA, name: "Agha", reason: "it needs the update" }]);
    expect(model.notes()[0]).toBe("Agha is left out: it needs the update.");
    expect(model.note).toBe("");
  });

  test("what the spend paid for is summed over the machines, and left out when one of them does not say", () => {
    const span = { from: 0, to: NOW, bucket: "day" as const };
    const a = report(DESK, { total: 70, costs: { in: 1, out: 9, cacheRead: 40, cacheWrite: 18, side: 2 } });
    const b = report(AGHA, { total: 30, costs: { in: 0, out: 3, cacheRead: 20, cacheWrite: 7, side: 0 } });
    expect(mergeReports([{ node: DESK, report: a }, { node: AGHA, report: b }], span, "project").costs).toEqual({ in: 1, out: 12, cacheRead: 60, cacheWrite: 25, side: 2 });
    expect(mergeReports([{ node: DESK, report: a }, { node: AGHA, report: report(AGHA, { total: 30 }) }], span, "project").costs).toBeUndefined();
  });

  test("a machine not linked is left out as not connected", async () => {
    const { model } = fake({ [DESK]: async () => report(DESK), [AGHA]: async () => { throw Object.assign(new Error(`node ${AGHA} is not linked`), { code: "unavailable" }); } });
    await model.load();
    expect(model.notes()[0]).toBe("Agha is left out: it is not connected.");
  });

  test("an offline machine is not asked; one picked is asked alone; none answering leaves why", async () => {
    const { model, asked } = fake({ [DESK]: async () => { throw new Error("link closed"); }, [AGHA]: async () => report(AGHA) }, [node(DESK, "Desk"), node(AGHA, "Agha", "offline")]);
    await model.load();
    expect(asked.filter((a) => a.method === "usage.report").map((a) => a.params["node"])).toEqual([DESK]);
    expect(model.data).toBeUndefined();
    expect(model.note).toBe("Desk could not be read: link closed.");
  });

  test("an answer for filters since changed is dropped", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    let calls = 0;
    const { model } = fake({ [DESK]: async () => (++calls === 1 ? (await slow, report(DESK, { total: 1 })) : report(DESK, { total: 2 })) }, [node(DESK, "Desk")]);
    const first = model.load();
    await settle();
    model.setRange("30d");
    await settle();
    release();
    await first;
    expect(model.data?.totals.cost).toBe(2);
    expect(model.range).toBe("30d");
  });
});

describe("usage: the chart", () => {
  const day = new Date(2026, 9, 21).getTime();
  const projects = (n: number) => Array.from({ length: n }, (_, i) => `C:\\D\\p${i}`);

  test("past eight keys: the seven that spent most, and Other with the rest; colours in their fixed order", async () => {
    const keys = projects(10);
    const { model } = fake({ [DESK]: async () => report(DESK, { project: keys.map((k, i) => group(k, 100 - i)), series: keys.map((k, i) => ({ at: day, key: k, cost: 100 - i })) }) }, [node(DESK, "Desk")]);
    await model.load();
    const view = model.series()!;
    expect(view.keys.map((k) => k.label)).toEqual(["p0", "p1", "p2", "p3", "p4", "p5", "p6", "Other"]);
    expect(view.keys.map((k) => k.color)).toEqual([...SERIES_COLORS.slice(0, 7), OTHER_COLOR]);
    expect(view.keys[7]!.total).toBe(93 + 92 + 91);
    expect(view.buckets).toHaveLength(7);
    const i = view.buckets.indexOf(day);
    expect(view.totals[i]).toBe(keys.reduce((a, _k, j) => a + 100 - j, 0));
    expect(view.max).toBe(view.totals[i]!);
  });

  test("a colour stays with its key across a filter; a key new to the chart takes the lowest slot free", async () => {
    let filtered = false;
    const { model } = fake({
      [DESK]: async (p) => {
        filtered = (p["filter"] as { model?: string[] } | undefined)?.model !== undefined;
        const series = filtered
          ? [{ at: day, key: "C:\\D\\b", cost: 5 }, { at: day, key: "C:\\D\\c", cost: 4 }, { at: day, key: "C:\\D\\new", cost: 3 }]
          : [{ at: day, key: "C:\\D\\a", cost: 9 }, { at: day, key: "C:\\D\\b", cost: 5 }, { at: day, key: "C:\\D\\c", cost: 4 }];
        return report(DESK, { series });
      },
    }, [node(DESK, "Desk")]);
    await model.load();
    const before = new Map(model.series()!.keys.map((k) => [k.key, k.color]));
    expect(before.get("C:\\D\\a")).toBe(SERIES_COLORS[0]);
    model.toggle("model", "claude-sonnet-5-5");
    await settle();
    expect(filtered).toBe(true);
    const after = new Map(model.series()!.keys.map((k) => [k.key, k.color]));
    expect(after.get("C:\\D\\b")).toBe(before.get("C:\\D\\b"));
    expect(after.get("C:\\D\\c")).toBe(before.get("C:\\D\\c"));
    expect(after.get("C:\\D\\new")).toBe(SERIES_COLORS[0]);
  });

  test("split by context: the buckets in their order, on the ordinal ramp", async () => {
    const { model } = fake({ [DESK]: async () => report(DESK, { series: [{ at: day, key: "4", cost: 9 }, { at: day, key: "0", cost: 1 }, { at: day, key: "2", cost: 5 }] }) }, [node(DESK, "Desk")]);
    model.split = "context";
    await model.load();
    const view = model.series()!;
    expect(view.keys.map((k) => [k.label, k.color])).toEqual([["Under 100K", CONTEXT_COLORS[0]], ["200K–300K", CONTEXT_COLORS[2]], ["Over 500K", CONTEXT_COLORS[4]]]);
  });

  test("the bar lists: six and the rest summed in a line, the context buckets in order, a filtered key marked", async () => {
    const keys = projects(9);
    const { model } = fake({ [DESK]: async () => report(DESK, { total: 450, project: keys.map((k, i) => group(k, 90 - i * 10)), context: [group("3", 300), group("0", 50), group("1", 100)] }) }, [node(DESK, "Desk")]);
    await model.load();
    const list = model.bars("project", "By project")!;
    expect(list.rows.map((r) => r.label)).toEqual(["p0", "p1", "p2", "p3", "p4", "p5"]);
    expect(list.rows[0]!.length).toBe(1);
    expect(list.rows[0]!.title).toBe("C:\\D\\p0");
    expect(list.rest).toEqual({ count: 3, cost: 30 + 20 + 10, share: share(60, 450) });
    const ctx = model.bars("context", "Context")!;
    expect(ctx.rows.map((r) => [r.label, r.color])).toEqual([["Under 100K", CONTEXT_COLORS[0]], ["100K–200K", CONTEXT_COLORS[1]], ["300K–500K", CONTEXT_COLORS[3]]]);
    model.toggle("project", "C:\\D\\p1");
    await settle();
    expect(model.bars("project", "By project")!.rows.find((r) => r.key === "C:\\D\\p1")!.active).toBe(true);
  });
});

describe("usage: keys in words", () => {
  test("models, who, what started it, context buckets, folders", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelLabel("claude-opus-5")).toBe("Opus 5");
    expect(modelLabel("gpt-5-codex")).toBe("gpt-5-codex");
    expect(agentLabel("main")).toBe("Main conversation");
    expect(agentLabel("sub:general-purpose")).toBe("Sub-agent: general-purpose");
    expect(agentLabel("side")).toBe("Claude's own calls");
    expect(contextLabel("0")).toBe("Under 100K");
    expect(contextLabel("3")).toBe("300K–500K");
    expect(contextLabel("4")).toBe("Over 500K");
    expect(projectLabel("C:\\D\\FarEastStudios\\far-east-client-portal")).toBe("far-east-client-portal");
    expect(projectLabel("/home/me/api/")).toBe("api");
    expect(projectLabel("")).toBe("No folder");
  });

  test("two folders or two accounts of one name, on two machines, take their machine's name; a session with none, its folder and id", async () => {
    const profiles = [profile("prof_1", DESK, "extra"), profile("prof_2", AGHA, "extra"), profile("prof_3", DESK, "default")];
    const { model } = fake(
      {
        [DESK]: async () => report(DESK, { project: [group("C:\\D\\UnrealEngine", 50)], account: [group("prof_1", 40, "extra"), group("prof_3", 10, "default")], sessions: [session("sess_01M5ABCDEF0123456789XYZW", 50, { project: "C:\\D\\UnrealEngine" })] }),
        [AGHA]: async () => report(AGHA, { project: [group("D:\\UnrealEngine", 30)], account: [group("prof_2", 30, "extra")] }),
      },
      undefined,
      profiles,
    );
    await model.load();
    expect(model.label("project", "C:\\D\\UnrealEngine")).toBe("UnrealEngine (Desk)");
    expect(model.label("project", "D:\\UnrealEngine")).toBe("UnrealEngine (Agha)");
    expect(model.label("account", "prof_1")).toBe("extra (Desk)");
    expect(model.label("account", "prof_3")).toBe("default");
    expect(model.label("account", "")).toBe("Unknown account");
    expect(model.label("session", "sess_01M5ABCDEF0123456789XYZW")).toBe("UnrealEngine · 89xyzw");
    expect(model.label("machine", AGHA)).toBe("Agha");
    // one machine picked: its own names need no machine
    model.setMachine(DESK);
    await settle();
    expect(model.label("account", "prof_1")).toBe("extra");
  });
});

describe("usage: figures and what they suggest", () => {
  const cut = (total: number, o: { typed?: number; sub?: number; side?: number; big?: number; peer?: number; monitor?: number; task?: number; saves?: number; previous?: number }) =>
    report(DESK, {
      total,
      previous: o.previous ?? 0,
      trigger: [group("typed", o.typed ?? 0), group("peer", o.peer ?? 0), group("monitor", o.monitor ?? 0), group("task", o.task ?? 0)].filter((g) => g.cost > 0),
      agent: [group("main", total - (o.sub ?? 0) - (o.side ?? 0)), group("sub:general-purpose", o.sub ?? 0), group("side", o.side ?? 0)].filter((g) => g.cost > 0),
      context: [group("1", total - (o.big ?? 0)), group("3", (o.big ?? 0) / 2), group("4", (o.big ?? 0) / 2)].filter((g) => g.cost > 0),
      ...(o.saves !== undefined ? { sonnetSaves: o.saves } : {}),
    });

  test("spent with its change on the span before, the share you started, the sub-agents', the average context and the share past 300K", async () => {
    const { model } = fake({ [DESK]: async () => cut(1000, { typed: 190, sub: 470, big: 400, previous: 800 }) }, [node(DESK, "Desk")]);
    await model.load();
    const k = model.kpis();
    expect(k.map((x) => [x.id, x.value])).toEqual([["spend", "$1,000"], ["typed", "19%"], ["sub", "47%"], ["context", "210K"], ["big", "40%"]]);
    expect(k[0]!.delta).toEqual({ text: "▲ 25% vs the 7 days before", up: true });
  });

  test("with what the spend paid for, re-reading the context takes the average context's tile; a change is shown only on a span the ledger holds whole", async () => {
    let since: number | undefined = new Date(2026, 8, 1).getTime();
    const { model } = fake({ [DESK]: async () => ({ ...cut(1000, { typed: 190, sub: 470, big: 400, previous: 800 }), costs: { in: 1, out: 100, cacheRead: 600, cacheWrite: 290, side: 9 }, ...(since !== undefined ? { since } : {}) }) }, [node(DESK, "Desk")]);
    await model.load();
    const k = model.kpis();
    expect(k.map((x) => [x.id, x.value])).toEqual([["spend", "$1,000"], ["reread", "60%"], ["typed", "19%"], ["sub", "47%"], ["big", "40%"]]);
    expect(k[0]!.delta?.up).toBe(true);
    expect(model.suggestions().find((x) => x.id === "context")!.text).toStartWith("Re-reading the conversation on every call was $600 (60%) of this spend.");
    // history began inside the span before: no change
    since = new Date(2026, 9, 14).getTime();
    await model.load();
    expect(model.kpis()[0]!.delta).toBeUndefined();
  });

  test("each suggestion only past its threshold, the biggest first", async () => {
    let next = cut(1000, { saves: 20, big: 100, peer: 50, monitor: 40, task: 50, side: 40 });
    const { model } = fake({ [DESK]: async () => next }, [node(DESK, "Desk")]);
    await model.load();
    expect(model.suggestions()).toEqual([]);
    next = cut(1000, { saves: 120, big: 400, peer: 150, monitor: 100, task: 50, side: 60 });
    await model.load();
    const s = model.suggestions();
    expect(s.map((x) => x.id)).toEqual(["context", "woken", "sonnet", "side"]);
    expect(s[0]!.text).toContain("$400 (40%)");
    expect(s[0]!.text).toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW=300k");
    expect(s[1]!.text).toContain("other agents' messages (15%), Monitor events (10%) and background tasks finishing (5%)");
    // a part under 1% is left out of the sentence, not the sum
    next = cut(1000, { peer: 200, monitor: 5 });
    await model.load();
    const woken = model.suggestions().find((x) => x.id === "woken")!;
    expect(woken.text).toStartWith("$205 (21%) went on turns nobody typed: other agents' messages (20%).");
    expect(s[2]!.text).toContain("$120 less, 12%");
    expect(s[2]!.text).toContain("CLAUDE_CODE_SUBAGENT_MODEL=sonnet");
  });
});

describe("usage: filters", () => {
  test("a click adds its key as a chip and a second click lets it go; a select keeps one; a machine picked drops its own keys", async () => {
    const { model, asked } = fake({ [DESK]: async () => report(DESK, { model: [group("claude-opus-5-5", 90)] }), [AGHA]: async () => report(AGHA) });
    await model.load();
    model.toggle("model", "claude-opus-5-5");
    model.toggle("trigger", "peer");
    model.toggle("trigger", "monitor");
    await settle();
    expect(model.chips().map((c) => c.text)).toEqual(["Model: Opus 5.5", "Started by: Another agent's message", "Started by: Monitor event"]);
    expect(asked.filter((a) => a.method === "usage.report").at(-1)!.params["filter"]).toEqual({ model: ["claude-opus-5-5"], trigger: ["peer", "monitor"] });
    model.toggle("trigger", "peer");
    model.pick("project", "C:\\D\\Faircase");
    model.pick("project", "C:\\D\\orchestrator");
    await settle();
    expect(model.filterParam()).toEqual({ model: ["claude-opus-5-5"], trigger: ["monitor"], project: ["C:\\D\\orchestrator"] });
    model.setMachine(AGHA);
    await settle();
    expect(model.filterParam()).toEqual({ model: ["claude-opus-5-5"], trigger: ["monitor"] });
    expect(asked.filter((a) => a.method === "usage.report").at(-1)!.params["node"]).toBe(AGHA);
    model.unfilter("trigger", "monitor");
    model.clearFilters();
    await settle();
    expect(model.chips()).toEqual([]);
    expect(model.filterParam()).toBeUndefined();
  });

  test("history starting inside the range, and history still filling, are said", async () => {
    const { model } = fake({ [DESK]: async () => report(DESK, { since: new Date(2026, 9, 20, 9).getTime(), filling: true }) }, [node(DESK, "Desk")]);
    await model.load();
    const notes = model.notes("en-GB");
    expect(notes[0]).toContain("Still reading the transcripts");
    expect(notes[1]).toBe("History starts 20 October: nothing before it was recorded.");
  });
});

describe("usage: ranges and numbers", () => {
  test("today in hours from midnight, the rest in local days back to midnight", () => {
    expect(rangeSpan("today", NOW)).toEqual({ from: new Date(2026, 9, 23).getTime(), to: NOW, bucket: "hour" });
    expect(rangeSpan("30d", NOW).from).toBe(new Date(2026, 8, 24).getTime());
    expect(bucketStarts(new Date(2026, 9, 23).getTime(), NOW, "hour")).toHaveLength(24);
    const days = bucketStarts(new Date(2026, 9, 17).getTime(), NOW, "day");
    expect(days).toHaveLength(7);
    expect(days[6]).toBe(new Date(2026, 9, 23).getTime());
  });

  test("dollars, shares and tokens", () => {
    expect(money(4327.4)).toBe("$4,327");
    expect(money(42.1)).toBe("$42.10");
    expect(money(0.004)).toBe("<$0.01");
    expect(money(0)).toBe("$0");
    expect(share(47, 100)).toBe("47%");
    expect(share(4.25, 100)).toBe("4.3%");
    expect(share(0.01, 100)).toBe("<0.1%");
    expect(share(1, 0)).toBe("0%");
    expect(tokenCount(271_400)).toBe("271K");
    expect(tokenCount(13_150_000_000)).toBe("13B");
    expect(tokenCount(1_250_000)).toBe("1.3M");
  });
});
