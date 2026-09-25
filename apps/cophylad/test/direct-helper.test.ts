// The helper process over a fake cophyla-net: `hello` then `net.configure` on the kept port,
// a taken port traded for a new one (and kept), a crash started again after a backoff that
// doubles, five exits within five minutes left unavailable with the helper's last words, a
// helper of another protocol never retried, and a stop that says `shutdown` first.

import { describe, expect, test } from "bun:test";
import { NetHelper } from "../src/direct/helper.ts";
import type { HelperStatus } from "../src/direct/helper.ts";
import { silentLogger } from "../src/log.ts";
import { FakeNet } from "./fakes/net.ts";
import { waitFor } from "./helpers.ts";

function harness(opts: { port?: number; backoffMs?: number } = {}) {
  const net = new FakeNet();
  const statuses: HelperStatus[] = [];
  const kept: number[] = [];
  const notes: [string, unknown][] = [];
  let now = 1_000_000;
  const helper = new NetHelper({
    command: "cophyla-net",
    env: {},
    log: silentLogger,
    configure: (port) => ({ port, stun: ["stun:example.test:3478"], predict: 12, map: true, ipv6: true }),
    port: () => kept.at(-1) ?? opts.port ?? 0,
    onPort: (p) => kept.push(p),
    onStatus: (s) => statuses.push(s),
    onNotification: (m, p) => notes.push([m, p]),
    backoffMs: opts.backoffMs ?? 5,
    backoffMaxMs: 40,
    spawn: net.spawn,
    now: () => now,
  });
  return { net, helper, statuses, kept, notes, tick: (ms: number) => (now += ms) };
}

describe("the direct helper", () => {
  test("hello, then configured on the kept port; ready with its addresses; its notifications come through", async () => {
    const { net, helper, statuses, kept, notes } = harness({ port: 40_123 });
    helper.start();
    await waitFor(() => helper.status.state === "ready");
    expect(statuses.map((s) => s.state)).toEqual(["starting", "ready"]);
    expect(helper.status).toEqual({ state: "ready", port: 40_123, addresses: ["192.0.2.10:40123"], version: "0.1.0-fake" });
    expect(net.live!.requests.map((r) => r.method)).toEqual(["hello", "net.configure"]);
    expect(net.live!.requests[1]!.params).toMatchObject({ port: 40_123, stun: ["stun:example.test:3478"], predict: 12 });
    expect(kept).toEqual([40_123]);
    await waitFor(() => notes.some(([m]) => m === "net.state"));
    expect(helper.pid).toBe(net.live!.pid);
    await expect(helper.request("peer.offer", { peer: "p1" })).resolves.toEqual({ sdp: "fake-offer:p1" });
  });

  test("a kept port that is taken now: a new one, and that one kept", async () => {
    const { net, helper, kept } = harness({ port: 40_123 });
    net.takenPorts.add(40_123);
    helper.start();
    await waitFor(() => helper.status.state === "ready");
    expect(net.live!.requests.filter((r) => r.method === "net.configure").map((r) => r.params["port"])).toEqual([40_123, 0]);
    expect(kept).toEqual([50_000]);
  });

  test("a crash starts it again after a backoff that doubles; five within five minutes leave it unavailable with its last words", async () => {
    const { net, helper, statuses, tick } = harness();
    helper.start();
    await waitFor(() => helper.status.state === "ready");
    for (let i = 1; i <= 4; i++) {
      net.live!.crash();
      await waitFor(() => net.helpers.length === i + 1 && helper.status.state === "ready");
      tick(10_000);
    }
    const restarts = statuses.filter((s): s is { state: "starting"; reason: string } => s.state === "starting" && s.reason !== undefined);
    expect(restarts).toHaveLength(4);
    expect(restarts[0]!.reason).toBe("the helper exited (101); starting it again");
    net.live!.crash(JSON.stringify({ level: "error", msg: "no usable address" }));
    await waitFor(() => helper.status.state === "unavailable");
    expect(helper.status).toEqual({ state: "unavailable", reason: "the helper exited 5 times in five minutes: no usable address" });
    await Bun.sleep(100);
    expect(net.helpers).toHaveLength(5);
    await expect(helper.request("peer.offer", { peer: "p" })).rejects.toThrow("not running");
    expect(statuses.filter((s) => s.state === "ready")).toHaveLength(5);
  });

  test("exits spread over more than five minutes never add up to five", async () => {
    const { net, helper, tick } = harness();
    helper.start();
    for (let i = 0; i < 7; i++) {
      await waitFor(() => net.helpers.length === i + 1 && helper.status.state === "ready");
      net.live!.crash();
      tick(90_000);
    }
    await waitFor(() => net.helpers.length === 8 && helper.status.state === "ready");
  });

  test("a helper of another protocol is left unavailable and not tried again", async () => {
    const { net, helper } = harness();
    net.protocol = 2;
    helper.start();
    await waitFor(() => helper.status.state === "unavailable");
    expect(helper.status).toEqual({ state: "unavailable", reason: "the helper speaks protocol 2, this node 1" });
    await Bun.sleep(60);
    expect(net.helpers).toHaveLength(1);
    expect(net.helpers[0]!.exited).toBe(true);
  });

  test("a binary that will not start counts as an exit; stop says shutdown and hears nothing after", async () => {
    const { net, helper, statuses } = harness();
    net.failSpawn = "ENOENT";
    helper.start();
    await waitFor(() => statuses.some((s) => s.state === "starting" && s.reason === "the helper could not be started (ENOENT); starting it again"));
    net.failSpawn = undefined;
    await waitFor(() => helper.status.state === "ready");
    const live = net.live!;
    await helper.stop();
    expect(live.notified.map((n) => n.method)).toEqual(["shutdown"]);
    expect(helper.status).toEqual({ state: "stopped" });
    live.emit("peer.open", { peer: "late" });
    await Bun.sleep(30);
    expect(net.helpers).toHaveLength(1);
  });
});
