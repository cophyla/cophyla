// Shared test helpers: a temporary home, a daemon on a free port, a tiny JSON-RPC client.

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, request, RpcMessage } from "@cophyla/protocol";
import type { RpcFailure, RpcNotification, RpcSuccess } from "@cophyla/protocol";
import { Bus } from "../src/bus.ts";
import { ensureDirs, loadConfig, paths } from "../src/config/load.ts";
import type { Config } from "../src/config/schema.ts";
import { startDaemon } from "../src/daemon.ts";
import type { Daemon, DaemonOptions } from "../src/daemon.ts";
import { Asks } from "../src/gate/asks.ts";
import { silentLogger } from "../src/log.ts";
import type { Logger } from "../src/log.ts";
import { UnsupportedRaiser } from "../src/sessions/focus.ts";
import type { WindowRaiser } from "../src/sessions/focus.ts";
import { Sessions } from "../src/sessions/index.ts";
import type { SessionOwners, SessionsDeps } from "../src/sessions/index.ts";
import type { HarnessAdapter, SessionHost } from "../src/sessions/model.ts";
import { Profiles } from "../src/sessions/profiles.ts";
import { Store } from "../src/store/index.ts";
import { Workspaces } from "../src/workspaces/index.ts";
import type { ProtectedFolders } from "../src/sessions/protected.ts";

/** A path as a TOML basic string value. */
export const tomlString = (s: string): string => JSON.stringify(s);

/** The fake `codex app-server` used by the Codex tests, run by the daemon's own runtime. */
export const FAKE_CODEX = join(import.meta.dir, "fakes", "codex-app-server.ts");

export interface Mini {
  home: string;
  config: Config;
  store: Store;
  bus: Bus;
  asks: Asks;
  profiles: Profiles;
  workspaces: Workspaces;
  sessions: Sessions;
  stop(): Promise<void>;
}

/** `Sessions` with its store, asks and profiles and no api: the unit under the adapter tests. */
export async function miniSessions(
  configToml: string,
  adapters: (host: SessionHost, log: Logger, asks: Asks) => HarnessAdapter[],
  opts: { raiser?: WindowRaiser; port?: number; log?: Logger; acp?: (config: Config) => { config: Config["acp"]; env: Record<string, string | undefined> }; deps?: Partial<SessionsDeps>; storePath?: string; owners?: SessionOwners; guard?: ProtectedFolders } = {},
): Promise<Mini> {
  const home = tempHome(configToml);
  const p = paths(home);
  ensureDirs(p);
  mkdirSync(p.data, { recursive: true });
  const config = loadConfig(p);
  const log = opts.log ?? silentLogger;
  // A store file outside the home outlives `stop`, so a second instance can start over it.
  const store = new Store(opts.storePath ?? ":memory:");
  store.migrate();
  const nodeId = newId("node");
  const bus = new Bus();
  const owners = opts.owners;
  const asks = new Asks(store, nodeId, bus, owners ? { isPrivate: (n) => owners.isPrivate(n) } : {});
  // never the machine's own Keychain: a Mac signed in to Claude would count every profile
  const profiles = new Profiles({ store, nodeId, config, log, keychainHas: () => false });
  const workspaces = new Workspaces({ store, nodeId, bus, ...(owners ? { owners } : {}), ...(opts.guard ? { guard: opts.guard } : {}) });
  const sessions = new Sessions({
    store,
    bus,
    asks,
    config: config.sessions,
    nodeId,
    log,
    profiles,
    workspaces,
    adapters: (host) => adapters(host, log, asks),
    raiser: opts.raiser ?? new UnsupportedRaiser(),
    hookToken: "hook-token",
    dataDir: p.data,
    ...(opts.acp ? { acp: opts.acp(config) } : {}),
    ...(owners ? { owners } : {}),
    ...opts.deps,
  });
  if (owners) {
    bus.partitions = { isPrivate: (n) => owners.isPrivate(n), sessionNode: (id) => sessions.getAny(id)?.node };
    asks.sessionNode = (id) => sessions.getAny(id)?.node;
  }
  await sessions.start({ port: opts.port ?? 0 });
  return {
    home,
    config,
    store,
    bus,
    asks,
    profiles,
    workspaces,
    sessions,
    stop: async () => {
      await sessions.stop();
      workspaces.dispose();
      asks.dispose();
      store.close();
      removeHome(home);
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until `check` returns a value, or fails after `timeoutMs`; an async check is awaited. */
export async function waitFor<T>(check: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 3000, stepMs = 25): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(stepMs);
  }
}

/**
 * A test home never scans the real `~/.claude` or `~/.codex`, never installs hooks anywhere,
 * never reads the public release feed and never broadcasts on the LAN: the `[sessions]`,
 * `[update]` and `[nodes]` defaults are overridden unless the test writes the section itself.
 */
export const SAFE_SESSIONS = "[sessions]\ndiscover = false\ninstall_hooks = false\n\n";
export const SAFE_UPDATE = "[update]\nenabled = false\n\n";
export const SAFE_NODES = "[nodes]\ndiscovery = false\n\n";

/**
 * A temporary home with a config. The path is the real one (macOS's `/var/folders` is a
 * symlink to `/private/var`, and the workspaces module realpaths what it stores), so a test
 * can compare paths byte for byte.
 */
export function tempHome(configToml = ""): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cophyla-test-")));
  let toml = /^\s*\[sessions\]/m.test(configToml) ? configToml : SAFE_SESSIONS + configToml;
  if (!/^\s*\[update\]/m.test(toml)) toml = SAFE_UPDATE + toml;
  if (!/^\s*\[nodes\]/m.test(toml)) toml = SAFE_NODES + toml;
  writeFileSync(join(home, "config.toml"), toml, "utf8");
  return home;
}

