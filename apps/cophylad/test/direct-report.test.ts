// The daily path counts: kept by UTC day in the store, sent for finished days only and then
// dropped, kept when the send fails, dropped unsent past a week, and nothing counted with
// `[direct] report = false`. Nothing in a report names a peer or an address.

import { afterEach, describe, expect, test } from "bun:test";
import type { DirectReport } from "@cophyla/protocol";
import { PathReport, utcDay } from "../src/direct/report.ts";
import { silentLogger } from "../src/log.ts";
import { Store } from "../src/store/index.ts";

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

function harness(enabled = true) {
  const store = new Store(":memory:");
  store.migrate();
  stores.push(store);
  let now = Date.UTC(2026, 8, 20, 10);
  const sent: DirectReport[] = [];
  let failing = false;
  const report = new PathReport({
    store,
    enabled,
    send: async (r) => {
      if (failing) throw new Error("link down");
      sent.push(r);
    },
    log: silentLogger,
    now: () => now,
  });
  return { store, report, sent, advance: (ms: number) => (now += ms), fail: (on: boolean) => (failing = on) };
}

describe("the path report", () => {
  test("today waits; a finished day goes once and is dropped", async () => {
    const { report, sent, advance } = harness();
    report.count("client", "srflx");
    report.count("client", "srflx");
    report.count("client", "failed");
    report.count("node", "predicted");
    await report.flush();
    expect(sent).toEqual([]);
    advance(86_400_000);
    report.count("client", "relay");
    await report.flush();
    expect(sent).toEqual([
      {
        day: "2026-09-20",
        counts: [
          { kind: "client", path: "srflx", count: 2 },
          { kind: "client", path: "failed", count: 1 },
          { kind: "node", path: "predicted", count: 1 },
        ],
      },
    ]);
    await report.flush();
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toMatch(/\d+\.\d+\.\d+\.\d+|controller_|node_/);
  });

  test("a failed send keeps the day for the next link-up; a day past a week goes unsent", async () => {
    const { report, sent, advance, fail } = harness();
    report.count("client", "host");
    advance(86_400_000);
    fail(true);
    await report.flush();
    expect(sent).toEqual([]);
    fail(false);
    await report.flush();
    expect(sent.map((r) => r.day)).toEqual(["2026-09-20"]);
    report.count("client", "host");
    advance(9 * 86_400_000);
    await report.flush();
    expect(sent.map((r) => r.day)).toEqual(["2026-09-20"]);
  });

  test("with the report off nothing is counted or sent", async () => {
    const { store, report, sent, advance } = harness(false);
    report.count("client", "srflx");
    advance(86_400_000);
    await report.flush();
    expect(sent).toEqual([]);
    expect(store.meta.get("direct_paths")).toBeUndefined();
    expect(utcDay(Date.UTC(2026, 0, 2, 23, 59))).toBe("2026-01-02");
  });
});
