// The direct connections' switch on a daemon signed in to the fake server, with a fake
// helper: off until switched on, then starting and ready with the helper's port; the switch
// and the port kept in the store; the plan losing it, or the account signing out, leaves it
// unavailable with the reason and the helper stopped, and the plan coming back brings it up
// again; a plan without it refuses the switch; TURN credentials come from the server, land
// in the stream viewer's file and go with the switch.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientNotificationParams } from "@cophyla/protocol";
import { paths } from "../src/config/load.ts";
import type { Daemon } from "../src/daemon.ts";
import { silentLogger } from "../src/log.ts";
import { FakeNet } from "./fakes/net.ts";
import { FakeServer } from "./fakes/server.ts";
import { isMethod, removeHome, tempHome, TestClient, waitFor } from "./helpers.ts";

type DirectState = ClientNotificationParams<"direct.state">;

interface Started {
  d: Daemon & { home: string };
  c: TestClient;
  fake: FakeServer;
  net: FakeNet;
}

let current: Started | undefined;
afterEach(async () => {
  if (!current) return;
  const s = current;
  current = undefined;
  s.c.close();
  await s.d.stop();
  await s.fake.stop();
  removeHome(s.d.home);
});

async function start(opts: { plan?: string } = {}): Promise<Started> {
  const fake = new FakeServer();
  if (opts.plan) fake.plan = opts.plan;
  const net = new FakeNet();
  const scratch = tempHome();
  writeFileSync(
    join(scratch, "config.toml"),
    `[nodes]\ndiscovery = false\n\n[sessions]\ndiscover = false\ninstall_hooks = false\n\n[update]\nenabled = false\n\n[brain]\nenabled = false\n\n[direct]\nrestart_backoff_ms = 20\n\n[cloud]\nenabled = true\nurl = "${fake.url}"\nallow_insecure = true\n`,
  );
  const p = paths(scratch);
  mkdirSync(p.data, { recursive: true });
  writeFileSync(p.accountToken, fake.mintToken() + "\n", { mode: 0o600 });
  const { startDaemon } = await import("../src/daemon.ts");
  const d = Object.assign(
    await startDaemon({ home: scratch, port: 0, log: silentLogger, brain: false, embedder: null, cloud: { keys: [fake.publicKey] }, direct: { spawn: net.spawn, command: () => "cophyla-net" } }),
    { home: scratch },
  );
  const c = await TestClient.connect(d.api.url);
  await c.hello(d.token, { name: "test" });
  current = { d, c, fake, net };
  return current;
}

/** The first `direct.state` after `action` that `want` takes. */
async function after(c: TestClient, action: () => unknown, want: (s: DirectState) => boolean): Promise<DirectState> {
  const mark = c.notifications.length;
  await action();
  return waitFor(() => c.notifications.slice(mark).find((n) => n.method === "direct.state" && want(n.params as DirectState))?.params as DirectState | undefined, 5000);
}

describe("direct connections' switch", () => {
  test("off, switched on: starting then ready on the helper's port; kept; switched off: the helper told to go", async () => {
    const { d, c, net } = await start();
    await waitFor(() => d.cloud.state().plan === "pro" && d.cloud.state().connected === true);
    expect(d.direct.state()).toEqual({ node: d.identity.id, state: "off", peers: [] });
    const ready = await after(c, () => c.request("direct.enable", {}), (s) => s.state === "ready" && s.mapping !== undefined);
    expect(ready).toEqual({ node: d.identity.id, state: "ready", port: 50_000, mapping: { status: "none", protocols: [] }, ipv6: false, peers: [] });
    expect(d.store.meta.get("direct_enabled")).toBe("1");
    expect(d.store.meta.get("direct_port")).toBe("50000");
    expect(net.live!.requests[1]!.params).toMatchObject({ port: 0, stun: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"], predict: 12, map: true, ipv6: true });
    const helper = net.live!;
    await after(c, () => c.request("direct.disable", {}), (s) => s.state === "off");
    expect(helper.notified.map((n) => n.method)).toEqual(["shutdown"]);
    expect(d.store.meta.get("direct_enabled")).toBe("0");
    // on again: the kept port is asked for first
    await after(c, () => c.request("direct.enable", {}), (s) => s.state === "ready");
    expect(net.live!.requests.find((r) => r.method === "net.configure")!.params["port"]).toBe(50_000);
    const rows = d.store.audit.list({ limit: 100 }).filter((e) => e.action.startsWith("direct."));
    expect(rows.map((e) => e.action).sort()).toEqual(["direct.disable", "direct.enable", "direct.enable"]);
  });

  test("the plan losing it leaves it unavailable and the helper stopped; the plan back brings it up; a sign-out says so", async () => {
    const { d, c, fake, net } = await start();
    await waitFor(() => d.cloud.state().connected === true);
    await after(c, () => c.request("direct.enable", {}), (s) => s.state === "ready");
    const first = net.live!;
    expect(await after(c, () => fake.setPlan("free"), (s) => s.state === "unavailable")).toMatchObject({ reason: "the plan has no direct connections" });
    expect(first.exited).toBe(true);
    await after(c, () => fake.setPlan("pro"), (s) => s.state === "ready");
    expect(net.helpers).toHaveLength(2);
    expect(await after(c, () => c.request("account.logout"), (s) => s.state === "unavailable")).toMatchObject({ reason: "sign in to use direct connections" });
    expect(net.live).toBeUndefined();
  });

  test("a plan without it refuses the switch; a new client hears where it stands", async () => {
    const { d, c } = await start({ plan: "free" });
    await waitFor(() => d.cloud.state().connected === true);
    const r = await c.call("direct.enable", {});
    expect("error" in r && r.error.data?.code).toBe("unavailable");
    expect("error" in r && r.error.message).toBe("the plan has no direct connections");
    expect(d.store.meta.get("direct_enabled")).toBeUndefined();
    const again = await TestClient.connect(d.api.url);
    try {
      const told = again.next(isMethod("direct.state", (p) => (p as DirectState).node === d.identity.id), 5000);
      await again.hello(d.token, { name: "late" });
      expect((await told).params).toEqual({ node: d.identity.id, state: "off", peers: [] });
    } finally {
      again.close();
    }
  });

  test("TURN credentials: minted once by the server, written for the stream viewer, gone with the switch", async () => {
    const { d, c, fake } = await start();
    await waitFor(() => d.cloud.state().connected === true);
    await expect(d.direct.iceServers()).rejects.toThrow("not running");
    await after(c, () => c.request("direct.enable", {}), (s) => s.state === "ready");
    const grant = await d.direct.iceServers();
    await d.direct.iceServers();
    expect(fake.turnGrants).toHaveLength(1);
    expect(grant.iceServers.some((s) => s.username === fake.turnGrants[0]!.username)).toBe(true);
    const file = join(d.home, "data", "remote", "ice-servers.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(grant.iceServers.map((s) => ({ urls: Array.isArray(s.urls) ? s.urls : [s.urls], username: s.username ?? "", credential: s.credential ?? "" })));
    await after(c, () => c.request("direct.disable", {}), (s) => s.state === "off");
    expect(existsSync(file)).toBe(false);
  });
});
