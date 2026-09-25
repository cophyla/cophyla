// `acceptTunnel` on its own: a connection the api serves from a socket it did not open —
// what the cloud module hands it once a tunnel is decrypted. No server, no relay: the test
// plays the tunnel with an in-memory socket, and checks the `cloud` listener's rules.

import { afterEach, describe, expect, test } from "bun:test";
import type { Client, Controller } from "@cophyla/protocol";
import type { Daemon } from "../src/daemon.ts";
import type { NodeSocketHandler } from "../src/api/server.ts";
import { stopDaemon, testDaemon, TestClient, waitFor } from "./helpers.ts";

let current: (Daemon & { home: string }) | undefined;
afterEach(async () => {
  if (current) await stopDaemon(current);
  current = undefined;
});

/** The far end of a tunnel as the api sees it: what it wrote, and the close it got. */
class FakeTunnel {
  readonly frames: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { data?: { code: string } } }[] = [];
  closed?: { code: number; reason: string };
  handler!: NodeSocketHandler;
  private waiters: { test: (f: FakeTunnel["frames"][number]) => boolean; resolve: (f: FakeTunnel["frames"][number]) => void }[] = [];
  private n = 0;

  attach(d: Daemon): void {
    this.handler = d.api.acceptTunnel({
      send: (text) => {
        const f = JSON.parse(text) as FakeTunnel["frames"][number];
        this.frames.push(f);
        for (const w of [...this.waiters]) if (w.test(f)) (this.waiters.splice(this.waiters.indexOf(w), 1), w.resolve(f));
      },
      close: (code, reason) => {
        this.closed = { code, reason };
      },
      remote: "relay:ctl_test",
    });
  }

  call(method: string, params: unknown = {}): Promise<FakeTunnel["frames"][number]> {
    const id = ++this.n;
    const p = this.wait((f) => f.id === id);
    this.handler.message(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return p;
  }

  wait(test: (f: FakeTunnel["frames"][number]) => boolean, ms = 5000): Promise<FakeTunnel["frames"][number]> {
    const have = this.frames.find(test);
    if (have) return Promise.resolve(have);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no frame")), ms);
      this.waiters.push({ test, resolve: (f) => (clearTimeout(t), resolve(f)) });
    });
  }
}

describe("api: a tunnel served as a connection", () => {
  test("hello by controller token, served through the gate with via relay; the LAN-only requests are unsupported; the close is a disconnect", async () => {
    const d = (current = await testDaemon("[controller]\nenabled = true\nport = 0\n"));
    const ui = await TestClient.connect(d.api.url);
    await ui.hello(d.token, { name: "desktop" });
    const { controller, token } = d.grants.createController("Pixel");
    const t = new FakeTunnel();
    t.attach(d);
    // the shared desktop token never authenticates here, like on the LAN
    const shared = await t.call("hello", { token: d.token, kind: "ui", audio: { in: false, out: false } });
    expect(shared.error?.data?.code).toBe("denied");
    expect(t.closed?.code).toBe(4401);
    // a second tunnel, the phone's own token
    const t2 = new FakeTunnel();
    t2.attach(d);
    const hello = await t2.call("hello", { token, kind: "controller", audio: { in: true, out: true } });
    const client = (hello.result as { client: Client }).client;
    expect(client).toMatchObject({ kind: "controller", controller: controller.id, via: "relay" });
    expect(d.clients.get(client.id)?.listener).toBe("cloud");
    expect((await ui.request<{ controllers: Controller[] }>("controller.list", {})).controllers[0]!.connected).toBe(true);
    // served like any client, audited under its principal
    expect((await t2.call("session.list", {})).result).toEqual({ sessions: [] });
    expect(d.store.audit.list({ limit: 20 }).some((e) => e.action === "session.list" && e.principal.kind === "user" && e.principal.client === client.id)).toBe(true);
    // broadcasts reach it
    const ask = d.asks.open({ type: "choice", source: { kind: "brain" }, title: "Tunnel?", options: [{ id: "y", label: "Yes" }], answerableBy: ["user"] });
    expect(((await t2.wait((f) => f.method === "ask.state" && (f.params as { id: string }).id === ask.id)).params as { title: string }).title).toBe("Tunnel?");
    // the LAN-only requests
    expect((await t2.call("pair.claim", { code: "123456", name: "x" })).error?.data?.code).toBe("unsupported");
    expect((await t2.call("view.stage", { id: "default" })).error?.data?.code).toBe("unsupported");
    expect((await t2.call("remote.open", { node: d.identity.id })).error?.data?.code).toBe("unsupported");
    expect((await t2.call("relay.info", {})).error?.data?.code).toBe("unsupported");
    // the push registration is served here (the row is this node's) and the token stays out of the audit
    expect((await t2.call("push.register", { platform: "android", token: "fcm-secret-token" })).result).toEqual({});
    expect(d.grants.pushOf(controller.id)).toMatchObject({ platform: "android", token: "fcm-secret-token" });
    expect(JSON.stringify(d.store.audit.list({ limit: 20 }))).not.toContain("fcm-secret-token");
    expect((await ui.request<{ controllers: Controller[] }>("controller.list", {})).controllers[0]!.push).toMatchObject({ platform: "android" });
    // the tunnel ends: the client is gone
    t2.handler.close(4409, "tunnel closed");
    await waitFor(() => d.clients.get(client.id) === undefined);
    expect((await ui.request<{ controllers: Controller[] }>("controller.list", {})).controllers[0]!.connected).toBe(false);
    ui.close();
  });

  test("a tunnel that never says hello is closed after the deadline; the desktop cannot register a push device", async () => {
    const d = (current = await testDaemon("[controller]\nenabled = true\nport = 0\n"));
    const ui = await TestClient.connect(d.api.url);
    await ui.hello(d.token, { name: "desktop" });
    const t = new FakeTunnel();
    t.attach(d);
    expect((await t.call("session.list", {})).error?.data?.code).toBe("denied");
    expect(t.closed?.code).toBe(4401);
    expect(await ui.call("push.register", { platform: "android", token: "x" })).toMatchObject({ error: { data: { code: "denied" } } });
    ui.close();
  });
});
