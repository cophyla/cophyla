// The Claude adapter feeding the spend ledger: each call counted past the ledger's marks, with
// who made it and what started its turn (a typed prompt, a background task's notice, a
// Monitor's event), a sub-agent's calls under the turn that launched it, a reply's later rows
// adding their output alone, Claude's cost record adding side spend, and a daemon started
// again on the same transcripts counting nothing twice; then the backfill's reader over
// transcripts no session reads live: past its marks only, a copy of history counted once,
// the last cost record's side spend, the run skipping what has not grown and what is claimed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaudeAdapter } from "../src/sessions/claude/adapter.ts";
import { transcriptPathFor } from "../src/sessions/claude/registry.ts";
import { Store } from "../src/store/index.ts";
import { SpendBackfill } from "../src/usage/backfill.ts";
import { readConversation, run } from "../src/usage/backfill-worker.ts";
import type { BackfillMessage } from "../src/usage/backfill-worker.ts";
import { SpendLedger } from "../src/usage/ledger.ts";
import type { SideSpend, SpendCall, SpendPass, SpendSink } from "../src/usage/ledger.ts";
import { clearRegistry, miniSessions, tempHome, tomlString, writeRegistry } from "./helpers.ts";
import type { Mini } from "./helpers.ts";

const PRICES: Record<string, number[]> = { "claude-opus-5-5": [4, 20, 0.2, 5, 8], "claude-sonnet-5-5": [2, 10, 0.2, 2.5, 4] };
const price = (model: string, t: { in: number; out: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number }): number | undefined => {
  const p = PRICES[model];
  return p ? (t.in * p[0]! + t.out * p[1]! + t.cacheRead * p[2]! + (t.cacheWrite - t.cacheWrite1h) * p[3]! + t.cacheWrite1h * p[4]!) / 1e6 : undefined;
};

/** A ledger in memory: what was committed, and the marks, kept across adapters as the store keeps them. */
class MemorySink implements SpendSink {
  marksKept = new Map<string, number>();
  calls: SpendCall[] = [];
  side: SideSpend[] = [];
  passes: SpendPass[] = [];
  claimed = new Set<string>();
  marks(keys: string[]): Map<string, number> {
    return new Map(keys.filter((k) => this.marksKept.has(k)).map((k) => [k, this.marksKept.get(k)!]));
  }
  claim(c: string): void {
    this.claimed.add(c);
  }
  commit(pass: SpendPass): void {
    this.passes.push(pass);
    this.calls.push(...pass.calls);
    this.side.push(...pass.side);
    for (const [k, v] of pass.marks) this.marksKept.set(k, v);
  }
}

