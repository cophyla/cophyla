// Redeeming a node invite, the new machine's side. The invite names a pending grant and
// carries its one-use secret; the link to the primary is sealed with that secret (kind
// `enroll`), on its LAN listener first and through the server relay after, as the invite's
// throwaway relay peer. Inside it `node.enroll` says which node this is, and the primary
// answers the grant's own key, the cluster and how to reach it from then on; the link closes
// and the invite is spent. The ephemeral keys make a recording of the exchange useless even
// to someone who later reads the invite.

import { nodeLinkRequests, RpcError } from "@cophyla/protocol";
import type { InviteBody } from "@cophyla/protocol";
import { pskFromSecret } from "@cophyla/relay";
import type { Logger } from "../log.ts";
import { RpcPeer } from "../rpc/peer.ts";
import type { EnrollResult } from "./inbound.ts";
import { openDirect } from "./outbound.ts";
import type { LinkSocket } from "./outbound.ts";
import { openRelayLink, sealLan } from "./sealed-link.ts";

/** `host:port`, with an IPv6 host in brackets. */
export function endpointOf(host: string, port: number): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]:${port}` : `${host}:${port}`;
}

/** Asks for the grant on a link sealed with the invite's secret; the link is closed after. */
async function enrollOver(sock: LinkSocket, self: { id: string; name: string }, timeoutMs: number, log: Logger, account?: string): Promise<EnrollResult> {
  const rpc = new RpcPeer({ write: (text) => sock.send(text), log, label: "enroll", onRequest: () => Promise.reject(new RpcError("unsupported", "nothing is served while enrolling")) });
  sock.onMessage((text) => rpc.onText(text));
  sock.onClose(() => rpc.close("closed"));
  try {
    const r = await rpc.request("node.enroll", { node: { id: self.id, name: self.name }, ...(account !== undefined ? { account } : {}) }, { timeoutMs });
    const parsed = nodeLinkRequests["node.enroll"].result.safeParse(r);
    if (!parsed.success) throw new RpcError("invalid", "bad node.enroll answer");
    return parsed.data;
  } finally {
    rpc.close("enrolled");
    sock.close(1000, "enrolled");
  }
}

/**
 * Redeems `invite` as this node: each LAN host it names, then the relay. Resolves with what
 * the primary answered and the way it was reached; the first refusal that is the primary's
 * own (the invite spent, expired, or this node already bound elsewhere) is final.
 */
export async function redeemNodeInvite(invite: InviteBody, self: { id: string; name: string }, opts: { timeoutMs: number; log: Logger; now?: number; account?: string }): Promise<EnrollResult & { via: "direct" | "relay" }> {
  if (invite.kind !== "node") throw new RpcError("invalid", "that invite is for a phone, not a node");
  if (invite.expiresAt <= (opts.now ?? Date.now())) throw new RpcError("denied", "that invite has expired");
  if (invite.node.id === self.id) throw new RpcError("conflict", "that invite was minted on this node");
  const psk = await pskFromSecret(invite.secret);
  const failures: string[] = [];
  const failed = (where: string, e: unknown) => failures.push(`${where}: ${e instanceof Error ? e.message : String(e)}`);
  // A refusal inside the sealed link is the primary's own word: the invite is spent or this
  // node is bound elsewhere, and no other way in will say otherwise. A refusal before the
  // seal, or a node that is not the primary, is only this way in.
  const final = (e: unknown) => e instanceof RpcError && (e.code === "denied" || e.code === "invalid" || (e.code === "conflict" && (e.error.data as { primary?: unknown } | undefined)?.primary === undefined));
  for (const host of invite.lan?.hosts ?? []) {
    const endpoint = endpointOf(host, invite.lan!.port);
    let sock: LinkSocket;
    try {
      sock = await sealLan(await openDirect(endpoint, opts.timeoutMs), { grant: invite.grant, kind: "enroll", psk, timeoutMs: opts.timeoutMs });
    } catch (e) {
      failed(endpoint, e);
      continue;
    }
    try {
      return { ...(await enrollOver(sock, self, opts.timeoutMs, opts.log, opts.account)), via: "direct" };
    } catch (e) {
      if (final(e)) throw e;
      failed(endpoint, e);
    }
  }
  if (invite.relay) {
    let sock: LinkSocket | undefined;
    try {
      sock = await openRelayLink({ url: invite.relay.url, token: invite.relay.token, peer: invite.relay.peer, psk, kind: "enroll", timeoutMs: opts.timeoutMs });
    } catch (e) {
      failed("relay", e);
    }
    if (sock) {
      try {
        return { ...(await enrollOver(sock, self, opts.timeoutMs, opts.log, opts.account)), via: "relay" };
      } catch (e) {
        if (final(e)) throw e;
        failed("relay", e);
      }
    }
  }
  throw new RpcError("unavailable", `could not reach ${invite.node.name}${failures.length > 0 ? `: ${failures.join("; ")}` : ": the invite names no way to it"}`);
}
