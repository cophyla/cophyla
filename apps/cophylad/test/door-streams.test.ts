// Tickets for a desktop as a sign-in door reads them, with no sockets: the primary carries a
// ticket on with who the viewer is set by itself, the node on the link it came from, over
// whatever that node said; a host that decides by it (a door) asks no one and keeps its audit
// row, a refusal with its reason; and a gate request decided already never asks, whatever the
// policy says.

import { describe, expect, test } from "bun:test";
import type { AuditEntry, TicketViewer } from "@cophyla/protocol";
import { Bus } from "../src/bus.ts";
import { Config } from "../src/config/schema.ts";
import { doorGate } from "../src/door/index.ts";
import { doorAllows } from "../src/door/link.ts";
import { Asks } from "../src/gate/asks.ts";
import { Audit } from "../src/gate/audit.ts";
import { Gate } from "../src/gate/index.ts";
import { Policy } from "../src/gate/policy.ts";
import { silentLogger } from "../src/log.ts";
import { StreamLinks } from "../src/nodes/streams.ts";
import type { Remote } from "../src/remote/index.ts";
import { Store } from "../src/store/index.ts";

const HOST = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const PRIMARY = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER = "node_01ARZ3NDEKTSV4RRFFQ69G5FAX";

/** A remote module that mints a ticket for anyone it is asked to. */
function fakeRemote(minted: string[]): Remote {
  return {
    ticket: async (viewer: string) => {
      minted.push(viewer);
      return { path: "/remote/?t=0", stream: "stream_1" };
    },
    closeTicket: () => undefined,
    linkGone: () => undefined,
  } as unknown as Remote;
}

describe("the viewer on a ticket", () => {
  test("the primary carries a ticket on with the viewer set to the node it came from, over what that node said", async () => {
    const carried: unknown[] = [];
    const store = new Store(":memory:");
    store.migrate();
    const bus = new Bus();
    const config = Config.parse({});
    const gate = new Gate({ config: config.gate, policy: new Policy(config.gate, store), asks: new Asks(store, PRIMARY, bus), audit: new Audit(store, PRIMARY, 65536, bus), log: silentLogger });
    const links = new StreamLinks({
      selfId: () => PRIMARY,
      gate,
      remote: () => undefined,
      pipes: () => undefined,
      carry: async (_node, _method, params) => {
        carried.push(params);
        return { path: "/remote/?t=0", stream: "stream_1" };
      },
      log: silentLogger,
    });
    const forged: TicketViewer = { kind: "phone", grant: "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC8" };
    await links.request({ id: OTHER, sessionKey: "link-1" }, "remote.ticket", { node: HOST, viewer: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB9", transport: "webrtc", by: forged });
    expect((carried[0] as { by: TicketViewer }).by).toEqual({ kind: "machine", node: OTHER });
  });

  test("a door decides by it: its user's phone in unasked and audited, a machine that never viewed the desktop refused with why", async () => {
    const store = new Store(":memory:");
    store.migrate();
    const bus = new Bus();
    const entries: AuditEntry[] = [];
    bus.on("audit.entry", (e) => entries.push(e));
    const gate = doorGate(store, bus, HOST, silentLogger);
    const minted: string[] = [];
    const links = new StreamLinks({
      selfId: () => HOST,
      gate,
      remote: () => fakeRemote(minted),
      pipes: () => undefined,
      carry: () => Promise.reject(new Error("a door carries nothing on")),
      decide: (t) => doorAllows(t.by, [PRIMARY]),
      log: silentLogger,
    });
    const from = { id: PRIMARY, sessionKey: "link-1" };
    const phone = await links.request(from, "remote.ticket", { node: HOST, viewer: "cli_1", name: "Pixel", transport: "webrtc", by: { kind: "phone", grant: "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC8" } });
    expect(phone).toMatchObject({ stream: "stream_1" });
    expect(minted).toEqual([StreamLinks.viewerKey(PRIMARY, "cli_1")]);
    // the desk's own app, which paired a viewer with this desktop
    await links.request(from, "remote.ticket", { node: HOST, viewer: "cli_2", transport: "webrtc", by: { kind: "machine", node: PRIMARY } });
    await expect(links.request(from, "remote.ticket", { node: HOST, viewer: "cli_3", transport: "webrtc", by: { kind: "machine", node: OTHER } })).rejects.toThrow("that machine has not viewed this desktop before: pair it while someone is signed in here");
    await expect(links.request(from, "remote.ticket", { node: HOST, viewer: "cli_4", transport: "webrtc" })).rejects.toThrow(/did not say who is asking/);
    expect(minted).toHaveLength(2);
    // each row is told as it opens and again as it completes: the completed ones
    const tickets = entries.filter((e) => e.action === "remote.ticket" && e.outcome !== undefined);
    expect(tickets.map((e) => [e.decision, e.outcome])).toEqual([
      ["allow", "ok"],
      ["allow", "ok"],
      ["deny", "denied"],
      ["deny", "denied"],
    ]);
    expect(tickets.every((e) => e.node === HOST && e.principal.kind === "node")).toBe(true);
  });

  test("decided already, the gate asks no one whatever the policy says; the door's gate denies anything it did not decide", async () => {
    const store = new Store(":memory:");
    store.migrate();
    const bus = new Bus();
    const gate = doorGate(store, bus, HOST, silentLogger);
    const asked: unknown[] = [];
    bus.on("ask.state", (a) => asked.push(a));
    expect(await gate.run({ principal: { kind: "node", id: PRIMARY }, action: "remote.ticket", args: {}, risk: "exec", decided: { decision: "allow", why: "one of the user's own phones" } }, () => "ok")).toBe("ok");
    await expect(gate.run({ principal: { kind: "node", id: PRIMARY }, action: "remote.enable", args: {} }, () => "ok")).rejects.toThrow("policy for node/exec");
    await expect(gate.run({ principal: { kind: "node", id: PRIMARY }, action: "node.list", args: {} }, () => "ok")).rejects.toThrow("policy for node/read");
    expect(asked).toEqual([]);
  });
});
