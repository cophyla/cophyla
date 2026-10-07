// The `cophyla-agents` MCP server in a Claude Code profile. The server is a user-scope entry in
// the profile's global config (`~/.claude.json` for `~/.claude`, `<dir>/.claude.json`
// otherwise), written through Claude's own CLI, `claude mcp add -s user`, since every running
// session rewrites that file whole and would undo an edit made beside it. The CLI runs only
// when the entry is missing or differs, which a read of the file tells. Its two tools are
// allowed in the profile's `settings.json`, as a session that prompts would otherwise ask on
// every call; with the bypass switch on, `crossSessionInbound: "accept"` goes there too, and
// is taken back only when cophylad wrote it.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { AGENT_MCP_SERVER, AGENT_TOOLS } from "@cophyla/protocol";
import { readSettings } from "./hooks.ts";

/** The permission rules that let a session call the two tools unasked. */
export const AGENT_TOOL_RULES: readonly string[] = AGENT_TOOLS.map((t) => `mcp__${AGENT_MCP_SERVER}__${t.name}`);

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** The server's user-scope entry in a global config: null when there is none, undefined when the file cannot be read. */
export function agentEntry(globalConfig: string): { command: string; args: string[] } | null | undefined {
  if (!existsSync(globalConfig)) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(globalConfig, "utf8"));
  } catch {
    return undefined;
  }
  const servers = isObject(doc) ? doc["mcpServers"] : undefined;
  const entry = isObject(servers) ? servers[AGENT_MCP_SERVER] : undefined;
  if (!isObject(entry)) return null;
  return { command: typeof entry["command"] === "string" ? entry["command"] : "", args: Array.isArray(entry["args"]) ? entry["args"].map(String) : [] };
}

/** When a global config last changed, so it is read again only once it has. */
export function stamp(path: string): string {
  try {
    const s = statSync(path);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return "none";
  }
}

export function sameEntry(entry: { command: string; args: string[] } | null | undefined, command: string, args: string[]): boolean {
  return !!entry && entry.command === command && entry.args.length === args.length && entry.args.every((a, i) => a === args[i]);
}

/** What a profile's `settings.json` is to hold of the server's: its tools allowed or not, and whether to let any session's message into one that bypasses prompts. */
export interface AgentSettingsWant {
  allow: boolean;
  /** `set`: write `accept`; `clear`: take back cophylad's own; `keep`: leave it as it is. */
  accept: "set" | "clear" | "keep";
}

/** The settings with the tools' rules and `crossSessionInbound` as wanted; no other rule or key is touched. */
export function withAgentSettings(settings: Json, want: AgentSettingsWant): Json {
  const out: Json = { ...settings };
  const permissions: Json = isObject(settings["permissions"]) ? { ...settings["permissions"] } : {};
  const allow = Array.isArray(permissions["allow"]) ? (permissions["allow"] as unknown[]).filter((r) => !AGENT_TOOL_RULES.includes(r as string)) : [];
  if (want.allow) allow.push(...AGENT_TOOL_RULES);
  if (allow.length > 0) permissions["allow"] = allow;
  else delete permissions["allow"];
  if (Object.keys(permissions).length > 0) out["permissions"] = permissions;
  else delete out["permissions"];
  if (want.accept === "set") out["crossSessionInbound"] = "accept";
  if (want.accept === "clear" && out["crossSessionInbound"] === "accept") delete out["crossSessionInbound"];
  return out;
}

/**
 * Brings a `settings.json` to what is wanted, writing it only when something changes (Claude
 * Code re-reads it in every open session when it does). Answers whether `accept` was there
 * before, so the caller knows whether the value is cophylad's to take back later.
 */
export function applyAgentSettings(path: string, want: AgentSettingsWant): { changed: boolean; acceptedBefore: boolean } {
  const before = readSettings(path);
  const after = withAgentSettings(before, want);
  const acceptedBefore = before["crossSessionInbound"] === "accept";
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (changed) writeFileSync(path, JSON.stringify(after, null, 2) + "\n", "utf8");
  return { changed, acceptedBefore };
}
