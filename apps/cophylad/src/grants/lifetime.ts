// How long what a client mints may run. A grant with an end mints nothing that outlives it: a
// phone's invite, a node's, a browser's key and the code of a pairing window it opens all end
// no later than the grant of the client that made them. A shared computer's session mints
// nothing at all. These close the protocol's own ways around an end. They are hygiene, not a
// wall: a grant with full access holds `terminal`, and a shell is the machine.

import { RpcError } from "@cophyla/protocol";

/** What the client asking holds its own credential for: until when, and whether it is a shared computer's session. */
export interface Lifetime {
  ends?: number;
  session?: boolean;
}

/**
 * When something `held` mints ends: when it was asked to (`expiresAt`), and no later than the
 * minter's own grant does; undefined when neither bounds it. `what` ends the sentence a
 * session is refused with ("invites nobody").
 */
export function boundedBy(held: Lifetime, expiresAt: number | undefined, now: number, what: string): number | undefined {
  if (held.session) throw new RpcError("denied", `a session on a shared computer ${what}`);
  if (held.ends === undefined) return expiresAt;
  if (held.ends <= now) throw new RpcError("denied", "this access has ended");
  return expiresAt === undefined ? held.ends : Math.min(expiresAt, held.ends);
}
