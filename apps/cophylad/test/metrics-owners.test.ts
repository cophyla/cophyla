// Owners from the process tree: a session claims its subtree, an ACP agent under cophylad is
// its session's and not the platform's, sidecars and the brain are named, the rest is other;
// a cycle of reused pids does not loop; trimming keeps every owned row and the busiest others.

import { describe, expect, test } from "bun:test";
import { FakeEngine } from "../src/metrics/fake.ts";
import { assignOwners, trimProcesses } from "../src/metrics/owners.ts";
import type { SampleProcess } from "../src/metrics/owners.ts";

const SESSION_A = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB1";
const SESSION_B = "sess_01ARZ3NDEKTSV4RRFFQ69G5FB2";

describe("metrics owners", () => {
  test("sessions, sidecars, brain and platform claim their subtrees in that order; the rest is other", () => {
    const raw = FakeEngine.tree();
    const owners = assignOwners(raw.processes, {
      sessions: new Map([
        [24, SESSION_A],
        [30, SESSION_B],
      ]),
      platform: 20,
      brain: 21,
      sidecars: new Map([[22, "tts-py"]]),
    });
    // The user's session: itself, its shell and its MCP server.
    expect(owners.get(30)).toEqual({ kind: "session", session: SESSION_B });
    expect(owners.get(31)).toEqual({ kind: "session", session: SESSION_B });
    expect(owners.get(32)).toEqual({ kind: "session", session: SESSION_B });
    // The spawned agent sits under cophylad, and is its session's, not the platform's.
    expect(owners.get(24)).toEqual({ kind: "session", session: SESSION_A });
    expect(owners.get(23)).toEqual({ kind: "platform" });
    expect(owners.get(20)).toEqual({ kind: "platform" });
    expect(owners.get(21)).toEqual({ kind: "brain" });
    expect(owners.get(22)).toEqual({ kind: "sidecar", name: "tts-py" });
    // The shell above cophylad is not claimed downward, and the desktop is nobody's.
    expect(owners.get(10)).toBeUndefined();
    expect(owners.get(40)).toBeUndefined();
    expect(owners.get(51)).toBeUndefined();
  });

  test("a claimed subtree is never re-entered, and a root that is not running claims nothing", () => {
    const raw = FakeEngine.tree();
    const owners = assignOwners(raw.processes, { sessions: new Map([[20, SESSION_A]]), platform: 20, brain: 21, sidecars: new Map([[999, "gone"]]) });
    // The session named cophylad's own pid first: everything under it is the session's, the brain included.
    expect(owners.get(21)).toEqual({ kind: "session", session: SESSION_A });
    expect(owners.get(24)).toEqual({ kind: "session", session: SESSION_A });
    expect([...owners.values()].some((o) => o.kind === "sidecar")).toBe(false);
  });

  test("a pid reused under its own descendant does not loop the walk", () => {
    const raw = FakeEngine.raw({
      processes: [
        { pid: 5, parent: 7, name: "a" },
        { pid: 6, parent: 5, name: "b" },
        { pid: 7, parent: 6, name: "c" },
      ],
    });
    const owners = assignOwners(raw.processes, { sessions: new Map([[5, SESSION_A]]), sidecars: new Map() });
    expect([...owners.keys()].sort()).toEqual([5, 6, 7]);
  });

  test("trimming keeps every owned row and the top others by cpu, then memory", () => {
    const row = (pid: number, cpu: number, memory: number, owner: SampleProcess["owner"]): SampleProcess => ({ pid, parent: 1, name: `p${pid}`, cpu, memory, owner });
    const rows: SampleProcess[] = [
      row(1, 0, 10, { kind: "other" }),
      row(2, 5, 10, { kind: "other" }),
      row(3, 5, 20, { kind: "other" }),
      row(4, 0, 1, { kind: "platform" }),
      row(5, 9, 1, { kind: "other" }),
      row(6, 0, 1, { kind: "session", session: SESSION_A }),
    ];
    const kept = trimProcesses(rows, 2);
    expect(kept.map((r) => r.pid)).toEqual([4, 6, 5, 3]);
    expect(trimProcesses(rows, 0).map((r) => r.pid)).toEqual([4, 6]);
  });
});
