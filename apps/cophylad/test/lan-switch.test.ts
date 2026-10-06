// The one switch for devices on the node's network (`lan.info`, `lan.enable`, `lan.disable`),
// and the listener behind it: up for other nodes alone it answers `/ws/node` and refuses the
// rest at HTTP; switched on it serves devices and comes up where it was down; switched off it
// closes the devices connected there and stops where no node needs it. The switch is kept
// over the config, a port that cannot be bound is said, and each node answers for itself.

import { afterEach, describe, expect, test } from "bun:test";
import type { Controller, LanState } from "@cophyla/protocol";
import { lanLines, runCommand } from "../src/cli.ts";
import { startDaemon } from "../src/daemon.ts";
import type { Daemon } from "../src/daemon.ts";
import { silentLogger } from "../src/log.ts";
import { removeHome, testDaemon, TestClient, waitFor } from "./helpers.ts";
import { client, linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

type Home = Daemon & { home: string };

let homes: Home[] = [];
let primary: Primary | undefined;
let secondary: Started | undefined;
const sockets: TestClient[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const d of homes.splice(0)) {
    await d.stop().catch(() => undefined);
    removeHome(d.home);
  }
  await stopAll(secondary, primary?.d);
  primary = undefined;
  secondary = undefined;
});

async function daemon(toml: string): Promise<Home> {
  const d = await testDaemon(toml);
  homes.push(d);
  return d;
}

async function desk(d: Daemon): Promise<TestClient> {
  const c = await TestClient.connect(d.api.url);
  sockets.push(c);
  await c.hello(d.token, { name: "desktop" });
  return c;
}

const get = (url: string): Promise<Response> => fetch(url, { tls: { rejectUnauthorized: false } } as never);
const at = (d: Daemon): string => `https://127.0.0.1:${d.controller!.port}`;

async function opens(url: string): Promise<TestClient | undefined> {
  try {
    const c = await TestClient.connect(url, { insecure: true });
    sockets.push(c);
    return c;
  } catch {
    return undefined;
  }
}

describe("the listener up for other nodes alone", () => {
  test("it links a node, and serves no device anything: refused at HTTP, before any socket", async () => {
    primary = await startPrimary({ nodesOnly: true });
    const d = primary.d;
    secondary = await startSecondary(primary);
    await linked(secondary);
    const ui = await desk(d);
    const info = await ui.request<LanState>("lan.info", {});
    expect(info).toMatchObject({ enabled: false, state: "nodes", port: d.controller!.port, addresses: [], keys: 0 });
    // the key's hash a node link pins is still told
    expect(info.fingerprints?.key).toBeDefined();
    expect(d.lan.spki).toBe(info.fingerprints!.key);
    expect(d.lan.pin()).toBeUndefined();

    for (const path of ["/", "/index.html", "/main.js", "/ws/client", "/remote/", "/remote/?t=abc", "/doc/frame.html", "/view/0123456789abcdef/index.html"]) {
      const res = await get(`${at(d)}${path}`);
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("this node serves no devices on its network");
    }
    expect(await opens(`wss://127.0.0.1:${d.controller!.port}/ws/client`)).toBeUndefined();
    // and nothing is handed out that would lead a device there
    expect(await ui.call("pair.start", {})).toMatchObject({ error: { data: { code: "unavailable" } } });
    expect(await ui.call("browser.invite", { name: "Laptop" })).toMatchObject({ error: { data: { code: "unavailable" } } });
    expect(await ui.call("grant.invite", { kind: "controller", name: "Phone" })).toMatchObject({ error: { data: { code: "unavailable" } } });
    // the node link is untouched by any of it
    expect(d.nodes.linkedNodes()).toEqual([secondary.identity.id]);
  }, 30_000);

  test("switched on it serves devices; switched off it closes them, said hello or not, and keeps the node's link", async () => {
    primary = await startPrimary({ nodesOnly: true });
    const d = primary.d;
    secondary = await startSecondary(primary);
    await linked(secondary);
    const ui = await desk(d);
    const on = await ui.request<LanState>("lan.enable", {});
    expect(on).toMatchObject({ enabled: true, state: "on", port: d.controller!.port });
    expect(on.addresses.every((a) => a.endsWith(`:${d.controller!.port}`))).toBe(true);
    expect((await get(`${at(d)}/`)).status).toBe(200);

    const wss = `wss://127.0.0.1:${d.controller!.port}/ws/client`;
    const offer = await ui.request<{ code: string }>("pair.start", {});
    const phone = (await opens(wss))!;
    const claimed = await phone.request<{ token: string; client: Controller }>("pair.claim", { code: offer.code, name: "Pixel" });
    await phone.request("hello", { token: claimed.token, kind: "controller", audio: { in: true, out: true } });
    const silent = (await opens(wss))!;
    // a device may turn it off, never on: that is asked on the machine itself
    expect(await phone.call("lan.enable", {})).toMatchObject({ error: { data: { code: "denied" } } });

    // the device that asked hears the answer, and is closed with the rest a moment later
    expect(await phone.request<LanState>("lan.disable", {})).toMatchObject({ enabled: false, state: "nodes" });
    expect((await get(`${at(d)}/`)).status).toBe(403);
    expect(await phone.closed).toEqual({ code: 4410, reason: "access on this network was turned off" });
    expect((await silent.closed).code).toBe(4410);
    expect(await ui.request<LanState>("lan.info", {})).toMatchObject({ enabled: false, state: "nodes" });
    expect((await get(`${at(d)}/`)).status).toBe(403);
    // the phone keeps its grant: it comes back when the switch does
    expect(d.grants.stands(claimed.client.id)).toBe(true);
    expect(d.nodes.linkedNodes()).toEqual([secondary.identity.id]);
    await ui.request("lan.enable", {});
    const back = (await opens(wss))!;
    expect("result" in (await back.hello(claimed.token, { kind: "controller", audio: { in: true, out: true } }))).toBe(true);
  }, 30_000);
});

