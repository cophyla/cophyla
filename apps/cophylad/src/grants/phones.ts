// Phone invites: a client with the `controllers` scope mints one (`grant.invite {kind:
// "controller"}`) with access no wider than its own, and the phone redeems it before `hello`
// (`invite.redeem`) on the LAN listener, pinned by the key the invite names, or through the
// server relay on the invite's own throwaway peer, keyed from the invite's secret. The check
// and the burn happen with nothing in between; what the phone gets is a token of its own, a
// relay token and key minted fresh for its real id, and the LAN listener's pin. Once the
// phone has its answer the throwaway peer is let go. A phone that left before its answer
// never held the token: its invite is opened again, and the relay access minted for it goes.

import { inviteLink, inviteText, newId, RpcError, validateAccess } from "@cophyla/protocol";
import type { Access, Controller, Grant, InviteBody, InviteOffer, PairedLan, RelayAccess } from "@cophyla/protocol";
import type { Logger } from "../log.ts";
import type { Lifetime } from "./lifetime.ts";
import { boundedBy } from "./lifetime.ts";
import type { Grants, InviteRow, RedeemHow } from "./store.ts";

/** How long a phone's invite may be redeemed when the minter does not say. */
export const DEFAULT_PHONE_INVITE_MS = 15 * 60_000;

export interface PhoneInvitesDeps {
  grants: Grants;
  identity: { id: string; name: string };
  /** The LAN listener as an invite names it: its addresses, port and key; nothing while it is down. */
  lan: () => InviteBody["lan"] | undefined;
  /** The LAN listener as a redeemed phone pins it. */
  lanPin: () => PairedLan | undefined;
  /** A relay token for a peer, when this node is signed in and its plan has the relay. */
  relayGrant?: (peer: string, opts: { kind: "controller"; name: string; expiresAt: number }) => Promise<{ url: string; token: string }>;
  /** The relay access a redeemed phone gets for its real id; nothing when the node cannot mint it now. */
  relayAccess: (id: string, name: string) => Promise<RelayAccess | undefined>;
  revokeRelay: (peer: string) => void;
  log: Logger;
  now?: () => number;
}

/** A redemption's answer, and what the api does once the phone has it, or has gone without it. */
export interface Redeemed {
  answer: { token: string; client: Controller; relay?: RelayAccess; lan?: PairedLan };
  /** The phone has its answer: the invite's throwaway relay peer goes. */
  settle(): void;
  /** The phone left before its answer: the invite is open again, and the relay access minted for it goes. */
  abandon(): void;
}

export class PhoneInvites {
  private deps: PhoneInvitesDeps;

  constructor(deps: PhoneInvitesDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Mints a phone's pending grant and the invite that redeems it; `minter` bounds the access it may carry, and `held` how long it may run. */
  async invite(opts: { name: string; access: Access; expiresIn?: number; inviteExpiresIn?: number }, minter: Access, held: Lifetime = {}): Promise<{ grant: Grant; invite: InviteOffer }> {
    const why = validateAccess(opts.access, minter);
    if (why) throw new RpcError("invalid", why);
    const now = this.now();
    const inviteExpiresAt = now + (opts.inviteExpiresIn ?? DEFAULT_PHONE_INVITE_MS);
    const expiresAt = boundedBy(held, opts.expiresIn !== undefined ? now + opts.expiresIn : undefined, now, "invites nobody");
    if (expiresAt !== undefined && expiresAt <= inviteExpiresAt) throw new RpcError("invalid", "the grant would end before its invite does");
    const lan = this.deps.lan();
    let relay: InviteBody["relay"];
    if (this.deps.relayGrant) {
      const peer = newId("controller", now);
      try {
        const r = await this.deps.relayGrant(peer, { kind: "controller", name: `invite for ${opts.name}`, expiresAt: inviteExpiresAt });
        relay = { url: r.url, peer, token: r.token };
      } catch (e) {
        this.deps.log.debug("no relay for the phone invite", { error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (!lan && !relay) throw new RpcError("unavailable", "no way in for a phone: turn on [controller] for the LAN listener, or sign in for the relay");
    const { row, secret } = this.deps.grants.mint({ kind: "controller", name: opts.name, access: opts.access, ...(expiresAt !== undefined ? { expiresAt } : {}), inviteExpiresAt, ...(relay ? { invitePeer: relay.peer } : {}) });
    const body: InviteBody = { v: 1, kind: "controller", grant: row.id, secret, expiresAt: inviteExpiresAt, node: { id: this.deps.identity.id, name: this.deps.identity.name }, ...(lan ? { lan } : {}), ...(relay ? { relay } : {}) };
    this.deps.log.info("phone invited", { grant: row.id, name: opts.name, lan: lan !== undefined, relay: relay !== undefined, inviteExpiresAt, ...(expiresAt !== undefined ? { expiresAt } : {}) });
    return { grant: this.deps.grants.entity(row), invite: { text: inviteText(body), link: inviteLink(body), expiresAt: inviteExpiresAt } };
  }

  /**
   * Redeems a phone's invite: the grant gets a token and a key of its own and the invite burns.
   * `peer` is the throwaway relay peer the redemption came in on, which must be this invite's.
   */
  async redeem(p: { grant: string; secret: string }, via: { peer?: string } = {}, how: RedeemHow = {}): Promise<Redeemed> {
    const grants = this.deps.grants;
    const { row, token, invite, pending } = grants.redeemController(p.grant, p.secret, via.peer, how);
    let relay: RelayAccess | undefined;
    // a browser's page reaches the node on its own origin alone: no relay access is minted for it
    if (row.form !== "browser") {
      try {
        relay = await this.deps.relayAccess(row.id, row.name);
      } catch {
        relay = undefined;
      }
    }
    const lan = this.deps.lanPin();
    const client = grants.controllerEntity(grants.get(row.id) ?? row);
    this.deps.log.info("phone invite redeemed", { grant: row.id, name: row.name, via: via.peer !== undefined ? "relay" : "lan", relay: relay !== undefined });
    return {
      answer: { token, client: relay ? { ...client, relay: true } : client, ...(relay ? { relay } : {}), ...(lan ? { lan } : {}) },
      settle: () => this.settle(invite),
      abandon: () => {
        if (relay) this.deps.revokeRelay(row.id);
        grants.reopen(pending);
        this.deps.log.warn("a phone left before its invite's answer; the invite is open again", { grant: row.id });
      },
    };
  }

  private settle(invite: InviteRow): void {
    if (invite.peer) this.deps.revokeRelay(invite.peer);
  }
}
