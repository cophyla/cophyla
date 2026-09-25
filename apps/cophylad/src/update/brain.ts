// Brain releases on disk: `<home>/data/brain/{current,previous,staged/<v>}`, each a
// directory with the binary and the signed `release.json` beside it. The bundled seed under
// `<install>/brain` has the same shape and is read-only. A directory is verified before the
// brain in it is spawned: the entry must be a brain release signed by a release key and the
// binary's hash must be the entry's.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Release } from "@cophyla/protocol";
import type { Release as ReleaseT } from "@cophyla/protocol";
import { isSemver, newer } from "./feed.ts";
import { RELEASE_FILE } from "./platform.ts";
import { sha256File, verifyRelease } from "./verify.ts";

/** The binaries brain-link looks for in a brain directory, in order. */
export const BRAIN_BINARIES = process.platform === "win32" ? ["brain.exe", "brain", "brain.ts", "brain.js"] : ["brain", "brain.ts", "brain.js"];

/** The name a downloaded brain gets in its directory: the runtime's for a binary, the script's own extension otherwise. */
export function brainBinaryName(release: Pick<ReleaseT, "name" | "url">): string {
  const source = release.name ?? release.url;
  const m = /\.(ts|js|mjs)$/i.exec(source);
  if (m) return `brain.${m[1]!.toLowerCase()}`;
  return process.platform === "win32" ? "brain.exe" : "brain";
}

/** `0755` on a brain binary on Unix (a script runs under the runtime and needs none); nothing on Windows. */
export function makeExecutable(path: string): void {
  if (process.platform === "win32" || /\.(ts|js|mjs)$/i.test(path)) return;
  try {
    chmodSync(path, 0o755);
  } catch {
    // brain-link reports a binary it cannot run
  }
}

/** The binary in a brain directory, if one is there. */
export function brainBinary(dir: string): string | undefined {
  for (const name of BRAIN_BINARIES) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

export function readBrainRelease(dir: string): ReleaseT | undefined {
  try {
    const parsed = Release.safeParse(JSON.parse(readFileSync(join(dir, RELEASE_FILE), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export type BrainCheck = { ok: true; release: ReleaseT } | { ok: false; reason: string };

/** The signed entry beside the binary checks against `keys`, and the binary hashes to what the entry says. */
export async function verifyBrainDir(dir: string, keys: string[]): Promise<BrainCheck> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, RELEASE_FILE), "utf8"));
  } catch {
    return { ok: false, reason: `no ${RELEASE_FILE}` };
  }
  const parsed = Release.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `${RELEASE_FILE} invalid` };
  const release = parsed.data;
  if (release.component !== "brain") return { ok: false, reason: `${RELEASE_FILE} is a ${release.component} release` };
  if (!verifyRelease(raw as Record<string, unknown>, keys)) return { ok: false, reason: "signature" };
  const binary = brainBinary(dir);
  if (!binary) return { ok: false, reason: "no binary" };
  const digest = await sha256File(binary);
  if (digest !== release.sha256) return { ok: false, reason: "hash" };
  return { ok: true, release };
}

export class BrainStore {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, "brain");
  }

  get currentDir(): string {
    return join(this.root, "current");
  }

  get previousDir(): string {
    return join(this.root, "previous");
  }

  stagedDir(version: string): string {
    return join(this.root, "staged", version);
  }

  currentRelease(): ReleaseT | undefined {
    return readBrainRelease(this.currentDir);
  }

  previousRelease(): ReleaseT | undefined {
    return readBrainRelease(this.previousDir);
  }

  /** The highest staged version with a binary and an entry, if any. */
  stagedVersion(): string | undefined {
    let best: string | undefined;
    let entries: string[];
    try {
      entries = readdirSync(join(this.root, "staged"));
    } catch {
      return undefined;
    }
    for (const v of entries) {
      if (!isSemver(v) || !brainBinary(this.stagedDir(v)) || !readBrainRelease(this.stagedDir(v))) continue;
      if (!best || newer(v, best)) best = v;
    }
    return best;
  }

  /**
   * Moves a downloaded binary into `staged/<v>/` with its entry. Replaces a staged copy of
   * the same version. A download has no mode bits: a binary gets `0755` on Unix.
   */
  stage(file: string, release: ReleaseT): string {
    const dir = this.stagedDir(release.version);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const binary = join(dir, brainBinaryName(release));
    renameSync(file, binary);
    makeExecutable(binary);
    writeFileSync(join(dir, RELEASE_FILE), JSON.stringify(release, null, 2) + "\n", "utf8");
    return dir;
  }

  /**
   * `staged/<v>` becomes `current`; what was current becomes `previous`. Other staged
   * versions are removed. Returns the promoted version.
   */
  promote(version: string): string {
    const from = this.stagedDir(version);
    if (!brainBinary(from)) throw new Error(`no staged brain ${version}`);
    if (existsSync(this.currentDir)) {
      rmSync(this.previousDir, { recursive: true, force: true });
      renameSync(this.currentDir, this.previousDir);
    }
    renameSync(from, this.currentDir);
    rmSync(join(this.root, "staged"), { recursive: true, force: true });
    return version;
  }

  /**
   * Removes a `current` that failed its check and puts `previous` back in its place when
   * there is one. Returns what is current now: the previous version, or nothing, in which
   * case brain-link falls through to the bundled seed or the dev tree.
   */
  rollback(): string | undefined {
    rmSync(this.currentDir, { recursive: true, force: true });
    if (existsSync(this.previousDir)) {
      renameSync(this.previousDir, this.currentDir);
      return this.currentRelease()?.version;
    }
    return undefined;
  }
}
