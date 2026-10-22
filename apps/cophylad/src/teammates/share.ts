// What a side shares with a teammate, read against where an agent works. A folder shared takes
// in every folder under it, as the session scope's folders do; `exclude` shares every
// workspace but those named and what is under them, and a workspace that appears after the
// teammate was made is shared closed until the user opens or excludes it. Paths are compared as
// the machine they are on compares them.

import type { TeammatePlace, TeammateShare } from "@cophyla/protocol";
import { isWithin } from "../sessions/paths.ts";

/** A node's platform as `node:path` names it: win32, darwin or linux. */
export type PathPlatform = string;

/** Whether `path` on `node` lies in one of `places`. */
export function within(places: readonly TeammatePlace[], node: string, path: string, platformOf: (node: string) => PathPlatform): boolean {
  return places.some((p) => p.node === node && isWithin(path, p.path, platformOf(node)));
}

/** Whether a share takes in `path` on `node`: in an included folder, or in no excluded one. */
export function shares(share: TeammateShare, node: string, path: string, platformOf: (node: string) => PathPlatform): boolean {
  const inside = within(share.folders, node, path, platformOf);
  return share.mode === "include" ? inside : !inside;
}

/** A place's key: its node and its path as that machine compares paths. */
export function placeKey(node: string, path: string, platformOf: (node: string) => PathPlatform): string {
  const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const platform = platformOf(node);
  return `${node}|${platform === "win32" || platform === "darwin" ? p.toLowerCase() : p}`;
}

/** A share as a client sends it, tidied: no repeats, the lists it needs. */
export function tidyShare(share: TeammateShare): TeammateShare {
  const seen = new Set<string>();
  const folders = share.folders.filter((f) => {
    const k = `${f.node}|${f.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    mode: share.mode,
    folders,
    open: share.open,
    ...(share.opened && share.opened.length > 0 ? { opened: [...new Set(share.opened)] } : {}),
    ...(share.closed && share.closed.length > 0 ? { closed: share.closed } : {}),
  };
}

/** The folders a share names that are too wide to share without a word: a home folder or a drive's root. */
export function tooWide(share: TeammateShare, homes: (node: string) => string | undefined): TeammatePlace[] {
  if (share.mode !== "include") return [];
  return share.folders.filter((f) => {
    const p = f.path.replace(/\\/g, "/").replace(/\/+$/, "");
    if (/^[A-Za-z]:$/.test(p) || p === "" || p === "/") return true;
    const home = homes(f.node)?.replace(/\\/g, "/").replace(/\/+$/, "");
    return home !== undefined && p.toLowerCase() === home.toLowerCase();
  });
}
