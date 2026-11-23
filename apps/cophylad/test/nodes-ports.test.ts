// A machine's localhost opened from another of the user's machines, two real daemons linked
// on the LAN: the desktop app on the primary opens a port of the secondary's (its forwarder on
// a free port, since on this one machine the page's own server has the same one), the page and
// its WebSocket come through, the client is told what it has open, and Close ends it at both
// ends, each audited without what the page carried; the secondary's desktop app opens the
// primary's port the same way, answered by its own node, not the primary; `ports.list` is
// answered by the machine it names. The phone app's pipes go to the share it opened alone. A
// machine whose link to the primary rides the server relay is refused in words.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AuditEntry, PortForward } from "@cophyla/protocol";
import { paths } from "../src/config/load.ts";
import { FakeServer } from "./fakes/server.ts";
import { TestForwarder } from "./fakes/pipe-forwarder.ts";
import { isMethod, tempHome, TestClient, waitFor } from "./helpers.ts";
import { client, linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

let primary: Primary | undefined;
let secondary: Started | undefined;
let fake: FakeServer | undefined;
const closers: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  await stopAll(secondary, primary?.d);
  primary = undefined;
  secondary = undefined;
  await fake?.stop();
  fake = undefined;
});

/** A page's server on this machine's loopback: a page, a module, and a WebSocket that echoes. */
function devServer(hostname = "127.0.0.1") {
  const server = Bun.serve({
    hostname,
    port: 0,
    fetch(req, srv) {
      const path = new URL(req.url).pathname;
      if (path === "/ws" && srv.upgrade(req)) return undefined;
      if (path === "/m.js") return new Response("export const n = 7;", { headers: { "content-type": "text/javascript" } });
      return new Response(`<!doctype html><title>dev</title><script type="module" src="/m.js"></script>`, { headers: { "content-type": "text/html", "set-cookie": "sid=abc; Path=/" } });
    },
    websocket: { message: (ws, m) => void ws.send(`echo:${String(m)}`) },
  });
  closers.push(() => server.stop(true));
  return server;
}

function echo(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    closers.push(() => ws.close());
    ws.onopen = () => ws.send("ping");
    ws.onmessage = (ev) => resolve(String(ev.data));
    ws.onerror = () => reject(new Error("socket failed"));
  });
}

/** The words a request was refused with. */
const refusal = (p: Promise<unknown>): Promise<string | undefined> => p.then(
  () => undefined,
  (e: unknown) => (e instanceof Error ? e.message : String(e)),
);

const rows = (d: Started, action: string): AuditEntry[] => d.store.audit.list({ limit: 500 }).filter((e) => e.action === action);

