// The host's API over loopback: the shared surface of Sunshine and Apollo on
// `https://127.0.0.1:47990` (`/api/*`, self-signed, no `Origin` header, which would make
// Apollo refuse even a good cookie) and the unauthenticated `/serverinfo` on 47989.
// Apollo takes no Basic auth: `POST /api/login` answers one `auth` cookie, a second login
// replaces it, so one session is held and renewed on a 401; Sunshine takes Basic auth on
// every request. `POST /api/config` replaces the whole file and applies only after
// `/api/restart`, so `configure` merges and restarts only when something changed. Apollo has
// no pending-PIN list: `pin` posts blind until the host says yes. Every client Apollo pairs
// after the first gets view and list only, so `grantViewer` opens input, launch and the
// clipboard to it; Sunshine has no permissions to grant.

import type { Logger } from "../log.ts";
import type { HostKind } from "./install.ts";

export interface HostCredentials {
  username: string;
  password: string;
}

export interface HostClient {
  uuid: string;
  name: string;
  /** Apollo's permission bits; absent on Sunshine. */
  perm?: number;
  /** Streaming now; Apollo reports it, Sunshine does not. */
  connected?: boolean;
  /** The whole row, for `updateClient`, which overwrites every field it is not given. */
  raw: Record<string, unknown>;
}

export interface HostApp {
  name: string;
  uuid?: string;
}

export interface ServerInfo {
  hostname?: string;
  state?: string;
  uniqueId?: string;
}

export interface HostApiDeps {
  kind: HostKind;
  /** Sunshine's base port: `/serverinfo` is there over http, the API one above it over https. */
  port?: number;
  fetch?: typeof fetch;
  log: Logger;
  timeoutMs?: number;
}

/** What Apollo's `/api/pin` and `/api/clients/*` answer. */
interface Status {
  status?: boolean | string;
  error?: string;
}

/** Apollo's permission groups (`crypto.h` PERM): inputs, operations, actions. */
export const PERM = {
  inputs: 0x1f00,
  clipboard: 0x30000,
  actions: 0x7000000,
  all: 0x1f00 | 0x1f0000 | 0x7000000,
} as const;

/** What a viewer cophylad pairs may do: see, launch, drive, and share the clipboard; no files, no server commands. */
export const PERM_VIEWER: number = PERM.inputs | PERM.clipboard | PERM.actions;

export class HostApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "HostApiError";
    this.status = status;
  }
}

export class HostApi {
  readonly kind: HostKind;
  private readonly port: number;
  private readonly doFetch: typeof fetch;
  private readonly log: Logger;
  private readonly timeoutMs: number;
  private credentials?: HostCredentials;
  private cookie?: string;

  constructor(deps: HostApiDeps) {
    this.kind = deps.kind;
    this.port = deps.port ?? 47989;
    this.doFetch = deps.fetch ?? fetch;
    this.log = deps.log;
    this.timeoutMs = deps.timeoutMs ?? 10_000;
  }

  get apiBase(): string {
    return `https://127.0.0.1:${this.port + 1}`;
  }

  get infoUrl(): string {
    return `http://127.0.0.1:${this.port}/serverinfo`;
  }

  setCredentials(c: HostCredentials): void {
    this.credentials = c;
    this.cookie = undefined;
  }

  private request(url: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
    // Bun's fetch takes the TLS options beside the standard ones; the host's certificate is its own.
    const full: RequestInit & { tls?: { rejectUnauthorized: boolean } } = { ...init, signal: AbortSignal.timeout(this.timeoutMs), tls: { rejectUnauthorized: false } };
    return this.doFetch(url, full);
  }

