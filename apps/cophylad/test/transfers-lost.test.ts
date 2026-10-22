// A machine that comes back without a transfer it was known to hold under way (its daemon
// stopped before the transfer was kept): the mirror ends the transfer as failed and dismissed,
// so no app keeps a row nothing can cancel and an agent waiting on it hears how it ended. A
// transfer that ended, and a machine whose join lists no transfers at all (an older one), lose
// nothing. A transfer the user ended while its machine was offline is held out of the lists
// until it ends there, and the primary keeps what was asked until that machine is back.

import { describe, expect, test } from "bun:test";
import type { Transfer } from "@cophyla/protocol";
import { Mirror } from "../src/nodes/mirror.ts";
import { TRANSFER_ENDS_NS, TransferEnds } from "../src/nodes/transfers.ts";
import { Store } from "../src/store/index.ts";

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const OTHER = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";

const row = (id: string, state: Transfer["state"]): Transfer => ({ id, from: { node: OTHER, path: "/x/a.zip" }, to: { node: NODE, dir: "/in" }, kind: "file", name: "a.zip", total: 10, bytes: 3, state, rate: 5, by: { kind: "user" }, startedAt: 1 });
const empty = { sessions: [], workspaces: [], asks: [] };

describe("transfers a machine came back without", () => {
  test("one under way that its join no longer lists ends as failed and goes; one it lists stays", () => {
    const m = new Mirror();
    expect(m.fill(NODE, { ...empty, transfers: [row("xfr_01ARZ3NDEKTSV4RRFFQ69G5FX1", "running"), row("xfr_01ARZ3NDEKTSV4RRFFQ69G5FX2", "queued")] })).toEqual([]);
    const lost = m.fill(NODE, { ...empty, transfers: [row("xfr_01ARZ3NDEKTSV4RRFFQ69G5FX2", "running")] }, 99);
    const { rate: _rate, ...was } = row("xfr_01ARZ3NDEKTSV4RRFFQ69G5FX1", "running");
    expect(lost).toEqual([{ ...was, state: "failed", error: "its machine stopped before it kept this transfer: send it again", endedAt: 99, dismissed: true }]);
    expect(m.transfers().map((t) => t.id)).toEqual(["xfr_01ARZ3NDEKTSV4RRFFQ69G5FX2"]);
  });

  test("one it was away with (waiting) is lost the same way when the machine comes back without it", () => {
    const m = new Mirror();
    m.fill(NODE, { ...empty, transfers: [row("xfr_01ARZ3NDEKTSV4RRFFQ69G5FX3", "running")] });
    m.drop(NODE);
    expect(m.ownerOfTransfer("xfr_01ARZ3NDEKTSV4RRFFQ69G5FX3")).toBe(NODE);
    const lost = m.fill(NODE, { ...empty, transfers: [] });
    expect(lost.map((t) => [t.id, t.state, t.dismissed])).toEqual([["xfr_01ARZ3NDEKTSV4RRFFQ69G5FX3", "failed", true]]);
    expect(m.ownerOfTransfer("xfr_01ARZ3NDEKTSV4RRFFQ69G5FX3")).toBeUndefined();
  });

  test("an ended one, and a join of an older machine that lists no transfers, lose nothing", () => {
    const m = new Mirror();
    m.fill(NODE, { ...empty, transfers: [row("xfr_01ARZ3NDEKTSV4RRFFQ69G5FX4", "done"), row("xfr_01ARZ3NDEKTSV4RRFFQ69G5FX5", "failed")] });
    expect(m.fill(NODE, { ...empty, transfers: [] })).toEqual([]);
    m.fill(NODE, { ...empty, transfers: [row("xfr_01ARZ3NDEKTSV4RRFFQ69G5FX6", "running")] });
    expect(m.fill(NODE, empty)).toEqual([]);
  });

  test("one ended while its machine was away is held: what that machine says of it is not news until it is dismissed", () => {
    const m = new Mirror();
    m.fill(NODE, { ...empty, transfers: [row("xfr_01ARZ3NDEKTSV4RRFFQ69G5FX7", "running")] });
    m.drop(NODE);
    expect(m.goneTransfer("xfr_01ARZ3NDEKTSV4RRFFQ69G5FX7")?.node).toBe(NODE);
    m.forgetGone("xfr_01ARZ3NDEKTSV4RRFFQ69G5FX7");
    expect(m.goneTransfer("xfr_01ARZ3NDEKTSV4RRFFQ69G5FX7")).toBeUndefined();
    expect(m.ownerOfTransfer("xfr_01ARZ3NDEKTSV4RRFFQ69G5FX7")).toBeUndefined();
    // back, listing it: held out of the lists and lost to no one
    expect(m.fill(NODE, { ...empty, transfers: [row("xfr_01ARZ3NDEKTSV4RRFFQ69G5FX7", "waiting")] }, 5, ["xfr_01ARZ3NDEKTSV4RRFFQ69G5FX7"])).toEqual([]);
    expect(m.transfers()).toEqual([]);
    expect(m.holds(row("xfr_01ARZ3NDEKTSV4RRFFQ69G5FX7", "cancelled"))).toBe(true);
    expect(m.holds({ ...row("xfr_01ARZ3NDEKTSV4RRFFQ69G5FX7", "cancelled"), dismissed: true })).toBe(true);
    // the hold went with its dismissal
    expect(m.holds(row("xfr_01ARZ3NDEKTSV4RRFFQ69G5FX7", "running"))).toBe(false);
    expect(m.holds(row("xfr_01ARZ3NDEKTSV4RRFFQ69G5FX8", "running"))).toBe(false);
  });
});

describe("what the user ended while its machine was offline", () => {
  test("is kept per machine, a cancel stays a cancel, and it is taken once that machine is back", () => {
    const store = new Store(":memory:");
    store.migrate();
    let now = 1_000;
    const ends = new TransferEnds(store.kv, () => now);
    ends.asked(NODE, "xfr_01ARZ3NDEKTSV4RRFFQ69G5FX1", true);
    ends.asked(NODE, "xfr_01ARZ3NDEKTSV4RRFFQ69G5FX1", false);
    ends.asked(NODE, "xfr_01ARZ3NDEKTSV4RRFFQ69G5FX2", false);
    ends.asked(OTHER, "xfr_01ARZ3NDEKTSV4RRFFQ69G5FX3", true);
    expect(ends.take(NODE).sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: "xfr_01ARZ3NDEKTSV4RRFFQ69G5FX1", cancel: true },
      { id: "xfr_01ARZ3NDEKTSV4RRFFQ69G5FX2", cancel: false },
    ]);
    expect(ends.take(NODE)).toEqual([]);
    expect(store.kv.list(TRANSFER_ENDS_NS)).toEqual(["xfr_01ARZ3NDEKTSV4RRFFQ69G5FX3"]);
    // after 30 days it is forgotten, by whichever machine comes back first
    now += 31 * 24 * 60 * 60_000;
    expect(ends.take(NODE)).toEqual([]);
    expect(store.kv.list(TRANSFER_ENDS_NS)).toEqual([]);
    store.close();
  });
});