export function removeHome(home: string): void {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Windows may hold the SQLite file for a moment; the temp directory is disposable.
  }
}

/**
 * A messaging socket path a test can host: a named pipe on Windows, a Unix socket under
 * `/tmp` elsewhere (short, under macOS's 104-byte `sun_path` limit; the temp home is not).
 */
export function testSocketPath(tag: string): string {
  const id = randomBytes(4).toString("hex");
  return process.platform === "win32" ? `\\\\.\\pipe\\LOCAL\\cophyla-${tag}-${id}` : `/tmp/cophyla-${tag}-${id}.sock`;
}

/** Removes a Unix socket file a test hosted; a no-op for a named pipe. */
export function removeSocket(path: string): void {
  if (process.platform === "win32") return;
  rmSync(path, { force: true });
}

/**
 * A daemon on a temporary home and a free port. The brain runs only when the config has a
 * `[brain]` section (a test names the fake it wants), so the other suites never spawn one;
 * recall is full-text only unless the test passes an embedder.
 */
export async function testDaemon(configToml = "", opts: Partial<DaemonOptions> = {}): Promise<Daemon & { home: string }> {
  const home = tempHome(configToml);
  const brain = /^\s*\[brain\]/m.test(configToml);
  const daemon = await startDaemon({ home, port: 0, log: silentLogger, brain, embedder: null, ...opts });
  return Object.assign(daemon, { home });
}

export async function stopDaemon(d: Daemon & { home: string }): Promise<void> {
  await d.stop();
  removeHome(d.home);
}

type Pending = { resolve: (r: RpcSuccess | RpcFailure) => void };

/** A minimal JSON-RPC client over WebSocket that records every notification it receives. */
export class TestClient {
  readonly notifications: RpcNotification[] = [];
  /** Hears every notification as it comes, beside the list. */
  onNotification?: (n: RpcNotification) => void;
  private ws: WebSocket;
  private pending = new Map<string | number, Pending>();
  private seq = 0;
  private waiters: { predicate: (n: RpcNotification) => boolean; resolve: (n: RpcNotification) => void }[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => {
      ws.addEventListener("close", (ev) => resolve({ code: ev.code, reason: ev.reason }));
    });
    ws.addEventListener("message", (ev) => {
      const msg = RpcMessage.parse(JSON.parse(String(ev.data)));
      if ("method" in msg && !("id" in msg)) {
        this.notifications.push(msg);
        this.onNotification?.(msg);
        const idx = this.waiters.findIndex((w) => w.predicate(msg));
        if (idx >= 0) {
          const [w] = this.waiters.splice(idx, 1);
          w!.resolve(msg);
        }
        return;
      }
      if (!("method" in msg) && msg.id !== null) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg);
        }
      }
    });
  }

  /**
   * `insecure` accepts the node's self-signed certificate, as a phone does after the warning;
   * `headers` are sent with the upgrade (an `Origin`, as a page in a browser sends one).
   */
  static connect(url: string, opts: { insecure?: boolean; headers?: Record<string, string> } = {}): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const init = { ...(opts.insecure ? { tls: { rejectUnauthorized: false } } : {}), ...(opts.headers ? { headers: opts.headers } : {}) };
      const ws = opts.insecure || opts.headers ? new WebSocket(url, init as never) : new WebSocket(url);
      ws.addEventListener("open", () => resolve(new TestClient(ws)));
      ws.addEventListener("error", (e) => reject(e));
    });
  }

  /** Sends a signal: a notification with no id and no response. */
  signal(method: string, params?: unknown): void {
    this.ws.send(JSON.stringify(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params }));
  }

  /** Sends a request and returns the raw response. */
  call(method: string, params?: unknown): Promise<RpcSuccess | RpcFailure> {
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.ws.send(JSON.stringify(request(id, method, params)));
    });
  }

  /** Sends a request and returns its result, or throws the protocol error. */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const r = await this.call(method, params);
    if ("error" in r) throw Object.assign(new Error(r.error.message), { rpc: r.error });
    return r.result as T;
  }

  sendRaw(text: string): void {
    this.ws.send(text);
  }

  hello(token: string, extra: Record<string, unknown> = {}): Promise<RpcSuccess | RpcFailure> {
    return this.call("hello", { token, kind: "ui", audio: { in: false, out: false }, ...extra });
  }

  /** Resolves with the first notification (already received or next) matching the predicate. */
  next(predicate: (n: RpcNotification) => boolean, timeoutMs = 5000): Promise<RpcNotification> {
    const found = this.notifications.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a notification")), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (n) => {
          clearTimeout(timer);
          resolve(n);
        },
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

