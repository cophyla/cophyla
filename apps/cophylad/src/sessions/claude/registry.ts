// Claude Code's session registry: `<configDir>/sessions/<pid>.json` for every live session
// and a sibling `<pid>.<64 hex>.key` holding the peer token. Stale key files outlive
// sessions, so an entry counts only when the key's process start time matches the
// registry's and the pid is alive. The start time is `procStart` in the entry and
// `procStartFt` in the key on Windows (a FILETIME as a decimal string); the POSIX shape is
// read tolerantly (`procStart` or `startTime`, string or number, either side may lack it)
// until the Mac visit records it, and a key is dropped only when both sides carry a start
// and they differ.
//
// Not every entry is a session. Claude Code runs a conversation sent to the background as a job
// under a daemon of its own: the job's process is an entry of `kind: "bg"` with its `jobId`, and
// the daemon keeps a pre-warmed process waiting for the next job, marked `spare`, which is no
// conversation yet. A window that sent its conversation away and shows the agents screen instead
// keeps its entry, marked `parkedJobId`: the conversation is the job's now. `claude agents` and
// `claude attach` write no entry at all. These are the rules `claude agents` lists sessions by.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionWaiting } from "@cophyla/protocol";

/** What the registry says a process is doing: `shell` is a turn over with background shells still running, `waiting` a dialog open. */
export type ClaudeRegistryStatus = "idle" | "busy" | "shell" | "waiting";

export interface ClaudeLive {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  /** The process start time as the registry wrote it; absent when the platform's registry carries none. */
  procStart?: string;
  name?: string;
  nameSource?: string;
  status: ClaudeRegistryStatus;
  /** With `waiting`: what the dialog is (`dialog open`, `permission prompt`, …). */
  waitingFor?: string;
  /** `interactive` for a window's process, `bg` for a job's; absent in older versions. */
  kind?: string;
  /** A job's id under the harness's daemon. */
  jobId?: string;
  /** A window showing the agents screen: its conversation went on as this job. */
  parkedJobId?: string;
  /** A pre-warmed process waiting to become the next job: no conversation yet. */
  spare?: boolean;
  updatedAt?: number;
  statusUpdatedAt?: number;
  version?: string;
  messagingSocketPath: string;
  peerToken: string;
}

export type IsAlive = (pid: number) => boolean;

