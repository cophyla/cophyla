// Installs cophylad's command hooks into a Codex home's `hooks.json`, under cophylad's marker,
// beside any other hooks there, and gets them trusted: Codex records a `trusted_hash` per
// hook in `config.toml`, which cophylad writes through the app-server's `config/batchWrite`
// and reads back through `hooks/list`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AGENT_MCP_SERVER } from "@cophyla/protocol";
import type { Logger } from "../../log.ts";
import { samePath } from "../paths.ts";
import type { CodexAppServer } from "./appserver.ts";

export const CODEX_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "PostToolUse", "Stop", "SessionEnd"] as const;
export const SHIM_MARKER = "cophylad-hook-shim.mjs";
export const HOOKS_FILENAME = "hooks.json";

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function isCophyladCodexHandler(h: unknown): boolean {
  if (!isObject(h)) return false;
  return [h["command"], h["commandWindows"]].some((c) => typeof c === "string" && c.includes(SHIM_MARKER));
}

export function isCophyladCodexGroup(group: unknown): boolean {
  if (!isObject(group)) return false;
  const hooks = group["hooks"];
  return Array.isArray(hooks) && hooks.some(isCophyladCodexHandler);
}

/** Codex reads `command` through `sh` and `commandWindows` through PowerShell; the file carries both. */
export interface CodexHookSpec {
  command: string;
  commandWindows: string;
  timeoutS: number;
}

export function withoutCophyladCodexHooks(doc: Json): Json {
  const out: Json = { ...doc };
  const hooks = doc["hooks"];
  if (!isObject(hooks)) return out;
  const cleaned: Json = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      cleaned[event] = groups;
      continue;
    }
    const kept = groups.filter((g) => !isCophyladCodexGroup(g));
    if (kept.length > 0 || kept.length === groups.length) cleaned[event] = kept;
  }
  out["hooks"] = cleaned;
  return out;
}

/** Codex clamps a SessionEnd hook to this and warns on every session start when the file says more. */
export const SESSION_END_TIMEOUT_S = 3;

export function withCophyladCodexHooks(doc: Json, spec: CodexHookSpec): Json {
  const out = withoutCophyladCodexHooks(doc);
  const hooks: Json = isObject(out["hooks"]) ? { ...(out["hooks"] as Json) } : {};
  for (const event of CODEX_HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    const timeout = event === "SessionEnd" ? Math.min(SESSION_END_TIMEOUT_S, spec.timeoutS) : spec.timeoutS;
    groups.push({
      hooks: [{ type: "command", command: spec.command, commandWindows: spec.commandWindows, timeout, async: false, statusMessage: "cophylad" }],
    });
    hooks[event] = groups;
  }
  out["hooks"] = hooks;
  return out;
}

export function readHooksFile(path: string): Json {
  if (!existsSync(path)) return { hooks: {} };
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return { hooks: {} };
  const v = JSON.parse(text) as unknown;
  if (!isObject(v)) throw new Error(`${path} is not a JSON object`);
  return v;
}

function writeHooksFile(path: string, doc: Json): void {
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n", "utf8");
}

export function installCodexHooks(hooksPath: string, spec: CodexHookSpec): void {
  writeHooksFile(hooksPath, withCophyladCodexHooks(readHooksFile(hooksPath), spec));
}

export function uninstallCodexHooks(hooksPath: string): void {
  if (!existsSync(hooksPath)) return;
  writeHooksFile(hooksPath, withoutCophyladCodexHooks(readHooksFile(hooksPath)));
}

/** The agents' server's table in a Codex `config.toml`: its command and arguments, or null when there is none (or the file does not parse). */
export function codexAgentEntry(configToml: string): { command: string; args: string[] } | null {
  if (!existsSync(configToml)) return null;
  try {
    const doc = Bun.TOML.parse(readFileSync(configToml, "utf8")) as Json;
    const servers = doc["mcp_servers"];
    const entry = isObject(servers) ? servers[AGENT_MCP_SERVER] : undefined;
    if (!isObject(entry)) return null;
    return { command: typeof entry["command"] === "string" ? entry["command"] : "", args: Array.isArray(entry["args"]) ? entry["args"].map(String) : [] };
  } catch {
    return null;
  }
}

