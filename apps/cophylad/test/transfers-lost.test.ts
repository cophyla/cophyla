// A machine that comes back without a transfer it was known to hold under way (its daemon
// stopped before the transfer was kept): the mirror ends the transfer as failed and dismissed,
// so no app keeps a row nothing can cancel and an agent waiting on it hears how it ended. A
// transfer that ended, and a machine whose join lists no transfers at all (an older one), lose
// nothing.

import { describe, expect, test } from "bun:test";
import type { Transfer } from "@cophyla/protocol";
import { Mirror } from "../src/nodes/mirror.ts";

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
});
