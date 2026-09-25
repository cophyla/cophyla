// Spike 14 shared bits: the host's API over loopback, credentials in out/, timing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OUT = join(import.meta.dir, "out");
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

export const HOST_API = process.env.HOST_API ?? "https://127.0.0.1:47990";
export const HOST_LAN = process.env.HOST_LAN ?? "192.168.1.44";
export const CREDS_FILE = join(OUT, "host-creds.json");

export type Creds = { username: string; password: string };

export function loadCreds(): Creds | undefined {
  if (!existsSync(CREDS_FILE)) return undefined;
  return JSON.parse(readFileSync(CREDS_FILE, "utf8")) as Creds;
}

export function saveCreds(c: Creds): void {
  writeFileSync(CREDS_FILE, JSON.stringify(c, null, 2));
}

export function basic(c: Creds): string {
  return "Basic " + Buffer.from(`${c.username}:${c.password}`).toString("base64");
}

// Apollo 0.4.6 takes no Basic auth: POST /api/login answers Set-Cookie auth=<64 chars>
// (Secure; SameSite=Strict; 30 days) and only that cookie opens /api/*. A second login
// replaces the token, so one session is held and renewed on a 401.
let session: string | undefined;
export async function login(c: Creds): Promise<string> {
  const res = await fetch(HOST_API + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: c.username, password: c.password }),
    // @ts-expect-error Bun extension
    tls: { rejectUnauthorized: false },
  });
  if (res.status !== 200) throw new Error("login failed: " + res.status);
  session = (res.headers.get("set-cookie") ?? "").split(";")[0];
  return session;
}

// Every call to the host: no Origin header (a foreign Origin makes Apollo reject even a
// valid cookie), the self-signed certificate accepted, the JSON parsed when there is any.
export async function api(
  path: string,
  init: { method?: string; body?: unknown; creds?: Creds; raw?: boolean; retried?: boolean } = {},
): Promise<{ status: number; json?: any; text: string; ms: number }> {
  const t0 = performance.now();
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.creds) headers.cookie = session ?? (await login(init.creds));
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(HOST_API + path, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    // @ts-expect-error Bun extension
    tls: { rejectUnauthorized: false },
  });
  if (res.status === 401 && init.creds && !init.retried) {
    session = undefined;
    return api(path, { ...init, retried: true });
  }
  const text = await res.text();
  let json: any;
  if (!init.raw) {
    try { json = JSON.parse(text); } catch { /* not json */ }
  }
  return { status: res.status, json, text, ms: Math.round(performance.now() - t0) };
}

export function log(label: string, r: { status: number; json?: any; text: string; ms: number }, max = 600): void {
  const body = r.json !== undefined ? JSON.stringify(r.json) : r.text.replace(/\s+/g, " ");
  console.log(`${label}: ${r.status} (${r.ms} ms) ${body.length > max ? body.slice(0, max) + "…" : body}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
