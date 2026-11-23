// A port's pipes between two hubs joined by an in-memory link, as a viewing machine's and the
// host's are: the host connects to its own loopback alone, 127.0.0.1 and then [::1] when that is
// refused, never another address; a share it does not have, or one of another machine's, is
// refused; a link that rides the relay is refused at the open and closes a pipe that was on it,
// never carrying its bytes on; what passes is counted, and a share's end closes its pipes.
// The forwarder on the viewing side listens where the page would be: the same port when it is
// free here, else a free one, on both loopback addresses, closes when unused, and Close ends
// its connections.

import { afterEach, describe, expect, test } from "bun:test";
import { RpcError } from "@cophyla/protocol";
import { silentLogger } from "../src/log.ts";
import { Forwarder, portFree } from "../src/remote/forwarder.ts";
import { PipeHub, RELAY_REFUSED } from "../src/remote/pipes.ts";
import type { PipeHubDeps, PipeTarget, PortMeter } from "../src/remote/pipes.ts";
import { waitFor } from "./helpers.ts";

const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

interface Counts {
  opened: number;
  done: number;
  bytes: number;
}

/** Two hubs, a viewer `A` and a host `B`, joined by a link whose way can be flipped to the relay. */
function pair(opts: { shares?: Map<string, { port: number; viewer: string }>; connect?: typeof Bun.connect } = {}) {
  const shares = opts.shares ?? new Map<string, { port: number; viewer: string }>();
  const counts: Counts = { opened: 0, done: 0, bytes: 0 };
  const meter = (): PortMeter => {
    counts.opened++;
    return { bytes: (n) => void (counts.bytes += n), done: () => void counts.done++ };
  };
  const straight = { A: true, B: true };
  let a: PipeHub;
  let b: PipeHub;
  const wire = (to: () => PipeHub, from: string) => ({
    data: (pipe: string, data: string) => {
      queueMicrotask(() => to().data(`link:${from}`, pipe, data));
      return true;
    },
    ack: (pipe: string, bytes: number) => queueMicrotask(() => to().ack(`link:${from}`, pipe, bytes)),
    close: (pipe: string, reason: string) => queueMicrotask(() => to().closed(`link:${from}`, pipe, reason)),
  });
  const base = (self: string): Omit<PipeHubDeps, "linkWire" | "nextHop" | "openOnLink"> => ({
    selfId: () => self,
    loopbackPort: () => 1,
    clientWire: () => ({ data: () => true, ack: () => undefined, close: () => undefined }),
    log: silentLogger,
  });
  a = new PipeHub({
    ...base("A"),
    linkWire: (n) => (n === "B" ? wire(() => b, "A") : undefined),
    nextHop: (n) => (n === "B" ? "B" : undefined),
    openOnLink: async () => ({ window: 1 }),
    openPortOnLink: (_hop, p) => b.openForLink("A", p, { kind: "port", share: p.share, viewer: p.viewer }),
    meter: () => meter(),
    straight: () => straight.B,
  });
  b = new PipeHub({
    ...base("B"),
    linkWire: (n) => (n === "A" ? wire(() => a, "B") : undefined),
    nextHop: () => undefined,
    openOnLink: async () => ({ window: 1 }),
    portOf: (share, viewer) => {
      const s = shares.get(share);
      if (!s || s.viewer !== viewer) throw new RpcError("not_found", "no such port is shared here");
      return { port: s.port };
    },
    straight: () => straight.A,
    ...(opts.connect ? { connect: opts.connect } : {}),
  });
  return { a, b, shares, counts, straight };
}

/** A page's server on one loopback address: a page, and a WebSocket that echoes. */
function devServer(hostname: string) {
  const server = Bun.serve({
    hostname,
    port: 0,
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/ws" && srv.upgrade(req)) return undefined;
      return new Response(`page from ${hostname} ${"x".repeat(100_000)}`);
    },
    websocket: { message: (ws, m) => void ws.send(`echo:${String(m)}`) },
  });
  closers.push(() => server.stop(true));
  return server;
}

function forwarder(hub: PipeHub, target: PipeTarget, opts: { port?: number; idleMs?: number; free?: (p: number) => Promise<boolean> } = {}): Forwarder {
  const f = new Forwarder({ hub, node: "B", target, log: silentLogger, ...opts });
  closers.push(() => f.stop());
  return f;
}

