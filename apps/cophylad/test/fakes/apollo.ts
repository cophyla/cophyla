// A stand-in for Apollo (or Sunshine) on two loopback ports: `/serverinfo` over http on the
// base port and the API over https one above it, the way the real host is laid out. It
// keeps what spike 14 found: the welcome flow before any credentials, a login cookie that a
// second login replaces (Basic auth on the Sunshine kind), `POST /api/config` replacing the
// whole config and `/api/restart` making it live, `/api/pin` answering false until a pairing
// session is pending, a fresh client paired with view and list only, `/api/clients/update`
// overwriting what it is not given, and `/api/otp`. The test injects pairing sessions and
// reads what the host recorded.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCertificate } from "../../src/api/tls.ts";
import { freePort } from "../../src/sidecars/index.ts";

export interface FakeClient {
  uuid: string;
  name: string;
  perm: number;
  connected: boolean;
  allow_client_commands: boolean;
  always_use_virtual_display: boolean;
  display_mode: string;
  enable_legacy_ordering: boolean;
}

export interface FakeApollo {
  kind: "apollo" | "sunshine";
  /** The base port: `/serverinfo`; the API is one above it. */
  port: number;
  credentials?: { username: string; password: string };
  config: Record<string, string>;
  /** What the running process has applied; differs from `config` until `/api/restart`. */
  live: Record<string, string>;
  clients: FakeClient[];
  /** PINs a viewer is waiting with; `POST /api/pin` with one of them pairs a client under the posted name. */
  pending: Set<string>;
  pins: { pin: string; name: string; ok: boolean }[];
  otps: { passphrase: string; deviceName: string; otp: string }[];
  restarts: number;
  logins: number;
  /** Every PIN is pending, as if each viewer had asked just before: for tests that pair through a sidecar the fake cannot see. */
  acceptAny: boolean;
  /** How long after taking a PIN the new client is listed: the real host lists it once the viewer has finished its half. */
  listDelayMs: number;
  /** The process is not running: every request answers 503, as a stopped service would refuse. */
  down: boolean;
  /** Every request path the host saw. */
  requests: string[];
  /** Makes a pairing session, as a moonlight client would; the next matching PIN pairs `name` (or the posted name). */
  expectPin(pin: string): void;
  /** A client that streams now. */
  connect(uuid: string, on?: boolean): void;
  stop(): Promise<void>;
}

