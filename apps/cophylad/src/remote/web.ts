// The web viewer: moonlight-web as a sidecar on the viewing node, the one a phone's
// controller is connected to. It speaks Moonlight to a host and WebRTC or a WebSocket to
// the browser; cophylad fetches its release into `data/sidecars/moonlight-web/<version>/`,
// runs it on loopback under `/remote` with the reverse-proxy header as its login (so the
// proxy's cookie is the only door), registers each host node with it once, pairs it with
// that host through the same PIN flow moonlight-qt uses (`pairOn` posts the PIN on the host
// node) and remembers the ids in `hosts.json`. The stream page is then
// `/remote/stream.html?hostId=…&appId=…`, served through the proxy. Its WebRTC takes its ICE
// servers from a script cophylad writes beside the servers file (`ice-servers.cmd` or `.sh`),
// which prints the TURN servers the direct connections keep there, or none while they are
// off; the public STUN servers the sidecar seeds its own config with are taken out.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RpcError } from "@cophyla/protocol";
import type { RemoteConfig } from "../config/schema.ts";
import type { Logger } from "../log.ts";
import type { Sidecar, Sidecars } from "../sidecars/index.ts";
import { extractTarGz, extractZip } from "../update/archive.ts";
import { download } from "../update/download.ts";
import { defaultTar, hostOs } from "../update/platform.ts";
import { WEB_VERSION, webAssetFor } from "./manifest.ts";

/** The header the proxy sets and the sidecar trusts as the login. */
export const WEB_USER_HEADER = "x-cophyla-user";
export const WEB_USER = "cophyla";
export const WEB_PREFIX = "/remote";
export const WEB_RTC_PORTS = { min: 40000, max: 40010 } as const;

export interface WebHost {
  hostId: number;
  address: string;
  appId?: number;
}

export interface WebDeps {
  /** `<home>/data/sidecars/moonlight-web`. */
  root: string;
  sidecars: Sidecars;
  config: RemoteConfig;
  log: Logger;
  fetch?: typeof fetch;
  /** `<os>-<arch>`, the release's naming. */
  target?: string;
  tar?: string;
  /** This node's LAN addresses, the first one advertised as the WebRTC host candidate. */
  lanIps: () => string[];
  /** Has `node`'s host accept the PIN the sidecar chose, under `name`, for the client `via`. */
  pairOn: (node: string, p: { pin: string; name: string }, via: string) => Promise<void>;
  /** What the sidecar's pairing is called in a host's list: `<this node> web`. */
  viewerName: string;
  /** A command to run instead of the release binary, for tests: `[bun, fake.ts]`. */
  command?: string[];
  /** Where each step is reported while the release is fetched. */
  progress?: (step: string, fraction?: number) => void;
  /** The ICE servers the stream's WebRTC is given, as the direct connections keep them; the script beside it prints them. */
  iceServersFile?: string;
}

/** The script the sidecar runs for its ICE servers: the file's contents, or an empty list without it. */
export function iceScript(file: string, windows = process.platform === "win32"): { path: string; text: string } {
  if (windows) return { path: join(dirname(file), "ice-servers.cmd"), text: `@echo off\r\nif exist "${file}" (type "${file}") else (echo [])\r\n` };
  const quoted = `'${file.replace(/'/g, "'\\''")}'`;
  return { path: join(dirname(file), "ice-servers.sh"), text: `#!/bin/sh\ncat ${quoted} 2>/dev/null || echo '[]'\n` };
}

/** A public STUN server of the kind the sidecar seeds its config with: Google's. */
const SEEDED_STUN = /^stuns?:(stun\d*\.)?l\.google\.com(:\d+)?$/i;

/**
 * The sidecar's own config with the public STUN servers it seeded taken out (an entry every
 * URL of which is one), anything else in the list kept; undefined when there is nothing to
 * take out.
 */
