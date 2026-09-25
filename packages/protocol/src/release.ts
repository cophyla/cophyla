// The release feed as bytes: what a signature covers, where a channel's feed lives and what
// an artifact is called. Pure, no crypto: the signing and checking are cophylad's and the
// release scripts', the layout is shared so a feed written by one is read by the other.

import type { Release } from "./entities.ts";

/** Signatures are `ed25519:<base64>` over `releasePayload`. */
export const SIGNATURE_PREFIX = "ed25519:";

/**
 * JSON with keys sorted at every depth, no whitespace and `undefined` fields dropped, so the
 * same entry gives the same bytes wherever it is serialised.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * What the signature covers: every field of the entry except `url`, so one signed entry
 * serves a mirror or a LAN feed, and `signature` itself. Takes the entry as it came off the
 * wire, so a field this package does not know yet is covered too.
 */
export function releasePayload(release: Record<string, unknown>): string {
  const { url: _url, signature: _signature, ...rest } = release;
  return canonicalJson(rest);
}

/** `<channel>/<os>-<arch>.json` under the feed root: the whole request is in the path. */
export function feedPath(channel: string, os: string, arch: string): string {
  return `${channel}/${os}-${arch}.json`;
}

/**
 * The artifact's file name. A model is `model-<name>-<version>.tar.gz`, `name` being the
 * model's; otherwise `release.name` when the feed carries one, else
 * `<component>-<version>[-<os>-<arch>]` with the platform archive as `.tar.gz` and a
 * Windows brain as `.exe`.
 */
export function releaseFileName(release: Pick<Release, "component" | "version" | "os" | "arch" | "name">): string {
  if (release.component === "model") return `model-${release.name ?? "unnamed"}-${release.version}.tar.gz`;
  if (release.name) return release.name;
  const target = release.os && release.arch ? `-${release.os}-${release.arch}` : "";
  const ext = release.component === "platform" ? ".tar.gz" : release.component === "brain" && release.os === "windows" ? ".exe" : "";
  return `${release.component}-${release.version}${target}${ext}`;
}
