// The sign-in door updates itself: the shim it runs under stays as the administrator installed
// it, while the door's own version (Bun, cophylad's tree, the direct connections' helper)
// follows the platform from the same signed feed the daemon reads (`update/feed.ts`,
// `verify.ts`, `download.ts`, `archive.ts`). It takes the version the daemon on this machine
// runs, once the daemon is newer, or, when the primary refused its protocol, the newest
// release whose protocol range covers the primary's; never an older one than its own, nor
// one marked broken. The archive unpacks beside the running version; `previous` and `current`
// are moved, the helper's fixed copy is refreshed, and the door exits EXIT_UPDATED for the
// shim to start the new one at once (the shim falls back to `previous` if it keeps failing).

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Release } from "@cophyla/protocol";
import type { UpdateConfig } from "../config/schema.ts";
import type { Logger } from "../log.ts";
import { extractTarGz } from "../update/archive.ts";
import { download } from "../update/download.ts";
import { feedUrl, hostTarget, isSemver, newer, selectReleases, urlAllowed } from "../update/feed.ts";
import { RELEASE_KEYS } from "../update/keys.ts";
import { BROKEN_MARKER, BUN_NAME, defaultTar, NET_PATH, RELEASE_FILE } from "../update/platform.ts";
import { programPaths } from "./constants.ts";

/** The door's entry point inside a version folder. */
export const DOOR_MAIN = join("cophylad", "apps", "cophylad", "src", "main.ts");

export interface ProgramDeps {
  program: string;
  /** Where downloads wait: the door's own `tmp/`. */
  tmp: string;
  log: Logger;
  fetch?: typeof fetch;
  tar?: string;
  keys?: string[];
}

/** What the door is asked to move to: the daemon's version, or a release that speaks the primary's protocol. */
export type UpdateWant = { version: string } | { protocol: number };

/** One line of a pointer file in the program folder. */
export function readProgramPointer(program: string, name: "current" | "previous"): string | undefined {
  try {
    const v = readFileSync(join(program, name), "utf8").trim();
    return isSemver(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The release to move to, from the feed's accepted entries: never older than `running`, never broken. */
export function pickRelease(accepted: Release[], running: string, want: UpdateWant, broken: (v: string) => boolean): Release | undefined {
  const platform = accepted.filter((r) => r.component === "platform" && newer(r.version, running) && !broken(r.version));
  if ("version" in want) return platform.find((r) => r.version === want.version);
  let best: Release | undefined;
  for (const r of platform) {
    if (r.protocol && (r.protocol.min > want.protocol || r.protocol.max < want.protocol)) continue;
    if (!best || newer(r.version, best.version)) best = r;
  }
  return best;
}

export class DoorProgram {
  private deps: ProgramDeps;
  private log: Logger;
  private busy?: Promise<string | undefined>;

  constructor(deps: ProgramDeps) {
    this.deps = deps;
    this.log = deps.log;
  }

  private versionDir(v: string): string {
    return join(programPaths(this.deps.program).versions, v);
  }

  private broken(v: string): boolean {
    return existsSync(join(this.versionDir(v), BROKEN_MARKER));
  }

  /**
   * Looks at the feed and, when there is a release to move to, stages it as `current`;
   * resolves with its version (the caller exits for the shim to start it), or undefined.
   * One look at a time.
   */
  update(running: string, want: UpdateWant, feed: UpdateConfig): Promise<string | undefined> {
    this.busy ??= this.run(running, want, feed).finally(() => {
      this.busy = undefined;
    });
    return this.busy;
  }

  private async run(running: string, want: UpdateWant, feed: UpdateConfig): Promise<string | undefined> {
    if ("version" in want && !newer(want.version, running)) return undefined;
    const { os, arch } = hostTarget();
    const url = feedUrl(feed.feed, feed.channel, os, arch);
    if (!urlAllowed(url, feed.allow_insecure_feed)) throw new Error(`the feed ${url} is not one the door may read`);
    const res = await (this.deps.fetch ?? fetch)(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`the feed answered ${res.status}`);
    const sel = selectReleases(await res.json(), { os, arch, channel: feed.channel, ...("protocol" in want ? { protocolVersion: want.protocol } : {}) }, this.deps.keys ?? RELEASE_KEYS);
    const release = pickRelease(sel.accepted, running, want, (v) => this.broken(v));
    if (!release) {
      this.log.info("no release for the sign-in door to move to", { running, want, accepted: sel.accepted.length });
      return undefined;
    }
    if (!urlAllowed(release.url, feed.allow_insecure_feed)) throw new Error(`the release's address ${release.url} is not one the door may fetch`);
    mkdirSync(this.deps.tmp, { recursive: true });
    const archive = join(this.deps.tmp, `platform-${release.version}.tar.gz`);
    this.log.info("the sign-in door fetches a new version", { from: running, to: release.version });
    await download(release.url, archive, { size: release.size, sha256: release.sha256, ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) });
    try {
      await this.stage(archive, release);
    } finally {
      rmSync(archive, { force: true });
    }
    return release.version;
  }

  /** Unpacks a version beside the running one, then moves the pointers and the helper's fixed copy. */
  private async stage(archive: string, release: Release): Promise<void> {
    const v = release.version;
    const final = this.versionDir(v);
    const partial = final + ".partial";
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    try {
      await extractTarGz(archive, partial, { tar: this.deps.tar ?? defaultTar() });
      for (const need of [BUN_NAME, DOOR_MAIN]) if (!existsSync(join(partial, need))) throw new Error(`the archive has no ${need}`);
      writeFileSync(join(partial, RELEASE_FILE), JSON.stringify(release, null, 2) + "\n", "utf8");
      rmSync(final, { recursive: true, force: true });
      renameSync(partial, final);
    } catch (e) {
      rmSync(partial, { recursive: true, force: true });
      throw e;
    }
    const net = join(final, NET_PATH);
    if (existsSync(net)) {
      const fixed = programPaths(this.deps.program).net;
      mkdirSync(dirname(fixed), { recursive: true });
      copyFileSync(net, fixed);
    }
    const current = readProgramPointer(this.deps.program, "current");
    if (current && current !== v) writeFileSync(join(this.deps.program, "previous"), current + "\n", "utf8");
    writeFileSync(join(this.deps.program, "current"), v + "\n", "utf8");
    this.prune([v, ...(current ? [current] : [])]);
    this.log.info("the sign-in door staged a new version", { version: v, previous: current });
  }

  /** Removes version folders but `keep`, partial ones included. */
  private prune(keep: string[]): void {
    const dir = programPaths(this.deps.program).versions;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (keep.includes(name)) continue;
      try {
        rmSync(join(dir, name), { recursive: true, force: true });
      } catch {
        // in use; the next update tries again
      }
    }
  }
}
