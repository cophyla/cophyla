// Where the agent sessions' MCP shim comes from, in order: its configured command, the
// `COPHYLA_MCP` environment variable, the platform's version folder (`versions/<v>/bin/`), and,
// in a checkout, cophyla-mcp's own release build, then its debug build.
//
// Every session runs the shim from a copy in a folder that never moves: `<root>/bin/` on an
// installed platform, `<data>/mcp/` from a checkout. The harnesses' configs name that one path,
// so they never point into a version folder that an update removes or into `target/`; and a
// build in the checkout is never blocked by a session running the copy (Windows will not
// overwrite a running executable, and placeBinary moves a running one aside instead).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { placeBinary } from "../update/place.ts";
import { MCP_PATH } from "../update/platform.ts";

export const MCP_NAME = process.platform === "win32" ? "cophyla-mcp.exe" : "cophyla-mcp";

export interface LocateMcpOptions {
  config: { command?: string };
  env: Record<string, string | undefined>;
  /** `versions/<v>/` of an installed platform. */
  versionDir?: string;
  /** The repository root, when the daemon runs from a checkout. */
  repoRoot?: string;
  exists?: (path: string) => boolean;
}

export interface McpLocation {
  path: string;
  origin: "config" | "env" | "installed" | "checkout";
}

export function locateMcp(opts: LocateMcpOptions): McpLocation | undefined {
  const exists = opts.exists ?? existsSync;
  if (opts.config.command) return exists(opts.config.command) ? { path: opts.config.command, origin: "config" } : undefined;
  const fromEnv = opts.env["COPHYLA_MCP"];
  if (fromEnv) return exists(fromEnv) ? { path: fromEnv, origin: "env" } : undefined;
  if (opts.versionDir) {
    const installed = join(opts.versionDir, MCP_PATH);
    // An installed platform never runs a checkout's build.
    return exists(installed) ? { path: installed, origin: "installed" } : undefined;
  }
  if (opts.repoRoot) {
    for (const profile of ["release", "debug"]) {
      const built = join(opts.repoRoot, "apps", "mcp", "target", profile, MCP_NAME);
      if (exists(built)) return { path: built, origin: "checkout" };
    }
  }
  return undefined;
}

/** The copy every session runs, put in place (or left, when it is current already): `<dir>/cophyla-mcp`. */
export function stageMcp(source: string, dir: string): string {
  placeBinary(source, dir, MCP_NAME);
  return join(dir, MCP_NAME);
}
