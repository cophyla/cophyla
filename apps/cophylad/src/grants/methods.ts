// The grant methods: a client with full access invites a node, and one with the
// `controllers` scope a phone with access no wider than its own (`grant.invite`); anyone
// entitled lists the grants and revokes one, and the desktop of this machine alone joins a
// primary with an invite or leaves it (`node.join`, `node.leave`). An invite's text is shown
// to the one who asked and kept in no audit row; so is the invite a join redeems. A browser on
// another computer is invited with a key (`browser.invite`), which is audited no more than an
// invite's text is. What a client
// whose own grant ends invites ends no later than it does, and a shared computer's session
// invites nobody.

import { FULL, isFull, RpcError } from "@cophyla/protocol";
import type { GrantRole, InviteOffer, Grant } from "@cophyla/protocol";
import type { MethodContext, MethodTable } from "../api/methods.ts";
import { boundedBy } from "./lifetime.ts";
import type { PhoneInvites } from "./phones.ts";
import type { Grants } from "./store.ts";

export interface GrantMethodDeps {
  grants: Grants;
  nodes: {
    invite(opts: { name: string; role: GrantRole; expiresIn?: number; inviteExpiresIn?: number; endsBy?: number }): Promise<{ grant: Grant; invite: InviteOffer }>;
    join(invite: string, opts: { paths?: string[]; answerHere?: boolean; askPrimary?: boolean }): Promise<{ primary: { id: string; name: string }; role: GrantRole }>;
    leave(): Promise<void>;
    revoke(id: string): Promise<void>;
  };
  /** Ends a phone's grant: its sockets close, its relay and push go. */
  revokeController: (id: string) => void;
  phones: Pick<PhoneInvites, "invite" | "browser">;
}

/** Joining and leaving are this machine's to decide: asked on its loopback listener, never from a phone or through the primary. */
export function onThisMachine(ctx: MethodContext, what: string): void {
  if (ctx.listener !== "loopback") throw new RpcError("denied", `${what} is asked on this machine alone`);
}

export function grantMethods(deps: GrantMethodDeps): MethodTable {
  return {
    "grant.invite": {
      target: (p) => p.name,
      redactResult: (r) => ({ ...r, invite: { ...r.invite, text: "[redacted]", link: "[redacted]" } }),
      handler: async (p, ctx) => {
        const own = ctx.client.access ?? FULL;
        if (p.kind === "controller") {
          if (p.role !== undefined) throw new RpcError("invalid", "a phone has access, not a role");
          // what the phone gets is the minter's own access unless it names less
          return deps.phones.invite(
            {
              name: p.name,
              access: p.access ?? own,
              ...(p.expiresIn !== undefined ? { expiresIn: p.expiresIn } : {}),
              ...(p.inviteExpiresIn !== undefined ? { inviteExpiresIn: p.inviteExpiresIn } : {}),
            },
            own,
            ctx,
          );
        }
        // A node's grant is full access: only a client that has it may hand it on.
        if (!isFull(own)) throw new RpcError("denied", "only a client with full access invites a node");
        if (p.access && !isFull(p.access)) throw new RpcError("invalid", "a node's access is full; its role says what it may be");
        // a session invites nobody, and what a grant with an end invites ends no later
        boundedBy(ctx, undefined, Date.now(), "invites nobody");
        return deps.nodes.invite({
          name: p.name,
          role: p.role ?? "full",
          ...(ctx.ends !== undefined ? { endsBy: ctx.ends } : {}),
          ...(p.expiresIn !== undefined ? { expiresIn: p.expiresIn } : {}),
          ...(p.inviteExpiresIn !== undefined ? { inviteExpiresIn: p.inviteExpiresIn } : {}),
        });
      },
    },
    "browser.invite": {
      target: (p) => p.name,
      // The key and the link are for the screen that shows them, not for the audit table.
      redactResult: (r) => ({ ...r, invite: { ...r.invite, key: "[redacted]", link: "[redacted]" } }),
      handler: (p, ctx) => {
        const own = ctx.client.access ?? FULL;
        return deps.phones.browser({ name: p.name, access: p.access ?? own, ...(p.expiresIn !== undefined ? { expiresIn: p.expiresIn } : {}), ...(p.session ? { session: true } : {}) }, own, ctx);
      },
    },
    "grant.list": {
      handler: () => ({ grants: deps.grants.list() }),
    },
    "grant.revoke": {
      target: (p) => p.id,
      handler: async (p) => {
        const row = deps.grants.get(p.id);
        if (!row) throw new RpcError("not_found", `no grant ${p.id}`);
        if (row.kind === "controller") deps.revokeController(p.id);
        else await deps.nodes.revoke(p.id);
        return {};
      },
    },
    "node.join": {
      redact: (p) => ({ ...p, invite: "[redacted]" }),
      handler: async (p, ctx) => {
        onThisMachine(ctx, "joining a primary");
        return deps.nodes.join(p.invite, { ...(p.paths ? { paths: p.paths } : {}), ...(p.answerHere ? { answerHere: true } : {}), ...(p.askPrimary ? { askPrimary: true } : {}) });
      },
    },
    "node.leave": {
      handler: async (_p, ctx) => {
        onThisMachine(ctx, "leaving the primary");
        await deps.nodes.leave();
        return {};
      },
    },
  };
}
