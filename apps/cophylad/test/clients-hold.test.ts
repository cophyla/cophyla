// The client registry holding a phone for its return, over fake sockets: out of sight, what it
// would be sent is kept in order and sent once it is back; speech is not kept; a machine's
// samples fold into one with the profiles' spend summed; a held phone is no one's audience and
// its terminals read its socket as full; a socket that closes holds it until a hello takes it
// up on another; past its time or past what is kept it is let go; and a revoke reaches it.

import { describe, expect, test } from "bun:test";
import type { Client, MetricsSample } from "@cophyla/protocol";
import { ClientRegistry, CLOSE_HOLD_ENDED } from "../src/api/clients.ts";
import type { HoldDeps } from "../src/api/clients.ts";

const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const PHONE = "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC1";

interface FakeSocket {
  heard: { method?: string; params?: unknown }[];
  closed?: { code?: number; reason?: string };
  owner: object;
  socket: { send(data: string): void; close(code?: number, reason?: string): void; buffered(): number };
}

function socket(): FakeSocket {
  const s: FakeSocket = {
    heard: [],
    owner: {},
    socket: {
      send: (data) => s.heard.push(JSON.parse(data) as { method?: string; params?: unknown }),
      close: (code, reason) => (s.closed = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) }),
      buffered: () => 0,
    },
  };
  return s;
}

function phone(id: string): Client {
  return { id, kind: "controller", controller: PHONE, scopes: ["chat", "sessions:read", "metrics:read", "voice", "asks:answer"], via: "relay", audio: { in: true, out: true }, connectedAt: 1 };
}

function setup(deps: Partial<HoldDeps> = {}) {
  const registry = new ClientRegistry();
  const told: string[] = [];
  registry.enableHolds({
    away: (c) => told.push(`away ${c.id}`),
    parked: (c) => told.push(`parked ${c.id}`),
    gone: (c, parked) => told.push(`gone ${c.id}${parked ? " parked" : ""}`),
    ...deps,
  });
  const first = socket();
  registry.add(phone("cli_phone"), first.socket, "cloud", first.owner);
  return { registry, told, first };
}

const ask = (title: string) => ({ id: `ask_${title}`, type: "choice", source: { kind: "brain" }, title, options: [{ id: "y", label: "Yes" }], answerableBy: ["user"], status: "open", createdAt: 1 }) as never;

const sample = (at: number, profiles?: MetricsSample["profiles"], node = NODE): MetricsSample => ({ node, at, cpu: at, memory: { used: at, total: 100 }, processes: [], llm: {}, ...(profiles ? { profiles } : {}) });

