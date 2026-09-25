// Spike 14: moonlight-web v2.10.0 natively on this machine, driven from Bun over its REST API
// with the reverse-proxy header as the login, paired with Apollo through /api/pin.
//
//   bun run spikes/14-remote/web.ts            # write config, start, add the host, pair, list apps
//   bun run spikes/14-remote/web.ts serve      # just start it and stay up (for proxy.ts / the browser)
//
// Layout after the unzip: out/moonlight-web/package/{web-server.exe,streamer.exe,static/};
// the server reads ./server/config.json relative to its cwd and keeps its users and hosts in
// ./server/data.json.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api as hostApi, HOST_LAN, loadCreds, sleep } from "./_shared";

export const PKG = join(import.meta.dir, "out", "moonlight-web", "package");
export const WEB_PORT = Number(process.env.WEB_PORT ?? 47800);
export const WEB_BASE = `http://127.0.0.1:${WEB_PORT}/remote`;
export const USER_HEADER = "x-cophyla-user";

// The config has no serde defaults for missing fields ("missing field
// `session_expiration_check_interval`"), so start from `print-config` — which writes and
// prints the default server/config.json when there is none, and panics on a partial one —
// and patch it.
export function writeConfig(): void {
  mkdirSync(join(PKG, "server"), { recursive: true });
  rmSync(join(PKG, "server", "config.json"), { force: true });
  const printed = Bun.spawnSync([join(PKG, "web-server.exe"), "print-config"], { cwd: PKG });
  const config = JSON.parse(printed.stdout.toString());
  config.webrtc.ice_servers = [];
  config.webrtc.port_range = { min: 40000, max: 40010 };
  config.webrtc.nat_1to1 = { ice_candidate_type: "host", ips: [HOST_LAN] };
  config.web_server.bind_address = `127.0.0.1:${WEB_PORT}`;
  config.web_server.url_path_prefix = "/remote";
  config.web_server.forwarded_header = { username_header: USER_HEADER, auto_create_missing_user: true };
  config.moonlight.pair_device_name = "cophyla-web-spike";
  writeFileSync(join(PKG, "server", "config.json"), JSON.stringify(config, null, 2));
}

export function startServer() {
  const child = Bun.spawn([join(PKG, "web-server.exe"), "run"], {
    cwd: PKG,
    stdout: "pipe",
    stderr: "pipe",
  });
  const lines: string[] = [];
  const pump = async (s: ReadableStream<Uint8Array> | null, tag: string) => {
    if (!s) return;
    for await (const chunk of s) {
      for (const line of new TextDecoder().decode(chunk).split(/\r?\n/)) {
        if (line.trim()) { lines.push(line); console.log(`  [${tag}] ${line}`); }
      }
    }
  };
  void pump(child.stdout as any, "web");
  void pump(child.stderr as any, "web!");
  return { child, lines };
}

export async function web(path: string, init: { method?: string; body?: unknown; stream?: boolean; user?: string } = {}) {
  const t0 = performance.now();
  const headers: Record<string, string> = { [USER_HEADER]: init.user ?? "cophyla" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(WEB_BASE + path, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (init.stream) return { status: res.status, body: res.body, ms: Math.round(performance.now() - t0), setCookie: res.headers.get("set-cookie") };
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, ms: Math.round(performance.now() - t0), setCookie: res.headers.get("set-cookie") };
}

// The server answers /api/hosts and /api/pair as newline-delimited JSON, one object at a time.
export async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf.trim());
}

export async function waitUp(ms = 15_000): Promise<number> {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    try {
      const r = await fetch(WEB_BASE + "/");
      if (r.status < 500) return Math.round(performance.now() - t0);
    } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error("moonlight-web did not come up");
}

