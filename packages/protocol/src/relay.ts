// The relay peer socket: a phone's WebSocket at the server's `/ws/relay`, JSON-RPC like
// the others. The phone authenticates with the relay token its pairing node minted
// (`relay.grant` on the server link), opens one tunnel to that node with an ephemeral key,
// and from then on every frame of the client protocol travels as a `relay` notification
// whose `frame` is ciphertext only the two ends can open. The server routes by `peer` and
// reads nothing else. A phone not paired yet authenticates with the grant its account
// sign-in returned instead, and its tunnel is the `pair` kind, to one of the account's
// nodes. See architecture.md, "Server link" and packages/relay.

import { z } from "zod";
import { NodeId } from "./ids.ts";
import { RelayCurve } from "./server-link.ts";

/** A PKCE code verifier (RFC 7636): 43 to 128 characters of the unreserved set. */
export const PkceVerifier = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/, { message: "expected a PKCE verifier" });

/** Requests the phone sends on `/ws/relay`. */
export const relayPeerRequests = {
  /**
   * First frame. A paired phone presents its relay token and speaks as its controller id;
   * a phone pairing through the account presents the grant its sign-in returned and the
   * verifier it kept, spends the grant, and speaks as an id of this pairing alone, told
   * the account it signed in as.
   */
  "relay.auth": {
    params: z.union([z.object({ token: z.string() }), z.object({ grant: z.string().min(1), verifier: PkceVerifier })]),
    result: z.object({ peer: z.string().min(1), subject: z.string().optional(), login: z.string().optional() }),
  },
  /**
   * Opens the tunnel: the phone's ephemeral public key; the answer is the node's id and key.
   * A paired phone's goes to its pairing node; a pairing phone's to `node`, or the node the
   * server picks, whose name comes back to show.
   */
  "relay.open": {
    params: z.object({ epk: z.string().describe("ephemeral public key, base64"), curve: RelayCurve.optional(), node: NodeId.optional() }),
    result: z.object({ peer: NodeId, epk: z.string(), name: z.string().optional() }),
  },
} as const;

export type RelayPeerRequestName = keyof typeof relayPeerRequests;

/** Frames that flow in both directions on `/ws/relay`. */
export const relayPeerFrames = {
  /** A record of the tunnel, base64 ciphertext; `peer` is the far end. */
  relay: z.object({ peer: z.string().min(1), frame: z.string() }),
  "relay.close": z.object({ peer: z.string().min(1), reason: z.string().optional() }),
} as const;

export type RelayPeerFrameName = keyof typeof relayPeerFrames;

/** The close code of a peer socket whose token is unknown, revoked, or on a plan without the relay; or whose grant is spent. */
export const RELAY_UNAUTHORIZED = 4401;
/** The close code of a peer socket whose tunnel or node went away. */
export const RELAY_GONE = 4409;
