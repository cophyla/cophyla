// The kit: what the user's daemon hands its machine's sign-in door, so the door can join the
// primary as this machine while the daemon is not running. The node's id and name, its
// membership (link.json, its grant's key with it), the primary it last linked to and the
// cluster's primary and backups, the desktop host's kind and credentials, the screen size,
// the remote, direct-connection, node-link and update settings, the machines that paired a
// viewer with this desktop (whom the door lets in unasked), and what the door must not serve
// for: a hands node, a confined one, sharing off, or the primary itself. The daemon sends it
// as it attaches and again whenever any of it changes; the door keeps it in its own home,
// behind its protected folder, and it is good for KIT_TTL_MS after the daemon last attached.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DisplaySize, NodeId, NodeRecord, Timestamp } from "@cophyla/protocol";
import type { NodeRecord as NodeRecordType } from "@cophyla/protocol";
import { DirectConfig, NodesConfig, RemoteConfig, UpdateConfig } from "../config/schema.ts";
import type { Config } from "../config/schema.ts";
import { LinkFile, readLinkFile } from "../grants/link-file.ts";
import { KIT_TTL_MS } from "./constants.ts";

export const Kit = z.object({
  v: z.literal(1),
  node: z.object({ id: NodeId, name: z.string().min(1) }),
  link: LinkFile,
  /** The primary the node last linked to: its id, epoch and endpoints. */
  lastPrimary: z.object({ id: NodeId, epoch: z.number().int().nonnegative(), endpoints: z.array(z.string()) }).optional(),
  /** The cluster's primary and backups as the node last heard them: where the door looks for the primary. */
  registry: z.array(NodeRecord),
  epoch: z.number().int().nonnegative(),
  /** The desktop host and its web credentials; absent while the daemon knows none. */
  host: z.object({ kind: z.enum(["apollo", "sunshine"]), username: z.string().min(1), password: z.string().min(1) }).optional(),
  /** The primary display, which the stream is sized to. */
  display: DisplaySize.optional(),
  remote: RemoteConfig,
  direct: z.object({ enabled: z.boolean(), config: DirectConfig }),
  nodes: NodesConfig,
  update: UpdateConfig,
  /** The machines that paired a viewer of their own with this desktop: let in unasked. */
  machines: z.array(NodeId),
  /** What the door must not serve for. */
  sharing: z.boolean(),
  hands: z.boolean(),
  confined: z.boolean(),
  primary: z.boolean(),
  platform: z.object({ version: z.string(), protocol: z.number().int() }),
  /** When the daemon last attached: the kit is good for KIT_TTL_MS from then. */
  attachedAt: Timestamp,
});
export type Kit = z.infer<typeof Kit>;

/** What the daemon reads a kit from. */
export interface KitSources {
  node: () => { id: string; name: string };
  /** `data/link.json`. */
  linkFile: string;
  /** `data/remote`: `host.json`, the host's credentials the daemon set. */
  remoteDir: string;
  config: Pick<Config, "remote" | "direct" | "nodes" | "update">;
  role: () => "primary" | "secondary";
  hands: () => boolean;
  confined: () => boolean;
  registry: () => NodeRecordType[];
  epoch: () => number;
  lastPrimary: () => Kit["lastPrimary"];
  hostKind: () => "apollo" | "sunshine" | "none";
  display: () => z.infer<typeof DisplaySize> | undefined;
  sharing: () => boolean;
  directEnabled: () => boolean;
  machines: () => string[];
  platform: { version: string; protocol: number };
  now?: () => number;
}

/** The host's web credentials: the configured pair, else the one the daemon set and kept. */
export function hostCredentials(remote: Pick<Config["remote"], "host_user" | "host_password">, remoteDir: string): { username: string; password: string } | undefined {
  if (remote.host_user && remote.host_password) return { username: remote.host_user, password: remote.host_password };
  const file = join(remoteDir, "host.json");
  if (!existsSync(file)) return undefined;
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as { username?: unknown; password?: unknown };
    return typeof v.username === "string" && v.username && typeof v.password === "string" && v.password ? { username: v.username, password: v.password } : undefined;
  } catch {
    return undefined;
  }
}

/** The kit as it stands now; undefined while the node is in no cluster. */
export function buildKit(src: KitSources): Kit | undefined {
  const link = readLinkFile(src.linkFile);
  if (!link) return undefined;
  const creds = hostCredentials(src.config.remote, src.remoteDir);
  const kind = src.hostKind();
  const display = src.display();
  const last = src.lastPrimary();
  return Kit.parse({
    v: 1,
    node: src.node(),
    link,
    ...(last ? { lastPrimary: last } : {}),
    registry: src.registry().filter((n) => n.role === "primary" || n.backup === true),
    epoch: src.epoch(),
    ...(creds ? { host: { kind: kind === "none" ? "apollo" : kind, ...creds } } : {}),
    ...(display ? { display } : {}),
    remote: src.config.remote,
    direct: { enabled: src.directEnabled(), config: src.config.direct },
    nodes: src.config.nodes,
    update: src.config.update,
    machines: [...new Set(src.machines())],
    sharing: src.sharing(),
    hands: src.hands(),
    confined: src.confined(),
    primary: src.role() === "primary",
    platform: src.platform,
    attachedAt: (src.now ?? Date.now)(),
  });
}

/** Why a kit opens no door now, or undefined when it does. */
export function kitRefusal(kit: Kit | undefined, now: number): string | undefined {
  if (!kit) return "the door has not been handed this machine's membership yet";
  if (kit.hands) return "this machine joined as hands: it has no sign-in door";
  if (kit.confined) return "this machine shares some folders alone, not its desktop";
  if (kit.primary) return "this machine is the primary: it cannot be reached at its sign-in screen yet";
  if (!kit.sharing) return "desktop sharing is off on this machine";
  if (!kit.host) return "the desktop host's credentials are not known";
  if (kit.link.expiresAt !== undefined && kit.link.expiresAt <= now) return "this machine's grant has ended";
  if (now - kit.attachedAt > KIT_TTL_MS) return "Cophyla has not run here for 30 days";
  return undefined;
}

/** Two kits that differ only in when they were made. */
export function sameKit(a: Kit | undefined, b: Kit | undefined): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify({ ...a, attachedAt: 0 }) === JSON.stringify({ ...b, attachedAt: 0 });
}
