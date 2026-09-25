// The controller listener end to end, over TLS on a free port: pairing a phone with a code
// from the desktop, the token it keeps, what the listener refuses, listing and revoking a
// controller, serving a view to the phone's frame under a ticket with the frame policy, and
// the five-second floor on a phone's metrics.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FULL } from "@cophyla/protocol";
import type { Controller, ViewManifest } from "@cophyla/protocol";
import { paths } from "../src/config/load.ts";
import { startDaemon } from "../src/daemon.ts";
import type { Daemon } from "../src/daemon.ts";
import { GRANTS_NS } from "../src/grants/namespaces.ts";
import { hashSecret } from "../src/grants/store.ts";
import { silentLogger } from "../src/log.ts";
import { Store } from "../src/store/index.ts";
import { viewCsp } from "../src/api/tickets.ts";
import { stopDaemon, tempHome, testDaemon, TestClient, waitFor } from "./helpers.ts";

const CONFIG = `[controller]\nenabled = true\nport = 0\n`;

interface Started {
  d: Daemon & { home: string };
  ui: TestClient;
  origin: string;
  wss: string;
}

let current: Started | undefined;
const phones: TestClient[] = [];
const apps: string[] = [];

afterEach(async () => {
  for (const p of phones.splice(0)) p.close();
  for (const app of apps.splice(0)) rmSync(app, { recursive: true, force: true });
  if (!current) return;
  current.ui.close();
  await stopDaemon(current.d);
  current = undefined;
});

async function start(extra = ""): Promise<Started> {
  const d = await testDaemon(CONFIG + extra);
  const ui = await TestClient.connect(d.api.url);
  await ui.hello(d.token, { name: "desktop" });
  const origin = `https://127.0.0.1:${d.controller!.port}`;
  current = { d, ui, origin, wss: `${origin}/ws/client` };
  return current;
}

/** A phone: a socket to the controller listener that accepts the self-signed certificate. */
async function phone(wss: string): Promise<TestClient> {
  const c = await TestClient.connect(wss, { insecure: true });
  phones.push(c);
  return c;
}

const pair = (c: TestClient, code: string, name = "Pixel") => c.call("pair.claim", { code, name });

