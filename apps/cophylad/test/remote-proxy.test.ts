// The web viewer behind the controller listener, with the fake moonlight-web as the sidecar
// and the fake host accepting its PIN: a controller's `remote.open` starts the sidecar,
// registers and pairs this node's host with it (the pairing gated and audited here as the
// phone) and answers a ticket URL on the controller's origin; the ticket buys one cookie and
// is dead after; the cookie is the only door, the login header is the proxy's and never the
// browser's, HTML may be framed by this origin only, the stream socket is bridged both ways;
// the session is a `web` viewer in `remote.state`, `remote.revoke` ends it and its socket,
// and the phone going away ends it too. Nothing under `/remote` answers on loopback. The
// phone app, which forwards the page through its own loopback, gets the path alone, the
// WebSocket transport whatever the node's default, and a cookie without `Secure` when the
// page's `Host` is loopback; `remote.close` ends its stream, and nobody else's.

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RemoteState } from "@cophyla/protocol";
import type { Daemon } from "../src/daemon.ts";
import { silentLogger } from "../src/log.ts";
import { HostApi } from "../src/remote/host.ts";
import { loopbackHost, RemoteProxy, RemoteTickets } from "../src/remote/proxy.ts";
import { startFakeApollo } from "./fakes/apollo.ts";
import type { FakeApollo } from "./fakes/apollo.ts";
import { FAKE_WEB, remoteSeams } from "./fakes/remote.ts";
import { isMethod, removeHome, stopDaemon, tempHome, TestClient, waitFor } from "./helpers.ts";

interface Started {
  d: Daemon & { home: string };
  fake: FakeApollo;
  scratch: string;
}

let current: Started | undefined;
const clients: TestClient[] = [];
const sockets: WebSocket[] = [];
const insecure = { tls: { rejectUnauthorized: false } } as const;

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const c of clients.splice(0)) c.close();
  if (!current) return;
  await stopDaemon(current.d);
  await current.fake.stop();
  removeHome(current.scratch);
  current = undefined;
});

async function start(remoteExtra = ""): Promise<Started> {
  const scratch = tempHome();
  const fake = await startFakeApollo();
  fake.acceptAny = true;
  const seams = remoteSeams();
  writeFileSync(
    join(scratch, "config.toml"),
    `[nodes]\ndiscovery = false\n\n[sessions]\ndiscover = false\ninstall_hooks = false\n\n[update]\nenabled = false\n\n[node]\nname = "study"\n\n[controller]\nenabled = true\nhost = "127.0.0.1"\nport = 0\n\n[remote]\nenabled = true\nhost_command = "C:\\\\fake\\\\Apollo\\\\sunshine.exe"\npoll_ms = 100\n${remoteExtra}`,
  );
  const { startDaemon } = await import("../src/daemon.ts");
  const d = Object.assign(
    await startDaemon({
      home: scratch,
      port: 0,
      log: silentLogger,
      brain: false,
      embedder: null,
      remote: {
        os: "windows",
        exec: seams.exec,
        hostApi: (kind) => new HostApi({ kind, port: fake.port, log: silentLogger, timeoutMs: 3000 }),
        moonlight: { spawn: seams.spawn, command: seams.moonlight },
        screenshot: seams.screenshot,
        web: { command: [process.execPath, FAKE_WEB] },
      },
    }),
    { home: scratch },
  );
  await d.remote.ready();
  current = { d, fake, scratch };
  return current;
}

/** A paired phone on the controller listener, said hello. */
async function phone(d: Daemon, name = "Pixel"): Promise<TestClient> {
  const { token } = d.grants.createController(name);
  const c = await TestClient.connect(`wss://127.0.0.1:${d.controller!.port}/ws/client`, { insecure: true });
  clients.push(c);
  const r = await c.call("hello", { token, kind: "controller", audio: { in: false, out: false } });
  if ("error" in r) throw new Error(r.error.message);
  return c;
}

const get = (url: string, headers: Record<string, string> = {}) => fetch(url, { ...insecure, redirect: "manual", headers } as RequestInit);

