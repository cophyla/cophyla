// The team methods (`teams.*`, the `controllers` scope, refused to limited access by the filter
// tables): list the teams and the invites waiting, make a team, invite someone into it, look at
// an invite and join or turn it down, change what is shared, rename, take someone out, change a
// role, leave and end. An invite's code is shown to the one who asked and kept in no audit row.
// The teams are the primary's: a client of a secondary is answered there.

import { isFull, RpcError } from "@cophyla/protocol";
import type { MethodContext, MethodTable } from "../api/methods.ts";
import { boundedBy } from "../grants/lifetime.ts";
import type { Teams } from "./index.ts";

export function teamMethods(deps: { teams: () => Teams | undefined }): MethodTable {
  const get = (): Teams => {
    const t = deps.teams();
    if (!t) throw new RpcError("unavailable", "teams are kept by the primary");
    return t;
  };
  // a team lets other people's agents in, and has no end of its own: only a client with full
  // access, whose grant does not end, makes, joins or widens one
  const full = (ctx: MethodContext, what: string) => {
    if (ctx.client.access && !isFull(ctx.client.access)) throw new RpcError("denied", `only a client with full access ${what}`);
    boundedBy(ctx, undefined, Date.now(), "shares nothing");
    if (ctx.ends !== undefined) throw new RpcError("denied", "access that ends shares nothing: a team lasts until you leave it");
  };
  return {
    "teams.list": { handler: () => get().list() },
    "teams.create": {
      handler: async (p, ctx) => {
        full(ctx, "makes a team");
        return { team: await get().create(p) };
      },
    },
    "teams.invite": {
      target: (p) => p.team,
      redactResult: (r) => ({ ...r, invite: { ...r.invite, code: "[redacted]" } }),
      handler: async (p, ctx) => {
        full(ctx, "adds someone to a team");
        return get().invite(p.team, p.user);
      },
    },
    "teams.cancel": { target: (p) => p.team, handler: async (p) => ({ team: await get().cancel(p.team, p.invite) }) },
    "teams.look": {
      redact: (p) => ({ ...p, code: "[redacted]" }),
      handler: async (p, ctx) => {
        full(ctx, "looks at a team's invite");
        return { offer: await get().look(p.code) };
      },
    },
    "teams.join": {
      target: (p) => p.offer,
      handler: async (p, ctx) => {
        full(ctx, "joins a team");
        return { team: await get().join(p.offer, p.share) };
      },
    },
    "teams.decline": {
      target: (p) => p.offer,
      handler: (p) => {
        get().decline(p.offer);
        return {};
      },
    },
    "teams.share": {
      target: (p) => p.team,
      handler: (p, ctx) => {
        full(ctx, "changes what is shared");
        return { team: get().share(p.team, p.share) };
      },
    },
    "teams.open": {
      target: (p) => p.team,
      handler: (p, ctx) => {
        if (p.on) full(ctx, "opens an agent to a team");
        return { team: get().open(p.team, p.session, p.on) };
      },
    },
    "teams.update": { target: (p) => p.team, handler: async (p) => ({ team: await get().update(p.team, p) }) },
    "teams.remove": { target: (p) => p.team, handler: async (p) => ({ team: await get().remove(p.team, p.user) }) },
    "teams.role": { target: (p) => p.team, handler: async (p) => ({ team: await get().role(p.team, p.user, p.role) }) },
    "teams.leave": {
      target: (p) => p.team,
      handler: async (p) => {
        await get().leave(p.team);
        return {};
      },
    },
    "teams.end": {
      target: (p) => p.team,
      handler: async (p) => {
        await get().end(p.team);
        return {};
      },
    },
  };
}
