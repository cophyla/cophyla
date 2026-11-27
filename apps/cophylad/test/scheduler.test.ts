// The background scheduler: a job's slices end at their budget with a turn of the loop between
// them, jobs of a class run one at a time, background work waits while the daemon is busy
// (voice, a critical CPU) for a bounded time, a triggered job runs soon, and the busy signal
// follows the bus.

import { describe, expect, test } from "bun:test";
import { InlineBackground } from "../src/background/client.ts";
import { busySignal } from "../src/background/maintenance.ts";
import { Scheduler } from "../src/background/scheduler.ts";
import type { JobContext } from "../src/background/scheduler.ts";
import { Bus } from "../src/bus.ts";
import { silentLogger } from "../src/log.ts";
import { createLogger } from "../src/log.ts";
import { Store } from "../src/store/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function scheduler(busy: () => string | undefined = () => undefined, log = silentLogger) {
  const store = new Store(":memory:");
  store.migrate();
  return new Scheduler({ log, background: new InlineBackground(store.db), busy, random: () => 0.5 });
}

describe("the scheduler", () => {
  test("a slice ends at its budget: other work runs between the slices of a long job", async () => {
    const s = scheduler();
    const ticks: number[] = [];
    const ticker = setInterval(() => ticks.push(performance.now()), 1);
    let slices = 0;
    s.add({
      name: "long",
      delayMs: 0,
      run: async (ctx) => {
        const until = performance.now() + 200;
        let last = performance.now();
        while (performance.now() < until) {
          if (performance.now() - last > 6) {
            await ctx.yield();
            if (performance.now() - last > 6) slices++;
            last = performance.now();
          }
        }
      },
    });
    s.start();
    await sleep(320);
    clearInterval(ticker);
    await s.stop();
    // the interval kept running while the job did (a timer on Windows ticks at ~16 ms at best)
    expect(ticks.length).toBeGreaterThan(6);
    expect(slices).toBeGreaterThan(3);
  });

  test("jobs of a class run one at a time; another class runs beside them", async () => {
    const s = scheduler();
    const log: string[] = [];
    const job = (name: string, cls: string) => ({
      name,
      class: cls,
      delayMs: 0,
      run: async (ctx: JobContext) => {
        log.push(`${name}+`);
        await ctx.sleep(30);
        log.push(`${name}-`);
      },
    });
    s.add(job("a", "x"));
    s.add(job("b", "x"));
    s.add(job("c", "y"));
    s.start();
    await sleep(150);
    await s.stop();
    const a = log.indexOf("a-");
    const b = log.indexOf("b+");
    expect(a).toBeLessThan(b);
    expect(log.indexOf("c+")).toBeLessThan(a);
  });

  test("background work waits while the daemon is busy, for its bound at most", async () => {
    let busy: string | undefined = "voice";
    const s = scheduler(() => busy);
    let ran = 0;
    s.add({ name: "waits", delayMs: 0, maxDeferMs: 10_000, run: async () => void ran++ });
    s.add({ name: "bounded", class: "other", delayMs: 0, maxDeferMs: 300, run: async () => void ran++ });
    s.start();
    await sleep(150);
    expect(ran).toBe(0);
    // the bound passed: the bounded job ran though the daemon is still busy
    await sleep(500);
    expect(ran).toBe(1);
    busy = undefined;
    await sleep(400);
    expect(ran).toBe(2);
    await s.stop();
  });

  test("a job waits at its yield while the daemon turns busy", async () => {
    let busy: string | undefined;
    const s = scheduler(() => busy);
    const steps: number[] = [];
    s.add({
      name: "steps",
      delayMs: 0,
      maxDeferMs: 10_000,
      run: async (ctx) => {
        for (let i = 0; i < 3; i++) {
          steps.push(i);
          busy = i === 0 ? "cpu" : undefined;
          await ctx.sleep(1);
        }
      },
    });
    s.start();
    await sleep(100);
    expect(steps).toEqual([0]);
    busy = undefined;
    await sleep(600);
    expect(steps).toEqual([0, 1, 2]);
    await s.stop();
  });

  test("a triggered job runs soon; one that answers again runs again; a periodic one repeats", async () => {
    const s = scheduler();
    let triggered = 0;
    let again = 0;
    let periodic = 0;
    s.add({ name: "on-demand", run: async () => void triggered++ });
    s.add({ name: "more", class: "more", delayMs: 0, run: async () => (++again < 3 ? "again" : undefined) });
    s.add({ name: "tick", class: "tick", delayMs: 0, everyMs: 40, run: async () => void periodic++ });
    s.start();
    await sleep(30);
    expect(triggered).toBe(0);
    s.trigger("on-demand");
    await sleep(320);
    await s.stop();
    expect(triggered).toBe(1);
    expect(again).toBe(3);
    expect(periodic).toBeGreaterThanOrEqual(3);
  });

  test("a slice that overruns its budget is logged with its job", async () => {
    const lines: string[] = [];
    const s = scheduler(undefined, createLogger("debug", (l) => lines.push(l)));
    s.add({
      name: "hog",
      delayMs: 0,
      run: async () => {
        const until = performance.now() + 80;
        while (performance.now() < until) {
          // never yields
        }
      },
    });
    s.start();
    await sleep(150);
    await s.stop();
    expect(lines.some((l) => l.includes("background slice over budget") && l.includes('"job":"hog"'))).toBe(true);
  });

  test("the busy signal follows voice and the CPU on the bus", () => {
    const bus = new Bus();
    const node = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const sig = busySignal(bus, node);
    expect(sig.busy()).toBeUndefined();
    bus.emit("voice.state", { state: "listening", client: "c1" } as never);
    expect(sig.busy()).toBe("voice");
    bus.emit("voice.state", { state: "thinking", client: "c1" } as never);
    expect(sig.busy()).toBeUndefined();
    bus.emit("node.pressure", { at: 1, node, resource: "cpu", level: "critical" } as never);
    expect(sig.busy()).toBe("cpu");
    bus.emit("node.pressure", { at: 2, node: "node_other", resource: "cpu", level: "ok" } as never);
    expect(sig.busy()).toBe("cpu");
    bus.emit("node.pressure", { at: 3, node, resource: "cpu", level: "warn" } as never);
    expect(sig.busy()).toBeUndefined();
    sig.dispose();
  });
});