function socket(url: string, cookie: string): Promise<{ ws: WebSocket; frames: (string | Uint8Array)[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { cookie }, ...insecure } as never);
    ws.binaryType = "arraybuffer";
    sockets.push(ws);
    const frames: (string | Uint8Array)[] = [];
    ws.addEventListener("message", (ev) => frames.push(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data as ArrayBuffer)));
    ws.addEventListener("open", () => resolve({ ws, frames }));
    ws.addEventListener("error", () => reject(new Error("socket failed")));
  });
}

describe("remote web viewer", () => {
  test("a controller opens this desktop: a ticket, one cookie, the proxied page and API, the bridged socket, a web viewer, revoked", async () => {
    const { d, fake } = await start();
    const c = await phone(d);
    const origin = `https://127.0.0.1:${d.controller!.port}`;
    const { url } = await c.request<{ url: string }>("remote.open", { node: d.identity.id });
    expect(url).toMatch(new RegExp(`^${origin.replace(/[.]/g, "\\.")}/remote/\\?t=[0-9a-f]{32}$`));
    // the sidecar paired with this node's host under this node's name, gated here as the phone
    expect(fake.clients.map((x) => x.name)).toEqual(["study web"]);
    const pair = d.store.audit.list({ limit: 100 }).find((e) => e.action === "remote.pair")!;
    expect(pair.principal).toEqual({ kind: "user", client: expect.any(String) });
    expect(pair.target).toBe("study web");
    expect((pair.args as { pin: string }).pin).toBe("[redacted]");
    // the open's row, which every client with the audit stream hears, keeps no live ticket
    const open = d.store.audit.list({ limit: 100 }).find((e) => e.action === "remote.open")!;
    expect((open.result!.body as { url: string }).url).toBe(`${origin}/remote/?t=[redacted]`);
    expect(open.result!.summary).not.toContain(url.split("t=")[1]!);

    // the ticket buys one cookie and a page that seeds the transport and moves on to the stream
    const claim = await get(url);
    expect(claim.status).toBe(200);
    const setCookie = claim.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^cophyla_remote=[0-9a-f]{32}; Path=\/remote; Secure; HttpOnly; SameSite=Strict$/);
    expect(claim.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    const page = await claim.text();
    expect(page).toContain(`"websocket"`);
    expect(page).toContain(`/remote/stream.html?hostId=`);
    expect(page).toContain(`appId=881448767`);
    expect((await get(url)).status).toBe(403);
    expect((await get(`${origin}/remote/?t=${"0".repeat(32)}`)).status).toBe(403);
    const cookie = setCookie.split(";")[0]!;

    // the cookie is the door; the proxy's header is the login, whatever the browser sends
    expect((await get(`${origin}/remote/`)).status).toBe(403);
    const home = await get(`${origin}/remote/`, { cookie });
    expect(home.status).toBe(200);
    expect(home.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(await home.text()).toContain("Moonlight Web");
    const user = await get(`${origin}/remote/api/user`, { cookie, "x-cophyla-user": "admin" });
    expect(((await user.json()) as { name: string }).name).toBe("cophyla");

    // the stream socket, text and binary, both ways
    const { ws, frames } = await socket(`wss://127.0.0.1:${d.controller!.port}/remote/api/host/stream/web_socket`, cookie);
    await waitFor(() => frames.length >= 1);
    expect(frames[0]).toBe(JSON.stringify({ hello: "cophyla" }));
    ws.send("ping");
    ws.send(new Uint8Array([1, 2, 3, 250]));
    await waitFor(() => frames.length >= 3);
    expect(frames[1]).toBe("cophyla:ping");
    expect([...(frames[2] as Uint8Array)]).toEqual([1, 2, 3, 250]);

    // a web viewer, watching while the socket is open
    const watching = (await c.next(isMethod("remote.state", (p) => (p as RemoteState).viewers.some((v) => v.kind === "web" && v.connected === true)))).params as RemoteState;
    const viewer = watching.viewers.find((v) => v.kind === "web")!;
    expect(viewer.name).toBe("Pixel");
    expect(viewer.id).toMatch(/^web_[0-9a-f]{8}$/);

    // revoked: the socket closes and the cookie is dead
    const closed = new Promise<void>((r) => ws.addEventListener("close", () => r()));
    await c.request("remote.revoke", { node: d.identity.id, viewer: viewer.id });
    await closed;
    expect((await get(`${origin}/remote/`, { cookie })).status).toBe(403);
    expect(d.remote.state().viewers.some((v) => v.kind === "web")).toBe(false);
  });

  test("the phone going away ends its session; a second open reuses the sidecar's pairing; loopback serves nothing under /remote", async () => {
    const { d, fake } = await start();
    const c = await phone(d);
    const { url } = await c.request<{ url: string }>("remote.open", { node: d.identity.id });
    const cookie = (await get(url)).headers.get("set-cookie")!.split(";")[0]!;
    const origin = `https://127.0.0.1:${d.controller!.port}`;
    expect((await get(`${origin}/remote/`, { cookie })).status).toBe(200);
    c.close();
    await waitFor(() => !d.remote.state().viewers.some((v) => v.kind === "web"));
    expect((await get(`${origin}/remote/`, { cookie })).status).toBe(403);

    const again = await phone(d, "Tablet");
    await again.request("remote.open", { node: d.identity.id });
    expect(fake.clients.map((x) => x.name)).toEqual(["study web"]);
    expect(fake.pins.filter((p) => p.ok).length).toBe(1);

    const loop = await fetch(`http://127.0.0.1:${d.api.port}/remote/?t=${"0".repeat(32)}`);
    expect(loop.status).toBe(404);
  });

  test("the phone app forwarding the page: a path, the WebSocket transport, a cookie without Secure through loopback, closed by remote.close", async () => {
    const { d } = await start(`web_transport = "webrtc"\n`);
    const { token } = d.grants.createController("Pixel");
    const c = await TestClient.connect(`wss://127.0.0.1:${d.controller!.port}/ws/client`, { insecure: true });
    clients.push(c);
    const hello = await c.call("hello", { token, kind: "controller", audio: { in: false, out: false }, forward: true });
    expect("error" in hello).toBe(false);
    const opened = await c.request<{ url?: string; path: string; transport: string; node: string; stream: string }>("remote.open", { node: d.identity.id });
    expect(opened.url).toBeUndefined();
    expect(opened.path).toMatch(/^\/remote\/\?t=[0-9a-f]{32}$/);
    expect(opened.transport).toBe("websocket");
    expect(opened.node).toBe(d.identity.id);
    expect(opened.stream).toMatch(/^stream_[0-9a-f]{16}$/);
    const open = d.store.audit.list({ limit: 100 }).find((e) => e.action === "remote.open")!;
    expect((open.result!.body as { path: string }).path).toBe("/remote/?t=[redacted]");

    // the forwarder on the phone's loopback passes its own Host through
    const origin = `https://127.0.0.1:${d.controller!.port}`;
    const claim = await get(`${origin}${opened.path}`, { host: "127.0.0.1:50123" });
    expect(claim.status).toBe(200);
    const setCookie = claim.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^cophyla_remote=[0-9a-f]{32}; Path=\/remote; HttpOnly; SameSite=Strict$/);
    const page = await claim.text();
    expect(page).toContain(`s.dataTransport="websocket"`);
    // only a ticket for the view beside the app's pane is seeded for low latency
    expect(page).not.toContain("canvasRenderer");
    const cookie = setCookie.split(";")[0]!;
    expect((await get(`${origin}/remote/`, { cookie })).status).toBe(200);

    // a browser controller on the same node still gets the node's default and a Secure cookie
    const browser = await phone(d, "Laptop");
    const { url, stream } = await browser.request<{ url: string; stream: string }>("remote.open", { node: d.identity.id });
    expect(stream).toMatch(/^stream_/);
    const other = await get(url);
    expect(other.headers.get("set-cookie")).toContain("; Secure;");
    expect(await other.text()).toContain(`s.dataTransport="webrtc"`);

    // the stream closes for its own client only
    await c.request("remote.close", { stream });
    expect(d.remote.state().viewers.filter((v) => v.kind === "web")).toHaveLength(2);
    await c.request("remote.close", { stream: opened.stream });
    expect((await get(`${origin}/remote/`, { cookie })).status).toBe(403);
    expect(d.remote.state().viewers.filter((v) => v.kind === "web")).toHaveLength(1);
  });

  test("a ticket is spent by its claim and dies after five minutes unclaimed", () => {
    let now = 1_000_000;
    const tickets = new RemoteTickets({ now: () => now });
    const target = { node: "node_x", hostId: 1, appId: 2 };
    const t1 = tickets.mint("client_a", target, { name: "Pixel" }).ticket;
    const t2 = tickets.mint("client_a", target).ticket;
    now += 5 * 60_000 + 1;
    expect(tickets.claim(t1)).toBeUndefined();
    const t3 = tickets.mint("client_b", target).ticket;
    const s = tickets.claim(t3)!;
    expect(s.client).toBe("client_b");
    expect(s.stream).toMatch(/^stream_[0-9a-f]{16}$/);
    expect(tickets.claim(t3)).toBeUndefined();
    expect(tickets.claim(t2)).toBeUndefined();
    expect(tickets.viewers()).toEqual([{ id: `web_${s.id.slice(0, 8)}`, kind: "web", since: now, connected: false }]);
    tickets.forgetClient("client_b");
    expect(tickets.list()).toEqual([]);
  });

  test("a stream is closed by its own client only, claimed or not; loopback hosts are told apart", () => {
    const tickets = new RemoteTickets();
    const target = { node: "node_x", hostId: 1, appId: 2 };
    const unclaimed = tickets.mint("client_a", target, { transport: "webrtc" });
    expect(tickets.close(unclaimed.stream, "client_b")).toBe(false);
    expect(tickets.close(unclaimed.stream, "client_a")).toBe(true);
    expect(tickets.claim(unclaimed.ticket)).toBeUndefined();
    const claimed = tickets.mint("client_a", target, { transport: "websocket", secureCookie: false });
    const s = tickets.claim(claimed.ticket)!;
    expect(s).toMatchObject({ transport: "websocket", secureCookie: false, stream: claimed.stream });
    expect(tickets.close(claimed.stream, "client_b")).toBe(false);
    expect(tickets.list()).toHaveLength(1);
    expect(tickets.close(claimed.stream, "client_a")).toBe(true);
    expect(tickets.list()).toEqual([]);
    for (const host of ["127.0.0.1:50123", "localhost:9", "[::1]:4000", "127.0.0.1"]) expect(loopbackHost(host)).toBe(true);
    for (const host of ["192.168.1.44:4818", "127.0.0.1.evil:1", "[fe80::1]:4818", null]) expect(loopbackHost(host)).toBe(false);
  });

  test("a low-latency ticket seeds the canvas renderer and HEVC where the page decodes it; others are left as they were", async () => {
    const tickets = new RemoteTickets();
    const proxy = new RemoteProxy({ tickets, upstream: () => undefined, transport: () => "webrtc", log: silentLogger });
    const target = { node: "node_x", hostId: 1, appId: 2 };
    const claim = async (ticket: string) => {
      const res = await proxy.handle(new Request(`http://127.0.0.1:50123/remote/?t=${ticket}`, { headers: { host: "127.0.0.1:50123" } }), () => false);
      return res!.text();
    };
    const low = await claim(tickets.mint("client_a", target, { transport: "websocket", secureCookie: false, lowLatency: true }).ticket);
    expect(low).toContain(`s.dataTransport="websocket";s.canvasRenderer=true;s.videoCodec=MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"')?"h265":"h264";`);
    const plain = await claim(tickets.mint("client_a", target).ticket);
    expect(plain).toContain(`s.dataTransport="webrtc";localStorage.setItem`);
    expect(plain).not.toContain("videoCodec");
  });

  test("the sessions showing one desktop are ended together, a client's on others left", () => {
    const tickets = new RemoteTickets();
    const mine = { node: "node_self", hostId: 1, appId: 2 };
    const other = { node: "node_other", hostId: 3, appId: 4 };
    tickets.claim(tickets.mint("client_a", mine).ticket);
    tickets.claim(tickets.mint("node_b:client_c", mine).ticket);
    tickets.claim(tickets.mint("client_a", other).ticket);
    const waiting = tickets.mint("client_d", mine);
    tickets.forgetWhere((_client, t) => t.node === "node_self");
    expect(tickets.list().map((s) => s.target.node)).toEqual(["node_other"]);
    expect(tickets.claim(waiting.ticket)).toBeUndefined();
  });
});
