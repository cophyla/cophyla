// Metrics across the link: a client of the primary subscribes to the secondary's samples,
// which the secondary's scripted engine produces on each of its ticks and the primary routes
// to that client alone; a second client at a slower interval shares the one subscription;
// unsubscribing and disconnecting stop the stream, and the last watcher gone unsubscribes
// the link. `metrics.history` and `tool.run` with a `node` reach the secondary too. Each
// watcher is sent its own share: at its rate, with its rows, every count it skipped carried
// on; the link carries every row while one watcher wants them, and a watcher's spend
// totals are summed on the secondary as its watch starts.

import { afterEach, describe, expect, test } from "bun:test";
import type { MetricsSample } from "@cophyla/protocol";
import type { RawSample } from "../src/metrics/engine.ts";
import { FakeEngine } from "../src/metrics/fake.ts";
import { isMethod, waitFor } from "./helpers.ts";
import type { TestClient } from "./helpers.ts";
import { client, linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

let primary: Primary | undefined;
let secondary: Started | undefined;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  await stopAll(secondary, primary?.d);
  primary = undefined;
  secondary = undefined;
});

/** A scripted engine whose readings a test advances by hand. */
function scripted(t0: number) {
  let last: RawSample = FakeEngine.tree({}, { monoS: 0 });
  last.at = t0;
  last.cpu = { busyNs: 0, totalNs: 0 };
  let monoS = 0;
  const engine = new FakeEngine(() => last);
  const step = (busyPct = 5) => {
    monoS += 1;
    const raw = FakeEngine.tree({ 30: monoS * 0.1 }, { monoS });
    raw.at = last.at + 1000;
    const dTotal = Number(raw.monoNs - last.monoNs) * raw.cores;
    raw.cpu = { busyNs: last.cpu.busyNs + (dTotal * busyPct) / 100, totalNs: last.cpu.totalNs + dTotal };
    last = raw;
  };
  return { engine, step, now: () => last.at };
}

const samplesOf = (c: TestClient, node: string): MetricsSample[] => c.notifications.filter(isMethod("metrics.sample", (p) => (p as MetricsSample).node === node)).map((n) => n.params as MetricsSample);