export interface HooksListEntry {
  key: string;
  eventName: string;
  currentHash: string;
  trustStatus: "managed" | "untrusted" | "trusted" | "modified";
  sourcePath?: string;
  source?: string;
  isManaged?: boolean;
  enabled?: boolean;
  command?: string;
  timeoutSec?: number;
}

export interface TrustResult {
  /** Entries in our file after the grant. */
  entries: HooksListEntry[];
  trusted: number;
  untrusted: number;
  /** Set when the grant was refused or could not be checked; the user has a TUI step to take. */
  refused?: string;
}

/** `hooks/list` answers one group per cwd, each with its entries. */
export interface HooksListResponse {
  data?: { cwd?: string; hooks?: HooksListEntry[] }[];
}

/**
 * The config key path of one hook's trust entry. The key holds a Windows path, so its
 * backslashes must be escaped in the TOML basic string the key path is parsed as; Codex
 * then stores it as a literal-string key. The hash is written as `hooks/list` reports it,
 * which already carries the `sha256:` prefix.
 */
export function trustEdit(entry: HooksListEntry): { keyPath: string; value: string; mergeStrategy: "upsert" } {
  const key = entry.key.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const hash = entry.currentHash.startsWith("sha256:") ? entry.currentHash : `sha256:${entry.currentHash}`;
  return { keyPath: `hooks.state."${key}".trusted_hash`, value: hash, mergeStrategy: "upsert" };
}

/** Lists the hooks Codex sees under a home and grants trust to the untrusted ones from cophylad's file. */
export async function trustCodexHooks(server: CodexAppServer, opts: { hooksPath: string; codexHome: string; log: Logger }): Promise<TrustResult> {
  const list = async (): Promise<HooksListEntry[]> => {
    const r = await server.call<HooksListResponse>("hooks/list", { cwds: [opts.codexHome] });
    const all = (r?.data ?? []).flatMap((g) => g.hooks ?? []);
    return all.filter((e) => samePath(e.sourcePath, opts.hooksPath) && isCophyladCodexHandler({ command: e.command ?? "" }));
  };
  let entries: HooksListEntry[];
  try {
    entries = await list();
  } catch (e) {
    const refused = `hooks/list failed: ${e instanceof Error ? e.message : String(e)}`;
    opts.log.warn("codex hook trust could not be checked", { home: opts.codexHome, error: refused });
    return { entries: [], trusted: 0, untrusted: 0, refused };
  }
  const untrusted = entries.filter((e) => e.trustStatus !== "trusted" && e.trustStatus !== "managed");
  if (untrusted.length > 0) {
    const edits = untrusted.map(trustEdit);
    try {
      await server.call("config/batchWrite", { edits, reloadUserConfig: true });
    } catch (e) {
      const refused = `config/batchWrite refused: ${e instanceof Error ? e.message : String(e)}`;
      opts.log.warn("codex refused the hook trust grant; trust them once from the Codex TUI (/hooks)", { home: opts.codexHome, error: refused });
      return { entries, trusted: entries.length - untrusted.length, untrusted: untrusted.length, refused };
    }
    try {
      entries = await list();
    } catch {
      // keep the earlier listing
    }
  }
  const trusted = entries.filter((e) => e.trustStatus === "trusted" || e.trustStatus === "managed").length;
  const result: TrustResult = { entries, trusted, untrusted: entries.length - trusted };
  if (result.untrusted > 0) {
    result.refused = "hooks stay untrusted after the grant";
    opts.log.warn("codex hooks are still untrusted; trust them once from the Codex TUI (/hooks)", { home: opts.codexHome, untrusted: result.untrusted });
  } else if (entries.length === 0) {
    result.refused = "hooks/list reports no cophylad hooks";
    opts.log.warn("codex does not list cophylad's hooks; the hooks feature may be off", { home: opts.codexHome, file: opts.hooksPath });
  } else {
    opts.log.info("codex hooks trusted", { home: opts.codexHome, count: trusted });
  }
  return result;
}