if (import.meta.main) {
  const mode = process.argv[2] ?? "all";
  if (!existsSync(join(PKG, "web-server.exe"))) throw new Error("unzip the release into out/moonlight-web first");
  writeConfig();
  const { child } = startServer();
  console.log(`up after ${await waitUp()} ms on ${WEB_BASE}`);

  if (mode === "serve") {
    console.log("serving; ctrl-c to stop");
    await child.exited;
    process.exit(0);
  }

  console.log("--- the page and the header login ---");
  const page = await fetch(WEB_BASE + "/");
  console.log(`GET /remote/: ${page.status} ${page.headers.get("content-type")} csp=${page.headers.get("content-security-policy")} xfo=${page.headers.get("x-frame-options")}`);
  const noHeader = await fetch(WEB_BASE + "/api/authenticate");
  console.log(`GET /api/authenticate without the header: ${noHeader.status}`);
  const auth = await web("/api/authenticate");
  console.log(`GET /api/authenticate with ${USER_HEADER}: ${auth.status} ${auth.text.slice(0, 200)} set-cookie=${auth.setCookie}`);
  const user = await web("/api/user");
  console.log(`GET /api/user: ${user.status} ${user.text.slice(0, 300)}`);
  const roles = await web("/api/roles");
  console.log(`GET /api/roles: ${roles.status} ${roles.text.slice(0, 600)}`);

  console.log("--- hosts ---");
  const hosts0 = await web("/api/hosts", { stream: true });
  const existing: any[] = [];
  for await (const h of ndjson(hosts0.body!)) existing.push(h);
  console.log(`GET /api/hosts: ${hosts0.status} ${JSON.stringify(existing).slice(0, 400)}`);
  let host = existing.find((h) => h.host?.address === HOST_LAN || h.address === HOST_LAN);
  if (!host) {
    const added = await web("/api/host", { body: { address: HOST_LAN, http_port: 47989 } });
    console.log(`POST /api/host: ${added.status} (${added.ms} ms) ${added.text.slice(0, 400)}`);
    host = added.json?.host ?? added.json;
  }
  const hostId = host?.host_id ?? host?.host?.host_id;
  console.log("host_id:", hostId, "paired:", JSON.stringify(host?.paired ?? host?.host?.paired ?? host?.pair_status));

  console.log("--- pairing: POST /api/pair streams the PIN, then the result ---");
  const creds = loadCreds()!;
  const pair = await web("/api/pair", { body: { host_id: hostId }, stream: true });
  console.log(`POST /api/pair: ${pair.status}`);
  const t0 = performance.now();
  let pin: string | undefined;
  const events: any[] = [];
  const consume = (async () => {
    for await (const ev of ndjson(pair.body!)) {
      events.push(ev);
      console.log(`  pair event at ${Math.round(performance.now() - t0)} ms: ${JSON.stringify(ev)}`);
      if (!pin) pin = ev.pin ?? ev.Pin ?? ev.data?.pin;
    }
  })();
  for (let i = 0; i < 100 && !pin; i++) await sleep(100);
  if (pin) {
    for (let tries = 1; tries <= 60; tries++) {
      const r = await hostApi("/api/pin", { creds, body: { pin, name: "spike-web" } });
      if (r.json?.status === true) { console.log(`  Apollo accepted the PIN after ${tries} tries, ${Math.round(performance.now() - t0)} ms`); break; }
      await sleep(500);
    }
  } else {
    console.log("  no pin in the stream; events so far:", JSON.stringify(events));
  }
  await Promise.race([consume, sleep(30_000)]);
  const hostAfter = await web(`/api/host?host_id=${hostId}`);
  console.log(`GET /api/host: ${hostAfter.status} ${hostAfter.text.slice(0, 500)}`);
  const apps = await web(`/api/apps?host_id=${hostId}`);
  console.log(`GET /api/apps: ${apps.status} ${apps.text.slice(0, 500)}`);
  const desktop = apps.json?.apps?.find((a: any) => a.title === "Desktop" || a.name === "Desktop");
  console.log(`stream page: ${WEB_BASE}/stream.html?hostId=${hostId}&appId=${desktop?.app_id ?? desktop?.id ?? "?"}`);
  console.log("--- Apollo's client list now ---");
  console.log(JSON.stringify((await hostApi("/api/clients/list", { creds })).json));
  child.kill();
}
