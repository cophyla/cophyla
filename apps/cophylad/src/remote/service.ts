// How the host runs. On Windows both Apollo and Sunshine install a service
// (`ApolloService`, `SunshineService`) that captures across the lock screen and UAC's
// secure desktop, so cophylad never spawns the binary there: it health-checks the API and,
// when the API is silent, reads the service's state for the reason. Elsewhere the host is
// a process cophylad owns through `Sidecars`, on Sunshine's fixed base port (47989; the API
// one above it), health-checked on its own TLS endpoint.

import { basename } from "node:path";
import type { Sidecar, SidecarSpec, Sidecars } from "../sidecars/index.ts";
import type { Exec } from "../sidecars/tts-py.ts";
import type { HostOs } from "../update/platform.ts";
import type { HostKind, Located } from "./install.ts";

export const SERVICE_NAMES: Record<HostKind, string> = { apollo: "ApolloService", sunshine: "SunshineService" };

/** Sunshine's base port: `/serverinfo` and pairing; the API is on the next one. */
export const HOST_PORT = 47989;

export type ServiceState = "running" | "stopped" | "starting" | "absent" | "unknown";

/** The Windows service's state through `sc query`, without a shell. */
export async function windowsServiceState(kind: HostKind, exec: Exec): Promise<{ state: ServiceState; detail: string }> {
  const name = SERVICE_NAMES[kind];
  const r = await exec(["sc", "query", name], {});
  const text = `${r.stdout}\n${r.stderr}`;
  if (r.code !== 0) {
    if (/1060|does not exist/i.test(text)) return { state: "absent", detail: `service ${name} is not installed` };
    return { state: "unknown", detail: `sc query ${name} exited ${r.code}` };
  }
  const m = /STATE\s*:\s*\d+\s+([A-Z_]+)/.exec(text);
  const word = m?.[1] ?? "";
  if (word === "RUNNING") return { state: "running", detail: `service ${name} is running` };
  if (word === "START_PENDING") return { state: "starting", detail: `service ${name} is starting` };
  if (word === "STOPPED" || word === "STOP_PENDING") return { state: "stopped", detail: `service ${name} is stopped` };
  return { state: "unknown", detail: `service ${name}: ${word || "no state"}` };
}

/** Asks the service manager to start the service; needs an elevated daemon, so a refusal is reported, not retried. */
export async function windowsServiceStart(kind: HostKind, exec: Exec): Promise<{ ok: boolean; detail: string }> {
  const name = SERVICE_NAMES[kind];
  const r = await exec(["sc", "start", name], {});
  if (r.code === 0) return { ok: true, detail: `service ${name} started` };
  const text = `${r.stdout} ${r.stderr}`.replace(/\s+/g, " ").trim();
  if (/1056|already running/i.test(text)) return { ok: true, detail: `service ${name} is running` };
  if (/5|Access is denied/i.test(text)) return { ok: false, detail: `service ${name} is stopped and starting it needs an administrator` };
  return { ok: false, detail: `sc start ${name} exited ${r.code}: ${text.slice(0, 160)}` };
}

/** The spec the host runs under on macOS and Linux: its own binary, the fixed port, its own TLS health endpoint. */
export function hostSidecarSpec(host: Located, os: HostOs): SidecarSpec {
  void os;
  return {
    name: "remote-host",
    command: host.path,
    // Sunshine and Apollo take any config key as `name=value` on the command line.
    args: [`port=${HOST_PORT}`, "origin_web_ui_allowed=pc"],
    port: HOST_PORT,
    health: { path: "/", url: `https://127.0.0.1:${HOST_PORT + 1}/`, insecure: true, intervalMs: 5000, startIntervalMs: 500, timeoutMs: 3000, startTimeoutMs: 60_000 },
    restart: { backoffMs: 1000, maxMs: 30_000, max: 5 },
  };
}

/** Spawns the host through the sidecars module, or returns the one already running. */
export function spawnHost(sidecars: Sidecars, host: Located, os: HostOs): Sidecar {
  return sidecars.spawn(hostSidecarSpec(host, os));
}

/** A short name for the log and the state: `sunshine.exe` under Apollo's tree is "apollo". */
export function hostLabel(host: Located): string {
  return `${host.kind} (${basename(host.path)})`;
}
