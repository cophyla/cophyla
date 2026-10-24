// The agents' conversations, for clients: every session's at a glance, a page of one session's,
// and what the user read of it (`talk.*`, `sessions:read` to read and `sessions:write` to mark
// read, refused to limited access by the filter tables, since a conversation reaches other
// sessions and other people). Clients alone: the brain and the agents' tools cannot reach them.
// They are the primary's: a client of a secondary is the primary's client, answered there.

import { RpcError } from "@cophyla/protocol";
import type { MethodTable } from "../api/methods.ts";
import type { TalkLog } from "./talk.ts";

export function talkMethods(deps: { talk: () => TalkLog | undefined }): MethodTable {
  const get = (): TalkLog => {
    const t = deps.talk();
    if (!t) throw new RpcError("unavailable", "agents' conversations are kept by the primary");
    return t;
  };
  return {
    "talk.list": { handler: () => ({ talks: get().list() }) },
    "talk.messages": {
      target: (p) => p.session,
      handler: (p) => get().page(p.session, p.limit ?? 50, p.before),
    },
    "talk.read": {
      target: (p) => p.session,
      handler: (p) => {
        get().read(p.session, p.upTo);
        return {};
      },
    },
  };
}
