// A connection's own link: what the two primaries of two Cophyla users say to each other, in
// a relay tunnel sealed from the first frame to the last, and nothing else. A tunnel of the
// invite's throwaway peer, keyed from the invite's secret, answers `connection.redeem` and
// `connection.confirm` alone; a tunnel of a live connection's peer, keyed from the key the two
// share, answers the `conn.*` requests alone, each about that connection and no other. The
// requests carry no address: a message that comes in on a connection's tunnel can only reach
// the terminal that connection lives with. Each end opens a tunnel of its own to send on,
// with the token the other end minted it, so the far end is metered for what it is sent.
//
// An identity is the server's word on who a user is: a token it signs with the entitlement
// key, naming the account and its GitHub login and bound to one exchange (`aud`), so it says
// nothing anywhere else. Each end asks its own server link for one and verifies the other's
// against the keys it ships with.

import { z } from "zod";
import { HarnessKind } from "./entities.ts";
import { AgentMessageId, ConnectionId, Timestamp } from "./ids.ts";
import { ConnectionRelay, Secret } from "./invite.ts";

/** One end of a connection as the other is told it: its name, the agent there now, whether one runs. */
export const ConnectionEndInfo = z.object({
  name: z.string().min(1).max(120),
  harness: HarnessKind.optional(),
  live: z.boolean(),
});
export type ConnectionEndInfo = z.infer<typeof ConnectionEndInfo>;

/** The longest message a connection carries: half of what an agent may send its own user's. */
export const CONNECTION_MAX_CHARS = 16_000;

/** What a message that came in on a connection became: delivered, held in the receiving terminal, waiting on its user, or kept until an agent runs there. */
export const ConnectionSendStatus = z.enum(["sent", "held", "pending", "waiting"]);
export type ConnectionSendStatus = z.infer<typeof ConnectionSendStatus>;

export const connectionLinkRequests = {
  /**
   * The redeemer, on the invite's tunnel: who it is (an identity whose `aud` is the invite's
   * `redeemer` audience), its end, and the relay peer the minter is to reach it by. Answered
   * with the minter's identity, end, relay peer and the key the connection's tunnels are
   * keyed from. The invite is spent; it opens again if no `connection.confirm` follows on
   * this tunnel.
   */
  "connection.redeem": {
    params: z.object({ id: ConnectionId, identity: z.string().min(1).max(4096), end: ConnectionEndInfo, relay: ConnectionRelay }),
    result: z.object({ identity: z.string().min(1).max(4096), end: ConnectionEndInfo, relay: ConnectionRelay, key: Secret }),
  },
  /** The redeemer kept the connection: both ends hold it from here. */
  "connection.confirm": { params: z.object({ id: ConnectionId }), result: z.object({}) },
  /**
   * A message from the agent at the sending end to the one at this end. `hops` counts its
   * conversation as the sender's side sees it; this end counts its own as well.
   */
  "conn.send": {
    params: z.object({
      id: AgentMessageId,
      text: z.string().min(1).max(CONNECTION_MAX_CHARS),
      replyTo: AgentMessageId.optional(),
      from: ConnectionEndInfo,
      sentAt: Timestamp,
    }),
    result: z.object({ status: ConnectionSendStatus }),
  },
  /** A message this end sent was not delivered after all: refused once it waited, or kept past its time. */
  "conn.notice": { params: z.object({ about: AgentMessageId, why: z.string().min(1).max(300) }), result: z.object({}) },
  /** The sending end's terminal changed: another agent there, or none. */
  "conn.state": { params: ConnectionEndInfo, result: z.object({}) },
  /** The sending end ended the connection: its terminal closed, or someone ended it there. */
  "conn.end": { params: z.object({ reason: z.string().min(1).max(200) }), result: z.object({}) },
} as const;

export type ConnectionLinkRequestName = keyof typeof connectionLinkRequests;

/** The audiences of a redemption's two identities: bound to the invite, and to which end speaks. */
export function identityAudience(secretHash: string, end: "redeemer" | "inviter"): string {
  return `cophyla-connect/1|${secretHash}|${end}`;
}

/** What a server-signed identity says: `typ` sets it apart from any other token under the same key. */
export const IdentityClaims = z.object({
  typ: z.literal("cophyla-identity"),
  sub: z.string().min(1),
  login: z.string().min(1).max(64),
  aud: z.string().min(1).max(300),
  iat: Timestamp,
  exp: Timestamp,
});
export type IdentityClaims = z.infer<typeof IdentityClaims>;