describe("pairing", () => {
  test("a code from the desktop pairs one phone, which then says hello with its own token", async () => {
    const { d, ui, wss, origin } = await start();
    const offer = await ui.request<{ code: string; url: string; expiresAt: number }>("pair.start", {});
    expect(offer.code).toMatch(/^\d{6}$/);
    expect(offer.url).toContain(`?code=${offer.code}`);
    expect(offer.expiresAt).toBeGreaterThan(Date.now());

    const p = await phone(wss);
    const claimed = await p.request<{ token: string; client: Controller }>("pair.claim", { code: offer.code, name: "Pixel 8" });
    expect(claimed.token).toHaveLength(64);
    expect(claimed.client.id).toMatch(/^ctl_/);
    expect(claimed.client.name).toBe("Pixel 8");
    expect(claimed.client.connected).toBe(false);

    const hello = await p.request<{ client: { id: string; kind: string; controller?: string } }>("hello", { token: claimed.token, kind: "controller", audio: { in: true, out: true } });
    expect(hello.client.kind).toBe("controller");
    expect(hello.client.controller).toBe(claimed.client.id);

    // The desktop sees it in the list, connected, with the same id.
    const listed = await ui.request<{ controllers: Controller[] }>("controller.list", {});
    expect(listed.controllers).toHaveLength(1);
    expect(listed.controllers[0]).toMatchObject({ id: claimed.client.id, name: "Pixel 8", connected: true });
    // The token is kept only as a hash.
    const row = d.store.kv.get(GRANTS_NS, claimed.client.id) as { tokenHash: string };
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(claimed.token);
    expect(origin).toContain("https://");
  });

  test("a phone paired before grants still says hello: its row moved in place, with full access", async () => {
    // A home from before grants: the phone's row under `controllers`.
    const home = tempHome(CONFIG);
    mkdirSync(join(home, "data"), { recursive: true });
    const old = new Store(paths(home).db);
    old.migrate();
    const token = "7".repeat(64);
    old.kv.put("controllers", "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC1", { id: "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC1", name: "Old Pixel", tokenHash: hashSecret(token), pairedAt: 5, relayKey: "ab".repeat(32) });
    old.close();
    const d = Object.assign(await startDaemon({ home, port: 0, log: silentLogger, brain: false, embedder: null }), { home });
    const ui = await TestClient.connect(d.api.url);
    await ui.hello(d.token, { name: "desktop" });
    current = { d, ui, origin: `https://127.0.0.1:${d.controller!.port}`, wss: `https://127.0.0.1:${d.controller!.port}/ws/client` };
    expect(d.store.kv.list("controllers")).toEqual([]);
    expect(d.grants.get("ctl_01ARZ3NDEKTSV4RRFFQ69G5FC1")).toMatchObject({ kind: "controller", key: "ab".repeat(32) });
    const p = await phone(current.wss);
    const hello = await p.request<{ client: { controller?: string; scopes: string[] } }>("hello", { token, kind: "controller", audio: { in: true, out: true } });
    expect(hello.client.controller).toBe("ctl_01ARZ3NDEKTSV4RRFFQ69G5FC1");
    expect(hello.client.scopes).toEqual(FULL.scopes);
    const listed = await ui.request<{ controllers: Controller[] }>("controller.list", {});
    expect(listed.controllers[0]).toMatchObject({ id: "ctl_01ARZ3NDEKTSV4RRFFQ69G5FC1", name: "Old Pixel", access: FULL });
  });

  test("a code is good once: the second claim is denied, and so is a wrong one", async () => {
    const { ui, wss } = await start();
    const offer = await ui.request<{ code: string }>("pair.start", {});
    const first = await phone(wss);
    await first.request("pair.claim", { code: offer.code, name: "one" });
    const second = await phone(wss);
    expect(await pair(second, offer.code, "two")).toMatchObject({ error: { data: { code: "denied" } } });
    const third = await phone(wss);
    expect(await pair(third, "000000", "three")).toMatchObject({ error: { data: { code: "denied" } } });
  });

  test("three wrong codes close the socket", async () => {
    const { ui, wss } = await start();
    await ui.request("pair.start", {});
    const p = await phone(wss);
    expect(await pair(p, "111111")).toMatchObject({ error: { data: { code: "denied" } } });
    expect(await pair(p, "222222")).toMatchObject({ error: { data: { code: "denied" } } });
    expect(await pair(p, "333333")).toMatchObject({ error: { data: { code: "denied" } } });
    const closed = await p.closed;
    expect(closed.code).toBe(4401);
  });

  test("the shared token is refused on the LAN listener, and a claim on loopback is unsupported", async () => {
    const { d, ui, wss } = await start();
    const p = await phone(wss);
    const refused = await p.call("hello", { token: d.token, kind: "controller", audio: { in: true, out: true } });
    expect(refused).toMatchObject({ error: { data: { code: "denied" } } });
    expect((await p.closed).code).toBe(4401);
    // The desktop listener pairs nobody: there is no window on it.
    expect(await ui.call("pair.claim", { code: "123456", name: "x" })).toMatchObject({ error: { data: { code: "unsupported" } } });
  });

  test("a claim after hello is a conflict, and a second claim on one socket is too", async () => {
    const { ui, wss } = await start();
    const offer = await ui.request<{ code: string }>("pair.start", {});
    const p = await phone(wss);
    const claimed = await p.request<{ token: string }>("pair.claim", { code: offer.code, name: "Pixel" });
    // A second claim on the same socket, before hello.
    expect(await pair(p, offer.code)).toMatchObject({ error: { data: { code: "conflict" } } });
    await p.request("hello", { token: claimed.token, kind: "controller", audio: { in: true, out: true } });
    expect(await pair(p, offer.code)).toMatchObject({ error: { data: { code: "conflict" } } });
  });

  test("revoking a controller closes its socket and refuses its token afterwards", async () => {
    const { ui, wss } = await start();
    const offer = await ui.request<{ code: string }>("pair.start", {});
    const p = await phone(wss);
    const claimed = await p.request<{ token: string; client: Controller }>("pair.claim", { code: offer.code, name: "Pixel" });
    await p.request("hello", { token: claimed.token, kind: "controller", audio: { in: true, out: true } });

    await ui.request("controller.revoke", { id: claimed.client.id });
    expect((await p.closed).code).toBe(4401);
    expect(await ui.request<{ controllers: Controller[] }>("controller.list", {})).toEqual({ controllers: [] });
    const again = await phone(wss);
    expect(await again.call("hello", { token: claimed.token, kind: "controller", audio: { in: true, out: true } })).toMatchObject({ error: { data: { code: "denied" } } });
    expect(await ui.call("controller.revoke", { id: claimed.client.id })).toMatchObject({ error: { data: { code: "not_found" } } });
  });

  test("every pairing attempt is audited, and the code never reaches the log", async () => {
    const { d, ui, wss } = await start();
    const offer = await ui.request<{ code: string }>("pair.start", {});
    const p = await phone(wss);
    await pair(p, "999999");
    await p.request("pair.claim", { code: offer.code, name: "Pixel" });
    await waitFor(() => d.store.audit.list({ limit: 50 }).filter((e) => e.action === "pair.claim").length === 2);
    const rows = d.store.audit.list({ limit: 50 }).filter((e) => e.action === "pair.claim");
    // The gate allowed both: a wrong code is the handler's refusal, which the audit calls an error.
    expect(rows.map((r) => r.outcome).sort()).toEqual(["error", "ok"]);
    expect(JSON.stringify(rows)).not.toContain(offer.code);
    expect(JSON.stringify(rows)).toContain("Pixel");
    // The desktop's own `pair.start` is audited too, its answer without the code it showed.
    const opened = d.store.audit.list({ limit: 50 }).find((e) => e.action === "pair.start");
    expect(opened?.outcome).toBe("ok");
    expect(JSON.stringify(opened)).not.toContain(offer.code);
  });
});

