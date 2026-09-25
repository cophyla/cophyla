// `RpcPeer` over an in-memory pair: a request answered by the other side, a notification
// heard, a peer error carried as a protocol error, a timeout, an abort, and a close that
// rejects what is in flight and refuses what comes after.

import { describe, expect, test } from "bun:test";
import { RpcError } from "@cophyla/protocol";
import { silentLogger } from "../src/log.ts";
import { ChildRpcError, RpcPeer } from "../src/rpc/peer.ts";

/** Two peers wired to each other, frames delivered on the next tick like a socket would. */
function pair(opts: { onRequestB?: (method: string, params: unknown) => unknown; onNotificationB?: (method: string, params: unknown) => void } = {}) {
  const a: RpcPeer = new RpcPeer({ write: (t) => (queueMicrotask(() => b.onText(t)), true), log: silentLogger, label: "a" });
  const b: RpcPeer = new RpcPeer({
    write: (t) => (queueMicrotask(() => a.onText(t)), true),
    log: silentLogger,
    label: "b",
    ...(opts.onRequestB ? { onRequest: opts.onRequestB } : {}),
    ...(opts.onNotificationB ? { onNotification: opts.onNotificationB } : {}),
  });
  return { a, b };
}

describe("rpc peer", () => {
  test("request and response, notification, and an error carried as a protocol error", async () => {
    const heard: unknown[] = [];
    const { a } = pair({
      onRequestB: (method, params) => {
        if (method === "echo") return { got: params };
        if (method === "fail") throw new RpcError("not_found", "nothing here", { extra: 1 });
        throw new Error("boom");
      },
      onNotificationB: (method, params) => heard.push([method, params]),
    });
    expect(await a.request("echo", { x: 1 })).toEqual({ got: { x: 1 } });
    a.notify("hi", { y: 2 });
    await Bun.sleep(1);
    expect(heard).toEqual([["hi", { y: 2 }]]);
    const err = await a.request("fail").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChildRpcError);
    expect((err as ChildRpcError).code).toBe("not_found");
    expect((err as ChildRpcError).message).toBe("nothing here");
    const plain = await a.request("other").catch((e: unknown) => e);
    expect((plain as RpcError).code).toBe("unavailable");
    expect((plain as RpcError).message).toBe("boom");
    // A peer with no request handler answers unsupported.
    const { a: c } = pair();
    const unsupported = await c.request("anything").catch((e: unknown) => e);
    expect((unsupported as RpcError).code).toBe("unsupported");
  });

  test("timeout and abort reject with their codes and clear the pending entry", async () => {
    const { a } = pair({ onRequestB: () => new Promise(() => {}) });
    const t = await a.request("slow", {}, { timeoutMs: 20 }).catch((e: unknown) => e);
    expect((t as RpcError).code).toBe("timeout");
    const ac = new AbortController();
    const p = a.request("slow", {}, { signal: ac.signal }).catch((e: unknown) => e);
    expect(a.inflight).toBe(1);
    ac.abort();
    expect((await p) as RpcError).toMatchObject({ code: "cancelled" });
    expect(a.inflight).toBe(0);
    const already = await a.request("slow", {}, { signal: ac.signal }).catch((e: unknown) => e);
    expect((already as RpcError).code).toBe("cancelled");
  });

  test("close rejects what is in flight with unavailable and refuses later requests; a failed write does too", async () => {
    const { a } = pair({ onRequestB: () => new Promise(() => {}) });
    const p = a.request("slow").catch((e: unknown) => e);
    a.close("link dropped");
    expect(a.open).toBe(false);
    expect((await p) as RpcError).toMatchObject({ code: "unavailable", message: "slow: link dropped" });
    const later = await a.request("x").catch((e: unknown) => e);
    expect((later as RpcError).message).toBe("x: link dropped");
    expect(a.notify("n")).toBe(false);
    const dead = new RpcPeer({ write: () => false, log: silentLogger });
    const w = await dead.request("x").catch((e: unknown) => e);
    expect((w as RpcError).code).toBe("unavailable");
    expect(dead.inflight).toBe(0);
  });
});
