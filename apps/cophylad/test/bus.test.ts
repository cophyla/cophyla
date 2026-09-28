// The bus kept apart by partition: an event is the machine's unless its payload names a
// workspace node (its `node`, its `id`, or for `session.event` its session's node); `on`
// hears the machine's alone, `for(g)` one workspace node's, `onAll` every one. What a
// workspace node raises through `for(g)` never reaches `on`, whatever ids it carries, and the
// handlers run in the order they were added.

import { describe, expect, test } from "bun:test";
import { newId } from "@cophyla/protocol";
import type { Ask, Node, SessionEvent } from "@cophyla/protocol";
import { Bus, MACHINE } from "../src/bus.ts";

const M = newId("node");
const G1 = newId("node");
const G2 = newId("node");
const RETIRED = newId("node");
const S_M = newId("session");
const S_G1 = newId("session");

function bus(): Bus {
  const b = new Bus();
  const sessions = new Map([
    [S_M, M],
    [S_G1, G1],
  ]);
  b.partitions = { isPrivate: (n) => n === G1 || n === G2 || n === RETIRED, sessionNode: (id) => sessions.get(id) };
  return b;
}

const ask = (node: string): Ask => ({ id: newId("ask"), node, type: "permission", source: { kind: "gate", action: "x", principal: { kind: "user", client: "c" } }, title: "t", options: [], answerableBy: ["user"], status: "open", createdAt: 1 }) as Ask;
const row = (id: string): Node => ({ id, name: "n" }) as Node;
const event = (session: string): SessionEvent => ({ session, seq: 1, at: 1, kind: "status", payload: {} }) as SessionEvent;

describe("the partitions", () => {
  test("an event's partition is its node's, its id's, or its session's node's; the machine's otherwise", () => {
    const b = bus();
    expect(b.partitionOf("ask.state", ask(M))).toBe(MACHINE);
    expect(b.partitionOf("ask.state", ask(G1))).toBe(G1);
    expect(b.partitionOf("node.state", row(G2))).toBe(G2);
    expect(b.partitionOf("node.state", row(newId("node")))).toBe(MACHINE);
    expect(b.partitionOf("node.left", { node: G1, at: 1 })).toBe(G1);
    expect(b.partitionOf("session.event", event(S_G1))).toBe(G1);
    expect(b.partitionOf("session.event", event(S_M))).toBe(MACHINE);
    expect(b.partitionOf("session.event", event(newId("session")))).toBe(MACHINE);
    expect(b.partitionOf("chat.retract", { id: "x" } as never)).toBe(MACHINE);
    // with no partitions known, everything is the machine's
    expect(new Bus().partitionOf("ask.state", ask(G1))).toBe(MACHINE);
  });

  test("each hears its own: `on` the machine's, `for(g)` g's, `onAll` everyone's; a removed node's reach `onAll` alone", () => {
    const b = bus();
    const heard: string[] = [];
    b.on("ask.state", (a) => heard.push(`machine ${a.node === M ? "M" : "?"}`));
    b.for(G1).on("ask.state", (a) => heard.push(`g1 ${a.node === G1 ? "G1" : "?"}`));
    b.for(G2).on("ask.state", (a) => heard.push(`g2 ${a.node === G2 ? "G2" : "?"}`));
    b.onAll("ask.state", (a) => heard.push(`all ${a.node === M ? "M" : a.node === G1 ? "G1" : a.node === G2 ? "G2" : "R"}`));
    b.emit("ask.state", ask(M));
    b.emit("ask.state", ask(G1));
    b.emit("ask.state", ask(G2));
    b.emit("ask.state", ask(RETIRED));
    expect(heard).toEqual(["machine M", "all M", "g1 G1", "all G1", "g2 G2", "all G2", "all R"]);
  });

  test("what a workspace node raises through its own partition never reaches the machine, whatever ids it carries", () => {
    const b = bus();
    const machine: unknown[] = [];
    const g1: unknown[] = [];
    const g2: unknown[] = [];
    b.on("node.state", (n) => machine.push(n.id));
    b.for(G1).on("node.state", (n) => g1.push(n.id));
    b.for(G2).on("node.state", (n) => g2.push(n.id));
    // the other cluster's primary, and the machine's own id, as a guest's registry might raise them
    const foreign = newId("node");
    b.for(G1).emit("node.state", row(foreign));
    b.for(G1).emit("node.state", row(M));
    expect(machine).toEqual([]);
    expect(g1).toEqual([foreign, M]);
    expect(g2).toEqual([]);
    // and a machine event is none of a guest's
    b.emit("node.state", row(M));
    expect(machine).toEqual([M]);
    expect(g1).toEqual([foreign, M]);
  });

  test("handlers run in the order they were added, across partitions, and come off", () => {
    const b = bus();
    const order: string[] = [];
    const off1 = b.on("session.event", () => order.push("on 1"));
    b.onAll("session.event", () => order.push("all"));
    b.on("session.event", () => order.push("on 2"));
    b.for(G1).on("session.event", () => order.push("g1"));
    b.emit("session.event", event(S_M));
    b.emit("session.event", event(S_G1));
    expect(order).toEqual(["on 1", "all", "on 2", "all", "g1"]);
    off1();
    order.length = 0;
    b.emit("session.event", event(S_M));
    expect(order).toEqual(["all", "on 2"]);
  });
});
