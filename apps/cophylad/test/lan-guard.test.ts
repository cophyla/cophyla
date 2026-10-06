// The LAN listener's guard end to end, on a daemon's real listener over TLS: a peer off the
// node's networks gets nothing, a request under another name is misdirected, a foreign page's
// socket is refused while the listener's own page's is a browser's, the app's files carry
// their headers, and the loopback listener is left as it was. And the limiter on that
// listener: an address's wrong tries block its pairing for a while and never its hello, and
// it holds only so many sockets that have not said who they are.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controllerCsp } from "@cophyla/protocol";
import type { Controller } from "@cophyla/protocol";
import type { Daemon, DaemonOptions } from "../src/daemon.ts";
import { stopDaemon, testDaemon, TestClient, waitFor } from "./helpers.ts";

let d: (Daemon & { home: string }) | undefined;
const sockets: TestClient[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  if (d) await stopDaemon(d);
  d = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A built app of two files, so the listener has a page and a script to serve. */
function app(): string {
  const dir = mkdtempSync(join(tmpdir(), "cophyla-app-"));
  dirs.push(dir);
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>controller</title>");
  writeFileSync(join(dir, "main.js"), "export const ok = 1;\n");
  return dir;
}

async function start(extra = "", opts: Partial<DaemonOptions> = {}): Promise<{ origin: string; wss: string; host: string }> {
  d = await testDaemon(`[controller]\nenabled = true\nport = 0\napp_dir = ${JSON.stringify(app())}\n${extra}`, opts);
  const host = `127.0.0.1:${d.controller!.port}`;
  return { origin: `https://${host}`, wss: `wss://${host}/ws/client`, host };
}

const get = (url: string, headers: Record<string, string> = {}): Promise<Response> => fetch(url, { headers, tls: { rejectUnauthorized: false } } as never);

/** Whether a socket to `url` opens with these headers. */
async function opens(url: string, headers?: Record<string, string>): Promise<TestClient | undefined> {
  try {
    const c = await TestClient.connect(url, { insecure: true, ...(headers ? { headers } : {}) });
    sockets.push(c);
    return c;
  } catch {
    return undefined;
  }
}

async function ui(): Promise<TestClient> {
  const c = await TestClient.connect(d!.api.url);
  sockets.push(c);
  await c.hello(d!.token, { name: "desktop" });
  return c;
}

describe("the LAN listener's guard", () => {
  test("the page goes out with its policy and its opener rule, every file says its type is its type, and nothing pins the host to TLS", async () => {
    const { origin } = await start();
    const page = await get(`${origin}/`);
    expect(page.status).toBe(200);
    // the policy is a header: nothing may frame the page, which a `<meta>` cannot say
    expect(page.headers.get("content-security-policy")).toBe(controllerCsp());
    expect(controllerCsp()).toContain("frame-ancestors 'none'");
    expect(controllerCsp()).toContain("connect-src 'self'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(page.headers.get("strict-transport-security")).toBeNull();
    const script = await get(`${origin}/main.js`);
    expect(script.headers.get("content-type")).toBe("text/javascript");
    expect(script.headers.get("x-content-type-options")).toBe("nosniff");
    expect(script.headers.get("cross-origin-opener-policy")).toBeNull();
    expect(script.headers.get("content-security-policy")).toBeNull();
  });

  test("a request under a name that is not this machine's is misdirected: the page, a socket and a node link alike", async () => {
    const { origin, wss, host } = await start("[nodes]\naccept = true\ndiscovery = false\n");
    for (const path of ["/", "/main.js", "/ws/client", "/ws/node", "/remote/"]) {
      const res = await get(`${origin}${path}`, { host: "evil.example" });
      expect(res.status).toBe(421);
      expect(await res.text()).not.toContain("controller");
    }
    expect(await opens(wss, { host: "evil.example:4818" })).toBeUndefined();
    // the machine's own names pass, whatever the port says: a port mapping still works
    expect((await get(`${origin}/`, { host: "localhost:9443" })).status).toBe(200);
    expect((await get(`${origin}/`, { host })).status).toBe(200);
    expect(d!.controller).toBeDefined();
  });

  test("a socket from the listener's own page is a browser's; a foreign page's is refused; an app's, with no Origin, opens as before", async () => {
    const { origin, wss, host } = await start();
    expect(await opens(wss, { origin: "https://evil.example" })).toBeUndefined();
    expect(await opens(wss, { origin: `http://${host}` })).toBeUndefined();
    expect(await opens(wss, { origin: "null" })).toBeUndefined();
    const desk = await ui();

    // an app's socket: no Origin, and it may say it forwards
    const app = (await opens(wss))!;
    const first = await desk.request<{ code: string }>("pair.start", {});
    const claimed = await app.request<{ token: string; client: Controller }>("pair.claim", { code: first.code, name: "Pixel" });
    expect("result" in (await app.hello(claimed.token, { kind: "controller", forward: true, audio: { in: true, out: true } }))).toBe(true);

    // the listener's own page: a browser, which has no forwarder
    const page = (await opens(wss, { origin }))!;
    expect(page).toBeDefined();
    const second = await desk.request<{ code: string }>("pair.start", {});
    const browser = await page.request<{ token: string }>("pair.claim", { code: second.code, name: "Firefox" });
    expect(await page.hello(browser.token, { kind: "controller", forward: true, audio: { in: false, out: false } })).toMatchObject({ error: { data: { code: "invalid" } } });
    expect((await page.closed).code).toBe(4401);
    const again = (await opens(wss, { origin }))!;
    expect("result" in (await again.hello(browser.token, { kind: "controller", audio: { in: false, out: false } }))).toBe(true);
    expect(await again.call("remote.open", { node: d!.identity.id, forward: true })).toMatchObject({ error: { data: { code: "invalid" } } });
  });

  test("a peer off the node's networks gets nothing, and a node link is held to it too", async () => {
    const { origin, wss } = await start("[nodes]\naccept = true\ndiscovery = false\n", { lan: { peer: () => "203.0.113.5" } });
    for (const path of ["/", "/main.js", "/ws/client", "/ws/node", "/remote/", "/doc/frame.html"]) {
      const res = await get(`${origin}${path}`);
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("not served on this network");
    }
    expect(await opens(wss)).toBeUndefined();
    expect(await opens(wss.replace("/ws/client", "/ws/node"))).toBeUndefined();
  });

  test("a range in [controller] networks is served beside the local ones, and `any` serves everyone", async () => {
    const ranged = await start('networks = ["local", "203.0.113.0/24"]\n', { lan: { peer: () => "::ffff:203.0.113.5" } });
    expect((await get(`${ranged.origin}/`)).status).toBe(200);
    expect(await opens(ranged.wss)).toBeDefined();
    for (const s of sockets.splice(0)) s.close();
    await stopDaemon(d!);
    const any = await start('networks = ["any"]\n', { lan: { peer: () => "8.8.8.8" } });
    expect((await get(`${any.origin}/`)).status).toBe(200);
  });

  test("the loopback listener is not the guard's or the limiter's: it answers as it did", async () => {
    await start();
    const c = await TestClient.connect(d!.api.url, { headers: { origin: "http://tauri.localhost" } });
    sockets.push(c);
    expect("result" in (await c.hello(d!.token, { name: "desktop" }))).toBe(true);
    const res = await fetch(`http://127.0.0.1:${d!.api.port}/nothing`, { headers: { host: "evil.example" } });
    expect(res.status).toBe(404);
    // wrong tokens from this machine are never counted
    for (let i = 0; i < 12; i++) {
      const bad = await TestClient.connect(d!.api.url);
      sockets.push(bad);
      expect(await bad.hello("not the token")).toMatchObject({ error: { data: { code: "denied" } } });
    }
    expect("result" in (await c.call("pair.start", {}))).toBe(true);
  });
});

describe("the limiter on the LAN listener", () => {
  const clock = { now: 1_000_000 };
  const from = (address: string) => ({ lan: { peer: () => address, limiter: { now: () => clock.now } } });
  const NETWORKS = 'networks = ["any"]\n';

  /** A wrong code on a fresh socket; three close one. */
  async function wrongCode(wss: string): Promise<unknown> {
    const s = (await opens(wss))!;
    const r = await s.call("pair.claim", { code: "000000", name: "guess" });
    s.close();
    return r;
  }

  test("ten wrong tries block an address's pairing for a minute; a paired device behind it still says hello", async () => {
    const { wss } = await start(NETWORKS, from("198.51.100.7"));
    const desk = await ui();
    // a device paired before the guessing began
    const first = await desk.request<{ code: string }>("pair.start", {});
    const paired = (await opens(wss))!;
    const claimed = await paired.request<{ token: string }>("pair.claim", { code: first.code, name: "Pixel" });
    paired.close();

    for (let i = 0; i < 7; i++) expect(await wrongCode(wss)).toMatchObject({ error: { data: { code: "denied" } } });
    // a wrong invite and wrong tokens count with the codes
    const guess = (await opens(wss))!;
    expect(await guess.call("invite.redeem", { grant: "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC5", secret: "0".repeat(64), name: "guess" })).toMatchObject({ error: { data: { code: "denied" } } });
    for (let i = 0; i < 2; i++) {
      const s = (await opens(wss))!;
      expect(await s.hello("not a token", { kind: "controller" })).toMatchObject({ error: { data: { code: "denied" } } });
    }

    // blocked: the right code is refused too, and says for how long
    const offer = await desk.request<{ code: string }>("pair.start", {});
    const late = (await opens(wss))!;
    const refused = await late.call("pair.claim", { code: offer.code, name: "Late" });
    expect(refused).toMatchObject({ error: { data: { code: "unavailable", retryable: true, data: { retryAfterMs: 60_000 } } } });
    expect((refused as { error: { message: string } }).error.message).toContain("60 s");
    expect(await late.call("invite.redeem", { grant: "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC5", secret: "0".repeat(64), name: "guess" })).toMatchObject({ error: { data: { code: "unavailable" } } });
    // the code was not spent on the refusal, and the device paired earlier is not locked out
    const back = (await opens(wss))!;
    expect("result" in (await back.hello(claimed.token, { kind: "controller", audio: { in: true, out: true } }))).toBe(true);

    clock.now += 60_001;
    expect("result" in (await late.call("pair.claim", { code: offer.code, name: "Late" }))).toBe(true);
  });

  test("another address is not held to it", async () => {
    let address = "198.51.100.7";
    const { wss } = await start(NETWORKS, { lan: { peer: () => address, limiter: { now: () => clock.now } } });
    const desk = await ui();
    for (let i = 0; i < 10; i++) await wrongCode(wss);
    expect(await wrongCode(wss)).toMatchObject({ error: { data: { code: "unavailable" } } });
    address = "198.51.100.8";
    const offer = await desk.request<{ code: string }>("pair.start", {});
    const other = (await opens(wss))!;
    expect("result" in (await other.call("pair.claim", { code: offer.code, name: "Other" }))).toBe(true);
  });

  test("an address holds sixteen sockets that have not said hello, and one that says it makes room", async () => {
    const { wss } = await start(NETWORKS, from("198.51.100.9"));
    const desk = await ui();
    const offer = await desk.request<{ code: string }>("pair.start", {});
    const held: TestClient[] = [];
    for (let i = 0; i < 16; i++) held.push((await opens(wss))!);
    expect(held.every(Boolean)).toBe(true);
    expect(await opens(wss)).toBeUndefined();
    const claimed = await held[0]!.request<{ token: string }>("pair.claim", { code: offer.code, name: "Pixel" });
    expect(await opens(wss)).toBeUndefined();
    expect("result" in (await held[0]!.hello(claimed.token, { kind: "controller", audio: { in: true, out: true } }))).toBe(true);
    const next = await opens(wss);
    expect(next).toBeDefined();
    // one that closes makes room as well
    expect(await opens(wss)).toBeUndefined();
    held[1]!.close();
    await waitFor(async () => (await opens(wss)) !== undefined);
  });
});
