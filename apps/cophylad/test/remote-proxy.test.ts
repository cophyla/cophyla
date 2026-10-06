// The web viewer behind the node's listeners, with the fake moonlight-web as the sidecar and
// the fake host accepting its PIN: a controller's `remote.open` starts the sidecar, registers
// and pairs this node's host with it (the pairing gated and audited here as the phone) and
// answers a ticket URL on the stream listener, the app's host on a port of its own; the ticket
// buys one cookie and is dead after; the cookie is the only way in, the login header is the
// proxy's and never the browser's, HTML may be framed by the app's page it was minted for and
// no other, which the claim page tells it loaded; the stream socket is the stream page's own
// and is bridged both ways; the session is a `web` viewer in `remote.state`, `remote.revoke`
// ends it and its socket, and the client going away ends it too. Nothing under `/remote`
// answers on loopback. The phone app, which forwards the page through its own loopback, gets
// the path alone, on the controller listener, the WebSocket transport whatever the node's
// default, and a cookie without `Secure` when the page's `Host` is loopback; `remote.close`
// ends its stream, and nobody else's. A ticket and its session belong to the door they were
// minted for: neither is served through another, though a cookie reaches every port. Asked
// to show the desktop beside its view, a browser gets the page seeded as the desktop app's
// is. What a claim seeded and the next one does not is put back to the viewer's own.

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { RemoteState } from "@cophyla/protocol";
import type { Daemon } from "../src/daemon.ts";
import { silentLogger } from "../src/log.ts";
import { HostApi } from "../src/remote/host.ts";
import { decoderSizeScript, loopbackHost, RemoteProxy, RemoteTickets, SEEDED_KEY, seedScript, streamPageFor } from "../src/remote/proxy.ts";
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
        display: seams.display,
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

function socket(url: string, cookie: string, origin?: string): Promise<{ ws: WebSocket; frames: (string | Uint8Array)[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { cookie, ...(origin !== undefined ? { origin } : {}) }, ...insecure } as never);
    ws.binaryType = "arraybuffer";
    sockets.push(ws);
    const frames: (string | Uint8Array)[] = [];
    ws.addEventListener("message", (ev) => frames.push(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data as ArrayBuffer)));
    ws.addEventListener("open", () => resolve({ ws, frames }));
    ws.addEventListener("error", () => reject(new Error("socket failed")));
  });
}