export function withoutSeededStun(configText: string): string | undefined {
  let config: { webrtc?: { ice_servers?: unknown } };
  try {
    config = JSON.parse(configText) as typeof config;
  } catch {
    return undefined;
  }
  const servers = config.webrtc?.ice_servers;
  if (!Array.isArray(servers)) return undefined;
  const seeded = (s: unknown): boolean => {
    const urls = (s as { urls?: unknown } | null)?.urls;
    const list = Array.isArray(urls) ? urls : [urls];
    return list.length > 0 && list.every((u) => typeof u === "string" && SEEDED_STUN.test(u));
  };
  const kept = servers.filter((s) => !seeded(s));
  if (kept.length === servers.length) return undefined;
  config.webrtc!.ice_servers = kept;
  return JSON.stringify(config, null, 2);
}

const HEALTH = { path: `${WEB_PREFIX}/`, intervalMs: 5000, startIntervalMs: 200, timeoutMs: 3000, startTimeoutMs: 60_000 };
const RESTART = { backoffMs: 1000, maxMs: 30_000, max: 5 };

export class MoonlightWeb {
  private deps: WebDeps;
  private log: Logger;
  private sidecar?: Sidecar;
  private starting?: Promise<Sidecar>;
  private hosts: Record<string, WebHost>;

  constructor(deps: WebDeps) {
    this.deps = deps;
    this.log = deps.log;
    this.hosts = this.loadHosts();
  }

  private get target(): string {
    return this.deps.target ?? `${hostOs()}-${process.arch}`;
  }

  private get hostsFile(): string {
    return join(this.deps.root, "hosts.json");
  }

  private loadHosts(): Record<string, WebHost> {
    try {
      return JSON.parse(readFileSync(this.hostsFile, "utf8")) as Record<string, WebHost>;
    } catch {
      return {};
    }
  }

  private saveHosts(): void {
    mkdirSync(this.deps.root, { recursive: true });
    writeFileSync(this.hostsFile, JSON.stringify(this.hosts, null, 2));
  }

  /** The sidecar's own base, `http://127.0.0.1:<port>`, once it runs. */
  url(): string | undefined {
    return this.sidecar?.state().status === "ready" ? this.sidecar.url : undefined;
  }

  running(): boolean {
    return this.url() !== undefined;
  }

  /** The server to run: `[remote] web_server` when set, else the release on disk, fetched and unpacked when missing. */
  private async ensureRelease(): Promise<{ dir: string; exe: string }> {
    const own = this.deps.config.web_server;
    if (own) {
      if (!existsSync(own)) throw new RpcError("unavailable", `[remote] web_server names ${own}, and there is nothing there`);
      return { dir: dirname(own), exe: own };
    }
    const dir = join(this.deps.root, WEB_VERSION);
    const exe = join(dir, "package", process.platform === "win32" ? "web-server.exe" : "web-server");
    if (existsSync(exe)) return { dir: join(dir, "package"), exe };
    const asset = webAssetFor(this.target);
    if (!asset) throw new RpcError("unsupported", `moonlight-web publishes no build for ${this.target}: build it from source and set [remote] web_server to its web-server`);
    mkdirSync(dir, { recursive: true });
    const archive = join(this.deps.root, `${WEB_VERSION}.${asset.kind}`);
    this.deps.progress?.(`fetching moonlight-web ${WEB_VERSION}`, 0);
    this.log.info("fetching moonlight-web", { version: WEB_VERSION, url: asset.url });
    await download(asset.url, archive, {
      size: asset.size,
      sha256: asset.sha256,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      onProgress: (f) => this.deps.progress?.(`fetching moonlight-web ${WEB_VERSION}`, f),
    });
    this.deps.progress?.(`unpacking moonlight-web ${WEB_VERSION}`);
    const tar = this.deps.tar ?? defaultTar();
    rmSync(join(dir, "package"), { recursive: true, force: true });
    if (asset.kind === "zip") await extractZip(archive, dir, { tar });
    else await extractTarGz(archive, dir, { tar });
    rmSync(archive, { force: true });
    if (!existsSync(exe)) throw new Error(`moonlight-web ${WEB_VERSION} unpacked without ${exe}`);
    return { dir: join(dir, "package"), exe };
  }

