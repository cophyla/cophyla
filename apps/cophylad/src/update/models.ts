// Voice models on disk: `<home>/data/models/<name>/{current,<version>/}`. A model release is
// a `.tar.gz` of one model directory with its `manifest.json`; it is unpacked into
// `<version>.partial`, checked against the hashes in that manifest, given the signed
// `release.json` it came with, and only then renamed into place. `current` is a pointer
// file naming the version the engines load, so turning a stage on is a rename and a
// pointer write, never an overwrite of a file an engine holds open.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Release } from "@cophyla/protocol";
import type { Release as ReleaseT } from "@cophyla/protocol";
import { verifyVoiceDir } from "../voice/manifest.ts";
import { extractTarGz } from "./archive.ts";
import { isSemver, newer } from "./feed.ts";
import { defaultTar, RELEASE_FILE } from "./platform.ts";
import { verifyRelease } from "./verify.ts";

/** The file naming the version the engines load, inside `<models>/<name>/`. */
export const CURRENT_FILE = "current";

export type ModelCheck = { ok: true; release: ReleaseT } | { ok: false; reason: string };

export function readModelRelease(dir: string): ReleaseT | undefined {
  try {
    const parsed = Release.safeParse(JSON.parse(readFileSync(join(dir, RELEASE_FILE), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The signed entry beside the model checks against `keys` and is a model release. */
export function verifyModelDir(dir: string, keys: string[]): ModelCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, RELEASE_FILE), "utf8"));
  } catch {
    return { ok: false, reason: `no ${RELEASE_FILE}` };
  }
  const parsed = Release.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `${RELEASE_FILE} invalid` };
  const release = parsed.data;
  if (release.component !== "model") return { ok: false, reason: `${RELEASE_FILE} is a ${release.component} release` };
  if (!verifyRelease(raw as Record<string, unknown>, keys)) return { ok: false, reason: "signature" };
  const files = verifyVoiceDir(dir);
  if (!files.ok) return { ok: false, reason: files.reason };
  return { ok: true, release };
}

export class ModelStore {
  readonly root: string;
  private tar: string;

  constructor(dataDir: string, opts: { tar?: string } = {}) {
    this.root = join(dataDir, "models");
    this.tar = opts.tar ?? defaultTar();
  }

  modelDir(name: string): string {
    return join(this.root, name);
  }

  dir(name: string, version: string): string {
    return join(this.root, name, version);
  }

  /** The version `current` names, when that directory is complete. */
  currentVersion(name: string): string | undefined {
    const v = this.readPointer(name);
    return v && this.isComplete(name, v) ? v : undefined;
  }

  currentDir(name: string): string | undefined {
    const v = this.currentVersion(name);
    return v ? this.dir(name, v) : undefined;
  }

  /** The highest complete version that is not the current one: what `update.apply` would promote. */
  stagedVersion(name: string): string | undefined {
    const current = this.readPointer(name);
    let best: string | undefined;
    for (const v of this.versions(name)) {
      if (v === current) continue;
      if (!best || newer(v, best)) best = v;
    }
    return best;
  }

  versions(name: string): string[] {
    try {
      return readdirSync(this.modelDir(name), { withFileTypes: true })
        .filter((d) => d.isDirectory() && isSemver(d.name) && this.isComplete(name, d.name))
        .map((d) => d.name);
    } catch {
      return [];
    }
  }

  /** Every model with a directory here, whether or not it is current. */
  known(): string[] {
    try {
      return readdirSync(this.root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .filter((name) => this.versions(name).length > 0)
        .sort();
    } catch {
      return [];
    }
  }

  isComplete(name: string, version: string): boolean {
    const dir = this.dir(name, version);
    return existsSync(join(dir, RELEASE_FILE)) && verifyVoiceDir(dir).ok;
  }

  release(name: string, version: string): ReleaseT | undefined {
    return readModelRelease(this.dir(name, version));
  }

  /**
   * Unpacks a downloaded archive into `<name>/<version>`, checking the manifest's hashes
   * before it is named; leaves nothing half-done. Returns the directory.
   */
  async stage(archive: string, release: ReleaseT): Promise<string> {
    const name = release.name;
    if (!name) throw new Error("a model release carries no name");
    const version = release.version;
    const final = this.dir(name, version);
    const partial = final + ".partial";
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    try {
      await extractTarGz(archive, partial, { tar: this.tar });
      const check = verifyVoiceDir(partial);
      if (!check.ok) throw new Error(`the archive does not check out: ${check.reason}`);
      if (check.manifest.name !== name) throw new Error(`the archive holds ${check.manifest.name}, not ${name}`);
      writeFileSync(join(partial, RELEASE_FILE), JSON.stringify(release, null, 2) + "\n", "utf8");
      rmSync(final, { recursive: true, force: true });
      renameSync(partial, final);
    } catch (e) {
      rmSync(partial, { recursive: true, force: true });
      throw e;
    }
    return final;
  }

  /** Makes a staged version current and removes the others. */
  promote(name: string, version: string): void {
    if (!this.isComplete(name, version)) throw new Error(`no complete ${name} ${version}`);
    this.writePointer(name, version);
    for (const v of this.versions(name)) {
      if (v !== version) rmSync(this.dir(name, v), { recursive: true, force: true });
    }
  }

  private readPointer(name: string): string | undefined {
    try {
      const v = readFileSync(join(this.modelDir(name), CURRENT_FILE), "utf8").trim();
      return isSemver(v) ? v : undefined;
    } catch {
      return undefined;
    }
  }

  private writePointer(name: string, version: string): void {
    const dir = this.modelDir(name);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `${CURRENT_FILE}.tmp-${process.pid}`);
    writeFileSync(tmp, version + "\n", "utf8");
    renameSync(tmp, join(dir, CURRENT_FILE));
  }
}
