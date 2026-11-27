// The host page's link over fakes of the shell and of the socket: attach asks for the socket and
// opens it, frames and state come over it to the Connection in order while the events of before
// are passed over, sends and log lines go over it, a socket that closes is asked for again, and
// one that never opens leaves the page on the events and commands, batched.

import { describe, expect, test } from "bun:test";
import { Connection, EVENT_STATE } from "@cophyla/viewhost";
import type { LinkSnapshot, TauriIo } from "@cophyla/viewhost";
import { EVENT_FRAMES, PageLink } from "../host/link.ts";
import type { SocketLike } from "../host/link.ts";

const HELLO = { client: { id: "cli_1", kind: "ui", scopes: [], via: "direct", audio: { in: true, out: true }, connectedAt: 1, node: "desk" }, node: "desk", protocolVersion: 1, platformVersion: "0.31.0" };
const URL = "ws://127.0.0.1:5000/secret/link";

class FakeSocket implements SocketLike {
  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  say(data: string): void {
    this.onmessage?.({ data });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function fixture(opts: { socket?: boolean } = {}) {
  const listeners = new Map<string, ((payload: unknown) => void)[]>();
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const sockets: FakeSocket[] = [];
  const shell: TauriIo = {
    invoke: async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ cmd, ...(args ? { args } : {}) });
      if (cmd === "cophylad_attach") return { state: "connecting", since: 1, ...(args?.["socket"] ? { socket: URL } : {}) } as T;
      if (cmd === "cophylad_send") return ((args?.["frames"] as unknown[] | undefined)?.map(() => null) ?? []) as T;
      return undefined as T;
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
  const logs: string[] = [];
  const link = new PageLink({
    io: shell,
    ...(opts.socket === false
      ? {}
      : {
          socket: (url: string) => {
            const s = new FakeSocket(url);
            sockets.push(s);
            return s;
          },
        }),
    log: (m) => logs.push(m),
    retryMs: 5,
  });
  return { link, calls, sockets, emit, logs };
}

const state = (s: Partial<LinkSnapshot> & { state: LinkSnapshot["state"] }) => JSON.stringify(["state", { since: 2, ...s }]);
const note = (n: number) => JSON.stringify({ jsonrpc: "2.0", method: "test.note", params: { n } });

describe("the host page's link", () => {
  test("attach asks for the socket and opens it; frames and state come over it in order, and the events of before are passed over", async () => {
    const { link, calls, sockets, emit } = fixture();
    const conn = new Connection(link, { coalesce: true });
    const frames: unknown[] = [];
    const states: string[] = [];
    conn.onFrame((f) => frames.push((f as { params: { n: number } }).params.n));
    conn.onState((s) => states.push(s.state));
    const snap = await conn.attach({ audio: { in: true } });
    expect(snap).toEqual({ state: "connecting", since: 1 });
    expect(calls[0]).toEqual({ cmd: "cophylad_attach", args: { audio: { in: true }, socket: true } });
    expect(sockets.map((s) => s.url)).toEqual([URL]);
    const ws = sockets[0]!;
    // before it opens, the shell's events are the link
    emit(EVENT_FRAMES, [note(0), note(1)]);
    ws.open();
    // once open, an event the shell sent before the switch is not this connection's
    emit(EVENT_FRAMES, [note(99)]);
    emit(EVENT_STATE, { state: "connected", since: 0 });
    ws.say(state({ state: "connecting" }));
    ws.say(state({ state: "connected", hello: HELLO as never }));
    for (const n of [2, 3, 4]) ws.say(note(n));
    expect(frames).toEqual([0, 1, 2, 3, 4]);
    expect(states).toEqual(["connecting", "connecting", "connected"]);
    expect(conn.connected).toBe(true);
    // requests and notifications go over the socket, a turn's together, in order
    const answer = conn.request<{ ok: boolean }>("session.list");
    void conn.send({ jsonrpc: "2.0", method: "voice.presence", params: { focused: true } });
    await Bun.sleep(0);
    expect(ws.sent.map((t) => JSON.parse(t).method)).toEqual(["session.list", "voice.presence"]);
    ws.say(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(ws.sent[0]!).id, result: { ok: true } }));
    expect(await answer).toEqual({ ok: true });
    // log lines too; other commands go to the shell
    await link.invoke("app_log", { lines: [{ level: "info", message: "hi" }] });
    expect(JSON.parse(ws.sent[2]!)).toEqual(["log", [{ level: "info", message: "hi" }]]);
    await link.invoke("notify_ask", { ask: { id: "a" } });
    expect(calls.map((c) => c.cmd)).toEqual(["cophylad_attach", "notify_ask"]);
  });

  test("the shell's events over the socket reach their listeners, and so do the events Tauri brings", async () => {
    const { link, sockets, emit } = fixture();
    const heard: unknown[] = [];
    await link.listen("voice:ptt", (p) => heard.push(p));
    await link.invoke("cophylad_attach", {});
    sockets[0]!.open();
    sockets[0]!.say(JSON.stringify(["event", "voice:ptt", { down: true, at: 1000 }]));
    emit("voice:ptt", { down: false, at: 1500 });
    sockets[0]!.say(JSON.stringify(["event", "other", {}]));
    expect(heard).toEqual([
      { down: true, at: 1000 },
      { down: false, at: 1500 },
    ]);
  });

  test("a socket that closes falls back to the events and is asked for again; one that never opens leaves the page on them", async () => {
    const { link, calls, sockets, emit, logs } = fixture();
    const conn = new Connection(link, { coalesce: true });
    const frames: number[] = [];
    const states: string[] = [];
    conn.onFrame((f) => frames.push((f as { params: { n: number } }).params.n));
    conn.onState((s) => states.push(s.state));
    await conn.attach();
    sockets[0]!.open();
    sockets[0]!.say(state({ state: "connected", hello: HELLO as never }));
    sockets[0]!.drop();
    // closed: the events are the link again, and sends go by the command
    emit(EVENT_FRAMES, [note(7)]);
    emit(EVENT_STATE, { state: "connected", hello: HELLO, since: 3 });
    void conn.send({ jsonrpc: "2.0", method: "voice.presence" });
    await Bun.sleep(0);
    expect(calls.at(-1)).toEqual({ cmd: "cophylad_send", args: { frames: [{ jsonrpc: "2.0", method: "voice.presence" }] } });
    expect(frames).toEqual([7]);
    // asked for again: a new socket, and the state the attach answers
    await Bun.sleep(20);
    expect(calls.filter((c) => c.cmd === "cophylad_attach").map((c) => c.args?.["socket"])).toEqual([true, true]);
    expect(sockets).toHaveLength(2);
    expect(states.at(-1)).toBe("connecting");
    // this one never opens: the page attaches without a socket, for good
    sockets[1]!.drop();
    await Bun.sleep(0);
    expect(calls.filter((c) => c.cmd === "cophylad_attach").at(-1)?.args?.["socket"]).toBeUndefined();
    expect(logs.some((l) => l.includes("did not open"))).toBe(true);
    await link.invoke("cophylad_attach", {});
    expect(sockets).toHaveLength(2);
  });

  test("a page with no socket of its own never asks for one", async () => {
    const { link, calls } = fixture({ socket: false });
    await link.invoke("cophylad_attach", { webTabs: true });
    expect(calls).toEqual([{ cmd: "cophylad_attach", args: { webTabs: true } }]);
  });
});
