// A machine's name is the user's: the name given in the invite becomes the joining machine's
// own (unless the user named it there already), `node.rename` from an app on the primary names
// the primary or a linked node, every node's copy of the registry follows, and the name is
// kept across a restart over `[node] name` and the host's.

import { afterEach, describe, expect, test } from "bun:test";
import type { Node, NodeRecord } from "@cophyla/protocol";
import { loadNodeIdentity } from "../src/nodes/self.ts";
import { parseConfig } from "../src/config/load.ts";
import { Store } from "../src/store/index.ts";
import { waitFor } from "./helpers.ts";
import type { TestClient } from "./helpers.ts";
import { client, inviteOn, linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

const daemons: (Started | undefined)[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  await stopAll(...daemons.reverse());
  daemons.length = 0;
});

describe("machine names", () => {
  test("the invite's name is the joining machine's; node.rename names a linked node and the primary, and every copy follows", async () => {
    const primary: Primary = await startPrimary();
    daemons.push(primary.d);
    // startSecondary redeems an invite named "test node"; a write the primary forwards asks the owner unless a rule says otherwise
    const secondary = await startSecondary(primary, { gateRules: { "node:node.rename": "allow" } });
    daemons.push(secondary);
    await linked(secondary);
    expect(secondary.identity.name).toBe("test node");
    expect(secondary.node().name).toBe("test node");
    await waitFor(() => primary.d.nodes.registry.get(secondary.identity.id)?.name === "test node", 5000);

    const c = await client(primary.d);
    clients.push(c);
    await c.request("node.rename", { id: secondary.identity.id, name: "  Laptop " });
    expect(secondary.identity.name).toBe("Laptop");
    expect(secondary.store.meta.get("node_name")).toBe("Laptop");
    await waitFor(async () => (await c.request<{ nodes: Node[] }>("node.list")).nodes.find((n) => n.id === secondary.identity.id)?.name === "Laptop", 5000);

    await c.request("node.rename", { id: primary.d.identity.id, name: "Desk" });
    expect(primary.d.identity.name).toBe("Desk");
    await waitFor(() => secondary.nodes.registry.get(primary.d.identity.id)?.name === "Desk", 5000);
    // the client sees the primary's row change
    await c.next((n) => n.method === "node.state" && (n.params as NodeRecord).id === primary.d.identity.id && (n.params as NodeRecord).name === "Desk", 5000);

    // a blank name and a node nobody knows are refused
    const blank = await c.call("node.rename", { id: secondary.identity.id, name: "   " });
    expect("error" in blank ? blank.error.data?.code : "answered").toBe("invalid");
    const nobody = await c.call("node.rename", { id: "node_01ARZ3NDEKTSV4RRFFQ69G5ZZZ", name: "x" });
    expect("error" in nobody ? nobody.error.data?.code : "answered").toBe("not_found");
  }, 30_000);

  test("a machine named in its config keeps that name when it joins; a name given in the app wins over config and host after a restart", async () => {
    const primary: Primary = await startPrimary();
    daemons.push(primary.d);
    const named = await startSecondary(primary, { node: 'name = "build box"\n', unjoined: true });
    daemons.push(named);
    await named.nodes.join(await inviteOn(primary, { name: "Laptop" }));
    expect(named.identity.name).toBe("build box");
    expect(named.store.meta.get("node_name")).toBeUndefined();

    const store = new Store(":memory:");
    store.migrate();
    const config = parseConfig('[node]\nname = "from config"\n');
    expect(loadNodeIdentity(store, config).name).toBe("from config");
    store.meta.set("node_name", "from the app");
    expect(loadNodeIdentity(store, config).name).toBe("from the app");
    store.close();
  }, 30_000);
});
