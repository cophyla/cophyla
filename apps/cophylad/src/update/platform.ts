// The installed platform on disk: the install root with its `current`, `previous` and
// `staged` pointers and `versions/<v>/` directories. The launcher owns `current` and
// `previous`; this module writes only `staged`, and only once a version directory is complete.
// A version is complete when `release.json` and the shell binary are there and no `.broken`
// marker is; the launcher writes `.broken` when a version failed to start.
//
// The root is the launcher's own directory on Windows (`%LOCALAPPDATA%\Cophyla`); on macOS
// and Linux the launcher is a sealed package (`/Applications/Cophyla.app`, `/usr/bin/Cophyla`)
// and the root lives in the user's data directory, seeded by the launcher from the package
// at first start. The names below are the one definition per OS; the launcher's and the
// shell's Rust constants are pinned equal to them by apps/ui/test/manifest.test.ts.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Release } from "@cophyla/protocol";
import { extractTarGz } from "./archive.ts";
import { isSemver } from "./feed.ts";

export type Pointer = "current" | "previous" | "staged";

export type HostOs = "windows" | "macos" | "linux";

/** The OS as the feed names it. */
export function hostOs(platform: NodeJS.Platform = process.platform): HostOs {
  return platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";
}

/** The shell binary inside `versions/<v>/`: on macOS a whole bundle per version. */
export const SHELL_PATHS: Record<HostOs, string> = {
  windows: "cophyla-ui.exe",
  macos: "Cophyla.app/Contents/MacOS/cophyla-ui",
  linux: "cophyla-ui",
};

/** The launcher's binary name: beside the root on Windows; the packaged entry point elsewhere. */
export const LAUNCHER_NAMES: Record<HostOs, string> = {
  windows: "Cophyla.exe",
  macos: "Cophyla",
  linux: "Cophyla",
};

/** The shipped runtime inside `versions/<v>/`. */
export const BUN_NAMES: Record<HostOs, string> = {
  windows: "bun.exe",
  macos: "bun",
  linux: "bun",
};

/** The tether binary inside `versions/<v>/`, which cophylad copies out before running it. */
export const TETHER_PATHS: Record<HostOs, string> = {
  windows: "bin/tether.exe",
  macos: "bin/tether",
  linux: "bin/tether",
};

/** The direct connections' helper inside `versions/<v>/`, which cophylad copies to `<root>/bin/` before running it. */
export const NET_PATHS: Record<HostOs, string> = {
  windows: "bin/cophyla-net.exe",
  macos: "bin/cophyla-net",
  linux: "bin/cophyla-net",
};

/** The agent sessions' MCP shim inside `versions/<v>/`, which cophylad copies to `<root>/bin/` and names in every harness's config. */
export const MCP_PATHS: Record<HostOs, string> = {
  windows: "bin/cophyla-mcp.exe",
  macos: "bin/cophyla-mcp",
  linux: "bin/cophyla-mcp",
};

export const SHELL_NAME = SHELL_PATHS[hostOs()];
export const TETHER_PATH = TETHER_PATHS[hostOs()];
export const NET_PATH = NET_PATHS[hostOs()];
export const MCP_PATH = MCP_PATHS[hostOs()];
export const LAUNCHER_NAME = LAUNCHER_NAMES[hostOs()];
export const BUN_NAME = BUN_NAMES[hostOs()];
export const BROKEN_MARKER = ".broken";
export const RELEASE_FILE = "release.json";
/** The file the launcher writes in the root with its own path, for the shell's relaunch. */
export const LAUNCHER_FILE = "launcher";

/** The `tar` that unpacks a platform archive: Windows ships one under System32, elsewhere PATH has it. */
export function defaultTar(platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): string {
  return platform === "win32" ? join(env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe") : "tar";
}

export interface Install {
  /** The root: the pointers, `versions/` and the bundled brain (and the launcher on Windows). */
  dir: string;
  /** The version directory this daemon runs from. */
  versionDir: string;
  /** Its version, from the directory name. */
  version: string;
}

/** A root is one the launcher made: the launcher beside it (Windows), or `versions/` with a `current` pointer (seeded elsewhere). */
function isRoot(dir: string): boolean {
  return existsSync(join(dir, LAUNCHER_NAME)) || (existsSync(join(dir, "current")) && existsSync(join(dir, "versions")));
}

/**
 * Where this daemon is installed, if it is: `COPHYLA_INSTALL_DIR` and `COPHYLA_PLATFORM_DIR` from
 * the shell, else the source tree's own place under `versions/<v>/` in a root. A daemon run
 * from a checkout is not installed and takes no platform updates.
 */
export function detectInstall(env: Record<string, string | undefined>, here = import.meta.dir): Install | undefined {
  const fromEnv = env["COPHYLA_INSTALL_DIR"];
  const platformDir = env["COPHYLA_PLATFORM_DIR"];
  if (fromEnv && platformDir) {
    const dir = resolve(fromEnv);
    const versionDir = resolve(platformDir);
    const version = basename(versionDir);
    if (isSemver(version) && isRoot(dir)) return { dir, versionDir, version };
  }
  // <dir>/versions/<v>/cophylad/apps/cophylad/src/update
  let cursor = resolve(here);
  for (let i = 0; i < 8; i++) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    if (basename(parent) === "versions" && isSemver(basename(cursor))) {
      const dir = dirname(parent);
      if (isRoot(dir)) return { dir, versionDir: cursor, version: basename(cursor) };
    }
    cursor = parent;
  }
  return undefined;
}

