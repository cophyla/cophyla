// The two real transports: the LAN one over a fake socket (open, timeout, close before open,
// frames), and the relay one against a minimal relay played in-process, with the node's side
// keyed from the same secret — the phone's frames arrive in the clear on the node, and the
// node's `relay.close` ends the duplex with 4409. The pairing transport against the same
// relay: the grant and verifier at auth, the `pair` kind keyed from the public constant.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { derive, ephemeral, pairingPsk, pskFromHex } from "@cophyla/relay";
import type { Tunnel } from "@cophyla/relay";
import { lanTransport, pairingTransport, relayTransport } from "../src/transport.ts";
import type { SocketLike } from "../src/transport.ts";

class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  closed?: { code?: number; reason?: string };
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.onclose?.({ code: code ?? 1000, reason: reason ?? "" });
  }
}

const timers = {
  handlers: new Map<number, () => void>(),
  n: 1,
  setTimeout(fn: () => void, _ms: number): unknown {
    const id = timers.n++;
    timers.handlers.set(id, fn);
    return id;
  },
  clearTimeout(h: unknown): void {
    timers.handlers.delete(h as number);
  },
  fireAll(): void {
    for (const [id, fn] of [...timers.handlers]) {
      timers.handlers.delete(id);
      fn();
    }
  },
};

describe("the LAN transport", () => {
  test("opens on the socket's open, carries frames both ways, and reports the close", async () => {
    const sockets: FakeSocket[] = [];
    const t = lanTransport("wss://node.test/ws/client", () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    }, 4000, timers);
    expect(t.kind).toBe("lan");
    expect(t.label).toBe("wss://node.test/ws/client");
    const opening = t.open();
    sockets[0]!.onopen?.({});
    const d = await opening;
    const got: string[] = [];
    d.onmessage = (text) => got.push(text);
    sockets[0]!.onmessage?.({ data: "{\"a\":1}" });
    expect(got).toEqual(["{\"a\":1}"]);
    d.send("up");
    expect(sockets[0]!.sent).toEqual(["up"]);
    let closed: [number, string] | undefined;
    d.onclose = (code, reason) => (closed = [code, reason]);
    sockets[0]!.close(4409, "gone");
    expect(closed).toEqual([4409, "gone"]);
  });

  test("a socket that closes before opening rejects; one that never opens times out", async () => {
    const sockets: FakeSocket[] = [];
    const t = lanTransport("wss://node.test/ws/client", () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    }, 4000, timers);
    const failing = t.open();
    sockets[0]!.close(1006, "");
    await expect(failing).rejects.toThrow(/closed 1006/);
    const slow = t.open();
    timers.fireAll();
    await expect(slow).rejects.toThrow(/no answer/);
    expect(sockets[1]!.closed).toBeDefined();
  });
});

// --- the relay transport against a fake relay -----------------------------------------------

const PSK_HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const PEER = "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC1";
const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";

const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
let server: ReturnType<typeof Bun.serve>;
const node: { tunnel?: Tunnel; received: string[]; sockets: Set<{ send(s: string): void }> } = { received: [], sockets: new Set() };

