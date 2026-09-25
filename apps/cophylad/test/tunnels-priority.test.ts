// The two queues in front of a tunnel's seal: a frame sent urgent overtakes the bulk waiting
// ahead of it, each class keeps its own order, and the far end still opens every record in
// sequence, because the number is taken when the record is sealed.

import { expect, test } from "bun:test";
import { RpcError } from "@cophyla/protocol";
import { derive, ephemeral, pskFromHex } from "@cophyla/relay";
import type { NodeSocket } from "../src/api/server.ts";
import { Tunnels } from "../src/cloud/tunnels.ts";
import { silentLogger } from "../src/log.ts";
import { waitFor } from "./helpers.ts";

const KEY = "ab".repeat(32);
const PEER = "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC1";

test("urgent frames overtake queued normal ones and still open in order", async () => {
  const records: string[] = [];
  let sock!: NodeSocket;
  const tunnels = new Tunnels({
    log: silentLogger,
    link: {
      notify: (method, params) => {
        if (method === "relay") records.push((params as { frame: string }).frame);
        return true;
      },
      request: async () => ({}),
    },
    controllerKey: () => KEY,
    acceptClient: () => (s) => {
      sock = s;
      return { message: () => {}, close: () => {} };
    },
    acceptNode: () => {
      throw new RpcError("denied", "no nodes here");
    },
    acceptPairing: () => undefined,
    subject: () => undefined,
  });
  const eph = await ephemeral();
  const { epk } = await tunnels.accept({ peer: PEER, kind: "controller", epk: eph.publicKey });
  const far = await derive("initiator", eph, epk, pskFromHex(KEY), { kind: "controller", peer: PEER });

  for (let i = 0; i < 5; i++) sock.send(`bulk ${i}`);
  sock.send("voice 0", { urgent: true });
  sock.send("voice 1", { urgent: true });
  await waitFor(() => records.length === 7);
  const opened: string[] = [];
  for (const r of records) opened.push(await far.open(r));
  // Nothing was sealed yet when the voice frames came: they go first, in their order, then the bulk in its own.
  expect(opened).toEqual(["voice 0", "voice 1", "bulk 0", "bulk 1", "bulk 2", "bulk 3", "bulk 4"]);
  tunnels.closeAll("done");
});
