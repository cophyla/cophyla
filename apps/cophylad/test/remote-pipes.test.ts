// A stream page carried through pipes, with the fake moonlight-web as the sidecar and the
// phone's forwarder played on loopback: each of the page's connections becomes a pipe from
// the phone to this node's loopback stream proxy. The ticket buys a cookie without `Secure`
// (the page is on the phone's loopback), the page, the API and the stream socket come through
// both ways; a reader that stops acknowledging holds the node to one window of bytes, and the
// rest comes once it acknowledges; a pipe the page closes, and every pipe of a phone that
// goes, is gone on the node too. The web viewer is given its ICE script, which prints the
// servers file or an empty list, and the STUN servers it seeds its config with are taken out.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Daemon } from "../src/daemon.ts";
import { silentLogger } from "../src/log.ts";
import { HostApi } from "../src/remote/host.ts";
import { PIPE_WINDOW } from "../src/remote/pipes.ts";
import { iceScript, withoutSeededStun } from "../src/remote/web.ts";
import { startFakeApollo } from "./fakes/apollo.ts";
import type { FakeApollo } from "./fakes/apollo.ts";
import { TestForwarder } from "./fakes/pipe-forwarder.ts";
import type { PipeLink } from "./fakes/pipe-forwarder.ts";
import { FAKE_WEB, remoteSeams } from "./fakes/remote.ts";
import { removeHome, stopDaemon, tempHome, TestClient, waitFor } from "./helpers.ts";

interface Started {
  d: Daemon & { home: string };
  fake: FakeApollo;
  scratch: string;
}

let current: Started | undefined;
const closers: (() => void)[] = [];

afterEach(async () => {
  for (const c of closers.splice(0)) c();
  if (!current) return;
  await stopDaemon(current.d);
  await current.fake.stop();
  removeHome(current.scratch);
  current = undefined;
});

