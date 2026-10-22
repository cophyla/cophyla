// A transfer whose receiving machine goes offline: three daemons on one machine, a primary and
// two secondaries, a file going from one secondary to the other. The receiver stops mid-file,
// and the row shows its machine offline. A Cancel then takes it from every list at once; when the
// machine comes back it is cancelled and dismissed there, what had come is deleted, and nothing
// that machine says of it before then shows again.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RpcNotification, Transfer } from "@cophyla/protocol";
import { TRANSFER_ENDS_NS } from "../src/nodes/transfers.ts";
import { removeHome, tempHome, TestClient, waitFor } from "./helpers.ts";
import { client, linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

function rowOf(c: TestClient, id: string, pred: (t: Transfer) => boolean = () => true): Promise<Transfer> {
  return c.next((n: RpcNotification) => n.method === "transfer.state" && (n.params as Transfer).id === id && pred(n.params as Transfer), 20_000).then((n) => n.params as Transfer);
}

const FAST = { transfers: { backoff: { firstMs: 100, maxMs: 400 }, relayConfirmBytes: 1000 } };
const BEAT = 1000;

describe("a transfer whose machine is offline", () => {
  let scratch: string;
  let primary: Primary;
  let a: Started;
  let b: Started;
  let c: TestClient;

  beforeAll(async () => {
    scratch = tempHome();
    primary = await startPrimary({ heartbeatMs: BEAT, daemon: FAST });
    a = await startSecondary(primary, { heartbeatMs: BEAT, daemon: FAST });
    b = await startSecondary(primary, { heartbeatMs: BEAT, daemon: FAST });
    await linked(a);
    await linked(b);
    c = await client(primary.d);
    await waitFor(() => primary.d.nodes.registry.get(a.identity.id)?.capabilities.files && primary.d.nodes.registry.get(b.identity.id)?.capabilities.files);
    await waitFor(() => b.nodes.registry.get(a.identity.id)?.status === "online");
  }, 60_000);

  afterAll(async () => {
    c?.close();
    await stopAll(b, a, primary?.d);
    removeHome(scratch);
  });

  test("a Cancel takes it from every list now, and ends it on that machine when it is back", async () => {
    const src = join(scratch, "on-a");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "big.bin"), new Uint8Array(4 * 1024 * 1024));
    const dir = join(scratch, "b-in");
    // b's pull never gets a pipe: the transfer stays under way until b stops
    b.pipes.openForFile = () => new Promise(() => undefined);
    const r = await c.request<{ transfer: Transfer }>("transfer.start", { from: { node: a.identity.id, path: join(src, "big.bin") }, to: { node: b.identity.id, dir } });
    const id = r.transfer.id;
    await waitFor(() => b.transfers.get(id)?.state === "running", 10_000);

    const home = b.home;
    await b.stop();
    const away = await rowOf(c, id, (t) => t.state === "waiting");
    expect(away.error).toBe("its machine is offline");

    // Cancel, with the machine offline: gone from every list at once
    const seenFrom = c.notifications.length;
    expect(await c.request<Record<string, never>>("transfer.cancel", { id })).toEqual({});
    const cancelled = await rowOf(c, id, (t) => t.dismissed === true);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.error).toBeUndefined();
    expect((await c.request<{ transfers: Transfer[] }>("transfer.list", {})).transfers.some((t) => t.id === id)).toBe(false);
    expect(primary.d.store.kv.list(TRANSFER_ENDS_NS)).toEqual([id]);
    // a second press finds nothing to cancel
    const again = await c.request("transfer.cancel", { id }).then(
      () => "answered",
      (e: Error) => e.message,
    );
    expect(again).toBe(`no transfer ${id} on this machine`);

    // b comes back with its source offline, so its transfer waits rather than lands
    await a.stop();
    const { startDaemon } = await import("../src/daemon.ts");
    const { silentLogger } = await import("../src/log.ts");
    b = Object.assign(await startDaemon({ home, port: 0, log: silentLogger, brain: false, embedder: null, ...FAST }), { home });
    expect(b.transfers.get(id)).toBeDefined();
    await linked(b, 10_000);
    await waitFor(() => b.transfers.get(id) === undefined, 10_000);
    expect(readdirSync(dir)).toEqual([]);
    expect(primary.d.store.kv.list(TRANSFER_ENDS_NS)).toEqual([]);
    // what b said of it as it was ended there never reached a client
    await Bun.sleep(300);
    const after = c.notifications.slice(seenFrom).filter((n) => n.method === "transfer.state" && (n.params as Transfer).id === id);
    expect(after.map((n) => [(n.params as Transfer).state, (n.params as Transfer).dismissed])).toEqual([["cancelled", true]]);
    expect((await c.request<{ transfers: Transfer[] }>("transfer.list", {})).transfers.some((t) => t.id === id)).toBe(false);
  }, 60_000);
});