export const isMethod = (method: string, where?: (params: unknown) => boolean) => (n: RpcNotification) =>
  n.method === method && (where ? where(n.params) : true);

/** Every frame the fake brain logged, as `{dir, frame}`. */
export const brainFrames = (log: string): { dir: string; frame: Record<string, unknown> }[] =>
  readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** Audio as it rides the wire: base64 of the little-endian int16 samples. */
export const audioChunk = (pcm: Int16Array): string => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");

/** Sends `pcm` as `voice.audio` signals, `frame` samples at a time. */
export function sendAudio(client: TestClient, frames: Int16Array[]): void {
  for (const pcm of frames) client.signal("voice.audio", { chunk: audioChunk(pcm) });
}

/** A Claude Code session registry entry and its key file, as a test writes them. */
export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  procStart?: string;
  keyProcStart?: string;
  status?: "idle" | "busy" | "shell" | "waiting";
  waitingFor?: string;
  /** `interactive` by default; `bg` for a background job's process. */
  kind?: "interactive" | "bg";
  jobId?: string;
  parkedJobId?: string;
  spare?: boolean;
  /** When the session started; one fixed time by default. */
  startedAt?: number;
  statusUpdatedAt?: number;
  name?: string;
  pipe?: string;
  token?: string;
  /**
   * `windows` (verified): `procStart` in the entry, `procStartFt` in the key, decimal FILETIME strings.
   * `posix` (the shape a Unix Claude is expected to write until the Mac visit records it):
   * a numeric `procStart` in both, a Unix socket path.
   */
  keyShape?: "windows" | "posix";
}

export function writeRegistry(dir: string, e: RegistryEntry): void {
  mkdirSync(dir, { recursive: true });
  const posix = e.keyShape === "posix";
  const procStart = e.procStart ?? (posix ? "1789657503" : "134341311020543343");
  const start = (s: string) => (posix ? Number(s) : s);
  writeFileSync(
    join(dir, `${e.pid}.json`),
    JSON.stringify({
      pid: e.pid,
      sessionId: e.sessionId,
      cwd: e.cwd,
      startedAt: e.startedAt ?? 1789657503164,
      procStart: start(procStart),
      version: "2.1.276",
      kind: e.kind ?? "interactive",
      ...(e.jobId !== undefined ? { jobId: e.jobId } : {}),
      ...(e.parkedJobId !== undefined ? { parkedJobId: e.parkedJobId } : {}),
      ...(e.spare ? { spare: true } : {}),
      entrypoint: "cli",
      messagingSocketPath: e.pipe ?? (posix ? `/tmp/cc-msg-${e.pid}.sock` : `\\\\.\\pipe\\LOCAL\\cc-msg-${e.pid}`),
      name: e.name ?? "auto-name",
      nameSource: "auto",
      status: e.status ?? "idle",
      ...(e.waitingFor !== undefined ? { waitingFor: e.waitingFor } : {}),
      updatedAt: 1789733407531,
      ...(e.statusUpdatedAt !== undefined ? { statusUpdatedAt: e.statusUpdatedAt } : {}),
    }),
  );
  const keyStart = e.keyProcStart ?? procStart;
  writeFileSync(
    join(dir, `${e.pid}.${"ab".repeat(32)}.key`),
    JSON.stringify(posix ? { peerToken: e.token ?? `tok-${e.pid}`, procStart: start(keyStart) } : { peerToken: e.token ?? `tok-${e.pid}`, procStartFt: keyStart }),
  );
}

export function clearRegistry(dir: string, pid: number): void {
  for (const f of [`${pid}.json`, `${pid}.${"ab".repeat(32)}.key`]) rmSync(join(dir, f), { force: true });
}