beforeAll(() => {
  server = Bun.serve<{ authed: boolean; pairing?: string }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      if (new URL(req.url).pathname !== "/ws/relay") return new Response("no", { status: 404 });
      return srv.upgrade(req, { data: { authed: false } }) ? undefined : new Response("no", { status: 426 });
    },
    websocket: {
      open(ws) {
        node.sockets.add(ws);
      },
      close(ws) {
        node.sockets.delete(ws);
      },
      async message(ws, raw): Promise<void> {
        const m = JSON.parse(String(raw)) as { id?: number; method: string; params: Record<string, string> };
        const reply = (result: unknown): void => void ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
        const fail = (code: string, message: string): void => void ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message, data: { code, message, retryable: false } } }));
        if (m.method === "relay.auth") {
          if (m.params["grant"] !== undefined) {
            if (m.params["grant"] !== "prg_good" || m.params["verifier"] !== VERIFIER) return fail("denied", "the grant is spent or not this phone's");
            ws.data.authed = true;
            ws.data.pairing = "pair_1";
            return reply({ peer: "pair_1", subject: "usr_1", login: "octocat" });
          }
          if (m.params["token"] !== "rly_good") return fail("denied", "unknown token");
          ws.data.authed = true;
          return reply({ peer: PEER });
        }
        if (!ws.data.authed) return fail("denied", "auth first");
        if (m.method === "relay.open") {
          const eph = await ephemeral();
          const pairing = ws.data.pairing;
          node.tunnel = pairing
            ? await derive("responder", eph, m.params["epk"]!, await pairingPsk(), { kind: "pair", peer: pairing })
            : await derive("responder", eph, m.params["epk"]!, pskFromHex(PSK_HEX), { kind: "controller", peer: PEER });
          return reply({ peer: NODE, epk: eph.publicKey, ...(pairing ? { name: "desk" } : {}) });
        }
        if (m.method === "relay" && node.tunnel) {
          let inner: string;
          try {
            inner = await node.tunnel.open(m.params["frame"]!);
          } catch {
            ws.send(JSON.stringify({ jsonrpc: "2.0", method: "relay.close", params: { peer: NODE, reason: "unauthorized" } }));
            return;
          }
          node.received.push(inner);
          if (inner === "bye") {
            ws.send(JSON.stringify({ jsonrpc: "2.0", method: "relay.close", params: { peer: NODE, reason: "closed by the node" } }));
            return;
          }
          ws.send(JSON.stringify({ jsonrpc: "2.0", method: "relay", params: { peer: NODE, frame: await node.tunnel.seal(`echo:${inner}`) } }));
        }
      },
    },
  });
});
afterAll(() => server.stop(true));

describe("the relay transport", () => {
  test("opens the tunnel with the access, carries frames in the clear to the node, and ends on the node's close", async () => {
    const t = relayTransport({ url: `http://127.0.0.1:${server.port}`, peer: PEER, token: "rly_good", key: PSK_HEX });
    expect(t.kind).toBe("relay");
    expect(t.label).toBe(`http://127.0.0.1:${server.port}/ws/relay`);
    const d = await t.open();
    const got: string[] = [];
    d.onmessage = (text) => got.push(text);
    const closed = new Promise<[number, string]>((r) => (d.onclose = (code, reason) => r([code, reason])));
    d.send("hello");
    d.send("world");
    await new Promise((r) => setTimeout(r, 150));
    expect(node.received).toEqual(["hello", "world"]);
    expect(got).toEqual(["echo:hello", "echo:world"]);
    d.send("bye");
    expect(await closed).toEqual([4409, "closed by the node"]);
  });

  test("a wrong secret or a bad token never yields a duplex the node accepts", async () => {
    const bad = relayTransport({ url: `http://127.0.0.1:${server.port}`, peer: PEER, token: "rly_bad", key: PSK_HEX });
    await expect(bad.open()).rejects.toMatchObject({ code: "denied" });
    const wrong = relayTransport({ url: `http://127.0.0.1:${server.port}`, peer: PEER, token: "rly_good", key: "00".repeat(32) });
    const d = await wrong.open();
    const closed = new Promise<[number, string]>((r) => (d.onclose = (code, reason) => r([code, reason])));
    d.send("hello");
    expect(await closed).toEqual([4409, "unauthorized"]);
  });
});

describe("the pairing transport", () => {
  test("spends the grant with the verifier and opens the pair kind: the node reads the frames in the clear", async () => {
    node.received.length = 0;
    const t = pairingTransport(`http://127.0.0.1:${server.port}`, "prg_good", VERIFIER);
    expect(t.kind).toBe("relay");
    const d = await t.open();
    const got: string[] = [];
    d.onmessage = (text) => got.push(text);
    d.send("pair.account");
    await new Promise((r) => setTimeout(r, 100));
    expect(node.received).toEqual(["pair.account"]);
    expect(got).toEqual(["echo:pair.account"]);
    d.close();
  });

  test("a grant that is not this phone's never opens", async () => {
    const t = pairingTransport(`http://127.0.0.1:${server.port}`, "prg_good", "x".repeat(43));
    await expect(t.open()).rejects.toMatchObject({ code: "denied" });
  });
});
