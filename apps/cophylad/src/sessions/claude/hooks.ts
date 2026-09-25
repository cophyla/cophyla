// Installs cophylad's hooks into a Claude Code profile's `settings.json`, under cophylad's marker,
// beside whatever other tools wrote there. A matcher group is cophylad's when one of its
// handlers carries the `x-cophylad` header, a url under `/hooks/claude`, or a command that runs
// the shim. Install drops those groups and appends fresh ones; uninstall is the drop alone.
// No other group is ever touched.
//
// Uninstall comes in two widths. The marker is the wide one, which install uses to clear
// whatever a past daemon left. A stopping daemon uses the narrow one instead, an owner per
// group it wrote, because a second daemon may be running against the same file: the two
// differ in the port their url names and in the data directory their shim sits in, so each
// drops its own and leaves the other's.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PermissionRequest",
  "Elicitation",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "Stop",
  "SessionEnd",
] as const;

export const SHIM_MARKER = "cophylad-hook-shim.mjs";
export const URL_MARKER = "/hooks/claude";
export const HEADER_MARKER = "x-cophylad";

export interface ClaudeHookSpec {
  mode: "http" | "command";
  url: string;
  token: string;
  timeoutS: number;
  profileId: string;
  /** The shim command, for `command` mode. */
  command?: string;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function isCophyladHandler(h: unknown): boolean {
  if (!isObject(h)) return false;
  const headers = h["headers"];
  if (isObject(headers) && Object.keys(headers).some((k) => k.toLowerCase() === HEADER_MARKER)) return true;
  if (typeof h["url"] === "string" && h["url"].includes(URL_MARKER)) return true;
  if (typeof h["command"] === "string" && h["command"].includes(SHIM_MARKER)) return true;
  return false;
}

export function isCophyladGroup(group: unknown): boolean {
  if (!isObject(group)) return false;
  const hooks = group["hooks"];
  return Array.isArray(hooks) && hooks.some(isCophyladHandler);
}

/**
 * What one daemon wrote into one settings file: the endpoint it installed, and the shim
 * command when it installed one. Both name the daemon: the url carries its port, the command
 * its data directory and the profile the events arrive under.
 */
export interface ClaudeHookOwner {
  url: string;
  command?: string;
}

export function isOwnHandler(h: unknown, owners: readonly ClaudeHookOwner[]): boolean {
  if (!isObject(h)) return false;
  const url = h["url"];
  const command = h["command"];
  return owners.some((o) => (typeof url === "string" && url === o.url) || (o.command !== undefined && typeof command === "string" && command === o.command));
}

export function isOwnGroup(group: unknown, owners: readonly ClaudeHookOwner[]): boolean {
  if (!isObject(group)) return false;
  const hooks = group["hooks"];
  return Array.isArray(hooks) && hooks.some((h) => isOwnHandler(h, owners));
}

function cophyladHandler(spec: ClaudeHookSpec): Json {
  if (spec.mode === "command") {
    return { type: "command", command: spec.command ?? "", timeout: spec.timeoutS };
  }
  return {
    type: "http",
    url: spec.url,
    timeout: spec.timeoutS,
    headers: { Authorization: `Bearer ${spec.token}`, "x-cophylad": "1", "x-cophyla-profile": spec.profileId },
  };
}

/** The settings with every group the caller claims removed. Never touches another group. */
function dropGroups(settings: Json, mine: (group: unknown) => boolean): Json {
  const out: Json = { ...settings };
  const hooks = settings["hooks"];
  if (!isObject(hooks)) return out;
  const cleaned: Json = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      cleaned[event] = groups;
      continue;
    }
    const kept = groups.filter((g) => !mine(g));
    if (kept.length > 0 || kept.length === groups.length) cleaned[event] = kept;
  }
  if (Object.keys(cleaned).length > 0) out["hooks"] = cleaned;
  else delete out["hooks"];
  return out;
}

/** The settings with cophylad's groups removed. Never touches a group that is not cophylad's. */
export function withoutCophyladHooks(settings: Json): Json {
  return dropGroups(settings, isCophyladGroup);
}

/** The settings with one daemon's own groups removed. Another daemon's survive. */
export function withoutOwnHooks(settings: Json, owners: readonly ClaudeHookOwner[]): Json {
  return dropGroups(settings, (g) => isOwnGroup(g, owners));
}

/** The settings with cophylad's groups replaced by fresh ones for every event it listens to. */
export function withCophyladHooks(settings: Json, spec: ClaudeHookSpec): Json {
  const out = withoutCophyladHooks(settings);
  const hooks: Json = isObject(out["hooks"]) ? { ...(out["hooks"] as Json) } : {};
  for (const event of CLAUDE_HOOK_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    groups.push({ matcher: "", hooks: [cophyladHandler(spec)] });
    hooks[event] = groups;
  }
  out["hooks"] = hooks;
  return out;
}

export function readSettings(path: string): Json {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return {};
  const v = JSON.parse(text) as unknown;
  if (!isObject(v)) throw new Error(`${path} is not a JSON object`);
  return v;
}

function writeSettings(path: string, settings: Json): void {
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

/**
 * Whether a change is worth writing. Claude Code watches this file and re-reads the hooks of
 * every open session when it changes, and the file is the user's: a settings file cophylad has
 * nothing to add to or take from is left exactly as it was found, indentation and all.
 */
function changed(before: Json, after: Json): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

export function installClaudeHooks(settingsPath: string, spec: ClaudeHookSpec): void {
  const before = readSettings(settingsPath);
  const after = withCophyladHooks(before, spec);
  if (changed(before, after) || !existsSync(settingsPath)) writeSettings(settingsPath, after);
}

/**
 * Drops cophylad's hooks. With `owners`, only the groups that daemon installed, so a second
 * daemon against the same file keeps its own; without, every group under the marker.
 */
export function uninstallClaudeHooks(settingsPath: string, owners?: readonly ClaudeHookOwner[]): void {
  if (!existsSync(settingsPath)) return;
  const before = readSettings(settingsPath);
  const after = owners ? withoutOwnHooks(before, owners) : withoutCophyladHooks(before);
  if (changed(before, after)) writeSettings(settingsPath, after);
}

/** Whether a settings file lets messages from outside Claude Code into a session that bypasses prompts. */
export function acceptsCrossSessionInbound(settingsPath: string): boolean {
  try {
    return readSettings(settingsPath)["crossSessionInbound"] === "accept";
  } catch {
    return false;
  }
}