describe("the switch", () => {
  test("with nothing that needs the listener it is down; the switch brings it up and takes it down, and is kept over the config", async () => {
    const d = await daemon(`[controller]\nenabled = false\nport = 0\n`);
    const ui = await desk(d);
    expect(d.controller).toBeUndefined();
    expect(await ui.request<LanState>("lan.info", {})).toEqual({ enabled: false, state: "off", addresses: [], keys: 0 });
    const on = await ui.request<LanState>("lan.enable", {});
    expect(on).toMatchObject({ enabled: true, state: "on" });
    expect(d.controller).toBeDefined();
    expect(on.port).toBe(d.controller!.port);
    expect(on.fingerprints?.certificate).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect((await get(`${at(d)}/`)).status).toBe(200);
    // an open key is counted
    await ui.request("browser.invite", { name: "Laptop" });
    expect((await ui.request<LanState>("lan.info", {})).keys).toBe(1);

    // the next daemon on this home still serves, whatever config.toml says
    const home = d.home;
    ui.close();
    await d.stop();
    homes = homes.filter((h) => h !== d);
    const again = Object.assign(await startDaemon({ home, port: 0, log: silentLogger, brain: false, embedder: null }), { home });
    homes.push(again);
    expect(again.config.controller.enabled).toBe(false);
    expect(again.lan.enabled).toBe(true);
    expect(again.controller).toBeDefined();
    const ui2 = await desk(again);
    const off = await ui2.request<LanState>("lan.disable", {});
    expect(off).toEqual({ enabled: false, state: "off", addresses: [], keys: 1 });
    expect(again.controller).toBeUndefined();
    // turning it off twice, or on twice, is the same as once; and on right after off waits for the port
    expect((await ui2.request<LanState>("lan.disable", {})).state).toBe("off");
    expect((await ui2.request<LanState>("lan.enable", {})).state).toBe("on");
    expect((await ui2.request<LanState>("lan.enable", {})).state).toBe("on");
  });

  test("a port that cannot be bound is said, and the next try brings the listener up", async () => {
    const holder = await daemon(`[controller]\nenabled = true\nport = 0\n`);
    const port = holder.controller!.port;
    const d = await daemon(`[controller]\nenabled = false\nport = ${port}\n`);
    const ui = await desk(d);
    const failed = await ui.request<LanState>("lan.enable", {});
    expect(failed).toMatchObject({ enabled: true, state: "failed", addresses: [] });
    expect(failed.reason).toBeDefined();
    expect(d.controller).toBeUndefined();
    expect(lanLines(failed)).toContain("the listener is not up");
    await holder.stop();
    homes = homes.filter((h) => h !== holder);
    removeHome(holder.home);
    const on = await waitFor(async () => {
      const s = await ui.request<LanState>("lan.enable", {});
      return s.state === "on" ? s : undefined;
    }, 5000, 200);
    expect(on.port).toBe(port);
  });

  test("the last refusal is told, with what would let it in", async () => {
    const d = await daemon(`[controller]\nenabled = true\nport = 0\n`);
    const ui = await desk(d);
    expect((await ui.request<LanState>("lan.info", {})).refused).toBeUndefined();
    const res = await fetch(`${at(d)}/`, { headers: { host: "evil.example" }, tls: { rejectUnauthorized: false } } as never);
    expect(res.status).toBe(421);
    const info = await ui.request<LanState>("lan.info", {});
    expect(info.refused).toMatchObject({ why: "host" });
    expect(info.refused!.detail).toContain("[controller] address");
  });

  test("each node answers for its own listener, a relayed client's too", async () => {
    primary = await startPrimary();
    secondary = await startSecondary(primary, { controller: true });
    await linked(secondary);
    const relayed = await client(secondary);
    sockets.push(relayed);
    const mine = await relayed.request<LanState>("lan.info", {});
    expect(mine).toMatchObject({ enabled: true, state: "on", port: secondary.controller!.port });
    const theirs = await (await desk(primary.d)).request<LanState>("lan.info", {});
    expect(theirs.port).toBe(primary.d.controller!.port);
    expect(theirs.port).not.toBe(mine.port);
    // asked on this machine's loopback, relayed or not: the switch moves here
    expect(await relayed.request<LanState>("lan.disable", {})).toMatchObject({ enabled: false });
    expect(secondary.lan.enabled).toBe(false);
    expect(primary.d.lan.enabled).toBe(true);
  }, 30_000);

  test("cophylad lan status, on and off", async () => {
    const d = await daemon(`[controller]\nenabled = false\nport = 0\n`);
    const run = async (...args: string[]): Promise<{ code: number; out: string }> => {
      const out: string[] = [];
      const write = process.stdout.write;
      process.stdout.write = ((s: string) => (out.push(String(s)), true)) as never;
      try {
        return { code: await runCommand("lan", [...args, "--home", d.home, "--port", String(d.api.port)]), out: out.join("") };
      } finally {
        process.stdout.write = write;
      }
    };
    expect(await run("status")).toEqual({ code: 0, out: "Access on this network is off.\n" });
    const on = await run("on");
    expect(on.code).toBe(0);
    expect(on.out).toContain("Access on this network is on: devices are served.");
    expect(on.out).toContain(`:${d.controller!.port}`);
    expect(on.out).toContain("Certificate (SHA-256): ");
    expect((await run()).out).toContain("is on");
    expect((await run("off")).out).toBe("Access on this network is off.\n");
    expect(d.controller).toBeUndefined();
  });
});