describe("remote web viewer", () => {
  test("a controller opens this desktop: a ticket to a page on the stream listener, one cookie, the proxied page and API, the bridged socket, a web viewer, revoked", async () => {
    const { d, fake } = await start();
    const c = await phone(d);
    const app = `https://127.0.0.1:${d.controller!.port}`;
    const streamPort = d.lan.streamPort!;
    expect(streamPort).toBeGreaterThan(0);
    expect(streamPort).not.toBe(d.controller!.port);
    const origin = `https://127.0.0.1:${streamPort}`;
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
    // the app's page, as the client's socket named it, frames it and is told it loaded; nobody else
    expect(claim.headers.get("content-security-policy")).toContain(`frame-ancestors ${app}`);
    const page = await claim.text();
    expect(page).toContain(`parent.postMessage({cophyla:"cophyla.stream.claimed"},"${app}")`);
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
    expect(home.headers.get("content-security-policy")).toBe(`frame-ancestors ${app}`);
    expect(await home.text()).toContain("Moonlight Web");
    const user = await get(`${origin}/remote/api/user`, { cookie, "x-cophyla-user": "admin" });
    expect(((await user.json()) as { name: string }).name).toBe("cophyla");
    // the cookie goes to every port of the host, and the session is served through its own door alone: never on the app's origin
    expect((await get(`${app}/remote/`, { cookie })).status).toBe(403);
    expect((await get(`${app}/remote/api/user`, { cookie })).status).toBe(403);

    // the stream socket is the stream page's own: one that names no page, or the app's, is refused
    const path = `wss://127.0.0.1:${streamPort}/remote/api/host/stream/web_socket`;
    await expect(socket(path, cookie)).rejects.toThrow("socket failed");
    await expect(socket(path, cookie, app)).rejects.toThrow("socket failed");
    await expect(socket(`wss://127.0.0.1:${d.controller!.port}/remote/api/host/stream/web_socket`, cookie, app)).rejects.toThrow("socket failed");
    expect(d.remote.state().viewers.find((v) => v.kind === "web")!.connected).toBe(false);
    // text and binary, both ways
    const { ws, frames } = await socket(path, cookie, origin);
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

  test("the stream listener serves /remote alone, under this machine's names, and says its address is open; the app's page may frame it, and its ticket is claimed there and nowhere else", async () => {
    const { d } = await start();
    const c = await phone(d);
    const app = `https://127.0.0.1:${d.controller!.port}`;
    const origin = `https://127.0.0.1:${d.lan.streamPort!}`;
    // nothing of the app is here
    for (const path of ["/", "/index.html", "/main.js", "/ws/client", "/ws/node", "/doc/frame.html"]) expect((await get(`${origin}${path}`)).status).toBe(404);
    // another name that resolves here gets nothing
    expect((await get(`${origin}/remote/ready`, { host: "evil.example" })).status).toBe(421);
    // the page a browser opens once to accept this port's certificate: no session, no script, framed by nobody
    const ready = await get(`${origin}/remote/ready`);
    expect(ready.status).toBe(200);
    expect(ready.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(ready.headers.get("set-cookie")).toBeNull();
    expect(await ready.text()).toContain("This address is open in this browser now");
    // the app's page is told, in its policy, the one other origin it frames
    const page = await get(`${app}/`);
    expect(page.headers.get("content-security-policy")).toContain(`frame-src 'self' ${origin};`);
    // and lan.info names the port, for a firewall
    expect(d.lan.state().stream).toEqual({ port: d.lan.streamPort! });

    // a browser's ticket is not there on the controller listener, and is still good where it belongs
    const { url } = await c.request<{ url: string }>("remote.open", { node: d.identity.id });
    const ticket = url.split("t=")[1]!;
    expect((await get(`${app}/remote/?t=${ticket}`)).status).toBe(403);
    expect((await get(url)).status).toBe(200);
    // the phone app's, minted for its forwarder, is not there on the stream listener
    const { token } = d.grants.createController("Phone");
    const forwarding = await TestClient.connect(`wss://127.0.0.1:${d.controller!.port}/ws/client`, { insecure: true });
    clients.push(forwarding);
    await forwarding.call("hello", { token, kind: "controller", audio: { in: false, out: false }, forward: true });
    const opened = await forwarding.request<{ path: string }>("remote.open", { node: d.identity.id });
    expect((await get(`${origin}${opened.path}`)).status).toBe(403);
    const claim = await get(`${app}${opened.path}`);
    expect(claim.status).toBe(200);
    // its page frames itself as before and tells nobody
    expect(claim.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(await claim.text()).not.toContain("postMessage");
    const cookie = claim.headers.get("set-cookie")!.split(";")[0]!;
    expect((await get(`${app}/remote/`, { cookie })).status).toBe(200);
    expect((await get(`${origin}/remote/`, { cookie })).status).toBe(403);
    // the forwarder's page is on a loopback of the phone's; under one of this machine's names the controller listener has no stream page at all
    expect((await get(`${app}/remote/`, { cookie, host: "localhost:50123" })).status).toBe(200);
    expect((await get(`${app}/remote/`, { cookie, host: `${hostname().toLowerCase()}:${d.controller!.port}` })).status).toBe(404);
    expect((await get(`${app}${(await forwarding.request<{ path: string }>("remote.open", { node: d.identity.id })).path}`, { host: `${hostname().toLowerCase()}:${d.controller!.port}` })).status).toBe(404);
  });

  test("a browser shows the desktop beside its view: the page seeded as the desktop app's is, this node's own desktop included", async () => {
    const { d } = await start();
    const c = await phone(d, "Laptop");
    const { url, stream, video } = await c.request<{ url: string; stream: string; video?: { width: number; height: number } }>("remote.open", { node: d.identity.id, embed: true });
    expect(url.startsWith(`https://127.0.0.1:${d.lan.streamPort!}/remote/?t=`)).toBe(true);
    expect(stream).toMatch(/^stream_/);
    expect(video).toEqual({ width: expect.any(Number), height: expect.any(Number) });
    const claim = await get(url);
    expect(claim.headers.get("set-cookie")).toContain("; Secure;");
    const page = await claim.text();
    expect(page).toContain("s.canvasRenderer=true;");
    expect(page).toContain(`s.videoSizeCustom={"width":${video!.width},"height":${video!.height}};`);
    expect(d.remote.tickets.list()[0]).toMatchObject({ door: "stream", lowLatency: true, hideCursor: true, video: { width: video!.width, height: video!.height } });
    // without it, the page as the viewer has it
    const plain = await c.request<{ url: string; video?: object }>("remote.open", { node: d.identity.id });
    expect(plain.video).toBeUndefined();
    expect(await (await get(plain.url)).text()).not.toContain("canvasRenderer=true");
  });

  test("with access on this network off there is no stream listener, and none where the node runs no web viewer", async () => {
    const { d } = await start();
    const port = d.lan.streamPort!;
    expect((await get(`https://127.0.0.1:${port}/remote/ready`)).status).toBe(200);
    d.lan.disable();
    await waitFor(() => d.lan.state().state === "off");
    expect(d.lan.streamPort).toBeUndefined();
    expect(d.lan.state().stream).toBeUndefined();
    await waitFor(async () => (await get(`https://127.0.0.1:${port}/remote/ready`).then(() => false, () => true)));
    // back on: where it was, so a page that knew its address still finds it
    await d.lan.enable();
    expect(d.lan.streamPort).toBe(port);
    expect((await get(`https://127.0.0.1:${port}/remote/ready`)).status).toBe(200);
    await stopDaemon(current!.d);
    await current!.fake.stop();
    removeHome(current!.scratch);
    current = undefined;

    const off = await start("web = false\n");
    expect(off.d.lan.streamPort).toBeUndefined();
    expect(off.d.lan.state().stream).toBeUndefined();
    const c = await phone(off.d);
    expect(await c.call("remote.open", { node: off.d.identity.id })).toMatchObject({ error: { data: { code: "unsupported" } } });
  });

  test("the phone going away ends its session; a second open reuses the sidecar's pairing; loopback serves nothing under /remote", async () => {
    const { d, fake } = await start();
    const c = await phone(d);
    const { url } = await c.request<{ url: string }>("remote.open", { node: d.identity.id });
    const cookie = (await get(url)).headers.get("set-cookie")!.split(";")[0]!;
    const origin = `https://127.0.0.1:${d.lan.streamPort!}`;
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
    const t1 = tickets.mint("client_a", target, { door: "forward", name: "Pixel" }).ticket;
    const t2 = tickets.mint("client_a", target, { door: "forward" }).ticket;
    now += 5 * 60_000 + 1;
    expect(tickets.claim(t1, "forward")).toBeUndefined();
    const t3 = tickets.mint("client_b", target, { door: "forward" }).ticket;
    const s = tickets.claim(t3, "forward")!;
    expect(s.client).toBe("client_b");
    expect(s.door).toBe("forward");
    expect(s.stream).toMatch(/^stream_[0-9a-f]{16}$/);
    expect(tickets.claim(t3, "forward")).toBeUndefined();
    expect(tickets.claim(t2, "forward")).toBeUndefined();
    expect(tickets.viewers()).toEqual([{ id: `web_${s.id.slice(0, 8)}`, kind: "web", since: now, connected: false }]);
    tickets.forgetClient("client_b");
    expect(tickets.list()).toEqual([]);
  });

  test("a stream is closed by its own client only, claimed or not; loopback hosts are told apart", () => {
    const tickets = new RemoteTickets();
    const target = { node: "node_x", hostId: 1, appId: 2 };
    const unclaimed = tickets.mint("client_a", target, { door: "forward", transport: "webrtc" });
    expect(tickets.close(unclaimed.stream, "client_b")).toBe(false);
    expect(tickets.close(unclaimed.stream, "client_a")).toBe(true);
    expect(tickets.claim(unclaimed.ticket, "forward")).toBeUndefined();
    const claimed = tickets.mint("client_a", target, { door: "forward", transport: "websocket", secureCookie: false });
    const s = tickets.claim(claimed.ticket, "forward")!;
    expect(s).toMatchObject({ transport: "websocket", secureCookie: false, stream: claimed.stream });
    expect(tickets.close(claimed.stream, "client_b")).toBe(false);
    expect(tickets.list()).toHaveLength(1);
    expect(tickets.close(claimed.stream, "client_a")).toBe(true);
    expect(tickets.list()).toEqual([]);
    for (const host of ["127.0.0.1:50123", "localhost:9", "[::1]:4000", "127.0.0.1"]) expect(loopbackHost(host)).toBe(true);
    for (const host of ["192.168.1.44:4818", "127.0.0.1.evil:1", "[fe80::1]:4818", null]) expect(loopbackHost(host)).toBe(false);
  });

  test("a low-latency ticket seeds the canvas renderer and HEVC where the page decodes it; others seed the transport alone", async () => {
    const tickets = new RemoteTickets();
    const proxy = new RemoteProxy({ tickets, upstream: () => undefined, transport: () => "webrtc", log: silentLogger });
    const target = { node: "node_x", hostId: 1, appId: 2 };
    const claim = async (ticket: string) => {
      const res = await proxy.handle(new Request(`http://127.0.0.1:50123/remote/?t=${ticket}`, { headers: { host: "127.0.0.1:50123" } }), () => false, "loopback");
      return res!.text();
    };
    const low = await claim(tickets.mint("client_a", target, { door: "loopback", transport: "websocket", secureCookie: false, lowLatency: true }).ticket);
    expect(low).toContain(`s.dataTransport="websocket";s.canvasRenderer=true;s.videoCodec=MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L120.90"')?"h265":"h264";`);
    const plain = await claim(tickets.mint("client_a", target, { door: "loopback" }).ticket);
    expect(plain).toContain(`s.dataTransport="webrtc";localStorage.setItem`);
    expect(plain).not.toContain("videoCodec");
  });

  test("what one claim seeded and the next does not is put back to the viewer's own; what the user set there themselves stays", () => {
    const stored = new Map<string, string>();
    const localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) };
    const MediaSource = { isTypeSupported: () => true };
    const run = (script: string) => new Function("localStorage", "MediaSource", script)(localStorage, MediaSource);
    const settings = () => JSON.parse(stored.get("mlSettings")!) as Record<string, unknown>;
    // the user's own choices in the viewer, made before any claim
    stored.set("mlSettings", JSON.stringify({ bitrate: 20000, mouseMode: "relative" }));
    run(seedScript("webrtc", false));
    expect(settings()).toEqual({ bitrate: 20000, mouseMode: "relative", dataTransport: "webrtc" });
    expect(stored.get(SEEDED_KEY)).toBe("[]");
    // a session beside the view: its renderer, codec, size, rate
    run(seedScript("websocket", true, { width: 2560, height: 1440, fps: 60, bitrate: 55296 }));
    expect(settings()).toEqual({ mouseMode: "relative", dataTransport: "websocket", canvasRenderer: true, videoCodec: "h265", videoSize: "custom", videoSizeCustom: { width: 2560, height: 1440 }, fps: 60, bitrate: 55296 });
    expect(JSON.parse(stored.get(SEEDED_KEY)!)).toEqual(["canvasRenderer", "videoCodec", "videoSize", "videoSizeCustom", "fps", "bitrate"]);
    // the next one, plain: none of it is left, and the viewer falls back to its own
    run(seedScript("webrtc", false));
    expect(settings()).toEqual({ mouseMode: "relative", dataTransport: "webrtc" });
    // low latency without a size keeps no size from before
    run(seedScript("websocket", true, { width: 1920, height: 1080, fps: 60, bitrate: 20000 }));
    run(seedScript("websocket", true));
    expect(settings()).toEqual({ mouseMode: "relative", dataTransport: "websocket", canvasRenderer: true, videoCodec: "h265" });
    // a list that is not one is nothing to put back, and the settings are still seeded
    stored.set(SEEDED_KEY, "{oops");
    run(seedScript("webrtc", false));
    expect(settings()).toMatchObject({ dataTransport: "webrtc", canvasRenderer: true });
    stored.set(SEEDED_KEY, '"canvasRenderer"');
    expect(() => run(seedScript("webrtc", false))).not.toThrow();
  });

  test("a session is served through the door its ticket was minted for and no other; the stream door's pages are framed by the app's page alone", async () => {
    const tickets = new RemoteTickets();
    const upstream = async (): Promise<Response> => new Response("<html></html>", { headers: { "content-type": "text/html" } });
    const proxy = new RemoteProxy({ tickets, upstream: () => "http://127.0.0.1:1", transport: () => "websocket", log: silentLogger, fetch: upstream as unknown as typeof fetch });
    const target = { node: "node_x", hostId: 1, appId: 2 };
    const at = (door: "stream" | "forward" | "loopback", path: string, cookie?: string) => proxy.handle(new Request(`https://192.168.1.44:4820${path}`, { headers: { host: "192.168.1.44:4820", ...(cookie !== undefined ? { cookie } : {}) } }), () => false, door);
    const minted = tickets.mint("client_a", target, { door: "stream", ancestor: "https://192.168.1.44:4818" });
    // at another door the ticket is not there, and is not spent
    expect((await at("forward", `/remote/?t=${minted.ticket}`))!.status).toBe(403);
    expect((await at("loopback", `/remote/?t=${minted.ticket}`))!.status).toBe(403);
    const claim = (await at("stream", `/remote/?t=${minted.ticket}`))!;
    expect(claim.status).toBe(200);
    expect(claim.headers.get("content-security-policy")).toMatch(/^default-src 'none'; script-src 'nonce-[^']+'; frame-ancestors https:\/\/192\.168\.1\.44:4818$/);
    expect(await claim.text()).toContain(`try{parent!==window&&parent.postMessage({cophyla:"cophyla.stream.claimed"},"https://192.168.1.44:4818")}catch(e){}location.replace(`);
    const cookie = claim.headers.get("set-cookie")!.split(";")[0]!;
    expect((await at("forward", "/remote/", cookie))!.status).toBe(403);
    expect((await at("loopback", "/remote/", cookie))!.status).toBe(403);
    const page = (await at("stream", "/remote/", cookie))!;
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors https://192.168.1.44:4818");
    // a stream ticket with no page to frame it, or one that is no origin, is framed by nobody and tells nobody
    for (const ancestor of [undefined, "https://192.168.1.44:4818/; script-src *", "javascript:alert(1)", `https://a"b`]) {
      const t = tickets.mint("client_a", target, { door: "stream", ...(ancestor !== undefined ? { ancestor } : {}) });
      const res = (await at("stream", `/remote/?t=${t.ticket}`))!;
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(await res.text()).not.toContain("postMessage");
    }
    // a name and an IPv6 literal are origins
    for (const ancestor of ["https://desk.home.example:4818", "https://[fd00::5]:4818", "https://desk"]) {
      const t = tickets.mint("client_a", target, { door: "stream", ancestor });
      expect((await at("stream", `/remote/?t=${t.ticket}`))!.headers.get("content-security-policy")).toContain(`frame-ancestors ${ancestor}`);
    }
  });

  test("a ticket with a video seeds its size, frame rate and bitrate over the viewer's own; one without leaves them", async () => {
    const video = { width: 1920, height: 1200, fps: 60, bitrate: 34560 };
    expect(seedScript("websocket", true, video)).toContain(`"h265":"h264";s.videoSize="custom";s.videoSizeCustom={"width":1920,"height":1200};s.fps=60;s.bitrate=34560;localStorage.setItem`);
    expect(seedScript("webrtc", false)).not.toContain("videoSize");
    const tickets = new RemoteTickets();
    const proxy = new RemoteProxy({ tickets, upstream: () => undefined, transport: () => "webrtc", log: silentLogger });
    const minted = tickets.mint("client_a", { node: "node_x", hostId: 1, appId: 2 }, { door: "loopback", transport: "websocket", lowLatency: true, video, hideCursor: true });
    const res = await proxy.handle(new Request(`http://127.0.0.1:50123/remote/?t=${minted.ticket}`), () => false, "loopback");
    expect(await res!.text()).toContain(`s.videoSizeCustom={"width":1920,"height":1200};s.fps=60;s.bitrate=34560;`);
    expect(tickets.list()[0]).toMatchObject({ video, hideCursor: true });
  });

  test("the decoder script gives the page's video decoder the stream's size where the page gives none, and leaves a size the page gives", () => {
    const seen: Record<string, unknown>[] = [];
    class FakeDecoder {
      configure(config: Record<string, unknown>): void {
        seen.push(config);
      }
    }
    const window = { VideoDecoder: FakeDecoder };
    const body = /^<script>([\s\S]*)<\/script>$/.exec(decoderSizeScript(1920, 1200))![1]!;
    new Function("window", body)(window);
    new FakeDecoder().configure({ codec: "hev1.2.4.L120.90", optimizeForLatency: true });
    new FakeDecoder().configure({ codec: "avc1.640033", codedWidth: 2560, codedHeight: 1440 });
    expect(seen).toEqual([
      { codec: "hev1.2.4.L120.90", optimizeForLatency: true, codedWidth: 1920, codedHeight: 1200 },
      { codec: "avc1.640033", codedWidth: 2560, codedHeight: 1440 },
    ]);
    // a page with no decoder of its own is left alone
    expect(() => new Function("window", body)({})).not.toThrow();
  });

  test("a sized session, or one that hides the pointer, gets the stream page rewritten, fetched whole and kept out of the cache; every other response, and every other session's, as it came", async () => {
    const video = { width: 1920, height: 1200 };
    expect(streamPageFor("<html><head><title>x</title></head><body></body></html>", { hideCursor: true })).toBe("<html><head><title>x</title><style>.video-stream{cursor:none}</style></head><body></body></html>");
    expect(streamPageFor("<html><head><title>x</title></head></html>", { hideCursor: true, video })).toBe(`<html><head><title>x</title>${decoderSizeScript(1920, 1200)}<style>.video-stream{cursor:none}</style></head></html>`);
    expect(streamPageFor("<video></video>", { hideCursor: true })).toBe("<style>.video-stream{cursor:none}</style><video></video>");
    expect(streamPageFor("<html><head></head></html>", {})).toBe("<html><head></head></html>");
    const asked: { path: string; headers: Headers }[] = [];
    const upstream = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      asked.push({ path: url.pathname, headers: new Headers(init?.headers) });
      if (url.pathname === "/remote/stream.html") return new Response("<!doctype html><html><head><title>Stream</title></head><body></body></html>", { headers: { "content-type": "text/html", etag: '"s1"', "last-modified": "Wed, 01 Oct 2026 08:00:00 GMT" } });
      return new Response("export const x = 1;", { headers: { "content-type": "text/javascript", etag: '"j1"' } });
    };
    const tickets = new RemoteTickets();
    const proxy = new RemoteProxy({ tickets, upstream: () => "http://127.0.0.1:1", transport: () => "websocket", log: silentLogger, fetch: upstream as typeof fetch });
    const target = { node: "node_x", hostId: 1, appId: 2 };
    const session = async (opts: { hideCursor?: boolean; video?: { width: number; height: number; fps: number; bitrate: number } }) => {
      const res = await proxy.handle(new Request(`http://127.0.0.1:50123/remote/?t=${tickets.mint("client_a", target, { door: "loopback", secureCookie: false, ...opts }).ticket}`, { headers: { host: "127.0.0.1:50123" } }), () => false, "loopback");
      return res!.headers.get("set-cookie")!.split(";")[0]!;
    };
    const get = async (cookie: string, path: string) => (await proxy.handle(new Request(`http://127.0.0.1:50123${path}`, { headers: { cookie, "if-none-match": '"s0"', "accept-encoding": "gzip" } }), () => false, "loopback"))!;

    const hiding = await session({ hideCursor: true });
    const page = await get(hiding, "/remote/stream.html?hostId=1&appId=2");
    expect(await page.text()).toBe("<!doctype html><html><head><title>Stream</title><style>.video-stream{cursor:none}</style></head><body></body></html>");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("etag")).toBeNull();
    expect(page.headers.get("last-modified")).toBeNull();
    expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    // asked for whole: no validator the browser held, no compression to undo
    expect(asked.at(-1)!.headers.get("if-none-match")).toBeNull();
    expect(asked.at(-1)!.headers.get("accept-encoding")).toBeNull();
    // the scripts come as they are, validators and all
    const script = await get(hiding, "/remote/stream.js");
    expect(await script.text()).toBe("export const x = 1;");
    expect(script.headers.get("etag")).toBe('"j1"');
    expect(asked.at(-1)!.headers.get("if-none-match")).toBe('"s0"');

    // a sized session's page tells the decoder the stream's size
    const sized = await session({ video: { width: 2560, height: 1440, fps: 60, bitrate: 55296 } });
    const sizedPage = await (await get(sized, "/remote/stream.html?hostId=1&appId=2")).text();
    expect(sizedPage).toContain("codedWidth:2560,codedHeight:1440");
    expect(sizedPage).not.toContain("cursor:none");

    // the phone's session: the page as it came
    const plain = await session({});
    const untouched = await get(plain, "/remote/stream.html?hostId=1&appId=2");
    const untouchedText = await untouched.text();
    expect(untouchedText).not.toContain("cursor:none");
    expect(untouchedText).not.toContain("codedWidth");
    expect(untouched.headers.get("etag")).toBe('"s1"');
    expect(asked.at(-1)!.headers.get("if-none-match")).toBe('"s0"');
  });

  test("the sessions showing one desktop are ended together, a client's on others left", () => {
    const tickets = new RemoteTickets();
    const mine = { node: "node_self", hostId: 1, appId: 2 };
    const other = { node: "node_other", hostId: 3, appId: 4 };
    tickets.claim(tickets.mint("client_a", mine, { door: "stream" }).ticket, "stream");
    tickets.claim(tickets.mint("node_b:client_c", mine, { door: "loopback" }).ticket, "loopback");
    tickets.claim(tickets.mint("client_a", other, { door: "forward" }).ticket, "forward");
    const waiting = tickets.mint("client_d", mine, { door: "loopback" });
    tickets.forgetWhere((_client, t) => t.node === "node_self");
    expect(tickets.list().map((s) => s.target.node)).toEqual(["node_other"]);
    expect(tickets.claim(waiting.ticket, "loopback")).toBeUndefined();
  });
});
