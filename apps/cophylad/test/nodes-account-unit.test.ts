// The account's machines, the decisions alone: what a machine does when the server names
// another cluster than its own, by what it is (alone, leading others, following a primary,
// hands), how a try that failed is told and tried again, and what the user's taking it out
// keeps. The joining itself is the nodes module's (nodes-account.test.ts).

import { afterEach, describe, expect, test } from "bun:test";
import { RpcError } from "@cophyla/protocol";
import type { GrantRole } from "@cophyla/protocol";
import type { Arbiter } from "../src/cloud/registry.ts";
import { silentLogger } from "../src/log.ts";
import { ACCOUNT_META, AccountJoin, JOINED_SHOWN_MS, RETRY_MS, SLOW_RETRY_MS } from "../src/nodes/account.ts";
import type { Stance } from "../src/nodes/account.ts";
import { waitFor } from "./helpers.ts";

const MINE = "1111111111111111";
const THEIRS = "2222222222222222";

interface Rig {
  join: AccountJoin;
  asked: { node: string; role?: GrantRole; from?: string }[];
  joined: { invite: string; how: string }[];
  moved: { node: string; invite: string }[];
  meta: Map<string, string>;
  changes: number;
  stance: Stance;
  cluster: string | undefined;
  answer: (node: string) => Promise<string>;
  clock: { now: number };
}

const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs) r.join.stop();
  rigs.length = 0;
});

function rig(opts: { stance?: Stance; meta?: Record<string, string>; enabled?: boolean; active?: boolean } = {}): Rig {
  const r: Rig = {
    asked: [],
    joined: [],
    moved: [],
    meta: new Map(Object.entries(opts.meta ?? {})),
    changes: 0,
    stance: opts.stance ?? { kind: "alone" },
    cluster: MINE,
    answer: async (node: string) => `invite-for-${node}`,
    clock: { now: 1_000_000 },
  } as unknown as Rig;
  const arb: Partial<Arbiter> = {
    active: () => opts.active ?? true,
    join: async (node, role, from) => {
      r.asked.push({ node: node.id, ...(role !== undefined ? { role } : {}), ...(from !== undefined ? { from } : {}) });
      return r.answer(node.id);
    },
  };
  r.join = new AccountJoin({
    log: silentLogger,
    enabled: () => opts.enabled ?? true,
    arbiter: () => arb as Arbiter,
    self: () => ({ id: "node_self", name: "laptop" }),
    cluster: () => r.cluster,
    stance: () => r.stance,
    joinSelf: async (invite, how) => {
      r.joined.push({ invite, how });
      r.cluster = THEIRS;
      return { primary: { id: "node_desk", name: "desk" }, ...(how !== "follows" ? { saved: "/data/before-join/x.json" } : {}) };
    },
    move: async (node, invite) => {
      if (node === "node_gone") throw new Error("it did not answer");
      r.moved.push({ node, invite });
    },
    meta: { get: (k) => r.meta.get(k), set: (k, v) => void r.meta.set(k, v) },
    changed: () => void r.changes++,
    now: () => r.clock.now,
  });
  rigs.push(r);
  return r;
}