async function start(): Promise<Started> {
  const scratch = tempHome();
  const fake = await startFakeApollo();
  fake.acceptAny = true;
  const seams = remoteSeams();
  writeFileSync(
    join(scratch, "config.toml"),
    `[nodes]\ndiscovery = false\n\n[sessions]\ndiscover = false\ninstall_hooks = false\n\n[update]\nenabled = false\n\n[node]\nname = "study"\n\n[controller]\nenabled = true\nhost = "127.0.0.1"\nport = 0\n\n[remote]\nenabled = true\nhost_command = "C:\\\\fake\\\\Apollo\\\\sunshine.exe"\npoll_ms = 100\n`,
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

/** The phone app on the controller listener, forwarding its stream pages. */
async function phone(d: Daemon): Promise<TestClient> {
  const { token } = d.grants.createController("Pixel");
  const c = await TestClient.connect(`wss://127.0.0.1:${d.controller!.port}/ws/client`, { insecure: true });
  closers.push(() => c.close());
  const r = await c.call("hello", { token, kind: "controller", audio: { in: false, out: false }, forward: true });
  if ("error" in r) throw new Error(r.error.message);
  return c;
}

function linkOf(c: TestClient): PipeLink {
  return {
    request: (method, params) => c.request(method, params),
    signal: (method, params) => c.signal(method, params),
    listen: (handler) => {
      c.onNotification = (n) => handler(n.method, n.params);
    },
  };
}

function forwarder(c: TestClient, node: string): TestForwarder {
  const f = new TestForwarder(linkOf(c), node);
  closers.push(() => f.stop());
  return f;
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

describe("a stream page through pipes", () => {
  test("the ticket's cookie without Secure, the page, the API and the stream socket; closed pipes and a phone gone leave none", async () => {
    const { d } = await start();
    const c = await phone(d);
    const opened = await c.request<{ path: string; stream: string }>("remote.open", { node: d.identity.id });
    const f = forwarder(c, d.identity.id);
    const base = `http://127.0.0.1:${f.port}`;

    const claim = await get(`${base}${opened.path}`);
    expect(claim.status).toBe(200);
    const setCookie = claim.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^cophyla_remote=[0-9a-f]{32}; Path=\/remote; HttpOnly; SameSite=Strict$/);
    expect(await claim.text()).toContain(`/remote/stream.html?hostId=`);
    const cookie = setCookie.split(";")[0]!;
    expect(await (await get(`${base}/remote/`, { cookie })).text()).toContain("Moonlight Web");
    expect(((await (await get(`${base}/remote/api/user`, { cookie })).json()) as { name: string }).name).toBe("cophyla");
    expect((await get(`${base}/remote/`)).status).toBe(403);

    const { ws, frames } = await socket(`ws://127.0.0.1:${f.port}/remote/api/host/stream/web_socket`, cookie);
    await waitFor(() => frames.length >= 1);
    expect(frames[0]).toBe(JSON.stringify({ hello: "cophyla" }));
    ws.send("ping");
    ws.send(new Uint8Array([9, 8, 7, 200]));
    await waitFor(() => frames.length >= 3);
    expect(frames[1]).toBe("cophyla:ping");
    expect([...(frames[2] as Uint8Array)]).toEqual([9, 8, 7, 200]);

    // each connection was a pipe, opened as the phone (settled by structure, audited)
    const rows = d.store.audit.list({ limit: 200 }).filter((e) => e.action === "remote.pipe.open");
    expect(rows.length).toBe(f.opened);
    expect(rows.every((e) => e.decision === "allow")).toBe(true);
    expect(d.pipes.count).toBeGreaterThan(0);

    // the socket closed by the page: its pipe is gone on the node
    const before = d.pipes.count;
    ws.close();
    await waitFor(() => d.pipes.count < before);
    // the phone going: every pipe it had is gone
    c.close();
    await waitFor(() => d.pipes.count === 0);
    expect(f.failures).toEqual([]);
  });

  test("a reader that stops acknowledging holds the node to one window; the rest comes once it does", async () => {
    const { d } = await start();
    const c = await phone(d);
    const opened = await c.request<{ path: string }>("remote.open", { node: d.identity.id });
    const f = forwarder(c, d.identity.id);
    const base = `http://127.0.0.1:${f.port}`;
    const cookie = (await get(`${base}${opened.path}`)).headers.get("set-cookie")!.split(";")[0]!;

    f.holdAcks = true;
    const mark = f.received;
    const size = 1024 * 1024;
    const body = get(`${base}/remote/api/blob?bytes=${size}`, { cookie }).then((r) => r.arrayBuffer());
    await waitFor(() => f.received - mark > PIPE_WINDOW / 2, 5000);
    await Bun.sleep(400);
    const held = f.received - mark;
    expect(held).toBeLessThanOrEqual(PIPE_WINDOW);
    f.release();
    const bytes = new Uint8Array(await body);
    expect(bytes.length).toBe(size);
    let ok = true;
    for (let i = 0; i < size; i++) if (bytes[i] !== ((i * 31 + 7) & 0xff)) ok = false;
    expect(ok).toBe(true);
  });

  test("the web viewer is given its ICE script: the servers file, or an empty list; its seeded STUN servers go", async () => {
    const { d } = await start();
    const c = await phone(d);
    const opened = await c.request<{ path: string }>("remote.open", { node: d.identity.id });
    const f = forwarder(c, d.identity.id);
    const base = `http://127.0.0.1:${f.port}`;
    const cookie = (await get(`${base}${opened.path}`)).headers.get("set-cookie")!.split(";")[0]!;
    const argv = (await (await get(`${base}/remote/api/argv`, { cookie })).json()) as string[];
    const at = argv.indexOf("--webrtc-ice-server-script");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(argv.indexOf("run"));
    const script = argv[at + 1]!;
    expect(script).toBe(iceScript(join(d.home, "data", "remote", "ice-servers.json")).path);

    // the script prints an empty list with no servers file, and the file once there is one
    const run = async () => {
      const cmd = process.platform === "win32" ? ["cmd", "/c", script] : ["sh", script];
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return JSON.parse(out.trim()) as unknown;
    };
    expect(await run()).toEqual([]);
    const servers = [{ urls: ["turn:turn.example.test:3478?transport=udp"], username: "u", credential: "c" }];
    mkdirSync(join(d.home, "data", "remote"), { recursive: true });
    writeFileSync(join(d.home, "data", "remote", "ice-servers.json"), JSON.stringify(servers));
    expect(await run()).toEqual(servers);
  });

  test("the seeded STUN servers are taken out of the viewer's config, a server of the user's kept; a config without any is left alone", () => {
    const own = { urls: ["turn:turn.example.test:3478"], username: "me", credential: "pw" };
    const seeded = { web_server: { bind_address: "127.0.0.1:0" }, webrtc: { ice_servers: [{ urls: ["stun:l.google.com:19302", "stun:stun.l.google.com:19302"] }, { urls: "stun:stun1.l.google.com:19302" }, own], port_range: { min: 40000, max: 40010 } } };
    expect(JSON.parse(withoutSeededStun(JSON.stringify(seeded))!)).toEqual({ ...seeded, webrtc: { ice_servers: [own], port_range: { min: 40000, max: 40010 } } });
    expect(withoutSeededStun(JSON.stringify({ webrtc: { ice_servers: [own] } }))).toBeUndefined();
    expect(withoutSeededStun(JSON.stringify({ webrtc: { ice_servers: [] } }))).toBeUndefined();
    expect(withoutSeededStun("not json")).toBeUndefined();
    // a path with a quote in it stays one argument in the shell script
    const sh = iceScript("/home/o'neil/.cophyla/data/remote/ice-servers.json", false);
    expect(sh.path).toBe(join("/home/o'neil/.cophyla/data/remote", "ice-servers.sh"));
    expect(sh.text).toContain(`cat '/home/o'\\''neil/.cophyla/data/remote/ice-servers.json' 2>/dev/null || echo '[]'`);
  });
});
