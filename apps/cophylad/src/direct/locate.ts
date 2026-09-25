// Where the direct connections' helper comes from, in order: `[direct].command`, the
// `COPHYLA_NET` environment variable, the platform's version folder (`versions/<v>/bin/`), and,
// in a checkout, cophyla-net's own release build, then its debug build.
//
// It runs from a copy in a folder that never moves: `<root>/bin/` on an installed platform,
// `data/net/` from a checkout. A firewall rule names an executable by its path, so the
// one the user allowed stays allowed across versions; and a build in the checkout is never
// blocked by the copy running.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DirectConfig } from "../config/schema.ts";
import { placeBinary } from "../update/place.ts";
import { NET_PATH } from "../update/platform.ts";

export const NET_NAME = process.platform === "win32" ? "cophyla-net.exe" : "cophyla-net";

export interface LocateNetOptions {
  config: Pick<DirectConfig, "command">;
  env: Record<string, string | undefined>;
  /** `versions/<v>/` of an installed platform. */
  versionDir?: string;
  /** The repository root, when the daemon runs from a checkout. */
  repoRoot?: string;
  exists?: (path: string) => boolean;
}

export interface NetLocation {
  path: string;
  origin: "config" | "env" | "installed" | "checkout";
}

export function locateNet(opts: LocateNetOptions): NetLocation | undefined {
  const exists = opts.exists ?? existsSync;
  if (opts.config.command) return exists(opts.config.command) ? { path: opts.config.command, origin: "config" } : undefined;
  const fromEnv = opts.env["COPHYLA_NET"];
  if (fromEnv) return exists(fromEnv) ? { path: fromEnv, origin: "env" } : undefined;
  if (opts.versionDir) {
    const installed = join(opts.versionDir, NET_PATH);
    // An installed platform never runs a checkout's build.
    return exists(installed) ? { path: installed, origin: "installed" } : undefined;
  }
  if (opts.repoRoot) {
    for (const profile of ["release", "debug"]) {
      const built = join(opts.repoRoot, "apps", "net", "target", profile, NET_NAME);
      if (exists(built)) return { path: built, origin: "checkout" };
    }
  }
  return undefined;
}

/** The copy the helper runs from, put in place (or left, when it is current already): `<dir>/cophyla-net`. */
export function stageNet(source: string, dir: string): string {
  placeBinary(source, dir, NET_NAME);
  return join(dir, NET_NAME);
}
