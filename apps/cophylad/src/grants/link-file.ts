// `data/link.json`: this node's membership of a cluster, the one credential it links with.
// The cluster's first primary writes it for itself when it mints the cluster (`via: self`,
// its self-grant); a machine that redeemed an invite writes it from the enrollment (`via:
// join`): its grant and key, the cluster, its role, the primary it joined and how to reach
// it, what that primary may reach here and whether it asks first. The file is this
// machine's alone: never replicated, never backed up, written readable by its owner only. A
// link closed as `revoked`, a grant that ended and `cophylad leave` remove it.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { ClusterId, Endpoint, GrantId, GrantRole, NodeId, Secret, Timestamp } from "@cophyla/protocol";

export const LinkFile = z.object({
  v: z.literal(1),
  grant: GrantId,
  key: Secret,
  cluster: ClusterId,
  role: GrantRole,
  /** How this node came to the cluster: it minted it (`self`), or it redeemed an invite (`join`). */
  via: z.enum(["self", "join"]),
  /** The primary a joined node enrolled with. */
  primary: z.object({ id: NodeId, name: z.string() }).optional(),
  /** Where the primary's LAN listener was, at the enrollment. */
  endpoints: z.array(Endpoint).optional(),
  /** The server relay, when the primary could grant it: its origin and this node's relay token. */
  relay: z.object({ url: z.string().min(1), token: z.string().min(1) }).optional(),
  /** When the grant ends by itself. */
  expiresAt: Timestamp.optional(),
  /** The folders the primary may reach on this machine; absent, the machine. */
  paths: z.array(z.string().min(1)).optional(),
  /** Asks raised here are answered here only, never from the primary's clients. */
  answerHere: z.boolean().optional(),
  /**
   * The primary's requests are asked here as `[gate.policy.node]` says. Absent, the owner let
   * the primary work here without asking at the join, which is the default.
   */
  askPrimary: z.boolean().optional(),
});
export type LinkFile = z.infer<typeof LinkFile>;

/** The file, or undefined when this node is in no cluster (or the file is not one). */
export function readLinkFile(path: string): LinkFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = LinkFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function writeLinkFile(path: string, file: LinkFile): void {
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}

export function removeLinkFile(path: string): void {
  rmSync(path, { force: true });
}