/** A pointer file holds one version on one line. */
export function readPointer(dir: string, name: Pointer): string | undefined {
  try {
    const v = readFileSync(join(dir, name), "utf8").trim();
    return isSemver(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Temp file and rename, so a reader never sees a half-written pointer. */
export function writePointer(dir: string, name: Pointer, version: string): void {
  const tmp = join(dir, `${name}.tmp-${process.pid}`);
  writeFileSync(tmp, version + "\n", "utf8");
  renameSync(tmp, join(dir, name));
}

export class PlatformStore {
  readonly install: Install;
  private tar: string;

  constructor(install: Install, opts: { tar?: string } = {}) {
    this.install = install;
    this.tar = opts.tar ?? defaultTar();
  }

  get dir(): string {
    return this.install.dir;
  }

  versionsDir(): string {
    return join(this.install.dir, "versions");
  }

  versionDir(version: string): string {
    return join(this.versionsDir(), version);
  }

  pointer(name: Pointer): string | undefined {
    return readPointer(this.install.dir, name);
  }

  isBroken(version: string): boolean {
    return existsSync(join(this.versionDir(version), BROKEN_MARKER));
  }

  markBroken(version: string): void {
    const dir = this.versionDir(version);
    if (!existsSync(dir)) return;
    writeFileSync(join(dir, BROKEN_MARKER), new Date().toISOString() + "\n", "utf8");
  }

  isComplete(version: string): boolean {
    const dir = this.versionDir(version);
    return existsSync(join(dir, RELEASE_FILE)) && existsSync(join(dir, SHELL_NAME)) && !this.isBroken(version);
  }

  /** The `staged` pointer when it names a complete version. */
  staged(): string | undefined {
    const v = this.pointer("staged");
    return v && this.isComplete(v) ? v : undefined;
  }

  /** The release entry a complete version directory carries. */
  release(version: string): Release | undefined {
    try {
      return JSON.parse(readFileSync(join(this.versionDir(version), RELEASE_FILE), "utf8")) as Release;
    } catch {
      return undefined;
    }
  }

  /** Versions on disk marked `.broken` by the launcher. */
  brokenVersions(): string[] {
    return this.versions().filter((v) => this.isBroken(v));
  }

  versions(): string[] {
    try {
      return readdirSync(this.versionsDir(), { withFileTypes: true })
        .filter((d) => d.isDirectory() && isSemver(d.name))
        .map((d) => d.name);
    } catch {
      return [];
    }
  }

  /**
   * Unpacks a downloaded archive into `versions/<v>.partial`, renames it into place, writes
   * `release.json` last and then the `staged` pointer. Leaves nothing half-done: a failure
   * removes the partial directory. On macOS the quarantine attribute a download carries is
   * stripped from the tree, so Gatekeeper does not hold the new shell at its first start.
   */
  async stage(archive: string, release: Release): Promise<void> {
    const version = release.version;
    const final = this.versionDir(version);
    const partial = final + ".partial";
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    try {
      await extractTarGz(archive, partial, { tar: this.tar });
      if (!existsSync(join(partial, SHELL_NAME))) throw new Error(`archive has no ${SHELL_NAME}`);
      if (process.platform === "darwin") {
        // status ignored: the attribute may not be there, and a refusal only means a Gatekeeper prompt
        await Bun.spawn(["xattr", "-dr", "com.apple.quarantine", partial], { stdout: "ignore", stderr: "ignore" }).exited;
      }
      rmSync(final, { recursive: true, force: true });
      renameSync(partial, final);
      writeFileSync(join(final, RELEASE_FILE), JSON.stringify(release, null, 2) + "\n", "utf8");
    } catch (e) {
      rmSync(partial, { recursive: true, force: true });
      throw e;
    }
    writePointer(this.install.dir, "staged", version);
  }

  /** Removes version directories outside `keep`, partial ones included. */
  prune(keep: Iterable<string>): string[] {
    const kept = new Set(keep);
    const removed: string[] = [];
    let entries: string[];
    try {
      entries = readdirSync(this.versionsDir());
    } catch {
      return removed;
    }
    for (const name of entries) {
      const version = name.replace(/\.partial$/, "");
      if (kept.has(name) || (kept.has(version) && !name.endsWith(".partial"))) continue;
      try {
        rmSync(join(this.versionsDir(), name), { recursive: true, force: true });
        removed.push(name);
      } catch {
        // in use; the next start tries again
      }
    }
    return removed;
  }
}