  /** The unauthenticated probe: whether the host answers at all, and its name. */
  async serverInfo(): Promise<ServerInfo> {
    const res = await this.request(this.infoUrl);
    const text = await res.text();
    if (!res.ok) throw new HostApiError(`serverinfo: HTTP ${res.status}`, res.status);
    const pick = (tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(text)?.[1];
    const out: ServerInfo = {};
    const hostname = pick("hostname");
    const state = pick("state");
    const uniqueId = pick("uniqueid");
    if (hostname !== undefined) out.hostname = hostname;
    if (state !== undefined) out.state = state;
    if (uniqueId !== undefined) out.uniqueId = uniqueId;
    return out;
  }

  async alive(): Promise<boolean> {
    try {
      await this.serverInfo();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The welcome flow: sets the first credentials when the host has none. `true` when it
   * took them, `false` when credentials already exist (the host answers 401 or 404 then).
   */
  async welcome(c: HostCredentials): Promise<boolean> {
    const res = await this.request(`${this.apiBase}/api/password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newUsername: c.username, newPassword: c.password, confirmNewPassword: c.password }),
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403 || res.status === 404) return false;
    const json = parse(text) as Status | undefined;
    if (!res.ok || json?.status === false || json?.status === "false") {
      // Apollo answers the welcome page (200, HTML) to a host without credentials; anything else is a refusal.
      if (res.ok && json === undefined) return false;
      throw new HostApiError(`welcome refused: ${json?.error ?? text.slice(0, 200)}`, res.status);
    }
    this.setCredentials(c);
    return true;
  }

  private async login(): Promise<void> {
    const c = this.credentials;
    if (!c) throw new HostApiError("no credentials", 401);
    if (this.kind !== "apollo") return;
    const res = await this.request(`${this.apiBase}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: c.username, password: c.password }),
    });
    await res.body?.cancel().catch(() => {});
    if (res.status !== 200) throw new HostApiError(`login refused: HTTP ${res.status}`, res.status);
    const cookie = res.headers.get("set-cookie");
    if (!cookie) throw new HostApiError("login answered no cookie", 500);
    this.cookie = cookie.split(";")[0]!;
  }

  private authHeaders(): Record<string, string> {
    const c = this.credentials;
    if (!c) return {};
    if (this.kind === "apollo") return this.cookie ? { cookie: this.cookie } : {};
    return { authorization: "Basic " + Buffer.from(`${c.username}:${c.password}`).toString("base64") };
  }

