// Maintains the static feed under `stage/feed/<channel>/<os>-<arch>.json`: `--add` merges
// signed entries (`*.release.json`) into the files for their channel and target, replacing an
// entry with the same key, newest first. A platform or brain entry belongs to one target and
// goes into one file; a model names no OS and runs wherever the platform does, so it goes
// into every target's file of its channel. `--list` prints what a feed holds. The files are
// what the `feed` branch carries and what serve-feed.ts serves on the LAN.
//   bun run apps/installer/scripts/feed.ts --add stage/out/platform-0.1.1-windows-x64.tar.gz.release.json [more…]
//   bun run apps/installer/scripts/feed.ts --list

import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Release, ReleaseFeed } from "@cophyla/protocol";
import type { Release as ReleaseT } from "@cophyla/protocol";
import { newer } from "../../cophylad/src/update/feed.ts";
import { RELEASE_KEYS } from "../../cophylad/src/update/keys.ts";
import { verifyRelease } from "../../cophylad/src/update/verify.ts";
import { ensureDir, fail, FEED_DIR, log, readJson, TARGETS } from "./lib.ts";

/** What makes two entries the same release: a model is keyed by its name as well. */
export function releaseKey(release: Pick<ReleaseT, "component" | "version" | "name">): string {
  return release.component === "model" ? `model/${release.name}@${release.version}` : `${release.component}@${release.version}`;
}

/**
 * The feed files, relative to the feed root, that an entry belongs in: one for a platform or
 * a brain release, and for a model every target the feed is meant to carry plus every file
 * of that channel already there, so a target added by hand is not left behind. Pure.
 */
export function feedFilesFor(release: ReleaseT, existing: string[] = []): string[] {
  if (release.component !== "model") {
    if (!release.os || !release.arch) fail(`${release.component} ${release.version} has no os/arch; a feed file needs both`);
    return [`${release.channel}/${release.os}-${release.arch}.json`];
  }
  const wanted = new Set(TARGETS.map((t) => `${release.channel}/${t.os}-${t.arch}.json`));
  for (const path of existing) if (path.startsWith(`${release.channel}/`)) wanted.add(path);
  return [...wanted].sort();
}

/** Puts one entry into one feed's list, replacing the one it supersedes. Pure. */
export function mergeInto(releases: ReleaseT[], release: ReleaseT): ReleaseT[] {
  const key = releaseKey(release);
  const out = releases.filter((r) => releaseKey(r) !== key);
  out.push(release);
  out.sort(order);
  return out;
}

function order(a: ReleaseT, b: ReleaseT): number {
  if (a.component !== b.component) return a.component.localeCompare(b.component);
  if (a.component === "model" && a.name !== b.name) return (a.name ?? "").localeCompare(b.name ?? "");
  return newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0;
}

/** Every `<channel>/<os>-<arch>.json` a feed directory holds now, relative to its root. */
export function feedFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const channel of readdirSync(dir)) {
    const path = join(dir, channel);
    if (!statSync(path).isDirectory()) continue;
    for (const file of readdirSync(path)) if (file.endsWith(".json")) out.push(`${channel}/${file}`);
  }
  return out.sort();
}

function load(path: string): ReleaseFeed {
  if (!existsSync(path)) return { releases: [] };
  const parsed = ReleaseFeed.safeParse(readJson(path));
  if (!parsed.success) fail(`${path} is not a feed: ${parsed.error.message}`);
  return parsed.data;
}

/** Merges one verified entry into every file it belongs in, under `root`. */
export function addToFeed(root: string, release: ReleaseT): string[] {
  const written: string[] = [];
  for (const rel of feedFilesFor(release, feedFiles(root))) {
    const path = join(root, rel);
    const releases = mergeInto(load(path).releases, release);
    ensureDir(join(path, ".."));
    writeFileSync(path, JSON.stringify({ generatedAt: Date.now(), releases }, null, 2) + "\n");
    log(`${path}: + ${releaseKey(release)} (${releases.length} entries)`);
    written.push(rel);
  }
  return written;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: { add: { type: "boolean" }, list: { type: "boolean" }, dir: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  const root = values.dir ?? FEED_DIR;

  if (values.add) {
    if (positionals.length === 0) fail("--add needs at least one *.release.json");
    for (const file of positionals) {
      const parsed = Release.safeParse(readJson(file));
      if (!parsed.success) fail(`${file}: not a Release: ${parsed.error.message}`);
      if (!verifyRelease(readJson(file) as Record<string, unknown>, RELEASE_KEYS)) fail(`${file}: the signature does not check against RELEASE_KEYS`);
      addToFeed(root, parsed.data);
    }
  } else if (values.list) {
    if (!existsSync(root)) fail(`no feed at ${root}`);
    for (const rel of feedFiles(root)) {
      log(`${rel}:`);
      for (const r of load(join(root, rel)).releases) {
        log(`  ${(r.component === "model" ? `model/${r.name}` : r.component).padEnd(24)} ${r.version.padEnd(8)} ${r.size} bytes  ${r.url}`);
      }
    }
  } else {
    fail("pass --add <files…> or --list");
  }
}
