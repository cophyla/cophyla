// What a Claude Code session was started with, as far as leaving plan mode goes: the mode it
// started in, whether bypassing permissions is open to it, and whether its plan dialog shows
// the "Yes, clear context" row (`showClearContextOnPlanAccept`). The CLI's plan dialog offers
// its "Yes, and …" row from these, and the ask cophylad opens for a plan offers the same one.
// The flags come from the process's command line; `permissions.defaultMode` and
// `permissions.disableBypassPermissionsMode` from the settings files the CLI reads, lowest
// first: the profile's, the project's, the project's local one, then `--settings`. Pure but
// for `readLaunch`, which reads those files and never throws.

import { isAbsolute, join } from "node:path";
import { readSettings } from "./hooks.ts";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions" | "dontAsk";

/** The spellings the CLI accepts for a mode, lowercased; `manual` is `default` since 2.1.200. */
const MODE_ALIASES: Record<string, PermissionMode> = {
  default: "default",
  manual: "default",
  acceptedits: "acceptEdits",
  plan: "plan",
  auto: "auto",
  bypasspermissions: "bypassPermissions",
  bypass: "bypassPermissions",
  dontask: "dontAsk",
};

export function permissionModeOf(value: unknown): PermissionMode | undefined {
  return typeof value === "string" ? MODE_ALIASES[value.trim().toLowerCase()] : undefined;
}

export interface LaunchFlags {
  /** `--permission-mode`, or `--dangerously-skip-permissions`. */
  mode?: PermissionMode;
  /** `--allow-dangerously-skip-permissions`: started elsewhere, free to switch to bypassing. */
  allowBypass: boolean;
  /** `--settings`: a file, or the settings themselves as JSON. */
  settings?: string;
}

/** The flags that bear on permissions, from a command line's arguments. */
export function launchFlags(argv: readonly string[]): LaunchFlags {
  const flags: LaunchFlags = { allowBypass: false };
  let bypass = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    let value: string | undefined;
    if (name === "--permission-mode" || name === "--settings") value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    if (name === "--dangerously-skip-permissions") bypass = true;
    else if (name === "--allow-dangerously-skip-permissions") flags.allowBypass = true;
    else if (name === "--permission-mode") {
      const mode = permissionModeOf(value);
      if (mode) flags.mode = mode;
    } else if (name === "--settings" && value) {
      flags.settings = value;
    }
  }
  if (bypass) flags.mode = "bypassPermissions";
  return flags;
}

export interface PermissionSettings {
  defaultMode?: PermissionMode;
  /** `disableBypassPermissionsMode: "disable"` in any of them. */
  bypassDisabled: boolean;
  /** `showClearContextOnPlanAccept`, the last one given. */
  clearRow: boolean;
}

/** The permission settings a stack of settings documents comes to, lowest precedence first. */
export function permissionSettings(docs: readonly unknown[]): PermissionSettings {
  const out: PermissionSettings = { bypassDisabled: false, clearRow: false };
  for (const doc of docs) {
    const clear = doc && typeof doc === "object" ? (doc as Record<string, unknown>)["showClearContextOnPlanAccept"] : undefined;
    if (typeof clear === "boolean") out.clearRow = clear;
    const permissions = doc && typeof doc === "object" ? (doc as Record<string, unknown>)["permissions"] : undefined;
    if (!permissions || typeof permissions !== "object") continue;
    const p = permissions as Record<string, unknown>;
    const mode = permissionModeOf(p["defaultMode"]);
    if (mode) out.defaultMode = mode;
    if (p["disableBypassPermissionsMode"] === "disable") out.bypassDisabled = true;
  }
  return out;
}

export interface ClaudeLaunch {
  /** The mode it started in, when a flag or a settings file names one. */
  mode?: PermissionMode;
  /** Bypassing permissions is open to it: started in it, or allowed to switch to it. */
  bypass: boolean;
  /** Its plan dialog shows the "Yes, clear context" row. */
  clearRow: boolean;
}

/** As the CLI decides it: a flag's mode over the settings' default, bypass unless a setting disables it. */
export function launchOf(flags: LaunchFlags | undefined, settings: PermissionSettings): ClaudeLaunch {
  const mode = flags?.mode ?? settings.defaultMode;
  return { ...(mode ? { mode } : {}), bypass: (mode === "bypassPermissions" || flags?.allowBypass === true) && !settings.bypassDisabled, clearRow: settings.clearRow };
}

function settingsDoc(path: string): unknown {
  try {
    return readSettings(path);
  } catch {
    return undefined;
  }
}

/**
 * Reads what a session was started with: its flags when its command line is known, and the
 * settings files the CLI would have read in `cwd` under `configDir`.
 */
export function readLaunch(opts: { argv?: readonly string[]; configDir?: string; cwd: string }): ClaudeLaunch {
  const flags = opts.argv ? launchFlags(opts.argv) : undefined;
  const docs: unknown[] = [];
  if (opts.configDir) docs.push(settingsDoc(join(opts.configDir, "settings.json")));
  docs.push(settingsDoc(join(opts.cwd, ".claude", "settings.json")));
  docs.push(settingsDoc(join(opts.cwd, ".claude", "settings.local.json")));
  const s = flags?.settings?.trim();
  if (s?.startsWith("{")) {
    try {
      docs.push(JSON.parse(s));
    } catch {
      // Not JSON after all: nothing to read.
    }
  } else if (s) {
    docs.push(settingsDoc(isAbsolute(s) ? s : join(opts.cwd, s)));
  }
  return launchOf(flags, permissionSettings(docs));
}