  /** One authenticated call; a 401 logs in again once. */
  async call<T = unknown>(path: string, body?: unknown, retried = false): Promise<T> {
    if (this.kind === "apollo" && !this.cookie) await this.login();
    const res = await this.request(`${this.apiBase}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { accept: "application/json", ...this.authHeaders(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (res.status === 401 && !retried) {
      this.cookie = undefined;
      return this.call(path, body, true);
    }
    if (!res.ok) {
      const json = parse(text) as Status | undefined;
      throw new HostApiError(`${path}: ${json?.error ?? `HTTP ${res.status}`}`, res.status);
    }
    const json = parse(text);
    if (json === undefined) throw new HostApiError(`${path}: not JSON`, res.status);
    return json as T;
  }

  /** The config the host has set, without the status fields it adds. */
  async config(): Promise<Record<string, unknown>> {
    const raw = await this.call<Record<string, unknown>>("/api/config");
    const { platform: _p, version: _v, status: _s, vdisplayStatus: _d, ...rest } = raw;
    void _p;
    void _v;
    void _s;
    void _d;
    return rest;
  }

  /** Merges `patch` into the config and restarts the host when anything changed; `true` when it did. */
  async configure(patch: Record<string, unknown>): Promise<boolean> {
    const current = await this.config();
    const changed = Object.entries(patch).some(([k, v]) => String(current[k] ?? "") !== String(v));
    if (!changed) return false;
    await this.call("/api/config", { ...current, ...patch });
    await this.restart();
    return true;
  }

  /** Asks the host to restart; the socket drops mid-answer, which is the answer. */
  async restart(): Promise<void> {
    try {
      await this.call("/api/restart", {});
    } catch (e) {
      if (e instanceof HostApiError) throw e;
      // the connection reset as the process left
    }
    this.cookie = undefined;
  }

  /** Waits for `/serverinfo` to answer again, up to `timeoutMs`. */
  async waitAlive(timeoutMs = 30_000, stepMs = 500): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await this.alive()) return true;
      await Bun.sleep(stepMs);
    }
    return false;
  }

  async apps(): Promise<HostApp[]> {
    const r = await this.call<{ apps?: { name?: string; uuid?: string }[] }>("/api/apps");
    return (r.apps ?? []).flatMap((a) => (a.name ? [{ name: a.name, ...(a.uuid ? { uuid: a.uuid } : {}) }] : []));
  }

  /**
   * Accepts a viewer's PIN: posted every `intervalMs` until the host has a pairing session
   * for it, or `timeoutMs` passes. The client appears in the list under `name`.
   */
  async pin(pin: string, name: string, opts: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const intervalMs = opts.intervalMs ?? 500;
    const end = Date.now() + timeoutMs;
    let tries = 0;
    while (Date.now() < end) {
      if (opts.signal?.aborted) throw new HostApiError("pairing cancelled", 499);
      tries++;
      const r = await this.call<Status>("/api/pin", { pin, name });
      if (r.status === true || r.status === "true") {
        this.log.info("host accepted a pin", { name, tries });
        return;
      }
      await Bun.sleep(intervalMs);
    }
    throw new HostApiError(`the host saw no pairing request from ${name} within ${timeoutMs} ms`, 408);
  }

  /** Apollo's host-minted code for a phone; Sunshine has none. */
  async otp(passphrase: string, deviceName: string): Promise<{ otp: string; ip?: string; name?: string }> {
    if (this.kind !== "apollo") throw new HostApiError("this host mints no invite codes", 501);
    const r = await this.call<Status & { otp?: string; ip?: string; name?: string }>("/api/otp", { passphrase, deviceName });
    if (!r.otp) throw new HostApiError(`otp refused: ${r.error ?? "no code"}`, 400);
    return { otp: r.otp, ...(r.ip ? { ip: r.ip } : {}), ...(r.name ? { name: r.name } : {}) };
  }

  async clients(): Promise<HostClient[]> {
    const r = await this.call<{ named_certs?: Record<string, unknown>[] }>("/api/clients/list");
    return (r.named_certs ?? []).map((row) => {
      const out: HostClient = { uuid: String(row["uuid"] ?? ""), name: String(row["name"] ?? ""), raw: row };
      if (typeof row["perm"] === "number") out.perm = row["perm"];
      if (typeof row["connected"] === "boolean") out.connected = row["connected"];
      return out;
    });
  }

  /** The client the host lists under `name`, if any. */
  async clientNamed(name: string): Promise<HostClient | undefined> {
    return (await this.clients()).find((c) => c.name === name);
  }

  /** Rewrites one client's row with `patch`; the whole row goes, since the host clears what it is not given. */
  async updateClient(client: HostClient, patch: Record<string, unknown>): Promise<void> {
    if (this.kind !== "apollo") return;
    const r = await this.call<Status>("/api/clients/update", { ...client.raw, uuid: client.uuid, name: client.name, ...patch });
    if (r.status === false) throw new HostApiError(`update of ${client.name} refused`, 400);
  }

  /** Opens input, launch and the clipboard to a client Apollo paired with view and list only. */
  async grantViewer(client: HostClient): Promise<void> {
    if (this.kind !== "apollo") return;
    if (client.perm !== undefined && (client.perm & PERM_VIEWER) === PERM_VIEWER) return;
    await this.updateClient(client, { perm: (client.perm ?? 0) | PERM_VIEWER });
  }

  async unpair(uuid: string): Promise<void> {
    const r = await this.call<Status>("/api/clients/unpair", { uuid });
    if (r.status === false) throw new HostApiError(`unpair of ${uuid} refused`, 400);
  }

  /** Ends a client's stream without unpairing it; Apollo only. */
  async disconnect(uuid: string): Promise<void> {
    if (this.kind !== "apollo") return;
    await this.call<Status>("/api/clients/disconnect", { uuid });
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
