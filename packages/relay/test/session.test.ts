// The peer session against a minimal relay: auth, open, records both ways, the close frame.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { derive, ephemeral, pairingPsk, pskFromHex } from "../src/tunnel.ts";
import type { Bytes, Tunnel } from "../src/tunnel.ts";
import { PeerSession, PEER_BAD_RECORD, PEER_GONE } from "../src/session.ts";

const PSK_HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const PEER = "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC1";
const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PAIRING = "pair_Hq3m9TzW1vKc0aLx";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

/** A relay with one node behind it, played by the test: it answers the handshake and echoes records back through the node's own tunnel. */
interface FakeNode {
  psk: Bytes;
  received: string[];
  tunnel?: Tunnel;
  /** What the node sends back for a frame; the default echoes with a prefix. */
  reply: (text: string) => string | undefined;
}

let server: ReturnType<typeof Bun.serve>;
let node: FakeNode;
const sockets = new Set<{ send(s: string): void; close(c: number, r: string): void }>();

beforeAll(() => {
  node = { psk: pskFromHex(PSK_HEX), received: [], reply: (t) => `echo:${t}` };
  server = Bun.serve<{ authed: boolean; peer: string; kind: "controller" | "pair" }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      if (new URL(req.url).pathname !== "/ws/relay") return new Response("no", { status: 404 });
      return srv.upgrade(req, { data: { authed: false, peer: PEER, kind: "controller" } }) ? undefined : new Response("no", { status: 426 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      async message(ws, raw): Promise<void> {
        const m = JSON.parse(String(raw)) as { id?: number; method: string; params: Record<string, string> };
        const reply = (result: unknown): void => void ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
        const fail = (code: string, message: string): void => void ws.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message, data: { code, message, retryable: false } } }));
        if (m.method === "relay.auth") {
          if (m.params["grant"] !== undefined) {
            if (m.params["grant"] !== "prg_good" || m.params["verifier"] !== VERIFIER) return fail("denied", "the grant is unknown, spent or not this phone's");
            ws.data = { authed: true, peer: PAIRING, kind: "pair" };
            return reply({ peer: PAIRING, subject: "usr_123", login: "octocat" });
          }
          if (m.params["token"] !== "rly_good") return fail("denied", "unknown token");
          ws.data.authed = true;
          return reply({ peer: PEER });
        }
        if (!ws.data.authed) return fail("denied", "auth first");
        if (m.method === "relay.open") {
          const eph = await ephemeral();
          const pairing = ws.data.kind === "pair";
          node.tunnel = await derive("responder", eph, m.params["epk"]!, pairing ? await pairingPsk() : node.psk, { kind: ws.data.kind, peer: ws.data.peer });
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
          const out = node.reply(inner);
          if (out !== undefined) ws.send(JSON.stringify({ jsonrpc: "2.0", method: "relay", params: { peer: NODE, frame: await node.tunnel.seal(out) } }));
        }
      },
    },
  });
});
// not awaited: Bun's stop never settles once the server itself closed a socket (the revoke test)
afterAll(() => void server.stop(true));

const origin = () => `http://127.0.0.1:${server.port}`;