describe("metrics across the link", () => {
  test("a subscription to the secondary delivers its samples to the subscribed client only, until it unsubscribes or goes", async () => {
    const T0 = Math.floor(1_700_000_000_000 / 60000) * 60000;
    const p = scripted(T0);
    const s = scripted(T0);
    primary = await startPrimary({ daemon: { metrics: { engine: p.engine, manual: true, now: p.now } } });
    secondary = await startSecondary(primary, { daemon: { metrics: { engine: s.engine, manual: true, now: s.now } } });
    await linked(secondary);
    // Both nodes primed at start; a tick each yields a first sample.
    p.step();
    await primary.d.metrics.tick();
    s.step();
    await secondary.metrics.tick();
    const a = await client(primary.d, "a");
    const b = await client(primary.d, "b");
    clients.push(a, b);
    const sid = secondary.identity.id;
    await a.request("metrics.subscribe", { node: sid, intervalMs: 1000 });
    // The latest arrives at once, from the secondary, to the subscriber alone.
    await waitFor(() => samplesOf(a, sid).length === 1);
    expect(samplesOf(a, sid)[0]!.node).toBe(sid);
    expect(secondary.metrics.snapshot().subscribers.map((x) => x.intervalMs)).toEqual([1000]);
    expect(secondary.metrics.snapshot().subscribers[0]!.client.startsWith("link:")).toBe(true);
    s.step(50);
    await secondary.metrics.tick();
    await waitFor(() => samplesOf(a, sid).length === 2);
    expect(samplesOf(a, sid)[1]!.cpu).toBe(50);
    expect(samplesOf(b, sid).length).toBe(0);
    // The primary's own samples are not the secondary's.
    p.step();
    await primary.d.metrics.tick();
    await Bun.sleep(50);
    expect(samplesOf(a, sid).length).toBe(2);
    // A second watcher at a slower rate shares the link's subscription, which runs at the smallest interval.
    await b.request("metrics.subscribe", { node: sid, intervalMs: 3000 });
    await waitFor(() => samplesOf(b, sid).length === 1);
    expect(secondary.metrics.snapshot().subscribers.map((x) => x.intervalMs)).toEqual([1000]);
    // `a` unsubscribes: the link stays for `b`, now at its rate, and `a` hears nothing more.
    await a.request("metrics.unsubscribe", {});
    await waitFor(() => secondary!.metrics.snapshot().subscribers[0]?.intervalMs === 3000);
    await Bun.sleep(50);
    const heardByA = samplesOf(a, sid).length;
    s.step();
    await secondary.metrics.tick();
    await Bun.sleep(50);
    expect(samplesOf(a, sid).length).toBe(heardByA);
    // `b` goes: the last watcher gone unsubscribes the link.
    b.close();
    await b.closed;
    await waitFor(() => secondary!.metrics.snapshot().subscribers.length === 0);
    // History and a tool on the secondary, by node.
    const history = await a.request<{ samples: MetricsSample[] }>("metrics.history", { node: sid, range: { from: T0 - 60_000 } });
    expect(history.samples.length).toBeGreaterThan(0);
    expect(history.samples.every((x) => x.node === sid)).toBe(true);
    // A node nobody knows: not found, from the primary's own module.
    const missing = await a.call("metrics.history", { node: "node_01ARZ3NDEKTSV4RRFFQ69G5FAW", range: {} });
    expect("error" in missing && missing.error.data?.code).toBe("not_found");
  }, 30_000);

  test("each watcher of the secondary is sent its own share: its rate, its rows, every count it skipped; spend is summed there", async () => {
    const T0 = Math.floor(1_700_000_000_000 / 60000) * 60000;
    const p = scripted(T0);
    const s = scripted(T0);
    primary = await startPrimary({ daemon: { metrics: { engine: p.engine, manual: true, now: p.now } } });
    secondary = await startSecondary(primary, { daemon: { metrics: { engine: s.engine, manual: true, now: s.now } } });
    await linked(secondary);
    s.step();
    await secondary.metrics.tick();
    const sid = secondary.identity.id;
    const profile = "prof_01ARZ3NDEKTSV4RRFFQ69G5FB8";
    const session = { id: "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1", node: sid, harness: "claude" as const, profile, native: { id: "n", pid: 30, transport: "pipe" as const }, origin: "user" as const, cwd: "/w", tags: [], status: "busy" as const, startedAt: 1, lastActivity: 2 };
    let total = 0;
    const spendTo = (n: number) => secondary!.bus.emit("session.state", { ...session, stats: { turns: 1, cost: 0, tokens: { in: n, out: 0 } } });
    const fast = await client(primary.d, "fast");
    const card = await client(primary.d, "card");
    clients.push(fast, card);
    await fast.request("metrics.subscribe", { node: sid, intervalMs: 1000 });
    await waitFor(() => samplesOf(fast, sid).length === 1);
    // Spent before the card watches: in the card's totals, and nowhere else it hears.
    for (let i = 1; i <= 3; i++) {
      total += 5;
      spendTo(total);
      s.step();
      await secondary.metrics.tick();
    }
    await waitFor(() => samplesOf(fast, sid).length === 4);
    const { spend: totals } = await card.request<{ spend: { at: number; profiles: Record<string, { in: number }> } }>("metrics.subscribe", { node: sid, intervalMs: 4000, processes: "owners", spend: {} });
    expect(totals.profiles[profile]!.in).toBe(total);
    expect(totals.at).toBe(secondary.metrics.latest()!.at);
    await waitFor(() => samplesOf(card, sid).length === 1);
    // The link carries every row while one watcher wants them.
    expect(secondary.metrics.snapshot().subscribers[0]!.processes).toBe("all");
    const before = total;
    for (let i = 1; i <= 9; i++) {
      total += 11;
      spendTo(total);
      s.step();
      await secondary.metrics.tick();
    }
    await waitFor(() => samplesOf(fast, sid).length >= 10);
    await Bun.sleep(50);
    const cardSamples = samplesOf(card, sid);
    expect(cardSamples.length).toBeLessThan(samplesOf(fast, sid).length);
    expect(cardSamples.every((x) => x.processes.every((row) => row.pid === 0))).toBe(true);
    expect(samplesOf(fast, sid).at(-1)!.processes.some((row) => row.pid !== 0)).toBe(true);
    const sent = (list: MetricsSample[]) => list.filter((x) => x.at > totals.at).reduce((a, x) => a + (x.profiles?.[profile]?.in ?? 0), 0);
    // Everything spent after the totals reached each watcher, however many samples it skipped; the card's last due sample carries the rest.
    expect(sent(samplesOf(fast, sid))).toBe(total - before);
    const last = cardSamples.at(-1)!.at;
    const pendingForCard = samplesOf(fast, sid).filter((x) => x.at > last).reduce((a, x) => a + (x.profiles?.[profile]?.in ?? 0), 0);
    expect(totals.profiles[profile]!.in + sent(cardSamples) + pendingForCard).toBe(total);
    // The watcher that wanted every row goes: the link narrows to the owners.
    await fast.request("metrics.unsubscribe", {});
    await waitFor(() => secondary!.metrics.snapshot().subscribers[0]?.processes === "owners");
    expect(secondary.metrics.snapshot().subscribers[0]!.intervalMs).toBe(4000);
  }, 30_000);

  test("watchers joining with their spend at once leave the link at the fastest of them; one that leaves meanwhile does not unsubscribe the joiner", async () => {
    const T0 = Math.floor(1_700_000_000_000 / 60000) * 60000;
    const p = scripted(T0);
    const s = scripted(T0);
    primary = await startPrimary({ daemon: { metrics: { engine: p.engine, manual: true, now: p.now } } });
    secondary = await startSecondary(primary, { daemon: { metrics: { engine: s.engine, manual: true, now: s.now } } });
    await linked(secondary);
    s.step();
    await secondary.metrics.tick();
    const sid = secondary.identity.id;
    const desk = await client(primary.d, "desk");
    const slow = await client(primary.d, "slow");
    const leaving = await client(primary.d, "leaving");
    clients.push(desk, slow, leaving);
    // The desk's answer is still on its way when the slow one asks: the link must not end at the slow rate.
    await Promise.all([
      desk.request("metrics.subscribe", { node: sid, intervalMs: 2000, spend: {} }),
      slow.request("metrics.subscribe", { node: sid, intervalMs: 6000, processes: "owners", spend: {} }),
    ]);
    await Bun.sleep(100);
    expect(secondary.metrics.snapshot().subscribers.map((x) => [x.intervalMs, x.processes])).toEqual([[2000, "all"]]);
    // A watcher leaving while another's spend is in flight re-subscribes for the joiner, never unsubscribes it.
    await desk.request("metrics.unsubscribe", {});
    await slow.request("metrics.unsubscribe", {});
    await waitFor(() => secondary!.metrics.snapshot().subscribers.length === 0);
    await leaving.request("metrics.subscribe", { node: sid, intervalMs: 3000 });
    const joined = desk.request("metrics.subscribe", { node: sid, intervalMs: 2000, spend: {} });
    leaving.close();
    await joined;
    await Bun.sleep(200);
    expect(secondary.metrics.snapshot().subscribers.map((x) => x.intervalMs)).toEqual([2000]);
    s.step();
    await secondary.metrics.tick();
    await waitFor(() => samplesOf(desk, sid).length >= 2);
  }, 30_000);
});
