// A client of a linked secondary is served by the primary: its `hello` answers with the
// primary's node id and `via: relay`; `chat.send` reaches the fake brain; `session.list` is
// the merged list; `view.stage` is still answered by the secondary, whose files the client
// can fetch; the link dropping closes the client, which reconnects and is served locally
// with `node.state` showing the primary offline; a revoked controller's relayed socket closes.

import { afterEach, describe, expect, test } from "bun:test";
import type { Client, Node, Session } from "@cophyla/protocol";
import { brainFrames, isMethod, TestClient, waitFor } from "./helpers.ts";
import { client, linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

let primary: Primary | undefined;
let secondary: Started | undefined;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients) c.close();
  clients.length = 0;
  await stopAll(secondary, primary?.d);
  primary = undefined;
  secondary = undefined;
});

const script = { on: [{ event: "user.message", requests: [{ method: "ui.say", params: { blocks: [{ type: "text", text: "heard: $event.text" }] } }] }] };

describe("relayed clients", () => {
  test("a client on the secondary is served by the primary while linked, and locally once the link is gone", async () => {
    primary = await startPrimary({ brain: { script } });
    secondary = await startSecondary(primary, { agent: true });
    await linked(secondary);
    await waitFor(() => primary!.d.brain?.state === "up");
    const c = await TestClient.connect(secondary.api.url);
    clients.push(c);
    const hello = await c.hello(secondary.token, { name: "laptop app" });
    expect("result" in hello).toBe(true);
    const result = (hello as { result: { client: Client; node: string } }).result;
    expect(result.node).toBe(primary.d.identity.id);
    expect(result.client.via).toBe("relay");
    // The welcome came from the primary: its nodes, and the secondary's own session once one exists.
    await c.next(isMethod("node.state", (p) => (p as Node).id === primary!.d.identity.id));
    const ws = secondary.workspaces.put({ node: secondary.identity.id, path: secondary.home, name: "second" });
    const spawned = await secondary.sessions.spawn({ harness: "claude", workspace: ws.id, prompt: "say hi" }, { profiles: secondary.profiles });
    await c.next(isMethod("session.state", (p) => (p as Session).id === spawned.id), 10_000);
    // The chat reaches the brain on the primary; the reply comes back down the link.
    await c.request("chat.send", { text: "hello from the laptop" });
    await waitFor(() => brainFrames(primary!.brainLog!).some((f) => f.dir === "in" && f.frame["method"] === "user.message"));
    const said = await c.next(isMethod("chat.message", (p) => (p as { message: { role: string } }).message.role === "orchestrator"));
    expect(said).toBeDefined();
    // The merged list, and this client in the primary's registry as a relay.
    const list = await c.request<{ sessions: Session[] }>("session.list");
    expect(list.sessions.map((s) => s.id)).toContain(spawned.id);
    expect(primary.d.clients.list().some((cl) => cl.id === result.client.id && cl.via === "relay")).toBe(true);
    expect(secondary.clients.list().some((cl) => cl.id === result.client.id)).toBe(true);
    // `view.stage` is answered by the secondary: the URL is this listener's, not the primary's.
    const staged = await c.request<{ base: string }>("view.stage", { id: "default" });
    expect(staged.base.startsWith(`http://127.0.0.1:${secondary.api.port}/view/`)).toBe(true);
    // The link goes: the relayed socket is closed; a new one is served locally, and the primary reads offline.
    await stopAll(primary.d);
    const closed = await c.closed;
    expect(closed.code).toBe(4409);
    await waitFor(() => !secondary!.nodes.linked());
    const again = await TestClient.connect(secondary.api.url);
    clients.push(again);
    const local = (await again.hello(secondary.token, { name: "laptop app" })) as { result: { client: Client; node: string } };
    expect(local.result.node).toBe(secondary.identity.id);
    expect(local.result.client.via).toBe("direct");
    const offline = await again.next(isMethod("node.state", (p) => (p as Node).id === primary!.d.identity.id));
    expect((offline.params as Node).status).toBe("offline");
    primary = undefined;
  }, 30_000);

  test("a linked secondary's controller listener relays a paired phone, and revoking it closes the relayed socket", async () => {
    primary = await startPrimary();
    secondary = await startSecondary(primary, { controller: true });
    await linked(secondary);
    const desk = await client(secondary);
    clients.push(desk);
    // The desktop is relayed too, but pairing is about this node's phones: `pair.start` is answered here.
    const window = await desk.request<{ code: string; url: string }>("pair.start");
    expect(window.url.startsWith(`https://`)).toBe(true);
    const phone = await TestClient.connect(`wss://127.0.0.1:${secondary.controller!.port}/ws/client`, { insecure: true });
    clients.push(phone);
    const claimed = await phone.request<{ token: string; client: { id: string } }>("pair.claim", { code: window.code, name: "Pixel" });
    const hello = (await phone.hello(claimed.token, { kind: "controller", audio: { in: true, out: true } })) as { result: { client: Client; node: string } };
    expect(hello.result.node).toBe(primary.d.identity.id);
    expect(hello.result.client.via).toBe("relay");
    // Listed and revoked through the relayed desktop, on the node whose row it is: the relayed socket closes at once.
    const listed = await desk.request<{ controllers: { id: string; connected: boolean }[] }>("controller.list");
    expect(listed.controllers.find((x) => x.id === claimed.client.id)?.connected).toBe(true);
    await desk.request("controller.revoke", { id: claimed.client.id });
    const closed = await phone.closed;
    expect(closed.code).toBe(4401);
    await waitFor(() => !primary!.d.clients.list().some((cl) => cl.id === hello.result.client.id));
  }, 30_000);
});
