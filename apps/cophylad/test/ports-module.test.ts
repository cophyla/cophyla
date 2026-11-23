// The ports module, both halves, with the links and the gate played by fakes. On the device's
// side: the desktop app gets a forwarder and the page's address, the phone app a share its own
// forwarder opens pipes to (and no other client may), a browser nothing; the machine itself
// needs nothing between; a machine that lends folders, is lent as hands, sits at its sign-in
// door, is offline or runs an older Cophyla is refused in words, and so is every way through
// the relay, the phone's own leg included; an HTTPS server is refused on the phone; what the
// client has open is told it whole; a close, the client going and the link going each end it,
// tell the host and leave an audit row of the counts alone. On the host's side: a share has a
// random id and a day at most, is the viewer's alone, and its end is audited the same way.

import { afterEach, describe, expect, test } from "bun:test";
import { RpcError } from "@cophyla/protocol";
import type { Client, PortForward } from "@cophyla/protocol";
import type { Gate, GateRequest } from "../src/gate/index.ts";
import { Policy } from "../src/gate/policy.ts";
import { silentLogger } from "../src/log.ts";
import { PipeHub } from "../src/remote/pipes.ts";
import { HTTPS_ON_PHONE, Ports } from "../src/remote/ports.ts";
import type { LinkWay, PortHost, PortsDeps } from "../src/remote/ports.ts";
import { waitFor } from "./helpers.ts";

const SELF = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DESK = "node_01ARZ3NDEKTSV4RRFFQ69G5FAW";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

function client(kind: "ui" | "controller", id = kind === "ui" ? "cli_desktop" : "cli_phone"): Client {
  return { id, kind, ...(kind === "ui" ? { node: SELF } : { name: "Pixel" }), scopes: [], via: "direct", audio: { in: false, out: false }, connectedAt: 0 };
}

interface Harness {
  ports: Ports;
  requests: { node: string; method: string; params: Record<string, unknown> }[];
  told: Map<string, PortForward[]>;
  audits: GateRequest[];
  host: PortHost;
  way: { v: LinkWay };
  tls: { v: boolean };
  share: { fail?: Error };
}

function harness(over: Partial<PortsDeps> = {}): Harness {
  const requests: Harness["requests"] = [];
  const told = new Map<string, PortForward[]>();
  const audits: GateRequest[] = [];
  const host: PortHost = { name: "Desk", online: true, machine: true, hands: false, door: false, ports: true };
  const way = { v: { route: "lan" } as LinkWay };
  const tls = { v: false };
  const share: Harness["share"] = {};
  const gate = {
    run: async (req: GateRequest, handler: (ctx: unknown) => unknown) => {
      audits.push(req);
      return handler({});
    },
  } as unknown as Gate;
  const hub = new PipeHub({
    selfId: () => SELF,
    loopbackPort: () => 1,
    clientWire: () => ({ data: () => true, ack: () => undefined, close: () => undefined }),
    linkWire: () => undefined,
    nextHop: () => undefined,
    openOnLink: async () => ({ window: 1 }),
    log: silentLogger,
  });
  let n = 0;
  const ports = new Ports({
    selfId: SELF,
    selfName: "Laptop",
    hub,
    gate,
    log: silentLogger,
    request: async (node, method, params) => {
      requests.push({ node, method, params: params as Record<string, unknown> });
      if (method === "port.share") {
        if (share.fail) throw share.fail;
        return { share: `prt_01ARZ3NDEKTSV4RRFFQ69G5F${String(++n).padStart(2, "0")}`, expiresAt: 1, ...(tls.v ? { tls: true } : {}) };
      }
      return { connections: 0, bytes: 0 };
    },
    host: (node) => (node === DESK ? host : undefined),
    primaryName: () => "Hub",
    way: () => way.v,
    notify: (c, forwards) => told.set(c, forwards),
    list: async () => [{ port: 3000, v4: true, v6: false }],
    tls: async () => tls.v,
    // nothing here has a port, so a forwarder takes any free one the system gives
    free: async () => false,
    ...over,
  });
  stops.push(() => ports.stop());
  return { ports, requests, told, audits, host, way, tls, share };
}

