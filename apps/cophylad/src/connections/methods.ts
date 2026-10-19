// The connection methods: a client with full access lists the connections, makes an invite
// for a terminal, uses another user's code for one, and ends one (`connection.*`, the
// `controllers` scope, refused to limited access by the filter tables). A code is shown to the
// one who asked and kept in no audit row, whichever way it went. The connections are the
// primary's: a client of a secondary is the primary's client, and its requests are answered
// there.

import { isFull, RpcError } from "@cophyla/protocol";
import type { MethodContext, MethodTable } from "../api/methods.ts";
import { boundedBy } from "../grants/lifetime.ts";
import type { Connections } from "./index.ts";

export function connectionMethods(deps: { connections: () => Connections | undefined }): MethodTable {
  const get = (): Connections => {
    const c = deps.connections();
    if (!c) throw new RpcError("unavailable", "connections are off on this node");
    return c;
  };
  // a connection lets another user's agent into a terminal, and has no end of its own: only a
  // client with full access, whose grant does not end, makes or uses one
  const full = (ctx: MethodContext, what: string) => {
    if (ctx.client.access && !isFull(ctx.client.access)) throw new RpcError("denied", `only a client with full access ${what}`);
    boundedBy(ctx, undefined, Date.now(), what === "makes an invite" ? "invites nobody" : "connects nothing");
    if (ctx.ends !== undefined) throw new RpcError("denied", `access that ends ${what === "makes an invite" ? "invites nobody" : "connects nothing"}: a connection lasts as long as its terminal`);
  };
  return {
    "connection.list": {
      handler: () => ({ connections: get().list() }),
    },
    "connection.invite": {
      target: (p) => p.session ?? p.terminal?.id,
      redactResult: (r) => ({ ...r, invite: { ...r.invite, code: "[redacted]" } }),
      handler: async (p, ctx) => {
        full(ctx, "makes an invite");
        const made = await get().invite({ ...(p.session ? { session: p.session } : {}), ...(p.terminal ? { terminal: p.terminal } : {}), ...(p.node ? { node: p.node } : {}), ...(p.for ? { for: p.for } : {}) }, "app");
        return { connection: made.connection, invite: { code: made.code, expiresAt: made.expiresAt } };
      },
    },
    "connection.accept": {
      target: (p) => p.session ?? p.terminal?.id,
      redact: (p) => ({ ...p, code: "[redacted]" }),
      handler: async (p, ctx) => {
        full(ctx, "uses a connection's code");
        const connection = await get().accept({ code: p.code, ...(p.session ? { session: p.session } : {}), ...(p.terminal ? { terminal: p.terminal } : {}), ...(p.node ? { node: p.node } : {}) }, "app");
        return { connection };
      },
    },
    "connection.end": {
      target: (p) => p.id,
      handler: async (p) => {
        await get().end(p.id, "ended by the user");
        return {};
      },
    },
  };
}
