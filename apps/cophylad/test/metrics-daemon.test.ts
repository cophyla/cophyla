// Metrics over the socket with the fake brain and a scripted engine: `metrics.subscribe`
// answers with a sample at once and one per tick, none after the client closes;
// `metrics.history` returns the finished minute's rollup and the open minute's samples; a
// reading at 96% reaches the brain as `node.pressure`, is in `event.history`, and fires a
// task triggered on it; the brain's `metrics.query` is served; every read is audited as such.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditEntry, MetricsSample, Task } from "@cophyla/protocol";
import type { Daemon } from "../src/daemon.ts";
import { FakeEngine } from "../src/metrics/fake.ts";
import type { RawSample } from "../src/metrics/engine.ts";
import { brainFrames, isMethod, removeHome, stopDaemon, tempHome, TestClient, tomlString, waitFor } from "./helpers.ts";

const FAKE_BRAIN = join(import.meta.dir, "fakes", "brain.ts");
const T0 = Math.floor(1_700_000_000_000 / 60000) * 60000 + 50_000;

interface Started {
  d: Daemon & { home: string };
  c: TestClient;
  log: string;
  scratch: string;
  step(spec?: { busyPct?: number; seconds?: number }): Promise<void>;
}

let current: Started | undefined;

afterEach(async () => {
  if (!current) return;
  current.c.close();
  await stopDaemon(current.d);
  removeHome(current.scratch);
  current = undefined;
});

async function start(): Promise<Started> {
  const scratch = tempHome();
  const configDir = join(scratch, "claude-home");
  mkdirSync(configDir, { recursive: true });
  const scriptPath = join(scratch, "brain-script.json");
  writeFileSync(
    scriptPath,
    JSON.stringify({
      on: [
        { event: "hello", requests: [{ method: "metrics.query", params: { node: "$event.nodeId" } }] },
        { event: "node.pressure", requests: [{ method: "metrics.query", params: { node: "$event.node", range: { from: 0 } } }] },
      ],
    }),
  );
  const log = join(scratch, "brain.log");
  const toml =
    `[nodes]\ndiscovery = false\n\n[sessions]\ndiscover = false\ninstall_hooks = false\n\n[[profiles]]\nharness = "claude"\nname = "fake"\nconfig_dir = ${tomlString(configDir)}\n\n` +
    `[brain]\ncommand = ${tomlString(FAKE_BRAIN)}\nrestart_backoff_ms = 100\nhello_timeout_ms = 5000\n\n[metrics]\nwarn = 80\ncritical = 95\n\n[gate.rules]\n"brain:task.create" = "allow"\n`;
  writeFileSync(join(scratch, "config.toml"), toml);
  const { startDaemon } = await import("../src/daemon.ts");
  const { silentLogger } = await import("../src/log.ts");
  let last: RawSample = FakeEngine.tree({}, { monoS: 0 });
  last.at = T0;
  last.cpu = { busyNs: 0, totalNs: 0 };
  let monoS = 0;
  const engine = new FakeEngine(() => last);
  const d = Object.assign(
    await startDaemon({ home: scratch, port: 0, log: silentLogger, env: { ...process.env, FAKE_BRAIN_SCRIPT: scriptPath, FAKE_BRAIN_LOG: log }, metrics: { engine, manual: true, now: () => last.at } }),
    { home: scratch },
  );
  const c = await TestClient.connect(d.api.url);
  await c.hello(d.token, { name: "test" });
  const step: Started["step"] = async (spec = {}) => {
    const seconds = spec.seconds ?? 1;
    monoS += seconds;
    const raw = FakeEngine.tree({ 20: monoS * 0.05 }, { monoS });
    raw.at = last.at + seconds * 1000;
    const dTotal = Number(raw.monoNs - last.monoNs) * raw.cores;
    raw.cpu = { busyNs: last.cpu.busyNs + (dTotal * (spec.busyPct ?? 5)) / 100, totalNs: last.cpu.totalNs + dTotal };
    last = raw;
    await d.metrics.tick();
  };
  current = { d, c, log, scratch, step };
  return current;
}

const samplesOf = (c: TestClient): MetricsSample[] => c.notifications.filter(isMethod("metrics.sample")).map((n) => n.params as MetricsSample);

