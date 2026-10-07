// cophylad's Muse plugin. Muse runs hooks only from a plugin, so each profile gets one under
// cophylad's data directory: a manifest (id `cophylad`) and a copy of the hook shim per event, since
// Muse refuses two hooks that share a source file. Each hook runs the daemon's runtime on its
// copy, naming the harness, the profile and the `hook.json` the daemon writes, because the
// copy runs from Muse's plugin cache with nothing beside it. At start the plugin is installed,
// or installed again when what Muse has cached differs from what cophylad wrote, and approved:
// Muse keeps a hook disabled until its definition is trusted, which is cophylad's own to grant,
// as it trusts its Codex hooks. The plugin stays installed when cophylad stops; a stopped daemon
// answers nothing and the shim prints `{}`. A plugin the user disabled is left disabled. The
// agents' MCP server (`cophyla-agents`) is one of its capabilities, a command array as Muse
// wants it, and is approved with the hooks.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_MCP_SERVER } from "@cophyla/protocol";
import type { Logger } from "../../log.ts";
import { plainPath, samePath } from "../paths.ts";
import { SHIM_SOURCE } from "../shim.ts";

export const MUSE_PLUGIN_ID = "cophylad";
export const MUSE_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "PostToolUse", "PostToolUseFailure", "Notification", "Stop", "SessionEnd"] as const;
/** The longest hook timeout Muse was seen to accept (two hours); a longer `hook_timeout_s` is held to it. */
export const MUSE_TIMEOUT_CAP_MS = 7_200_000;
/** A SessionEnd hook answers at once, and a session that is closing should not wait on it. */
export const SESSION_END_TIMEOUT_MS = 3000;

/** A hook's shim copy, relative to the plugin's root. */
export function hookFile(event: string): string {
  return `hooks/${event.toLowerCase()}.mjs`;
}

/** The manifest: one hook per event, each running its own copy of the shim, and the agents' server when `agents` is its command. */
export function museManifest(argv: (shim: string) => string[], timeoutS: number, version: string, agents?: string[]): Record<string, unknown> {
  const timeoutMs = Math.min(timeoutS * 1000, MUSE_TIMEOUT_CAP_MS);
  return {
    schemaVersion: 1,
    name: MUSE_PLUGIN_ID,
    displayName: "cophylad",
    version,
    description: "Reports this session to cophylad, so it can be followed and answered from the Cophyla apps.",
    compat: { source: "native", manifestDir: ".muse-plugin" },
    capabilities: {
      skills: [],
      commands: [],
      hooks: MUSE_HOOK_EVENTS.map((event) => ({
        id: event.toLowerCase(),
        event,
        command: argv(hookFile(event)),
        timeoutMs: event === "SessionEnd" ? Math.min(SESSION_END_TIMEOUT_MS, timeoutMs) : timeoutMs,
      })),
      mcpServers: agents ? [{ id: AGENT_MCP_SERVER, command: agents }] : [],
      reminders: [],
    },
  };
}

/** The plugin's files by path relative to its root. */
export function museFiles(manifest: Record<string, unknown>): Map<string, string> {
  const files = new Map<string, string>([[".muse-plugin/plugin.json", JSON.stringify(manifest, null, 2) + "\n"]]);
  for (const event of MUSE_HOOK_EVENTS) files.set(hookFile(event), SHIM_SOURCE);
  return files;
}

/** Writes the plugin under `dir`, replacing what an earlier run wrote. */
export function writeMusePlugin(dir: string, files: Map<string, string>): void {
  rmSync(join(dir, "hooks"), { recursive: true, force: true });
  for (const [rel, text] of files) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text, "utf8");
  }
}

/** Runs `muse plugins <args> --json` under the profile: the exit code and what it printed. */
export type MuseRun = (args: string[]) => Promise<{ code: number; out: string }>;

export interface PluginStatus {
  installed: boolean;
  /** Every hook trusted and enabled. */
  approved: boolean;
  /** What stands between the plugin and working hooks, and the command that settles it. */
  refused?: string;
}

interface Inspect {
  record?: { enabled?: boolean; source?: { path?: string }; cache_path?: string };
  runtime_capabilities?: { candidate?: { stable_id?: string }; status?: string }[];
}

function parse(out: string): unknown {
  try {
    return JSON.parse(out) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether Muse's cached copy of the plugin is exactly what cophylad wrote, from the same place. */
function cachedMatches(inspect: Inspect, dir: string, files: Map<string, string>): boolean {
  const cache = inspect.record?.cache_path;
  const source = inspect.record?.source?.path;
  if (!cache || !source || !samePath(plainPath(source), dir)) return false;
  for (const [rel, text] of files) {
    try {
      if (readFileSync(join(cache, rel), "utf8").replace(/\r\n/g, "\n") !== text) return false;
    } catch {
      return false;
    }
  }
  // A hook file the plugin no longer has, still in the cache, is a definition Muse would run.
  try {
    const cached = readdirSync(join(cache, "hooks")).map((n) => `hooks/${n}`);
    if (cached.some((rel) => !files.has(rel))) return false;
  } catch {
    return false;
  }
  return true;
}

function allTrusted(inspect: Inspect): boolean {
  const caps = inspect.runtime_capabilities ?? [];
  return caps.length > 0 && caps.every((c) => c.status === "trusted_enabled");
}

/**
 * Installs the plugin when Muse's copy differs from `dir`, and approves its hooks when any is
 * not trusted and enabled. `approveHint` is the command the user can run themselves.
 */
export async function ensureMusePlugin(opts: { dir: string; files: Map<string, string>; run: MuseRun; log: Logger; approveHint: string }): Promise<PluginStatus> {
  const { dir, files, run, log } = opts;
  const inspect = async (): Promise<Inspect | undefined> => {
    const r = await run(["inspect", MUSE_PLUGIN_ID]);
    const v = parse(r.out) as (Inspect & { error?: unknown }) | undefined;
    return r.code === 0 && v && !v.error ? v : undefined;
  };
  let current = await inspect();
  if (!current || !cachedMatches(current, dir, files)) {
    if (!existsSync(join(dir, ".muse-plugin", "plugin.json"))) return { installed: false, approved: false, refused: "the plugin was not written" };
    const r = await run(["install", dir, "--scope", "user"]);
    if (r.code !== 0) {
      const v = parse(r.out) as { error?: { message?: string } } | undefined;
      const why = v?.error?.message ?? (r.out.trim().split(/\r?\n/).pop() || `exit ${r.code}`);
      log.warn("muse refused cophylad's plugin", { dir, error: why });
      return { installed: false, approved: false, refused: `muse plugins install refused: ${why}` };
    }
    log.info("muse plugin installed", { dir });
    current = await inspect();
    if (!current) return { installed: true, approved: false, refused: "muse plugins inspect cophylad failed after the install" };
  }
  if (current.record?.enabled === false) {
    log.warn("cophylad's muse plugin is disabled; sessions in a TUI go unseen until it is enabled", { enable: "muse plugins enable cophylad" });
    return { installed: true, approved: false, refused: "the plugin is disabled (muse plugins enable cophylad)" };
  }
  if (!allTrusted(current)) {
    const r = await run(["approve", MUSE_PLUGIN_ID]);
    if (r.code === 0) current = (await inspect()) ?? current;
    if (r.code !== 0 || !allTrusted(current)) {
      log.warn("muse did not approve cophylad's hooks; approve them once yourself", { run: opts.approveHint });
      return { installed: true, approved: false, refused: `hooks not approved (${opts.approveHint})` };
    }
    log.info("muse plugin hooks approved", { dir });
  }
  return { installed: true, approved: true };
}