const desktopWay = { listener: "loopback" };
const phoneWay = { listener: "controller", forward: true };

describe("opening a port from a device", () => {
  test("the desktop app: a forwarder here and the page's address, told the client; Close ends it, tells the host and audits the counts", async () => {
    const h = harness();
    const r = await h.ports.open(client("ui"), desktopWay, DESK, 3000);
    expect(r.id).toMatch(/^prt_/);
    expect(r.route).toBe("lan");
    expect(r.local).toBeGreaterThan(0);
    expect(r.url).toBe(`http://localhost:${r.local}/`);
    expect(r.share).toBeUndefined();
    expect(h.requests[0]).toEqual({ node: DESK, method: "port.share", params: { node: DESK, port: 3000, viewer: SELF } });
    expect(h.told.get("cli_desktop")).toEqual([{ id: r.id, node: DESK, port: 3000, local: r.local!, url: r.url!, route: "lan", since: expect.any(Number), connections: 0, bytes: 0 }]);
    // any program on this computer may use it while it is open
    const s = await Bun.connect({ hostname: "127.0.0.1", port: r.local!, socket: { data() {} } });
    s.end();
    // another client cannot close it
    expect(() => h.ports.close("cli_other", r.id)).toThrow(RpcError);
    h.ports.close("cli_desktop", r.id);
    expect(h.requests.at(-1)).toEqual({ node: DESK, method: "port.unshare", params: { node: DESK, share: r.id, viewer: SELF } });
    expect(h.told.get("cli_desktop")).toEqual([]);
    const row = h.audits.find((a) => a.action === "port.close")!;
    expect(row.principal).toEqual({ kind: "system" });
    expect(row.args).toEqual({ id: r.id, node: DESK, port: 3000, why: "closed" });
    await expect(Bun.connect({ hostname: "127.0.0.1", port: r.local!, socket: { data() {} } })).rejects.toThrow();
  });

  test("the phone app: a share its forwarder opens pipes to, its own alone; a browser is refused", async () => {
    const h = harness();
    const r = await h.ports.open(client("controller"), phoneWay, DESK, 5173);
    expect(r.share).toBe(r.id);
    expect(r.local).toBeUndefined();
    expect(h.ports.pipeTo("cli_phone", r.share!)).toEqual({ node: DESK, target: { kind: "port", share: r.share! } });
    expect(() => h.ports.pipeTo("cli_other", r.share!)).toThrow(RpcError);
    await expect(h.ports.open(client("controller", "cli_browser"), { listener: "controller", browser: true }, DESK, 5173)).rejects.toThrow("not in a browser");
    await expect(h.ports.open(client("controller", "cli_plain"), { listener: "controller" }, DESK, 5173)).rejects.toThrow("not in a browser");
  });

  test("on the machine itself: nothing between for the desktop app, a share of its own loopback for the phone", async () => {
    const h = harness();
    const here = await h.ports.open(client("ui"), desktopWay, SELF, 3000);
    expect(here).toEqual({ id: expect.stringMatching(/^prt_/), node: SELF, port: 3000, url: "http://localhost:3000/", route: "here" });
    expect(h.requests).toEqual([]);
    const phone = await h.ports.open(client("controller"), phoneWay, SELF, 3000);
    expect(phone.route).toBe("lan");
    expect(h.ports.portOf(phone.share!, SELF).port).toBe(3000);
    expect(h.ports.counts).toEqual({ shares: 1, forwards: 1 });
    h.ports.close("cli_phone", phone.id);
    expect(h.ports.counts).toEqual({ shares: 0, forwards: 0 });
    expect(() => h.ports.portOf(phone.share!, SELF)).toThrow(RpcError);
  });

  test("never through the relay: a link on it, or the phone's own leg, is refused in plain words", async () => {
    const h = harness();
    h.way.v = { refused: "relay" };
    await expect(h.ports.open(client("controller"), phoneWay, DESK, 3000)).rejects.toThrow("Opening Desk's localhost needs a direct connection; this phone reaches Desk only through the relay right now");
    await expect(h.ports.open(client("ui"), desktopWay, DESK, 3000)).rejects.toThrow("Opening Desk's localhost needs a direct connection; this computer reaches Desk only through the relay right now");
    h.way.v = { route: "lan" };
    await expect(h.ports.open(client("controller"), { listener: "cloud", forward: true }, DESK, 3000)).rejects.toThrow("this phone reaches Desk only through the relay right now");
    await expect(h.ports.open(client("controller"), { listener: "p2p", path: "turn", forward: true }, DESK, 3000)).rejects.toThrow("only through the relay");
    // a data channel of its own is straight
    const direct = await h.ports.open(client("controller"), { listener: "p2p", path: "direct", forward: true }, DESK, 3000);
    expect(direct.route).toBe("direct");
    expect(h.requests.filter((r) => r.method === "port.share").length).toBe(1);
  });

  test("a machine that cannot share its port is refused in words, and an older Cophyla is named", async () => {
    const h = harness();
    const cases: [Partial<PortHost>, string][] = [
      [{ online: false }, "Desk is offline"],
      [{ door: true }, "Desk is at its sign-in screen"],
      [{ machine: false }, "Desk shares some folders alone"],
      [{ hands: true }, "Desk is lent as hands"],
      [{ ports: false }, "Update Cophyla on Desk"],
    ];
    for (const [patch, words] of cases) {
      Object.assign(h.host, { name: "Desk", online: true, machine: true, hands: false, door: false, ports: true }, patch);
      await expect(h.ports.open(client("ui"), desktopWay, DESK, 3000)).rejects.toThrow(words);
    }
    Object.assign(h.host, { online: true, door: false, machine: true, hands: false, ports: true });
    await expect(h.ports.open(client("ui"), desktopWay, "node_01ARZ3NDEKTSV4RRFFQ69G5FZZ", 3000)).rejects.toThrow("No such machine");
    h.share.fail = new RpcError("unsupported", "port.share is not served upward");
    await expect(h.ports.open(client("ui"), desktopWay, DESK, 3000)).rejects.toThrow("Update Cophyla on Hub");
    h.share.fail = new RpcError("unsupported", "port.share is not served over the node link");
    await expect(h.ports.open(client("ui"), desktopWay, DESK, 3000)).rejects.toThrow("Update Cophyla on Desk");
    const hands = harness({ hands: () => true });
    await expect(hands.ports.open(client("ui"), desktopWay, DESK, 3000)).rejects.toThrow("lent as hands");
  });

  test("an HTTPS server is refused on the phone, and unshared again; the desktop gets an https address", async () => {
    const h = harness();
    h.tls.v = true;
    await expect(h.ports.open(client("controller"), phoneWay, DESK, 8443)).rejects.toThrow(HTTPS_ON_PHONE);
    expect(h.requests.map((r) => r.method)).toEqual(["port.share", "port.unshare"]);
    const r = await h.ports.open(client("ui"), desktopWay, DESK, 8443);
    expect(r.url).toBe(`https://localhost:${r.local}/`);
    await expect(h.ports.open(client("controller"), phoneWay, SELF, 8443)).rejects.toThrow(HTTPS_ON_PHONE);
    expect(h.ports.counts.shares).toBe(0);
  });

  test("the client going, or the link under a forward, ends it", async () => {
    const h = harness();
    const a = await h.ports.open(client("ui"), desktopWay, DESK, 3000);
    const b = await h.ports.open(client("controller"), phoneWay, DESK, 3001);
    h.ports.clientGone("cli_desktop");
    expect(h.ports.forwardsOf("cli_desktop")).toEqual([]);
    expect(h.ports.forwardsOf("cli_phone").map((f) => f.id)).toEqual([b.id]);
    expect(h.audits.find((x) => x.action === "port.close" && (x.args as { id: string }).id === a.id)?.args).toMatchObject({ why: "its app went" });
    // a link to another machine going leaves it be; the one under it ends it
    h.ports.linkGone("node_01ARZ3NDEKTSV4RRFFQ69G5FZZ", false);
    expect(h.ports.counts.forwards).toBe(1);
    h.ports.linkGone(DESK, false);
    expect(h.ports.counts.forwards).toBe(0);
    // on a secondary, the link to the primary carries every forward
    await h.ports.open(client("ui"), desktopWay, DESK, 3002);
    h.ports.linkGone("node_01ARZ3NDEKTSV4RRFFQ69G5FPR", true);
    expect(h.ports.counts.forwards).toBe(0);
  });
});

