// The workspace node methods: lending a folder of this machine to another person's cluster
// (`guest.add`, which only checks the folder when no invite is given), listing what is lent,
// joining one to a cluster again, leaving and removing. The terminal's `cophyla node`
// commands ask them, on this machine's loopback listener alone: never from a phone, never
// through a primary. The invite is shown to no one and kept in no audit row.

import type { ClientParams, ClientResult } from "@cophyla/protocol";
import type { MethodTable } from "../api/methods.ts";
import type { Guests } from "../nodes/guests.ts";
import { onThisMachine } from "./methods.ts";

export interface GuestMethodDeps {
  guests: Pick<Guests, "check" | "add" | "list" | "join" | "leave" | "remove">;
}

const hideInvite = <T extends { invite?: string }>(p: T): T => (p.invite === undefined ? p : { ...p, invite: "[redacted]" });

export function guestMethods(deps: GuestMethodDeps): MethodTable {
  return {
    "guest.add": {
      target: (p) => p.folder,
      redact: hideInvite,
      handler: async (p, ctx): Promise<ClientResult<"guest.add">> => {
        onThisMachine(ctx, "lending a folder to another cluster");
        const opts = { folder: p.folder, ...(p.name !== undefined ? { name: p.name } : {}), ...(p.profile !== undefined ? { profile: p.profile } : {}) };
        if (p.invite === undefined) return deps.guests.check(opts);
        const guest = await deps.guests.add({ ...opts, invite: p.invite });
        return { folder: guest.folder, name: guest.name, guest };
      },
    },
    "guest.list": {
      handler: (_p, ctx) => {
        onThisMachine(ctx, "listing the workspace nodes");
        return { guests: deps.guests.list() };
      },
    },
    "guest.join": {
      target: (p) => p.name,
      redact: hideInvite,
      handler: async (p: ClientParams<"guest.join">, ctx) => {
        onThisMachine(ctx, "joining a workspace node to a cluster");
        return { guest: await deps.guests.join(p.name, p.invite) };
      },
    },
    "guest.leave": {
      target: (p) => p.name,
      handler: async (p, ctx) => {
        onThisMachine(ctx, "a workspace node leaving its cluster");
        return { guest: await deps.guests.leave(p.name) };
      },
    },
    "guest.remove": {
      target: (p) => p.name,
      handler: async (p, ctx) => {
        onThisMachine(ctx, "removing a workspace node");
        await deps.guests.remove(p.name);
        return {};
      },
    },
  };
}
