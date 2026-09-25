// The host's connection over a fake shell: attach subscribes then asks for the state,
// requests are answered by id, time out, and fail with unavailable when the link drops;
// hello is refused by the shell and surfaced as denied.

import { describe, expect, test } from "bun:test";
import { RpcError } from "@cophyla/protocol";
import { Connection, EVENT_FRAME, EVENT_STATE } from "../src/connection.ts";
import type { LinkSnapshot, TauriIo } from "../src/connection.ts";

const HELLO = { client: { id: "cli_1", kind: "ui", scopes: ["sessions:read"], via: "direct", audio: { in: false, out: false }, connectedAt: 1 }, node: "node_1", protocolVersion: 1, platformVersion: "0.1.0" };

function fakeShell(initial: LinkSnapshot) {
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  const sent: unknown[] = [];
  const calls: string[] = [];
  const io: TauriIo = {
    invoke: async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push(cmd);
      if (cmd === "cophylad_attach") return initial as T;
      if (cmd === "cophylad_send") {
        const frame = args?.["frame"] as { method?: string };
        if (frame.method === "hello") throw "denied: hello is sent by the shell";
        if (initial.state !== "connected") throw "unavailable: not connected to cophylad";
        sent.push(frame);
        return undefined as T;
      }
      throw new Error(`unexpected ${cmd}`);
    },
    listen: async <T>(event: string, handler: (payload: T) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(handler as (p: unknown) => void);
      listeners.set(event, list);
      return () => {};
    },
  };
  const emit = (event: string, payload: unknown) => {
    for (const h of listeners.get(event) ?? []) h(payload);
  };
  return { io, emit, sent, calls, listeners };
}

const connected: LinkSnapshot = { state: "connected", hello: HELLO as never, since: 1, url: "ws://127.0.0.1:4817/ws/client" };

describe("connection", () => {
  test("attach subscribes to both events before asking for the state", async () => {
    const shell = fakeShell(connected);
    const conn = new Connection(shell.io);
    const states: string[] = [];
    conn.onState((s) => states.push(s.state));
    const snap = await conn.attach();
    expect(snap.state).toBe("connected");
    expect(conn.connected).toBe(true);
    expect(shell.calls).toEqual(["cophylad_attach"]);
    expect([...shell.listeners.keys()].sort()).toEqual([EVENT_FRAME, EVENT_STATE].sort());
    expect(states).toEqual(["connected"]);
    await conn.attach();
    expect(shell.listeners.get(EVENT_FRAME)).toHaveLength(1);
  });

  test("a request is sent with an h<n> id and settled by the matching response; other frames go to onFrame", async () => {
    const shell = fakeShell(connected);
    const conn = new Connection(shell.io);
    await conn.attach();
    const frames: unknown[] = [];
    conn.onFrame((f) => frames.push(f));
    const p = conn.request<{ sessions: unknown[] }>("session.list", {});
    expect(shell.sent[0]).toEqual({ jsonrpc: "2.0", id: "h1", method: "session.list", params: {} });
    shell.emit(EVENT_FRAME, JSON.stringify({ jsonrpc: "2.0", method: "session.state", params: { id: "sess_1" } }));
    shell.emit(EVENT_FRAME, JSON.stringify({ jsonrpc: "2.0", id: "v1-1", result: {} }));
    shell.emit(EVENT_FRAME, JSON.stringify({ jsonrpc: "2.0", id: "h1", result: { sessions: [] } }));
    expect(await p).toEqual({ sessions: [] });
    expect(frames).toHaveLength(2);
    expect((frames[0] as { method: string }).method).toBe("session.state");
    expect((frames[1] as { id: string }).id).toBe("v1-1");
    // Junk is dropped.
    shell.emit(EVENT_FRAME, "{not json");
    shell.emit(EVENT_FRAME, JSON.stringify({ hello: "world" }));
    expect(frames).toHaveLength(2);
  });

  test("an error response rejects with the protocol error", async () => {
    const shell = fakeShell(connected);
    const conn = new Connection(shell.io);
    await conn.attach();
    const p = conn.request("session.history", { id: "sess_x" });
    shell.emit(EVENT_FRAME, JSON.stringify({ jsonrpc: "2.0", id: "h1", error: { code: -32004, message: "no session", data: { code: "not_found", message: "no session sess_x", retryable: false } } }));
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe("not_found");
  });

  test("a request times out", async () => {
    const shell = fakeShell(connected);
    const conn = new Connection(shell.io, { timeoutMs: 20 });
    await conn.attach();
    const err = await conn.request("session.list").catch((e: unknown) => e);
    expect((err as RpcError).code).toBe("timeout");
  });

  test("pending requests fail with unavailable when the link drops, and nothing can be sent until it is back", async () => {
    const shell = fakeShell(connected);
    const conn = new Connection(shell.io);
    await conn.attach();
    const p = conn.request("session.list");
    shell.emit(EVENT_STATE, { state: "disconnected", since: 2, error: "cophylad closed the socket" });
    const err = await p.catch((e: unknown) => e);
    expect((err as RpcError).code).toBe("unavailable");
    expect((err as RpcError).message).toContain("cophylad closed the socket");
    expect(conn.connected).toBe(false);
    const refused = await conn.request("session.list").catch((e: unknown) => e);
    expect((refused as RpcError).code).toBe("unavailable");
    shell.emit(EVENT_STATE, connected);
    expect(conn.connected).toBe(true);
  });

  test("hello is refused by the shell as denied", async () => {
    const shell = fakeShell(connected);
    const conn = new Connection(shell.io);
    await conn.attach();
    const err = await conn.send({ jsonrpc: "2.0", id: "h9", method: "hello", params: {} }).catch((e: unknown) => e);
    expect((err as RpcError).code).toBe("denied");
    expect(shell.sent).toEqual([]);
  });

  test("a starting link reports its state and requests are refused", async () => {
    const shell = fakeShell({ state: "starting", since: 1, error: "started cophylad (pid 1)" });
    const conn = new Connection(shell.io);
    const snap = await conn.attach();
    expect(snap.state).toBe("starting");
    const err = await conn.request("session.list").catch((e: unknown) => e);
    expect((err as RpcError).code).toBe("unavailable");
  });
});