describe("peer session", () => {
  test("auth, open, and records both ways in order", async () => {
    const texts: string[] = [];
    const s = new PeerSession({ url: origin(), token: "rly_good", peer: PEER, psk: pskFromHex(PSK_HEX) }, { onText: (t) => texts.push(t) });
    const { peer } = await s.connect();
    expect(peer).toBe(NODE);
    expect(s.open).toBe(true);
    for (let i = 0; i < 20; i++) s.send(`frame ${i}`);
    await Bun.sleep(150);
    expect(node.received).toEqual(Array.from({ length: 20 }, (_, i) => `frame ${i}`));
    expect(texts).toEqual(Array.from({ length: 20 }, (_, i) => `echo:frame ${i}`));
    s.close();
    node.received.length = 0;
  });

  test("a bad token is refused before any tunnel exists", async () => {
    const closes: number[] = [];
    const s = new PeerSession({ url: origin(), token: "rly_bad", peer: PEER, psk: pskFromHex(PSK_HEX) }, { onClose: (c) => closes.push(c) });
    await expect(s.connect()).rejects.toMatchObject({ code: "denied" });
    expect(s.open).toBe(false);
  });

  test("a wrong secret: the node cannot open the first record and closes the tunnel; the session reports 4409", async () => {
    const closed = new Promise<{ code: number; reason: string }>((r) => {
      const s = new PeerSession({ url: origin(), token: "rly_good", peer: PEER, psk: pskFromHex("00".repeat(32)) }, { onClose: (code, reason) => r({ code, reason }) });
      void s.connect().then(() => s.send("hello"));
    });
    const c = await closed;
    expect(c.code).toBe(PEER_GONE);
    expect(c.reason).toBe("unauthorized");
  });

  test("records that came before the server dropped the socket are handed on before the close", async () => {
    node.reply = () => undefined;
    const events: string[] = [];
    const done = new Promise<void>((r) => {
      const s = new PeerSession({ url: origin(), token: "rly_good", peer: PEER, psk: pskFromHex(PSK_HEX) }, { onText: (t) => events.push(`text ${t}`), onClose: (code) => (events.push(`close ${code}`), r()) });
      void s.connect().then(async () => {
        // the node's last words, then the server drops the socket at once, as it does on a revoke
        const last = await node.tunnel!.seal("the last words");
        const [ws] = [...sockets];
        ws!.send(JSON.stringify({ jsonrpc: "2.0", method: "relay", params: { peer: NODE, frame: last } }));
        ws!.close(4401, "revoked");
      });
    });
    await done;
    expect(events).toEqual(["text the last words", "close 4401"]);
    node.reply = (t) => `echo:${t}`;
  });

  test("what was sent just before a close leaves before the socket closes, and nothing after it is taken", async () => {
    node.reply = () => undefined;
    node.received.length = 0;
    const closes: number[] = [];
    const s = new PeerSession({ url: origin(), token: "rly_good", peer: PEER, psk: pskFromHex(PSK_HEX) }, { onClose: (c) => closes.push(c) });
    await s.connect();
    // a node leaving says so, then closes at once
    for (let i = 0; i < 5; i++) s.send(`frame ${i}`);
    s.send("node.leave");
    s.close(1000, "left");
    expect(s.open).toBe(false);
    s.send("too late");
    await Bun.sleep(150);
    expect(node.received).toEqual(["frame 0", "frame 1", "frame 2", "frame 3", "frame 4", "node.leave"]);
    expect(closes).toEqual([1000]);
    s.close();
    expect(closes).toEqual([1000]);
    node.received.length = 0;
    node.reply = (t) => `echo:${t}`;
  });

  test("a record the session cannot open closes it with 4403", async () => {
    node.reply = () => undefined;
    const closed = new Promise<number>((r) => {
      const s = new PeerSession({ url: origin(), token: "rly_good", peer: PEER, psk: pskFromHex(PSK_HEX) }, { onClose: (code) => r(code) });
      void s.connect().then(() => {
        // the fake node sends garbage as a record
        for (const ws of sockets) ws.send(JSON.stringify({ jsonrpc: "2.0", method: "relay", params: { peer: NODE, frame: "AAAA" } }));
      });
    });
    expect(await closed).toBe(PEER_BAD_RECORD);
    node.reply = (t) => `echo:${t}`;
  });

  test("a grant: the server names the pairing peer and the account, the tunnel is the pair kind keyed from the public constant", async () => {
    const texts: string[] = [];
    const s = new PeerSession({ url: origin(), grant: { grant: "prg_good", verifier: VERIFIER }, psk: await pairingPsk() }, { onText: (t) => texts.push(t) });
    const { peer } = await s.connect();
    expect(peer).toBe(NODE);
    expect(s.peer).toBe(PAIRING);
    expect(s.account).toEqual({ subject: "usr_123", login: "octocat" });
    expect(s.nodeName).toBe("desk");
    s.send("pair.account");
    await Bun.sleep(100);
    expect(node.received).toEqual(["pair.account"]);
    expect(texts).toEqual(["echo:pair.account"]);
    s.close();
    node.received.length = 0;
  });

  test("a grant that is not this phone's is refused before any tunnel exists", async () => {
    const s = new PeerSession({ url: origin(), grant: { grant: "prg_good", verifier: "x".repeat(43) }, psk: await pairingPsk() });
    await expect(s.connect()).rejects.toMatchObject({ code: "denied" });
    expect(s.open).toBe(false);
  });

  test("a session with neither a token nor a grant never opens a socket's worth of trust", async () => {
    const s = new PeerSession({ url: origin(), psk: pskFromHex(PSK_HEX) });
    await expect(s.connect()).rejects.toMatchObject({ code: "invalid" });
  });

  test("a connection that never opens times out", async () => {
    const s = new PeerSession({ url: "http://127.0.0.1:1", token: "rly_good", peer: PEER, psk: pskFromHex(PSK_HEX), timeoutMs: 500 });
    await expect(s.connect()).rejects.toMatchObject({ code: expect.stringMatching(/unavailable|timeout/) });
  });
});
