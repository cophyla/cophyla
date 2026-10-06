// Another node's desktop where there is no route to it: a primary and a secondary on no
// common network, linked through the server relay, both with direct connections on; the
// secondary shares its desktop (the fake host and the fake moonlight-web). The desktop app
// on the primary opening the secondary's desktop gets a URL on its own loopback: the ticket
// is the secondary's, gated there as the primary with the pairing's words (the owner
// answers), and the page, the API and the stream socket come through a forwarder here and
// pipes over the link to the secondary's loopback proxy, the video set for WebRTC;
// `remote.close` ends the session there. A phone on the relay opening the same desktop gets
// the path and WebRTC, its own forwarder's pipes run through the primary, and the phone
// going ends the session on the secondary. A browser on the primary's network, to which the
// primary's loopback is nothing, gets a page on the primary's stream listener: the primary
// claims the secondary's ticket itself and keeps its cookie, and the page, the API and the
// stream socket come through the same forwarder and pipes under the stream door's rules; it
// is the secondary's viewer and not the primary's. The phone app on that network gets the
// path and WebRTC as it does on the relay.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Ask } from "@cophyla/protocol";
import { paths } from "../src/config/load.ts";
import { silentLogger } from "../src/log.ts";
import { HostApi } from "../src/remote/host.ts";
import { startFakeApollo } from "./fakes/apollo.ts";
import type { FakeApollo } from "./fakes/apollo.ts";
import { FakeNet, FakeWire } from "./fakes/net.ts";
import { TestForwarder } from "./fakes/pipe-forwarder.ts";
import type { PipeLink } from "./fakes/pipe-forwarder.ts";
import { RelayPhone } from "./fakes/relay-phone.ts";
import { FAKE_WEB, remoteSeams } from "./fakes/remote.ts";
import { FakeServer } from "./fakes/server.ts";
import { TestClient, tempHome, waitFor } from "./helpers.ts";
import { client, linked, startPrimary, startSecondary, stopAll } from "./nodes-helpers.ts";
import type { Primary, Started } from "./nodes-helpers.ts";

let primary: Primary | undefined;
let secondary: Started | undefined;
let fake: FakeServer | undefined;
let apollo: FakeApollo | undefined;
const closers: (() => void)[] = [];

afterEach(async () => {
  for (const c of closers.splice(0)) c();
  await stopAll(secondary, primary?.d);
  primary = undefined;
  secondary = undefined;
  await fake?.stop();
  fake = undefined;
  await apollo?.stop();
  apollo = undefined;
});

function signedInHome(f: FakeServer): { home: string; toml: string } {
  const home = tempHome();
  const p = paths(home);
  mkdirSync(p.data, { recursive: true });
  writeFileSync(p.accountToken, f.mintToken() + "\n", { mode: 0o600 });
  return { home, toml: `[cloud]\nenabled = true\nurl = "${f.url}"\nallow_insecure = true\nreconnect_ms = 20\nreconnect_max_ms = 100\nhello_timeout_ms = 3000\n\n[direct]\nrestart_backoff_ms = 50\n\n` };
}

async function start(opts: { lan?: boolean } = {}) {
  fake = new FakeServer();
  apollo = await startFakeApollo();
  apollo.acceptAny = true;
  const wire = new FakeWire();
  const netP = new FakeNet();
  const netS = new FakeNet();
  netP.wire = wire;
  netS.wire = wire;
  const ph = signedInHome(fake);
  // with `lan`, the primary serves the devices on its network, where the secondary then links too: `lan_route` off has
  // the primary treat its desktop as one it has no route to, which is what that switch is for on one machine
  primary = await startPrimary({ ...(opts.lan ? {} : { noLan: true }), heartbeatMs: 1000, home: ph.home, toml: ph.toml + (opts.lan ? `[remote]\nlan_route = false\n\n` : ""), daemon: { cloud: { keys: [fake.publicKey] }, direct: { spawn: netP.spawn, command: () => "cophyla-net" } } });
  await waitFor(() => fake!.primaryOf()?.primary === primary!.d.identity.id, 5000);
  await primary.d.direct.enable();
  await waitFor(() => primary!.d.direct.ready, 5000);
  const sh = signedInHome(fake);
  const seams = remoteSeams();
  seams.screen = { width: 1920, height: 1200 };
  const port = apollo.port;
  secondary = await startSecondary(
    primary,
    {
      noEndpoint: true,
      relayOnly: true,
      home: sh.home,
      node: `name = "den"\n`,
      toml: sh.toml + `[remote]\nenabled = true\nhost_command = "C:\\\\fake\\\\Apollo\\\\sunshine.exe"\npoll_ms = 100\n`,
      heartbeatMs: 1000,
      daemon: {
        cloud: { keys: [fake.publicKey] },
        direct: { spawn: netS.spawn, command: () => "cophyla-net", link: { firstTryMs: 60_000, retryMs: [60_000] } },
        remote: {
          os: "windows",
          exec: seams.exec,
          hostApi: (kind) => new HostApi({ kind, port, log: silentLogger, timeoutMs: 3000 }),
          moonlight: { spawn: seams.spawn, command: seams.moonlight },
          screenshot: seams.screenshot,
          display: seams.display,
          web: { command: [process.execPath, FAKE_WEB] },
        },
      },
    },
  );
  await waitFor(() => secondary!.cloud.state().connected === true, 5000);
  await secondary.direct.enable();
  await waitFor(() => secondary!.direct.ready, 5000);
  await secondary.remote.ready();
  await linked(secondary, 10_000);
  if (!opts.lan) expect(secondary.nodes.via()).toBe("relay");
  return { p: primary, s: secondary };
}