  /** Starts the sidecar, or returns the one running; the release is fetched first when it is not here. */
  ensure(): Promise<Sidecar> {
    if (this.sidecar && this.sidecar.state().status === "ready") return Promise.resolve(this.sidecar);
    if (this.starting) return this.starting;
    this.starting = (async () => {
      let command: string;
      let prefix: string[] = [];
      let cwd: string;
      if (this.deps.command) {
        [command, ...prefix] = this.deps.command as [string, ...string[]];
        cwd = this.deps.root;
        mkdirSync(cwd, { recursive: true });
      } else {
        ({ dir: cwd, exe: command } = await this.ensureRelease());
      }
      const lan = this.deps.lanIps().filter((ip) => ip !== "127.0.0.1");
      const script = this.writeIceScript();
      this.stripSeededStun(cwd);
      // The options are the program's, not the subcommand's: they go before `run`.
      const args = [
        ...prefix,
        "--bind-address",
        "127.0.0.1:{port}",
        "--path-prefix",
        WEB_PREFIX,
        "--forwarded-header",
        WEB_USER_HEADER,
        "--webrtc-port-range",
        `${WEB_RTC_PORTS.min}:${WEB_RTC_PORTS.max}`,
        ...(lan[0] ? ["--webrtc-nat-1to1-host", lan[0]] : []),
        ...(script ? ["--webrtc-ice-server-script", script] : []),
        "run",
      ];
      this.deps.progress?.("starting moonlight-web");
      const sidecar = this.deps.sidecars.spawn({ name: "moonlight-web", command, args, cwd, health: HEALTH, restart: RESTART });
      this.sidecar = sidecar;
      try {
        await sidecar.start();
      } catch (e) {
        this.deps.sidecars.forget("moonlight-web");
        this.sidecar = undefined;
        throw e;
      }
      this.log.info("moonlight-web ready", { port: sidecar.port });
      return sidecar;
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** The ICE script beside the servers file, written afresh at every start; its path. */
  private writeIceScript(): string | undefined {
    const file = this.deps.iceServersFile;
    if (!file) return undefined;
    const { path, text } = iceScript(file);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      if (process.platform !== "win32") chmodSync(path, 0o755);
      return path;
    } catch (e) {
      this.log.warn("the ICE script could not be written; the stream's WebRTC keeps to the LAN", { error: e instanceof Error ? e.message : String(e) });
      return undefined;
    }
  }

  /** Takes the public STUN servers out of the config the sidecar seeded; from its next start. */
  private stripSeededStun(cwd: string): void {
    const file = join(cwd, "server", "config.json");
    try {
      if (!existsSync(file)) return;
      const next = withoutSeededStun(readFileSync(file, "utf8"));
      if (next !== undefined) writeFileSync(file, next);
    } catch {
      // the sidecar's own file: left as it is
    }
  }

  private async api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const base = this.url();
    if (!base) throw new RpcError("unavailable", "moonlight-web is not running");
    const doFetch = this.deps.fetch ?? fetch;
    const res = await doFetch(`${base}${WEB_PREFIX}/api${path}`, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers: { [WEB_USER_HEADER]: WEB_USER, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) throw new RpcError("unavailable", `moonlight-web ${path}: HTTP ${res.status} ${text.slice(0, 120)}`);
    // The list and pair endpoints answer newline-delimited JSON; the first line is what is asked for here.
    const first = text.split("\n").find((l) => l.trim());
    return (first ? JSON.parse(first) : {}) as T;
  }

  /** Streams `POST /api/pair`: the PIN line, then the outcome. */
  private async pair(node: string, hostId: number, via: string): Promise<void> {
    const base = this.url();
    if (!base) throw new RpcError("unavailable", "moonlight-web is not running");
    const doFetch = this.deps.fetch ?? fetch;
    const res = await doFetch(`${base}${WEB_PREFIX}/api/pair`, {
      method: "POST",
      headers: { [WEB_USER_HEADER]: WEB_USER, "content-type": "application/json" },
      body: JSON.stringify({ host_id: hostId }),
    });
    if (!res.ok || !res.body) throw new RpcError("unavailable", `moonlight-web pair: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let posted = false;
    let paired = false;
    const lines: string[] = [];
    const handle = async (line: string) => {
      const ev = JSON.parse(line) as Record<string, unknown>;
      lines.push(line);
      const pin = ev["Pin"] ?? ev["pin"];
      if (typeof pin === "string" && !posted) {
        posted = true;
        await this.deps.pairOn(node, { pin, name: this.deps.viewerName }, via);
        return;
      }
      if ("Paired" in ev || ev["paired"] === "Paired") paired = true;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line) await handle(line);
      }
      if (paired) break;
    }
    if (buffer.trim()) await handle(buffer.trim());
    if (!paired) throw new RpcError("unavailable", `moonlight-web did not pair with ${node}: ${lines.slice(-1)[0] ?? "no answer"}`);
  }

  /**
   * The sidecar's record of `node`'s host at `address`: added and paired on the first open,
   * checked and re-paired when the sidecar lost it. Returns the ids the stream page takes.
   */
  async ensureHost(node: string, address: string, via: string): Promise<{ hostId: number; appId: number }> {
    await this.ensure();
    let known = this.hosts[node];
    let hostRow: { host_id: number; paired?: string } | undefined;
    if (known && known.address === address) {
      try {
        const r = await this.api<{ host?: { host_id: number; paired?: string } }>(`/host?host_id=${known.hostId}`);
        hostRow = r.host;
      } catch {
        hostRow = undefined;
      }
    }
    if (!hostRow) {
      const added = await this.api<{ host?: { host_id: number; paired?: string } }>("/host", { body: { address, http_port: 47989 } });
      if (!added.host) throw new RpcError("unavailable", "moonlight-web did not add the host");
      hostRow = added.host;
      known = { hostId: hostRow.host_id, address };
      this.hosts[node] = known;
      this.saveHosts();
    }
    if (hostRow.paired !== "Paired") {
      await this.pair(node, hostRow.host_id, via);
      this.log.info("moonlight-web paired", { node, hostId: hostRow.host_id });
    }
    if (known!.appId === undefined) {
      const apps = await this.api<{ apps?: { app_id: number; title?: string }[] }>(`/apps?host_id=${hostRow.host_id}`);
      const desktop = (apps.apps ?? []).find((a) => a.title === "Desktop") ?? apps.apps?.[0];
      if (!desktop) throw new RpcError("unavailable", `${node}'s host lists no apps`);
      known!.appId = desktop.app_id;
      this.saveHosts();
    }
    return { hostId: known!.hostId, appId: known!.appId! };
  }

  /** Drops the sidecar's record of `node`, so the next open adds and pairs it again. */
  async forgetHost(node: string): Promise<void> {
    const known = this.hosts[node];
    if (!known) return;
    delete this.hosts[node];
    this.saveHosts();
    if (this.url()) await this.api(`/host?host_id=${known.hostId}`, { method: "DELETE" }).catch(() => undefined);
  }

  /** The path of the stream page for a host, under the proxy's prefix. */
  streamPath(ids: { hostId: number; appId: number }): string {
    return `${WEB_PREFIX}/stream.html?hostId=${ids.hostId}&appId=${ids.appId}`;
  }

  async stop(): Promise<void> {
    const s = this.sidecar;
    this.sidecar = undefined;
    if (s) {
      await s.stop();
      this.deps.sidecars.forget("moonlight-web");
    }
  }
}