describe("the account's machines: what a machine does when the server names another cluster", () => {
  test("its own cluster named: nothing; another one: a machine alone asks for its invite and joins, and says so for a day", async () => {
    const r = rig();
    r.join.hear({ cluster: MINE });
    await Bun.sleep(20);
    expect(r.asked).toEqual([]);
    expect(r.join.state()).toBeUndefined();
    r.join.hear({ cluster: THEIRS });
    await waitFor(() => r.joined.length === 1, 2000);
    expect(r.asked).toEqual([{ node: "node_self" }]);
    expect(r.joined).toEqual([{ invite: "invite-for-node_self", how: "alone" }]);
    expect(r.join.state()).toEqual({ state: "joined", primary: "desk", saved: "/data/before-join/x.json", since: r.clock.now });
    expect(JSON.parse(r.meta.get(ACCOUNT_META)!)).toMatchObject({ state: "joined", primary: "desk" });
    // the server names it from now on: nothing more, and the note stays its day
    r.join.hear({ cluster: THEIRS });
    await Bun.sleep(20);
    expect(r.joined.length).toBe(1);
    r.clock.now += JOINED_SHOWN_MS + 1;
    expect(r.join.state()).toBeUndefined();
  });

  test("a primary with others moves each it reaches, then itself with its cluster named; the ones it did not reach are named", async () => {
    const r = rig({
      stance: {
        kind: "leads",
        members: [
          { node: "node_m1", name: "ansar", role: "hands", linked: true },
          { node: "node_off", name: "laptop-old", role: "full", linked: false },
          { node: "node_gone", name: "flaky", role: "full", linked: true },
        ],
      },
    });
    r.join.hear({ cluster: THEIRS });
    await waitFor(() => r.joined.length === 1, 2000);
    expect(r.asked).toEqual([{ node: "node_m1", role: "hands" }, { node: "node_gone", role: "full" }, { node: "node_self", role: "full", from: MINE }]);
    expect(r.moved).toEqual([{ node: "node_m1", invite: "invite-for-node_m1" }]);
    expect(r.joined).toEqual([{ invite: "invite-for-node_self", how: "leads" }]);
    expect(r.join.state()).toMatchObject({ state: "joined", primary: "desk", left: ["laptop-old", "flaky"] });
  });

  test("the account's primary refusing a machine it leads stops the move: nothing more is asked, and it is tried again", async () => {
    const r = rig({ stance: { kind: "leads", members: [{ node: "node_m1", name: "ansar", role: "full", linked: true }] } });
    r.answer = async () => {
      throw new RpcError("unavailable", "desk, the account's primary, is not connected", { provider: "server", primary: { id: "node_desk", name: "desk" } });
    };
    r.join.hear({ cluster: THEIRS });
    await waitFor(() => r.join.state()?.state === "waiting", 2000);
    expect(r.asked).toEqual([{ node: "node_m1", role: "full" }]);
    expect(r.moved).toEqual([]);
    expect(r.joined).toEqual([]);
    expect(r.join.state()).toMatchObject({ state: "waiting", primary: "desk", detail: "desk, the account's primary, is not connected" });
  });

  test("a secondary waits for its primary to move it; told its cluster was moved without it, it joins on its own", async () => {
    const r = rig({ stance: { kind: "follows" } });
    r.join.hear({ cluster: THEIRS });
    await Bun.sleep(50);
    expect(r.asked).toEqual([]);
    await expect(r.join.joinNow()).rejects.toThrow(/joins your account's machines when that primary does/);
    r.join.hear({ cluster: THEIRS, merged: true });
    await waitFor(() => r.joined.length === 1, 2000);
    expect(r.joined).toEqual([{ invite: "invite-for-node_self", how: "follows" }]);
    expect(r.join.state()).toMatchObject({ state: "joined", primary: "desk" });
    expect(r.join.state()?.saved).toBeUndefined();
  });

  test("hands never joins on its own; nor anything with the switch off or the server out of reach", async () => {
    for (const r of [rig({ stance: { kind: "hands" } }), rig({ enabled: false }), rig({ active: false })]) {
      r.join.hear({ cluster: THEIRS });
      await Bun.sleep(30);
      expect(r.asked).toEqual([]);
      expect(r.join.state()).toBeUndefined();
    }
  });

  test("busy (the role changing, a join in flight): tried again shortly", async () => {
    const r = rig({ stance: { kind: "busy" } });
    r.join.hear({ cluster: THEIRS });
    await Bun.sleep(30);
    expect(r.asked).toEqual([]);
    expect(RETRY_MS[0]).toBe(5_000);
  });
});

describe("the account's machines: a try that failed", () => {
  const failing = async (e: RpcError) => {
    const r = rig();
    r.answer = async () => {
      throw e;
    };
    r.join.hear({ cluster: THEIRS });
    await waitFor(() => r.join.state() !== undefined && r.join.state()?.state !== "joining", 2000);
    return r;
  };

  test("the primary away: waiting, with the server's words and the primary's name", async () => {
    const r = await failing(new RpcError("unavailable", "desk, the account's primary, is not connected", { provider: "server", primary: { id: "node_desk", name: "desk" } }));
    expect(r.join.state()).toEqual({ state: "waiting", primary: "desk", detail: "desk, the account's primary, is not connected", since: r.clock.now });
  });

  test("an older primary: waiting for its update, tried again later", async () => {
    const r = await failing(new RpcError("unsupported", "unsupported: account.invite", { primary: { id: "node_desk", name: "desk" }, from: "primary" }));
    expect(r.join.state()).toMatchObject({ state: "waiting", detail: "desk needs a newer Cophyla to let machines in through the account" });
    expect(SLOW_RETRY_MS).toBe(600_000);
  });

  test("an older server", async () => {
    const r = await failing(new RpcError("unsupported", "unsupported: account.join"));
    expect(r.join.state()).toMatchObject({ state: "waiting", detail: "the server lets no machine join through the account yet" });
  });

  test("the primary's refusal: failed, in its words", async () => {
    const r = await failing(new RpcError("denied", "desk lets no machine in through the account: [nodes] account_join is off there", { from: "primary" }));
    expect(r.join.state()).toMatchObject({ state: "failed", detail: "desk lets no machine in through the account: [nodes] account_join is off there" });
  });

  test("already one of them: nothing to show", async () => {
    const r = rig();
    r.answer = async () => {
      throw new RpcError("conflict", "this machine is one of the account's machines already");
    };
    r.join.hear({ cluster: THEIRS });
    await Bun.sleep(50);
    expect(r.join.state()).toBeUndefined();
  });
});

describe("the account's machines: taken out", () => {
  test("left or removed, it stays apart across restarts; Join them puts it back", async () => {
    const r = rig();
    r.join.keepApart("left its cluster");
    expect(r.meta.get(ACCOUNT_META)).toBe("off");
    expect(r.join.state()).toMatchObject({ state: "off" });
    r.join.hear({ cluster: THEIRS });
    await Bun.sleep(30);
    expect(r.asked).toEqual([]);
    // a restart reads it back
    const again = rig({ meta: { [ACCOUNT_META]: "off" } });
    expect(again.join.state()).toMatchObject({ state: "off" });
    again.join.hear({ cluster: THEIRS });
    await Bun.sleep(30);
    expect(again.asked).toEqual([]);
    // the user asks
    await again.join.joinNow();
    expect(again.joined).toEqual([{ invite: "invite-for-node_self", how: "alone" }]);
    expect(again.join.off()).toBe(false);
    expect(again.join.state()).toMatchObject({ state: "joined" });
    // taken out, then let in again with an invite: once the server names it one of them, it is kept apart no more
    const invited = rig({ meta: { [ACCOUNT_META]: "off" } });
    invited.join.hear({ cluster: MINE });
    expect(invited.join.off()).toBe(false);
    expect(invited.join.state()).toBeUndefined();
  });

  test("Join them refused while the switch is off, the server unreachable, or it is one of them already", async () => {
    await expect(rig({ enabled: false }).join.joinNow()).rejects.toThrow(/account_join/);
    await expect(rig({ active: false }).join.joinNow()).rejects.toThrow(/not signed in/);
    const r = rig();
    r.join.hear({ cluster: MINE });
    await expect(r.join.joinNow()).rejects.toThrow(/one of the account's machines already/);
  });
});