/** The owner of the secondary's desktop lets the viewer in, when its gate asks. */
async function allowOn(s: Started): Promise<Ask> {
  const ask = await waitFor(() => s.asks.listOpen().find((a) => a.source.kind === "gate" && a.source.action === "remote.ticket"), 10_000);
  s.asks.answer(ask.id, { option: "allow" }, { kind: "user", client: "cli_01ARZ3NDEKTSV4RRFFQ69G5FB7" });
  return ask;
}

const get = (url: string, headers: Record<string, string> = {}) => fetch(url, { redirect: "manual", headers });

function socket(url: string, cookie: string): Promise<{ ws: WebSocket; frames: (string | Uint8Array)[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { cookie } } as never);
    ws.binaryType = "arraybuffer";
    closers.push(() => ws.close());
    const frames: (string | Uint8Array)[] = [];
    ws.addEventListener("message", (ev) => frames.push(typeof ev.data === "string" ? ev.data : new Uint8Array(ev.data as ArrayBuffer)));
    ws.addEventListener("open", () => resolve({ ws, frames }));
    ws.addEventListener("error", () => reject(new Error("socket failed")));
  });
}

/** The page at `base` + `path`: claimed, then the home page, the API and the stream socket; the claim page and the stream page. */
async function watch(base: string, path: string): Promise<{ page: string; stream: string }> {
  const claim = await get(`${base}${path}`);
  expect(claim.status).toBe(200);
  const setCookie = claim.headers.get("set-cookie")!;
  expect(setCookie).toMatch(/^cophyla_remote=[0-9a-f]{32}; Path=\/remote; HttpOnly; SameSite=Strict$/);
  const page = await claim.text();
  expect(page).toContain(`s.dataTransport="webrtc"`);
  const cookie = setCookie.split(";")[0]!;
  expect(await (await get(`${base}/remote/`, { cookie })).text()).toContain("Moonlight Web");
  expect(((await (await get(`${base}/remote/api/user`, { cookie })).json()) as { name: string }).name).toBe("cophyla");
  const { ws, frames } = await socket(`${base.replace(/^http/, "ws")}/remote/api/host/stream/web_socket`, cookie);
  await waitFor(() => frames.length >= 1);
  expect(frames[0]).toBe(JSON.stringify({ hello: "cophyla" }));
  ws.send("ping");
  await waitFor(() => frames.length >= 2);
  expect(frames[1]).toBe("cophyla:ping");
  const stream = await (await get(`${base}${/"(\/remote\/stream\.html[^"]*)"/.exec(page)![1]}`, { cookie })).text();
  return { page, stream };
}

