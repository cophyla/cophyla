// StdioRpc over an echo child: requests and responses, notifications both ways, requests
// from the child answered or failed from `onRequest`, abort → cancelled, timeout → timeout,
// exit → every pending request rejected with unavailable, stderr kept.

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { RpcError } from "@cophyla/protocol";
import { silentLogger } from "../src/log.ts";
import { ChildRpcError, StdioRpc } from "../src/rpc/stdio.ts";
import { sleep, waitFor } from "./helpers.ts";

const FAKE = join(import.meta.dir, "fakes", "echo-rpc.ts");

function spawnEcho(extra: Partial<ConstructorParameters<typeof StdioRpc>[0]> = {}): StdioRpc {
  return new StdioRpc({ command: process.execPath, args: [FAKE], env: process.env, log: silentLogger, ...extra });
}

const children: StdioRpc[] = [];
afterAll(async () => {
  for (const c of children) if (c.alive) c.kill();
});

describe("stdio rpc", () => {
  test("request/response, notifications both ways, stderr tail", async () => {
    const pongs: unknown[] = [];
    const rpc = spawnEcho({ onNotification: (m, p) => pongs.push({ m, p }) });
    children.push(rpc);
    expect(await rpc.request("echo", { a: 1 })).toEqual({ a: 1 });
    expect(await rpc.request("echo")).toEqual({});
    rpc.notify("ping", { x: 2 });
    await waitFor(() => pongs.length === 1);
    expect(pongs[0]).toEqual({ m: "pong", p: { x: 2 } });
    await waitFor(() => rpc.stderr.includes("echo-rpc ready"));
    expect(rpc.pid).toBeGreaterThan(0);
    await rpc.stop();
    expect(rpc.alive).toBe(false);
  });

  test("a child error is a ChildRpcError carrying the protocol code", async () => {
    const rpc = spawnEcho();
    children.push(rpc);
    const e = await rpc.request("fail").catch((x) => x);
    expect(e).toBeInstanceOf(ChildRpcError);
    expect((e as RpcError).code).toBe("not_found");
    const unknown = await rpc.request("nope").catch((x) => x);
    expect((unknown as RpcError).code).toBe("unavailable");
    await rpc.stop();
  });

  test("requests from the child are served by onRequest; a thrown RpcError becomes a failure", async () => {
    const rpc = spawnEcho({
      onRequest: (method, params) => {
        if (method === "question") return { got: params };
        throw new RpcError("denied", "no");
      },
    });
    children.push(rpc);
    expect(await rpc.request("ask", { method: "question", params: { q: 1 } })).toEqual({ answer: { result: { got: { q: 1 } } } });
    const failed = (await rpc.request("ask", { method: "other" })) as { answer: { error: { code: number; data: { code: string } } } };
    expect(failed.answer.error.code).toBe(-32001);
    expect(failed.answer.error.data.code).toBe("denied");
    await rpc.stop();
    // Without a handler, a request from the child is unsupported.
    const bare = spawnEcho();
    children.push(bare);
    const r = (await bare.request("ask", { method: "x" })) as { answer: { error: { data: { code: string } } } };
    expect(r.answer.error.data.code).toBe("unsupported");
    await bare.stop();
  });

  test("abort → cancelled, timeout → timeout, no default timeout", async () => {
    const rpc = spawnEcho();
    children.push(rpc);
    const ac = new AbortController();
    const p = rpc.request("slow", { ms: 0 }, { signal: ac.signal });
    await sleep(30);
    ac.abort();
    const e = await p.catch((x) => x);
    expect((e as RpcError).code).toBe("cancelled");
    const t = await rpc.request("slow", { ms: 0 }, { timeoutMs: 50 }).catch((x) => x);
    expect((t as RpcError).code).toBe("timeout");
    // A request that does answer within its timeout is fine, and one without a timeout waits.
    expect(await rpc.request("slow", { ms: 20 }, { timeoutMs: 1000 })).toEqual({ slept: 20 });
    expect(await rpc.request("slow", { ms: 120 })).toEqual({ slept: 120 });
    // An already-aborted signal fails at once without writing.
    const pre = new AbortController();
    pre.abort();
    const early = await rpc.request("echo", {}, { signal: pre.signal }).catch((x) => x);
    expect((early as RpcError).code).toBe("cancelled");
    await rpc.stop();
  });

  test("exit rejects pending requests with unavailable and reports the exit", async () => {
    let exited: { code: number | null; signal: string | null } | undefined;
    const rpc = spawnEcho({ onExit: (code, signal) => (exited = { code, signal }) });
    children.push(rpc);
    const hanging = rpc.request("slow", { ms: 0 });
    await rpc.request("exit", { code: 3 });
    const e = await hanging.catch((x) => x);
    expect((e as RpcError).code).toBe("unavailable");
    await waitFor(() => exited !== undefined);
    expect(exited!.code).toBe(3);
    expect(rpc.alive).toBe(false);
    expect(rpc.exit).toEqual({ code: 3, signal: null });
    const late = await rpc.request("echo").catch((x) => x);
    expect((late as RpcError).code).toBe("unavailable");
    expect(rpc.notify("ping")).toBe(false);
  });

  test("a command that cannot start reports an exit and rejects", async () => {
    const rpc = new StdioRpc({ command: join(import.meta.dir, "no-such-binary.exe"), args: [], env: process.env, log: silentLogger });
    children.push(rpc);
    const e = await rpc.request("echo").catch((x) => x);
    expect((e as RpcError).code).toBe("unavailable");
    await waitFor(() => !rpc.alive);
  });
});