describe("client registry: a phone out of sight", () => {
  test("what it would be sent is kept in order and sent once it is back; speech is not kept", () => {
    const { registry, told, first } = setup();
    registry.broadcast("ask.state", ask("before"));
    expect(registry.goAway("cli_phone")).toBe(true);
    expect(told).toEqual(["away cli_phone"]);
    registry.broadcast("ask.state", ask("one"));
    registry.send("cli_phone", "voice.audio", { seq: 0, data: "AAAA", codec: "pcm" } as never);
    registry.broadcast("ask.state", ask("two"));
    expect(first.heard.map((f) => (f.params as { title: string }).title)).toEqual(["before"]);
    expect(registry.comeBack("cli_phone")).toBe(true);
    expect(first.heard.map((f) => (f.params as { title: string }).title)).toEqual(["before", "one", "two"]);
    // and from here on it is sent straight
    registry.broadcast("ask.state", ask("three"));
    expect(first.heard).toHaveLength(4);
    expect(registry.held("cli_phone")).toBeUndefined();
  });

  test("a machine's samples fold into one: the latest reading, what each profile spent summed", () => {
    const { registry, first } = setup();
    registry.goAway("cli_phone");
    registry.send("cli_phone", "metrics.sample", { ...sample(1, { p1: { in: 10, out: 1, cached: 0, cost: 0.5 } }), llm: { "gemini-3.8-flash": { in: 100, out: 10 } } });
    registry.send("cli_phone", "metrics.sample", sample(2, { other: { in: 3, out: 3, cached: 3 } }, OTHER_NODE));
    registry.send("cli_phone", "metrics.sample", sample(3));
    registry.send("cli_phone", "metrics.sample", { ...sample(4, { p1: { in: 5, out: 2, cached: 7, cost: 0.25 }, p2: { in: 1, out: 1, cached: 1 } }), llm: { "gemini-3.8-flash": { in: 1, out: 1 } } });
    registry.comeBack("cli_phone");
    expect(first.heard.map((f) => f.method)).toEqual(["metrics.sample", "metrics.sample"]);
    const mine = first.heard[0]!.params as MetricsSample;
    expect(mine.at).toBe(4);
    expect(mine.cpu).toBe(4);
    expect(mine.profiles).toEqual({ p1: { in: 15, out: 3, cached: 7, cost: 0.75 }, p2: { in: 1, out: 1, cached: 1 } });
    expect(mine.llm).toEqual({ "gemini-3.8-flash": { in: 101, out: 11 } });
    expect((first.heard[1]!.params as MetricsSample).node).toBe(OTHER_NODE);
  });

  test("held, it is no one's audience: not listed, not counted as the phone being there; its socket reads as full", () => {
    const { registry } = setup();
    expect(registry.list().map((c) => c.id)).toEqual(["cli_phone"]);
    expect(registry.byController(PHONE)).toHaveLength(1);
    registry.goAway("cli_phone");
    expect(registry.list()).toEqual([]);
    expect(registry.byController(PHONE)).toHaveLength(0);
    expect(registry.byController(PHONE, { held: true })).toHaveLength(1);
    expect(registry.get("cli_phone")!.socket.buffered!()).toBeGreaterThan(1e12);
    registry.comeBack("cli_phone");
    expect(registry.get("cli_phone")!.socket.buffered!()).toBe(0);
  });

  test("past what is kept it is let go: its socket closed with the hold's code, and its close ends nothing more", () => {
    const { registry, told, first } = setup({ maxBytes: 600 });
    registry.goAway("cli_phone");
    for (let i = 0; i < 10; i++) registry.broadcast("ask.state", ask(`t${i}`));
    expect(first.closed?.code).toBe(CLOSE_HOLD_ENDED);
    expect(registry.get("cli_phone")).toBeUndefined();
    expect(registry.endedOn(first.owner)).toBe(true);
    expect(told).toEqual(["away cli_phone", "gone cli_phone"]);
  });

  test("a registry without holds holds nothing", () => {
    const registry = new ClientRegistry();
    const s = socket();
    registry.add(phone("cli_phone"), s.socket, "cloud", s.owner);
    expect(registry.goAway("cli_phone")).toBe(false);
    expect(registry.park("cli_phone", s.owner)).toBe(false);
  });
});

describe("client registry: a phone whose socket closed", () => {
  test("held until a hello takes it up on another socket: what was kept comes back, and the new socket carries it", () => {
    const { registry, told, first } = setup();
    expect(registry.park("cli_phone", {})).toBe(false);
    expect(registry.park("cli_phone", first.owner)).toBe(true);
    expect(registry.held("cli_phone")).toBe("parked");
    registry.broadcast("ask.state", ask("missed"));
    const second = socket();
    expect(registry.resume("cli_phone", { controller: "ctl_other", kind: "controller" }, second.socket, "controller", second.owner)).toBeUndefined();
    const taken = registry.resume("cli_phone", { controller: PHONE, kind: "controller" }, second.socket, "controller", second.owner)!;
    expect(taken.frames.map((f) => (JSON.parse(f) as { params: { title: string } }).params.title)).toEqual(["missed"]);
    expect(registry.get("cli_phone")!.listener).toBe("controller");
    expect(registry.get("cli_phone")!.owner).toBe(second.owner);
    registry.broadcast("ask.state", ask("after"));
    expect(second.heard).toHaveLength(1);
    expect(first.heard).toHaveLength(0);
    expect(told).toEqual(["parked cli_phone"]);
  });

  test("away first, then its socket gone: one hold, kept whole; a resume hands the dead socket over to be closed", () => {
    const { registry, first } = setup();
    registry.goAway("cli_phone");
    registry.broadcast("ask.state", ask("one"));
    const second = socket();
    const taken = registry.resume("cli_phone", { controller: PHONE, kind: "controller" }, second.socket, "cloud", second.owner)!;
    expect(taken.frames).toHaveLength(1);
    taken.stale!.close(1000, "taken up on another connection");
    expect(first.closed?.code).toBe(1000);
  });

  test("past its time it is let go, and nothing is left of it", async () => {
    const { registry, told, first } = setup({ holdMs: 30 });
    registry.park("cli_phone", first.owner);
    await Bun.sleep(80);
    expect(registry.get("cli_phone")).toBeUndefined();
    expect(told).toEqual(["parked cli_phone", "gone cli_phone parked"]);
  });

  test("a revoke reaches it: closing a parked client lets it go", () => {
    const { registry, told, first } = setup();
    registry.park("cli_phone", first.owner);
    registry.close("cli_phone", 4401, "controller revoked");
    expect(registry.get("cli_phone")).toBeUndefined();
    expect(told).toEqual(["parked cli_phone", "gone cli_phone parked"]);
  });
});
