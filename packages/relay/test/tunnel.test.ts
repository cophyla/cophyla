// The tunnel: two ends keyed from the same handshake and secret speak; anything else fails.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { derive, ephemeral, fromBase64, pairingPsk, pskFromHex, pskFromSecret, toBase64, TunnelError } from "../src/tunnel.ts";
import type { Bytes, RelayCurve, Tunnel } from "../src/tunnel.ts";

const PSK_HEX = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const BINDING = { kind: "controller", peer: "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC1" } as const;

/** Both ends of one tunnel, as a handshake would leave them. */
async function pair(opts: { curve?: RelayCurve; pskA?: Bytes; pskB?: Bytes; peerB?: string } = {}): Promise<{ a: Tunnel; b: Tunnel }> {
  const ea = await ephemeral(opts.curve);
  const eb = await ephemeral(opts.curve);
  const psk = pskFromHex(PSK_HEX);
  const a = await derive("initiator", ea, eb.publicKey, opts.pskA ?? psk, BINDING);
  const b = await derive("responder", eb, ea.publicKey, opts.pskB ?? psk, { ...BINDING, peer: opts.peerB ?? BINDING.peer });
  return { a, b };
}

describe("tunnel", () => {
  test("a round trip both ways, in order, with the frames intact", async () => {
    const { a, b } = await pair();
    const up = ['{"jsonrpc":"2.0","id":1,"method":"hello"}', "second ☃ frame", ""];
    const sealed = await Promise.all(up.map((t) => a.seal(t)));
    for (const s of sealed) expect(s).not.toContain("hello");
    const opened: string[] = [];
    for (const s of sealed) opened.push(await b.open(s));
    expect(opened).toEqual(up);
    const down = await b.seal('{"jsonrpc":"2.0","id":1,"result":{}}');
    expect(await a.open(down)).toBe('{"jsonrpc":"2.0","id":1,"result":{}}');
    // the two directions are keyed apart: a record sealed downward never opens upward
    await expect(b.open(down)).rejects.toBeInstanceOf(TunnelError);
  });

  test("the sequence is implicit: a record out of order, replayed or skipped fails", async () => {
    const { a, b } = await pair();
    const r1 = await a.seal("one");
    const r2 = await a.seal("two");
    const r3 = await a.seal("three");
    await expect(b.open(r2)).rejects.toMatchObject({ code: "bad_record" });
    // the responder's counter moved past 0 on the failure; nothing recovers a broken stream
    await expect(b.open(r1)).rejects.toMatchObject({ code: "bad_record" });
    const { a: a2, b: b2 } = await pair();
    const s1 = await a2.seal("one");
    expect(await b2.open(s1)).toBe("one");
    await expect(b2.open(s1)).rejects.toMatchObject({ code: "bad_record" });
    void r3;
  });

  test("a tampered record fails on its tag", async () => {
    const { a, b } = await pair();
    const r = await a.seal("payload");
    const bytes = fromBase64(r);
    bytes[3] = (bytes[3]! + 1) & 0xff;
    await expect(b.open(toBase64(bytes))).rejects.toMatchObject({ code: "bad_record" });
    await expect(b.open("not base64!!")).rejects.toMatchObject({ code: "bad_record" });
  });

  test("a wrong pre-shared secret fails on the first record, in either direction", async () => {
    const other = pskFromHex("0000000000000000000000000000000000000000000000000000000000000001");
    const { a, b } = await pair({ pskB: other });
    await expect(b.open(await a.seal("hello"))).rejects.toMatchObject({ code: "bad_record" });
    await expect(a.open(await b.seal("welcome"))).rejects.toMatchObject({ code: "bad_record" });
  });

  test("the binding is part of the key: a swapped peer id fails", async () => {
    const { a, b } = await pair({ peerB: "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC2" });
    await expect(b.open(await a.seal("hello"))).rejects.toMatchObject({ code: "bad_record" });
    const ea = await ephemeral();
    const eb = await ephemeral();
    const psk = pskFromHex(PSK_HEX);
    const asNode = await derive("initiator", ea, eb.publicKey, psk, { kind: "node", peer: BINDING.peer });
    const asController = await derive("responder", eb, ea.publicKey, psk, { kind: "controller", peer: BINDING.peer });
    await expect(asController.open(await asNode.seal("hello"))).rejects.toMatchObject({ code: "bad_record" });
  });

  test("P-256 works the same when asked for", async () => {
    const { a, b } = await pair({ curve: "p256" });
    expect(fromBase64((await ephemeral("p256")).publicKey).length).toBe(65);
    expect(fromBase64((await ephemeral()).publicKey).length).toBe(32);
    expect(await b.open(await a.seal("over p256"))).toBe("over p256");
    // the curves do not mix: an X25519 key is not a P-256 point
    const x = await ephemeral();
    const p = await ephemeral("p256");
    await expect(derive("initiator", p, x.publicKey, pskFromHex(PSK_HEX), BINDING)).rejects.toMatchObject({ code: "bad_key" });
  });

  test("sealing is serialized: concurrent seals leave in call order and open in that order", async () => {
    const { a, b } = await pair();
    const texts = Array.from({ length: 50 }, (_, i) => `frame ${i}`);
    const sealed = await Promise.all(texts.map((t) => a.seal(t)));
    const opened = await Promise.all(sealed.map((s) => b.open(s)));
    expect(opened).toEqual(texts);
  });

  test("the secrets: hex must be 32 bytes; an invite's secret hashes to what its minter keeps", async () => {
    expect(() => pskFromHex("abcd")).toThrow();
    expect(() => pskFromHex("zz".repeat(32))).toThrow();
    expect(pskFromHex(PSK_HEX).length).toBe(32);
    const secret = "ab".repeat(32);
    const t = await pskFromSecret(secret);
    expect(t.length).toBe(32);
    // the minter keeps sha256(secret) as hex: the same bytes, without the secret
    expect(toBase64(t)).toBe(toBase64(pskFromHex(createHash("sha256").update(secret, "utf8").digest("hex"))));
    expect(toBase64(t)).not.toBe(toBase64(await pskFromSecret("cd".repeat(32))));
    // the pairing constant: the same everywhere, 32 bytes, and not a secret's hash
    const p = await pairingPsk();
    expect(p.length).toBe(32);
    expect(toBase64(p)).toBe(toBase64(await pairingPsk()));
    expect(toBase64(p)).not.toBe(toBase64(t));
  });

  test("a pairing tunnel keyed from the constant speaks, and its binding still guards it", async () => {
    const ea = await ephemeral();
    const eb = await ephemeral();
    const binding = { kind: "pair", peer: "pair_Hq3m9TzW1vKc0aLx" } as const;
    const a = await derive("initiator", ea, eb.publicKey, await pairingPsk(), binding);
    const b = await derive("responder", eb, ea.publicKey, await pairingPsk(), binding);
    expect(await b.open(await a.seal("pair.account"))).toBe("pair.account");
    const c = await derive("responder", eb, ea.publicKey, await pairingPsk(), { kind: "controller", peer: binding.peer });
    await expect(c.open(await a.seal("again"))).rejects.toBeInstanceOf(TunnelError);
  });
});