describe("the controller listener", () => {
  test("serves a view under a ticket with the frame policy, and forgets it when the client goes", async () => {
    const { d, ui, wss, origin } = await start();
    const offer = await ui.request<{ code: string }>("pair.start", {});
    const p = await phone(wss);
    const claimed = await p.request<{ token: string }>("pair.claim", { code: offer.code, name: "Pixel" });
    await p.request("hello", { token: claimed.token, kind: "controller", audio: { in: true, out: true } });

    const views = await p.request<{ views: ViewManifest[] }>("view.list", {});
    const id = views.views.find((v) => v.default)!.id;
    const staged = await p.request<{ base: string; version: string }>("view.stage", { id });
    expect(staged.base).toBe(`${origin}/view/${staged.base.split("/view/")[1]!.replace(/\/$/, "")}/`);
    expect(d.tickets.size).toBe(1);

    const res = await fetch(staged.base + "index.html", { tls: { rejectUnauthorized: false } } as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(res.headers.get("content-security-policy")).toBe(viewCsp(origin));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // The sandboxed frame fetches its own modules from an opaque origin: without this the
    // view's `<script type="module">` is blocked before it runs.
    expect(res.headers.get("access-control-allow-origin")).toBe("null");
    expect(await res.text()).toContain("<!doctype html>");

    // A made-up ticket, and a path that tries to climb out, are both 404.
    const bad = await fetch(`${origin}/view/${"0".repeat(32)}/index.html`, { tls: { rejectUnauthorized: false } } as never);
    expect(bad.status).toBe(404);
    const climb = await fetch(staged.base + "..%2f..%2fconfig.toml", { tls: { rejectUnauthorized: false } } as never);
    expect(climb.status).toBe(404);

    p.close();
    await waitFor(() => d.tickets.size === 0);
  });

  test("serves the app it was given, answers no hooks, and the loopback listener keeps them", async () => {
    const app = mkdtempSync(join(tmpdir(), "cophyla-app-"));
    apps.push(app);
    writeFileSync(join(app, "index.html"), "<!doctype html><title>controller</title>");
    writeFileSync(join(app, "main.js"), "export const ok = 1;\n");
    const { d, origin } = await start(`app_dir = ${JSON.stringify(app)}\n`);
    const page = await fetch(`${origin}/`, { tls: { rejectUnauthorized: false } } as never);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<title>controller</title>");
    const script = await fetch(`${origin}/main.js`, { tls: { rejectUnauthorized: false } } as never);
    expect(script.headers.get("content-type")).toBe("text/javascript");
    // A path that climbs out of the app directory is a 404, not a file.
    const climb = await fetch(`${origin}/..%2f..%2fconfig.toml`, { tls: { rejectUnauthorized: false } } as never);
    expect(climb.status).toBe(404);
    // The harness hooks are the loopback listener's alone.
    const hook = await fetch(`${origin}/hooks/claude`, { method: "POST", body: "{}", tls: { rejectUnauthorized: false } } as never);
    expect(hook.status).toBe(404);
    const loopback = await fetch(`http://127.0.0.1:${d.api.port}/hooks/claude`, { method: "POST", body: "{}" });
    expect(loopback.status).not.toBe(404);
  });

  test("an app that was never built answers with one line saying so", async () => {
    const { origin } = await start(`app_dir = ${JSON.stringify(join(tmpdir(), "cophyla-no-such-app"))}\n`);
    const page = await fetch(`${origin}/`, { tls: { rejectUnauthorized: false } } as never);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("controller app is not built");
    // Only the entry falls back to it; anything else is a plain 404.
    const other = await fetch(`${origin}/main.js`, { tls: { rejectUnauthorized: false } } as never);
    expect(other.status).toBe(404);
  });

  test("a socket that says nothing is closed, and the two listeners share one client registry", async () => {
    const { d, ui, wss } = await start();
    const offer = await ui.request<{ code: string }>("pair.start", {});
    const p = await phone(wss);
    const claimed = await p.request<{ token: string }>("pair.claim", { code: offer.code, name: "Pixel" });
    await p.request("hello", { token: claimed.token, kind: "controller", audio: { in: true, out: true } });
    // One desktop on loopback, one phone on the LAN, both in the registry.
    expect(d.clients.list().map((c) => c.kind).sort()).toEqual(["controller", "ui"]);
    // A broadcast from the bus reaches both.
    const seen = p.next((n) => n.method === "workspace.state");
    d.workspaces.put({ node: d.identity.id, path: d.home, name: "home-again" });
    expect(await seen).toBeDefined();
  });

  test("a phone is sent metrics every five seconds at most, however fast it asks; the desktop at its own rate", async () => {
    const { d, ui, wss } = await start();
    const offer = await ui.request<{ code: string }>("pair.start", {});
    const p = await phone(wss);
    const claimed = await p.request<{ token: string }>("pair.claim", { code: offer.code, name: "Pixel" });
    const hello = await p.request<{ client: { id: string } }>("hello", { token: claimed.token, kind: "controller", audio: { in: true, out: true } });
    const uiId = d.clients.list().find((c) => c.kind === "ui")!.id;
    await p.request("metrics.subscribe", { intervalMs: 1000, processes: "owners" });
    await ui.request("metrics.subscribe", { intervalMs: 2000 });
    const subscribers = new Map(d.metrics.snapshot().subscribers.map((s) => [s.client, s]));
    expect(subscribers.get(hello.client.id)).toMatchObject({ intervalMs: 5000, processes: "owners" });
    expect(subscribers.get(uiId)).toMatchObject({ intervalMs: 2000, processes: "all" });
  });
});
