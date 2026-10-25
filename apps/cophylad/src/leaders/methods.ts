// The leaders' client methods: a client lists them, makes a session or the chat a leader of a
// group of the user's sessions or changes its group, and ends one (`lead.*`, `sessions:read`
// to list and `sessions:write` to change, refused to limited access by the filter tables, since
// a leader speaks as the user anywhere). Clients alone: the brain reads them (`lead.list` on its
// own table) and the agents' tools cannot reach them. The leaders are the primary's: a client
// of a secondary is the primary's client, and its requests are answered there.

import { RpcError } from "@cophyla/protocol";
import type { MethodTable } from "../api/methods.ts";
import type { Leaders } from "./index.ts";

export function leaderMethods(deps: { leaders: () => Leaders | undefined }): MethodTable {
  const get = (): Leaders => {
    const l = deps.leaders();
    if (!l) throw new RpcError("unavailable", "the leaders are kept by the primary");
    return l;
  };
  return {
    // refused, not empty, before this node is the primary: an app that connected while it claimed
    // the role asks again once it has it, rather than showing no leaders until one changes
    "lead.list": { handler: () => ({ leaders: get().list() }) },
    "lead.set": {
      target: (p) => p.speaker,
      handler: (p) => ({ leader: get().set(p.speaker, p.targets) }),
    },
    "lead.remove": {
      target: (p) => p.speaker,
      handler: (p) => {
        get().remove(p.speaker);
        return {};
      },
    },
  };
}
