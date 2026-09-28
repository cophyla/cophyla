// A workspace node's files, `data/nodes/<slug>/`: `guest.json` says which node it is, the one
// folder it owns and what it runs sessions on; `node.sqlite` keeps its identity, epoch,
// registry and remembered answers; `link.json` its membership, written as the machine's own is
// (grants/link-file.ts). `data/nodes/retired.json` lists the ids of the workspace nodes
// removed: what they left behind (the session ids kept as tombstones) stays private to them.
// All of it is this machine's alone: never replicated, never backed up.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ClusterId, NodeId } from "@cophyla/protocol";

export const GuestManifest = z.object({
  v: z.literal(1),
  id: NodeId,
  /** What the other cluster calls it: `--name`, or the folder's own name. */
  name: z.string().min(1),
  /** The folder it owns, absolute. */
  folder: z.string().min(1),
  /** The profile its sessions run on; absent, each harness's usual one on this machine. */
  profile: z.string().min(1).optional(),
  /** The cluster it was last in: a join into another purges what it holds first. */
  lastCluster: ClusterId.optional(),
});
export type GuestManifest = z.infer<typeof GuestManifest>;

export interface GuestDir {
  slug: string;
  dir: string;
  manifest: GuestManifest;
}

/** Where every workspace node's folder of files is. */
export function guestsRoot(dataDir: string): string {
  return join(dataDir, "nodes");
}

export function guestFiles(dir: string): { manifest: string; db: string; link: string } {
  return { manifest: join(dir, "guest.json"), db: join(dir, "node.sqlite"), link: join(dir, "link.json") };
}

/** Every workspace node on this machine, by its folder of files; one whose manifest does not read is left out. */
export function readGuests(dataDir: string): GuestDir[] {
  const root = guestsRoot(dataDir);
  if (!existsSync(root)) return [];
  const out: GuestDir[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = join(root, e.name);
    const manifest = readManifest(guestFiles(dir).manifest);
    if (manifest) out.push({ slug: e.name, dir, manifest });
  }
  return out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name) || a.slug.localeCompare(b.slug));
}

function readManifest(path: string): GuestManifest | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = GuestManifest.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function writeManifest(dir: string, manifest: GuestManifest): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(guestFiles(dir).manifest, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

/** A folder name for a new workspace node's files: its name, made safe, and a number when taken. */
export function newSlug(dataDir: string, name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 40) || "node";
  const root = guestsRoot(dataDir);
  let slug = base;
  for (let n = 2; existsSync(join(root, slug)); n++) slug = `${base}-${n}`;
  return slug;
}

export function removeGuestDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

const Retired = z.array(NodeId);

function retiredPath(dataDir: string): string {
  return join(guestsRoot(dataDir), "retired.json");
}

/** The ids of the workspace nodes removed from this machine. */
export function readRetired(dataDir: string): string[] {
  const path = retiredPath(dataDir);
  if (!existsSync(path)) return [];
  try {
    const parsed = Retired.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function addRetired(dataDir: string, id: string): void {
  const ids = readRetired(dataDir);
  if (ids.includes(id)) return;
  mkdirSync(guestsRoot(dataDir), { recursive: true });
  writeFileSync(retiredPath(dataDir), JSON.stringify([...ids, id], null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}