describe("a desktop with no route to it", () => {
  test("the desktop app on the primary: a loopback URL, the secondary's ticket gated there, the page through pipes, closed by remote.close", async () => {
    const { p, s } = await start();
    const ui: TestClient = await client(p.d, "laptop app");
    closers.push(() => ui.close());
    expect(p.d.nodes.lanRoute(s.identity.id)).toBe(false);

    const opening = ui.request<{ url: string; stream: string; video?: { width: number; height: number } }>("remote.open", { node: s.identity.id });
    const ask = await allowOn(s);
    expect(ask.title).toBe("Let laptop app view and control this desktop?");
    const opened = await opening;
    const m = /^http:\/\/127\.0\.0\.1:(\d+)(\/remote\/\?t=[0-9a-f]{32})$/.exec(opened.url)!;
    expect(m).not.toBeNull();
    expect(opened.stream).toMatch(/^stream_[0-9a-f]{16}$/);
    const row = s.store.audit.list({ limit: 200 }).find((e) => e.action === "remote.ticket")!;
    expect(row.principal).toEqual({ kind: "node", id: p.d.identity.id });
    expect(row).toMatchObject({ decision: "ask", ask: ask.id, outcome: "ok" });
    // the row every client with the audit stream hears keeps no live ticket
    expect((row.result!.body as { path: string }).path).toBe("/remote/?t=[redacted]");

    // the window on this machine is seeded for low latency, as the view beside the pane is, at
    // the host's screen size and the bitrate across the internet, the pointer hidden over it
    expect(opened.video).toEqual({ width: 1920, height: 1200 });
    const watched = await watch(`http://127.0.0.1:${m[1]}`, m[2]!);
    expect(watched.page).toContain(`s.canvasRenderer=true;`);
    expect(watched.page).toContain(`s.videoSize="custom";s.videoSizeCustom={"width":1920,"height":1200};s.fps=60;s.bitrate=15000;`);
    expect(watched.stream).toContain("<style>.video-stream{cursor:none}</style></head>");
    expect(watched.stream).toContain("codedWidth:1920,codedHeight:1200");
    await waitFor(() => s.remote.state().viewers.some((v) => v.kind === "web" && v.name === "laptop app"));
    // the pipes ran here and there
    expect(p.d.pipes.count).toBeGreaterThan(0);
    expect(s.pipes.count).toBeGreaterThan(0);

    await ui.request("remote.close", { stream: opened.stream });
    await waitFor(() => !s.remote.state().viewers.some((v) => v.kind === "web"), 5000);
    await waitFor(() => p.d.pipes.count === 0 && s.pipes.count === 0, 5000);
    // the forwarder went with it
    await expect(fetch(`http://127.0.0.1:${m[1]}/remote/`)).rejects.toThrow();

    // beside the view: the same way, through a forwarder here
    const beside = ui.request<{ url: string; stream: string; video?: { width: number; height: number } }>("remote.open", { node: s.identity.id, embed: true });
    await allowOn(s);
    const embedded = await beside;
    const e = /^http:\/\/127\.0\.0\.1:(\d+)(\/remote\/\?t=[0-9a-f]{32})$/.exec(embedded.url)!;
    expect(e).not.toBeNull();
    expect(embedded.video).toEqual({ width: 1920, height: 1200 });
    const besideWatched = await watch(`http://127.0.0.1:${e[1]}`, e[2]!);
    expect(besideWatched.page).toContain("s.canvasRenderer=true;");
    expect(besideWatched.stream).toContain("<style>.video-stream{cursor:none}</style></head>");
    await ui.request("remote.close", { stream: embedded.stream });
    await waitFor(() => !s.remote.state().viewers.some((v) => v.kind === "web"), 5000);
  });

  test("a browser on the primary's network: a page on the stream listener, the secondary's own page behind it through pipes, its cookie kept on the primary; closed by remote.close", async () => {
    const { p, s } = await start({ lan: true });
    const app = `https://127.0.0.1:${p.d.controller!.port}`;
    const origin = `https://127.0.0.1:${p.d.lan.streamPort!}`;
    const { token } = p.d.grants.createController("Laptop browser", { form: "browser", expiresAt: Date.now() + 3_600_000 });
    const browser = await TestClient.connect(`wss://127.0.0.1:${p.d.controller!.port}/ws/client`, { insecure: true, headers: { origin: app } });
    closers.push(() => browser.close());
    expect("error" in (await browser.call("hello", { token, kind: "controller", name: "Laptop browser", audio: { in: false, out: false } }))).toBe(false);

    // asked to show it beside its view: the secondary's ticket, gated there, seeded as the desktop app's window is
    const opening = browser.request<{ url: string; stream: string; video?: { width: number; height: number } }>("remote.open", { node: s.identity.id, embed: true });
    const ask = await allowOn(s);
    expect(ask.title).toBe("Let Laptop browser view and control this desktop?");
    const opened = await opening;
    expect(opened.url).toMatch(new RegExp(`^${origin.replace(/[.]/g, "\\.")}/remote/\\?t=[0-9a-f]{32}$`));
    expect(opened.video).toEqual({ width: 1920, height: 1200 });

    const insecure = { tls: { rejectUnauthorized: false } };
    const get = (url: string, headers: Record<string, string> = {}) => fetch(url, { redirect: "manual", headers, ...insecure } as RequestInit);
    // the ticket is the primary's own, for its stream door: not there on the controller listener
    expect((await get(`${app}/remote/?t=${opened.url.split("t=")[1]}`)).status).toBe(403);
    const claim = await get(opened.url);
    expect(claim.status).toBe(200);
    const setCookie = claim.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^cophyla_remote=[0-9a-f]{32}; Path=\/remote; Secure; HttpOnly; SameSite=Strict$/);
    expect(claim.headers.get("content-security-policy")).toMatch(new RegExp(`^default-src 'none'; script-src 'nonce-[^']+'; frame-ancestors ${app.replace(/[.]/g, "\\.")}$`));
    const page = await claim.text();
    // what the secondary's own claim page seeds, the app's page told it loaded, then the secondary's stream page
    expect(page).toContain(`s.dataTransport="webrtc"`);
    expect(page).toContain("s.canvasRenderer=true;");
    expect(page).toContain(`s.videoSizeCustom={"width":1920,"height":1200};s.fps=60;s.bitrate=15000;`);
    expect(page).toContain(`parent.postMessage({cophyla:"cophyla.stream.claimed"},"${app}")`);
    const streamPage = /location\.replace\("(\/remote\/stream\.html\?hostId=\d+&appId=\d+)"\)/.exec(page)![1]!;
    const cookie = setCookie.split(";")[0]!;
    // the secondary's session is its own: its cookie stays on the primary, and the browser's opens nothing there
    await waitFor(() => s.remote.tickets.list().length === 1);
    const their = s.remote.tickets.list()[0]!;
    expect(cookie).not.toContain(their.id);
    expect(page).not.toContain(their.id);

    const home = await get(`${origin}/remote/`, { cookie });
    expect(await home.text()).toContain("Moonlight Web");
    expect(home.headers.get("content-security-policy")).toBe(`frame-ancestors ${app}`);
    expect(home.headers.get("set-cookie")).toBeNull();
    expect(((await (await get(`${origin}/remote/api/user`, { cookie })).json()) as { name: string }).name).toBe("cophyla");
    // the stream page as the secondary's proxy makes it for its sized session
    const stream = await (await get(`${origin}${streamPage}`, { cookie })).text();
    expect(stream).toContain("<style>.video-stream{cursor:none}</style></head>");
    expect(stream).toContain("codedWidth:1920,codedHeight:1200");
    // the stream socket: the stream page's own, bridged through the pipes both ways
    const ws = new WebSocket(`wss://127.0.0.1:${p.d.lan.streamPort!}/remote/api/host/stream/web_socket`, { headers: { cookie, origin }, ...insecure } as never);
    closers.push(() => ws.close());
    const frames: string[] = [];
    ws.addEventListener("message", (ev) => frames.push(String(ev.data)));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("socket failed")));
    });
    await waitFor(() => frames.length >= 1);
    expect(frames[0]).toBe(JSON.stringify({ hello: "cophyla" }));
    ws.send("ping");
    await waitFor(() => frames.length >= 2);
    expect(frames[1]).toBe("cophyla:ping");
    expect(p.d.pipes.count).toBeGreaterThan(0);

    // it watches the secondary's desktop, and is listed there; the primary's own desktop has no such viewer
    await waitFor(() => s.remote.state().viewers.some((v) => v.kind === "web" && v.name === "Laptop browser" && v.connected === true));
    expect(p.d.remote.state().viewers.filter((v) => v.kind === "web")).toEqual([]);
    // no other way in: not through the controller listener, without the cookie, or as a worker that would outlast the session
    expect((await get(`${app}/remote/`, { cookie })).status).toBe(403);
    expect((await get(`${origin}/remote/`)).status).toBe(403);
    expect((await get(`${origin}/remote/sw.js`, { cookie, "service-worker": "script" })).status).toBe(403);

    await browser.request("remote.close", { stream: opened.stream });
    await waitFor(() => !s.remote.state().viewers.some((v) => v.kind === "web"), 5000);
    await waitFor(() => p.d.pipes.count === 0 && s.pipes.count === 0, 5000);
    expect((await get(`${origin}/remote/`, { cookie })).status).toBe(403);
    expect(p.d.remote.tickets.list()).toEqual([]);

    // without embed: the page as the secondary's viewer has it, and the browser going ends it there too
    const plain = browser.request<{ url: string; stream: string; video?: object }>("remote.open", { node: s.identity.id });
    await allowOn(s);
    const second = await plain;
    expect(second.video).toBeUndefined();
    const again = await get(second.url);
    expect(await again.text()).not.toContain("canvasRenderer");
    await waitFor(() => s.remote.state().viewers.some((v) => v.kind === "web"));
    browser.close();
    await waitFor(() => !s.remote.state().viewers.some((v) => v.kind === "web"), 5000);
    expect(p.d.remote.tickets.list()).toEqual([]);
  }, 60_000);

  test("the phone app on the primary's network: the path and WebRTC, as on the relay, where the primary has no route to the desktop", async () => {
    const { p, s } = await start({ lan: true });
    const { token } = p.d.grants.createController("Pixel");
    const phone = await TestClient.connect(`wss://127.0.0.1:${p.d.controller!.port}/ws/client`, { insecure: true });
    closers.push(() => phone.close());
    expect("error" in (await phone.call("hello", { token, kind: "controller", name: "Pixel", audio: { in: false, out: false }, forward: true }))).toBe(false);
    const opening = phone.request<{ url?: string; path: string; transport: string; node: string; stream: string }>("remote.open", { node: s.identity.id });
    await allowOn(s);
    const opened = await opening;
    expect(opened.url).toBeUndefined();
    expect(opened).toMatchObject({ transport: "webrtc", node: s.identity.id });
    expect(opened.path).toMatch(/^\/remote\/\?t=[0-9a-f]{32}$/);
    // its own forwarder's pipes run through the primary, as they do from the relay
    const link: PipeLink = {
      request: (method, params) => phone.request(method, params),
      signal: (method, params) => phone.signal(method, params),
      listen: (handler) => {
        phone.onNotification = (n) => handler(n.method, n.params);
      },
    };
    const f = new TestForwarder(link, s.identity.id);
    closers.push(() => f.stop());
    const watched = await watch(`http://127.0.0.1:${f.port}`, opened.path);
    expect(watched.page).not.toContain("canvasRenderer");
    await phone.request("remote.close", { stream: opened.stream });
    await waitFor(() => !s.remote.state().viewers.some((v) => v.kind === "web"), 5000);
  }, 60_000);

  test("a phone on the relay: the path and WebRTC, its pipes through the primary; the phone gone ends the session there", async () => {
    const { p, s } = await start();
    const { controller, token } = p.d.grants.createController("Pixel");
    const access = await p.d.cloud.relayAccess(controller.id, "Pixel");
    const phone = new RelayPhone(access);
    closers.push(() => phone.close());
    await phone.connect();
    await phone.request("hello", { token, kind: "controller", name: "Pixel", audio: { in: false, out: false }, forward: true });

    const opening = phone.request<{ path: string; transport: string; node: string; stream: string; url?: string }>("remote.open", { node: s.identity.id });
    await allowOn(s);
    const opened = await opening;
    expect(opened.url).toBeUndefined();
    expect(opened.path).toMatch(/^\/remote\/\?t=[0-9a-f]{32}$/);
    expect(opened.transport).toBe("webrtc");
    expect(opened.node).toBe(s.identity.id);

    const link: PipeLink = {
      request: (method, params) => phone.request(method, params),
      signal: (method, params) => phone.signal(method, params),
      listen: (handler) => {
        phone.onNotification = handler;
      },
    };
    const f = new TestForwarder(link, s.identity.id);
    closers.push(() => f.stop());
    // the phone's page is as it was: the viewer's own size, its pointer its own
    const phoneWatched = await watch(`http://127.0.0.1:${f.port}`, opened.path);
    expect(phoneWatched.page).not.toContain("canvasRenderer");
    expect(phoneWatched.page).not.toContain("videoSize");
    expect(phoneWatched.stream).not.toContain("cursor:none");
    expect(phoneWatched.stream).not.toContain("codedWidth");
    expect(f.failures).toEqual([]);
    await waitFor(() => s.remote.state().viewers.some((v) => v.kind === "web" && v.name === "Pixel"));

    phone.close();
    await waitFor(() => !s.remote.state().viewers.some((v) => v.kind === "web"), 5000);
    await waitFor(() => p.d.pipes.count === 0 && s.pipes.count === 0, 5000);
  });
});