let clock = Date.parse("2026-10-23T05:00:00.000Z");
const ts = (): string => new Date(clock).toISOString();
const user = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "user", timestamp: ts(), message: { role: "user", content: text }, ...extra });
const reply = (id: string, model: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "assistant", timestamp: ts(), message: { id, model, role: "assistant", content: [{ type: "text", text: `${id} says hi` }], usage }, ...extra });
const launch = (agentId: string) => JSON.stringify({ type: "user", timestamp: ts(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${agentId}`, content: "Async agent launched" }] }, toolUseResult: { isAsync: true, agentId } });
const notice = (monitor: boolean) =>
  JSON.stringify({ type: "user", timestamp: ts(), origin: { kind: "task-notification" }, message: { role: "user", content: monitor ? "<task-notification>\n<summary>Monitor \"ci\" stream ended</summary>\n<event>DONE</event>" : "<task-notification>\n<status>completed</status>" } });
const record = (total: number) => JSON.stringify({ type: "cost-state", sessionId: "x", totalCostUSD: total, modelUsage: {} });

describe("the claude adapter feeds the spend ledger", () => {
  let profileDir: string;
  let registry: string;
  let cwd: string;
  const sink = new MemorySink();
  const alive = new Set([700]);
  let mini: Mini | undefined;

  const start = async (): Promise<Mini> =>
    miniSessions(
      `[sessions]\ndiscover = false\ninstall_hooks = false\npoll_ms = 100000\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(profileDir)}\n`,
      (host, log) => [new ClaudeAdapter({ host, log, isAlive: (pid) => alive.has(pid), sharedSettings: join(profileDir, "none.json"), price, ledger: sink })],
      { deps: { now: () => clock } },
    );

  beforeAll(async () => {
    const scratch = tempHome();
    profileDir = join(scratch, "claude-profile");
    registry = join(profileDir, "sessions");
    cwd = join(scratch, "work");
    mkdirSync(registry, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    mini = await start();
  });
  afterAll(() => mini?.stop());

  test("each call with who made it and what started its turn; a sub-agent's under the turn that launched it", async () => {
    writeRegistry(registry, { pid: 700, sessionId: "sess-feed", cwd });
    const path = transcriptPathFor(profileDir, cwd, "sess-feed");
    const subs = join(path.replace(/\.jsonl$/, ""), "subagents");
    mkdirSync(subs, { recursive: true });
    writeFileSync(
      path,
      [
        user("build the thing"),
        reply("msg_1", "claude-opus-5-5", { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 150_000 }),
        launch("a1"),
        notice(false),
        reply("msg_2", "claude-opus-5-5", { input_tokens: 5, output_tokens: 50 }),
        notice(true),
        reply("msg_3", "claude-opus-5-5", { input_tokens: 5, output_tokens: 20 }),
      ].join("\n") + "\n",
    );
    writeFileSync(join(subs, "agent-a1.jsonl"), reply("msg_s1", "claude-sonnet-5-5", { input_tokens: 7, output_tokens: 70 }, { isSidechain: true }) + "\n");
    writeFileSync(join(subs, "agent-a1.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "build" }));
    await mini!.sessions.tick();
    const seen = sink.calls.map((c) => `${c.model}|${c.agent}|${c.trigger}|${c.first}|${c.tokens.out}`);
    expect(seen).toEqual([
      "claude-opus-5-5|main|typed|true|100",
      "claude-opus-5-5|main|task|true|50",
      "claude-opus-5-5|main|monitor|true|20",
      "claude-sonnet-5-5|sub:general-purpose|typed|true|70",
    ]);
    expect(sink.calls[0]!.context).toBe(150_010);
    expect(sink.claimed.has("claude:sess-feed")).toBe(true);
    const pass = sink.passes.at(-1)!;
    expect(pass.conversation).toMatchObject({ conversation: "claude:sess-feed", harness: "claude", cwd });
    expect([...sink.marksKept.keys()].sort()).toEqual(["claude:sess-feed", "claude:sess-feed/agent-a1.jsonl"]);
  });

  test("a reply's later row adds its output alone; Claude's cost record adds what it holds beyond as side spend", async () => {
    const path = transcriptPathFor(profileDir, cwd, "sess-feed");
    const before = sink.calls.length;
    appendFileSync(path, reply("msg_3", "claude-opus-5-5", { input_tokens: 5, output_tokens: 220 }) + "\n");
    clock += 1000;
    await mini!.sessions.tick();
    expect(sink.calls.slice(before).map((c) => `${c.trigger}|${c.first}|${c.tokens.out}|${c.context}`)).toEqual(["monitor|false|200|5"]);
    const counted = (10 * 4 + 100 * 20 + 150_000 * 0.2 + 5 * 4 + 50 * 20 + 5 * 4 + 220 * 20) / 1e6 + (7 * 2 + 70 * 10) / 1e6;
    appendFileSync(path, record(counted + 0.25) + "\n");
    clock += 1000;
    await mini!.sessions.tick();
    expect(sink.side).toHaveLength(1);
    expect(sink.side[0]!.cost).toBeCloseTo(0.25, 6);
    expect(sink.side[0]!.model).toBe("claude-opus-5-5");
  });

  test("a daemon started again on the same transcripts counts nothing twice, and what comes after once", async () => {
    mini!.stop();
    const before = sink.calls.length;
    const sideBefore = sink.side.length;
    mini = await start();
    clock += 1000;
    await mini.sessions.tick();
    expect(sink.calls.length).toBe(before);
    expect(sink.side.length).toBe(sideBefore);
    const path = transcriptPathFor(profileDir, cwd, "sess-feed");
    appendFileSync(path, user("one more") + "\n" + reply("msg_4", "claude-opus-5-5", { input_tokens: 1, output_tokens: 9 }) + "\n");
    clock += 1000;
    await mini.sessions.tick();
    expect(sink.calls.slice(before).map((c) => `${c.trigger}|${c.tokens.out}`)).toEqual(["typed|9"]);
    alive.delete(700);
    clearRegistry(registry, 700);
  });
});

describe("the spend backfill", () => {
  const home = tempHome();
  const claudeDir = join(home, "claude");
  const project = join(claudeDir, "projects", "C--w-faircase");
  mkdirSync(project, { recursive: true });
  const main = join(project, "conv-a.jsonl");
  const subs = join(project, "conv-a", "subagents");
  mkdirSync(subs, { recursive: true });
  const at = (h: number) => new Date(Date.parse("2026-10-21T10:00:00.000Z") + h * 3_600_000).toISOString();
  const row = (o: Record<string, unknown>) => JSON.stringify({ cwd: "C:\\w\\faircase", sessionId: "conv-a", ...o });
  writeFileSync(
    main,
    [
      JSON.stringify({ type: "custom-title", customTitle: "lightning", sessionId: "conv-a" }),
      row({ type: "user", timestamp: at(0), message: { role: "user", content: "fix it" } }),
      row({ type: "assistant", timestamp: at(0), message: { id: "msg_a1", model: "claude-opus-5-5", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 1000 } } }),
      row({ type: "user", timestamp: at(0), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "launched" }] }, toolUseResult: { agentId: "b7" } }),
      row({ type: "user", timestamp: at(1), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "x".repeat(70_000) }] } }),
      row({ type: "user", timestamp: at(1), origin: { kind: "peer", from: "api" }, message: { role: "user", content: "<cophyla-message>hi</cophyla-message>" } }),
      row({ type: "assistant", timestamp: at(1), message: { id: "msg_a2", model: "claude-opus-5-5", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 500 } } }),
      JSON.stringify({ type: "cost-state", sessionId: "conv-a", totalCostUSD: 0.03 + 0.4, modelUsage: {} }),
    ].join("\n") + "\n",
  );
  writeFileSync(join(subs, "agent-b7.jsonl"), row({ type: "assistant", isSidechain: true, timestamp: at(0), message: { id: "msg_b1", model: "claude-sonnet-5-5", role: "assistant", content: [], usage: { input_tokens: 0, output_tokens: 1000 } } }) + "\n");
  writeFileSync(join(subs, "agent-b7.meta.json"), JSON.stringify({ agentType: "Explore" }));
  // A job forked from it: its copy of msg_a1, then its own.
  const job = join(project, "conv-b.jsonl");
  writeFileSync(
    job,
    [
      row({ type: "assistant", sessionId: "conv-b", timestamp: at(0), message: { id: "msg_a1", model: "claude-opus-5-5", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 1000 } } }),
      row({ type: "user", sessionId: "conv-b", timestamp: at(2), message: { role: "user", content: "go on" } }),
      row({ type: "assistant", sessionId: "conv-b", timestamp: at(2), message: { id: "msg_c1", model: "claude-opus-5-5", role: "assistant", content: [], usage: { input_tokens: 0, output_tokens: 100 } } }),
    ].join("\n") + "\n",
  );

  test("a conversation read whole: its calls under their turns, its sub-agent's under the launching one, the last cost record's side spend, its line and marks", () => {
    const seen = new Map<string, number>();
    const r = readConversation(main, {}, price, seen);
    expect(r).toMatchObject({ conversation: "claude:conv-a", cwd: "C:\\w\\faircase", title: "lightning" });
    const cells = r.rows.map((c) => `${c.agent}|${c.trigger}|${c.calls}|${c.out}`).sort();
    expect(cells).toEqual(["main|peer|1|500", "main|typed|1|1000", "side|side|0|0", "sub:Explore|typed|1|1000"]);
    const counted = (10 * 4 + 1000 * 20 + 10 * 4 + 500 * 20) / 1e6 + (1000 * 10) / 1e6;
    expect(r.rows.find((c) => c.agent === "side")!.cost).toBeCloseTo(0.43 - counted, 6);
    expect(r.marks.map(([k]) => k).sort()).toEqual(["claude:conv-a", "claude:conv-a/agent-b7.jsonl"]);
    // Read again past those marks: nothing.
    const again = readConversation(main, Object.fromEntries(r.marks), price, new Map());
    expect(again.rows).toEqual([]);
    expect(again.marks).toEqual([]);
    // The job after it in the same run: its copy of msg_a1 counts nothing.
    const j = readConversation(job, {}, price, seen);
    expect(j.rows.map((c) => `${c.trigger}|${c.calls}|${c.out}`)).toEqual(["typed|1|100"]);
  });

  test("a run reads the oldest first, skips what is claimed and what has not grown", () => {
    const msgs: BackfillMessage[] = [];
    run({ dirs: [claudeDir], since: 0, claimed: ["claude:conv-b"], marks: {}, prices: Object.entries(PRICES).map(([k, v]) => [k, { input: v[0]!, output: v[1]!, cache_read: v[2]!, cache_write: v[3]!, cache_write_1h: v[4]! }]) }, (m) => msgs.push(m));
    const results = msgs.filter((m) => m.kind === "result");
    expect(results.map((m) => (m as { result: { conversation: string } }).result.conversation)).toEqual(["claude:conv-a"]);
    const end = msgs.at(-1)!;
    expect(end).toEqual({ kind: "end", read: 1, skipped: 1, failed: 0 });
    const marks = Object.fromEntries((results[0] as { result: { marks: [string, number][] } }).result.marks);
    const msgs2: BackfillMessage[] = [];
    run({ dirs: [claudeDir, claudeDir], since: 0, claimed: ["claude:conv-b"], marks, prices: [] }, (m) => msgs2.push(m));
    expect(msgs2).toEqual([{ kind: "end", read: 0, skipped: 2, failed: 0 }]);
  });

  test("through its worker into the store: the session that tracked a conversation names it; a second run reads nothing new", async () => {
    const store = new Store(":memory:");
    store.migrate();
    const ledger = new SpendLedger({ store, price, retentionDays: 3650 });
    const backfill = new SpendBackfill({
      ledger,
      store,
      claudeDirs: () => [claudeDir],
      session: () => undefined,
      prices: Object.entries(PRICES).map(([k, v]) => [k, { input: v[0]!, output: v[1]!, cache_read: v[2]!, cache_write: v[3]!, cache_write_1h: v[4]! }]),
      retentionDays: 3650,
      delayMs: 0,
    });
    expect(await backfill.run()).toEqual({ read: 2, skipped: 0, failed: 0 });
    const conv = store.spend.conversations().find((c) => c.conversation === "claude:conv-a")!;
    expect(conv).toMatchObject({ cwd: "C:\\w\\faircase", title: "lightning", profile: "" });
    expect(store.spend.total({ from: 0, to: Date.now() + 86_400_000, filter: {}, hidden: [] }).calls).toBe(4);
    expect(await backfill.run()).toEqual({ read: 0, skipped: 2, failed: 0 });
    expect(ledger.filling).toBe(false);
  });
});
