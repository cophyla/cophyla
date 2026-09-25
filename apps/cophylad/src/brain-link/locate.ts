// Where the brain comes from, in order: `[brain].command` in config, the `COPHYLA_BRAIN`
// environment variable, the installed release under `data/brain/current`, the brain bundled
// with an installed platform under `<install>/brain`, and, in a development tree only,
// `brain/src/main.ts` run by the daemon's own Bun. None of them found means the brain is
// off. Resolved again before every spawn, so a release staged while the brain ran is what
// the next start finds.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BrainConfig } from "../config/schema.ts";
import { brainBinary } from "../update/brain.ts";

export interface BrainLocation {
  command: string;
  args: string[];
  /** The brain's working directory: the directory its binary or script lives in. */
  cwd: string;
  origin: "config" | "env" | "installed" | "bundled" | "dev";
}

export interface LocateOptions {
  config: BrainConfig;
  env: Record<string, string | undefined>;
  /** The user data directory. */
  home: string;
  /** The platform's install directory, when the daemon runs from one; its `brain/` is the bundled seed. */
  installDir?: string;
  /** The repository root, when the daemon runs from one. */
  repoRoot?: string;
  bun?: string;
}

/** The repository root relative to this file, for the development fallback. */
export function repoRootFromHere(): string {
  return resolve(import.meta.dir, "..", "..", "..", "..");
}

function dirOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > 0 ? path.slice(0, i) : ".";
}

function isScript(path: string): boolean {
  return /\.(ts|js|mjs|cjs|tsx)$/i.test(path);
}

/** A binary is run as it is, a script by Bun. */
function runnable(path: string, bun: string, args: string[] = []): { command: string; args: string[] } {
  return isScript(path) ? { command: bun, args: [path, ...args] } : { command: path, args };
}

/** A verified release directory: the binary in it, run from it. */
function fromDir(dir: string, origin: BrainLocation["origin"], bun: string): BrainLocation | undefined {
  const binary = brainBinary(dir);
  return binary ? { ...runnable(binary, bun), cwd: dir, origin } : undefined;
}

export function locateBrain(opts: LocateOptions): BrainLocation | undefined {
  const bun = opts.bun ?? process.execPath;
  if (opts.config.command) {
    const command = opts.config.command;
    return { ...runnable(command, bun, opts.config.args), cwd: dirOf(resolve(command)), origin: "config" };
  }
  const fromEnv = opts.env["COPHYLA_BRAIN"];
  if (fromEnv) return { ...runnable(fromEnv, bun), cwd: dirOf(resolve(fromEnv)), origin: "env" };
  const installed = fromDir(join(opts.home, "data", "brain", "current"), "installed", bun);
  if (installed) return installed;
  if (opts.installDir) {
    const bundled = fromDir(join(opts.installDir, "brain"), "bundled", bun);
    if (bundled) return bundled;
    // An installed platform never runs a checkout's brain.
    return undefined;
  }
  const repo = opts.repoRoot ?? repoRootFromHere();
  const dev = join(repo, "brain", "src", "main.ts");
  if (existsSync(dev)) return { command: bun, args: ["run", dev], cwd: join(repo, "brain"), origin: "dev" };
  return undefined;
}