/** `process.kill(pid, 0)` works under Bun on Windows: it throws ESRCH for a dead pid. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const STATUSES: readonly string[] = ["idle", "busy", "shell", "waiting"];

const ENTRY = /^(\d+)\.json$/;
const KEY = /^(\d+)\.[0-9a-f]{64}\.key$/;

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The process start time a registry entry or key carries, under whichever name and type, as a string. */
function startValue(doc: Record<string, unknown>): string | undefined {
  for (const field of ["procStartFt", "procStart", "startTime"]) {
    const v = doc[field];
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

/** Every live session in one registry directory. A missing directory is an empty one. */
export function readRegistry(dir: string, alive: IsAlive = isAlive): ClaudeLive[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const keys = new Map<number, string[]>();
  for (const n of names) {
    const m = KEY.exec(n);
    if (!m) continue;
    const pid = Number(m[1]);
    const list = keys.get(pid) ?? [];
    list.push(n);
    keys.set(pid, list);
  }

  const out: ClaudeLive[] = [];
  for (const n of names) {
    const m = ENTRY.exec(n);
    if (!m) continue;
    const entry = readJson(join(dir, n));
    if (!entry) continue;
    const pid = Number(entry["pid"] ?? m[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const sessionId = entry["sessionId"];
    const cwd = entry["cwd"];
    const socket = entry["messagingSocketPath"];
    const procStart = startValue(entry);
    if (typeof sessionId !== "string" || typeof cwd !== "string" || typeof socket !== "string") continue;
    if (!alive(pid)) continue;

    let token: string | undefined;
    for (const keyName of keys.get(pid) ?? []) {
      const key = readJson(join(dir, keyName));
      if (!key) continue;
      const keyStart = startValue(key);
      if (procStart !== undefined && keyStart !== undefined && keyStart !== procStart) continue;
      if (typeof key["peerToken"] === "string") {
        token = key["peerToken"];
        break;
      }
    }
    if (!token) continue;

    const live: ClaudeLive = {
      pid,
      sessionId,
      cwd,
      startedAt: typeof entry["startedAt"] === "number" ? entry["startedAt"] : Date.now(),
      status: STATUSES.includes(entry["status"] as string) ? (entry["status"] as ClaudeRegistryStatus) : "idle",
      messagingSocketPath: socket,
      peerToken: token,
    };
    if (procStart !== undefined) live.procStart = procStart;
    if (typeof entry["name"] === "string") live.name = entry["name"];
    if (typeof entry["nameSource"] === "string") live.nameSource = entry["nameSource"];
    if (typeof entry["updatedAt"] === "number") live.updatedAt = entry["updatedAt"];
    if (typeof entry["statusUpdatedAt"] === "number") live.statusUpdatedAt = entry["statusUpdatedAt"];
    if (typeof entry["version"] === "string") live.version = entry["version"];
    if (typeof entry["waitingFor"] === "string") live.waitingFor = entry["waitingFor"];
    if (typeof entry["kind"] === "string") live.kind = entry["kind"];
    if (typeof entry["jobId"] === "string" && entry["jobId"] !== "") live.jobId = entry["jobId"];
    if (typeof entry["parkedJobId"] === "string" && entry["parkedJobId"] !== "") live.parkedJobId = entry["parkedJobId"];
    if (entry["spare"] === true) live.spare = true;
    out.push(live);
  }
  return out;
}

/** One process's entry as it stands, for its status: no key check, which the full read does. */
export function readEntry(dir: string, pid: number): Pick<ClaudeLive, "sessionId" | "status" | "waitingFor"> | undefined {
  const entry = readJson(join(dir, `${pid}.json`));
  if (!entry || typeof entry["sessionId"] !== "string") return undefined;
  const status = STATUSES.includes(entry["status"] as string) ? (entry["status"] as ClaudeRegistryStatus) : "idle";
  return { sessionId: entry["sessionId"], status, ...(typeof entry["waitingFor"] === "string" ? { waitingFor: entry["waitingFor"] } : {}) };
}

/** A registry's entries by what they are. */
export interface ClaudeEntries {
  /** Conversations: a window's, or a background job's (`jobId`). */
  sessions: ClaudeLive[];
  /** Pre-warmed processes, no conversation yet. */
  spares: ClaudeLive[];
  /** Windows showing the agents screen, their conversation gone on as `parkedJobId`. */
  parked: ClaudeLive[];
}

export function classify(entries: ClaudeLive[]): ClaudeEntries {
  const out: ClaudeEntries = { sessions: [], spares: [], parked: [] };
  for (const e of entries) {
    if (e.spare) out.spares.push(e);
    else if (e.parkedJobId !== undefined && e.kind !== "bg") out.parked.push(e);
    else out.sessions.push(e);
  }
  return out;
}

/** The session status an entry stands for: a turn running is busy, anything else idle. */
export function statusOf(live: Pick<ClaudeLive, "status">): "idle" | "busy" {
  return live.status === "busy" ? "busy" : "idle";
}

/** What an idle entry waits on, when it is not done. */
export function waitingOf(live: Pick<ClaudeLive, "status" | "waitingFor">): SessionWaiting | undefined {
  if (live.status === "shell") return { on: "shell" };
  if (live.status === "waiting") return { on: "user", ...(live.waitingFor ? { detail: live.waitingFor } : {}) };
  return undefined;
}

/** When a job was made (`<configDir>/jobs/<id>/state.json`): rows in its transcript from before then are the history it was forked with. */
export function jobCreatedAt(configDir: string, jobId: string): number | undefined {
  if (!/^[0-9A-Za-z_-]+$/.test(jobId)) return undefined;
  const at = readJson(join(configDir, "jobs", jobId, "state.json"))?.["createdAt"];
  const ms = typeof at === "string" ? Date.parse(at) : typeof at === "number" ? at : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/** Claude's transcript directory name for a working directory: every non-alphanumeric character becomes `-`. */
export function transcriptDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Where the transcript of a session lives when no hook has said: `<configDir>/projects/<cwd>/<sessionId>.jsonl`. */
export function transcriptPathFor(configDir: string, cwd: string, sessionId: string): string {
  return join(configDir, "projects", transcriptDirName(cwd), `${sessionId}.jsonl`);
}
