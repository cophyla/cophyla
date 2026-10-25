// The teammate methods: a client with full access lists the teammates, makes a code, uses
// another user's, changes what it shares, opens an agent by hand, lists a teammate's agents,
// connects one of its agents to one of theirs and ends that, cancels a code, and ends a
// teammate (`teammate.*`, the `controllers` scope, refused to limited access by the filter
// tables). A code is shown to the one who asked and kept in no audit row. The teammates are the
// primary's: a client of a secondary is the primary's client, and its requests are answered
// there.

import { isFull, RpcError } from "@cophyla/protocol";
import type { MethodContext, MethodTable } from "../api/methods.ts";
import { boundedBy } from "../grants/lifetime.ts";
import type { Teammates } from "./index.ts";

export function teammateMethods(deps: { teammates: () => Teammates | undefined }): MethodTable {
  const get = (): Teammates => {
    const t = deps.teammates();
    if (!t) throw new RpcError("unavailable", "teammates are kept by the primary");
    return t;
  };
  // a teammate lets another user's agents in, and has no end of its own: only a client with
  // full access, whose grant does not end, makes or uses a code, or opens more of what is shared
  const full = (ctx: MethodContext, what: string) => {
    if (ctx.client.access && !isFull(ctx.client.access)) throw new RpcError("denied", `only a client with full access ${what}`);
    boundedBy(ctx, undefined, Date.now(), "shares nothing");
    if (ctx.ends !== undefined) throw new RpcError("denied", "access that ends shares nothing: a teammate lasts until one of you ends it");
  };
  return {
    "teammate.list": { handler: () => ({ teammates: get().list() }) },
    "teammate.invite": {
      redactResult: (r) => ({ ...r, invite: { ...r.invite, code: "[redacted]" } }),
      handler: async (p, ctx) => {
        full(ctx, "makes a teammate's code");
        const made = await get().invite(p.share);
        return { teammate: made.teammate, invite: { code: made.code, expiresAt: made.expiresAt } };
      },
    },
    "teammate.accept": {
      redact: (p) => ({ ...p, code: "[redacted]" }),
      handler: async (p, ctx) => {
        full(ctx, "uses a teammate's code");
        return { teammate: await get().accept(p.code, p.share) };
      },
    },
    "teammate.update": {
      target: (p) => p.id,
      handler: (p, ctx) => {
        full(ctx, "changes what is shared");
        return { teammate: get().update(p.id, p.share) };
      },
    },
    "teammate.open": {
      target: (p) => p.teammate,
      handler: (p, ctx) => {
        if (p.on) full(ctx, "opens an agent to a teammate");
        return { teammate: get().open(p.teammate, p.session, p.on) };
      },
    },
    "teammate.agents": {
      target: (p) => p.teammate,
      handler: (p) => get().agentsFor(p.teammate, p.fresh === true),
    },
    "teammate.connect": {
      target: (p) => p.teammate,
      handler: async (p, ctx) => {
        full(ctx, "connects an agent to a teammate's");
        return { teammate: await get().connect(p.teammate, p.session, p.agent) };
      },
    },
    "teammate.disconnect": {
      target: (p) => p.teammate,
      handler: async (p) => ({ teammate: await get().disconnect(p.teammate, p.id) }),
    },
    "teammate.cancel": {
      target: (p) => p.id,
      handler: async (p) => {
        await get().end(p.id, "cancelled by the user");
        return {};
      },
    },
    "teammate.end": {
      target: (p) => p.id,
      handler: async (p) => {
        await get().end(p.id, "ended by the user");
        return {};
      },
    },
  };
}
