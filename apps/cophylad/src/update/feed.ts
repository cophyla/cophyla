// Reading a feed: which entries this node may take, and which of those is the newest. Pure:
// the fetch, the disk and the clock are the caller's.

import { feedPath, PROTOCOL_VERSION, ReleaseFeed } from "@cophyla/protocol";
import type { Release } from "@cophyla/protocol";
import { verifyRelease } from "./verify.ts";

export interface FeedTarget {
  os: string;
  arch: string;
  channel: string;
  protocolVersion?: number;
}

export interface Dropped {
  release: Record<string, unknown>;
  reason: string;
}

export interface Selection {
  accepted: Release[];
  dropped: Dropped[];
}

/** A version this module compares: three dot-separated integers and an optional pre-release tag. */
export const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function isSemver(v: string | undefined): v is string {
  return v !== undefined && SEMVER.test(v);
}

/** `a` is newer than `b`; either invalid means no. */
export function newer(a: string, b: string): boolean {
  if (!isSemver(a) || !isSemver(b)) return false;
  return Bun.semver.order(a, b) > 0;
}

/** The entries of a body that looks like a feed, parsed or not, for the drop log. */
function rawEntries(body: unknown): Record<string, unknown>[] {
  const releases = body && typeof body === "object" ? (body as { releases?: unknown }).releases : undefined;
  if (!Array.isArray(releases)) return [];
  return releases.map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : {}));
}

/**
 * Parses a feed body and keeps the entries that are signed by one of `keys`, are for this
 * OS, architecture and channel, and whose protocol range contains ours. Every drop carries
 * its reason, for the log.
 */
export function selectReleases(body: unknown, target: FeedTarget, keys: string[]): Selection {
  const protocolVersion = target.protocolVersion ?? PROTOCOL_VERSION;
  const accepted: Release[] = [];
  const dropped: Dropped[] = [];
  const feed = ReleaseFeed.safeParse(body);
  if (!feed.success) {
    const raws = rawEntries(body);
    if (raws.length === 0) dropped.push({ release: {}, reason: "feed invalid" });
    for (const raw of raws) dropped.push({ release: raw, reason: "entry invalid" });
    return { accepted, dropped };
  }
  const raws = rawEntries(body);
  feed.data.releases.forEach((release, i) => {
    const raw = raws[i]!;
    const drop = (reason: string) => dropped.push({ release: raw, reason });
    if (!verifyRelease(raw, keys)) return drop("bad signature");
    if (release.component !== "model" && (!release.os || !release.arch)) return drop("no os or arch");
    if (release.os !== undefined && release.os !== target.os) return drop(`os ${release.os}`);
    if (release.arch !== undefined && release.arch !== target.arch) return drop(`arch ${release.arch}`);
    if (release.channel !== target.channel) return drop(`channel ${release.channel}`);
    if (release.protocol && (release.protocol.min > protocolVersion || release.protocol.max < protocolVersion)) {
      return drop(`protocol range ${release.protocol.min}-${release.protocol.max} excludes ${protocolVersion}`);
    }
    if (!isSemver(release.version)) return drop(`version ${release.version} is not semver`);
    accepted.push(release);
  });
  return { accepted, dropped };
}

/**
 * The highest version of `component` above `current`, leaving out `skip`. An invalid
 * `current` is never updated: a brain that says `fake-0.1` stays.
 */
export function newest(accepted: Release[], component: Release["component"], current: string | undefined, skip: Iterable<string> = []): Release | undefined {
  if (!isSemver(current)) return undefined;
  const skipped = new Set(skip);
  let best: Release | undefined;
  for (const r of accepted) {
    if (r.component !== component || skipped.has(r.version)) continue;
    if (!newer(r.version, current)) continue;
    if (!best || newer(r.version, best.version)) best = r;
  }
  return best;
}

/** `<feed>/<channel>/<os>-<arch>.json`, whatever trailing slash the base has. */
export function feedUrl(base: string, channel: string, os: string, arch: string): string {
  return `${base.replace(/\/+$/, "")}/${feedPath(channel, os, arch)}`;
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1)$/i;

/** `https:` anywhere; `http:` on loopback, or elsewhere only with `allowInsecure`. */
export function urlAllowed(url: string, allowInsecure = false): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  if (u.protocol !== "http:") return false;
  return LOOPBACK.test(u.hostname) || allowInsecure;
}

/** This process as the feed names it: `windows|macos|linux` and `x64|arm64`. */
export function hostTarget(): { os: string; arch: string } {
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : process.platform;
  return { os, arch: process.arch };
}
