// The sealed socket: two ends set up by the two frames in the clear speak in order both ways;
// a record that does not open closes it with 4403 after what was queued; a close waits for
// the queue; the hello is checked field by field; a key or a grant that differs derives a
// tunnel that opens nothing; and a man in the middle who swaps the keys learns nothing.

import { describe, expect, test } from "bun:test";
import { parseSealedHello, pskFromHex, SEALED_BAD_RECORD, SealedError, sealedInitiate, sealedRefusal, sealedRespond, SealedSocket } from "../src/index.ts";
import type { Tunnel } from "../src/index.ts";

const KEY = pskFromHex("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
const OTHER = pskFromHex("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
const GRANT = "grt_01ARZ3NDEKTSV4RRFFQ69G5FD1";

async function handshake(opts: { initiatorKey?: Uint8Array<ArrayBuffer>; responderKey?: Uint8Array<ArrayBuffer>; grant?: string } = {}): Promise<{ a: Tunnel; b: Tunnel }> {
  const init = await sealedInitiate({ grant: GRANT, kind: "node", psk: opts.initiatorKey ?? KEY });
  const hello = parseSealedHello(init.hello)!;
  const { answer, tunnel: b } = await sealedRespond({ ...hello, grant: opts.grant ?? hello.grant }, opts.responderKey ?? KEY);
  return { a: await init.finish(answer), b };
}

/** Two sealed sockets joined by an in-memory wire. */
function wire(a: Tunnel, b: Tunnel) {
  const heard = { a: [] as string[], b: [] as string[] };
  const closed = { a: [] as number[], b: [] as number[] };
  const wireAB: string[] = [];
  let sa: SealedSocket;
  let sb: SealedSocket;
  sa = new SealedSocket(a, { send: (f) => (wireAB.push(f), sb.receive(f)), close: (code, reason) => sb.transportClosed(code, reason) }, { onText: (t) => heard.a.push(t), onClose: (c) => closed.a.push(c) });
  sb = new SealedSocket(b, { send: (f) => sa.receive(f), close: (code, reason) => sa.transportClosed(code, reason) }, { onText: (t) => heard.b.push(t), onClose: (c) => closed.b.push(c) });
  return { sa, sb, heard, closed, wireAB };
}

describe("sealed socket", () => {
  test("the two frames in the clear set up a tunnel; frames go both ways in order; nothing readable on the wire", async () => {
    const { a, b } = await handshake();
    const { sa, sb, heard, wireAB } = wire(a, b);
    for (const t of ["one", "two", '{"jsonrpc":"2.0","method":"node.hello"}']) sa.send(t);
    sb.send("back");
    await Bun.sleep(20);
    expect(heard.b).toEqual(["one", "two", '{"jsonrpc":"2.0","method":"node.hello"}']);
    expect(heard.a).toEqual(["back"]);
    expect(wireAB.join("")).not.toContain("node.hello");
    expect(sa.out).toBe(3);
    expect(sb.in).toBe(3);
  });

  test("a close waits for the queue; the far end hears it once", async () => {
    const { a, b } = await handshake();
    const { sa, heard, closed } = wire(a, b);
    sa.send("last words");
    sa.close(1000, "bye");
    expect(sa.send("too late")).toBe(false);
    await Bun.sleep(20);
    expect(heard.b).toEqual(["last words"]);
    expect(closed.a).toEqual([1000]);
    expect(closed.b).toEqual([1000]);
  });

  test("a wrong key or another grant's binding derives a tunnel whose first record closes the far end 4403", async () => {
    for (const opts of [{ responderKey: OTHER }, { grant: "grt_01ARZ3NDEKTSV4RRFFQ69G5FD2" }]) {
      const { a, b } = await handshake(opts);
      const { sa, heard, closed } = wire(a, b);
      sa.send("hello");
      await Bun.sleep(20);
      expect(heard.b).toEqual([]);
      expect(closed.b).toEqual([SEALED_BAD_RECORD]);
      expect(closed.a).toEqual([SEALED_BAD_RECORD]);
    }
  });

  test("a man in the middle who answers each side with his own key, holding no grant key, opens nothing and injects nothing", async () => {
    // He sits between: the initiator's hello goes to him, he answers with his own; he opens
    // his own hello to the responder. Without the grant's key his tunnels are keyed apart.
    const init = await sealedInitiate({ grant: GRANT, kind: "node", psk: KEY });
    const mitmToInitiator = await sealedRespond(parseSealedHello(init.hello)!, OTHER);
    const a = await init.finish(mitmToInitiator.answer);
    const record = await a.seal("secret frame");
    await expect(mitmToInitiator.tunnel.open(record)).rejects.toThrow();
    // A frame he makes up, sealed with his side's key, does not open at the initiator.
    const forged = await mitmToInitiator.tunnel.seal('{"jsonrpc":"2.0","method":"node.takeover"}');
    await expect(a.open(forged)).rejects.toThrow();
  });

  test("the hello is checked field by field; a refusal reads as an error", async () => {
    const init = await sealedInitiate({ grant: GRANT, kind: "enroll", psk: KEY, curve: "p256" });
    expect(parseSealedHello(init.hello)).toMatchObject({ grant: GRANT, kind: "enroll", curve: "p256" });
    expect(parseSealedHello("not json")).toBeUndefined();
    expect(parseSealedHello('{"jsonrpc":"2.0","id":1,"method":"node.hello","params":{}}')).toBeUndefined();
    expect(parseSealedHello(JSON.stringify({ ...JSON.parse(init.hello), kind: "controller" }))).toBeUndefined();
    expect(parseSealedHello(JSON.stringify({ ...JSON.parse(init.hello), grant: "" }))).toBeUndefined();
    expect(parseSealedHello(JSON.stringify({ ...JSON.parse(init.hello), v: "cophyla-sealed/2" }))).toBeUndefined();
    await expect(init.finish(sealedRefusal("no such grant"))).rejects.toThrow(SealedError);
    await expect(init.finish("{}")).rejects.toThrow("no key");
  });
});