describe("sharing a port of this machine", () => {
  test("a random id, a day at most, the viewer's alone; its ends audited with the counts", async () => {
    const h = harness({ shareMs: 60 });
    const s = await h.ports.share({ port: 3000, viewer: DESK, name: "Laptop", link: DESK });
    expect(s.share).toMatch(/^prt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(h.ports.portOf(s.share, DESK).port).toBe(3000);
    expect(() => h.ports.portOf(s.share, SELF)).toThrow(RpcError);
    expect(() => h.ports.unshare(s.share, SELF)).toThrow(RpcError);
    // a meter counts the pipes and their bytes
    const m = h.ports.portOf(s.share, DESK).meter;
    m.bytes(512);
    m.done();
    expect(h.ports.unshare(s.share, DESK)).toEqual({ connections: 2, bytes: 512 });
    // ended by the gated unshare: its own row says the counts, no second one
    expect(h.audits.filter((a) => a.action === "port.unshare")).toEqual([]);
    // the day passes (here, 60 ms)
    const t = await h.ports.share({ port: 3001, viewer: DESK, link: DESK });
    await waitFor(() => h.audits.some((a) => a.action === "port.unshare"), 2000);
    const row = h.audits.find((a) => a.action === "port.unshare")!;
    expect(row.principal).toEqual({ kind: "system" });
    expect(row.args).toEqual({ share: t.share, port: 3001, viewer: DESK, why: "a day passed" });
    // the link it came on going ends it
    const u = await h.ports.share({ port: 3002, viewer: DESK, link: DESK });
    h.ports.linkGone(DESK, false);
    expect(() => h.ports.portOf(u.share, DESK)).toThrow(RpcError);
    // a machine that lends folders shares none
    const lent = harness({ sharesNone: () => "this machine shares some folders alone, not its localhost" });
    await expect(lent.ports.share({ port: 3000, viewer: DESK, link: DESK })).rejects.toThrow("shares some folders alone");
    await expect(lent.ports.list()).rejects.toThrow("shares some folders alone");
  });

  test("the gate shares a port unasked for the user's own machine, where a rule may still ask", () => {
    const config = { audit_result_cap: 65536, ask_timeout_ms: 0, policy: { user: allow, brain: allow, node: { read: "allow", write: "ask", exec: "ask", network: "ask" }, harness: allow }, rules: {} } as const;
    const store = { policy: { list: () => [] } } as never;
    const policy = new Policy(config as never, store);
    expect(policy.decide({ principal: "node", action: "port.share", risk: "exec" }).decision).toBe("allow");
    expect(policy.decide({ principal: "node", action: "port.unshare", risk: "write" }).decision).toBe("allow");
    const asking = new Policy({ ...config, rules: { "node:port.share": "ask" } } as never, store);
    expect(asking.decide({ principal: "node", action: "port.share", risk: "exec" }).decision).toBe("ask");
  });
});

const allow = { read: "allow", write: "allow", exec: "allow", network: "allow" } as const;
