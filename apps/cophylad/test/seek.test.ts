// Seeking the primary, apart from the role: the ways in order (the endpoint a primary named,
// the configured one, the enrollment's, the ones heard newest first, the registry's primary
// then its backups, never this node's own, each once), the relay last or first; and the loop
// that tries them: a refusal naming the primary tries it next, a linked way ends the round
// and resets the wait, a fruitless round waits twice as long each time up to the cap, a round
// that settles things (a promotion) schedules none, and one abandoned runs no more.

import { describe, expect, test } from "bun:test";
import { RpcError } from "@cophyla/protocol";
import { silentLogger } from "../src/log.ts";
import type { LinkTarget } from "../src/nodes/outbound.ts";
import { endpointCandidates, linkCandidates, Seeker } from "../src/nodes/seek.ts";
import { sleep, waitFor } from "./helpers.ts";

const label = (t: LinkTarget) => (t.kind === "direct" ? t.endpoint : "relay");
const relay: LinkTarget = { kind: "relay", open: () => Promise.reject(new Error("no")) };

describe("the ways to the primary", () => {
  test("in order, each once, never this node's own", () => {
    const order = endpointCandidates({
      preferred: "p:1",
      configured: "c:1",
      membership: ["m:1", "p:1"],
      heard: [
        { endpoint: "h:old", heardAt: 1 },
        { endpoint: "h:new", heardAt: 5 },
      ],
      registryPrimary: ["r:p"],
      registryBackups: [["r:b1"], ["r:b2", "self:1"]],
      self: ["self:1"],
    });
    expect(order).toEqual(["p:1", "c:1", "m:1", "h:new", "h:old", "r:p", "r:b1", "r:b2"]);
    expect(endpointCandidates({})).toEqual([]);
  });

  test("the relay last, or first when asked; none without a token", () => {
    expect(linkCandidates({ membership: ["m:1"], relay }).map(label)).toEqual(["m:1", "relay"]);
    expect(linkCandidates({ membership: ["m:1"], relay, relayFirst: true }).map(label)).toEqual(["relay", "m:1"]);
    expect(linkCandidates({ membership: ["m:1"] }).map(label)).toEqual(["m:1"]);
    // a workspace node: no configured primary, no endpoints of its own, the relay alone
    expect(linkCandidates({ relay }).map(label)).toEqual(["relay"]);
  });
});

describe("the loop", () => {
  test("a refusal naming the primary tries it next; linking ends the round", async () => {
    const tried: string[] = [];
    let linked = 0;
    let active = true;
    const s = new Seeker({
      candidates: () => [{ kind: "direct", endpoint: "a:1" }, { kind: "direct", endpoint: "b:1" }],
      connect: async (t) => {
        const e = label(t);
        tried.push(e);
        if (e === "a:1") throw new RpcError("conflict", "not the primary", { primary: "p:9" });
        if (e === "p:9") {
          active = false;
          return;
        }
        throw new Error("no");
      },
      active: () => active,
      reconnectMs: 10,
      reconnectMaxMs: 40,
      linked: () => void linked++,
      log: silentLogger,
    });
    s.kick();
    await waitFor(() => linked === 1);
    expect(tried).toEqual(["a:1", "p:9"]);
    expect(s.seeking).toBe(false);
  });

  test("a fruitless round waits twice as long each time, up to the cap; a settling miss and an abandon stop it", async () => {
    const rounds: number[] = [];
    let misses = 0;
    let settle = false;
    const s = new Seeker({
      candidates: () => [{ kind: "direct", endpoint: "x:1" }],
      connect: async () => {
        rounds.push(Date.now());
        throw new Error("no");
      },
      active: () => true,
      reconnectMs: 20,
      reconnectMaxMs: 80,
      missed: async () => {
        misses++;
        return settle;
      },
      log: silentLogger,
    });
    s.kick();
    await waitFor(() => rounds.length >= 5, 5000, 5);
    const gaps = rounds.slice(1).map((t, i) => t - rounds[i]!);
    // 20, 40, 80, 80: never shorter than the wait asked, and capped
    expect(gaps[0]!).toBeGreaterThanOrEqual(15);
    expect(gaps[1]!).toBeGreaterThanOrEqual(35);
    expect(gaps[2]!).toBeGreaterThanOrEqual(70);
    expect(gaps[3]!).toBeLessThan(80 * 4);
    expect(misses).toBeGreaterThanOrEqual(4);
    // a miss that settles things schedules no round
    settle = true;
    // the round already waiting runs; its miss settles, and none follows
    const missesAtSettle = misses;
    await waitFor(() => misses > missesAtSettle, 2000, 5);
    const n = rounds.length;
    await sleep(250);
    expect(rounds.length).toBe(n);
    // kicked again then abandoned: nothing after
    settle = false;
    const missedBefore = misses;
    s.kick();
    await waitFor(() => rounds.length === n + 1 && misses === missedBefore + 1);
    s.abandon();
    await sleep(250);
    expect(rounds.length).toBe(n + 1);
    s.resetBackoff();
  });
});