describe("a port's pipes", () => {
  test("the host connects to 127.0.0.1, then [::1] when that is refused, and to nothing else", async () => {
    const tried: string[] = [];
    const connect = ((o: Parameters<typeof Bun.connect>[0]) => {
      tried.push((o as unknown as { hostname: string }).hostname);
      return Bun.connect(o);
    }) as typeof Bun.connect;
    const v6 = devServer("::1");
    const v4 = devServer("127.0.0.1");
    const { a, shares } = pair({ connect });
    shares.set("prt_6", { port: v6.port!, viewer: "A" });
    shares.set("prt_4", { port: v4.port!, viewer: "A" });
    const f6 = forwarder(a, { kind: "port", share: "prt_6" });
    const f4 = forwarder(a, { kind: "port", share: "prt_4" });
    const p6 = await f6.startBoth();
    const p4 = await f4.startBoth();
    expect(await (await fetch(`http://127.0.0.1:${p6}/`)).text()).toStartWith("page from ::1");
    expect(tried).toEqual(["127.0.0.1", "::1"]);
    tried.length = 0;
    expect(await (await fetch(`http://127.0.0.1:${p4}/`)).text()).toStartWith("page from 127.0.0.1");
    expect(tried).toEqual(["127.0.0.1"]);
  });

  test("a share the host does not have, or one of another machine's, is refused", async () => {
    const v4 = devServer("127.0.0.1");
    const { a, b, shares } = pair();
    shares.set("prt_other", { port: v4.port!, viewer: "C" });
    for (const share of ["prt_none", "prt_other"]) {
      const f = forwarder(a, { kind: "port", share });
      const port = await f.startBoth();
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    }
    expect(b.count).toBe(0);
    expect(a.count).toBe(0);
  });

  test("the page and its WebSocket come through, counted; the share's end closes its pipes", async () => {
    const v4 = devServer("127.0.0.1");
    const { a, b, shares, counts } = pair();
    shares.set("prt_1", { port: v4.port!, viewer: "A" });
    const f = forwarder(a, { kind: "port", share: "prt_1" });
    const port = await f.startBoth();
    expect((await (await fetch(`http://127.0.0.1:${port}/`)).text()).length).toBeGreaterThan(100_000);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    closers.push(() => ws.close());
    const heard: string[] = [];
    ws.onmessage = (ev) => heard.push(String(ev.data));
    await new Promise((r) => (ws.onopen = r));
    ws.send("ping");
    await waitFor(() => heard.length > 0);
    expect(heard).toEqual(["echo:ping"]);
    expect(counts.opened).toBeGreaterThanOrEqual(2);
    expect(counts.bytes).toBeGreaterThan(100_000);
    expect(b.portCount).toBeGreaterThan(0);
    // the host stops sharing it: every pipe to it goes, the page's socket with it
    const closed = new Promise((r) => (ws.onclose = r));
    expect(b.closeShare("prt_1", "unshared")).toBeGreaterThan(0);
    await closed;
    await waitFor(() => a.count === 0 && b.count === 0);
    expect(counts.done).toBe(counts.opened);
  });

  test("a link on the relay is refused at the open, and one that falls back closes the pipes on it", async () => {
    const v4 = devServer("127.0.0.1");
    const { a, b, shares, straight } = pair();
    shares.set("prt_1", { port: v4.port!, viewer: "A" });
    const f = forwarder(a, { kind: "port", share: "prt_1" });
    const port = await f.startBoth();
    straight.B = false;
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    expect(a.count + b.count).toBe(0);

    // straight again: a live socket opens, then the link falls back under it
    straight.B = true;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    closers.push(() => ws.close());
    await new Promise((r) => (ws.onopen = r));
    expect(b.portCount).toBe(1);
    const closed = new Promise((r) => (ws.onclose = r));
    straight.B = false;
    straight.A = false;
    // the bytes the page sends next go no further than here
    ws.send("ping");
    await closed;
    await waitFor(() => a.count === 0 && b.count === 0);

    // and one the link's switch reports falling back is closed at once, idle or not
    straight.A = true;
    straight.B = true;
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    closers.push(() => ws2.close());
    await new Promise((r) => (ws2.onopen = r));
    const closed2 = new Promise((r) => (ws2.onclose = r));
    expect(b.offStraight("link:A")).toBe(1);
    await closed2;
    await waitFor(() => a.count === 0);
    expect(RELAY_REFUSED).toContain("relay");
  });
});

describe("a port's forwarder", () => {
  test("the same port when it is free here, on 127.0.0.1 and [::1]", async () => {
    const { a } = pair();
    // a port the system had free a moment ago
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const wanted = probe.port;
    probe.stop(true);
    expect(await portFree(wanted)).toBe(true);
    const f = forwarder(a, { kind: "port", share: "prt_1" }, { port: wanted });
    expect(await f.startBoth()).toBe(wanted);
    expect(f.addresses.sort()).toEqual(["127.0.0.1", "::1"]);
  });

  test("a free one, the same on both addresses, when something here has the port", async () => {
    const { a } = pair();
    const held = devServer("::1");
    expect(await portFree(held.port!)).toBe(false);
    const f = forwarder(a, { kind: "port", share: "prt_1" }, { port: held.port! });
    const port = await f.startBoth();
    expect(port).not.toBe(held.port);
    expect(f.addresses.sort()).toEqual(["127.0.0.1", "::1"]);
    // something answers on both
    for (const host of ["127.0.0.1", "::1"]) {
      const s = await Bun.connect({ hostname: host, port, socket: { data() {} } });
      s.end();
    }
  });

  test("it closes after a while with no connection, and Close ends its connections", async () => {
    const v4 = devServer("127.0.0.1");
    const { a, shares } = pair();
    shares.set("prt_1", { port: v4.port!, viewer: "A" });
    let closedIdle = false;
    const idle = new Forwarder({ hub: a, node: "B", target: { kind: "port", share: "prt_1" }, log: silentLogger, idleMs: 80, onClose: () => (closedIdle = true) });
    closers.push(() => idle.stop());
    const idlePort = await idle.startBoth();
    await waitFor(() => closedIdle, 2000);
    expect(await portFree(idlePort)).toBe(true);

    const f = forwarder(a, { kind: "port", share: "prt_1" });
    const port = await f.startBoth();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    closers.push(() => ws.close());
    await new Promise((r) => (ws.onopen = r));
    expect(f.connections).toBe(1);
    const closed = new Promise((r) => (ws.onclose = r));
    f.stop();
    await closed;
    await waitFor(() => a.count === 0);
    expect(await portFree(port)).toBe(true);
  });
});
