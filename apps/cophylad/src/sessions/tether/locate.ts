// Where the tether binary comes from, in order: `[tether].command`, the `COPHYLA_TETHER`
// environment variable, the platform's version folder (`versions/<v>/bin/`), and, in a
// checkout, tether's own release build, then its debug build. None found means sessions start
// in a terminal as they did before tether: typed input and terminal views are off.
//
// The binary is run from a copy under `data/tether/<version>-<hash>/`, never from where it was
// found: a host outlives the daemon that started it, and a running executable cannot be
// replaced or deleted on Windows, so a host started from the version folder would keep the
// updater from pruning it, and one started from a checkout would block the next build.

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { TetherConfig } from "../../config/schema.ts";
import { TETHER_PATH } from "../../update/platform.ts";

export const TETHER_NAME = process.platform === "win32" ? "tether.exe" : "tether";

export interface LocateTetherOptions {
  config: TetherConfig;
  env: Record<string, string | undefined>;
  /** `versions/<v>/` of an installed platform. */
  versionDir?: string;
  /** The repository root, when the daemon runs from a checkout. */
  repoRoot?: string;
  exists?: (path: string) => boolean;
}

export interface TetherLocation {
  path: string;
  origin: "config" | "env" | "installed" | "checkout";
}

export function locateTether(opts: LocateTetherOptions): TetherLocation | undefined {
  const exists = opts.exists ?? existsSync;
  if (opts.config.command) return exists(opts.config.command) ? { path: opts.config.command, origin: "config" } : undefined;
  const fromEnv = opts.env["COPHYLA_TETHER"];
  if (fromEnv) return exists(fromEnv) ? { path: fromEnv, origin: "env" } : undefined;
  if (opts.versionDir) {
    const installed = join(opts.versionDir, TETHER_PATH);
    // An installed platform never runs a checkout's build.
    return exists(installed) ? { path: installed, origin: "installed" } : undefined;
  }
  if (opts.repoRoot) {
    for (const profile of ["release", "debug"]) {
      const built = join(opts.repoRoot, "tether", "target", profile, TETHER_NAME);
      if (exists(built)) return { path: built, origin: "checkout" };
    }
  }
  return undefined;
}

/**
 * The copy the daemon runs, made when it is not there yet. `version` names the folder with the
 * content's hash, so a rebuilt binary of the same version gets a folder of its own.
 */
export function stageTether(source: string, dataDir: string, version: string): string {
  const hash = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 12);
  const dir = join(dataDir, "tether", `${version}-${hash}`);
  const dest = join(dir, TETHER_NAME);
  if (existsSync(dest)) return dest;
  mkdirSync(dir, { recursive: true });
  const tmp = `${dest}.tmp${process.pid}`;
  copyFileSync(source, tmp);
  if (process.platform !== "win32") chmodSync(tmp, 0o755);
  renameSync(tmp, dest);
  return dest;
}