const DEFAULT_PERM = 50331648;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export async function startFakeApollo(opts: { kind?: "apollo" | "sunshine"; credentials?: { username: string; password: string } } = {}): Promise<FakeApollo> {
  const kind = opts.kind ?? "apollo";
  const dir = mkdtempSync(join(tmpdir(), "cophyla-fake-apollo-"));
  const cert = ensureCertificate(dir, { dnsNames: ["localhost"], ips: ["127.0.0.1"] });
  let port = freePort();
  // Two consecutive ports; try until both are free.
  for (let i = 0; i < 20; i++) {
    try {
      const probe = Bun.listen({ hostname: "127.0.0.1", port: port + 1, socket: { data() {} } });
      probe.stop(true);
      break;
    } catch {
      port = freePort();
    }
  }
  const state: FakeApollo = {
    kind,
    port,
    ...(opts.credentials ? { credentials: opts.credentials } : {}),
    config: {},
    live: {},
    clients: [],
    pending: new Set(),
    pins: [],
    otps: [],
    restarts: 0,
    logins: 0,
    down: false,
    acceptAny: false,
    listDelayMs: 0,
    requests: [],
    expectPin: (pin) => state.pending.add(pin),
    connect: (uuid, on = true) => {
      const c = state.clients.find((x) => x.uuid === uuid);
      if (c) c.connected = on;
    },
    stop: async () => {
      // Bun 1.3.14 on Windows: `stop(true)` may never settle once a socket was served; the listener is released at once.
      await Promise.race([Promise.all([info.stop(true), api.stop(true)]), Bun.sleep(200)]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
  let cookie: string | undefined;
  let nextUuid = 1;

  const authed = (req: Request): boolean => {
    if (!state.credentials) return false;
    if (kind === "sunshine") {
      const expected = "Basic " + Buffer.from(`${state.credentials.username}:${state.credentials.password}`).toString("base64");
      return req.headers.get("authorization") === expected;
    }
    if (req.headers.get("origin")) return false;
    const raw = req.headers.get("cookie") ?? "";
    return cookie !== undefined && raw.includes(`auth=${cookie}`);
  };

  const info = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const url = new URL(req.url);
      state.requests.push(`info ${url.pathname}`);
      if (state.down) return new Response("down", { status: 503 });
      if (url.pathname !== "/serverinfo") return new Response("not found", { status: 404 });
      const name = state.live["sunshine_name"] ?? "FAKE-HOST";
      const busy = kind === "sunshine" && state.clients.some((c) => c.connected);
      return new Response(`<?xml version="1.0" encoding="utf-8"?><root status_code="200"><hostname>${name}</hostname><uniqueid>0E6E0635-FAKE</uniqueid><PairStatus>0</PairStatus><state>${busy ? "SUNSHINE_SERVER_BUSY" : "SUNSHINE_SERVER_FREE"}</state></root>`, { headers: { "content-type": "text/xml" } });
    },
  });

  const api = Bun.serve({
    hostname: "127.0.0.1",
    port: port + 1,
    tls: { key: cert.keyPem, cert: cert.certPem },
    async fetch(req) {
      const url = new URL(req.url);
      state.requests.push(`${req.method} ${url.pathname}`);
      if (state.down) return new Response("down", { status: 503 });
      const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
      if (url.pathname === "/api/password" && !state.credentials) {
        const u = body["newUsername"];
        const p = body["newPassword"];
        if (typeof u !== "string" || typeof p !== "string" || p !== body["confirmNewPassword"]) return json({ status: false, error: "bad credentials" }, 400);
        state.credentials = { username: u, password: p };
        return json({ status: true });
      }
      if (!state.credentials) return new Response("<!DOCTYPE html><title>Welcome to Apollo</title>", { headers: { "content-type": "text/html" } });
      if (url.pathname === "/api/login" && kind === "apollo") {
        state.logins++;
        if (body["username"] !== state.credentials.username || body["password"] !== state.credentials.password) return json({ status: false }, 401);
        cookie = Bun.hash(String(state.logins) + Math.random()).toString(16).padStart(16, "0").repeat(4);
        return json({ status: true }, 200, { "set-cookie": `auth=${cookie}; Secure; SameSite=Strict; Max-Age=2592000; Path=/` });
      }
      if (!authed(req)) return json({ error: "Unauthorized", status: false, status_code: 401 }, 401);
      switch (url.pathname) {
        case "/api/config":
          if (req.method === "POST") {
            state.config = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)]));
            return json({ status: true });
          }
          return json({ ...state.config, platform: "windows", version: "0.4.6", status: true, vdisplayStatus: 0 });
        case "/api/restart":
          state.restarts++;
          state.live = { ...state.config };
          cookie = undefined;
          return json({ status: true });
        case "/api/apps":
          return json({ apps: [{ name: "Desktop", uuid: "90364DA8-F24F-192C-8C9A-C6970D31FA91" }, { name: "Steam Big Picture", uuid: "FDAFB9D0" }], status: true });
        case "/api/pin": {
          const pin = String(body["pin"] ?? "");
          const name = String(body["name"] ?? "");
          const ok = state.acceptAny || state.pending.has(pin);
          state.pins.push({ pin, name, ok });
          if (!ok) return json({ status: false });
          state.pending.delete(pin);
          const first = state.clients.length === 0;
          const client = { uuid: `UUID-${nextUuid++}`, name, perm: first ? 119480064 : DEFAULT_PERM, connected: false, allow_client_commands: true, always_use_virtual_display: false, display_mode: "", enable_legacy_ordering: true };
          if (state.listDelayMs > 0) setTimeout(() => state.clients.push(client), state.listDelayMs);
          else state.clients.push(client);
          return json({ status: true });
        }
        case "/api/otp": {
          if (kind !== "apollo") return json({ error: "Not Found", status_code: 404 }, 404);
          const passphrase = String(body["passphrase"] ?? "");
          if (passphrase.length < 4) return json({ error: "Passphrase too short!", status: false, status_code: 400 }, 400);
          const otp = String(1000 + state.otps.length);
          state.otps.push({ passphrase, deviceName: String(body["deviceName"] ?? ""), otp });
          return json({ ip: "192.168.1.44", message: "OTP created, effective within 3 minutes.", name: state.live["sunshine_name"] ?? "FAKE-HOST", otp, status: true });
        }
        case "/api/clients/list":
          return json({ named_certs: state.clients.map((c) => (kind === "apollo" ? { ...c } : { uuid: c.uuid, name: c.name })), platform: "windows", status: true });
        case "/api/clients/update": {
          if (kind !== "apollo") return json({ error: "Not Found", status_code: 404 }, 404);
          const c = state.clients.find((x) => x.uuid === body["uuid"]);
          if (!c) return json({ status: false });
          c.name = String(body["name"] ?? "");
          c.perm = typeof body["perm"] === "number" ? body["perm"] : 0;
          return json({ status: true });
        }
        case "/api/clients/unpair": {
          const before = state.clients.length;
          state.clients = state.clients.filter((x) => x.uuid !== body["uuid"]);
          return json({ status: state.clients.length < before });
        }
        case "/api/clients/disconnect": {
          const c = state.clients.find((x) => x.uuid === body["uuid"]);
          if (c) c.connected = false;
          return json({ status: c !== undefined });
        }
        default:
          return json({ error: "Not Found", status_code: 404 }, 404);
      }
    },
  });
  return state;
}