describe("a machine's localhost over the links", () => {
  test("the desktop app on the primary opens the secondary's port; Close ends it at both ends", async () => {
    primary = await startPrimary();
    secondary = await startSecondary(primary, { daemon: { ports: { list: async () => [{ port: 5173, v4: false, v6: true, process: "node.exe" }] } } });
    await linked(secondary);
    await waitFor(() => primary!.d.nodes.registry.get(secondary!.identity.id)?.capabilities.ports === true);
    const dev = devServer();
    const c = await client(primary.d, "desktop");
    closers.push(() => c.close());

    // what listens there is the secondary's to say
    const listed = await c.request<{ ports: unknown[] }>("ports.list", { node: secondary.identity.id });
    expect(listed.ports).toEqual([{ port: 5173, v4: false, v6: true, process: "node.exe" }]);
    expect(rows(secondary, "ports.list")[0]?.principal).toEqual({ kind: "node", id: primary.d.identity.id });

    const opened = await c.request<{ id: string; local: number; url: string; route: string }>("port.open", { node: secondary.identity.id, port: dev.port });
    expect(opened.route).toBe("lan");
    // the page's own server has that port on this machine: another one, and the page's address says it
    expect(opened.local).not.toBe(dev.port);
    expect(opened.url).toBe(`http://localhost:${opened.local}/`);
    const state = await waitFor(() => c.notifications.find(isMethod("port.state", (p) => (p as { forwards: PortForward[] }).forwards.length === 1)));
    expect((state.params as { forwards: PortForward[] }).forwards[0]).toMatchObject({ id: opened.id, node: secondary.identity.id, port: dev.port, local: opened.local });

    const page = await fetch(`http://127.0.0.1:${opened.local}/`);
    expect(await page.text()).toContain(`src="/m.js"`);
    expect(page.headers.get("set-cookie")).toBe("sid=abc; Path=/");
    expect(await (await fetch(`http://[::1]:${opened.local}/m.js`)).text()).toBe("export const n = 7;");
    expect(await echo(`ws://localhost:${opened.local}/ws`)).toBe("echo:ping");

    // the share on the secondary, gated as the primary, unasked
    const share = rows(secondary, "port.share")[0]!;
    expect(share.principal).toEqual({ kind: "node", id: primary.d.identity.id });
    expect(share.decision).toBe("allow");
    expect(share.args).toMatchObject({ port: dev.port, viewer: primary.d.identity.id });
    expect(JSON.stringify(share)).not.toContain("echo:");

    await c.request("port.close", { id: opened.id });
    await expect(fetch(`http://127.0.0.1:${opened.local}/`)).rejects.toThrow();
    await waitFor(() => secondary!.ports.counts.shares === 0);
    expect(primary.d.ports.counts.forwards).toBe(0);
    await waitFor(() => rows(primary!.d, "port.close").some((r) => r.principal.kind === "system"));
    const closed = rows(primary.d, "port.close").find((r) => r.principal.kind === "system")!;
    expect(closed.args).toMatchObject({ id: opened.id, port: dev.port, why: "closed" });
    const counts = closed.result?.body as { connections: number; bytes: number };
    expect(counts.connections).toBeGreaterThanOrEqual(3);
    expect(counts.bytes).toBeGreaterThan(100);
    const unshared = rows(secondary, "port.unshare")[0]!;
    expect(unshared.principal).toEqual({ kind: "node", id: primary.d.identity.id });
    expect(unshared.result?.body).toMatchObject({ connections: expect.any(Number), bytes: expect.any(Number) });
  });

  test("the secondary's desktop app opens the primary's port, answered by its own node", async () => {
    primary = await startPrimary();
    secondary = await startSecondary(primary);
    await linked(secondary);
    const dev = devServer("::1");
    const c = await TestClient.connect(secondary.api.url);
    closers.push(() => c.close());
    await c.hello(secondary.token, { name: "laptop app" });
    await waitFor(() => secondary!.nodes.registry.get(primary!.d.identity.id)?.capabilities.ports === true);
    const opened = await c.request<{ id: string; local: number; url: string }>("port.open", { node: primary.d.identity.id, port: dev.port });
    // the forwarder is the secondary's, where the app is
    expect(secondary.ports.counts.forwards).toBe(1);
    expect(primary.d.ports.counts).toEqual({ shares: 1, forwards: 0 });
    expect(await echo(`ws://127.0.0.1:${opened.local}/ws`)).toBe("echo:ping");
    // the client goes: what it opened closes, and the primary stops sharing it
    c.close();
    await waitFor(() => secondary!.ports.counts.forwards === 0 && primary!.d.ports.counts.shares === 0);
  });

  test("the phone app's pipes go to the share it opened, and no other client's", async () => {
    primary = await startPrimary();
    secondary = await startSecondary(primary);
    await linked(secondary);
    await waitFor(() => primary!.d.nodes.registry.get(secondary!.identity.id)?.capabilities.ports === true);
    const dev = devServer();
    const phone = async (name: string) => {
      const { token } = primary!.d.grants.createController(name);
      const c = await TestClient.connect(`wss://127.0.0.1:${primary!.d.controller!.port}/ws/client`, { insecure: true });
      closers.push(() => c.close());
      const r = await c.call("hello", { token, kind: "controller", audio: { in: false, out: false }, forward: true });
      if ("error" in r) throw new Error(r.error.message);
      return c;
    };
    const p1 = await phone("Pixel");
    const p2 = await phone("Other");
    const opened = await p1.request<{ id: string; share: string; local?: number }>("port.open", { node: secondary.identity.id, port: dev.port });
    expect(opened.share).toBe(opened.id);
    expect(opened.local).toBeUndefined();
    expect(await refusal(p2.request("remote.pipe.open", { node: secondary.identity.id, share: opened.share }))).toBe("no such port is open for this client");
    const link = {
      request: (m: string, p: unknown) => p1.request(m, p),
      signal: (m: string, p: unknown) => p1.signal(m, p),
      listen: (h: (m: string, p: unknown) => void) => {
        const prev = p1.onNotification;
        p1.onNotification = (n) => {
          prev?.(n);
          h(n.method, n.params);
        };
      },
    };
    const f = new TestForwarder(link, secondary.identity.id, opened.share);
    closers.push(() => f.stop());
    expect(await (await fetch(`http://127.0.0.1:${f.port}/m.js`)).text()).toBe("export const n = 7;");
    expect(f.failures).toEqual([]);
    await p1.request("port.close", { id: opened.id });
    await waitFor(() => secondary!.ports.counts.shares === 0);
  });

  test("a machine linked through the relay is refused in words", async () => {
    fake = new FakeServer();
    const home = tempHome();
    const p = paths(home);
    mkdirSync(p.data, { recursive: true });
    writeFileSync(p.accountToken, fake.mintToken() + "\n", { mode: 0o600 });
    const toml = `[cloud]\nenabled = true\nurl = "${fake.url}"\nallow_insecure = true\nreconnect_ms = 20\nreconnect_max_ms = 100\nhello_timeout_ms = 3000\n\n`;
    primary = await startPrimary({ noLan: true, heartbeatMs: 1000, home, toml, daemon: { cloud: { keys: [fake.publicKey] } } });
    await waitFor(() => fake!.primaryOf()?.primary === primary!.d.identity.id, 5000);
    secondary = await startSecondary(primary, { noEndpoint: true, relayOnly: true, heartbeatMs: 1000, node: 'name = "Desk"\n' });
    await linked(secondary, 10_000);
    await waitFor(() => primary!.d.nodes.registry.get(secondary!.identity.id)?.via === "relay");
    const c = await client(primary.d, "desktop");
    closers.push(() => c.close());
    expect(await refusal(c.request("port.open", { node: secondary.identity.id, port: 3000 }))).toBe("Opening Desk's localhost needs a direct connection; this computer reaches Desk only through the relay right now");
    expect(secondary.ports.counts.shares).toBe(0);
  });
});
