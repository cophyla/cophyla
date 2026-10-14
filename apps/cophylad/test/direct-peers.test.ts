// A data channel as a socket, over a real tunnel: a frame too big for one helper message goes
// as several, the far end hears each piece as it comes (the node link's switch counts them as
// the other side heard while the frame is still arriving), and the frame opens whole once its
// last piece is in.

import { expect, test } from "bun:test";
import { derive, ephemeral, pskFromHex } from "@cophyla/relay";
import { ChannelSocket } from "../src/direct/peers.ts";
import { silentLogger } from "../src/log.ts";
import { waitFor } from "./helpers.ts";

const KEY = "cd".repeat(32);
const BINDING = { kind: "node", peer: "node_01ARZ3NDEKTSV4RRFFQ69G5FC1" } as const;

test("each piece of a frame is told as it comes, and the frame opens whole after the last", async () => {
  const [ei, er] = await Promise.all([ephemeral(), ephemeral()]);
  const [ti, tr] = await Promise.all([derive("initiator", ei, er.publicKey, pskFromHex(KEY), BINDING), derive("responder", er, ei.publicKey, pskFromHex(KEY), BINDING)]);
  const messages: string[] = [];
  const near = new ChannelSocket({ peer: "p", tunnel: ti, send: (m) => (messages.push(m), true), close: () => undefined, log: silentLogger, remote: "direct:p" });
  const far = new ChannelSocket({ peer: "p", tunnel: tr, send: () => true, close: () => undefined, log: silentLogger, remote: "direct:p" });
  const texts: string[] = [];
  let pieces = 0;
  far.attach(
    (t) => texts.push(t),
    () => undefined,
    () => pieces++,
  );

  const big = JSON.stringify({ jsonrpc: "2.0", method: "replicate.write", params: { pad: "z".repeat(100_000) } });
  near.send(big);
  await waitFor(() => messages.length > 0);
  expect(messages.length).toBeGreaterThan(5);
  for (const [i, m] of messages.entries()) {
    far.receive(m);
    expect(pieces).toBe(i + 1);
    if (i < messages.length - 1) expect(texts).toEqual([]);
  }
  await waitFor(() => texts.length === 1);
  expect(texts[0]).toBe(big);
});