describe("metrics over the socket", () => {
  test("subscribe delivers the latest at once and one sample per tick; nothing after the client closes; history spans the minute", async () => {
    const { d, c, step, log } = await start();
    await waitFor(() => d.brain?.state === "up");
    // The daemon primed at start; one step yields the first sample.
    await step();
    const first = d.metrics.latest()!;
    expect(first.at).toBe(T0 + 1000);
    await c.request("metrics.subscribe", { intervalMs: 1000 });
    await waitFor(() => samplesOf(c).length === 1);
    expect(samplesOf(c)[0]).toEqual(first);
    // This process is the platform, and pid 20 of the fake tree is not (it is another bun); every owner kind is well-formed.
    expect(first.processes.every((p) => ["session", "platform", "brain", "sidecar", "other"].includes(p.owner.kind))).toBe(true);
    await step();
    await step();
    await waitFor(() => samplesOf(c).length === 3);
    // Twelve more steps close the minute at T0 + 60 s.
    for (let i = 0; i < 12; i++) await step();
    await waitFor(() => samplesOf(c).length === 15);
    expect(d.store.metrics.count(d.identity.id)).toBe(1);
    const history = await c.request<{ samples: MetricsSample[] }>("metrics.history", { node: d.identity.id, range: { from: T0 - 60_000, to: T0 + 120_000 } });
    expect(history.samples[0]!.at).toBe(Math.floor(T0 / 60000) * 60000);
    expect(history.samples.length).toBe(1 + samplesOf(c).filter((s) => s.at >= Math.floor(T0 / 60000) * 60000 + 60_000).length);
    // A node this daemon does not know: not found.
    const other = await c.call("metrics.history", { node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAW", range: {} });
    expect("error" in other && other.error.data?.code).toBe("not_found");
    // Every metrics request crossed the gate as a read by this client.
    const audit = d.store.audit.list({ limit: 100 }).filter((e: AuditEntry) => e.action.startsWith("metrics."));
    expect(audit.map((e) => e.action).sort()).toEqual(["metrics.history", "metrics.history", "metrics.query", "metrics.subscribe"]);
    expect(audit.filter((e) => e.action !== "metrics.query").every((e) => e.principal.kind === "user" && e.decision === "allow")).toBe(true);
    const brainQuery = audit.find((e) => e.action === "metrics.query")!;
    expect(brainQuery.principal).toEqual({ kind: "brain" });
    expect(brainQuery.outcome).toBe("ok");
    // The brain's query at hello answered with the rollups and the latest sample it had then: an array, possibly empty.
    const reply = brainFrames(log).find((f) => f.dir === "in" && f.frame["result"] !== undefined && (f.frame["result"] as { samples?: unknown }).samples !== undefined);
    expect(reply).toBeDefined();
    // Unsubscribing stops the stream; a second client that closes is dropped from the subscribers.
    await c.request("metrics.unsubscribe", {});
    const before = samplesOf(c).length;
    await step();
    await step();
    await Bun.sleep(50);
    expect(samplesOf(c).length).toBe(before);
    const c2 = await TestClient.connect(d.api.url);
    await c2.hello(d.token, { name: "second" });
    await c2.request("metrics.subscribe", { intervalMs: 1000 });
    expect(d.metrics.snapshot().subscribers.length).toBe(1);
    c2.close();
    await c2.closed;
    await waitFor(() => d.metrics.snapshot().subscribers.length === 0);
  }, 20_000);

  test("a reading over the threshold reaches the brain as node.pressure, lands in event.history and fires a task triggered on it", async () => {
    const { d, c, step, log } = await start();
    await waitFor(() => d.brain?.state === "up");
    const created = await c.request<{ id: string }>("task.create", { title: "on pressure", trigger: { kind: "event", name: "node.pressure", match: { level: "critical" } } });
    await step();
    await step({ busyPct: 96 });
    const frame = await waitFor(() => brainFrames(log).find((f) => f.dir === "in" && f.frame["method"] === "node.pressure"));
    expect(frame.frame["params"]).toMatchObject({ node: d.identity.id, resource: "cpu", level: "critical" });
    const task = await waitFor(() => {
      const t = d.tasks.get(created.id);
      return t?.status === "ready" ? t : undefined;
    });
    expect((task as Task).status).toBe("ready");
    expect(d.store.events.history({ name: "node.pressure" }).map((e) => e.payload)).toEqual([{ resource: "cpu", level: "critical" }]);
    // The brain's query on the event was served in range form.
    await waitFor(() => brainFrames(log).filter((f) => f.dir === "in" && f.frame["result"] !== undefined && (f.frame["result"] as { samples?: unknown[] }).samples !== undefined).length >= 2);
    // Back under the line for two readings: normal, once.
    await step({ busyPct: 10 });
    await step({ busyPct: 10 });
    await waitFor(() => brainFrames(log).filter((f) => f.dir === "in" && f.frame["method"] === "node.pressure").length === 2);
    const levels = brainFrames(log)
      .filter((f) => f.dir === "in" && f.frame["method"] === "node.pressure")
      .map((f) => (f.frame["params"] as { level: string }).level);
    expect(levels).toEqual(["critical", "normal"]);
  }, 20_000);
});
