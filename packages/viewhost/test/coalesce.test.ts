// The connection's outbound coalescing, over a fake shell that answers `cophylad_send` batches
// late and out of turn: the frames of one turn go as one batch, a batch waits for the one before
// it, so cophylad gets every frame in the order sent, and each sender hears its own frame's error.

import { describe, expect, test } from "bun:test";
import { RpcError } from "@cophyla/protocol";
import { Connection } from "../src/connection.ts";
import type { LinkSnapshot, TauriIo } from "../src/connection.ts";

const HELLO = { client: { id: "cli_1", kind: "ui", scopes: ["sessions:read"], via: "direct", audio: { in: false, out: false }, connectedAt: 1 }, node: "node_1", protocolVersion: 1, platformVersion: "0.1.0" };
const connected: LinkSnapshot = { state: "connected", hello: HELLO as never, since: 1 };

/** A shell whose batches are answered when the test says, the later one first if it likes. */
function slowShell() {
  const batches: { frames: { n?: number; method?: string }[]; answer: (errors: (string | null)[]) => void; fail: (e: unknown) => void }[] = [];
  const delivered: number[] = [];
  const io: TauriIo = {
    invoke: <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      if (cmd === "cophylad_attach") return Promise.resolve(connected as T);
      if (cmd !== "cophylad_send") return Promise.reject(new Error(`unexpected ${cmd}`));
      const frames = (args?.["frames"] ?? []) as { n?: number; method?: string }[];
      return new Promise<T>((resolve, reject) => {
        batches.push({
          frames,
          answer: (errors) => {
            for (const f of frames) if (typeof f.n === "number") delivered.push(f.n);
            resolve(errors as T);
          },
          fail: reject,
        });
      });
    },
    listen: async () => () => {},
  };
  return { io, batches, delivered };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("connection coalescing", () => {
  test("the frames of one turn go as one batch, and the next batch waits for its answer", async () => {
    const shell = slowShell();
    const conn = new Connection(shell.io, { coalesce: true });
    await conn.attach();
    const sends = [0, 1, 2].map((n) => conn.send({ jsonrpc: "2.0", method: "voice.audio", n }));
    await tick();
    expect(shell.batches.map((b) => b.frames.map((f) => f.n))).toEqual([[0, 1, 2]]);
    // sent while the first batch is out: they wait, and go together after it
    const later = [3, 4].map((n) => conn.send({ jsonrpc: "2.0", method: "voice.audio", n }));
    await tick();
    const more = conn.send({ jsonrpc: "2.0", method: "voice.audio", n: 5 });
    await tick();
    expect(shell.batches).toHaveLength(1);
    shell.batches[0]!.answer([null, null, null]);
    await Promise.all(sends);
    await tick();
    expect(shell.batches.map((b) => b.frames.map((f) => f.n))).toEqual([[0, 1, 2], [3, 4, 5]]);
    shell.batches[1]!.answer([null, null, null]);
    await Promise.all([...later, more]);
    expect(shell.delivered).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test("each frame's error rejects its own sender, and a failed batch rejects all of it", async () => {
    const shell = slowShell();
    const conn = new Connection(shell.io, { coalesce: true });
    await conn.attach();
    const ok = conn.send({ jsonrpc: "2.0", method: "voice.presence", n: 1 });
    const hello = conn.send({ jsonrpc: "2.0", method: "hello" });
    const request = conn.request("session.list");
    await tick();
    expect(shell.batches[0]!.frames.map((f) => f.method)).toEqual(["voice.presence", "hello", "session.list"]);
    shell.batches[0]!.answer([null, "denied: hello is sent by the shell", "unavailable: outbound queue is full"]);
    await ok;
    const denied = await hello.catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(RpcError);
    expect((denied as RpcError).code).toBe("denied");
    const full = await request.catch((e: unknown) => e);
    expect((full as RpcError).code).toBe("unavailable");
    // the command itself failing: every frame of the batch hears it
    const a = conn.send({ jsonrpc: "2.0", method: "a" });
    const b = conn.send({ jsonrpc: "2.0", method: "b" });
    await tick();
    shell.batches[1]!.fail("unavailable: link task is gone");
    for (const p of [a, b]) expect(((await p.catch((e: unknown) => e)) as RpcError).code).toBe("unavailable");
    // and the next send starts a batch of its own again
    const c = conn.send({ jsonrpc: "2.0", method: "c" });
    await tick();
    expect(shell.batches).toHaveLength(3);
    shell.batches[2]!.answer([null]);
    await c;
  });

  test("without coalesce, each frame is its own command, as the controller's link takes it", async () => {
    const calls: Record<string, unknown>[] = [];
    const io: TauriIo = {
      invoke: async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
        if (cmd === "cophylad_attach") return connected as T;
        calls.push(args ?? {});
        return undefined as T;
      },
      listen: async () => () => {},
    };
    const conn = new Connection(io);
    await conn.attach();
    await Promise.all([conn.send({ jsonrpc: "2.0", method: "a" }), conn.send({ jsonrpc: "2.0", method: "b" })]);
    expect(calls).toEqual([{ frame: { jsonrpc: "2.0", method: "a" } }, { frame: { jsonrpc: "2.0", method: "b" } }]);
  });
});
