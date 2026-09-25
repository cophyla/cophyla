// Which Muse binary cophylad runs for its own `serve` host and `plugins` calls. Muse installs a
// launcher (`muse.cmd` and a PowerShell script on Windows) that checks for an update, may
// download one, and then runs the active binary, `muse-bin-<version>.exe`, named by the
// `.muse-version` file beside it. cophylad runs that binary itself: no update round trip, no
// PowerShell tree per call, and a host that notices when the launcher moves the version on.
// A profile's own `command` wins; with no launcher found, `muse` on PATH is run as it is. A
// terminal cophylad starts runs `muse` exactly as the user does, launcher and all
// (`terminalCommand`), with the profile's `args`: those are the TUI's alone, since Muse takes
// no option before a subcommand (`muse --provider echo serve` is refused).

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HarnessProfile } from "@cophyla/protocol";

/** The launcher's record of the active version, beside it. */
export const VERSION_FILE = ".muse-version";

export interface MuseBinary {
  /** What to run. */
  command: string;
  /** Put before cophylad's own arguments: none for Muse itself, a script's path for a stand-in run by a runtime. */
  args: string[];
  /** The launcher's version file, when the binary came from it: a change there means a new binary. */
  versionFile?: string;
  /** The version it named when the binary was picked. */
  version?: string;
}

export interface LocateOptions {
  which?: (cmd: string) => string | null;
  platform?: NodeJS.Platform;
}

/** `muse` on PATH, its links resolved: the launcher, when Muse's installer put it there. */
export function launcherPath(opts: LocateOptions = {}): string | undefined {
  const found = (opts.which ?? Bun.which)("muse");
  if (!found) return undefined;
  try {
    return realpathSync(found);
  } catch {
    return found;
  }
}

/** The active binary a launcher's directory names, when the file and the binary are there. */
export function activeBinary(dir: string, platform: NodeJS.Platform = process.platform): { command: string; version: string; versionFile: string } | undefined {
  const versionFile = join(dir, VERSION_FILE);
  let version: string;
  try {
    version = readFileSync(versionFile, "utf8").trim();
  } catch {
    return undefined;
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+-R[0-9]+(\.[0-9]+)?$/.test(version)) return undefined;
  const command = join(dir, `muse-bin-${version}${platform === "win32" ? ".exe" : ""}`);
  return existsSync(command) ? { command, version, versionFile } : undefined;
}

/** The binary for a profile: its own command, else the launcher's active binary, else `muse`. */
export function locateMuse(profile: Pick<HarnessProfile, "exec"> | undefined, opts: LocateOptions = {}): MuseBinary {
  if (profile?.exec?.command) return { command: profile.exec.command, args: [] };
  const launcher = launcherPath(opts);
  if (launcher) {
    const active = activeBinary(dirname(launcher), opts.platform);
    if (active) return { ...active, args: [] };
    return { command: launcher, args: [] };
  }
  return { command: "muse", args: [] };
}

/** Whether the launcher has since named another version than the one a binary was picked for. */
export function versionMoved(bin: MuseBinary): boolean {
  if (!bin.versionFile) return false;
  try {
    return readFileSync(bin.versionFile, "utf8").trim() !== bin.version;
  } catch {
    return false;
  }
}

/** What a terminal cophylad starts runs: the profile's command, else `muse` as PATH finds it, launcher and all. */
export function terminalCommand(profile: Pick<HarnessProfile, "exec"> | undefined, opts: LocateOptions = {}): string[] {
  if (profile?.exec?.command) return [profile.exec.command, ...profile.exec.args];
  return [(opts.which ?? Bun.which)("muse") ?? "muse"];
}
